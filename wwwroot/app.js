const $ = selector => document.querySelector(selector);
const escapeHtml = value => String(value ?? '').replace(/[&<>"]/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[char]));
const defaultColors = ['#ff416c','#19d3c5','#587dff','#ffc857','#a855f7','#ff7a00','#44d17a','#f05cff'];
const placementColors = ['#ff3131','#ff8a00','#ffd60a','#25d366','#1687ff','#3f37c9','#a855f7','#ff2d9a'];
const placementColorNames = ['빨강','주황','노랑','초록','파랑','남색','보라','핑크'];
const legacyMusicGroups = ['A','B','C','D','E'];
const MUSIC_COMMAND_INTERVAL_MS = 1000, ENTERTAINMENT_FRAME_INTERVAL_MS = 100;
const storedMusicStyle=localStorage.getItem('hue-music-style');
let lights = [], phase = 0, commandBusy = false, musicStyle = ['beat-brightness','equalizer','entertainment'].includes(storedMusicStyle) ? storedMusicStyle : 'beat';
let audioContext, analyser, sourceNode, playerSourceNode, activeStream, animationFrame;
let playbackTimer;
let lastBeatAt = 0, beatTimes = [], energyHistory = [], beatCount = 0;
let analyzedTrack = null, audioObjectUrl = null, analyzedBeatCursor = 0, analyzedEnvelopeCursor = -1;
let savedTracks = [], activeTrackId = null;
let lastMusicCommandAt = 0, lastScheduledMusicBeat = -Infinity;
let musicScenesReady = false, musicGroupsReady = false;
let entertainmentActive=false,entertainmentFrameBusy=false,entertainmentLastFrameAt=0,entertainmentSelectedId='',entertainmentConfigurations=[],entertainmentAccentBucket=-1,entertainmentFlashUntil=0;
let showTestTimer, showTestFadeTimer, showTestStep = 0, equalizerLastLevel = -1, equalizerLastSentAt = 0;
let equalizerSamples = [], equalizerCalibrationStartedAt = 0, equalizerHoldUntil = 0, equalizerColorDirty = false;
let masterTimer, lightTimer, modalHsv = {h:0,s:0,v:1}, modalConfirm, wheelImage;
let editingGroup = null, groupDraft = null, renamingLightId = null;
let controllerSettingsReady = false, controllerSettingsSaveTimer;

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
  if (!result.music.length) result.music.push(makeGroup('music',0));
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
      manualTransition:Number($('#manualTransition')?.value||80),testBpm:Number($('#testBpm')?.value||60),beatBrightness:Number($('#beatBrightness')?.value||100),transition:Number($('#transition')?.value||80),syncOffset:Number($('#syncOffset')?.value||120),sensitivity:Number($('#sensitivity')?.value||1.45),minInterval:Number($('#minInterval')?.value||260),equalizerGroup:$('#equalizerGroup')?.value||'',entertainmentConfigurationId:$('#entertainmentConfiguration')?.value||entertainmentSelectedId||'',entertainmentAccentInterval:Number($('#entertainmentAccentInterval')?.value||500),entertainmentPunch:Number($('#entertainmentPunch')?.value||100)
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
  musicStyle=['beat-brightness','equalizer','entertainment'].includes(settings?.musicStyle)?settings.musicStyle:'beat';localStorage.setItem('hue-mode-groups-v1',JSON.stringify(groupState));localStorage.setItem('hue-manual-settings',JSON.stringify(manual));localStorage.setItem('hue-music-style',musicStyle);
}
function applyStoredControls(controls={}){
  const values={manualTransition:controls.manualTransition,testBpm:controls.testBpm,beatBrightness:controls.beatBrightness,transition:controls.transition,syncOffset:controls.syncOffset,sensitivity:controls.sensitivity,minInterval:controls.minInterval,entertainmentAccentInterval:controls.entertainmentAccentInterval,entertainmentPunch:controls.entertainmentPunch};
  Object.entries(values).forEach(([id,value])=>{const input=document.getElementById(id);if(input&&value!==undefined){input.value=id==='testBpm'?Math.min(60,Math.max(30,Number(value)||60)):value;input.dispatchEvent(new Event('input'));}});
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
    <span class="light-order-actions"><button type="button" data-light-order-offset="-1" ${index===0?'disabled':''} aria-label="${escapeHtml(light.name)} 앞으로 이동">↑</button><button type="button" data-light-order-offset="1" ${index===count-1?'disabled':''} aria-label="${escapeHtml(light.name)} 뒤로 이동">↓</button><button type="button" data-remove-light="${light.id}" data-remove-mode="${mode}" data-remove-group="${groupId}" aria-label="${escapeHtml(light.name)} 그룹에서 제거">×</button></span>
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
      <div class="group-card-actions">${modeActions}<button data-group-settings>그룹 설정</button><button data-delete-group class="danger">삭제</button></div>
    </article>`;
  }).join('') : '<div class="empty">그룹이 없습니다. 위의 그룹 추가 버튼을 눌러주세요.</div>';
  bindGroupInteractions(mode);
  renderEqualizerGroupOptions();
}
function bindGroupInteractions(mode) {
  const container = $(`#${mode}Groups`), pool = $(`#${mode}Unassigned`);
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
function renderAllGroups() { renderGroupManager('normal'); renderGroupManager('music'); renderEqualizerGroupOptions(); }
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
  $('#lightsGrid').innerHTML = lights.map(light => {
    manual.lightBrightness[light.id] ??= Math.round(light.brightness || 100);
    manual.lightColors[light.id] ??= '#ffffff';
    const reachable = light.connectivity === 'connected' || light.connectivity === 'unknown';
    const statusClass = light.connectivity === 'connected' ? '' : light.connectivity === 'unknown' ? 'unknown' : 'offline';
    const normalGroup = groupForLight('normal',light.id), musicGroup = groupForLight('music',light.id);
    return `<article class="light-item ${light.on ? '' : 'off'} ${reachable ? '' : 'unreachable'}">
      <div class="light-heading"><span class="lamp"></span><div><div class="light-name-row"><div class="light-name">${escapeHtml(light.name)}</div><button class="rename-light-button" data-rename-light="${light.id}">이름 변경</button></div><div class="light-id">${escapeHtml(light.id)}</div><span class="light-status ${statusClass}">${escapeHtml(light.connectivity)}</span></div></div>
      <div class="membership-row"><span>일반 · ${escapeHtml(normalGroup?.name || '미배정')}</span><span>음악 · ${escapeHtml(musicGroup?.name || '미배정')}</span></div>
      <label class="light-slider">개별 밝기 <output data-light-brightness-output="${light.id}">${manual.lightBrightness[light.id]}%</output><input data-light-brightness="${light.id}" type="range" min="1" max="100" value="${manual.lightBrightness[light.id]}" ${reachable ? '' : 'disabled'}></label>
      <button class="color-button light-color-button" data-edit-light-color="${light.id}" ${reachable ? '' : 'disabled'}><span class="color-swatch" style="background:${manual.lightColors[light.id]}"></span><span><small>개별 RGB</small><strong>${manual.lightColors[light.id].toUpperCase()}</strong></span></button>
      <div class="light-actions"><button data-light-action="on" data-light-id="${light.id}" ${reachable ? '' : 'disabled'}>켜기</button><button class="test" data-light-action="test" data-light-id="${light.id}" ${reachable ? '' : 'disabled'}>식별 테스트</button><button data-light-action="off" data-light-id="${light.id}" ${reachable ? '' : 'disabled'}>끄기</button></div>
    </article>`;
  }).join('');
  saveManual();
  document.querySelectorAll('[data-light-action]').forEach(button => button.addEventListener('click',() => controlSingleLight(button)));
  document.querySelectorAll('[data-edit-light-color]').forEach(button => button.addEventListener('click',() => editLightColor(button.dataset.editLightColor)));
  document.querySelectorAll('[data-rename-light]').forEach(button => button.addEventListener('click',() => openRenameLight(button.dataset.renameLight)));
  document.querySelectorAll('[data-light-brightness]').forEach(slider => {
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
function entertainmentMusicGroups(){return activeMusicGroups().slice(0,2).map(group=>({...group,lightIds:group.lightIds.slice(0,5)}));}
function validateEntertainmentGroups(){const groups=entertainmentMusicGroups(),ids=groups.flatMap(group=>group.lightIds);if(groups.length<2||groups.some(group=>group.lightIds.length!==5))throw new Error('음악 그룹 A와 B에 연결된 전구가 각각 5개 이상 필요합니다.');if(new Set(ids).size!==10)throw new Error('Entertainment 테스트에는 서로 다른 전구 10개가 필요합니다.');return groups;}
function updateEntertainmentMapping(){const groups=entertainmentMusicGroups(),names=groups.map(group=>`${group.name} ${group.lightIds.length}/5`).join(' · ');$('#entertainmentMapping').textContent=names?`${names} · 각 그룹 정렬의 앞 5개를 사용합니다.`:'A/B 그룹의 앞 5개 전구씩, 총 10개를 사용합니다.';}
async function loadEntertainmentConfigurations(){
  $('#entertainmentConfiguration').innerHTML='<option value="">불러오는 중…</option>';const configurations=await api('/api/entertainment/configurations');entertainmentConfigurations=Array.isArray(configurations)?configurations:[];$('#entertainmentConfiguration').innerHTML=entertainmentConfigurations.length?entertainmentConfigurations.map(item=>`<option value="${item.id}">${escapeHtml(item.name)} · ${item.channelCount}채널</option>`).join(''):'<option value="">Hue 앱에서 영역을 먼저 만들어 주세요</option>';if(entertainmentSelectedId&&entertainmentConfigurations.some(item=>item.id===entertainmentSelectedId))$('#entertainmentConfiguration').value=entertainmentSelectedId;else entertainmentSelectedId=$('#entertainmentConfiguration').value||'';queueControllerSettingsSave();return entertainmentConfigurations;
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
  const now=performance.now();if(!entertainmentActive||entertainmentFrameBusy||(!force&&now-entertainmentLastFrameAt<ENTERTAINMENT_FRAME_INTERVAL_MS))return false;const previousFrameAt=entertainmentLastFrameAt;entertainmentFrameBusy=true;try{const result=await api('/api/entertainment/frame',{method:'POST',body:JSON.stringify({commands:artFrame?buildMediaArtCommands(artFrame):buildEntertainmentCommands(phase,intensity,turnOff,transitionOverride,punch),scheduleAheadMs:0})});if(result.ignoredLightIds?.length)throw new Error(`${result.ignoredLightIds.length}개 전구가 선택한 Entertainment 영역에 없습니다.`);entertainmentLastFrameAt=performance.now();if(previousFrameAt)$('#commandInterval').textContent=`${Math.round(entertainmentLastFrameAt-previousFrameAt)}ms`;return true;}finally{entertainmentFrameBusy=false;}
}
function buildMediaArtCommands(frame){
  const groups=validateEntertainmentGroups(),master=Number($('#beatBrightness').value)/100,palette=['#668bff','#23c9bd','#ae62ff','#ff8c40','#ff4e85','#70dfff'];
  const limit=Math.min(...groups.map(group=>group.brightness))*master,punch=Number($('#entertainmentPunch').value)/100;
  return groups.flatMap(group=>group.lightIds.map((id,index)=>({
    lightIds:[id],hexColor:palette[frame.color%palette.length],on:frame.weights[index]>.001,
    brightness:frame.weights[index]*(frame.bloom?100*master*punch:limit),
    transitionMs:frame.bloom?0:frame.hit?60:100
  })));
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
      mediaArtDemo=HueMediaArt.compile({duration:40,envelope,envelopeStep:.1,beatTimes:Array.from({length:70},(_,i)=>i*.5+3)});
    }
    const time=((performance.now()-mediaArtDemoStarted)/1000)%40,frame=HueMediaArt.sample(mediaArtDemo,time);
    await sendEntertainmentFrame(0,false,false,null,false,frame);
    $('#mediaArtState').textContent='40초 예시 · '+({intro:'한 점',travel:'이동',build:'쌓임',highlight:'펼침'})[frame.mode];
    return;
  }
  playTestClick(showTestStep%4).catch(()=>{});
  if(musicStyle==='beat')await triggerBeat(false);else if(musicStyle==='beat-brightness')await triggerBrightnessBeat([.25,.55,1,.45][showTestStep%4],showTestStep%4===0?1:.5,true);else if(musicStyle==='entertainment'){phase=(phase+(showTestStep%4===0?2:1))%placementColors.length;beatCount++;$('#beatCount').textContent=beatCount;const punch=Number($('#entertainmentPunch').value)/100;await sendEntertainmentFrame(punch,true,false,0,true);clearTimeout(showTestFadeTimer);showTestFadeTimer=setTimeout(()=>sendEntertainmentFrame(.28,true,false,80).catch(error=>setMessage(error.message,'error')),150);}else{const group=selectedEqualizerGroup(),max=group?.lightIds.length||0;if(!max)return;const cycle=max===1?1:max*2-2,position=showTestStep%cycle,level=position<max?position+1:max*2-1-position;phase=(phase+1)%placementColors.length;equalizerColorDirty=true;beatCount++;$('#beatCount').textContent=beatCount;await applyEqualizerLevel(level,true);}
  showTestStep++;
}
function stopShowTest(silent=false){clearTimeout(showTestFadeTimer);showTestFadeTimer=null;if(!showTestTimer)return;clearInterval(showTestTimer);showTestTimer=null;$('#startShowTestButton').disabled=false;$('#stopShowTestButton').disabled=true;if(!silent)setMessage('연출 테스트를 정지했습니다.');}
async function startShowTest(){
  if(musicStyle==='beat'&&!buildBeatCommands().length){setMessage('연결된 전구가 들어 있는 음악 그룹이 없습니다.','error');return;}
  if(musicStyle==='beat-brightness'&&!buildBrightnessBeatCommands().length){setMessage('연결된 전구가 들어 있는 음악 그룹이 없습니다.','error');return;}
  if(musicStyle==='equalizer'&&!buildEqualizerCommands(1).length){setMessage('연결된 전구가 들어 있는 이퀄라이저 대상 그룹을 선택하세요.','error');return;}
  if(musicStyle==='beat'){try{await prepareMusicScenes();}catch(error){setMessage(`공통 Scene 준비 실패: ${error.message}`,'error');return;}}
  if(musicStyle==='beat-brightness'){try{await prepareAnalyzedMusicGroups();}catch(error){setMessage(`음악 그룹 준비 실패: ${error.message}`,'error');return;}}
  if(musicStyle==='entertainment'){try{validateEntertainmentGroups();if(!entertainmentActive)await startEntertainment();}catch(error){setMessage(`Entertainment 준비 실패: ${error.message}`,'error');return;}}
  stopShowTest(true);resetAnalysis();$('#audioPlayer').pause();phase=0;showTestStep=0;mediaArtDemoStarted=performance.now();$('#startShowTestButton').disabled=true;$('#stopShowTestButton').disabled=false;
  const bpm=Math.min(60,Number($('#testBpm').value)),interval=musicStyle==='entertainment'?100:Math.max(MUSIC_COMMAND_INTERVAL_MS,60000/bpm),groups=activeMusicGroups(),lightCount=groups.reduce((sum,group)=>sum+group.lightIds.length,0),label=musicStyle==='beat'?`일반 음악 연출 테스트 시작 · ${groups.length}개 그룹 · ${lightCount}개 전구`:musicStyle==='beat-brightness'?`일반+밝기 연출 테스트 시작 · ${groups.length}개 그룹 · ${lightCount}개 전구`:musicStyle==='entertainment'?'미디어아트 40초 반복 테스트 시작':'이퀄라이저 연출 테스트 시작';setMessage(musicStyle==='entertainment'?label:`${label} · ${bpm} BPM`,'success');await runShowTestStep();showTestTimer=setInterval(runShowTestStep,interval);
}
function setMusicStyle(style){
  const previous=musicStyle;stopShowTest(true);musicStyle=['beat-brightness','equalizer','entertainment'].includes(style)?style:'beat';if(previous==='entertainment'&&musicStyle!=='entertainment'&&entertainmentActive)stopEntertainment(true).catch(()=>{});localStorage.setItem('hue-music-style',musicStyle);queueControllerSettingsSave();equalizerLastLevel=-1;$('#equalizerLevel').textContent='0';
  document.querySelectorAll('[data-music-style]').forEach(button=>{const active=button.dataset.musicStyle===musicStyle;button.classList.toggle('active',active);button.setAttribute('aria-selected',String(active));});
  $('#equalizerGroupField').hidden=musicStyle!=='equalizer';$('#entertainmentControls').hidden=musicStyle!=='entertainment';$('#musicStyleDescription').textContent=musicStyle==='beat'?'고정 BPM 대신 실제 강한 타격을 고르고, 약한 구간은 뜸하게·강한 구간은 최대 1초마다 공통 Scene을 바꿉니다.':musicStyle==='beat-brightness'?'일반 API로 A/B 그룹의 색상과 분석된 음량 밝기를 최대 1초마다 함께 보냅니다. 일반 음악과 동기화 차이를 비교하는 테스트입니다.':musicStyle==='equalizer'?'분석된 음량 곡선을 1초 간격으로 반영해 01번부터 점등 개수를 바꿉니다.':'양쪽 같은 번호가 같은 색으로 움직입니다. 한 점 → 이동 → 쌓임 → 전체 펼침으로 진행하며 구간이 바뀔 때 색을 바꿉니다.';updateEntertainmentMapping();if(musicStyle==='entertainment'&&!entertainmentConfigurations.length)loadEntertainmentConfigurations().catch(error=>setMessage(error.message,'error'));
}
document.querySelectorAll('[data-music-style]').forEach(button=>button.addEventListener('click',()=>setMusicStyle(button.dataset.musicStyle)));
$('#equalizerGroup').addEventListener('change',()=>{equalizerLastLevel=-1;$('#equalizerLevel').textContent='0';queueControllerSettingsSave();});
$('#refreshEntertainmentButton').addEventListener('click',()=>loadEntertainmentConfigurations().then(()=>setMessage('Entertainment 영역을 새로 불러왔습니다.','success')).catch(error=>setMessage(error.message,'error')));
$('#entertainmentConfiguration').addEventListener('change',event=>{entertainmentSelectedId=event.target.value;queueControllerSettingsSave();});
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
document.addEventListener('keydown',event=>{if(event.key!=='Escape')return;if(!$('#colorModal').hidden)closeColorModal();else if(!$('#groupSettingsModal').hidden)closeGroupSettings();else if(!$('#renameLightModal').hidden)closeRenameLight();});

function bindRange(id,outputId,suffix=''){const input=$(id),output=$(outputId),update=()=>output.textContent=`${input.value}${suffix}`;input.addEventListener('input',update);update();}
bindRange('#manualTransition','#manualTransitionValue',' ms');bindRange('#beatBrightness','#beatBrightnessValue','%');bindRange('#transition','#transitionValue',' ms');bindRange('#testBpm','#testBpmValue',' BPM');bindRange('#sensitivity','#sensitivityValue');bindRange('#minInterval','#intervalValue',' ms');bindRange('#syncOffset','#syncOffsetValue',' ms 빠르게');bindRange('#entertainmentAccentInterval','#entertainmentAccentIntervalValue',' ms');bindRange('#entertainmentPunch','#entertainmentPunchValue','%');
['manualTransition','beatBrightness','transition','testBpm','syncOffset','sensitivity','minInterval','entertainmentAccentInterval','entertainmentPunch'].forEach(id=>document.getElementById(id).addEventListener('change',queueControllerSettingsSave));
$('#beatBrightness').addEventListener('change',()=>musicScenesReady=false);
document.querySelectorAll('[data-zero-transition]').forEach(button=>button.addEventListener('click',()=>{const slider=document.getElementById(button.dataset.zeroTransition);slider.value=0;slider.dispatchEvent(new Event('input'));setMessage('전환 시간을 0ms로 설정했습니다. 실제 통신 지연은 별도로 발생할 수 있습니다.','success');}));

async function ensureAudio(){audioContext||=new AudioContext();if(audioContext.state==='suspended')await audioContext.resume();analyser||=new AnalyserNode(audioContext,{fftSize:2048,smoothingTimeConstant:.55});}
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
async function analyzeAudioBuffer(buffer,onProgress=()=>{}){
  const frameSeconds=.02,hop=Math.max(1,Math.round(buffer.sampleRate*frameSeconds)),windowSize=hop*2,frameCount=Math.max(1,Math.floor((buffer.length-windowSize)/hop)),channels=Array.from({length:buffer.numberOfChannels},(_,index)=>buffer.getChannelData(index)),energies=new Float32Array(frameCount),bassEnergy=new Float32Array(frameCount);let low=0;const lowAlpha=1-Math.exp(-2*Math.PI*180/(buffer.sampleRate/2));
  for(let frame=0;frame<frameCount;frame++){
    const start=frame*hop;let sum=0,bassSum=0,count=0;low=0;
    for(let sample=0;sample<windowSize;sample+=2){let mixed=0;for(const channel of channels)mixed+=channel[start+sample]||0;mixed/=channels.length;sum+=mixed*mixed;low+=lowAlpha*(mixed-low);bassSum+=low*low;count++;}
    energies[frame]=Math.log1p(Math.sqrt(sum/Math.max(1,count))*80);bassEnergy[frame]=Math.sqrt(bassSum/Math.max(1,count));
    if(frame%1200===0){onProgress(Math.round(frame/frameCount*55));await new Promise(resolve=>setTimeout(resolve,0));}
  }

  const onsets=new Float32Array(frameCount);
  for(let frame=1;frame<frameCount;frame++){
    let local=0,items=0;for(let back=2;back<=10&&frame-back>=0;back++){local+=energies[frame-back];items++;}
    const baseline=items?local/items:energies[frame-1],rise=Math.max(0,energies[frame]-baseline),slope=Math.max(0,energies[frame]-energies[frame-1]);onsets[frame]=rise+slope*.7;
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
  const activeStartIndex=Math.max(0,Array.from(energies).findIndex(value=>value>floor+range*.08)),activeStart=activeStartIndex*frameSeconds,beatInterval=bestLag*frameSeconds,beatTimes=[],cueStrengths=[];
  // BPM is shown as a reference only. Lighting cues come from the strongest real
  // attack in each one-second window, with quieter sections receiving a longer
  // cooldown. This preserves sparse intros and becomes denser as the arrangement grows.
  const sortedOnsets=Array.from(onsets).sort((a,b)=>a-b),onsetFloor=percentile(sortedOnsets,.5),onsetCeiling=percentile(sortedOnsets,.985),onsetRange=Math.max(.0001,onsetCeiling-onsetFloor),bucketFrames=Math.max(1,Math.round(1/frameSeconds));
  let lastCue=-Infinity;
  for(let from=activeStartIndex;from<frameCount;from+=bucketFrames){
    const to=Math.min(frameCount-1,from+bucketFrames),localRadius=Math.round(4/frameSeconds),localValues=Array.from(onsets.slice(Math.max(0,from-localRadius),Math.min(frameCount,to+localRadius))).sort((a,b)=>a-b),localFloor=percentile(localValues,.5),localCeiling=percentile(localValues,.95),localRange=Math.max(.0001,localCeiling-localFloor),candidates=[];
    for(let frame=Math.max(1,from);frame<to;frame++){
      if(onsets[frame]<onsets[frame-1]||onsets[frame]<onsets[frame+1])continue;
      const attack=Math.max(0,Math.min(1,(onsets[frame]-onsetFloor)/onsetRange)),localAttack=Math.max(0,Math.min(1,(onsets[frame]-localFloor)/localRange)),intensity=energyLevels[frame],score=attack*.5+localAttack*.3+intensity*.2;
      candidates.push({frame,attack,localAttack,intensity,score});
    }
    if(!candidates.length)continue;candidates.sort((a,b)=>b.score-a.score);const cue=candidates[0],time=cue.frame*frameSeconds+frameSeconds;
    const requiredGap=cue.intensity>=.68?1:cue.intensity>=.4?1.4:1.9,gate=cue.intensity>=.68?.23:cue.intensity>=.4?.28:.32;
    if(time-lastCue<requiredGap||cue.score<gate)continue;
    beatTimes.push(time);cueStrengths.push(Math.max(.15,Math.min(1,cue.score)));lastCue=time;
  }
  onProgress(80);
  const bassSorted=Array.from(bassEnergy).sort((a,b)=>a-b),bassMax=Math.max(.00001,percentile(bassSorted,.96)),bassEnvelope=[];
  for(let i=0;i<frameCount;i+=envelopeEvery)bassEnvelope.push(Math.min(1,bassEnergy[i]/bassMax));
  const result={version:4,duration:buffer.duration,bpm,beatInterval,beatTimes,cueStrengths,envelope,bassEnvelope,envelopeStep:.1,confidence:Math.max(0,Math.min(1,bestScore||0)),analysisMode:'adaptive-local-onset'};
  result.mediaArt=HueMediaArt.compile(result);return result;
}
function drawAnalyzedTimeline(currentTime=0){
  const canvas=$('#meter'),ctx=canvas.getContext('2d');ctx.clearRect(0,0,canvas.width,canvas.height);if(!analyzedTrack)return;const values=analyzedTrack.envelope,bars=Math.min(canvas.width,values.length),gradient=ctx.createLinearGradient(0,0,canvas.width,0);gradient.addColorStop(0,'#7957ff');gradient.addColorStop(1,'#1dd3e8');ctx.fillStyle=gradient;
  for(let bar=0;bar<bars;bar++){const from=Math.floor(bar*values.length/bars),to=Math.max(from+1,Math.floor((bar+1)*values.length/bars));let peak=0;for(let index=from;index<to;index++)peak=Math.max(peak,values[index]||0);const height=Math.max(2,peak*(canvas.height-8));ctx.fillRect(bar*canvas.width/bars,canvas.height-height,Math.max(1,canvas.width/bars),height);}
  const x=Math.max(0,Math.min(canvas.width,(currentTime/analyzedTrack.duration)*canvas.width));ctx.fillStyle='#ffffff';ctx.fillRect(x,0,2,canvas.height);
}
function resetAnalyzedPlayback(time=0){
  if(!analyzedTrack)return;analyzedBeatCursor=0;while(analyzedBeatCursor<analyzedTrack.beatTimes.length&&analyzedTrack.beatTimes[analyzedBeatCursor]<time-.08)analyzedBeatCursor++;analyzedEnvelopeCursor=-1;phase=0;if(['beat','beat-brightness','entertainment'].includes(musicStyle))for(let index=0;index<analyzedBeatCursor;index++){const strength=analyzedTrack.cueStrengths?.[index]??1;phase=(phase+(strength>=.68?3:strength>=.4?2:1))%placementColors.length;}beatCount=0;lastMusicCommandAt=0;lastScheduledMusicBeat=-Infinity;equalizerLastLevel=-1;equalizerLastSentAt=0;equalizerColorDirty=true;entertainmentLastFrameAt=0;entertainmentAccentBucket=-1;entertainmentFlashUntil=0;$('#beatCount').textContent='0';$('#commandInterval').textContent='—';drawAnalyzedTimeline(time);
}
function stopPlaybackLoop(){clearTimeout(playbackTimer);playbackTimer=null;}
async function startAnalyzedPlayback(){
  if(!analyzedTrack)return;const player=$('#audioPlayer');if(musicStyle==='beat'&&!musicScenesReady){player.pause();try{await prepareMusicScenes();await player.play();}catch(error){setMessage(`공통 Scene 준비 실패: ${error.message}`,'error');}return;}if(musicStyle==='beat-brightness'&&!musicGroupsReady){player.pause();try{await prepareAnalyzedMusicGroups();await player.play();}catch(error){setMessage(`음악 그룹 준비 실패: ${error.message}`,'error');}return;}if(musicStyle==='entertainment'&&!entertainmentActive){player.pause();try{await startEntertainment();await player.play();}catch(error){setMessage(`Entertainment 준비 실패: ${error.message}`,'error');}return;}stopShowTest(true);if(activeStream){activeStream.getTracks().forEach(track=>track.stop());activeStream=null;}resetAnalyzedPlayback(player.currentTime);stopPlaybackLoop();
  const tick=()=>{if(player.paused||player.ended){animationFrame=null;return;}const current=player.currentTime,scheduled=current+Number($('#syncOffset')?.value||120)/1000;let entertainmentCueChanged=false;
    while(analyzedBeatCursor<analyzedTrack.beatTimes.length&&analyzedTrack.beatTimes[analyzedBeatCursor]<=scheduled){const cueIndex=analyzedBeatCursor++,beatTime=analyzedTrack.beatTimes[cueIndex],cueStrength=analyzedTrack.cueStrengths?.[cueIndex]??1;if(beatTime>=current-.12&&(beatTime-lastScheduledMusicBeat)*1000>=MUSIC_COMMAND_INTERVAL_MS-40){lastScheduledMusicBeat=beatTime;if(musicStyle==='beat')triggerBeat(false,cueStrength);else if(musicStyle==='beat-brightness'){const envelopeIndex=Math.max(0,Math.min(analyzedTrack.envelope.length-1,Math.floor(beatTime/analyzedTrack.envelopeStep))),level=analyzedTrack.envelope[envelopeIndex]||0;triggerBrightnessBeat(level,cueStrength);}else if(musicStyle==='entertainment'){phase=(phase+(cueStrength>=.68?3:cueStrength>=.4?2:1))%placementColors.length;entertainmentCueChanged=true;beatCount++;$('#beatCount').textContent=beatCount;}else{phase=(phase+1)%placementColors.length;equalizerColorDirty=true;}}}
    if(musicStyle==='equalizer'){const group=selectedEqualizerGroup(),max=group?.lightIds.filter(id=>connectedLightIds().includes(id)).length||0,index=Math.max(0,Math.min(analyzedTrack.envelope.length-1,Math.floor(scheduled/analyzedTrack.envelopeStep))),now=performance.now();if(index!==analyzedEnvelopeCursor&&!commandBusy&&now-equalizerLastSentAt>=MUSIC_COMMAND_INTERVAL_MS){analyzedEnvelopeCursor=index;const level=Math.round((analyzedTrack.envelope[index]||0)*max);applyEqualizerLevel(level).then(applied=>{if(applied){equalizerLastSentAt=performance.now();beatCount++;$('#beatCount').textContent=beatCount;}}).catch(error=>setMessage(error.message,'error'));}}
    if(musicStyle==='entertainment'){
      analyzedTrack.mediaArt||=HueMediaArt.compile(analyzedTrack);
      const frame=HueMediaArt.sample(analyzedTrack.mediaArt,scheduled),index=Math.floor(scheduled/analyzedTrack.mediaArt.step);
      if(frame&&index!==analyzedEnvelopeCursor&&!entertainmentFrameBusy){
        sendEntertainmentFrame(0,false,false,null,false,frame).then(sent=>{if(sent)analyzedEnvelopeCursor=index;}).catch(error=>{setMessage(error.message,'error');player.pause();});
        $('#mediaArtState').textContent=({intro:'도입 · 한 점',travel:'이동 · 잔상',build:'쌓임 · 확장',highlight:'하이라이트 · 펼침'})[frame.mode];
      }
    }
    drawAnalyzedTimeline(current);playbackTimer=setTimeout(tick,16);
  };tick();
}
async function prepareAnalyzedMusicGroups(){const commands=musicStyle==='beat-brightness'?buildBrightnessBeatCommands(phase,.7,false):buildBeatCommands(false);if(!commands.length)throw new Error('연결된 전구가 들어 있는 음악 그룹이 없습니다.');const result=await api('/api/control/grouped-music/prepare',{method:'POST',body:JSON.stringify({commands})});musicGroupsReady=true;return result;}
function analyzedTrackSummary(analysis){
  const cues=analysis?.beatTimes?.length||0,mode=analysis?.analysisMode==='adaptive-local-onset'?'구간별 타격 분석':analysis?.analysisMode==='adaptive-onset'?'가변 타격 분석':'기존 박자 분석';
  return `${analysis?.bpm||'—'} BPM 참고 · ${formatDuration(analysis?.duration)} · 조명 타격점 ${cues}개 · ${mode}`;
}
function renderTrackLibrary(){
  $('#trackCount').textContent=`${savedTracks.length}곡`;
  $('#trackPlaylist').innerHTML=savedTracks.length?savedTracks.map(track=>`<article class="track-row ${track.id===activeTrackId?'active':''}" data-track-id="${track.id}"><div class="track-copy"><strong title="${escapeHtml(track.fileName)}">${escapeHtml(track.fileName)}</strong><span>${escapeHtml(analyzedTrackSummary(track.analysis))}</span></div><button class="track-play" data-track-play="${track.id}">${track.id===activeTrackId&&!$('#audioPlayer').paused?'일시정지':'재생'}</button><button class="track-delete" data-track-delete="${track.id}" aria-label="${escapeHtml(track.fileName)} 삭제">삭제</button></article>`).join(''):'<div class="empty">저장된 음악이 없습니다. 위에서 음원 파일을 분석해 주세요.</div>';
}
async function loadTrackLibrary(){savedTracks=await api('/api/tracks');renderTrackLibrary();}
async function upgradeSavedTrackAnalysis(track){
  if(Number(track.analysis?.version||0)>=4&&track.analysis?.mediaArt?.version===2)return track;
  if(Number(track.analysis?.version||0)>=4&&Array.isArray(track.analysis?.envelope)){
    const analysis={...track.analysis,mediaArt:HueMediaArt.compile(track.analysis)},updated=await api(`/api/tracks/${encodeURIComponent(track.id)}/analysis`,{method:'PUT',body:JSON.stringify(analysis)});savedTracks=savedTracks.map(item=>item.id===updated.id?updated:item);return updated;
  }
  const panel=$('#trackAnalysis');panel.hidden=false;$('#analysisState').className='analysis-state';$('#analysisState').textContent='재분석 중';$('#analysisTrackName').textContent=track.fileName;$('#analysisSummary').textContent='음량·저음 타격과 연출 순서를 분석하고 있습니다.';setMessage('저장된 음원을 개선된 기준으로 한 번만 다시 분석합니다.');
  await ensureAudio();const response=await fetch(`/api/tracks/${encodeURIComponent(track.id)}/audio`);if(!response.ok)throw new Error('저장된 음원 파일을 읽지 못했습니다.');const raw=await response.arrayBuffer(),decoded=await audioContext.decodeAudioData(raw),analysis=await analyzeAudioBuffer(decoded,progress=>{$('#analysisSummary').textContent=`${progress}% · 음량·저음 타격과 연출 순서를 분석하고 있습니다.`;});const updated=await api(`/api/tracks/${encodeURIComponent(track.id)}/analysis`,{method:'PUT',body:JSON.stringify(analysis)});savedTracks=savedTracks.map(item=>item.id===updated.id?updated:item);return updated;
}
async function selectSavedTrack(track,autoplay=false){
  const panel=$('#trackAnalysis'),player=$('#audioPlayer');stopShowTest(true);player.pause();resetAnalysis();track=await upgradeSavedTrackAnalysis(track);analyzedTrack=track.analysis;activeTrackId=track.id;panel.hidden=false;player.hidden=false;$('#analysisState').className='analysis-state ready';$('#analysisState').textContent='분석 완료';$('#analysisTrackName').textContent=track.fileName;$('#analysisSummary').textContent=analyzedTrackSummary(analyzedTrack);$('#bpmValue').textContent=analyzedTrack.bpm||'—';player.src=`/api/tracks/${encodeURIComponent(track.id)}/audio`;player.load();resetAnalyzedPlayback(0);renderTrackLibrary();if(autoplay)await player.play();
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
$('#audioPlayer').addEventListener('ended',()=>{stopPlaybackLoop();renderTrackLibrary();setMessage('음원 재생과 조명 연출이 끝났습니다.','success');});
$('#microphoneButton').addEventListener('click',async()=>{try{stopShowTest(true);$('#audioPlayer').pause();resetAnalysis();if(musicStyle==='entertainment'&&!entertainmentActive)await startEntertainment();await ensureAudio();activeStream=await navigator.mediaDevices.getUserMedia({audio:true});sourceNode=audioContext.createMediaStreamSource(activeStream);sourceNode.connect(analyser);if(musicStyle==='equalizer')await applyEqualizerLevel(0,true);startAnalysis();setMessage('마이크 실시간 분석을 시작했습니다. 파일 연출보다 박자 정확도는 낮습니다.','success');}catch(error){setMessage(`마이크를 시작하지 못했습니다: ${error.message}`,'error');}});
$('#stopButton').addEventListener('click',()=>{const player=$('#audioPlayer');player.pause();player.currentTime=0;resetAnalysis();if(analyzedTrack){$('#bpmValue').textContent=analyzedTrack.bpm;resetAnalyzedPlayback(0);}setMessage('재생과 실시간 분석을 중지했습니다.');});

async function bootstrap(){
  let stored=null,settingsEndpointAvailable=true;
  try{const response=await api('/api/controller-settings');if(response.exists&&response.settings){stored=response.settings;applyStoredControllerSettings(stored);}}
  catch(error){settingsEndpointAvailable=false;console.error('제어 설정 불러오기 실패',error);}
  updateMasterControls();renderAllGroups();applyStoredControls(stored?.controls);setMusicStyle(musicStyle);controllerSettingsReady=settingsEndpointAvailable;
  if(settingsEndpointAvailable&&!stored){try{await saveControllerSettingsNow();setMessage('현재 그룹과 전구 순서를 폴더 설정 파일에 저장했습니다.','success');}catch(error){setMessage(error.message,'error');}}
  api('/api/entertainment/stop',{method:'POST'}).catch(()=>{});
  try{await loadTrackLibrary();}catch(error){setMessage(`저장된 음악을 불러오지 못했습니다: ${error.message}`,'error');}
  try{await loadStatus();await loadLights(true);}catch(error){setMessage(error.message,'error');}
}
bootstrap();
