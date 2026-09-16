"""Local-only source/output probe, not a show rule or beat evaluator.
Usage: venv python tests/ledfx-song-probe.py path.wav
Close experiment tabs first. Controller must run. Never calls Hue endpoints.
"""
import asyncio
import base64
import json
import sys
from pathlib import Path
import aiohttp
import numpy as np
import soundfile as sf
import samplerate


async def main():
    samples, rate = sf.read(sys.argv[1], always_2d=True)
    mono = samples.mean(axis=1)
    if rate != 48000:
        mono = samplerate.resample(mono, 48000 / rate, 'sinc_best')
    # Loud comparison window is selected by RMS, not labelled a musical climax.
    duration = 12
    candidates = range(40, max(41, int(len(mono)/48000)-duration-20), 4)
    loud = max(candidates, key=lambda s: np.mean(mono[s*48000:(s+duration)*48000]**2))
    windows = [('intro', 8), ('high_rms', loud), ('reported_tail', 200)]
    reports=[]
    async with aiohttp.ClientSession() as session:
        async def request(path, body=None):
            method=session.get if body is None else session.post
            async with method('http://127.0.0.1:5188'+path, **({} if body is None else {'json':body})) as r:
                text=await r.text()
                assert r.status<400, text
                return json.loads(text) if text else None
        await request('/api/ledfx/start', {})
        for _ in range(60):
            if (await request('/api/ledfx/status'))['available']: break
            await asyncio.sleep(1)
        async with session.ws_connect('http://127.0.0.1:8888/api/websocket') as ws:
            number=0
            async def send(kind, **values):
                nonlocal number
                number+=1
                await ws.send_json(dict(id=number,type=kind,client='HueBeat-Web',**values))
            await send('audio_stream_start')
            await asyncio.sleep(.3)
            try:
                for effect in ['energy','power']:
                    for label, second in windows:
                        await request('/api/ledfx/configure',dict(pairs=5,effect=effect,client='HueBeat-Web'))
                        rows=[]
                        start=asyncio.get_running_loop().time()
                        # 3-second preroll reduces, but does not eliminate, state differences.
                        for tick in range((duration+3)*60):
                            position=(second-3)*48000+tick*800
                            block=mono[position:position+800]
                            if len(block)!=800: break
                            pcm=np.clip(block,-1,1)*32767
                            await send('audio_stream_data_v2',data=base64.b64encode(pcm.astype('<i2').tobytes()).decode())
                            if tick>=180 and tick%2==0:
                                frame=await request('/api/ledfx/frame')
                                if not frame['stale'] and len(frame['rgb'])==15:
                                    rows.append(dict(time=round(position/48000,4),rms=float(np.sqrt(np.mean(block**2))),rgb=frame['rgb'],sequence=frame['sequence']))
                            await asyncio.sleep(max(0,start+(tick+1)/60-asyncio.get_running_loop().time()))
                        assert rows, 'No RGB received'
                        peaks=np.array([r['rgb'] for r in rows]).reshape(-1,5,3).max(axis=2)
                        report=dict(effect=effect,window=label,start=second,frames=len(rows),mean_peak=round(float(peaks.mean()),2),black_percent=round(float((peaks==0).mean()*100),2),mean_frame_change=round(float(np.abs(np.diff(peaks,axis=0)).mean()),2),rows=rows)
                        reports.append(report)
                        print(json.dumps({k:v for k,v in report.items() if k!='rows'}),flush=True)
            finally:
                await request('/api/ledfx/clear',{})
                await send('audio_stream_stop')
    target=Path('tmp/ledfx-song-probe.json')
    target.parent.mkdir(exist_ok=True)
    target.write_text(json.dumps(reports),encoding='utf-8')
    print('Saved local-only output trace:',target)


asyncio.run(main())
