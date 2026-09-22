(function() {
  'use strict';
  const C=window.HuePiano,$=id=>document.getElementById(id),state=C.createState();
  const buttons=[],ribbons=[],pointers=new Set(),voices=new Map();
  const preview=new URLSearchParams(location.search).get('preview')==='1';
  const idleTimeoutMs=60_000;
  const configuredBrightness=Number(window.__HUEBEAT_PIANO_BASE_BRIGHTNESS__??0);
  const baseLevel=window.__HUEBEAT_KIOSK__&&Number.isFinite(configuredBrightness)?Math.max(0,Math.min(100,configuredBrightness))/100:0;
  let sound=true,volume=50,context=null,master=null,token=null,started=false,starting=false,stopping=false;
  let pending=null,lastSignature='',lastSent=0,generation=0,lastInputAt=0;
  function message(text){$('status').textContent=text;$('welcomeStatus').textContent=text;}
  async function api(path,body){
    const response=await fetch(path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json'},
      body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(8000)});
    const data=await response.json();if(!response.ok)throw new Error(data.message||'연결을 확인하고 다시 시작해 주세요.');return data;
  }
  const ambient=preview?null:window.HueKioskAmbient.create({api,buildFrame:window.HueAmbientArt.buildFrame,
    now:()=>performance.now(),every:(fn,ms)=>setInterval(fn,ms),clearEvery:id=>clearInterval(id),
    onError:error=>{if(!started&&!starting)message(`상시 연출 연결이 끊겼어요: ${error.message}`);}});
  let ambientTransition=Promise.resolve();
  function resumeAmbient(announce=false){if(!ambient)return Promise.resolve();ambientTransition=ambientTransition.then(async()=>{await ambient.start();if(announce&&!started)message('상시 미디어아트 실행 중 · 화면을 터치하면 피아노로 전환됩니다.');}).catch(error=>message(error.message));return ambientTransition;}
  async function pauseAmbient(){if(!ambient)return;await ambientTransition;await ambient.stop();}
  function setVolume(value){
    const parsed=Number(value);
    volume=Number.isFinite(parsed)?Math.max(0,Math.min(100,parsed)):50;
    if(master)master.gain.value=.15*volume/100;
  }
  function audioReady(){
    try{
      if(!context){context=new AudioContext();master=context.createGain();master.gain.value=.15*volume/100;master.connect(context.destination);}
      if(context.state==='suspended')context.resume().catch(()=>{});
    }catch{sound=false;}
  }
  function stopVoice(i){
    const voice=voices.get(i);if(!voice)return;voices.delete(i);
    const now=Math.max(context.currentTime,voice.start+.04);
    voice.gain.gain.cancelAndHoldAtTime(now);voice.gain.gain.linearRampToValueAtTime(0,now+.18);
    voice.oscs.forEach(osc=>osc.stop(now+.2));
    voice.oscs[0].onended=()=>{voice.oscs.forEach(osc=>osc.disconnect());voice.gain.disconnect();};
  }
  function syncAudio(){
    const held=state.held();
    for(let i=0;i<C.keys.length;i++){
      if(!held[i]||!sound){stopVoice(i);continue;}
      if(!context||voices.has(i))continue;
      const gain=context.createGain(),now=context.currentTime;
      gain.gain.setValueAtTime(0,now);gain.gain.linearRampToValueAtTime(.65,now+.008);
      gain.gain.exponentialRampToValueAtTime(.16,now+.65);gain.connect(master);
      const oscs=[1,2,3].map((harmonic,j)=>{
        const osc=context.createOscillator(),partial=context.createGain();osc.frequency.value=C.keys[i].hz*harmonic;
        partial.gain.value=[1,.22,.07][j];osc.connect(partial);partial.connect(gain);
        osc.addEventListener('ended',()=>partial.disconnect());osc.start();return osc;
      });voices.set(i,{gain,oscs,start:now});
    }
  }
  function render(){
    const held=state.held(),levels=C.noteLevels(state.frame(performance.now())).map(level=>started?baseLevel+(1-baseLevel)*level:0);
    buttons.forEach((button,i)=>{button.classList.toggle('pressed',held[i]);button.setAttribute('aria-pressed',String(held[i]));});
    ribbons.forEach((r,i)=>r.style.setProperty('--level',levels[i].toFixed(3)));return levels;
  }
  function clear(){if(started&&state.held().some(Boolean))lastInputAt=performance.now();pointers.clear();state.clear();syncAudio();render();lastSignature='';pump();}
  function press(owner,i){if(!started)return;lastInputAt=performance.now();state.press(owner,i,lastInputAt);syncAudio();render();pump();}
  function release(owner){if(started&&state.held().some(Boolean))lastInputAt=performance.now();state.release(owner,performance.now());syncAudio();render();pump();}
  function checkIdle(){
    if(!started||starting||stopping)return;
    if(state.held().some(Boolean))return;
    if(performance.now()-lastInputAt>=idleTimeoutMs)void stop('잠시 연주가 없어 시작 화면으로 돌아왔어요.');
  }
  function pump(){
    if(!token||pending||stopping)return;
    const levels=render(),signature=levels.map(v=>Math.round(v*100)).join(','),now=performance.now();
    if(signature===lastSignature&&now-lastSent<250)return;
    lastSignature=signature;lastSent=now;
    pending=api('/api/piano/frame',{token,levels}).catch(()=>{
      if(!stopping)queueMicrotask(()=>stop('연주 연결이 잠시 끊겼어요. 다시 시작해 주세요.'));
    }).finally(()=>{pending=null;});
  }
  async function begin(){
    if(starting||stopping)return;
    const current=++generation;starting=true;$('begin').disabled=true;audioReady();
    try{
      const config=await api('/api/piano/config');sound=config.sound!==false;setVolume(config.volume??50);
      if(current!==generation)return;
      if(!config.enabled&&!preview)throw new Error('운영 화면에서 피아노 전구 출력을 허용해 주세요.');
      if(!preview){
        await pauseAmbient();
        const result=await api('/api/piano/session',{});
        if(current!==generation){await api('/api/piano/stop',{token:result.token});return;}
        token=result.token;sound=result.sound!==false;setVolume(result.volume??50);
      }
      state.clear();started=true;lastInputAt=performance.now();$('welcome').hidden=true;$('endUse').hidden=false;lastSignature='';pump();
      message(token?'건반을 누르면 소리와 빛이 함께 피어나요.':'지금은 화면의 빛과 소리로 자유롭게 연주해 보세요.');
    }catch(error){message(error.message);if(!preview)await resumeAmbient();}
    finally{starting=false;$('begin').disabled=false;}
  }
  async function stop(reason){
    ++generation;if(stopping)return;stopping=true;started=false;clear();
    const owned=token;token=null;if(pending)await pending;
    if(owned)try{await api('/api/piano/stop',{token:owned});}catch{}
    $('endUse').hidden=true;$('welcome').hidden=false;message(reason||'터치하면 다시 연주할 수 있어요.');
    await resumeAmbient(true);stopping=false;
  }
  C.notes.forEach(note=>{const ribbon=document.createElement('span');ribbon.className='ribbon';ribbon.style.setProperty('--note',note.color);$('ribbons').append(ribbon);ribbons.push(ribbon);});
  C.keys.forEach(note=>{
    const button=document.createElement('button');button.type='button';button.className='key';button.dataset.note=note.index;
    button.style.setProperty('--note',note.color);button.setAttribute('aria-label',`${note.name} ${note.pitch}`);button.setAttribute('aria-pressed','false');
    button.innerHTML=`<span class="dot"></span><strong>${note.name}</strong><small>${note.pitch}</small>`;
    button.addEventListener('click',event=>{if(event.detail===0){press('accessible',note.index);release('accessible');}});
    $(`${note.range}Keys`).append(button);buttons.push(button);
  });
  const keyboard=$('keyboard');
  function noteAt(event){const target=document.elementFromPoint(event.clientX,event.clientY)?.closest('.key');return target?Number(target.dataset.note):null;}
  keyboard.addEventListener('pointerdown',event=>{
    if(!started||(event.pointerType==='mouse'&&event.button!==0))return;
    const note=noteAt(event);if(note===null)return;event.preventDefault();pointers.add(event.pointerId);
    keyboard.setPointerCapture(event.pointerId);press(`pointer-${event.pointerId}`,note);
  });
  keyboard.addEventListener('pointermove',event=>{
    if(!pointers.has(event.pointerId))return;const note=noteAt(event);
    if(note===null)release(`pointer-${event.pointerId}`);else press(`pointer-${event.pointerId}`,note);
  });
  for(const name of ['pointerup','pointercancel','lostpointercapture'])keyboard.addEventListener(name,event=>{pointers.delete(event.pointerId);release(`pointer-${event.pointerId}`);});
  keyboard.addEventListener('contextmenu',event=>event.preventDefault());
  window.addEventListener('keydown',event=>{
    if(event.ctrlKey||event.altKey||event.metaKey||event.repeat)return;
    const index=C.keys.findIndex(n=>n.key===event.code);if(index<0)return;event.preventDefault();press(event.code,index);
  });
  window.addEventListener('keyup',event=>release(event.code));window.addEventListener('blur',clear);
  document.addEventListener('visibilitychange',()=>{if(document.hidden)stop();});
  window.addEventListener('pagehide',()=>{
    state.clear();syncAudio();if(token)navigator.sendBeacon('/api/piano/stop',new Blob([JSON.stringify({token})],{type:'application/json'}));
  });
  $('begin').addEventListener('click',begin);
  $('endUse').addEventListener('click',()=>stop('다시 연주하려면 화면을 터치해 주세요.'));
  if(window.__HUEBEAT_KIOSK__){
    $('fullscreen').hidden=true;
  }else{
    $('fullscreen').addEventListener('click',async()=>{try{if(document.fullscreenElement)await document.exitFullscreen();else await document.documentElement.requestFullscreen();}catch{message('화면을 넓히려면 브라우저의 전체 화면을 선택해 주세요.');}});
    document.addEventListener('fullscreenchange',()=>{$('fullscreen').setAttribute('aria-label',document.fullscreenElement?'전체 화면 나가기':'전체 화면');});
  }
  setInterval(()=>{checkIdle();render();pump();},40);render();resumeAmbient(true);
})();
