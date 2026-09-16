"""Capture original LedFx graph events from WAV excerpts, without Hue or speakers.
Run with installed venv Python and a WAV argument; close experiment tabs first.
Controller/engine must run. Output stays under ignored tmp/.
"""
import asyncio, base64, json, sys
from pathlib import Path
import aiohttp, numpy as np, soundfile as sf, samplerate

async def main():
    audio, rate=sf.read(sys.argv[1],always_2d=True)
    mono=audio.mean(axis=1)
    if rate!=48000: mono=samplerate.resample(mono,48000/rate,'sinc_best')
    results=[]
    async with aiohttp.ClientSession() as session:
        async def post(path,body):
            async with session.post('http://127.0.0.1:5188'+path,json=body) as r:
                assert r.status<400,await r.text()
        async with session.ws_connect('http://127.0.0.1:8888/api/websocket') as ws:
            number=0; rows=[]; started=asyncio.get_running_loop().time()
            async def send(kind,**values):
                nonlocal number
                number+=1
                await ws.send_json(dict(id=number,type=kind,client='HueBeat-Web',**values))
            async def receive():
                async for msg in ws:
                    if msg.type!=aiohttp.WSMsgType.TEXT: continue
                    data=json.loads(msg.data)
                    if data.get('event_type')=='graph_update':
                        rows.append(dict(time=asyncio.get_running_loop().time()-started,values=data['melbank'],frequencies=data['frequencies']))
            receiver=asyncio.create_task(receive())
            await send('audio_stream_start');await send('subscribe_event',event_type='graph_update')
            await asyncio.sleep(.3)
            try:
                for label,second in [('intro',8),('strong',188),('tail',200)]:
                    await post('/api/ledfx/configure',dict(pairs=5,effect='energy',client='HueBeat-Web'))
                    rows=[];started=asyncio.get_running_loop().time()
                    for tick in range(720):
                        block=mono[second*48000+tick*800:second*48000+(tick+1)*800]
                        if len(block)!=800:break
                        pcm=(np.clip(block,-1,1)*32767).astype('<i2').tobytes()
                        await send('audio_stream_data_v2',data=base64.b64encode(pcm).decode())
                        await asyncio.sleep(max(0,started+(tick+1)/60-asyncio.get_running_loop().time()))
                    assert len(rows)>300,'Missing LedFx graph events'
                    results.append(dict(label=label,start=second,rows=list(rows)))
                    print(label,len(rows),'original graph events',flush=True)
            finally:
                await post('/api/ledfx/clear',{});await send('audio_stream_stop');receiver.cancel()
                try:await receiver
                except asyncio.CancelledError:pass
    target=Path('tmp/ledfx-show-probe.json');target.parent.mkdir(exist_ok=True)
    target.write_text(json.dumps(results),encoding='utf-8')

asyncio.run(main())
