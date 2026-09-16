// LedFx filtered melbanks -> HueBeat transient rules -> RGB -> preview/Hue.
(() => {
  const panel=document.createElement('section');panel.className='card';panel.id='ledfxExperiment';
  panel.innerHTML=`
    <div class="section-title"><span>FX</span><div><h2>HueBeat 음악 연출</h2><p>LedFx 대역 분석 → 타격 후보 → 한 쌍 / 전체 펀치·감쇠. 지속음만으로 전구를 계속 켜두지 않습니다.</p></div></div>
    <div class="entertainment-row">
      <button id="lfConnect" class="accent">분석 엔진 연결</button>
      <label>연출 방식<select id="lfMode"><option value="auto">자동 — 한 쌍 ↔ 전체 펀치</option><option value="sparse">한 쌍 — 점등·감쇠 확인</option><option value="full">전체 — 타격마다 밝기 펀치</option></select></label>
      <label>좌우 쌍<select id="lfPairs"><option>1</option><option>2</option><option>3</option><option>4</option><option selected>5</option></select></label><button id="lfStop">연출 정지</button>
    </div>
    <div class="entertainment-row" style="margin-top:12px">
      <label>타격 민감도<select id="lfSensitivity"><option value="0.7">낮음</option><option value="1" selected>기본</option><option value="1.5">높음</option></select></label>
      <label>한 쌍 소등까지<select id="lfDecay"><option value="60">240ms</option><option value="100" selected>400ms · 기본</option><option value="150">600ms</option></select></label>
      <label>최대 밝기<input id="lfBrightness" type="range" min="0" max="100" value="80"><span id="lfBrightnessValue">80%</span></label>
    </div>
    <p><label style="display:flex;align-items:center;gap:8px"><input id="lfMove" type="checkbox" checked style="width:18px;flex:none">선별된 소리 시작마다 다음 쌍 점등 · 이전 쌍 즉시 소등 (끄면 1번 쌍)</label></p>
    <p><label style="display:flex;align-items:center;gap:8px"><input id="lfClick" type="checkbox" style="width:18px;flex:none">검출 클릭음 듣기 · 실제 타격과 비교 (분석 지연 포함)</label></p>
    <p><label style="display:flex;align-items:center;gap:8px"><input id="lfHue" type="checkbox" style="width:18px;flex:none">실제 Hue에도 출력 (A/B 같은 수, 총 10개 이하)</label></p>
    <div class="entertainment-row"><label>음원 파일<input id="lfFile" type="file" accept="audio/*"></label><label>저장된 음원<select id="lfTrack"><option value="">음원 선택</option></select></label><button id="lfTracks">목록 새로고침</button></div>
    <audio id="lfPlayer" controls style="width:100%;margin:16px 0"></audio>
    <div class="entertainment-row"><button id="lfPlay">음악 재생</button><button id="lfPause">일시 정지</button></div>
    <p id="lfStatus" role="status">분석 엔진을 연결하세요. 기존 LedFx 설치를 그대로 사용합니다.</p>
    <div id="lfDiagnostics" style="padding:12px;border:1px solid #475569;border-radius:12px;margin:12px 0;font-variant-numeric:tabular-nums">대역 분석 대기</div>
    <div id="lfBulbs"></div><small>자동 모드는 타격 밀도·대역 에너지로 전환하는 실험 규칙이며 클라이맥스 확정 기능은 아닙니다.<br>단색으로 타이밍부터 확인하세요. 기존 사전 분석 싱크값은 적용하지 않습니다. 빠른 점멸에 민감하면 실제 출력을 켜지 마세요.</small>`;
  document.querySelector('main').prepend(panel);
  const el=id=>document.getElementById(id),player=el('lfPlayer'),show=new HueBeatShow.Show();
  let socket,context,source,worklet,url,timer,ready=false,connecting=false,generation=0,id=1,hueOwned=false,output=Promise.resolve(),graphMax=0,graphId=null,diagnosticAt=0;
  const settings=()=>({pairs:Number(el('lfPairs').value),mode:el('lfMode').value,sensitivity:Number(el('lfSensitivity').value),decayMs:Number(el('lfDecay').value),move:el('lfMove').checked,brightness:Number(el('lfBrightness').value)});
  const status=text=>{el('lfStatus').textContent=text;};
  const queue=action=>(output=output.catch(()=>{}).then(action));
  const send=value=>{if(socket?.readyState===WebSocket.OPEN)socket.send(JSON.stringify({id:id++,...value}));};
  function draw(rgb){
    const count=rgb.length/3,container=el('lfBulbs');
    if(container.dataset.count!==String(count)){
      container.dataset.count=String(count);
      container.innerHTML=['A','B'].map(row=>'<div style="display:flex;gap:12px;margin:16px 0;align-items:center"><b>'+row+'</b>'+Array.from({length:count},(_,i)=>'<div style="flex:1;text-align:center"><div data-lf="'+i+'" style="height:60px;border:1px solid #64748b;border-radius:14px"></div><small>'+row+(i+1)+'</small></div>').join('')+'</div>').join('');
    }
    container.querySelectorAll('[data-lf]').forEach(node=>{const i=Number(node.dataset.lf)*3;node.style.background='rgb('+rgb.slice(i,i+3).join(',')+')';});
  }
  function commands(rgb,groups){return groups.flatMap(group=>group.lightIds.map((lightId,i)=>{
    const c=rgb.slice(i*3,i*3+3),peak=Math.max(...c);
    return {lightIds:[lightId],hexColor:'#'+c.map(v=>Math.round(peak?v/peak*255:0).toString(16).padStart(2,'0')).join(''),brightness:peak/255*100,on:peak>0,transitionMs:0};
  }));}
  async function releaseHue(){
    if(!hueOwned)return;
    try{await api('/api/entertainment/frame',{method:'POST',body:JSON.stringify({commands:[{lightIds:entertainmentMusicGroups().flatMap(g=>g.lightIds),brightness:0,on:false,transitionMs:0}],scheduleAheadMs:0})});}
    finally{await stopEntertainment(true);hueOwned=false;}
  }
  async function connect(){
    if(connecting)return;connecting=true;el('lfConnect').disabled=true;
    let token;
    try{
      await stop();token=++generation;
      status('LedFx 분석 엔진 시작 중…');await api('/api/ledfx/start',{method:'POST'});
      let available=false;
      for(let i=0;i<60&&token===generation;i++){if((await api('/api/ledfx/status')).available){available=true;break;}await new Promise(r=>setTimeout(r,1000));}
      if(token!==generation)return;
      if(!available)throw Error('분석 엔진 시작 시간 초과. 서버 로그를 확인하세요.');
      socket=new WebSocket('ws://127.0.0.1:8888/api/websocket');
      await new Promise((resolve,reject)=>{const wait=setTimeout(()=>reject(Error('분석 연결 시간 초과')),8000);socket.onopen=()=>{clearTimeout(wait);resolve();};socket.onerror=()=>{clearTimeout(wait);reject(Error('분석 연결 실패'));};});
      if(token!==generation){socket?.close();return;}
      graphMax=0;graphId=null;show.reset();
      socket.onmessage=event=>{
        if(token!==generation||!ready||player.paused||player.seeking)return;
        let value;try{value=JSON.parse(event.data);}catch{return;}
        if(value.event_type!=='graph_update'||!Array.isArray(value.frequencies)||!Array.isArray(value.melbank))return;
        const maximum=Math.max(...value.frequencies);
        if(!Number.isFinite(maximum)||maximum<graphMax)return;
        if(maximum>graphMax){graphMax=maximum;graphId=value.graph_id;show.reset();}
        if(value.graph_id!==graphId)return;
        const accepted=show.ingest(value.melbank,value.frequencies,performance.now()/1000,settings());
        if(accepted&&el('lfClick').checked&&context?.state==='running'){
          const tone=context.createOscillator(),gain=context.createGain(),t=context.currentTime;
          tone.frequency.value=1200;gain.gain.setValueAtTime(.09,t);gain.gain.exponentialRampToValueAtTime(.001,t+.025);
          tone.connect(gain);gain.connect(context.destination);tone.start(t);tone.stop(t+.03);
          tone.onended=()=>{tone.disconnect();gain.disconnect();};
        }
      };
      send({type:'audio_stream_start',client:'HueBeat-Web'});send({type:'subscribe_event',event_type:'graph_update'});
      await new Promise(r=>setTimeout(r,250));
      // Original virtual activates LedFx analysis; its RGB is not used in this show.
      await api('/api/ledfx/configure',{method:'POST',body:JSON.stringify({pairs:5,effect:'energy',client:'HueBeat-Web'})});
      if(token!==generation)return;
      socket.onclose=()=>{if(token===generation&&ready){ready=false;player.pause();show.reset();draw(Array(settings().pairs*3).fill(0));queue(releaseHue).catch(()=>{});status('분석 연결이 끊겼습니다. 다시 연결하세요.');}};
      ready=true;status('연결 완료 · 음원을 선택하고 음악 재생을 누르세요.');render(token);
    }catch(error){if(token===generation||token===undefined){await stop();status(error.message);}}
    finally{connecting=false;el('lfConnect').disabled=false;}
  }
  async function render(token){
    if(token!==generation||!ready)return;
    try{
      const now=performance.now()/1000,options=settings(),frame=show.frame(now,options),playing=!player.paused&&!player.seeking;
      const rgb=playing?frame.rgb:Array(options.pairs*3).fill(0);draw(rgb);
      if(now-diagnosticAt>.1){
        diagnosticAt=now;const bands=frame.bands.map(v=>Math.round(v*100)+'%').join(' / ');
        el('lfDiagnostics').textContent=`${frame.mode==='full'?'전체 펀치':'한 쌍 감쇠'} · 상승 후보 ${frame.candidateCount} / 선별 타격 ${frame.hitCount} / 이동 ${frame.moveCount} · 현재 ${frame.mode==='full'?'전체':Math.max(1,frame.index+1)+'번 쌍'} · ${frame.hitAge<.15?'● '+frame.source+' 소리 시작':'○ 대기'} · 저/중/고 ${bands} · 출력 ${Math.round(Math.max(0,...rgb)/255*100)}%`;
        el('lfDiagnostics').style.borderColor=frame.hitAge<.15?'#22d3ee':'#475569';
      }
      if(playing&&!frame.fresh){await queue(releaseHue);status('분석 데이터 대기 · 데이터가 없으면 소등합니다.');}
      else if(playing&&el('lfHue').checked){
        await queue(async()=>{
          if(token!==generation||player.paused||player.seeking||!el('lfHue').checked)return;
          const groups=validateEntertainmentGroups();
          if(groups[0].lightIds.length!==options.pairs)throw Error('좌우 쌍 수와 A/B 그룹 전구 수를 맞춰 주세요.');
          if(!entertainmentActive)await startEntertainment();hueOwned=true;
          if(token!==generation||player.paused||player.seeking||!el('lfHue').checked){await releaseHue();return;}
          const current=show.frame(performance.now()/1000,settings());
          if(!current.fresh){await releaseHue();return;}
          const result=await api('/api/entertainment/frame',{method:'POST',body:JSON.stringify({commands:commands(current.rgb,groups),scheduleAheadMs:0})});
          if(result.ignoredLightIds?.length)throw Error('Entertainment 영역에 없는 전구가 있습니다.');
        });
      }
      if(playing&&frame.fresh)status(`LedFx 분석 → HueBeat 연출 · ${el('lfHue').checked?'Hue 출력':'웹 미리보기'} · ${frame.mode==='full'?'전체 펀치':'한 쌍 펀치·감쇠'}`);
    }catch(error){player.pause();el('lfHue').checked=false;await queue(releaseHue).catch(()=>{});status(error.message);}
    if(token===generation&&ready)timer=setTimeout(()=>render(token),25);
  }
  async function audioGraph(){
    if(context){await context.resume();return;}
    context=new AudioContext({sampleRate:48000});await context.audioWorklet.addModule('/ledfx-audio-worklet.js');
    source=context.createMediaElementSource(player);worklet=new AudioWorkletNode(context,'ledfx-pcm',{outputChannelCount:[2]});
    worklet.port.onmessage=event=>{
      if(!ready||player.paused||player.seeking||socket?.readyState!==WebSocket.OPEN||socket.bufferedAmount>64000)return;
      const pcm=new DataView(new ArrayBuffer(event.data.length*2));event.data.forEach((sample,i)=>{const v=Math.max(-1,Math.min(1,sample));pcm.setInt16(i*2,Math.round(v*(v<0?32768:32767)),true);});
      let binary='';for(const b of new Uint8Array(pcm.buffer))binary+=String.fromCharCode(b);
      send({type:'audio_stream_data_v2',client:'HueBeat-Web',data:btoa(binary)});
    };
    source.connect(worklet);worklet.connect(context.destination);await context.resume();
  }
  async function stop(){
    ready=false;generation++;clearTimeout(timer);player.pause();show.reset();
    send({type:'audio_stream_stop',client:'HueBeat-Web'});socket?.close();socket=null;
    await queue(releaseHue);try{await api('/api/ledfx/clear',{method:'POST'});}catch{}
    draw(Array(settings().pairs*3).fill(0));status('연출 정지');
  }
  const run=action=>()=>Promise.resolve().then(action).catch(error=>status(error.message));
  el('lfConnect').onclick=run(connect);el('lfStop').onclick=run(stop);
  el('lfPlay').onclick=run(async()=>{if(!ready)throw Error('분석 엔진을 먼저 연결하세요.');await audioGraph();await player.play();});el('lfPause').onclick=()=>player.pause();
  el('lfHue').onchange=run(async()=>{if(!el('lfHue').checked)await queue(releaseHue);});
  el('lfBrightness').oninput=()=>{el('lfBrightnessValue').textContent=el('lfBrightness').value+'%';};
  el('lfPairs').onchange=()=>{player.pause();show.reset();draw(Array(settings().pairs*3).fill(0));};
  el('lfMode').onchange=()=>show.reset();el('lfMove').onchange=()=>show.reset();
  el('lfFile').onchange=()=>{player.pause();if(url)URL.revokeObjectURL(url);const file=el('lfFile').files[0];if(file){url=URL.createObjectURL(file);player.src=url;}};
  const tracks=async()=>{const items=await api('/api/tracks');el('lfTrack').innerHTML='<option value="">음원 선택</option>'+items.map(t=>'<option value="'+escapeHtml(t.id)+'">'+escapeHtml(t.fileName)+'</option>').join('');};
  el('lfTracks').onclick=run(tracks);el('lfTrack').onchange=()=>{if(el('lfTrack').value){player.pause();player.src='/api/tracks/'+encodeURIComponent(el('lfTrack').value)+'/audio';}};
  player.addEventListener('play',run(async()=>{if(!ready){player.pause();throw Error('분석 엔진을 먼저 연결하세요.');}document.getElementById('audioPlayer').pause();stopShowTest(true);stopCalibration(true);try{await audioGraph();}catch(error){player.pause();throw error;}}));
  function resetPlayback(){show.reset();draw(Array(settings().pairs*3).fill(0));queue(releaseHue).catch(error=>status(error.message));}
  player.addEventListener('pause',()=>{resetPlayback();if(ready)for(let i=0;i<8;i++)send({type:'audio_stream_data_v2',client:'HueBeat-Web',data:btoa('\0'.repeat(1600))});});
  player.addEventListener('seeking',resetPlayback);
  document.getElementById('audioPlayer').addEventListener('play',()=>{if(ready)stop().catch(error=>status(error.message));});
  window.addEventListener('beforeunload',()=>{send({type:'audio_stream_stop',client:'HueBeat-Web'});socket?.close();});
  draw(Array(15).fill(0));tracks().catch(()=>{});
})();
