(() => {
  'use strict';
  const C = window.OfflineReviewCore;
  const $ = id => document.getElementById(id);
  const selectedFromUrl = new URLSearchParams(location.search);
  const state = { projects: [], data: null, buffer: null, layer: 'downbeat', context: null,
    musicGain: null, clickGain: null, sources: [], playing: false, offset: 0, startedAt: 0,
    loop: null, loadId: 0, transportId: 0, abort: null, clickBuffer: null, detailWindow: null,
    previewStopped: true, lampNodes: [], sections: [], showVersion: 0, showReady: false,
    showDirty: false, showGenerated: false, saving: false, projectId: '', revisionId: '',
    dynamics: null, autoSections: [] };
  const timeText = (t, precise = false) => {
    const ms = Math.floor(Math.max(0, t) * 1000);
    return `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}${precise ? '.' + String(ms % 1000).padStart(3, '0') : ''}`;
  };
  function status(text) { $('status').textContent = text; }
  async function get(url, signal, json = true) {
    const response = await fetch(url, { signal, cache: 'no-store' });
    if (response.status === 409) throw new Error('공통 음원이 분석 이후 변경되었습니다. 원본과 분석 결과를 확인해 주세요.');
    if (!response.ok) throw new Error(response.status === 404 ? '새 검토 API 또는 분석 파일을 찾을 수 없습니다. 서버를 최신 코드로 재시작해 주세요.' : '분석 결과를 읽지 못했습니다. 파일과 서버 상태를 확인하세요.');
    if (json && !response.headers.get('content-type')?.includes('application/json')) throw new Error('이전 서버가 실행 중입니다. 서버를 종료하고 start.cmd로 다시 실행한 뒤 새로고침해 주세요.');
    return response;
  }
  function context() {
    if (!state.context) {
      state.context = new AudioContext();
      state.musicGain = state.context.createGain();
      state.clickGain = state.context.createGain();
      state.musicGain.connect(state.context.destination);
      state.clickGain.connect(state.context.destination);
      updateVolume();
    }
    return state.context;
  }
  function updateVolume() {
    if (!state.context) return;
    state.musicGain.gain.setTargetAtTime(Number($('musicVolume').value) / 100, state.context.currentTime, .01);
    state.clickGain.gain.setTargetAtTime($('clickEnabled').checked ? Number($('clickVolume').value) / 100 : 0, state.context.currentTime, .01);
  }
  function current(display = false) {
    if (!state.playing) return state.offset;
    let clock = state.context.currentTime;
    // Where supported, align the visual preview to the audio device's output clock.
    if (display && state.context.getOutputTimestamp) {
      const output = state.context.getOutputTimestamp();
      if (output.contextTime > 0 && output.contextTime <= clock) clock = output.contextTime;
    }
    return C.position(state.offset, clock - state.startedAt, state.data.durationSec, state.loop);
  }
  function halt() {
    ++state.transportId;
    if (state.playing) state.offset = current();
    state.playing = false;
    for (const source of state.sources) { source.onended = null; try { source.stop(); } catch {} source.disconnect(); }
    state.sources = [];
    $('play').textContent = '재생';
  }
  function clicks() {
    if (!state.clickBuffer) {
      const ctx = context();
      const samples = C.makeClicks(C.eventsFor(state.data, state.layer), state.data.durationSec, ctx.sampleRate);
      state.clickBuffer = ctx.createBuffer(1, samples.length, ctx.sampleRate);
      state.clickBuffer.copyToChannel(samples, 0);
    }
    return state.clickBuffer;
  }
  async function play() {
    if (!state.data || !state.buffer) return;
    const loadId = state.loadId, transportId = ++state.transportId;
    try {
      const ctx = context();
      await ctx.resume();
      if (loadId !== state.loadId || transportId !== state.transportId || !state.buffer || state.playing) return;
      if (state.offset >= state.data.durationSec) state.offset = 0;
      if (state.loop && (state.offset < state.loop.start || state.offset >= state.loop.end)) state.offset = state.loop.start;
      const music = ctx.createBufferSource(), click = ctx.createBufferSource();
      music.buffer = state.buffer; click.buffer = clicks();
      music.connect(state.musicGain); click.connect(state.clickGain);
      for (const source of [music, click]) {
        if (state.loop) { source.loop = true; source.loopStart = state.loop.start; source.loopEnd = state.loop.end; }
      }
      const when = ctx.currentTime + .04;
      state.startedAt = when;
      state.sources = [music, click];
      state.playing = true;
      state.previewStopped = false;
      music.onended = () => {
        if (!state.loop && state.sources[0] === music) { halt(); state.offset = state.data.durationSec; state.previewStopped = true; draw(); }
      };
      music.start(when, state.offset);
      click.start(when, state.offset);
      $('play').textContent = '일시 정지';
    } catch (error) { halt(); status('오디오 재생 실패: ' + error.message); }
  }
  function seek(t) {
    if (!state.data) return;
    const resume = state.playing;
    halt();
    state.offset = Math.max(0, Math.min(state.data.durationSec, t));
    state.previewStopped = false;
    if (state.loop && (t < state.loop.start || t >= state.loop.end)) setLoop(null);
    draw();
    if (resume) void play();
  }
  function setLoop(loop) {
    state.loop = loop;
    $('loop').setAttribute('aria-pressed', String(!!loop));
    $('loop').textContent = loop ? '반복 켜짐' : '반복 꺼짐';
  }
  function changeLayer(layer) {
    if (!state.data || !C.available(state.data, layer)) return;
    const resume = state.playing;
    halt();
    state.layer = layer;
    state.clickBuffer = null;
    document.querySelectorAll('[data-layer]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.layer === layer)));
    $('explanation').textContent = C.layers[layer].description;
    draw();
    if (resume) void play();
  }
  async function loadRevision() {
    const project = $('project').value, revision = $('revision').value;
    state.abort?.abort();
    state.abort = new AbortController();
    const signal = state.abort.signal, loadId = ++state.loadId;
    halt(); state.data = null; state.buffer = null; state.clickBuffer = null; state.offset = 0;
    state.sections = []; state.showReady = false; state.showDirty = false; state.showGenerated = false;
    state.dynamics = null; state.autoSections = [];
    state.projectId = project; state.revisionId = revision;
    state.previewStopped = true;
    setLoop(null); $('review').hidden = true;
    if (!project || !revision) return;
    status('분석 결과와 공통 음원을 불러오는 중… 처음에는 잠시 걸릴 수 있습니다.');
    try {
      const base = `/api/offline-review/projects/${encodeURIComponent(project)}`;
      const [dataResponse, audioResponse] = await Promise.all([get(`${base}/analyses/${encodeURIComponent(revision)}`, signal), get(`${base}/audio`, signal, false)]);
      const data = C.validate(await dataResponse.json());
      const audio = await audioResponse.arrayBuffer();
      if (loadId !== state.loadId) return;
      const buffer = await context().decodeAudioData(audio);
      if (loadId !== state.loadId) return;
      if (Math.abs(buffer.duration - data.durationSec) > .05) throw new Error('재생 음원과 분석의 길이가 다릅니다. 이 결과로는 비교할 수 없습니다.');
      state.data = data; state.buffer = buffer;
      state.dynamics = C.buildDynamics(data);
      state.autoSections = C.autoClimaxSections(data, state.dynamics);
      await loadShow(loadId);
      if (loadId !== state.loadId) return;
      buildPreview(); buildCloseCandidates();
      $('seek').max = String(data.durationSec);
      $('loopStart').value = '0'; $('loopEnd').value = String(Math.min(25, data.durationSec));
      $('loopStart').max = $('loopEnd').max = String(data.durationSec);
      document.querySelectorAll('[data-layer]').forEach(button => { button.disabled = !C.available(data, button.dataset.layer); });
      $('review').hidden = false;
      $('warning').hidden = !data.warnings?.length;
      $('warning').textContent = data.warnings?.some(w => w.startsWith('float-source-above-full-scale'))
        ? '원본 음원에 최대 출력 범위를 넘는 샘플이 있습니다. 원본은 보존했으며, 검토는 기본 음악 음량 55%로 시작합니다.'
        : data.warnings?.length ? '분석 시 스테레오 상쇄 등의 주의사항이 기록되었습니다. 분석 문서를 함께 확인하세요.' : '';
      changeLayer(C.available(data, state.layer) ? state.layer : 'onset');
      status('준비 완료 · 재생을 누르세요. 분석 원본은 유지하며 모의 연출만 표시합니다. 실제 전구 출력은 없습니다.');
    } catch (error) {
      if (loadId === state.loadId && error.name !== 'AbortError') { status(error.message); $('setupHelp').hidden = false; }
    }
  }
  function chooseProject() {
    const selected = state.projects.find(p => p.projectId === $('project').value);
    $('revision').replaceChildren();
    for (const r of selected?.revisions ?? []) {
      const option = new Option(`${new Date(r.createdAt).toLocaleString('ko-KR')} · ${r.analysisId.slice(0, 8)}`, r.analysisId);
      $('revision').add(option);
    }
    $('revision').disabled = !selected;
    if (selected?.revisions.some(r => r.analysisId === selectedFromUrl.get('revision')))
      $('revision').value = selectedFromUrl.get('revision');
    selectedFromUrl.delete('revision');
    void loadRevision();
  }
  async function refresh() {
    halt(); ++state.loadId; state.abort?.abort();
    state.data = null; state.buffer = null; state.clickBuffer = null;
    $('review').hidden = true; $('project').disabled = $('revision').disabled = true; $('refresh').disabled = true;
    status('분석 목록을 불러오는 중…');
    try {
      state.projects = await (await get('/api/offline-review/projects')).json();
      $('project').replaceChildren(); $('revision').replaceChildren();
      if (!state.projects.length) {
        $('project').add(new Option('완료된 새 분석이 없습니다', ''));
        $('setupHelp').hidden = false;
        status('새 사전 분석 결과가 없습니다. 위에서 음원을 선택해 분석하세요.');
        return;
      }
      for (const p of state.projects) $('project').add(new Option(`${p.title} · ${timeText(p.durationSec)}`, p.projectId));
      if (state.projects.some(p => p.projectId === selectedFromUrl.get('project')))
        $('project').value = selectedFromUrl.get('project');
      selectedFromUrl.delete('project');
      $('project').disabled = false; $('setupHelp').hidden = true;
      chooseProject();
    } catch (error) { status(error.message); $('setupHelp').hidden = false; }
    finally { $('refresh').disabled = false; }
  }
  async function runAnalysis(file, pendingId) {
    halt(); $('newAudio').disabled = true;
    const progress = message => { $('uploadStatus').textContent = message; };
    try {
      const job = pendingId ? await HueOfflineAnalysis.wait(pendingId, progress) : await HueOfflineAnalysis.analyze(file, progress);
      selectedFromUrl.set('project', job.projectId); selectedFromUrl.set('revision', job.analysisId);
      history.replaceState(null, '', HueOfflineAnalysis.reviewUrl(job));
      await refresh();
    } catch (error) { progress(error.message); }
    finally { $('newAudio').disabled = false; }
  }
  $('newAudio').addEventListener('change', event => {
    const file = event.target.files[0]; event.target.value = '';
    if (!file) return;
    if (state.showDirty && !confirm('저장하지 않은 연출 수정이 있습니다. 새 분석을 열까요?')) return;
    void runAnalysis(file);
  });
  function plot(canvas, start, end, position, detail) {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width) return;
    const dpr = window.devicePixelRatio || 1, width = Math.round(rect.width), height = Math.round(rect.height);
    if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) { canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr); }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, width, height);
    const pad = 14, left = 10, usable = width - 20, span = end - start, mid = (height - 24) / 2;
    const x = t => left + (t - start) / span * usable;
    for (const section of state.sections) {
      const a = Math.max(start, section.start), b = Math.min(end, section.end);
      if (a >= b) continue;
      ctx.fillStyle = '#a480ff30'; ctx.fillRect(x(a), pad, x(b) - x(a), height - 40);
      ctx.fillStyle = '#d2beff'; ctx.font = '12px Segoe UI, sans-serif'; ctx.fillText('클라이맥스', x(a) + 4, 25);
    }
    const w = state.data.waveform;
    const max = Math.max(.001, w.peak.reduce((a, b) => Math.max(a, b), 0));
    ctx.strokeStyle = '#29394e'; ctx.lineWidth = 1;
    ctx.fillStyle = '#aebfd1'; ctx.font = '12px Segoe UI, sans-serif';
    for (let n = 0; n <= 5; n++) { const t = start + span * n / 5, px = x(t); ctx.beginPath(); ctx.moveTo(px, pad); ctx.lineTo(px, height - 25); ctx.stroke(); ctx.fillText(timeText(t), Math.min(width - 40, Math.max(2, px)), height - 7); }
    let i = C.lowerBound(w.timesSec, start);
    for (let px = left; px < width - left; px++) {
      const endTime = start + (px - left + 1) / usable * span;
      let peak = 0, rms = 0;
      while (i < w.timesSec.length && w.timesSec[i] < endTime) { peak = Math.max(peak, w.peak[i]); rms = Math.max(rms, w.rms[i]); i++; }
      ctx.strokeStyle = '#244958'; ctx.beginPath(); ctx.moveTo(px, mid - peak / max * (mid - pad)); ctx.lineTo(px, mid + peak / max * (mid - pad)); ctx.stroke();
      ctx.strokeStyle = '#55a9b6'; ctx.beginPath(); ctx.moveTo(px, mid - rms / max * (mid - pad)); ctx.lineTo(px, mid + rms / max * (mid - pad)); ctx.stroke();
    }
    const events = C.eventsFor(state.data, state.layer);
    let eventIndex = C.lowerBound(events, start);
    ctx.strokeStyle = '#ffce72'; ctx.lineWidth = detail ? 1.5 : 1; ctx.globalAlpha = detail ? .85 : .45;
    for (; eventIndex < events.length && events[eventIndex] < end; eventIndex++) { const px = x(events[eventIndex]); ctx.beginPath(); ctx.moveTo(px, pad); ctx.lineTo(px, height - 26); ctx.stroke(); }
    ctx.globalAlpha = 1;
    if (state.loop) { ctx.fillStyle = '#5ee5c01a'; const a = Math.max(start, state.loop.start), b = Math.min(end, state.loop.end); if (a < b) ctx.fillRect(x(a), pad, x(b) - x(a), height - 40); }
    if (position >= start && position <= end) { ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(x(position), 4); ctx.lineTo(x(position), height - 24); ctx.stroke(); }
  }
  function draw() {
    if (!state.data || $('review').hidden) return;
    const t = current(true), duration = state.data.durationSec;
    drawPreview(t);
    $('time').textContent = `${timeText(t, true)} / ${timeText(duration)}`;
    if (document.activeElement !== $('seek')) $('seek').value = String(t);
    state.detailWindow = C.windowAt(t, duration, Number($('zoom').value));
    const { start, end } = state.detailWindow;
    $('windowRange').textContent = `${start.toFixed(2)}–${end.toFixed(2)}초 · 파형을 누르면 이동`;
    const events = C.eventsFor(state.data, state.layer), visible = C.lowerBound(events, end) - C.lowerBound(events, start);
    $('eventCount').textContent = `${C.layers[state.layer].label} · 구간 ${visible}개 / 전체 ${events.length}개`;
    plot($('overview'), 0, duration, t, false); plot($('detail'), start, end, t, true);
  }
  function canvasSeek(event, detail) {
    if (!state.data) return;
    const rect = event.currentTarget.getBoundingClientRect(), f = Math.max(0, Math.min(1, (event.clientX - rect.left - 10) / (rect.width - 20)));
    const range = detail ? state.detailWindow : { start: 0, end: state.data.durationSec };
    seek(range.start + f * (range.end - range.start));
  }
  $('play').onclick = () => state.playing ? (halt(), draw()) : void play();
  $('stop').onclick = () => { halt(); state.offset = 0; state.previewStopped = true; draw(); };
  function canDiscard() { return !state.saving && (!state.showDirty || confirm('저장하지 않은 연출 변경을 버릴까요?')); }
  $('refresh').onclick = () => { if (canDiscard()) void refresh(); };
  $('project').onchange = () => { if (canDiscard()) chooseProject(); else $('project').value = state.projectId; };
  $('revision').onchange = () => { if (canDiscard()) void loadRevision(); else $('revision').value = state.revisionId; };
  document.querySelectorAll('[data-layer]').forEach(button => button.onclick = () => changeLayer(button.dataset.layer));
  $('seek').oninput = () => seek(Number($('seek').value)); $('zoom').onchange = draw;
  $('overview').onclick = event => canvasSeek(event, false); $('detail').onclick = event => canvasSeek(event, true);
  for (const id of ['musicVolume', 'clickVolume', 'clickEnabled']) $(id).oninput = updateVolume;
  $('useWindow').onclick = () => { $('loopStart').value = state.detailWindow.start.toFixed(2); $('loopEnd').value = (Math.floor(state.detailWindow.end * 100) / 100).toFixed(2); if (state.loop) updateLoop(); };
  function updateLoop() {
    try { const loop = C.readLoop(Number($('loopStart').value), Number($('loopEnd').value), state.data.durationSec); const resume = state.playing; halt(); setLoop(loop); if (resume) void play(); draw(); }
    catch (error) { halt(); setLoop(null); draw(); status(error.message); }
  }
  $('loop').onclick = () => { if (!state.loop) updateLoop(); else { const resume = state.playing; halt(); setLoop(null); if (resume) void play(); draw(); } };
  for (const id of ['loopStart', 'loopEnd']) $(id).onchange = () => { if (state.loop) updateLoop(); };
  window.addEventListener('resize', draw);
  document.addEventListener('visibilitychange', () => { if (document.hidden && state.playing) { halt(); status('다른 화면으로 이동해 검토 재생을 일시 정지했습니다.'); } });
  window.addEventListener('pagehide', halt);
  window.addEventListener('beforeunload', event => { if (state.showDirty || state.saving) { event.preventDefault(); event.returnValue = ''; } });
  function buildPreview() {
    const pairs = Number($('previewPairs').value);
    $('previewLamps').replaceChildren(); state.lampNodes = [];
    for (const group of ['A', 'B']) {
      const row = document.createElement('div'); row.className = 'preview-row';
      row.style.setProperty('--pairs', pairs);
      const title = document.createElement('strong'); title.textContent = group; row.append(title);
      const lamps = [];
      for (let i = 0; i < pairs; i++) {
        const lamp = document.createElement('div'); lamp.className = 'preview-lamp';
        const bulb = document.createElement('span'); bulb.className = 'preview-bulb'; bulb.setAttribute('role', 'img');
        const label = document.createElement('span'); label.textContent = `${group}${i + 1}`;
        lamp.append(bulb, label); row.append(lamp); lamps.push({ bulb, label: label.textContent });
      }
      $('previewLamps').append(row); state.lampNodes.push(lamps);
    }
  }
  function drawPreview(t) {
    if (!state.data || !state.lampNodes.length) return;
    const enabled = state.layer === 'downbeat' && !state.previewStopped;
    const events = state.dynamics?.lightingDownbeats ?? C.eventsFor(state.data, 'downbeat');
    const frame = C.showFrame(events, t, state.lampNodes[0].length, state.sections, enabled, state.dynamics);
    state.lampNodes.forEach((row, group) => row.forEach((lamp, i) => {
      const level = (group ? frame.b : frame.a)[i];
      lamp.bulb.style.backgroundColor = `rgb(${(frame.pairColors?.[i] ?? frame.rgb).map(channel => Math.round(channel * level)).join(',')})`;
      lamp.bulb.setAttribute('aria-label', `${lamp.label} ${frame.colorName} 밝기 ${Math.round(level * 100)}%`);
    }));
    const peak = Math.max(...frame.a), next = frame.eventIndex + 1;
    if (frame.preparation) {
      const p=frame.preparation;
      $('previewState').textContent = !enabled ? '정지 · 마디 첫 박자 탭에서 재생하세요.'
        : `${state.playing?'':'정지 화면 · '}클라이맥스 ${p.phase==='blackout'?'진입 전 전체 소등':p.phase==='fade'?'진입 전 감쇠':'진입 준비'} ${p.bar}/${p.total}마디 · ${p.filled}/${frame.a.length}쌍 · ${frame.colorName} · 밝기 ${Math.round(peak*100)}% · 진입까지 ${Math.max(0,p.end-t).toFixed(2)}초`;
      return;
    }
    if (frame.accumulation) {
      const fill = frame.accumulation;
      const phases = { fill: '누적 점등', hold: '전체 유지', fade: '전체 감쇠', blackout: '암전', punch: '전체 펀치', dark: '대기·소등' };
      $('previewState').textContent = state.layer !== 'downbeat' ? '마디 첫 박자 탭을 선택하면 모의 점등이 보입니다.'
        : state.previewStopped ? '정지 · 8마디 누적 → 마지막 마디 3박 소등·4박 전체 펀치 → 소등 → 새 색으로 반복'
        : `${state.playing ? '' : '정지 화면 · '}${fill.cycle}회차 · ${frame.pattern} · ${fill.bar}/8마디 · ${phases[fill.phase]} · ${fill.filled}/${frame.a.length}쌍 · ${frame.colorName} · 밝기 ${Math.round(peak * 100)}%${fill.bar === 8 && !fill.measured ? ' · 마무리 시각은 마디 길이 기준' : ''}`;
      return;
    }
    const stageName = frame.mode === 'intro' ? '도입' : frame.mode === 'groove' ? '일반' : '클라이맥스';
    const pulseTime = frame.pulse.kind === 'accent' ? state.dynamics.accentTimes[frame.pulse.index] : events[frame.pulse.index];
    const pulseName = frame.pulse.kind === 'accent' ? '마디 내 악센트' : '마디 점등';
    $('previewState').textContent = state.layer !== 'downbeat' ? '마디 첫 박자 탭을 선택하면 모의 점등이 보입니다.'
      : !events.length ? '이 분석에는 마디 첫 박자 후보가 없습니다.'
      : state.previewStopped ? '정지 · 재생하면 도입은 마디마다 한 쌍, 일반 구간은 제한된 악센트, 클라이맥스는 전체로 연출됩니다.'
      : frame.mode === 'climax' ? `${state.playing ? '' : '정지 화면 · '}클라이맥스 · 전체 ${Math.round(peak*100)}% · ${frame.colorName} · ${frame.pattern || "전체 펀치"} / 마디 첫 박자 색 전환`
      : `${state.playing ? '' : '정지 화면 · '}${stageName} · ${peak > 0 ? `A${frame.slot + 1}+B${frame.slot + 1} ${Math.round(peak * 100)}% · ${pulseName} ${pulseTime.toFixed(3)}초` : '전체 소등'}${next < events.length ? ` · 다음 마디 ${events[next].toFixed(3)}초` : ' · 마지막 마디 이후'}`;
  }
  function showUrl() {
    return `/api/offline-review/projects/${encodeURIComponent(state.projectId)}/analyses/${encodeURIComponent(state.revisionId)}/show`;
  }
  async function readShowResponse(response) {
    if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('새 연출 API가 없습니다. 서버를 재시작하세요.');
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || '연출 데이터를 읽거나 저장하지 못했습니다.');
    return data;
  }
  function acceptShow(show) {
    if (show.schemaVersion !== 1 || show.analysisId !== state.revisionId || show.playbackHash !== state.data.playbackHash || !Number.isInteger(show.version) || show.version < 0)
      throw new Error('연출 저장본과 선택한 분석이 다릅니다.');
    const stored = C.validateSections(show.sections, state.data.durationSec);
    state.showGenerated = show.version === 0 && !stored.length && state.autoSections.length > 0;
    state.sections = state.showGenerated ? state.autoSections.map(section => ({start:section.start,end:section.end})) : stored;
    state.showVersion = show.version; state.showDirty = false; state.showReady = true;
    renderSections();
    $('showStatus').textContent = show.version ? `저장본 v${show.version} · ${show.sections.length}개 구간`
      : state.showGenerated ? `자동 후보 ${state.sections.length}개 적용 중 · 아직 저장하지 않았습니다.`
      : '뚜렷한 자동 클라이맥스 후보가 없습니다. 필요한 구간을 직접 표시하세요.';
  }
  async function loadShow(loadId = state.loadId) {
    state.showReady = false; $('showFields').disabled = true; $('reloadShow').disabled = true;
    $('showStatus').textContent = '연출 구간을 불러오는 중…';
    try {
      const show = await readShowResponse(await fetch(showUrl(), { cache: 'no-store', signal: state.abort?.signal }));
      if (loadId !== state.loadId) return;
      acceptShow(show); $('climaxStart').value = $('climaxEnd').value = '';
      $('climaxStart').max = $('climaxEnd').max = String(state.data.durationSec);
      draw();
    } catch (error) {
      if (loadId === state.loadId && error.name !== 'AbortError') $('showStatus').textContent = `불러오기 실패 · ${error.message} 편집은 잠겼으며 기존 저장본을 덮어쓰지 않습니다.`;
    } finally {
      if (loadId === state.loadId) { $('showFields').disabled = !state.showReady; $('reloadShow').disabled = false; }
    }
  }
  function edited() {
    state.showDirty = true; state.showGenerated = false; renderSections(); draw();
    $('showStatus').textContent = '미저장 변경 · 화면에는 반영되었습니다. 남기려면 연출 저장을 누르세요.';
  }
  function renderSections() {
    $('showSections').replaceChildren();
    if (!state.sections.length) $('showSections').textContent = '클라이맥스 구간이 없습니다.';
    state.sections.forEach((section, index) => {
      const row = document.createElement('div'); row.className = 'show-section-row';
      const label = document.createElement('span'); label.textContent = `${index + 1}. ${timeText(section.start, true)} → ${timeText(section.end, true)}${state.showGenerated ? ' · 자동 후보' : ''}`;
      const jump = document.createElement('button'); jump.textContent = '시작으로 이동';
      jump.onclick = () => { changeLayer('downbeat'); seek(section.start); };
      const remove = document.createElement('button'); remove.textContent = '삭제'; remove.setAttribute('aria-label', `${index + 1}번 클라이맥스 구간 삭제`);
      remove.onclick = () => { state.sections.splice(index, 1); edited(); };
      row.append(label, jump, remove); $('showSections').append(row);
    });
    $('saveShow').disabled = !state.showDirty && !state.showGenerated;
  }
  $('markStart').onclick = () => { $('climaxStart').value = current(true).toFixed(2); };
  $('markEnd').onclick = () => { $('climaxEnd').value = current(true).toFixed(2); };
  $('addSection').onclick = () => {
    try {
      if (!$('climaxStart').value || !$('climaxEnd').value) throw new Error('시작과 끝을 모두 입력하거나 현재 위치로 표시하세요.');
      state.sections = C.validateSections([...state.sections, { start: Number($('climaxStart').value), end: Number($('climaxEnd').value) }], state.data.durationSec);
      edited();
    } catch (error) { $('showStatus').textContent = error.message; }
  };
  $('reloadShow').onclick = () => { if (canDiscard()) void loadShow(); };
  $('autoShow').onclick = () => {
    if (!state.autoSections.length) { $('showStatus').textContent = '이 분석에서는 지속되는 고에너지 구간을 찾지 못했습니다.'; return; }
    state.sections = state.autoSections.map(section => ({start:section.start,end:section.end}));
    state.showGenerated = true; state.showDirty = state.showVersion > 0;
    renderSections(); draw();
    $('showStatus').textContent = `자동 후보 ${state.sections.length}개를 다시 적용했습니다. 파형 배경과 재생으로 경계를 확인하세요.`;
  };
  $('saveShow').onclick = async () => {
    if (!state.showReady || state.saving || !state.showDirty) return;
    const loadId = state.loadId;
    state.saving = true; $('showFields').disabled = true; $('reloadShow').disabled = true;
    $('showStatus').textContent = '연출 저장 중…';
    try {
      const response = await fetch(showUrl(), { method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseVersion: state.showVersion, sections: state.sections.map(({start,end}) => ({start,end})) }) });
      const show = await readShowResponse(response);
      if (loadId === state.loadId) acceptShow(show);
    } catch (error) { if (loadId === state.loadId) $('showStatus').textContent = `저장 실패 · ${error.message} 현재 변경은 화면에만 남아 있습니다.`; }
    finally { state.saving = false; if (loadId === state.loadId) { $('showFields').disabled = !state.showReady; $('reloadShow').disabled = false; } }
  };
  function buildCloseCandidates() {
    const nearby = C.closeDownbeats(C.eventsFor(state.data, 'downbeat'));
    $('closeCandidates').hidden = !nearby.length;
    $('closeCandidateSummary').textContent = `짧은 간격 후보 검토 · ${nearby.length}곳 (자동 삭제 안 함)`;
    $('closeCandidateList').replaceChildren();
    for (const item of nearby) {
      const row = document.createElement('div'); row.className = 'close-candidate-row';
      const text = document.createElement('span'); text.textContent = `${item.first.toFixed(3)} → ${item.second.toFixed(3)}초 · ${Math.round(item.gap * 1000)}ms 간격`;
      const button = document.createElement('button'); button.textContent = '이 구간 반복';
      button.onclick = () => {
        halt(); changeLayer('downbeat');
        const start = Math.max(0, item.first - 2), end = Math.min(state.data.durationSec, item.second + 3);
        $('loopStart').value = start.toFixed(2); $('loopEnd').value = end.toFixed(2);
        setLoop(C.readLoop(start, end, state.data.durationSec));
        $('zoom').value = '10'; seek(start);
        status('짧은 간격 후보 구간을 준비했습니다. 재생을 누르세요. 두 후보는 모두 원본 그대로 남아 있습니다.');
      };
      row.append(text, button); $('closeCandidateList').append(row);
    }
  }
  $('previewPairs').onchange = () => { buildPreview(); draw(); };
  let last = 0;
  function tick(now) { if (state.playing) { drawPreview(current(true)); if (now - last > 45) { draw(); last = now; } } requestAnimationFrame(tick); }
  requestAnimationFrame(tick);
  const pendingId = sessionStorage.getItem('hue-offline-analysis-job');
  if (pendingId) void runAnalysis(null, pendingId); else void refresh();
})();
