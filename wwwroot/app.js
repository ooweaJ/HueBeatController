const $ = selector => document.querySelector(selector);
const escapeHtml = value => String(value ?? '').replace(/[&<>"]/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[char]));
const defaultColors = ['#ff416c','#19d3c5','#587dff','#ffc857','#a855f7','#ff7a00','#44d17a','#f05cff'];
const placementColors = ['#ff3131','#ff8a00','#ffd60a','#25d366','#1687ff','#3f37c9','#a855f7','#ff2d9a'];
const mediaArtPalette = ['#ff3155','#ff8a00','#ffd43b','#36d978','#22b8ff','#5965ff','#a855f7','#ff4fb3'];
const placementColorNames = ['빨강','주황','노랑','초록','파랑','남색','보라','핑크'];
const legacyMusicGroups = ['A','B'];
const MUSIC_COMMAND_INTERVAL_MS = 1000, ENTERTAINMENT_FRAME_INTERVAL_MS = 50, ENTERTAINMENT_SCHEDULE_AHEAD_MS = 35;
let lights = [], phase = 0, commandBusy = false, musicStyle = 'entertainment';
let audioContext, analyser, sourceNode, playerSourceNode, activeStream, animationFrame;
let playbackTimer;
let lastBeatAt = 0, beatTimes = [], energyHistory = [], beatCount = 0;
let analyzedTrack = null, audioObjectUrl = null, analyzedBeatCursor = 0, analyzedEnvelopeCursor = -1, timelineLayer = 'all';
let savedTracks = [], activeTrackId = null;
let lastMusicCommandAt = 0, lastScheduledMusicBeat = -Infinity;
let musicScenesReady = false, musicGroupsReady = false;
let entertainmentActive=false,entertainmentFrameBusy=false,entertainmentLastFrameAt=0,entertainmentSelectedId='',entertainmentConfigurations=[],entertainmentAccentBucket=-1,entertainmentFlashUntil=0;
let showTestTimer, showTestFadeTimer, showTestStep = 0, showTestPreviewOnly = false, equalizerLastLevel = -1, equalizerLastSentAt = 0;
let equalizerSamples = [], equalizerCalibrationStartedAt = 0, equalizerHoldUntil = 0, equalizerColorDirty = false;
let masterTimer, lightTimer, modalHsv = {h:0,s:0,v:1}, modalConfirm, wheelImage;
let editingGroup = null, groupDraft = null, renamingLightId = null;
const expandedLightIds = new Set();
let controllerSettingsReady = false, controllerSettingsSaveTimer;
let audioSyncMs = 0, lightSyncMs = 0, syncVerificationActive = false;
let calibrationTargetAt = 0, calibrationTimer = null, calibrationSignalTimer = null, calibrationOffTimer = null, calibrationVisualFrame = null, calibrationTrialStartedAt = 0, calibrationFired = false;

const manual = (() => {
  try { return {...{masterBrightness:100,masterColor:'#ffffff',lightBrightness:{},lightColors:{}}, ...JSON.parse(localStorage.getItem('hue-manual-settings') || '{}')}; }
  catch { return {masterBrightness:100,masterColor:'#ffffff',lightBrightness:{},lightColors:{}}; }
})();
const saveManual = () => { localStorage.setItem('hue-manual-settings', JSON.stringify(manual)); queueControllerSettingsSave(); };

function newId(prefix) {
  return `${prefix}-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`}`;
}
function makeGroup(mode, index, overrides = {}) {
  return {
    id:newId(mode),
    name:`${mode === 'normal' ? '일반' : '음악'} 그룹 ${index + 1}`,
    color:defaultColors[index % defaultColors.length],
    brightness:mode === 'normal' ? 100 : 80,
    lightIds:[],
    ...overrides
  };
}
function sanitizeGroups(value) {
  const result = {normal:[], music:[]};
  for (const mode of ['normal','music']) {
    const source = Array.isArray(value?.[mode]) ? value[mode] : [];
    result[mode] = source.map((group,index) => ({
      id:String(group.id || newId(mode)).replace(/[^a-z0-9_-]/gi,'-'),
      name:String(group.name || `${mode === 'normal' ? '일반' : '음악'} 그룹 ${index + 1}`).slice(0,24),
      color:/^#[0-9a-f]{6}$/i.test(group.color || '') ? group.color.toLowerCase() : defaultColors[index % defaultColors.length],
      brightness:Math.max(1,Math.min(100,Number(group.brightness) || 100)),
      lightIds:Array.isArray(group.lightIds) ? [...new Set(group.lightIds.map(String))] : []
    }));
  }
  if (!result.normal.length) result.normal.push(makeGroup('normal',0));
  result.music=result.music.slice(0,2);
  while(result.music.length<2){
    const index=result.music.length;
    result.music.push(makeGroup('music',index,{name:index===0?'왼쪽 A 그룹':'오른쪽 B 그룹',brightness:100}));
  }
  return result;
}
function loadGroupState() {
  try {
    const stored = JSON.parse(localStorage.getItem('hue-mode-groups-v1') || 'null');
    if (stored) return sanitizeGroups(stored);
  } catch {}
  let legacyMapping = {}, legacyColors = {};
  try { legacyMapping = JSON.parse(localStorage.getItem('hue-light-groups') || '{}'); } catch {}
  try { legacyColors = JSON.parse(localStorage.getItem('hue-group-colors') || '{}'); } catch {}
  return sanitizeGroups({
    normal:[makeGroup('normal',0,{name:'일반 그룹 1',color:'#ffffff',brightness:100})],
    music:legacyMusicGroups.map((letter,index) => makeGroup('music',index,{
      id:`legacy-${letter}`,
      name:`${letter} 그룹`,
      color:legacyColors[letter] || defaultColors[index],
      brightness:80,
      lightIds:Object.entries(legacyMapping).filter(([,group]) => group === letter).map(([lightId]) => lightId)
    }))
  });
}
let groupState = loadGroupState();
function saveGroups() { musicScenesReady=false;musicGroupsReady=false;localStorage.setItem('hue-mode-groups-v1', JSON.stringify(groupState));if(document.querySelector('#entertainmentMapping'))updateEntertainmentMapping();queueControllerSettingsSave(); }
function normalizeMembership(mode) {
  const seen = new Set();
  groupState[mode].forEach(group => { group.lightIds = group.lightIds.filter(id => !seen.has(id) && seen.add(id)); });
}
normalizeMembership('normal'); normalizeMembership('music'); saveGroups();

function controllerSettingsSnapshot() {
  return {
    version:1,
    groups:groupState,
    manual,
    musicStyle,
    controls:{
      manualTransition:Number($('#manualTransition')?.value||80),testBpm:Number($('#testBpm')?.value||60),beatBrightness:Number($('#beatBrightness')?.value||100),transition:Number($('#transition')?.value||80),audioSyncMs,lightSyncMs,syncOffset:totalSyncMs(),sensitivity:Number($('#sensitivity')?.value||1.45),minInterval:Number($('#minInterval')?.value||260),equalizerGroup:$('#equalizerGroup')?.value||'',entertainmentConfigurationId:$('#entertainmentConfiguration')?.value||entertainmentSelectedId||'',entertainmentAccentInterval:Number($('#entertainmentAccentInterval')?.value||500),entertainmentPunch:Number($('#entertainmentPunch')?.value||100)
    }
  };
}
async function saveControllerSettingsNow(){if(!controllerSettingsReady)return;await api('/api/controller-settings',{method:'PUT',body:JSON.stringify(controllerSettingsSnapshot())});}
function queueControllerSettingsSave(){if(!controllerSettingsReady)return;clearTimeout(controllerSettingsSaveTimer);controllerSettingsSaveTimer=setTimeout(()=>saveControllerSettingsNow().catch(error=>console.error('제어 설정 저장 실패',error)),250);}
function applyStoredControllerSettings(settings){
  if(settings?.groups)groupState=sanitizeGroups(settings.groups);
  if(settings?.manual&&typeof settings.manual==='object'){
    manual.masterBrightness=Number(settings.manual.masterBrightness)||100;manual.masterColor=settings.manual.masterColor||'#ffffff';manual.lightBrightness={...(settings.manual.lightBrightness||{})};manual.lightColors={...(settings.manual.lightColors||{})};
  }
  musicStyle='entertainment';localStorage.setItem('hue-mode-groups-v1',JSON.stringify(groupState));localStorage.setItem('hue-manual-settings',JSON.stringify(manual));localStorage.setItem('hue-music-style',musicStyle);
}
function applyStoredControls(controls={}){
  const values={manualTransition:controls.manualTransition,testBpm:controls.testBpm,beatBrightness:controls.beatBrightness,transition:controls.transition,sensitivity:controls.sensitivity,minInterval:controls.minInterval,entertainmentAccentInterval:controls.entertainmentAccentInterval,entertainmentPunch:controls.entertainmentPunch};
  Object.entries(values).forEach(([id,value])=>{const input=document.getElementById(id);if(input&&value!==undefined){input.value=id==='testBpm'?Math.min(60,Math.max(30,Number(value)||60)):value;input.dispatchEvent(new Event('input'));}});
  if(controls.audioSyncMs!==undefined||controls.lightSyncMs!==undefined){audioSyncMs=Number(controls.audioSyncMs)||0;lightSyncMs=Number(controls.lightSyncMs)||0;}
  else{audioSyncMs=0;lightSyncMs=Number(controls.syncOffset)||0;}
  syncCalibrationUi(false);
  if(audioSyncMs||lightSyncMs)$('#calibrationStatus').textContent=`저장된 보정값을 불러왔습니다. 오디오 ${signedMs(audioSyncMs)}, 전구 최종 ${signedMs(totalSyncMs())}입니다.`;
  if(controls.equalizerGroup&&[...$('#equalizerGroup').options].some(option=>option.value===controls.equalizerGroup))$('#equalizerGroup').value=controls.equalizerGroup;
  entertainmentSelectedId=String(controls.entertainmentConfigurationId||'');
}

async function api(path, options = {}) {
  const headers=options.body instanceof FormData?{}:{'Content-Type':'application/json'};
  const response = await fetch(path, {...options,headers:{...headers,...(options.headers||{})}});
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || `요청 실패 (${response.status})`);
  return data;
}
function setMessage(text, type = '') {
  const node = $('#connectionMessage'); node.textContent = text; node.className = `message ${type}`;
}
function connectedLightIds() {
  return lights.filter(light => light.connectivity === 'connected' || light.connectivity === 'unknown').map(light => light.id);
}
function commandFor(lightId, {on=true,color=null,brightness=effectiveBrightness(lightId),transition=Number($('#manualTransition').value)} = {}) {
  return {lightIds:[lightId],hexColor:color,brightness,transitionMs:transition,on};
}
function effectiveBrightness(id) {
  const personal = Number(manual.lightBrightness[id] ?? 100);
  return Math.max(.1, Math.min(100, personal * Number(manual.masterBrightness) / 100));
}
async function sendCommands(commands, successText = '') {
  if (!commands.length) { setMessage('제어할 전구가 없습니다.','error'); return; }
  const result=await api('/api/control',{method:'POST',body:JSON.stringify({commands})});
  if (successText) setMessage(successText,'success');
  return result;
}
document.querySelectorAll('[data-mode]').forEach(button => button.addEventListener('click', () => {
  document.querySelectorAll('[data-mode]').forEach(item => item.classList.toggle('active', item === button));
  $('#normalPanel').hidden = button.dataset.mode !== 'normal';
  $('#musicPanel').hidden = button.dataset.mode !== 'music';
}));

function groupForLight(mode, lightId) { return groupState[mode].find(group => group.lightIds.includes(lightId)); }
function moveLight(mode, lightId, targetGroupId = null) {
  groupState[mode].forEach(group => { group.lightIds = group.lightIds.filter(id => id !== lightId); });
  if (targetGroupId) groupState[mode].find(group => group.id === targetGroupId)?.lightIds.push(lightId);
  saveGroups(); renderGroupManager(mode); renderLights();
}
function moveLightByOffset(mode, groupId, lightId, offset) {
  const group=groupState[mode].find(item=>item.id===groupId);if(!group)return;
  const fromIndex=group.lightIds.indexOf(lightId),toIndex=fromIndex+offset;if(fromIndex<0||toIndex<0||toIndex>=group.lightIds.length)return;
  [group.lightIds[fromIndex],group.lightIds[toIndex]]=[group.lightIds[toIndex],group.lightIds[fromIndex]];saveGroups();renderGroupManager(mode);
  const light=lights.find(item=>item.id===lightId);setMessage(`${light?.name||'전구'}를 ${String(toIndex+1).padStart(2,'0')}번으로 이동했습니다.`,'success');
}
function reorderLight(mode, lightId, targetGroupId, targetLightId) {
  if(lightId===targetLightId)return;
  const sourceGroup=groupForLight(mode,lightId),targetGroup=groupState[mode].find(group=>group.id===targetGroupId);if(!targetGroup)return;
  const sameGroup=sourceGroup?.id===targetGroupId,originalSourceIndex=sameGroup?sourceGroup.lightIds.indexOf(lightId):-1,originalTargetIndex=targetGroup.lightIds.indexOf(targetLightId);
  groupState[mode].forEach(group=>{group.lightIds=group.lightIds.filter(id=>id!==lightId);});
  const targetIndex=targetGroup.lightIds.indexOf(targetLightId);if(targetIndex<0)return;
  const insertIndex=sameGroup&&originalSourceIndex<originalTargetIndex?targetIndex+1:targetIndex;
  targetGroup.lightIds.splice(insertIndex,0,lightId);saveGroups();renderGroupManager(mode);renderLights();
  const light=lights.find(item=>item.id===lightId);setMessage(`${light?.name||'전구'}를 ${String(insertIndex+1).padStart(2,'0')}번으로 이동했습니다.`,'success');
}
function addGroup(mode) {
  if(mode==='music'){setMessage('Entertainment 음악 그룹은 왼쪽 A와 오른쪽 B 두 개만 사용합니다.','error');return;}
  groupState[mode].push(makeGroup(mode,groupState[mode].length)); saveGroups(); renderGroupManager(mode);
}
function deleteGroup(mode, groupId) {
  const group = groupState[mode].find(item => item.id === groupId); if (!group) return;
  if (!confirm(`'${group.name}' 그룹을 삭제할까요? 전구는 미배정 상태로 이동합니다.`)) return;
  groupState[mode] = groupState[mode].filter(item => item.id !== groupId);
  saveGroups(); renderGroupManager(mode); renderLights();
}
function lightChip(light, removable = false, mode = '', groupId = '') {
  return `<span class="light-chip draggable-chip" draggable="true" data-drag-light="${light.id}" data-drag-mode="${mode}">${escapeHtml(light.name)}${removable ? `<button data-remove-light="${light.id}" data-remove-mode="${mode}" data-remove-group="${groupId}" aria-label="${escapeHtml(light.name)} 그룹에서 제거">×</button>` : ''}</span>`;
}
function orderedLightRow(light, mode, groupId, index, count) {
  const color=placementColors[index%placementColors.length],colorName=placementColorNames[index%placementColorNames.length];
  return `<div class="ordered-light-row draggable-chip" draggable="true" data-drag-light="${light.id}" data-drag-mode="${mode}" data-light-slot="${light.id}" title="${String(index+1).padStart(2,'0')}번 · 배치 확인 시 ${colorName}">
    <span class="light-drag-handle" aria-hidden="true">⠿</span><strong class="light-order-number">${String(index+1).padStart(2,'0')}</strong><span class="placement-swatch" style="background:${color}"></span><span class="ordered-light-name">${escapeHtml(light.name)}</span>
    <span class="light-order-actions"><button type="button" data-rename-light="${light.id}" class="rename-order-light" aria-label="${escapeHtml(light.name)} 이름 수정" title="이름 수정">✎</button><button type="button" data-light-order-offset="-1" ${index===0?'disabled':''} aria-label="${escapeHtml(light.name)} 앞으로 이동">↑</button><button type="button" data-light-order-offset="1" ${index===count-1?'disabled':''} aria-label="${escapeHtml(light.name)} 뒤로 이동">↓</button><button type="button" data-remove-light="${light.id}" data-remove-mode="${mode}" data-remove-group="${groupId}" aria-label="${escapeHtml(light.name)} 그룹에서 제거">×</button></span>
  </div>`;
}
function renderGroupManager(mode) {
  normalizeMembership(mode);
  const groups = groupState[mode], container = $(`#${mode}Groups`), pool = $(`#${mode}Unassigned`);
  const assigned = new Set(groups.flatMap(group => group.lightIds));
  const unassigned = lights.filter(light => !assigned.has(light.id));
  pool.innerHTML = `<div><strong>미배정 전구</strong><span>${unassigned.length}개 · 그룹 카드로 드래그하거나 아래 선택 메뉴로 이동하세요.</span></div><div class="pool-chips">${unassigned.length ? unassigned.map(light => lightChip(light,false,mode)).join('') : '<small>모든 전구가 그룹에 배정되었습니다.</small>'}</div>`;
  pool.dataset.dropMode = mode;
  container.innerHTML = groups.length ? groups.map((group,index) => {
    const members = group.lightIds.map(id => lights.find(light => light.id === id)).filter(Boolean);
    const candidates = lights.filter(light => !group.lightIds.includes(light.id));
    const modeActions = mode === 'normal'
      ? `<button data-group-action="on">켜기</button><button data-group-action="apply" class="accent">설정 적용</button><button data-group-action="layout">배치 색상 확인</button><button data-group-action="off">끄기</button>`
      : `<button data-group-action="preview" class="accent">그룹 테스트</button><button data-group-action="layout">배치 색상 확인</button>`;
    return `<article class="control-group-card" data-group-id="${group.id}" data-group-mode="${mode}" style="--group-color:${group.color}">
      <header><span class="group-index">${String(index + 1).padStart(2,'0')}</span><span class="color-swatch" style="background:${group.color}"></span><div class="group-title"><strong>${escapeHtml(group.name)}</strong><small>${members.length}개 전구 · ${Math.round(group.brightness)}%</small></div></header>
      <div class="assigned-lights drop-target">${members.length ? members.map((light,lightIndex) => orderedLightRow(light,mode,group.id,lightIndex,members.length)).join('') : '<small>전구를 이곳으로 드래그하세요.</small>'}</div>
      <div class="group-move-row"><select data-group-light-select ${candidates.length ? '' : 'disabled'}>${candidates.map(light => `<option value="${light.id}">${escapeHtml(light.name)}${groupForLight(mode,light.id) ? ` · ${escapeHtml(groupForLight(mode,light.id).name)}` : ' · 미배정'}</option>`).join('')}</select><button data-move-selected ${candidates.length ? '' : 'disabled'}>여기로 이동</button></div>
      <div class="group-card-actions">${modeActions}<button data-group-settings>그룹 설정</button>${mode==='normal'?'<button data-delete-group class="danger">삭제</button>':''}</div>
    </article>`;
  }).join('') : '<div class="empty">그룹이 없습니다. 위의 그룹 추가 버튼을 눌러주세요.</div>';
  bindGroupInteractions(mode);
  renderEqualizerGroupOptions();
}
function bindGroupInteractions(mode) {
  const container = $(`#${mode}Groups`), pool = $(`#${mode}Unassigned`);
  container.querySelectorAll('[data-rename-light]').forEach(button=>button.addEventListener('click',event=>{event.stopPropagation();openRenameLight(button.dataset.renameLight);}));
  container.querySelectorAll('[data-light-order-offset]').forEach(button=>button.addEventListener('click',event=>{
    event.stopPropagation();const card=button.closest('[data-group-id]'),row=button.closest('[data-light-slot]');moveLightByOffset(mode,card.dataset.groupId,row.dataset.lightSlot,Number(button.dataset.lightOrderOffset));
  }));
  container.querySelectorAll('[data-remove-light]').forEach(button => button.addEventListener('click', event => { event.stopPropagation(); moveLight(mode,button.dataset.removeLight); }));
  container.querySelectorAll('[data-move-selected]').forEach(button => button.addEventListener('click', () => {
    const card = button.closest('[data-group-id]'), select = card.querySelector('[data-group-light-select]');
    if (select.value) moveLight(mode,select.value,card.dataset.groupId);
  }));
  container.querySelectorAll('[data-group-settings]').forEach(button => button.addEventListener('click', () => {
    const card = button.closest('[data-group-id]'); openGroupSettings(mode,card.dataset.groupId);
  }));
  container.querySelectorAll('[data-delete-group]').forEach(button => button.addEventListener('click', () => {
    const card = button.closest('[data-group-id]'); deleteGroup(mode,card.dataset.groupId);
  }));
  container.querySelectorAll('[data-group-action]').forEach(button => button.addEventListener('click', async () => {
    const card = button.closest('[data-group-id]');
    try { await applyGroup(mode,card.dataset.groupId,button.dataset.groupAction); }
    catch (error) { setMessage(error.message,'error'); }
  }));
  document.querySelectorAll(`[data-drag-mode="${mode}"]`).forEach(chip => chip.addEventListener('dragstart', event => {
    event.dataTransfer.setData('text/plain',JSON.stringify({kind:'light',mode,lightId:chip.dataset.dragLight})); event.dataTransfer.effectAllowed='move';
  }));
  container.querySelectorAll('[data-light-slot]').forEach(row=>{
    row.addEventListener('dragover',event=>{event.preventDefault();event.stopPropagation();row.classList.add('drag-over');});
    row.addEventListener('dragleave',event=>{event.stopPropagation();row.classList.remove('drag-over');});
    row.addEventListener('drop',event=>{event.preventDefault();event.stopPropagation();row.classList.remove('drag-over');try{const data=JSON.parse(event.dataTransfer.getData('text/plain'));if(data.mode===mode&&data.kind==='light')reorderLight(mode,data.lightId,row.closest('[data-group-id]').dataset.groupId,row.dataset.lightSlot);}catch{}});
  });
  container.querySelectorAll('.control-group-card').forEach(card => {
    card.addEventListener('dragover',event => { event.preventDefault(); card.classList.add('drag-over'); });
    card.addEventListener('dragleave',() => card.classList.remove('drag-over'));
    card.addEventListener('drop',event => { event.preventDefault(); card.classList.remove('drag-over'); try { const data=JSON.parse(event.dataTransfer.getData('text/plain')); if(data.mode===mode&&data.lightId)moveLight(mode,data.lightId,card.dataset.groupId); } catch {} });
  });
  pool.ondragover=event => { event.preventDefault(); pool.classList.add('drag-over'); };
  pool.ondragleave=() => pool.classList.remove('drag-over');
  pool.ondrop=event => { event.preventDefault(); pool.classList.remove('drag-over'); try { const data=JSON.parse(event.dataTransfer.getData('text/plain')); if(data.mode===mode&&data.kind!=='group'&&data.lightId)moveLight(mode,data.lightId); } catch {} };
}
function renderEqualizerGroupOptions() {
  const select=$('#equalizerGroup');if(!select)return;const previous=select.value;
  const options=['normal','music'].flatMap(mode=>groupState[mode].filter(group=>group.lightIds.length).map(group=>({value:`${mode}:${group.id}`,label:`${mode==='normal'?'일반':'음악'} · ${group.name} (${group.lightIds.length}개)`})));
  select.innerHTML=options.length?options.map(option=>`<option value="${option.value}">${escapeHtml(option.label)}</option>`).join(''):'<option value="">전구가 포함된 그룹 없음</option>';
  if(options.some(option=>option.value===previous))select.value=previous;
}
function renderAllGroups() { renderGroupManager('normal'); renderGroupManager('music'); renderEqualizerGroupOptions(); updateEntertainmentAreaManager(); }
document.querySelectorAll('[data-add-group]').forEach(button => button.addEventListener('click',() => addGroup(button.dataset.addGroup)));

async function applyGroup(mode, groupId, action = 'apply') {
  const group = groupState[mode].find(item => item.id === groupId); if (!group) return;
  const controllable = new Set(connectedLightIds()), ids = group.lightIds.filter(id => controllable.has(id));
  if (!ids.length) throw new Error(`${group.name}에 연결된 전구가 없습니다.`);
  if(action==='layout'){
    const commands=group.lightIds.map((id,index)=>({id,index})).filter(item=>controllable.has(item.id)).map(item=>({lightIds:[item.id],hexColor:placementColors[item.index%placementColors.length],brightness:group.brightness,transitionMs:80,on:true}));
    await sendCommands(commands);setMessage(`${group.name} 배치 확인 완료 · 01번부터 빨강→주황→노랑→초록→파랑→남색→보라→핑크`,'success');return;
  }
  const on = action !== 'off';
  const brightness = mode === 'music' ? Math.max(.1,group.brightness * Number($('#beatBrightness').value) / 100) : group.brightness;
  const command = {lightIds:ids,hexColor:on ? group.color : null,brightness,transitionMs:Number(mode === 'music' ? $('#transition').value : $('#manualTransition').value),on};
  if (mode === 'music') await sendCommands([command]);
  else await sendCommands([command]);
  setMessage(`${group.name} ${action === 'off' ? '끄기' : action === 'on' ? '켜기' : action === 'preview' ? '테스트' : '설정 적용'} 완료`,'success');
}

function renderLights() {
  $('#lightsEmpty').hidden = lights.length > 0;
  const statusRank={connected:0,unknown:1,disconnected:2};
  const orderedLights=[...lights].sort((left,right)=>(statusRank[left.connectivity]??2)-(statusRank[right.connectivity]??2)||left.name.localeCompare(right.name,'ko',{numeric:true}));
  const firstNonConnected=orderedLights.findIndex(light=>light.connectivity!=='connected');
  const connectedCount=lights.filter(light=>light.connectivity==='connected').length,unknownCount=lights.filter(light=>light.connectivity==='unknown').length,offlineCount=lights.length-connectedCount-unknownCount;
  $('#lightsSummary').textContent=`Bridge 등록 ${lights.length}개 · 연결 ${connectedCount}개${unknownCount?` · 확인 중 ${unknownCount}개`:''}${offlineCount?` · 연결 끊김 ${offlineCount}개`:''}`;
  $('#lightsGrid').innerHTML = orderedLights.map((light,listIndex) => {
    manual.lightBrightness[light.id] ??= Math.round(light.brightness || 100);
    manual.lightColors[light.id] ??= '#ffffff';
    const reachable = light.connectivity === 'connected' || light.connectivity === 'unknown';
    const statusClass = light.connectivity === 'connected' ? '' : light.connectivity === 'unknown' ? 'unknown' : 'offline';
    const statusText = light.connectivity === 'connected' ? '연결됨' : light.connectivity === 'unknown' ? '확인 중' : '연결 끊김';
    const expanded=expandedLightIds.has(light.id);
    const normalGroup = groupForLight('normal',light.id), musicGroup = groupForLight('music',light.id);
    const divider=listIndex===firstNonConnected?`<div class="light-list-divider"><strong>연결 안 된 전구</strong><span>불이 켜져 보여도 Bridge의 Zigbee 연결이 끊겼다면 이 아래에 표시됩니다.</span></div>`:'';
    return `${divider}<article class="light-item ${expanded?'expanded':''} ${light.on ? '' : 'off'} ${reachable ? '' : 'unreachable'}" data-light-card="${light.id}">
      <div class="light-compact-row"><span class="lamp"></span><div class="light-compact-name"><strong>${escapeHtml(light.name)}</strong><span class="light-status ${statusClass}">${statusText}</span></div><span class="light-power-state">${light.on?'켜짐':'꺼짐'}</span><button type="button" class="light-expand-button" data-toggle-light-details="${light.id}" aria-expanded="${expanded}">${expanded?'접기':'확대'}</button></div>
      <div class="light-details" ${expanded?'':'hidden'}>
        <div class="light-heading"><div><div class="light-name-row"><div class="light-name">${escapeHtml(light.name)}</div><button class="rename-light-button" data-rename-light="${light.id}">이름 변경</button></div><div class="light-id">${escapeHtml(light.id)}</div></div></div>
        <div class="membership-row"><span>일반 · ${escapeHtml(normalGroup?.name || '미배정')}</span><span>음악 · ${escapeHtml(musicGroup?.name || '미배정')}</span></div>
        <label class="light-slider">개별 밝기 <output data-light-brightness-output="${light.id}">${manual.lightBrightness[light.id]}%</output><input data-light-brightness="${light.id}" type="range" min="1" max="100" value="${manual.lightBrightness[light.id]}" ${reachable ? '' : 'disabled'}></label>
        <button class="color-button light-color-button" data-edit-light-color="${light.id}" ${reachable ? '' : 'disabled'}><span class="color-swatch" style="background:${manual.lightColors[light.id]}"></span><span><small>개별 RGB</small><strong>${manual.lightColors[light.id].toUpperCase()}</strong></span></button>
        <div class="light-actions"><button data-light-action="on" data-light-id="${light.id}" ${reachable ? '' : 'disabled'}>켜기</button><button class="test" data-light-action="test" data-light-id="${light.id}" ${reachable ? '' : 'disabled'}>식별 테스트</button><button data-light-action="off" data-light-id="${light.id}" ${reachable ? '' : 'disabled'}>끄기</button></div>
      </div>
    </article>`;
  }).join('');
  saveManual();
  const grid=$('#lightsGrid');
  grid.querySelectorAll('[data-toggle-light-details]').forEach(button=>button.addEventListener('click',()=>{const id=button.dataset.toggleLightDetails;if(expandedLightIds.has(id))expandedLightIds.delete(id);else expandedLightIds.add(id);renderLights();}));
  grid.querySelectorAll('[data-light-action]').forEach(button => button.addEventListener('click',() => controlSingleLight(button)));
  grid.querySelectorAll('[data-edit-light-color]').forEach(button => button.addEventListener('click',() => editLightColor(button.dataset.editLightColor)));
  grid.querySelectorAll('[data-rename-light]').forEach(button => button.addEventListener('click',() => openRenameLight(button.dataset.renameLight)));
  grid.querySelectorAll('[data-light-brightness]').forEach(slider => {
    slider.addEventListener('input',() => { const id=slider.dataset.lightBrightness; manual.lightBrightness[id]=Number(slider.value); saveManual(); document.querySelector(`[data-light-brightness-output="${id}"]`).textContent=`${slider.value}%`; clearTimeout(lightTimer); lightTimer=setTimeout(()=>applyLightBrightness(id),140); });
    slider.addEventListener('change',() => applyLightBrightness(slider.dataset.lightBrightness));
  });
}
async function applyLightBrightness(id) { try { await sendCommands([commandFor(id,{color:manual.lightColors[id]})],'개별 밝기를 적용했습니다.'); } catch(error){setMessage(error.message,'error');} }
function editLightColor(id) {
  const light=lights.find(item=>item.id===id); openColorModal(`${light?.name || '전구'} RGB 색상`,manual.lightColors[id] || '#ffffff',async hex=>{manual.lightColors[id]=hex;saveManual();renderLights();await sendCommands([commandFor(id,{color:hex})],`${light?.name || '전구'} 색상을 적용했습니다.`);});
}
async function controlSingleLight(button) {
  const id=button.dataset.lightId,action=button.dataset.lightAction;button.disabled=true;
  try {
    if(action==='test'){await sendCommands([commandFor(id,{color:'#ff0000',brightness:100,transition:0})]);setTimeout(()=>sendCommands([commandFor(id,{color:manual.lightColors[id],transition:100})]).catch(()=>{}),650);setMessage('선택한 전구가 빨간색으로 표시됩니다.','success');}
    else await sendCommands([commandFor(id,{on:action==='on',color:action==='on'?manual.lightColors[id]:null})],action==='on'?'전구를 켰습니다.':'전구를 껐습니다.');
  } catch(error){setMessage(error.message,'error');} finally{button.disabled=false;}
}

function openRenameLight(lightId) {
  const light=lights.find(item=>item.id===lightId);if(!light)return;
  renamingLightId=lightId;$('#renameLightTitle').textContent=`${light.name} 이름 변경`;$('#renameLightName').value=light.name;$('#renameLightModal').hidden=false;syncModalLock();
  requestAnimationFrame(()=>{$('#renameLightName').focus();$('#renameLightName').select();});
}
function closeRenameLight(){renamingLightId=null;$('#renameLightModal').hidden=true;syncModalLock();}
$('#renameLightClose').addEventListener('click',closeRenameLight);$('#renameLightCancel').addEventListener('click',closeRenameLight);
$('#renameLightModal').addEventListener('click',event=>{if(event.target===$('#renameLightModal'))closeRenameLight();});
$('#renameLightForm').addEventListener('submit',async event=>{
  event.preventDefault();if(!renamingLightId)return;const name=$('#renameLightName').value.trim(),button=$('#renameLightSave');
  if(!name){setMessage('전구 이름을 입력하세요.','error');return;}button.disabled=true;
  try{const result=await api(`/api/lights/${encodeURIComponent(renamingLightId)}/name`,{method:'PUT',body:JSON.stringify({name})});closeRenameLight();await loadLights(true);setMessage(result.message,'success');}
  catch(error){setMessage(error.message,'error');}finally{button.disabled=false;}
});

async function loadStatus() {
  const status=await api('/api/status');if(status.bridgeIp)$('#bridgeIp').value=status.bridgeIp;
  const online=status.bridgeOnline??status.paired,badge=$('#connectionBadge');badge.textContent=online?`Bridge 연결됨 · ${status.bridgeIp}`:status.paired?`Bridge 응답 없음 · ${status.bridgeIp}`:'Bridge 미연결';badge.className=`badge ${online?'online':'offline'}`;
}
async function loadLights(quiet=false) {
  const button=$('#loadLightsButton');button.disabled=true;
  try{lights=await api('/api/lights');renderLights();renderAllGroups();if(!quiet){const connected=lights.filter(light=>light.connectivity==='connected').length;setMessage(`${lights.length}개 조명 중 ${connected}개가 현재 연결되어 있습니다.`,connected?'success':'');}}
  catch(error){setMessage(error.message,'error');}finally{button.disabled=false;}
}
$('#pairButton').addEventListener('click',async()=>{const button=$('#pairButton');button.disabled=true;setMessage('Bridge 인증을 요청하고 있습니다…');try{const result=await api('/api/pair',{method:'POST',body:JSON.stringify({bridgeIp:$('#bridgeIp').value})});setMessage(result.message,'success');await loadStatus();await loadLights();}catch(error){setMessage(`${error.message} Bridge 중앙 버튼을 누른 뒤 30초 안에 다시 시도하세요.`,'error');}finally{button.disabled=false;}});
$('#loadLightsButton').addEventListener('click',()=>{loadStatus();loadLights(false);});

$('#masterOnButton').addEventListener('click',async()=>{try{await sendCommands(connectedLightIds().map(id=>commandFor(id,{color:manual.lightColors[id]||manual.masterColor})),'전체 전구를 켰습니다.');}catch(e){setMessage(e.message,'error');}});
$('#masterOffButton').addEventListener('click',async()=>{try{await sendCommands(connectedLightIds().map(id=>commandFor(id,{on:false,color:null})),'전체 전구를 껐습니다.');}catch(e){setMessage(e.message,'error');}});
$('#masterColorButton').addEventListener('click',()=>openColorModal('전체 RGB 색상',manual.masterColor,async hex=>{manual.masterColor=hex;connectedLightIds().forEach(id=>manual.lightColors[id]=hex);saveManual();updateMasterControls();renderLights();await sendCommands(connectedLightIds().map(id=>commandFor(id,{color:hex})),'전체 RGB 색상을 적용했습니다.');}));
function updateMasterControls(){manual.masterBrightness=Number(manual.masterBrightness)||100;$('#masterBrightness').value=manual.masterBrightness;$('#masterBrightnessValue').textContent=`${manual.masterBrightness}%`;$('#masterColorHex').textContent=manual.masterColor.toUpperCase();$('#masterColorSwatch').style.background=manual.masterColor;}
async function applyMasterBrightness(){try{await sendCommands(connectedLightIds().map(id=>commandFor(id,{color:manual.lightColors[id]})),'전체 밝기를 적용했습니다.');}catch(e){setMessage(e.message,'error');}}
$('#masterBrightness').addEventListener('input',event=>{manual.masterBrightness=Number(event.target.value);saveManual();$('#masterBrightnessValue').textContent=`${event.target.value}%`;clearTimeout(masterTimer);masterTimer=setTimeout(applyMasterBrightness,140);});
$('#masterBrightness').addEventListener('change',applyMasterBrightness);

function openGroupSettings(mode,groupId) {
  const group=groupState[mode].find(item=>item.id===groupId);if(!group)return;
  editingGroup={mode,groupId};groupDraft={name:group.name,color:group.color,brightness:group.brightness};
  $('#groupSettingsMode').textContent=mode==='normal'?'GENERAL GROUP SETTINGS':'MUSIC GROUP SETTINGS';
  $('#groupSettingsTitle').textContent=group.name;$('#groupNameInput').value=group.name;$('#groupBrightnessInput').value=group.brightness;
  $('#groupSettingsLights').innerHTML=`<strong>포함 전구 ${group.lightIds.length}개</strong><div>${group.lightIds.map(id=>lights.find(light=>light.id===id)).filter(Boolean).map(light=>lightChip(light)).join('')||'<small>포함된 전구가 없습니다.</small>'}</div>`;
  $('#groupSettingsApply').textContent=mode==='normal'?'저장 및 전구 적용':'저장 및 그룹 테스트';syncGroupDraft();$('#groupSettingsModal').hidden=false;syncModalLock();
}
function syncGroupDraft(){if(!groupDraft)return;$('#groupSettingsTitle').textContent=$('#groupNameInput').value||'그룹 설정';$('#groupColorSwatch').style.background=groupDraft.color;$('#groupColorHex').textContent=groupDraft.color.toUpperCase();$('#groupBrightnessValue').textContent=`${Math.round(groupDraft.brightness)}%`;}
function closeGroupSettings(){editingGroup=null;groupDraft=null;$('#groupSettingsModal').hidden=true;syncModalLock();}
function saveGroupSettings(close=true){if(!editingGroup||!groupDraft)return null;const group=groupState[editingGroup.mode].find(item=>item.id===editingGroup.groupId);if(!group)return null;group.name=($('#groupNameInput').value.trim()||group.name).slice(0,24);group.color=groupDraft.color;group.brightness=Number(groupDraft.brightness);saveGroups();renderGroupManager(editingGroup.mode);renderLights();if(close)closeGroupSettings();return group;}
$('#groupNameInput').addEventListener('input',syncGroupDraft);
$('#groupBrightnessInput').addEventListener('input',event=>{if(groupDraft){groupDraft.brightness=Number(event.target.value);syncGroupDraft();}});
$('#groupColorButton').addEventListener('click',()=>{if(groupDraft)openColorModal('그룹 RGB 색상',groupDraft.color,hex=>{groupDraft.color=hex;syncGroupDraft();});});
$('#groupSettingsClose').addEventListener('click',closeGroupSettings);$('#groupSettingsCancel').addEventListener('click',closeGroupSettings);
$('#groupSettingsSave').addEventListener('click',()=>{const name=$('#groupNameInput').value.trim();saveGroupSettings(true);setMessage(`${name||'그룹'} 설정을 저장했습니다.`,'success');});
$('#groupSettingsApply').addEventListener('click',async()=>{const context=editingGroup&&{...editingGroup};const group=saveGroupSettings(false);if(!context||!group)return;try{await applyGroup(context.mode,context.groupId,context.mode==='music'?'preview':'apply');closeGroupSettings();}catch(error){setMessage(error.message,'error');}});
$('#groupSettingsModal').addEventListener('click',event=>{if(event.target===$('#groupSettingsModal'))closeGroupSettings();});

function activeMusicGroups(){const controllable=new Set(connectedLightIds());return groupState.music.map(group=>({...group,lightIds:group.lightIds.filter(id=>controllable.has(id))})).filter(group=>group.lightIds.length);}
function entertainmentMusicGroups(){const controllable=new Set(connectedLightIds());return groupState.music.slice(0,2).map(group=>({...group,lightIds:group.lightIds.filter(id=>controllable.has(id))}));}
function entertainmentPairCount(){const connectedSizes=entertainmentMusicGroups().map(group=>group.lightIds.length),configuredSizes=groupState.music.slice(0,2).map(group=>group.lightIds.length),sizes=connectedSizes.every(Boolean)?connectedSizes:configuredSizes.every(Boolean)?configuredSizes:[];return Math.max(1,Math.min(5,sizes.length?Math.min(...sizes):5));}
function validateEntertainmentGroups(){const groups=entertainmentMusicGroups(),ids=groups.flatMap(group=>group.lightIds),counts=groups.map(group=>group.lightIds.length);if(groups.length<2||counts.some(count=>count<1))throw new Error('음악 그룹 A와 B에 연결된 전구가 각각 1개 이상 필요합니다.');if(counts[0]!==counts[1])throw new Error(`좌우 쌍 연출을 위해 A/B 전구 수를 같게 맞춰 주세요. 현재 ${counts[0]}개 / ${counts[1]}개입니다.`);if(ids.length>10)throw new Error('한 Entertainment 영역에서는 총 10개까지만 사용할 수 있습니다.');if(new Set(ids).size!==ids.length)throw new Error('A/B 그룹에 중복된 전구가 있습니다.');return groups;}
function currentEntertainmentLightIds(){return entertainmentMusicGroups().flatMap(group=>group.lightIds);}
function sameLightSet(left,right){return left.length===right.length&&left.every(id=>right.includes(id));}
function updateEntertainmentAreaManager(){
  const select=$('#entertainmentAreaTarget'),status=$('#entertainmentAreaMembership'),button=$('#syncEntertainmentAreaButton'),name=$('#entertainmentAreaName');if(!select||!status||!button)return;
  const configuration=entertainmentConfigurations.find(item=>item.id===select.value),groupIds=currentEntertainmentLightIds(),areaIds=configuration?.lightIds||[];
  button.textContent=configuration?'선택 영역 갱신':'새 영역 등록';
  if(configuration&&document.activeElement!==name)name.value=configuration.name;
  if(!configuration){status.className='area-membership-state';status.textContent=`현재 A/B ${groupIds.length}개 · 새 Entertainment 영역으로 등록할 수 있습니다.`;return;}
  const matches=sameLightSet(groupIds,areaIds),missing=groupIds.filter(id=>!areaIds.includes(id)).length,extra=areaIds.filter(id=>!groupIds.includes(id)).length;
  status.className=`area-membership-state ${matches?'match':'mismatch'}`;
  status.textContent=matches?`구성 일치 · A/B 전구 ${groupIds.length}개가 이 영역에 등록되어 있습니다.`:`구성 불일치 · 영역에 추가 ${missing}개 / 영역에서 제외 ${extra}개`;
}
function syncEntertainmentSelectors(configurationId){
  const playback=$('#entertainmentConfiguration'),manager=$('#entertainmentAreaTarget');
  if(configurationId&&entertainmentConfigurations.some(item=>item.id===configurationId)){playback.value=configurationId;manager.value=configurationId;entertainmentSelectedId=configurationId;}
  updateEntertainmentAreaManager();queueControllerSettingsSave();
}
async function syncEntertainmentArea(){
  const groups=validateEntertainmentGroups(),lightIds=groups.flatMap(group=>group.lightIds),target=$('#entertainmentAreaTarget').value,name=$('#entertainmentAreaName').value.trim(),button=$('#syncEntertainmentAreaButton');
  if(!name)throw new Error('Entertainment 영역 이름을 입력하세요.');
  button.disabled=true;
  try{
    const result=await api('/api/entertainment/configurations/sync',{method:'POST',body:JSON.stringify({configurationId:target||null,name,lightIds})});
    let match=null;
    for(let attempt=0;attempt<4&&!match;attempt++){
      if(attempt)await new Promise(resolve=>setTimeout(resolve,250));
      await loadEntertainmentConfigurations();
      match=entertainmentConfigurations.find(item=>item.id===result.configurationId)||entertainmentConfigurations.find(item=>item.name===name&&sameLightSet(item.lightIds||[],lightIds));
    }
    if(match)syncEntertainmentSelectors(match.id);
    return result;
  }finally{button.disabled=false;}
}
function updateEntertainmentMapping(){const groups=entertainmentMusicGroups(),names=groups.map(group=>`${group.name} ${group.lightIds.length}개`).join(' · ');$('#entertainmentMapping').textContent=names?`${names} · 같은 순번끼리 한 쌍으로 움직입니다.`:'A/B 그룹에 같은 수의 전구를 넣으면 배열 크기에 맞춰 순환합니다.';updateEntertainmentAreaManager();}
async function loadEntertainmentConfigurations(){
  const playback=$('#entertainmentConfiguration'),manager=$('#entertainmentAreaTarget'),previousManager=manager?.value||'';playback.innerHTML='<option value="">불러오는 중…</option>';if(manager)manager.innerHTML='<option value="">불러오는 중…</option>';const configurations=await api('/api/entertainment/configurations');entertainmentConfigurations=Array.isArray(configurations)?configurations:[];const options=entertainmentConfigurations.map(item=>`<option value="${item.id}">${escapeHtml(item.name)} · ${item.channelCount}채널</option>`).join('');playback.innerHTML=options||'<option value="">등록된 영역 없음</option>';if(manager)manager.innerHTML=`<option value="">+ 새 Entertainment 영역</option>${options}`;if(entertainmentSelectedId&&entertainmentConfigurations.some(item=>item.id===entertainmentSelectedId))playback.value=entertainmentSelectedId;else entertainmentSelectedId=playback.value||'';if(manager){const managerId=previousManager||entertainmentSelectedId;if(entertainmentConfigurations.some(item=>item.id===managerId))manager.value=managerId;}updateEntertainmentAreaManager();queueControllerSettingsSave();return entertainmentConfigurations;
}
async function startEntertainment(){
  validateEntertainmentGroups();if(!entertainmentConfigurations.length)await loadEntertainmentConfigurations();const configurationId=$('#entertainmentConfiguration').value||entertainmentSelectedId;if(!configurationId)throw new Error('연결할 Entertainment 영역을 선택하세요.');const result=await api('/api/entertainment/start',{method:'POST',body:JSON.stringify({configurationId})});entertainmentSelectedId=configurationId;entertainmentActive=true;entertainmentLastFrameAt=0;entertainmentAccentBucket=-1;entertainmentFlashUntil=0;$('#startEntertainmentButton').disabled=true;$('#stopEntertainmentButton').disabled=false;$('#entertainmentStatus').className='analysis-state ready';$('#entertainmentStatus').textContent=`연결됨 · ${result.channelCount||10}채널`;queueControllerSettingsSave();return result;
}
async function stopEntertainment(silent=false){
  try{await api('/api/entertainment/stop',{method:'POST'});}catch(error){if(!silent)throw error;}finally{entertainmentActive=false;entertainmentFrameBusy=false;$('#startEntertainmentButton').disabled=false;$('#stopEntertainmentButton').disabled=true;$('#entertainmentStatus').className='analysis-state';$('#entertainmentStatus').textContent='연결 안 됨';}
}
function buildEntertainmentCommands(targetPhase=phase,intensity=1,turnOff=false,transitionOverride=null,punch=false){
  const groups=validateEntertainmentGroups(),master=Number($('#beatBrightness').value)/100,safeIntensity=Math.max(0,Math.min(1,Number(intensity)||0)),transition=transitionOverride===null?Math.max(40,Math.min(240,Number($('#transition').value)||100)):Math.max(0,Math.min(1000,Number(transitionOverride)||0));return groups.map((group,index)=>({lightIds:group.lightIds,hexColor:turnOff?null:placementColors[(targetPhase+index*4)%placementColors.length],brightness:turnOff?0:Math.max(.1,master*(punch?100*safeIntensity:group.brightness*(.2+safeIntensity*.8))),transitionMs:turnOff?0:transition,on:!turnOff,groupKey:`entertainment-${index}`}));
}
async function sendEntertainmentFrame(intensity=1,force=false,turnOff=false,transitionOverride=null,punch=false,artFrame=null){
  const now=performance.now();if(!entertainmentActive||entertainmentFrameBusy||(!force&&now-entertainmentLastFrameAt<ENTERTAINMENT_FRAME_INTERVAL_MS))return false;const previousFrameAt=entertainmentLastFrameAt;entertainmentFrameBusy=true;try{const result=await api('/api/entertainment/frame',{method:'POST',body:JSON.stringify({commands:artFrame?buildMediaArtCommands(artFrame):buildEntertainmentCommands(phase,intensity,turnOff,transitionOverride,punch),scheduleAheadMs:artFrame?ENTERTAINMENT_SCHEDULE_AHEAD_MS:0})});if(result.ignoredLightIds?.length)throw new Error(`${result.ignoredLightIds.length}개 전구가 선택한 Entertainment 영역에 없습니다.`);entertainmentLastFrameAt=performance.now();if(previousFrameAt)$('#commandInterval').textContent=`${Math.round(entertainmentLastFrameAt-previousFrameAt)}ms`;return true;}finally{entertainmentFrameBusy=false;}
}
function buildMediaArtCommands(frame){
  const groups=validateEntertainmentGroups(),master=Number($('#beatBrightness').value)/100;
  const limit=100*master,punch=Number($('#entertainmentPunch').value)/100;
  return groups.flatMap(group=>group.lightIds.map((id,index)=>({
    lightIds:[id],hexColor:mediaArtPalette[(frame.color+(frame.colorOffsets?.[index]||0))%mediaArtPalette.length],on:frame.weights[index]>.001,
    brightness:frame.weights[index]*(frame.bloom?100*master*punch:limit),
    transitionMs:frame.blackout||frame.bloom||frame.punchHold?0:70
  })));
}
function ensureVirtualLights(slotCount=entertainmentPairCount()){
  const stage=$('#virtualLightStage'),safeCount=Math.max(1,Math.min(5,Number(slotCount)||5));if(!stage||Number(stage.dataset.slotCount)===safeCount)return;
  stage.dataset.slotCount=String(safeCount);stage.style.setProperty('--slot-count',safeCount);stage.innerHTML=['A','B'].map(row=>`<div class="virtual-light-row"><span class="virtual-row-name">${row}</span>${Array.from({length:safeCount},(_,index)=>`<div class="virtual-bulb-wrap"><i class="virtual-bulb" data-virtual-slot="${index}" data-virtual-row="${row}"></i><small>${row}${index+1}</small></div>`).join('')}</div>`).join('');
}
function renderVirtualLights(frame,time=0){
  if(!frame)return;ensureVirtualLights(frame.weights?.length||entertainmentPairCount());const master=Number($('#beatBrightness').value)/100,punch=Number($('#entertainmentPunch').value)/100,state=$('#simulatorState');
  document.querySelectorAll('[data-virtual-slot]').forEach(bulb=>{const index=Number(bulb.dataset.virtualSlot),color=mediaArtPalette[(frame.color+(frame.colorOffsets?.[index]||0))%mediaArtPalette.length],rgb=hexToRgb(color),level=Math.max(0,Math.min(1,(frame.weights?.[index]||0)*master*(frame.bloom?punch:1)));bulb.style.setProperty('--bulb-color',color);bulb.style.setProperty('--bulb-rgb',`${rgb.r},${rgb.g},${rgb.b}`);bulb.style.setProperty('--bulb-shine',(.08+level*.55).toFixed(3));bulb.style.setProperty('--bulb-alpha',(.16+level*.84).toFixed(3));bulb.style.setProperty('--bulb-soft',(.05+level*.48).toFixed(3));bulb.style.setProperty('--bulb-glow',`${5+level*34}px`);bulb.style.setProperty('--bulb-glow-alpha',(level*.82).toFixed(3));bulb.style.setProperty('--bulb-inset',`${5+level*15}px`);bulb.style.setProperty('--bulb-inset-alpha',(level*.32).toFixed(3));bulb.style.setProperty('--bulb-scale',(.93+level*.07).toFixed(3));bulb.classList.toggle('hit',Boolean(frame.hit||frame.bloom));bulb.parentElement.querySelector('small').textContent=`${bulb.dataset.virtualRow}${index+1} · ${Math.round(level*100)}%`;});
  const mode=HueShowScore.TYPE_LABELS[frame.mode]||frame.mode||'대기',event=frame.bloom?' · FULL':frame.hit?' · KICK':frame.snareHit?' · SNARE':frame.hatHit?' · HIGH':'';state.textContent=`${mode}${event}`;state.classList.toggle('climax',frame.mode==='climax');$('#simulatorTime').textContent=`${Math.max(0,time).toFixed(2)}s`;$('#simulatorLow').textContent=`${Math.round((frame.low||0)*100)}%`;$('#simulatorMid').textContent=`${Math.round((frame.mid||0)*100)}%`;$('#simulatorHigh').textContent=`${Math.round((frame.high||0)*100)}%`;
}
function buildBeatCommandsForPhase(targetPhase,turnOff=false) {
  const groups=activeMusicGroups();if(!groups.length)return[];const master=Number($('#beatBrightness').value)/100;
  return groups.map((group,index)=>{
    // Spread groups evenly around the palette. With two groups this produces
    // opposite colors (red/blue, orange/indigo...) instead of adjacent colors.
    const groupOffset=Math.round(index*placementColors.length/groups.length);
    return {lightIds:group.lightIds,hexColor:turnOff?null:placementColors[(groupOffset+targetPhase)%placementColors.length],brightness:turnOff?0:Math.max(.1,group.brightness*master),transitionMs:Number($('#transition').value),on:!turnOff,groupKey:group.id};
  });
}
function buildBeatCommands(turnOff=false){return buildBeatCommandsForPhase(phase,turnOff);}
function buildBrightnessBeatCommands(targetPhase=phase,intensity=1,turnOff=false){
  const safeIntensity=Math.max(0,Math.min(1,Number(intensity)||0)),factor=.15+Math.pow(safeIntensity,.85)*.85;
  return buildBeatCommandsForPhase(targetPhase,turnOff).map(command=>({...command,brightness:turnOff?0:Math.max(.1,command.brightness*factor)}));
}
async function prepareMusicScenes(){
  const frames=placementColors.map((_,scenePhase)=>({commands:buildBeatCommandsForPhase(scenePhase,false)}));
  if(frames.some(frame=>!frame.commands.length))throw new Error('연결된 전구가 들어 있는 음악 그룹이 없습니다.');
  setMessage('A/B 공통 색상 Scene 8개를 Bridge에 준비하고 있습니다.');
  const result=await api('/api/control/music-scenes/prepare',{method:'POST',body:JSON.stringify({frames})});musicScenesReady=true;return result;
}
function selectedEqualizerGroup(){const value=$('#equalizerGroup')?.value||'',separator=value.indexOf(':');if(separator<0)return null;const mode=value.slice(0,separator),id=value.slice(separator+1);return groupState[mode]?.find(group=>group.id===id)||null;}
function buildEqualizerCommands(level,turnOff=false){
  const group=selectedEqualizerGroup();if(!group)return[];const controllable=new Set(connectedLightIds()),orderedIds=group.lightIds.filter(id=>controllable.has(id)),litCount=turnOff?0:Math.max(0,Math.min(orderedIds.length,Math.round(level))),master=Number($('#beatBrightness').value)/100,previous=equalizerLastLevel<0?null:Math.min(orderedIds.length,equalizerLastLevel),commands=[];
  let onIds=[],offIds=[];
  if(turnOff){offIds=orderedIds;}
  else if(previous===null){onIds=orderedIds.slice(0,litCount);offIds=orderedIds.slice(litCount);}
  else{if(equalizerColorDirty)onIds=orderedIds.slice(0,litCount);else if(litCount>previous)onIds=orderedIds.slice(previous,litCount);if(litCount<previous)offIds=orderedIds.slice(litCount,previous);}
  if(onIds.length)commands.push({lightIds:onIds,hexColor:placementColors[phase%placementColors.length],brightness:Math.max(.1,group.brightness*master),transitionMs:Number($('#transition').value),on:true});
  if(offIds.length)commands.push({lightIds:offIds,hexColor:null,brightness:0,transitionMs:Number($('#transition').value),on:false});
  return commands;
}
async function applyEqualizerLevel(level,force=false){
  const group=selectedEqualizerGroup();if(!group){if(force)setMessage('전구가 포함된 이퀄라이저 대상 그룹을 선택하세요.','error');return false;}
  const connectedCount=group.lightIds.filter(id=>connectedLightIds().includes(id)).length,safeLevel=Math.max(0,Math.min(connectedCount,Math.round(level)));if(!force&&safeLevel===equalizerLastLevel&&!equalizerColorDirty)return false;if(commandBusy)return false;
  const commands=buildEqualizerCommands(safeLevel);if(!commands.length){equalizerLastLevel=safeLevel;equalizerColorDirty=false;$('#equalizerLevel').textContent=`${safeLevel}/${connectedCount}`;return false;}
  commandBusy=true;try{await sendCommands(commands);equalizerLastLevel=safeLevel;equalizerColorDirty=false;$('#equalizerLevel').textContent=`${safeLevel}/${connectedCount}`;return true;}catch(error){setMessage(error.message,'error');return false;}finally{commandBusy=false;}
}
async function triggerBeat(manualTrigger=false,cueStrength=1) {
  if(commandBusy||!lights.length)return;const commandAt=performance.now();if(!manualTrigger&&lastMusicCommandAt&&commandAt-lastMusicCommandAt<MUSIC_COMMAND_INTERVAL_MS-60)return;if(lastMusicCommandAt)$('#commandInterval').textContent=`${Math.round(commandAt-lastMusicCommandAt)}ms`;lastMusicCommandAt=commandAt;commandBusy=true;document.body.classList.add('beat');setTimeout(()=>document.body.classList.remove('beat'),110);
  try{const commands=buildBeatCommands(false);if(!commands.length){setMessage('연결된 전구가 들어 있는 음악 그룹이 없습니다.','error');return;}if(!musicScenesReady)await prepareMusicScenes();const sceneIndex=phase;await api('/api/control/music-scenes/recall',{method:'POST',body:JSON.stringify({sceneIndex,transitionMs:Number($('#transition').value)})});const appliedColors=commands.map(command=>command.hexColor?.toUpperCase()).join(' / '),totalLights=commands.reduce((sum,command)=>sum+command.lightIds.length,0),step=cueStrength>=.68?3:cueStrength>=.4?2:1;phase=(phase+step)%placementColors.length;if(manualTrigger)setMessage(`공통 Scene ${sceneIndex+1} 실행 · ${totalLights}개 전구 · ${appliedColors}`,'success');else{beatCount++;$('#beatCount').textContent=beatCount;}}
  catch(error){setMessage(error.message,'error');}finally{commandBusy=false;}
}
async function triggerBrightnessBeat(intensity=.7,cueStrength=1,manualTrigger=false){
  if(commandBusy||!lights.length)return false;const commandAt=performance.now();if(!manualTrigger&&lastMusicCommandAt&&commandAt-lastMusicCommandAt<MUSIC_COMMAND_INTERVAL_MS-60)return false;if(lastMusicCommandAt)$('#commandInterval').textContent=`${Math.round(commandAt-lastMusicCommandAt)}ms`;lastMusicCommandAt=commandAt;commandBusy=true;document.body.classList.add('beat');setTimeout(()=>document.body.classList.remove('beat'),110);
  try{const commands=buildBrightnessBeatCommands(phase,intensity,false);if(!commands.length){setMessage('연결된 전구가 들어 있는 음악 그룹이 없습니다.','error');return false;}const sceneIndex=phase,step=cueStrength>=.68?3:cueStrength>=.4?2:1;await api('/api/control/grouped-music',{method:'POST',body:JSON.stringify({commands})});phase=(phase+step)%placementColors.length;beatCount++;$('#beatCount').textContent=beatCount;if(manualTrigger){const levels=commands.map(command=>`${Math.round(command.brightness)}%`).join(' / ');setMessage(`일반+밝기 ${sceneIndex+1} 실행 · 그룹 밝기 ${levels}`,'success');}return true;}
  catch(error){setMessage(error.message,'error');return false;}finally{commandBusy=false;}
}
async function playTestClick(beatInBar=0){await ensureAudio();const now=audioContext.currentTime,kick=audioContext.createOscillator(),gain=audioContext.createGain();kick.type='sine';kick.frequency.setValueAtTime(beatInBar===0?145:110,now);kick.frequency.exponentialRampToValueAtTime(48,now+.11);gain.gain.setValueAtTime(beatInBar===0?.2:.13,now);gain.gain.exponentialRampToValueAtTime(.001,now+.14);kick.connect(gain);gain.connect(audioContext.destination);kick.start(now);kick.stop(now+.15);}
let mediaArtDemo=null,mediaArtDemoStarted=0;
async function runShowTestStep(){
  if(musicStyle==='entertainment'){
    if(!mediaArtDemo){
      const envelope=Array.from({length:400},(_,i)=>{const base=i<70?.04:i<160?.2:i<250?.48:i<340?.8:.15;return Math.min(1,base+(i%5===0?.1:0));});
      const bassEnvelope=envelope.map((value,index)=>Math.min(1,value*1.08+(index%5===0?.16:0))),midEnvelope=envelope.map((value,index)=>Math.min(1,value*.88+(index%10>=5?.1:0))),highEnvelope=envelope.map((value,index)=>Math.min(1,value*.7+(index>=250&&index%3===0?.2:0))),spectralFluxEnvelope=deriveSpectralFluxEnvelope({bassEnvelope,midEnvelope,highEnvelope});
      mediaArtDemo=HueMediaArt.compile({duration:40,envelope,bassEnvelope,midEnvelope,highEnvelope,onsetEnvelope:spectralFluxEnvelope,bassOnsetEnvelope:spectralFluxEnvelope,spectralFluxEnvelope,envelopeStep:.1,beatInterval:.5,beatGridStart:0,beatTimes:Array.from({length:70},(_,i)=>i*.5+3),cueStrengths:Array(70).fill(.82),slotCount:entertainmentPairCount()});
    }
    const time=((performance.now()-mediaArtDemoStarted)/1000)%40,frame=HueMediaArt.sample(mediaArtDemo,time);
    renderVirtualLights(frame,time);if(!showTestPreviewOnly)await sendEntertainmentFrame(0,false,false,null,false,frame);
    $('#mediaArtState').textContent=`${showTestPreviewOnly?'웹 모의':'실제 전구'} 40초 예시 · ${HueShowScore.TYPE_LABELS[frame.mode]||frame.mode} · ${HueShowScore.PRESET_LABELS[frame.preset]||frame.preset}`;
    return;
  }
  playTestClick(showTestStep%4).catch(()=>{});
  if(musicStyle==='beat')await triggerBeat(false);else if(musicStyle==='beat-brightness')await triggerBrightnessBeat([.25,.55,1,.45][showTestStep%4],showTestStep%4===0?1:.5,true);else if(musicStyle==='entertainment'){phase=(phase+(showTestStep%4===0?2:1))%placementColors.length;beatCount++;$('#beatCount').textContent=beatCount;const punch=Number($('#entertainmentPunch').value)/100;await sendEntertainmentFrame(punch,true,false,0,true);clearTimeout(showTestFadeTimer);showTestFadeTimer=setTimeout(()=>sendEntertainmentFrame(.28,true,false,80).catch(error=>setMessage(error.message,'error')),150);}else{const group=selectedEqualizerGroup(),max=group?.lightIds.length||0;if(!max)return;const cycle=max===1?1:max*2-2,position=showTestStep%cycle,level=position<max?position+1:max*2-1-position;phase=(phase+1)%placementColors.length;equalizerColorDirty=true;beatCount++;$('#beatCount').textContent=beatCount;await applyEqualizerLevel(level,true);}
  showTestStep++;
}
function stopShowTest(silent=false){clearTimeout(showTestFadeTimer);showTestFadeTimer=null;if(!showTestTimer)return;clearInterval(showTestTimer);showTestTimer=null;$('#startShowTestButton').disabled=false;$('#stopShowTestButton').disabled=true;if(!silent)setMessage('연출 테스트를 정지했습니다.');}
async function startShowTest(){
  stopCalibration(true);
  if(musicStyle==='beat'&&!buildBeatCommands().length){setMessage('연결된 전구가 들어 있는 음악 그룹이 없습니다.','error');return;}
  if(musicStyle==='beat-brightness'&&!buildBrightnessBeatCommands().length){setMessage('연결된 전구가 들어 있는 음악 그룹이 없습니다.','error');return;}
  if(musicStyle==='equalizer'&&!buildEqualizerCommands(1).length){setMessage('연결된 전구가 들어 있는 이퀄라이저 대상 그룹을 선택하세요.','error');return;}
  if(musicStyle==='beat'){try{await prepareMusicScenes();}catch(error){setMessage(`공통 Scene 준비 실패: ${error.message}`,'error');return;}}
  if(musicStyle==='beat-brightness'){try{await prepareAnalyzedMusicGroups();}catch(error){setMessage(`음악 그룹 준비 실패: ${error.message}`,'error');return;}}
  showTestPreviewOnly=$('#simulatorPreviewOnly').checked;if(musicStyle==='entertainment'&&!showTestPreviewOnly){try{validateEntertainmentGroups();if(!entertainmentActive)await startEntertainment();}catch(error){setMessage(`Entertainment 준비 실패: ${error.message}`,'error');return;}}
  stopShowTest(true);resetAnalysis();$('#audioPlayer').pause();phase=0;showTestStep=0;mediaArtDemo=null;mediaArtDemoStarted=performance.now();$('#startShowTestButton').disabled=true;$('#stopShowTestButton').disabled=false;
  const interval=ENTERTAINMENT_FRAME_INTERVAL_MS;setMessage(showTestPreviewOnly?'웹 모의 전구 40초 반복 테스트 시작 · 실제 Hue에는 전송하지 않습니다.':'Entertainment 실제 전구 40초 반복 테스트 시작','success');await runShowTestStep();showTestTimer=setInterval(runShowTestStep,interval);
}
function setMusicStyle(style){
  stopShowTest(true);musicStyle='entertainment';localStorage.setItem('hue-music-style',musicStyle);queueControllerSettingsSave();equalizerLastLevel=-1;$('#equalizerLevel').textContent='0';
  document.querySelectorAll('[data-music-style]').forEach(button=>{const active=button.dataset.musicStyle==='entertainment';button.classList.toggle('active',active);button.setAttribute('aria-selected',String(active));});
  $('#equalizerGroupField').hidden=true;$('#entertainmentControls').hidden=false;$('#musicStyleDescription').textContent='전체 전구가 하나의 장면을 유지하면서 저음은 밝기 펀치, 중음은 색 흐름, 고음은 공간 대비를 만들고 에너지가 상승하면 전체 클라이맥스로 확장합니다.';updateEntertainmentMapping();if(!entertainmentConfigurations.length)loadEntertainmentConfigurations().catch(error=>setMessage(error.message,'error'));
}
document.querySelectorAll('[data-music-style]').forEach(button=>button.addEventListener('click',()=>setMusicStyle(button.dataset.musicStyle)));
$('#equalizerGroup').addEventListener('change',()=>{equalizerLastLevel=-1;$('#equalizerLevel').textContent='0';queueControllerSettingsSave();});
$('#refreshEntertainmentButton').addEventListener('click',()=>loadEntertainmentConfigurations().then(()=>setMessage('Entertainment 영역을 새로 불러왔습니다.','success')).catch(error=>setMessage(error.message,'error')));
$('#entertainmentConfiguration').addEventListener('change',event=>{entertainmentSelectedId=event.target.value;if(event.target.value&&$('#entertainmentAreaTarget'))$('#entertainmentAreaTarget').value=event.target.value;updateEntertainmentAreaManager();queueControllerSettingsSave();});
$('#entertainmentAreaTarget').addEventListener('change',event=>{const configuration=entertainmentConfigurations.find(item=>item.id===event.target.value);$('#entertainmentAreaName').value=configuration?.name||'HueBeat 현장';updateEntertainmentAreaManager();});
$('#syncEntertainmentAreaButton').addEventListener('click',()=>syncEntertainmentArea().then(result=>setMessage(result.message,'success')).catch(error=>setMessage(error.message,'error')));
$('#startEntertainmentButton').addEventListener('click',()=>startEntertainment().then(result=>setMessage(result.message,'success')).catch(error=>setMessage(error.message,'error')));
$('#stopEntertainmentButton').addEventListener('click',()=>stopEntertainment(false).then(()=>setMessage('Entertainment 스트리밍을 종료했습니다.')).catch(error=>setMessage(error.message,'error')));
$('#startShowTestButton').addEventListener('click',startShowTest);$('#stopShowTestButton').addEventListener('click',()=>stopShowTest(false));
$('#musicAllOffButton').addEventListener('click',async()=>{try{if(musicStyle==='entertainment'&&entertainmentActive)await sendEntertainmentFrame(0,true,true);else{const ids=[...new Set([...activeMusicGroups().flatMap(group=>group.lightIds),...(selectedEqualizerGroup()?.lightIds||[])])].filter(id=>connectedLightIds().includes(id));if(!ids.length)throw new Error('연결된 연출 전구가 없습니다.');await sendCommands([{lightIds:ids,hexColor:null,brightness:0,transitionMs:Number($('#transition').value),on:false}]);}equalizerLastLevel=0;equalizerColorDirty=false;$('#equalizerLevel').textContent='0';setMessage('연출 전구를 모두 껐습니다.','success');}catch(error){setMessage(error.message,'error');}});

function clampByte(value){return Math.max(0,Math.min(255,Math.round(Number(value)||0)));}
function rgbToHex({r,g,b}){return '#'+[r,g,b].map(value=>clampByte(value).toString(16).padStart(2,'0')).join('');}
function hsvToRgb({h,s,v}){const c=v*s,x=c*(1-Math.abs((h/60)%2-1)),m=v-c;let p;if(h<60)p=[c,x,0];else if(h<120)p=[x,c,0];else if(h<180)p=[0,c,x];else if(h<240)p=[0,x,c];else if(h<300)p=[x,0,c];else p=[c,0,x];return{r:(p[0]+m)*255,g:(p[1]+m)*255,b:(p[2]+m)*255};}
function rgbToHsv({r,g,b}){r/=255;g/=255;b/=255;const max=Math.max(r,g,b),min=Math.min(r,g,b),d=max-min;let h=0;if(d){if(max===r)h=60*(((g-b)/d)%6);else if(max===g)h=60*((b-r)/d+2);else h=60*((r-g)/d+4);}if(h<0)h+=360;return{h,s:max?d/max:0,v:max};}
function hexToRgb(hex){const n=parseInt(hex.replace('#',''),16);return{r:(n>>16)&255,g:(n>>8)&255,b:n&255};}
function createWheelImage(){const canvas=$('#colorWheel'),ctx=canvas.getContext('2d'),image=ctx.createImageData(canvas.width,canvas.height),cx=canvas.width/2,cy=canvas.height/2,radius=cx-5;for(let y=0;y<canvas.height;y++)for(let x=0;x<canvas.width;x++){const dx=x-cx,dy=y-cy,s=Math.sqrt(dx*dx+dy*dy)/radius,i=(y*canvas.width+x)*4;if(s<=1){const rgb=hsvToRgb({h:(Math.atan2(dy,dx)*180/Math.PI+360)%360,s,v:1});image.data[i]=rgb.r;image.data[i+1]=rgb.g;image.data[i+2]=rgb.b;image.data[i+3]=255;}}return image;}
function drawWheel(){const canvas=$('#colorWheel'),ctx=canvas.getContext('2d');wheelImage||=createWheelImage();ctx.putImageData(wheelImage,0,0);const radius=canvas.width/2-5,angle=modalHsv.h*Math.PI/180,x=canvas.width/2+Math.cos(angle)*modalHsv.s*radius,y=canvas.height/2+Math.sin(angle)*modalHsv.s*radius;ctx.beginPath();ctx.arc(x,y,7,0,Math.PI*2);ctx.strokeStyle='#fff';ctx.lineWidth=3;ctx.stroke();ctx.beginPath();ctx.arc(x,y,9,0,Math.PI*2);ctx.strokeStyle='#111827';ctx.lineWidth=1;ctx.stroke();}
function syncColorModal(){const rgb=hsvToRgb(modalHsv),hex=rgbToHex(rgb).toUpperCase();$('#rgbR').value=clampByte(rgb.r);$('#rgbG').value=clampByte(rgb.g);$('#rgbB').value=clampByte(rgb.b);$('#colorValue').value=Math.round(modalHsv.v*100);$('#colorValueOutput').textContent=`${Math.round(modalHsv.v*100)}%`;$('#modalColorPreview').style.background=hex;$('#modalHex').textContent=hex;drawWheel();}
function syncModalLock(){document.body.classList.toggle('modal-open',!$('#colorModal').hidden||!$('#groupSettingsModal').hidden||!$('#renameLightModal').hidden);}
function openColorModal(title,hex,onConfirm){$('#colorModalTitle').textContent=title;modalHsv=rgbToHsv(hexToRgb(hex));modalConfirm=onConfirm;syncColorModal();$('#colorModal').hidden=false;syncModalLock();}
function closeColorModal(){modalConfirm=null;$('#colorModal').hidden=true;syncModalLock();}
function pickWheel(event){const canvas=$('#colorWheel'),rect=canvas.getBoundingClientRect(),x=(event.clientX-rect.left)*canvas.width/rect.width-canvas.width/2,y=(event.clientY-rect.top)*canvas.height/rect.height-canvas.height/2,radius=canvas.width/2-5;modalHsv.h=(Math.atan2(y,x)*180/Math.PI+360)%360;modalHsv.s=Math.min(1,Math.sqrt(x*x+y*y)/radius);syncColorModal();}
let wheelDragging=false;$('#colorWheel').addEventListener('pointerdown',event=>{wheelDragging=true;$('#colorWheel').setPointerCapture(event.pointerId);pickWheel(event);});$('#colorWheel').addEventListener('pointermove',event=>{if(wheelDragging)pickWheel(event);});$('#colorWheel').addEventListener('pointerup',()=>wheelDragging=false);
['#rgbR','#rgbG','#rgbB'].forEach(selector=>$(selector).addEventListener('input',()=>{modalHsv=rgbToHsv({r:clampByte($('#rgbR').value),g:clampByte($('#rgbG').value),b:clampByte($('#rgbB').value)});syncColorModal();}));
$('#colorValue').addEventListener('input',event=>{modalHsv.v=Number(event.target.value)/100;syncColorModal();});$('#colorModalClose').addEventListener('click',closeColorModal);$('#colorCancelButton').addEventListener('click',closeColorModal);$('#colorModal').addEventListener('click',event=>{if(event.target===$('#colorModal'))closeColorModal();});
$('#colorConfirmButton').addEventListener('click',async()=>{const callback=modalConfirm,hex=$('#modalHex').textContent.toLowerCase();if(!callback)return;$('#colorConfirmButton').disabled=true;try{await callback(hex);closeColorModal();}catch(error){setMessage(error.message,'error');}finally{$('#colorConfirmButton').disabled=false;}});
document.addEventListener('keydown',event=>{if(event.key!=='Escape')return;if(!$('#timelineModal').hidden)closeTimelineModal();else if(!$('#colorModal').hidden)closeColorModal();else if(!$('#groupSettingsModal').hidden)closeGroupSettings();else if(!$('#renameLightModal').hidden)closeRenameLight();});

function bindRange(id,outputId,suffix=''){const input=$(id),output=$(outputId),update=()=>output.textContent=`${input.value}${suffix}`;input.addEventListener('input',update);update();}
bindRange('#manualTransition','#manualTransitionValue',' ms');bindRange('#beatBrightness','#beatBrightnessValue','%');bindRange('#transition','#transitionValue',' ms');bindRange('#testBpm','#testBpmValue',' BPM');bindRange('#sensitivity','#sensitivityValue');bindRange('#minInterval','#intervalValue',' ms');bindRange('#syncOffset','#syncOffsetValue',' ms 빠르게');bindRange('#entertainmentAccentInterval','#entertainmentAccentIntervalValue',' ms');bindRange('#entertainmentPunch','#entertainmentPunchValue','%');
['manualTransition','beatBrightness','transition','testBpm','syncOffset','sensitivity','minInterval','entertainmentAccentInterval','entertainmentPunch'].forEach(id=>document.getElementById(id).addEventListener('change',queueControllerSettingsSave));
$('#beatBrightness').addEventListener('change',()=>musicScenesReady=false);
document.querySelectorAll('[data-zero-transition]').forEach(button=>button.addEventListener('click',()=>{const slider=document.getElementById(button.dataset.zeroTransition);slider.value=0;slider.dispatchEvent(new Event('input'));setMessage('전환 시간을 0ms로 설정했습니다. 실제 통신 지연은 별도로 발생할 수 있습니다.','success');}));

async function ensureAudio(){audioContext||=new AudioContext();if(audioContext.state==='suspended')await audioContext.resume();analyser||=new AnalyserNode(audioContext,{fftSize:2048,smoothingTimeConstant:.55});}
function totalSyncMs(){return Math.max(-1000,Math.min(1000,Math.round(audioSyncMs+lightSyncMs)));}
function signedMs(value,zeroSign=false){const rounded=Math.round(Number(value)||0);return `${rounded>0?'+':rounded<0?'−':zeroSign?'+':''}${Math.abs(rounded)}ms`;}
function syncCalibrationUi(save=true){
  audioSyncMs=Math.max(-1000,Math.min(1000,Math.round(Number(audioSyncMs)||0)));lightSyncMs=Math.max(-1000,Math.min(1000,Math.round(Number(lightSyncMs)||0)));const total=totalSyncMs();$('#audioSyncInput').value=audioSyncMs;$('#lightSyncInput').value=lightSyncMs;$('#totalSyncValue').textContent=signedMs(total);$('#calibrationLastResult').textContent=`오디오 ${signedMs(audioSyncMs)} · 전구 최종 ${signedMs(total)}`;$('#syncOffset').value=total;$('#syncOffsetValue').textContent=`${total} ms 빠르게`;if(save)queueControllerSettingsSave();
}
async function playCalibrationBeep(delayMs){
  await ensureAudio();const when=audioContext.currentTime+Math.max(0,delayMs)/1000,gain=audioContext.createGain();gain.gain.setValueAtTime(.0001,when);gain.gain.exponentialRampToValueAtTime(.62,when+.006);gain.gain.setValueAtTime(.62,when+.13);gain.gain.exponentialRampToValueAtTime(.0001,when+.28);gain.connect(audioContext.destination);[660,990].forEach((frequency,index)=>{const oscillator=audioContext.createOscillator();oscillator.type=index?'square':'sine';oscillator.frequency.setValueAtTime(frequency,when);oscillator.connect(gain);oscillator.start(when);oscillator.stop(when+.3);});
}
async function sendCalibrationFlash(on){
  if(!entertainmentActive)return;const groups=validateEntertainmentGroups(),commands=groups.map((group,index)=>({lightIds:group.lightIds,hexColor:on?'#ffffff':null,brightness:on?100:0,transitionMs:0,on,groupKey:`calibration-${index}`}));await api('/api/entertainment/frame',{method:'POST',body:JSON.stringify({commands,scheduleAheadMs:ENTERTAINMENT_SCHEDULE_AHEAD_MS})});
}
function setCalibrationControls(active){$('#startSyncVerificationButton').disabled=active;$('#stopCalibrationButton').disabled=!active;}
function resetCalibrationVisual(){cancelAnimationFrame(calibrationVisualFrame);calibrationVisualFrame=null;$('#calibrationTrack').classList.remove('fired','timeout');$('#calibrationRunner').style.left='4%';$('#calibrationCountdown').textContent='대기';}
function updateCalibrationVisual(){
  if(!syncVerificationActive)return;const now=performance.now(),duration=Math.max(1,calibrationTargetAt-calibrationTrialStartedAt),progress=Math.max(0,Math.min(1,(now-calibrationTrialStartedAt)/duration)),afterProgress=Math.max(0,Math.min(1,(now-calibrationTargetAt)/800));$('#calibrationRunner').style.left=`${4+progress*64+afterProgress*27}%`;const remaining=Math.round(calibrationTargetAt-now);if(remaining>0)$('#calibrationCountdown').textContent=`${remaining}ms`;else{if(!calibrationFired){calibrationFired=true;$('#calibrationTrack').classList.add('fired');$('#calibrationPrompt').textContent='HIT · 소리와 전구를 비교하세요';}const elapsed=Math.abs(remaining);$('#calibrationCountdown').textContent=elapsed<260?'지금!':`HIT 후 ${elapsed}ms`;}calibrationVisualFrame=requestAnimationFrame(updateCalibrationVisual);
}
function stopCalibration(silent=false){
  const wasActive=syncVerificationActive;syncVerificationActive=false;clearTimeout(calibrationTimer);clearTimeout(calibrationSignalTimer);clearTimeout(calibrationOffTimer);calibrationTimer=null;calibrationSignalTimer=null;calibrationOffTimer=null;setCalibrationControls(false);resetCalibrationVisual();if(wasActive)sendCalibrationFlash(false).catch(()=>{});if(!silent)$('#calibrationStatus').textContent='통합 테스트를 중지했습니다. 보정값은 유지됩니다.';
}
function scheduleSyncVerification(){
  if(!syncVerificationActive)return;const targetDelay=1800,audioDelay=Math.max(80,targetDelay-audioSyncMs),lightDelay=Math.max(80,targetDelay-totalSyncMs());resetCalibrationVisual();calibrationTrialStartedAt=performance.now();calibrationTargetAt=calibrationTrialStartedAt+targetDelay;calibrationFired=false;$('#calibrationPrompt').textContent='마커가 HIT에 도착할 때 소리와 전구를 확인하세요';syncCalibrationUi(false);$('#calibrationStatus').textContent=`통합 테스트 반복 중 · 오디오 ${signedMs(audioSyncMs)}, 전구 최종 ${signedMs(totalSyncMs())}`;playCalibrationBeep(audioDelay).catch(error=>{stopCalibration(true);setMessage(error.message,'error');});calibrationSignalTimer=setTimeout(()=>{if(!syncVerificationActive)return;sendCalibrationFlash(true).then(()=>{calibrationOffTimer=setTimeout(()=>sendCalibrationFlash(false).catch(()=>{}),220);}).catch(error=>{stopCalibration(true);setMessage(`통합 테스트 플래시 실패: ${error.message}`,'error');});},lightDelay);updateCalibrationVisual();calibrationTimer=setTimeout(scheduleSyncVerification,targetDelay+1500);
}
async function startSyncVerification(){
  stopCalibration(true);stopShowTest(true);const player=$('#audioPlayer');player.pause();resetAnalysis();try{await ensureAudio();validateEntertainmentGroups();if(!entertainmentActive)await startEntertainment();}catch(error){setMessage(`통합 테스트를 시작하지 못했습니다: ${error.message}`,'error');return;}syncVerificationActive=true;setCalibrationControls(true);$('#calibrationStatus').textContent='통합 싱크 테스트를 준비합니다.';calibrationTimer=setTimeout(scheduleSyncVerification,400);
}
function adjustSync(kind,delta){if(kind==='audio')audioSyncMs+=delta;else lightSyncMs+=delta;syncCalibrationUi();$('#calibrationStatus').textContent=`${kind==='audio'?'오디오':'전구'}를 ${delta<0?'빠른 출력 보정':'늦은 출력 보정'} 방향으로 ${Math.abs(delta)}ms 조절했습니다.`;}
$('#previewBeepButton').addEventListener('click',async()=>{try{await playCalibrationBeep(80);$('#calibrationStatus').textContent='비프음을 재생했습니다. 통합 테스트에서 HIT와 비교하세요.';}catch(error){setMessage(`비프음 재생 실패: ${error.message}`,'error');}});
$('#audioEarlierButton').addEventListener('click',()=>adjustSync('audio',-10));$('#audioLaterButton').addEventListener('click',()=>adjustSync('audio',10));$('#lightEarlierButton').addEventListener('click',()=>adjustSync('light',-10));$('#lightLaterButton').addEventListener('click',()=>adjustSync('light',10));
$('#startSyncVerificationButton').addEventListener('click',startSyncVerification);$('#stopCalibrationButton').addEventListener('click',()=>stopCalibration(false));
$('#audioSyncInput').addEventListener('change',event=>{audioSyncMs=Number(event.target.value)||0;syncCalibrationUi();$('#calibrationStatus').textContent=`오디오 선행값을 ${signedMs(audioSyncMs)}로 저장했습니다.`;});
$('#lightSyncInput').addEventListener('change',event=>{lightSyncMs=Number(event.target.value)||0;syncCalibrationUi();$('#calibrationStatus').textContent=`전구 추가 보정값을 ${signedMs(lightSyncMs)}로 저장했습니다. 전구 최종값은 ${signedMs(totalSyncMs())}입니다.`;});
$('#resetCalibrationButton').addEventListener('click',()=>{stopCalibration(true);audioSyncMs=0;lightSyncMs=0;syncCalibrationUi();$('#calibrationStatus').textContent='오디오와 전구 보정값을 0ms로 초기화했습니다.';});
function resetAnalysis(){cancelAnimationFrame(animationFrame);animationFrame=null;energyHistory=[];beatTimes=[];lastBeatAt=0;beatCount=0;lastMusicCommandAt=0;lastScheduledMusicBeat=-Infinity;equalizerLastLevel=-1;equalizerLastSentAt=0;equalizerSamples=[];equalizerCalibrationStartedAt=0;equalizerHoldUntil=0;equalizerColorDirty=false;entertainmentAccentBucket=-1;entertainmentFlashUntil=0;$('#beatCount').textContent='0';$('#bpmValue').textContent='—';$('#commandInterval').textContent='—';$('#equalizerLevel').textContent='0';if(sourceNode){try{sourceNode.disconnect();}catch{}sourceNode=null;}if(activeStream){activeStream.getTracks().forEach(track=>track.stop());activeStream=null;}}
function percentile(sorted,ratio){if(!sorted.length)return 0;const position=(sorted.length-1)*ratio,lower=Math.floor(position),upper=Math.ceil(position),weight=position-lower;return sorted[lower]*(1-weight)+sorted[upper]*weight;}
function updateEqualizerFromEnergy(energy,average,now){
  const group=selectedEqualizerGroup();if(!group)return;if(!equalizerCalibrationStartedAt)equalizerCalibrationStartedAt=now;equalizerSamples.push({time:now,value:energy});while(equalizerSamples.length&&equalizerSamples[0].time<now-3500)equalizerSamples.shift();
  if(now-equalizerCalibrationStartedAt<1400){$('#equalizerLevel').textContent='보정 중';return;}
  const values=equalizerSamples.map(sample=>sample.value).sort((a,b)=>a-b),floor=percentile(values,.15),ceiling=percentile(values,.94),span=Math.max(8,ceiling-floor),raw=Math.max(0,Math.min(1,(energy-floor)/(span*1.08))),shaped=Math.pow(raw,1.35),punch=Math.max(0,Math.min(1,(energy-average)/Math.max(6,average*.3))),normalized=Math.min(1,shaped*.86+punch*.14),max=group.lightIds.filter(id=>connectedLightIds().includes(id)).length;
  let target=Math.round(normalized*max);if(energy<floor+1.5)target=0;const current=Math.max(0,equalizerLastLevel),sendReady=now-equalizerLastSentAt>=MUSIC_COMMAND_INTERVAL_MS;let next=current;
  if(target>current){next=target;equalizerHoldUntil=now+140;}else if(target<current&&now>=equalizerHoldUntil&&sendReady)next=current-1;
  if((next!==current||equalizerColorDirty)&&sendReady){applyEqualizerLevel(next).then(applied=>{if(applied)equalizerLastSentAt=performance.now();}).catch(error=>setMessage(error.message,'error'));}
}
function startAnalysis(){
  cancelAnimationFrame(animationFrame);const buffer=new Uint8Array(analyser.frequencyBinCount),canvas=$('#meter'),ctx=canvas.getContext('2d');
  const frame=()=>{
    analyser.getByteFrequencyData(buffer);const binHz=audioContext.sampleRate/analyser.fftSize,bassEnd=Math.max(5,Math.floor(250/binHz)),rhythmEnd=Math.max(bassEnd+1,Math.floor(2000/binHz));let bass=0,rhythm=0;
    for(let i=1;i<bassEnd;i++)bass+=buffer[i]*buffer[i];for(let i=bassEnd;i<rhythmEnd;i++)rhythm+=buffer[i]*buffer[i];bass=Math.sqrt(bass/Math.max(1,bassEnd-1));rhythm=Math.sqrt(rhythm/Math.max(1,rhythmEnd-bassEnd));
    const energy=bass*.72+rhythm*.28,average=energyHistory.length?energyHistory.reduce((a,b)=>a+b,0)/energyHistory.length:energy;energyHistory.push(energy);if(energyHistory.length>60)energyHistory.shift();
    const now=performance.now(),sensitivity=Number($('#sensitivity').value),threshold=average*(1+Math.max(.02,(sensitivity-1)*.32)),interval=Number($('#minInterval').value),strongRise=energy>Math.max(18,threshold)&&energy-average>2.5,fallbackPulse=energy>20&&now-lastBeatAt>1800;
    if(energyHistory.length>12&&(strongRise||fallbackPulse)&&now-lastBeatAt>=interval){lastBeatAt=now;beatTimes.push(now);if(beatTimes.length>9)beatTimes.shift();if(beatTimes.length>2){const gaps=beatTimes.slice(1).map((time,index)=>time-beatTimes[index]);$('#bpmValue').textContent=Math.round(60000/(gaps.reduce((a,b)=>a+b,0)/gaps.length));}if(musicStyle==='beat')triggerBeat();else if(musicStyle==='beat-brightness')triggerBrightnessBeat(Math.min(1,energy/95));else if(musicStyle==='entertainment'){phase=(phase+3)%placementColors.length;beatCount++;$('#beatCount').textContent=beatCount;sendEntertainmentFrame(Math.min(1,energy/95),true).catch(error=>setMessage(error.message,'error'));}else{phase=(phase+1)%placementColors.length;equalizerColorDirty=true;beatCount++;$('#beatCount').textContent=beatCount;}}
    if(musicStyle==='equalizer')updateEqualizerFromEnergy(energy,average,now);ctx.clearRect(0,0,canvas.width,canvas.height);const gradient=ctx.createLinearGradient(0,0,canvas.width,0);gradient.addColorStop(0,'#7957ff');gradient.addColorStop(1,'#1dd3e8');ctx.fillStyle=gradient;const bars=90,step=Math.max(1,Math.floor(buffer.length/bars));for(let i=0;i<bars;i++){const h=buffer[i*step]/255*canvas.height;ctx.fillRect(i*canvas.width/bars,canvas.height-h,Math.max(2,canvas.width/bars-3),h);}animationFrame=requestAnimationFrame(frame);
  };frame();
}
function formatDuration(seconds){const safe=Math.max(0,Math.round(seconds||0)),minutes=Math.floor(safe/60);return `${minutes}:${String(safe%60).padStart(2,'0')}`;}
function deriveSpectralFluxEnvelope(analysis){
  const low=analysis.bassEnvelope||[],mid=analysis.midEnvelope||[],high=analysis.highEnvelope||[],length=Math.max(low.length,mid.length,high.length),raw=Array(length).fill(0);
  for(let index=1;index<length;index++)raw[index]=Math.max(0,(low[index]||0)-(low[index-1]||0))*.46+Math.max(0,(mid[index]||0)-(mid[index-1]||0))*.32+Math.max(0,(high[index]||0)-(high[index-1]||0))*.22;
  const scale=Math.max(.0001,percentile([...raw].sort((a,b)=>a-b),.985));return raw.map(value=>Math.sqrt(Math.max(0,Math.min(1,value/scale))));
}
async function analyzeAudioBuffer(buffer,onProgress=()=>{}){
  const frameSeconds=.02,hop=Math.max(1,Math.round(buffer.sampleRate*frameSeconds)),frameCount=Math.max(1,Math.ceil(buffer.length/hop)),channels=Array.from({length:buffer.numberOfChannels},(_,index)=>buffer.getChannelData(index)),energies=new Float32Array(frameCount),bassEnergy=new Float32Array(frameCount),midEnergy=new Float32Array(frameCount),highEnergy=new Float32Array(frameCount);let low=0,upper=0;const sampleStride=2,lowAlpha=1-Math.exp(-2*Math.PI*180*sampleStride/buffer.sampleRate),upperAlpha=1-Math.exp(-2*Math.PI*2500*sampleStride/buffer.sampleRate);
  for(let frame=0;frame<frameCount;frame++){
    const start=frame*hop,end=Math.min(buffer.length,start+hop);let sum=0,bassSum=0,midSum=0,highSum=0,count=0;
    for(let position=start;position<end;position+=sampleStride){let mixed=0;for(const channel of channels)mixed+=channel[position]||0;mixed/=channels.length;sum+=mixed*mixed;low+=lowAlpha*(mixed-low);upper+=upperAlpha*(mixed-upper);const mid=upper-low,high=mixed-upper;bassSum+=low*low;midSum+=mid*mid;highSum+=high*high;count++;}
    energies[frame]=Math.log1p(Math.sqrt(sum/Math.max(1,count))*80);bassEnergy[frame]=Math.sqrt(bassSum/Math.max(1,count));midEnergy[frame]=Math.sqrt(midSum/Math.max(1,count));highEnergy[frame]=Math.sqrt(highSum/Math.max(1,count));
    if(frame%1200===0){onProgress(Math.round(frame/frameCount*55));await new Promise(resolve=>setTimeout(resolve,0));}
  }

  const onsets=new Float32Array(frameCount),bassOnsets=new Float32Array(frameCount);
  for(let frame=1;frame<frameCount;frame++){
    let local=0,items=0;for(let back=2;back<=10&&frame-back>=0;back++){local+=energies[frame-back];items++;}
    let bassLocal=0,bassItems=0;for(let back=2;back<=10&&frame-back>=0;back++){bassLocal+=bassEnergy[frame-back];bassItems++;}
    const baseline=items?local/items:energies[frame-1],bassBaseline=bassItems?bassLocal/bassItems:bassEnergy[frame-1],rise=Math.max(0,energies[frame]-baseline),slope=Math.max(0,energies[frame]-energies[frame-1]);onsets[frame]=rise+slope*.7;bassOnsets[frame]=Math.max(0,(bassEnergy[frame]-bassBaseline)/Math.max(.00001,bassBaseline));
  }
  const minLag=Math.max(2,Math.round(60/180/frameSeconds)),maxLag=Math.min(frameCount-1,Math.round(60/70/frameSeconds)),scores=new Map();let bestLag=Math.round(.5/frameSeconds),bestScore=-Infinity;
  for(let lag=minLag;lag<=maxLag;lag++){
    let cross=0,left=0,right=0;for(let frame=lag;frame<frameCount;frame++){const a=onsets[frame],b=onsets[frame-lag];cross+=a*b;left+=a*a;right+=b*b;}
    const score=cross/Math.max(1e-9,Math.sqrt(left*right));scores.set(lag,score);if(score>bestScore){bestScore=score;bestLag=lag;}
  }
  if(bestLag*2<=maxLag&&(scores.get(bestLag*2)||0)>bestScore*.92)bestLag*=2;
  if(bestLag%2===0&&bestLag/2>=minLag&&(scores.get(bestLag/2)||0)>bestScore*.8)bestLag/=2;
  const bpm=Math.round(60/(bestLag*frameSeconds));

  const sortedEnergy=Array.from(energies).sort((a,b)=>a-b),floor=percentile(sortedEnergy,.1),ceiling=percentile(sortedEnergy,.96),range=Math.max(.08,ceiling-floor),envelope=[],energyLevels=new Float32Array(frameCount),envelopeEvery=Math.max(1,Math.round(.1/frameSeconds));let smoothed=0;
  for(let frame=0;frame<frameCount;frame++){
    let level=Math.max(0,Math.min(1,(energies[frame]-floor)/(range*1.04)));level=Math.pow(level,1.35);energyLevels[frame]=level;smoothed+=(level > smoothed ? .72 : .11)*(level-smoothed);if(frame%envelopeEvery===0)envelope.push(smoothed<.025?0:smoothed);
  }
  const activeStartIndex=Math.max(0,Array.from(energies).findIndex(value=>value>floor+range*.08)),beatInterval=bestLag*frameSeconds,beatTimes=[],cueStrengths=[],rawBassHitTimes=[];
  // BPM is reference-only. Analyse every local maximum instead of forcing one
  // winner into each fixed half-second bucket. Low-frequency attacks dominate;
  // a very strong broadband onset is retained only when the song is active.
  const sortedOnsets=Array.from(onsets).sort((a,b)=>a-b),onsetFloor=percentile(sortedOnsets,.5),onsetCeiling=percentile(sortedOnsets,.985),onsetRange=Math.max(.0001,onsetCeiling-onsetFloor),sortedBassOnsets=Array.from(bassOnsets).sort((a,b)=>a-b),bassOnsetFloor=percentile(sortedBassOnsets,.55),bassOnsetCeiling=percentile(sortedBassOnsets,.985),bassOnsetRange=Math.max(.0001,bassOnsetCeiling-bassOnsetFloor),candidates=[];
  for(let frame=Math.max(2,activeStartIndex);frame<frameCount-2;frame++){
    const energyPeak=onsets[frame]>=onsets[frame-1]&&onsets[frame]>=onsets[frame+1],bassPeak=bassOnsets[frame]>=bassOnsets[frame-1]&&bassOnsets[frame]>=bassOnsets[frame+1];if(!energyPeak&&!bassPeak)continue;
    const attack=Math.max(0,Math.min(1,(onsets[frame]-onsetFloor)/onsetRange)),bassAttack=Math.max(0,Math.min(1,(bassOnsets[frame]-bassOnsetFloor)/bassOnsetRange)),intensity=energyLevels[frame],time=(frame+.5)*frameSeconds;
    if(bassPeak&&bassAttack>=.2)rawBassHitTimes.push(time);
    const bassDriven=bassPeak&&bassAttack>=.2,clearBroadband=energyPeak&&attack>=.78&&intensity>=.16;if(!bassDriven&&!clearBroadband)continue;
    const score=Math.min(1,bassAttack*.62+attack*.22+intensity*.12+(bassDriven?.08:0));if(score<.24)continue;candidates.push({time,score,bassAttack,attack,intensity});
  }
  for(const cue of candidates){
    const requiredGap=cue.score>=.78?.18:cue.score>=.55?.26:.38,lastIndex=beatTimes.length-1,lastTime=beatTimes[lastIndex]??-Infinity;
    if(cue.time-lastTime<requiredGap){if(lastIndex>=0&&cue.score>cueStrengths[lastIndex]){beatTimes[lastIndex]=cue.time;cueStrengths[lastIndex]=cue.score;}continue;}
    beatTimes.push(cue.time);cueStrengths.push(Math.max(.15,Math.min(1,cue.score)));
  }
  const phaseScores=new Float64Array(bestLag);
  for(let frame=activeStartIndex;frame<frameCount;frame++)phaseScores[frame%bestLag]+=onsets[frame]*.55+bassOnsets[frame]*.35+energyLevels[frame]*.1;
  let bestBeatPhase=0;for(let index=1;index<phaseScores.length;index++)if(phaseScores[index]>phaseScores[bestBeatPhase])bestBeatPhase=index;
  const phaseDistance=(bestBeatPhase-activeStartIndex%bestLag+bestLag)%bestLag,firstBeatFrame=activeStartIndex+phaseDistance,beatGridStart=(firstBeatFrame+.5)*frameSeconds,beatGrid=[];
  for(let time=beatGridStart;time<buffer.duration;time+=beatInterval)beatGrid.push(Number(time.toFixed(5)));
  const downbeatScores=[0,0,0,0];for(let index=0;index<beatGrid.length;index++){const frame=Math.max(0,Math.min(frameCount-1,Math.round(beatGrid[index]/frameSeconds)));downbeatScores[index%4]+=onsets[frame]*.45+bassOnsets[frame]*.35+energyLevels[frame]*.2;}
  let downbeatPhase=0;for(let index=1;index<4;index++)if(downbeatScores[index]>downbeatScores[downbeatPhase])downbeatPhase=index;const downbeats=beatGrid.filter((_,index)=>index%4===downbeatPhase);
  onProgress(80);
  const normalizeBand=values=>Math.max(.00001,percentile(Array.from(values).sort((a,b)=>a-b),.96)),bassMax=normalizeBand(bassEnergy),midMax=normalizeBand(midEnergy),highMax=normalizeBand(highEnergy),bassEnvelope=[],midEnvelope=[],highEnvelope=[],bassOnsetEnvelope=[],onsetEnvelope=[];
  for(let i=0;i<frameCount;i+=envelopeEvery){bassEnvelope.push(Math.min(1,bassEnergy[i]/bassMax));midEnvelope.push(Math.min(1,midEnergy[i]/midMax));highEnvelope.push(Math.min(1,highEnergy[i]/highMax));bassOnsetEnvelope.push(Math.max(0,Math.min(1,(bassOnsets[i]-bassOnsetFloor)/bassOnsetRange)));onsetEnvelope.push(Math.max(0,Math.min(1,(onsets[i]-onsetFloor)/onsetRange)));}
  const spectralFluxEnvelope=deriveSpectralFluxEnvelope({bassEnvelope,midEnvelope,highEnvelope});
  const result={version:10,duration:buffer.duration,bpm,beatInterval,beatGridStart,beatGridOffsetMs:0,beatGrid,downbeatPhase,downbeats,beatTimes,cueStrengths,rawBassHitTimes,envelope,bassEnvelope,midEnvelope,highEnvelope,bassOnsetEnvelope,onsetEnvelope,spectralFluxEnvelope,envelopeStep:.1,confidence:Math.max(0,Math.min(1,bestScore||0)),analysisMode:'layered-show'};
  result.lightingScore=HueShowScore.compile(result);result.mediaArt=HueMediaArt.compile({...result,slotCount:entertainmentPairCount()});return result;
}
function paintAnalyzedTimeline(canvas,currentTime=0,rangeStart=0,rangeEnd=null){
  const ctx=canvas.getContext('2d');ctx.clearRect(0,0,canvas.width,canvas.height);if(!analyzedTrack)return;
  const values=analyzedTrack.envelope||[],bassValues=analyzedTrack.bassEnvelope||[],midValues=analyzedTrack.midEnvelope||[],highValues=analyzedTrack.highEnvelope||[],step=Number(analyzedTrack.envelopeStep)||.1,duration=Math.max(.1,Number(analyzedTrack.duration)||0),start=Math.max(0,Math.min(duration-.01,Number(rangeStart)||0)),end=Math.max(start+.01,Math.min(duration,rangeEnd===null?duration:Number(rangeEnd)||duration)),span=end-start,fromIndex=Math.max(0,Math.floor(start/step)),toIndex=Math.min(values.length,Math.ceil(end/step)),visibleCount=Math.max(1,toIndex-fromIndex),bars=Math.min(canvas.width,visibleCount),gradient=ctx.createLinearGradient(0,0,canvas.width,0);gradient.addColorStop(0,'#7957ff');gradient.addColorStop(1,'#1dd3e8');ctx.fillStyle=gradient;
  const visible=layer=>timelineLayer==='all'||timelineLayer===layer;
  if(visible('energy'))for(let bar=0;bar<bars;bar++){const from=fromIndex+Math.floor(bar*visibleCount/bars),to=Math.min(toIndex,Math.max(from+1,fromIndex+Math.floor((bar+1)*visibleCount/bars)));let peak=0;for(let index=from;index<to;index++)peak=Math.max(peak,values[index]||0);const height=Math.max(2,peak*(canvas.height-8));ctx.fillRect(bar*canvas.width/bars,canvas.height-height,Math.max(1,canvas.width/bars),height);}
  if(visible('phrase'))for(const phrase of analyzedTrack.lightingScore?.phrases||[]){if(phrase.end<start||phrase.start>end)continue;const x=Math.max(0,(phrase.start-start)/span*canvas.width),right=Math.min(canvas.width,(phrase.end-start)/span*canvas.width);ctx.fillStyle=['intro','bridge','outro'].includes(phrase.type)?'rgba(101,126,168,.28)':phrase.type==='climax'?'rgba(255,80,130,.3)':'rgba(77,225,194,.22)';ctx.fillRect(x,0,Math.max(1,right-x),canvas.height);if(span<=120||timelineLayer==='phrase'){ctx.fillStyle='#f0f6ff';ctx.font=`${Math.max(10,canvas.width/120)}px sans-serif`;ctx.fillText(HueShowScore.TYPE_LABELS[phrase.type]||phrase.type,x+5,16);}}
  const drawGrid=(times,color,width,alpha)=>{ctx.strokeStyle=color;ctx.lineWidth=width;ctx.globalAlpha=alpha;for(const time of times||[]){if(time<start||time>end)continue;const markerX=(time-start)/span*canvas.width;ctx.beginPath();ctx.moveTo(markerX,0);ctx.lineTo(markerX,canvas.height);ctx.stroke();}ctx.globalAlpha=1;};
  if(visible('beat')&&(span<=30||timelineLayer==='beat'))drawGrid(analyzedTrack.beatGrid,'#62a8ff',1,timelineLayer==='beat'?.72:.24);if(visible('downbeat'))drawGrid(analyzedTrack.downbeats,'#22e5ee',Math.max(1.5,canvas.width/1200*2),timelineLayer==='downbeat'?.8:.48);
  if(visible('bass')&&bassValues.length){ctx.beginPath();ctx.strokeStyle='#42f5c5';ctx.lineWidth=Math.max(2,canvas.width/1000);ctx.globalAlpha=.9;for(let x=0;x<canvas.width;x++){const time=start+x/canvas.width*span,index=Math.min(bassValues.length-1,Math.max(0,Math.floor(time/step))),y=canvas.height-4-(bassValues[index]||0)*(canvas.height-12);if(x===0)ctx.moveTo(x,y);else ctx.lineTo(x,y);}ctx.stroke();ctx.globalAlpha=1;}
  const drawBand=(layer,data,color)=>{if(!visible(layer)||!data.length)return;ctx.beginPath();ctx.strokeStyle=color;ctx.lineWidth=Math.max(2,canvas.width/1100);for(let x=0;x<canvas.width;x++){const time=start+x/canvas.width*span,index=Math.min(data.length-1,Math.max(0,Math.floor(time/step))),y=canvas.height-4-(data[index]||0)*(canvas.height-12);if(x===0)ctx.moveTo(x,y);else ctx.lineTo(x,y);}ctx.stroke();};drawBand('mid',midValues,'#ffd166');drawBand('high',highValues,'#ff7de9');
  if(visible('raw')){ctx.strokeStyle='#ff5ac8';ctx.lineWidth=Math.max(1,canvas.width/1500);for(const time of analyzedTrack.rawBassHitTimes||[]){if(time<start||time>end)continue;const markerX=(time-start)/span*canvas.width;ctx.globalAlpha=timelineLayer==='raw'?.9:.52;ctx.beginPath();ctx.moveTo(markerX,timelineLayer==='raw'?0:canvas.height*.28);ctx.lineTo(markerX,timelineLayer==='raw'?canvas.height:canvas.height*.48);ctx.stroke();}}
  if(visible('cue')){ctx.strokeStyle='#ffb020';ctx.lineWidth=Math.max(1,canvas.width/1500);for(let index=0;index<(analyzedTrack.beatTimes?.length||0);index++){const time=analyzedTrack.beatTimes[index];if(time<start||time>end)continue;const cueX=(time-start)/span*canvas.width,strength=Math.max(.15,Math.min(1,analyzedTrack.cueStrengths?.[index]??.6));ctx.globalAlpha=timelineLayer==='cue'?.9:.45+strength*.5;ctx.beginPath();ctx.moveTo(cueX,0);ctx.lineTo(cueX,timelineLayer==='cue'?canvas.height:10+strength*canvas.height*.2);ctx.stroke();}}ctx.globalAlpha=1;
  if(visible('playhead')&&currentTime>=start&&currentTime<=end){const x=(currentTime-start)/span*canvas.width;ctx.fillStyle='#ffffff';ctx.fillRect(x,0,Math.max(2,canvas.width/900*2),canvas.height);}
}
function drawAnalyzedTimeline(currentTime=0){
  paintAnalyzedTimeline($('#meter'),currentTime);if(!$('#timelineModal').hidden&&analyzedTrack){const duration=Math.max(.1,Number(analyzedTrack.duration)||0),detailStart=Math.max(0,Math.min(Math.max(0,duration-10),currentTime-5)),detailEnd=Math.min(duration,detailStart+10);paintAnalyzedTimeline($('#timelineModalCanvas'),currentTime);paintAnalyzedTimeline($('#timelineDetailCanvas'),currentTime,detailStart,detailEnd);$('#timelineDetailRange').textContent=`${formatDuration(detailStart)}–${formatDuration(detailEnd)}`;updateBeatgridEditor();}if(!analyzedTrack)return;const label=`분석 v${analyzedTrack.version||'?'} · Beat ${analyzedTrack.beatGrid?.length||0}개 · 최종 타격 ${analyzedTrack.beatTimes?.length||0}개`;$('#analysisVersion').textContent=label;$('#analysisVersionModal').textContent=label;
}
function openTimelineModal(){if(!analyzedTrack){setMessage('먼저 분석된 음악을 선택하세요.');return;}$('#timelineModal').hidden=false;renderScoreEditor();drawAnalyzedTimeline($('#audioPlayer').currentTime||0);$('#timelineModalClose').focus();}
function closeTimelineModal(){$('#timelineModal').hidden=true;$('#meter').focus();}
$('#meter').addEventListener('click',openTimelineModal);$('#meter').addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();openTimelineModal();}});$('#timelineModalClose').addEventListener('click',closeTimelineModal);$('#timelineModal').addEventListener('click',event=>{if(event.target===$('#timelineModal'))closeTimelineModal();});
function setTimelineLayer(layer){timelineLayer=layer;document.querySelectorAll('[data-timeline-layer]').forEach(button=>button.classList.toggle('active',button.dataset.timelineLayer===layer));drawAnalyzedTimeline($('#audioPlayer').currentTime||0);}
document.querySelectorAll('[data-timeline-layer]').forEach(button=>button.addEventListener('click',()=>setTimelineLayer(button.dataset.timelineLayer)));setTimelineLayer('all');
function rebuildBeatGrid(){
  if(!analyzedTrack)return;const interval=Math.max(.125,Math.min(1.5,Number(analyzedTrack.beatInterval)||.5)),start=Number(analyzedTrack.beatGridStart)||0,duration=Math.max(.1,Number(analyzedTrack.duration)||0),grid=[];for(let time=start;time<duration;time+=interval)if(time>=0)grid.push(Number(time.toFixed(5)));analyzedTrack.beatInterval=interval;analyzedTrack.bpm=Math.round(60/interval);analyzedTrack.beatGrid=grid;analyzedTrack.downbeatPhase=((Number(analyzedTrack.downbeatPhase)||0)%4+4)%4;analyzedTrack.downbeats=grid.filter((_,index)=>index%4===analyzedTrack.downbeatPhase);
}
function updateBeatgridEditor(){if(!analyzedTrack)return;$('#beatgridSummary').textContent=`${analyzedTrack.bpm||'—'} BPM · ${Math.round((analyzedTrack.beatInterval||0)*1000)}ms/Beat · 시작 ${Number(analyzedTrack.beatGridStart||0).toFixed(3)}초 · 보정 ${signedMs(analyzedTrack.beatGridOffsetMs||0)}`;$('#bpmValue').textContent=analyzedTrack.bpm||'—';}
function editBeatgrid({bpmFactor=1,shiftMs=0,downbeatShift=0}){if(!analyzedTrack?.beatGrid?.length){setMessage('Beatgrid가 포함된 분석 v9 음원을 먼저 선택하세요.','error');return;}if(bpmFactor!==1)analyzedTrack.beatInterval=Math.max(.25,Math.min(1.5,analyzedTrack.beatInterval/bpmFactor));if(shiftMs){analyzedTrack.beatGridStart=Math.max(0,Math.min(analyzedTrack.duration-.01,analyzedTrack.beatGridStart+shiftMs/1000));analyzedTrack.beatGridOffsetMs=(Number(analyzedTrack.beatGridOffsetMs)||0)+shiftMs;}if(downbeatShift)analyzedTrack.downbeatPhase=(Number(analyzedTrack.downbeatPhase)||0)+downbeatShift;rebuildBeatGrid();rebuildLightingScore(false);}
document.querySelectorAll('[data-grid-bpm]').forEach(button=>button.addEventListener('click',()=>editBeatgrid({bpmFactor:Number(button.dataset.gridBpm)})));document.querySelectorAll('[data-grid-shift]').forEach(button=>button.addEventListener('click',()=>editBeatgrid({shiftMs:Number(button.dataset.gridShift)})));document.querySelectorAll('[data-downbeat-shift]').forEach(button=>button.addEventListener('click',()=>editBeatgrid({downbeatShift:Number(button.dataset.downbeatShift)})));
$('#saveBeatgridButton').addEventListener('click',async()=>{if(!activeTrackId||!analyzedTrack)return;$('#saveBeatgridButton').disabled=true;try{const updated=await api(`/api/tracks/${encodeURIComponent(activeTrackId)}/analysis`,{method:'PUT',body:JSON.stringify(analyzedTrack)});analyzedTrack=updated.analysis;savedTracks=savedTracks.map(track=>track.id===updated.id?updated:track);renderTrackLibrary();drawAnalyzedTimeline($('#audioPlayer').currentTime||0);setMessage('Beatgrid 보정값을 저장했습니다.','success');}catch(error){setMessage(`Beatgrid를 저장하지 못했습니다: ${error.message}`,'error');}finally{$('#saveBeatgridButton').disabled=false;}});
function rebuildLightingScore(preserve=true){
  if(!analyzedTrack)return;const previous=analyzedTrack.lightingScore,barsPerPhrase=Number($('#scoreBarsPerPhrase')?.value)||previous?.barsPerPhrase||4;if(!preserve)delete analyzedTrack.lightingScore;analyzedTrack.lightingScore=HueShowScore.compile(analyzedTrack,{barsPerPhrase});if(preserve&&previous?.reactive)analyzedTrack.lightingScore.reactive=previous.reactive;analyzedTrack.mediaArt=HueMediaArt.compile({...analyzedTrack,slotCount:entertainmentPairCount()});renderScoreEditor();drawAnalyzedTimeline($('#audioPlayer').currentTime||0);
}
function phraseOptions(selected,labels){return Object.entries(labels).map(([value,label])=>`<option value="${value}" ${value===selected?'selected':''}>${label}</option>`).join('');}
function renderScoreEditor(){
  if(!analyzedTrack)return;const score=analyzedTrack.lightingScore||(analyzedTrack.lightingScore=HueShowScore.compile(analyzedTrack));$('#scoreSummary').textContent=`${score.phrases.length}개 구간 · ${score.cues.length}개 Cue · ${score.barsPerPhrase||4}마디 기준`;
  $('#scoreBarsPerPhrase').value=String(score.barsPerPhrase||4);
  $('#phraseList').innerHTML=score.phrases.map((phrase,index)=>`<article class="phrase-row" data-phrase-id="${phrase.id}"><span class="phrase-index">${index+1}</span><div><strong>${formatDuration(phrase.start)}–${formatDuration(phrase.end)}</strong><small>${phrase.bars||'—'}마디 · 평균 ${Math.round((phrase.stats?.energy||0)*100)}%</small></div><select data-phrase-type aria-label="구간 유형">${phraseOptions(phrase.type,HueShowScore.TYPE_LABELS)}</select><select data-phrase-preset aria-label="조명 패턴">${phraseOptions(phrase.preset,HueShowScore.PRESET_LABELS)}</select><button data-phrase-shift="-1" ${index===0?'disabled':''}>경계 −1마디</button><button data-phrase-shift="1" ${index===0?'disabled':''}>경계 +1마디</button></article>`).join('');
  const reactive=score.reactive||{};for(const band of ['low','mid','high']){const value=Math.round((reactive[band]?.gain||0)*100);$(`#${band}Gain`).value=value;$(`#${band}GainValue`).textContent=`${value}%`;}
  for(const field of ['attack','release']){const id=field==='attack'?'reactiveAttack':'reactiveRelease',value=Math.round((reactive[field]||0)*100);$(`#${id}`).value=value;$(`#${id}Value`).textContent=`${value}%`;}
  const manual=score.cues.filter(cue=>!cue.automatic);$('#manualCueList').innerHTML=manual.length?manual.map(cue=>`<span>${formatDuration(cue.time)} · ${cue.type==='blackout'?'암전':'전체 펀치'} <button data-cue-delete="${cue.id}">삭제</button></span>`).join(''):'<span class="score-empty">수동 Cue 없음</span>';
}
function snapToDownbeat(time){const beats=analyzedTrack?.downbeats||[];return beats.reduce((best,value)=>Math.abs(value-time)<Math.abs(best-time)?value:best,beats[0]??time);}
function refreshCompiledScore(){analyzedTrack.lightingScore=HueShowScore.normalize(analyzedTrack.lightingScore,analyzedTrack);analyzedTrack.mediaArt=HueMediaArt.compile({...analyzedTrack,slotCount:entertainmentPairCount()});renderScoreEditor();drawAnalyzedTimeline($('#audioPlayer').currentTime||0);}
async function saveLightingScore(){if(!activeTrackId||!analyzedTrack)return;$('#saveScoreButton').disabled=true;try{refreshCompiledScore();const updated=await api(`/api/tracks/${encodeURIComponent(activeTrackId)}/analysis`,{method:'PUT',body:JSON.stringify(analyzedTrack)});analyzedTrack=updated.analysis;savedTracks=savedTracks.map(track=>track.id===updated.id?updated:track);renderTrackLibrary();renderScoreEditor();setMessage('프레이즈·패턴·Cue 조명 악보를 곡에 저장했습니다.','success');}catch(error){setMessage(`조명 악보를 저장하지 못했습니다: ${error.message}`,'error');}finally{$('#saveScoreButton').disabled=false;}}
$('#phraseList').addEventListener('change',event=>{const row=event.target.closest('[data-phrase-id]'),phrase=analyzedTrack?.lightingScore?.phrases.find(item=>item.id===row?.dataset.phraseId);if(!phrase)return;if(event.target.matches('[data-phrase-type]')){phrase.type=event.target.value;if(!event.target.closest('.phrase-row').querySelector('[data-phrase-preset]').dataset.edited)phrase.preset=HueShowScore.DEFAULT_PRESET[phrase.type];}if(event.target.matches('[data-phrase-preset]')){phrase.preset=event.target.value;event.target.dataset.edited='true';}refreshCompiledScore();});
$('#phraseList').addEventListener('click',event=>{const button=event.target.closest('[data-phrase-shift]');if(!button)return;const row=button.closest('[data-phrase-id]'),phrases=analyzedTrack.lightingScore.phrases,index=phrases.findIndex(item=>item.id===row.dataset.phraseId);if(index<=0)return;const downbeats=analyzedTrack.downbeats||[],current=phrases[index].start,barIndex=downbeats.findIndex(time=>Math.abs(time-current)<.04),target=downbeats[barIndex+Number(button.dataset.phraseShift)];if(target===undefined||target<=phrases[index-1].start+.1||target>=phrases[index].end-.1)return;phrases[index].start=target;phrases[index-1].end=target;refreshCompiledScore();});
$('#splitPhraseButton').addEventListener('click',()=>{if(!analyzedTrack)return;const score=analyzedTrack.lightingScore,time=snapToDownbeat($('#audioPlayer').currentTime||0),index=score.phrases.findIndex(phrase=>time>phrase.start+.1&&time<phrase.end-.1);if(index<0){setMessage('현재 위치에서 나눌 수 있는 프레이즈가 없습니다.','error');return;}const phrase=score.phrases[index],next={...phrase,id:`phrase-${Date.now()}`,start:time};phrase.end=time;score.phrases.splice(index+1,0,next);refreshCompiledScore();});
function addManualCue(type){if(!analyzedTrack)return;const time=snapToDownbeat($('#audioPlayer').currentTime||0);analyzedTrack.lightingScore.cues.push({id:`manual-${type}-${Date.now()}`,time,type,automatic:false});refreshCompiledScore();}
$('#addBlackoutCueButton').addEventListener('click',()=>addManualCue('blackout'));$('#addPunchCueButton').addEventListener('click',()=>addManualCue('full-punch'));$('#manualCueList').addEventListener('click',event=>{const button=event.target.closest('[data-cue-delete]');if(!button)return;analyzedTrack.lightingScore.cues=analyzedTrack.lightingScore.cues.filter(cue=>cue.id!==button.dataset.cueDelete);refreshCompiledScore();});
for(const band of ['low','mid','high'])$(`#${band}Gain`).addEventListener('input',event=>{if(!analyzedTrack)return;const value=Number(event.target.value)/100;analyzedTrack.lightingScore.reactive[band].gain=value;$(`#${band}GainValue`).textContent=`${event.target.value}%`;analyzedTrack.mediaArt=HueMediaArt.compile({...analyzedTrack,slotCount:entertainmentPairCount()});});
for(const [id,field] of [['reactiveAttack','attack'],['reactiveRelease','release']])$(`#${id}`).addEventListener('input',event=>{if(!analyzedTrack)return;analyzedTrack.lightingScore.reactive[field]=Number(event.target.value)/100;$(`#${id}Value`).textContent=`${event.target.value}%`;analyzedTrack.mediaArt=HueMediaArt.compile({...analyzedTrack,slotCount:entertainmentPairCount()});});
$('#rebuildScoreButton').addEventListener('click',()=>{rebuildLightingScore(false);setMessage('현재 분석 데이터에서 프레이즈와 기본 패턴을 다시 만들었습니다. 저장 전까지 원본 데이터는 유지됩니다.','success');});$('#saveScoreButton').addEventListener('click',saveLightingScore);
function resetAnalyzedPlayback(time=0){
  if(!analyzedTrack)return;analyzedBeatCursor=0;while(analyzedBeatCursor<analyzedTrack.beatTimes.length&&analyzedTrack.beatTimes[analyzedBeatCursor]<time-.08)analyzedBeatCursor++;analyzedEnvelopeCursor=-1;phase=0;if(['beat','beat-brightness','entertainment'].includes(musicStyle))for(let index=0;index<analyzedBeatCursor;index++){const strength=analyzedTrack.cueStrengths?.[index]??1;phase=(phase+(strength>=.68?3:strength>=.4?2:1))%placementColors.length;}beatCount=0;lastMusicCommandAt=0;lastScheduledMusicBeat=-Infinity;equalizerLastLevel=-1;equalizerLastSentAt=0;equalizerColorDirty=true;entertainmentLastFrameAt=0;entertainmentAccentBucket=-1;entertainmentFlashUntil=0;$('#beatCount').textContent='0';$('#commandInterval').textContent='—';const slotCount=entertainmentPairCount();if(!analyzedTrack.mediaArt||analyzedTrack.mediaArt.slotCount!==slotCount)analyzedTrack.mediaArt=HueMediaArt.compile({...analyzedTrack,slotCount});renderVirtualLights(HueMediaArt.sample(analyzedTrack.mediaArt,time),time);drawAnalyzedTimeline(time);
}
function stopPlaybackLoop(){clearTimeout(playbackTimer);playbackTimer=null;}
async function startAnalyzedPlayback(){
  if(!analyzedTrack)return;const player=$('#audioPlayer'),previewOnly=$('#analysisPreviewOnly').checked;stopCalibration(true);if(!previewOnly&&musicStyle==='beat'&&!musicScenesReady){player.pause();try{await prepareMusicScenes();await player.play();}catch(error){setMessage(`공통 Scene 준비 실패: ${error.message}`,'error');}return;}if(!previewOnly&&musicStyle==='beat-brightness'&&!musicGroupsReady){player.pause();try{await prepareAnalyzedMusicGroups();await player.play();}catch(error){setMessage(`음악 그룹 준비 실패: ${error.message}`,'error');}return;}if(!previewOnly&&musicStyle==='entertainment'&&!entertainmentActive){player.pause();try{await startEntertainment();await player.play();}catch(error){setMessage(`Entertainment 준비 실패: ${error.message}`,'error');}return;}stopShowTest(true);if(activeStream){activeStream.getTracks().forEach(track=>track.stop());activeStream=null;}resetAnalyzedPlayback(player.currentTime);stopPlaybackLoop();if(previewOnly)setMessage('분석 미리보기 재생 중 · Hue Bridge와 전구에는 명령을 보내지 않습니다.','success');
  const tick=()=>{if(player.paused||player.ended){animationFrame=null;return;}const current=player.currentTime,scheduled=current+totalSyncMs()/1000;
    const previousBeatCursor=analyzedBeatCursor;while(analyzedBeatCursor<analyzedTrack.beatTimes.length&&analyzedTrack.beatTimes[analyzedBeatCursor]<=scheduled)analyzedBeatCursor++;if(previewOnly&&analyzedBeatCursor!==previousBeatCursor){beatCount+=analyzedBeatCursor-previousBeatCursor;$('#beatCount').textContent=beatCount;}
    const slotCount=entertainmentPairCount();if(!analyzedTrack.mediaArt||analyzedTrack.mediaArt.slotCount!==slotCount)analyzedTrack.mediaArt=HueMediaArt.compile({...analyzedTrack,slotCount});const entertainmentFrame=HueMediaArt.sample(analyzedTrack.mediaArt,scheduled);if(entertainmentFrame)renderVirtualLights(entertainmentFrame,scheduled);
    if(previewOnly&&entertainmentFrame)$('#mediaArtState').textContent=`웹 모의 전구 · ${HueShowScore.TYPE_LABELS[entertainmentFrame.mode]||entertainmentFrame.mode} · ${HueShowScore.PRESET_LABELS[entertainmentFrame.preset]||entertainmentFrame.preset}`;
    if(musicStyle==='equalizer'){const group=selectedEqualizerGroup(),max=group?.lightIds.filter(id=>connectedLightIds().includes(id)).length||0,index=Math.max(0,Math.min(analyzedTrack.envelope.length-1,Math.floor(scheduled/analyzedTrack.envelopeStep))),now=performance.now();if(index!==analyzedEnvelopeCursor&&!commandBusy&&now-equalizerLastSentAt>=MUSIC_COMMAND_INTERVAL_MS){analyzedEnvelopeCursor=index;const level=Math.round((analyzedTrack.envelope[index]||0)*max);applyEqualizerLevel(level).then(applied=>{if(applied){equalizerLastSentAt=performance.now();beatCount++;$('#beatCount').textContent=beatCount;}}).catch(error=>setMessage(error.message,'error'));}}
    if(!previewOnly&&musicStyle==='entertainment'){
      const frame=entertainmentFrame,index=Math.floor(scheduled/analyzedTrack.mediaArt.step);
      if(frame&&index!==analyzedEnvelopeCursor&&!entertainmentFrameBusy){
        sendEntertainmentFrame(0,false,false,null,false,frame).then(sent=>{if(sent){analyzedEnvelopeCursor=index;if(frame.hit){beatCount++;$('#beatCount').textContent=beatCount;}}}).catch(error=>{setMessage(error.message,'error');player.pause();});
        $('#mediaArtState').textContent=`${HueShowScore.TYPE_LABELS[frame.mode]||frame.mode} · ${HueShowScore.PRESET_LABELS[frame.preset]||frame.preset}`;
      }
    }
    drawAnalyzedTimeline(current);playbackTimer=setTimeout(tick,16);
  };tick();
}
async function prepareAnalyzedMusicGroups(){const commands=musicStyle==='beat-brightness'?buildBrightnessBeatCommands(phase,.7,false):buildBeatCommands(false);if(!commands.length)throw new Error('연결된 전구가 들어 있는 음악 그룹이 없습니다.');const result=await api('/api/control/grouped-music/prepare',{method:'POST',body:JSON.stringify({commands})});musicGroupsReady=true;return result;}
function analyzedTrackSummary(analysis){
  const cues=analysis?.beatTimes?.length||0,mode=analysis?.analysisMode==='layered-show'?'레이어형 공연 연출':analysis?.analysisMode==='adaptive-reactive-field'?'오디오 반응형 전체 필드':analysis?.analysisMode==='phrase-score-multiband'?'프레이즈·3대역 악보':analysis?.analysisMode==='beatgrid-bass-onset'?'Beatgrid·저음 분석':analysis?.analysisMode==='continuous-bass-onset'?'연속 저음 타격 분석':analysis?.analysisMode==='adaptive-bass-onset'?'저음 타격 중심 분석':analysis?.analysisMode==='adaptive-local-onset'?'구간별 타격 분석':analysis?.analysisMode==='adaptive-onset'?'가변 타격 분석':'기존 박자 분석';
  return `${analysis?.bpm||'—'} BPM 참고 · ${formatDuration(analysis?.duration)} · 조명 타격점 ${cues}개 · ${mode}`;
}
function renderTrackLibrary(){
  $('#trackCount').textContent=`${savedTracks.length}곡`;
  $('#trackPlaylist').innerHTML=savedTracks.length?savedTracks.map(track=>`<article class="track-row ${track.id===activeTrackId?'active':''}" data-track-id="${track.id}"><div class="track-copy"><strong title="${escapeHtml(track.fileName)}">${escapeHtml(track.fileName)}</strong><span>${escapeHtml(analyzedTrackSummary(track.analysis))}</span></div><button class="track-play" data-track-play="${track.id}">${track.id===activeTrackId&&!$('#audioPlayer').paused?'일시정지':'재생'}</button><button class="track-delete" data-track-delete="${track.id}" aria-label="${escapeHtml(track.fileName)} 삭제">삭제</button></article>`).join(''):'<div class="empty">저장된 음악이 없습니다. 위에서 음원 파일을 분석해 주세요.</div>';
}
async function loadTrackLibrary(){savedTracks=await api('/api/tracks');renderTrackLibrary();}
async function upgradeSavedTrackAnalysis(track){
  const slotCount=entertainmentPairCount();if(Number(track.analysis?.version||0)>=10&&Array.isArray(track.analysis?.spectralFluxEnvelope)&&track.analysis?.mediaArt?.version===8&&track.analysis.mediaArt.slotCount===slotCount&&track.analysis?.lightingScore?.version===2)return track;
  if(Number(track.analysis?.version||0)>=9&&Array.isArray(track.analysis?.midEnvelope)){
    const analysis={...track.analysis,version:10,analysisMode:'layered-show'};analysis.spectralFluxEnvelope=analysis.spectralFluxEnvelope||deriveSpectralFluxEnvelope(analysis);analysis.lightingScore=analysis.lightingScore?.version===2?analysis.lightingScore:HueShowScore.compile({...analysis,lightingScore:null});analysis.mediaArt=HueMediaArt.compile({...analysis,slotCount});const updated=await api(`/api/tracks/${encodeURIComponent(track.id)}/analysis`,{method:'PUT',body:JSON.stringify(analysis)});savedTracks=savedTracks.map(item=>item.id===updated.id?updated:item);return updated;
  }
  const panel=$('#trackAnalysis');panel.hidden=false;$('#analysisState').className='analysis-state';$('#analysisState').textContent='재분석 중';$('#analysisTrackName').textContent=track.fileName;$('#analysisSummary').textContent='음량·저음 타격과 연출 순서를 분석하고 있습니다.';setMessage('저장된 음원을 개선된 기준으로 한 번만 다시 분석합니다.');
  await ensureAudio();const response=await fetch(`/api/tracks/${encodeURIComponent(track.id)}/audio`);if(!response.ok)throw new Error('저장된 음원 파일을 읽지 못했습니다.');const raw=await response.arrayBuffer(),decoded=await audioContext.decodeAudioData(raw),analysis=await analyzeAudioBuffer(decoded,progress=>{$('#analysisSummary').textContent=`${progress}% · 음량·저음 타격과 연출 순서를 분석하고 있습니다.`;});const updated=await api(`/api/tracks/${encodeURIComponent(track.id)}/analysis`,{method:'PUT',body:JSON.stringify(analysis)});savedTracks=savedTracks.map(item=>item.id===updated.id?updated:item);return updated;
}
async function selectSavedTrack(track,autoplay=false){
  const panel=$('#trackAnalysis'),player=$('#audioPlayer');stopShowTest(true);player.pause();resetAnalysis();track=await upgradeSavedTrackAnalysis(track);analyzedTrack=track.analysis;activeTrackId=track.id;panel.hidden=false;player.hidden=false;$('#analysisState').className='analysis-state ready';$('#analysisState').textContent='분석 완료';$('#analysisTrackName').textContent=track.fileName;$('#analysisSummary').textContent=analyzedTrackSummary(analyzedTrack);$('#bpmValue').textContent=analyzedTrack.bpm||'—';player.src=`/api/tracks/${encodeURIComponent(track.id)}/audio`;player.load();renderScoreEditor();resetAnalyzedPlayback(0);renderTrackLibrary();if(autoplay)await player.play();
}
async function saveAnalyzedTrack(file,analysis){const form=new FormData();form.append('audio',file,file.name);form.append('analysis',JSON.stringify(analysis));return api('/api/tracks',{method:'POST',body:form});}
$('#trackPlaylist').addEventListener('click',async event=>{
  const play=event.target.closest('[data-track-play]'),remove=event.target.closest('[data-track-delete]');
  if(play){const track=savedTracks.find(item=>item.id===play.dataset.trackPlay);if(!track)return;const player=$('#audioPlayer');try{if(activeTrackId===track.id&&!player.paused){player.pause();renderTrackLibrary();}else await selectSavedTrack(track,true);}catch(error){setMessage(`음원을 재생하지 못했습니다: ${error.message}`,'error');}return;}
  if(remove){const track=savedTracks.find(item=>item.id===remove.dataset.trackDelete);if(!track||!confirm(`재생목록에서 “${track.fileName}”을 삭제할까요?`))return;try{if(activeTrackId===track.id){const player=$('#audioPlayer');player.pause();player.removeAttribute('src');player.load();analyzedTrack=null;activeTrackId=null;$('#trackAnalysis').hidden=true;}await api(`/api/tracks/${encodeURIComponent(track.id)}`,{method:'DELETE'});await loadTrackLibrary();setMessage('음원과 분석 데이터를 재생목록에서 삭제했습니다.','success');}catch(error){setMessage(error.message,'error');}
  }
});
$('#audioFile').addEventListener('change',async event=>{
  const file=event.target.files[0];if(!file)return;const panel=$('#trackAnalysis'),player=$('#audioPlayer');stopShowTest(true);player.pause();resetAnalysis();analyzedTrack=null;activeTrackId=null;renderTrackLibrary();panel.hidden=false;player.hidden=true;$('#analysisState').className='analysis-state';$('#analysisState').textContent='분석 중';$('#analysisTrackName').textContent=file.name;$('#analysisSummary').textContent='0% · 곡 전체에서 실제 타격과 구간별 강도를 읽고 있습니다.';setMessage('음원을 분석하고 있습니다. 완료되면 재생목록에 저장됩니다.');
  try{
    await ensureAudio();const raw=await file.arrayBuffer(),decoded=await audioContext.decodeAudioData(raw),analysis=await analyzeAudioBuffer(decoded,progress=>{$('#analysisSummary').textContent=`${progress}% · 실제 타격과 구간별 강도를 읽고 있습니다.`;});
    $('#analysisState').textContent='저장 중';$('#analysisSummary').textContent=analyzedTrackSummary(analysis);setMessage('분석이 끝났습니다. 음원과 분석 데이터를 재생목록에 저장하고 있습니다.');
    const saved=await saveAnalyzedTrack(file,analysis);await loadTrackLibrary();const stored=savedTracks.find(track=>track.id===saved.id)||saved;await selectSavedTrack(stored,false);
    try{if(musicStyle==='beat')await prepareMusicScenes();else if(['beat-brightness','equalizer'].includes(musicStyle))await prepareAnalyzedMusicGroups();}catch(error){setMessage(`음원은 저장됐지만 브리지 준비에 실패했습니다: ${error.message}`,'error');event.target.value='';return;}
    setMessage(`분석·저장 완료 · ${analysis.bpm} BPM 참고 · 조명 타격점 ${analysis.beatTimes.length}개 · 재생을 누르면 연출이 시작됩니다.`,'success');
  }
  catch(error){analyzedTrack=null;activeTrackId=null;$('#analysisState').textContent='분석 실패';$('#analysisSummary').textContent=error.message;setMessage(`음원 분석 또는 저장에 실패했습니다: ${error.message}`,'error');}
  finally{event.target.value='';renderTrackLibrary();}
});
$('#audioPlayer').addEventListener('play',()=>{renderTrackLibrary();startAnalyzedPlayback();});
$('#audioPlayer').addEventListener('pause',()=>{stopPlaybackLoop();renderTrackLibrary();if(analyzedTrack)drawAnalyzedTimeline($('#audioPlayer').currentTime);});
$('#audioPlayer').addEventListener('seeked',()=>{if(analyzedTrack)resetAnalyzedPlayback($('#audioPlayer').currentTime);});
$('#audioPlayer').addEventListener('ended',()=>{stopPlaybackLoop();renderTrackLibrary();setMessage($('#analysisPreviewOnly').checked?'음원 분석 미리보기가 끝났습니다.':'음원 재생과 조명 연출이 끝났습니다.','success');});
async function setPreviewOnly(enabled,source){
  $('#analysisPreviewOnly').checked=enabled;$('#simulatorPreviewOnly').checked=enabled;localStorage.setItem('hue-analysis-preview-only',String(enabled));const player=$('#audioPlayer');if(showTestTimer)stopShowTest(true);if(enabled&&entertainmentActive){try{await stopEntertainment(true);}catch{}}if(source==='analysis'&&!player.paused){stopPlaybackLoop();resetAnalyzedPlayback(player.currentTime);startAnalyzedPlayback();}setMessage(enabled?'웹 모의 전구 모드입니다. 실제 Hue에는 명령을 보내지 않습니다.':'실제 Entertainment 전구 제어 모드입니다.',enabled?'success':'');
}
$('#analysisPreviewOnly').addEventListener('change',event=>setPreviewOnly(event.target.checked,'analysis'));
$('#simulatorPreviewOnly').addEventListener('change',event=>setPreviewOnly(event.target.checked,'simulator'));
$('#microphoneButton').addEventListener('click',async()=>{try{stopShowTest(true);$('#audioPlayer').pause();resetAnalysis();if(musicStyle==='entertainment'&&!entertainmentActive)await startEntertainment();await ensureAudio();activeStream=await navigator.mediaDevices.getUserMedia({audio:true});sourceNode=audioContext.createMediaStreamSource(activeStream);sourceNode.connect(analyser);if(musicStyle==='equalizer')await applyEqualizerLevel(0,true);startAnalysis();setMessage('마이크 실시간 분석을 시작했습니다. 파일 연출보다 박자 정확도는 낮습니다.','success');}catch(error){setMessage(`마이크를 시작하지 못했습니다: ${error.message}`,'error');}});
$('#stopButton').addEventListener('click',()=>{stopCalibration(true);const player=$('#audioPlayer');player.pause();player.currentTime=0;resetAnalysis();if(analyzedTrack){$('#bpmValue').textContent=analyzedTrack.bpm;resetAnalyzedPlayback(0);}setMessage('재생과 실시간 분석을 중지했습니다.');});

