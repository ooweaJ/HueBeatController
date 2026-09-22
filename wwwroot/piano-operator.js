(function(root){
  'use strict';
  const $=id=>document.getElementById(id),C=root.HuePiano;
  let source,ready=false,saving=false,draft={enabled:false,sound:true,assignments:[],configurationIds:{}};
  const map=new Map();
  function status(text,error=false){$('pianoOperatorStatus').textContent=text;$('pianoOperatorStatus').classList.toggle('error',error);}
  async function request(path,method='GET',body){
    const response=await fetch(path,{method,headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
    const value=await response.json();if(!response.ok)throw new Error(value.message||'피아노 설정 요청 실패');return value;
  }
  function changed(){status('변경한 배치를 저장하면 관람객 화면에 적용됩니다.');}
  function noteFor(lightId){return ready?map.get(lightId)??null:null;}
  function setNote(lightId,note){
    if(!ready||note!==null&&(!Number.isInteger(note)||note<0||note>=C.notes.length))return false;
    if(note===null)map.delete(lightId);else map.set(lightId,note);
    changed();summary();return true;
  }
  function refresh(){
    if(!ready)return;
    $('pianoEnabled').disabled=saving;$('pianoSound').disabled=saving;
    const lights=source.getLights(),groups=source.getGroups(),configs=source.getConfigurations(),container=$('pianoMappings');
    const assigned=new Set(groups.flatMap(group=>group.lightIds));
    container.replaceChildren();
    for(const light of lights.filter(item=>!assigned.has(item.id))){
      const row=document.createElement('div');row.className='piano-map-row';
      const description=document.createElement('div'),name=document.createElement('strong'),detail=document.createElement('small');
      name.textContent=light.name;
      detail.textContent=`Bridge ${light.bridgeIndex} · 음악 그룹 미배정 · ${light.connectivity==='connected'?'연결됨':light.connectivity==='unknown'?'상태 미확인':'연결 끊김'}`;
      description.append(name,detail);
      const find=document.createElement('button');find.type='button';find.textContent='위치 찾기';find.disabled=saving;
      find.addEventListener('click',async()=>{find.disabled=true;try{await request(`/api/lights/${encodeURIComponent(light.id)}/identify`,'POST',{bridgeIndex:light.bridgeIndex});status(`${light.name} 위치를 점멸로 확인하세요.`);}catch(e){status(e.message,true);}finally{find.disabled=false;}});
      const select=document.createElement('select');select.setAttribute('aria-label',`${light.name} 피아노 음계`);
      const off=document.createElement('option');off.value='';off.textContent='미사용';select.append(off);
      C.notes.forEach(note=>{const option=document.createElement('option');option.value=note.index;option.textContent=`${note.index===7?'높은 도':note.name} · ${['빨강','주황','노랑','초록','파랑','남색','보라','빨강'][note.index]}`;select.append(option);});
      select.value=map.has(light.id)?String(map.get(light.id)):'';select.disabled=saving||!light.colorCapable;
      select.addEventListener('change',()=>setNote(light.id,select.value===''?null:Number(select.value)));
      row.append(description,find,select);container.append(row);
    }
    const missing=[...map.keys()].filter(id=>!lights.some(l=>l.id===id));
    for(const id of missing){
      const row=document.createElement('div');row.className='piano-map-row';const text=document.createElement('span');text.textContent=`현재 목록에 없는 전구 · ${id}`;
      const remove=document.createElement('button');remove.textContent='매핑 해제';remove.disabled=saving;remove.addEventListener('click',()=>{map.delete(id);changed();refresh();});row.append(text,remove);container.append(row);
    }
    if(!lights.length&&!missing.length)container.textContent='Bridge 전구를 불러오면 아래 A/B 그룹에서 음계를 지정할 수 있습니다.';
    else if(!container.children.length)container.textContent='모든 전구가 A/B 그룹에 있습니다. 아래 각 전구 행에서 음계를 지정하세요.';
    for(const index of [1,2]){
      const select=$(`pianoArea${index}`);select.replaceChildren();const none=document.createElement('option');none.value='';none.textContent='사용할 영역 선택';select.append(none);
      const list=configs.filter(c=>Number(c.bridgeIndex)===index);
      list.forEach(c=>{const option=document.createElement('option');option.value=c.id;option.textContent=`${c.name} · ${c.channelCount}채널`;select.append(option);});
      const value=draft.configurationIds[index]||'';
      if(value&&!list.some(c=>c.id===value)){const old=document.createElement('option');old.value=value;old.textContent='저장된 영역 · 현재 목록에서 확인 필요';select.append(old);}
      select.value=value;select.disabled=saving;
    }
    summary();
  }
  function summary(){
    $('pianoMappingSummary').textContent=C.notes.map(note=>`${note.index===7?'높은 도':note.name} ${[...map.values()].filter(n=>n===note.index).length}개`).join(' · ');
    const lights=new Map(source.getLights().map(light=>[light.id,light]));
    const details=$('pianoMappingDetails');details.replaceChildren();
    for(const note of C.notes){
      const matches=[...map].filter(([,index])=>index===note.index).map(([id])=>{
        const light=lights.get(id);
        if(!light)return `목록에서 사라진 전구 (${id.slice(0,8)}) · 연주 제외`;
        return `${light.name} (Bridge ${light.bridgeIndex}${draft.configurationIds[light.bridgeIndex]?'':' · 영역 미선택, 연주 제외'})`;
      });
      const row=document.createElement('div');row.className='piano-mapping-detail-row';
      const label=document.createElement('strong');label.textContent=`${note.index===7?'높은 도':note.name} · ${['빨강','주황','노랑','초록','파랑','남색','보라','빨강'][note.index]}`;
      const targets=document.createElement('span');targets.textContent=matches.length?matches.join(' · '):'지정된 전구 없음';
      row.append(label,targets);details.append(row);
    }
  }
  async function init(options){
    source=options;
    $('pianoVisitorUrl').textContent=new URL('/piano/',location.href).href;
    for(const index of [1,2])$(`pianoArea${index}`).addEventListener('change',event=>{draft.configurationIds[index]=event.target.value;changed();summary();});
    for(const id of ['pianoEnabled','pianoSound'])$(id).addEventListener('change',changed);
    $('pianoCopyMusic').addEventListener('click',()=>{
      map.clear();C.copyGroups(source.getGroups()).forEach(a=>map.set(a.lightId,a.note));
      draft.configurationIds={...source.getSelectedConfigurations()};refresh();source.renderMusicGroups?.();changed();
    });
    $('pianoSave').addEventListener('click',async()=>{
      if(!ready||saving)return;
      saving=true;$('pianoSave').disabled=true;$('pianoCopyMusic').disabled=true;
      const settings={enabled:$('pianoEnabled').checked,sound:$('pianoSound').checked,
        assignments:[...map].map(([lightId,note])=>({lightId,note})),
        configurationIds:Object.fromEntries(Object.entries(draft.configurationIds).filter(([,id])=>id))};
      refresh();
      try{draft=await request('/api/piano/settings','PUT',settings);status('저장했습니다. 관람객 화면에서 다시 시작하면 새 배치가 적용됩니다.');}
      catch(error){status(error.message,true);}
      finally{saving=false;$('pianoSave').disabled=false;$('pianoCopyMusic').disabled=false;refresh();}
    });
    $('pianoStop').addEventListener('click',async()=>{try{await request('/api/piano/operator-stop','POST',{});status('현재 피아노 연주를 종료했습니다. 운영을 중단하려면 실제 출력 허용을 끄고 저장하세요.');}catch(e){status(e.message,true);}});
    try{
      draft=await request('/api/piano/settings');draft.assignments.forEach(a=>map.set(a.lightId,a.note));
      $('pianoEnabled').checked=draft.enabled;$('pianoSound').checked=draft.sound;
      ready=true;$('pianoSave').disabled=false;$('pianoCopyMusic').disabled=false;refresh();source.renderMusicGroups?.();status('아래 A/B 그룹에서 전구 위치와 음계를 함께 확인하세요.');
    }catch(error){status(`피아노 설정을 불러오지 못했습니다: ${error.message}. 서버를 최신 빌드로 실행해 주세요.`,true);}
  }
  root.HuePianoOperator={init,refresh,noteFor,setNote,isReady:()=>ready};
})(window);
