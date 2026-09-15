"""Run with tmp/ledfx-venv/Scripts/python.exe tests/ledfx-integration.py.

Requires controller + original LedFx running. Alters only experimental virtuals;
does not send Hue commands. Close the browser experiment before running.
"""
import asyncio
import base64
import math
import struct
import aiohttp


async def main():
    async with aiohttp.ClientSession() as session:
        async def request(path, body=None):
            method = session.get if body is None else session.post
            async with method('http://127.0.0.1:5188' + path, **({} if body is None else {'json': body})) as r:
                text = await r.text()
                assert r.status < 400, (r.status, text)
                return await r.json() if text else None

        async with session.ws_connect('http://127.0.0.1:8888/api/websocket') as ws:
            number = 0
            async def send(kind, **values):
                nonlocal number
                number += 1
                await ws.send_json(dict(id=number, type=kind, client='HueBeat-Web', **values))
            await send('audio_stream_start')
            await asyncio.sleep(.3)
            try:
                for effect, pairs in [('energy', 5), ('bar', 5), ('power', 5), ('power', 1), ('energy', 5)]:
                    await request('/api/ledfx/configure', dict(effect=effect, pairs=pairs, client='HueBeat-Web'))
                    colours, sequences = set(), set()
                    start = asyncio.get_running_loop().time()
                    for tick in range(240):
                        # Alternating bass/mid/high pulses plus silence, not a song-specific fixture.
                        freq = [70, 600, 4000][(tick // 60) % 3]
                        amplitude = .75 if tick % 30 < 9 else .005
                        pcm = [round(32767 * amplitude * math.sin(2 * math.pi * freq * (tick * 800 + i) / 48000)) for i in range(800)]
                        await send('audio_stream_data_v2', data=base64.b64encode(struct.pack('<800h', *pcm)).decode())
                        if tick % 3 == 0:
                            frame = await request('/api/ledfx/frame')
                            if not frame['stale'] and len(frame['rgb']) == pairs * 3:
                                colours.add(tuple(frame['rgb']))
                                sequences.add(frame['sequence'])
                        await asyncio.sleep(max(0, start + (tick + 1) / 60 - asyncio.get_running_loop().time()))
                    assert len(sequences) > 20, (effect, 'missing frames', len(sequences))
                    assert len(colours) > 3 and any(any(c) for c in colours), (effect, 'static/black output', colours)
                    print(f'PASS {effect} pairs={pairs}: {len(sequences)} frames, {len(colours)} distinct RGB frames', flush=True)
            finally:
                await request('/api/ledfx/clear', {})
                await send('audio_stream_stop')


asyncio.run(main())
