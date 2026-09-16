// Original LedFx produces timing/intensity. Optional colour-only comparison.
(() => {
  const panel = document.createElement('section');
  panel.className = 'card'; panel.id = 'ledfxExperiment';
  panel.innerHTML = `
    <div class="section-title"><span>FX</span><div><h2>LedFx 원본 엔진 실험</h2><p>음악을 재생하면 LedFx가 실시간으로 분석하고 원본 효과를 출력합니다. 기존 분석곡은 수정하지 않습니다.</p></div></div>
    <div class="entertainment-row">
      <button id="lfConnect" class="accent">엔진 연결</button>
      <label>비교 효과<select id="lfEffect"><option value="energy">Energy — 원본</option><option value="bar">Bar — 원본</option><option value="power">Power — 원본</option><option value="power-single">Power — 색상 정리 (단색)</option></select></label>
      <label>좌우 쌍<select id="lfPairs"><option>1</option><option>2</option><option>3</option><option>4</option><option selected>5</option></select></label>
      <button id="lfApply">효과 적용</button><button id="lfStop">실험 정지</button>
    </div>
    <p id="lfVariantNote">Energy 원본 · 클라이맥스에서 밝기 변화 타이밍을 비교하세요.</p>
    <label id="lfColorLabel" hidden style="display:none">Power 단색 (즉시 반영)<select id="lfColor"><option value="#ffb870">따뜻한 살구</option><option value="#70c8ff">맑은 하늘색</option><option value="#cf9fff">연보라</option></select></label>
    <p><label style="display:flex;align-items:center;gap:8px"><input type="checkbox" id="lfHue" style="width:18px;height:18px;margin:0;flex:none"> 실제 Hue에도 출력 (A/B 같은 수, 총 10개 이하)</label></p>
    <div class="entertainment-row"><label>음원 파일 <input id="lfFile" type="file" accept="audio/*"></label><label>저장된 음원<select id="lfTrack"><option value="">음원 선택</option></select></label><button id="lfTracks">목록 새로고침</button></div>
    <audio id="lfPlayer" controls style="width:100%;margin:16px 0"></audio>
    <div class="entertainment-row"><button id="lfPlay">음악 재생</button><button id="lfPause">일시 정지</button></div>
    <p id="lfStatus" role="status">설치 후 엔진 연결을 누르세요. 미설치 시 프로젝트의 setup-ledfx.ps1을 실행하세요.</p>
    <div id="lfBulbs"></div><small>원본 반응 + 선택적 단색 변환 · 같은 번호를 A/B에 복제 · 실시간 분석이라 기존 사전 분석 싱크값은 적용하지 않습니다.<br>Energy는 전구 수가 적거나 소리가 작으면 막대 길이가 0이 될 수 있습니다. 1쌍 테스트는 Power를 사용하세요. 빠른 점멸에 민감하면 실제 조명 출력을 켜지 마세요.</small>`;
  document.querySelector('main').prepend(panel);
  const el = id => document.getElementById(id);
  const player = el('lfPlayer');
  let appliedEffect='energy', appliedPairs=5;
  const engineEffect=value=>value==='power-single'?'power':value;
  function variantNote(){
    const value=el('lfEffect').value;
    el('lfColorLabel').hidden=value!=='power-single';
    el('lfColorLabel').style.display=value==='power-single'?'grid':'none';
    el('lfVariantNote').textContent=value==='power-single'
      ?'색만 변경 · 전구별 밝기 명령값/점등 위치/펀치/감쇠 타이밍은 원본 Power와 동일합니다. 눈에 느껴지는 밝기는 색에 따라 달라질 수 있습니다. 선택 후 효과 적용을 누르세요.'
      :value==='power'?'Power 원본 · 순간 점등과 부드러운 감쇠를 비교하세요.'
      :value==='energy'?'Energy 원본 · 클라이맥스에서 밝기 변화 타이밍을 비교하세요.'
      :'Bar 원본 · 반복 움직임 비교용입니다.';
  }
  let socket, context, worklet, source, timer, sequence = -1, ready = false, connecting = false, url, messageId = 1, generation = 0, hueOwned = false;
  let output = Promise.resolve();
  const queueOutput = action => (output = output.catch(()=>{}).then(action));
  async function releaseHue() {
    if(!hueOwned)return;
    try {
      const ids=entertainmentMusicGroups().flatMap(group=>group.lightIds);
      await api('/api/entertainment/frame',{method:'POST',body:JSON.stringify({commands:[{lightIds:ids,brightness:0,on:false,transitionMs:0}],scheduleAheadMs:0})});
    } finally {await stopEntertainment(true);hueOwned=false;}
  }
  const status = text => { el('lfStatus').textContent = text; };
  const send = value => { if(socket?.readyState===WebSocket.OPEN)socket.send(JSON.stringify({id:messageId++,...value})); };
  function draw(rgb) {
    const count = rgb.length / 3;
    if (el('lfBulbs').dataset.count !== String(count)) {
      el('lfBulbs').dataset.count = String(count);
      el('lfBulbs').innerHTML = ['A','B'].map(row => '<div style="display:flex;gap:16px;margin:16px 0;align-items:center"><b>'+row+'</b>'+Array.from({length:count},(_,i)=>'<div style="flex:1;text-align:center"><div data-lf="'+i+'" style="height:65px;border-radius:16px;border:1px solid #64748b;background:#000"></div><small>'+row+(i+1)+'</small></div>').join('')+'</div>').join('');
    }
    el('lfBulbs').querySelectorAll('[data-lf]').forEach(node => {
      const i=Number(node.dataset.lf)*3,c=rgb.slice(i,i+3),css='rgb('+c.join(',')+')';
      node.style.background=css;node.style.boxShadow='0 0 '+(Math.max(...c)/255*25)+'px '+css;
    });
  }
  function commands(rgb,groups) {
    return groups.flatMap(group=>group.lightIds.map((id,i)=>{
      const c=rgb.slice(i*3,i*3+3),peak=Math.max(...c);
      const hex='#'+c.map(v=>Math.round(peak?v/peak*255:0).toString(16).padStart(2,'0')).join('');
      return {lightIds:[id],hexColor:hex,brightness:peak/255*100,on:peak>0,transitionMs:0};
    }));
  }
  async function configure(force=false) {
    const pairs=Number(el('lfPairs').value);
    if(el('lfHue').checked){
      const groups=validateEntertainmentGroups();
      if(groups[0].lightIds.length!==pairs)throw Error('선택한 쌍 수와 A/B 그룹의 전구 수를 맞춰 주세요.');
    }
    const next=el('lfEffect').value;
    // Power <-> single colour uses the SAME running engine: no filter reset.
    if(force||engineEffect(next)!==engineEffect(appliedEffect)||pairs!==appliedPairs)
      await api('/api/ledfx/configure',{method:'POST',body:JSON.stringify({pairs,effect:engineEffect(next),client:'HueBeat-Web'})});
    appliedEffect=next;appliedPairs=pairs;
  }
  async function connect() {
    if(connecting)return;
    connecting=true;el('lfConnect').disabled=true;
    try {
      await stop();status('원본 LedFx 엔진 시작 중…');
      await api('/api/ledfx/start',{method:'POST'});
      let available=false;
      for(let i=0;i<60;i++){
        const state=await api('/api/ledfx/status');
        if(state.available){available=true;break;}
        await new Promise(resolve=>setTimeout(resolve,1000));
      }
      if(!available)throw Error('LedFx 시작 시간 초과. data/ledfx-engine 로그를 확인하세요.');
      socket=new WebSocket('ws://127.0.0.1:8888/api/websocket');
      await new Promise((resolve,reject)=>{
        const timeout=setTimeout(()=>reject(Error('LedFx WebSocket 연결 시간 초과')),8000);
        socket.onopen=()=>{clearTimeout(timeout);resolve();};
        socket.onerror=()=>{clearTimeout(timeout);reject(Error('LedFx WebSocket 연결 실패'));};
      });
      send({type:'audio_stream_start',client:'HueBeat-Web'});
      await new Promise(resolve=>setTimeout(resolve,250));
      await configure(true);
      socket.onclose=()=>{if(ready){ready=false;player.pause();status('LedFx 연결이 끊겼습니다. 엔진 연결을 다시 누르세요.');}};
      ready=true;sequence=-1;status('연결 완료 · 음원을 선택하고 재생하세요.');
      poll(++generation);
    } catch(error) {await stop();throw error;}
    finally {connecting=false;el('lfConnect').disabled=false;}
  }
  async function poll(token) {
    if(token!==generation||!ready)return;
    try {
      const frame=await api('/api/ledfx/frame');
      if(token!==generation)return;
      if(frame.stale){draw(Array(Number(el('lfPairs').value)*3).fill(0));await queueOutput(releaseHue);status('원본 프레임 대기 중 · 음악 재생과 엔진 연결을 확인하세요.');}
      else if(frame.sequence!==sequence && frame.rgb.length===appliedPairs*3){
        const rgb=appliedEffect==='power-single'?LedFxColor.powerSingleColor(frame.rgb,el('lfColor').value):frame.rgb;
        sequence=frame.sequence;draw(player.paused?rgb.map(()=>0):rgb);
        if(el('lfHue').checked&&!player.paused){
          await queueOutput(async()=>{
            if(token!==generation||player.paused||!el('lfHue').checked)return;
            const groups=validateEntertainmentGroups();
            if(groups[0].lightIds.length*3!==frame.rgb.length)throw Error('재생 중 그룹 크기가 바뀌었습니다.');
            if(!entertainmentActive) await startEntertainment();
            hueOwned=true;
            if(token!==generation||player.paused||!el('lfHue').checked){await releaseHue();return;}
            const result=await api('/api/entertainment/frame',{method:'POST',body:JSON.stringify({commands:commands(rgb,groups),scheduleAheadMs:0})});
            if(result.ignoredLightIds?.length)throw Error('선택한 Entertainment 영역에 없는 전구가 있습니다.');
          });
        }
        status((appliedEffect==='power-single'?'Power 단색 · 원본 밝기 유지':'원본 '+appliedEffect)+' · RGB 프레임 '+sequence+(el('lfHue').checked?' · Hue 출력':' · 웹 미리보기'));
      }
    }catch(error){el('lfHue').checked=false;player.pause();await queueOutput(releaseHue).catch(()=>{});status(error.message);}
    if(token===generation&&ready)timer=setTimeout(()=>poll(token),33);
  }
  async function audioGraph() {
    if(context){await context.resume();return;}
    context=new AudioContext({sampleRate:48000});
    await context.audioWorklet.addModule('/ledfx-audio-worklet.js');
    source=context.createMediaElementSource(player);
    worklet=new AudioWorkletNode(context,'ledfx-pcm',{outputChannelCount:[2]});
    worklet.port.onmessage=event=>{
      if(!ready||player.paused||socket?.readyState!==WebSocket.OPEN||socket.bufferedAmount>64000)return;
      const pcm=new DataView(new ArrayBuffer(event.data.length*2));
      for(let i=0;i<event.data.length;i++){const v=Math.max(-1,Math.min(1,event.data[i]));pcm.setInt16(i*2,Math.round(v*(v<0?32768:32767)),true);}
      let binary='';for(const b of new Uint8Array(pcm.buffer))binary+=String.fromCharCode(b);
      send({type:'audio_stream_data_v2',client:'HueBeat-Web',data:btoa(binary)});
    };
    source.connect(worklet);worklet.connect(context.destination);await context.resume();
  }
  async function stop() {
    ready=false;generation++;clearTimeout(timer);player.pause();
    send({type:'audio_stream_stop',client:'HueBeat-Web'});socket?.close();socket=null;
    await queueOutput(releaseHue);
    try{await api('/api/ledfx/clear',{method:'POST'});}catch{}
    draw(Array(Number(el('lfPairs').value)*3).fill(0));
    status('실험 정지');
  }
  function run(action){return ()=>action().catch(error=>status(error.message));}
  el('lfConnect').onclick=run(connect);
  el('lfEffect').onchange=variantNote;
  el('lfPlay').onclick=run(async()=>{if(!ready)throw Error('먼저 엔진을 연결하세요.');await audioGraph();await player.play();});
  el('lfPause').onclick=()=>player.pause();
  el('lfStop').onclick=run(stop);
  el('lfApply').onclick=run(async()=>{if(!ready)throw Error('먼저 엔진을 연결하세요.');await configure();sequence=-1;status('비교 효과 적용 완료');});
  el('lfHue').onchange=run(async()=>{if(!el('lfHue').checked)await queueOutput(releaseHue);});
  el('lfFile').onchange=()=>{player.pause();if(url)URL.revokeObjectURL(url);const file=el('lfFile').files[0];if(file){url=URL.createObjectURL(file);player.src=url;}};
  const tracks=async()=>{
    const items=await api('/api/tracks');
    el('lfTrack').innerHTML='<option value="">음원 선택</option>'+items.map(t=>'<option value="'+escapeHtml(t.id)+'">'+escapeHtml(t.fileName)+'</option>').join('');
  };
  el('lfTracks').onclick=run(tracks);
  el('lfTrack').onchange=()=>{if(el('lfTrack').value){player.pause();player.src='/api/tracks/'+encodeURIComponent(el('lfTrack').value)+'/audio';}};
  player.addEventListener('play',run(async()=>{
    if(!ready){player.pause();throw Error('먼저 엔진 연결을 눌러 주세요.');}
    document.getElementById('audioPlayer').pause();stopShowTest(true);stopCalibration(true);
    try{await audioGraph();}catch(error){player.pause();throw error;}
  }));
  // A bounded silence block prevents effects retaining the last loud audio indefinitely.
  player.addEventListener('pause',()=>{
    if(ready)for(let i=0;i<8;i++)send({type:'audio_stream_data_v2',client:'HueBeat-Web',data:btoa('\0'.repeat(1600))});
    queueOutput(releaseHue).catch(error=>status(error.message));
    draw(Array(Number(el('lfPairs').value)*3).fill(0));
  });
  document.getElementById('audioPlayer').addEventListener('play',()=>{if(ready)stop().catch(error=>status(error.message));});
  window.addEventListener('beforeunload',()=>{send({type:'audio_stream_stop',client:'HueBeat-Web'});socket?.close();});
  draw(Array(15).fill(0));tracks().catch(()=>{});
})();