async function bootstrap(){
  let stored=null,settingsEndpointAvailable=true;
  try{const response=await api('/api/controller-settings');if(response.exists&&response.settings){stored=response.settings;applyStoredControllerSettings(stored);}}
  catch(error){settingsEndpointAvailable=false;console.error('제어 설정 불러오기 실패',error);}
  const previewSetting=localStorage.getItem('hue-analysis-preview-only'),previewOnly=previewSetting===null?true:previewSetting==='true';$('#analysisPreviewOnly').checked=previewOnly;$('#simulatorPreviewOnly').checked=previewOnly;updateMasterControls();renderAllGroups();applyStoredControls(stored?.controls);setMusicStyle(musicStyle);ensureVirtualLights();controllerSettingsReady=settingsEndpointAvailable;
  if(settingsEndpointAvailable&&!stored){try{await saveControllerSettingsNow();setMessage('현재 그룹과 전구 순서를 폴더 설정 파일에 저장했습니다.','success');}catch(error){setMessage(error.message,'error');}}
  api('/api/entertainment/stop',{method:'POST'}).catch(()=>{});
  try{await loadTrackLibrary();}catch(error){setMessage(`저장된 음악을 불러오지 못했습니다: ${error.message}`,'error');}
  try{await loadStatus();await loadLights(true);}catch(error){setMessage(error.message,'error');}
}
bootstrap();
