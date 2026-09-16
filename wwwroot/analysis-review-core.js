(function (root) {
  'use strict';
  const layers = {
    onset: { candidate: 'librosa', field: 'onsetsSec', label: '소리 시작', description: '새로운 소리·타격 후보입니다. 보컬·장식음도 포함되며 모두 조명에 사용할 것은 아닙니다.' },
    beat: { candidate: 'beat-this', field: 'beatsSec', label: '박자', description: 'Beat This가 추정한 음악의 맥박입니다. 발로 박자를 세며 비교하세요. 모든 타격음과 같지는 않습니다.' },
    downbeat: { candidate: 'beat-this', field: 'downbeatsSec', label: '마디 첫 박자', description: 'Beat This의 마디 시작 후보입니다. 강한 소리가 언제나 마디 첫 박인 것은 아닙니다.' },
    baseline: { candidate: 'librosa', field: 'beatsSec', label: '비교용 박자', description: 'librosa의 박자 추적 결과입니다. 같은 구간에서 Beat This 박자와 비교해 보세요.' }
  };
  function eventsFor(data, layer) {
    const spec = layers[layer];
    const candidate = data?.candidates?.[spec?.candidate];
    return candidate?.status === 'complete' && Array.isArray(candidate[spec.field]) ? candidate[spec.field] : [];
  }
  function available(data, layer) { return data?.candidates?.[layers[layer].candidate]?.status === 'complete'; }
  function validate(data) {
    const duration = data?.durationSec;
    if (!Number.isFinite(duration) || duration <= 0 || duration > 600) throw new Error('지원 범위를 벗어난 음원 길이입니다.');
    for (const layer of Object.keys(layers)) {
      let previous = -1;
      for (const t of eventsFor(data, layer)) {
        if (!Number.isFinite(t) || t < 0 || t >= duration || t <= previous) throw new Error('후보 시각 배열이 손상되었습니다.');
        previous = t;
      }
    }
    const w = data.waveform;
    const featureKeys = ['rms','peak','lowPower','midPower','highPower','onsetStrength'];
    if (!w || !Array.isArray(w.timesSec) || !w.timesSec.length || featureKeys.some(key => w.timesSec.length !== w[key]?.length)) throw new Error('파형·에너지 데이터가 올바르지 않습니다.');
    let previous = -1;
    w.timesSec.forEach((t, i) => {
      if (!Number.isFinite(t) || t <= previous || t < 0 || t >= duration || featureKeys.some(key => !Number.isFinite(w[key][i]) || w[key][i] < 0)) throw new Error('파형 시간축 또는 에너지 값이 손상되었습니다.');
      previous = t;
    });
    return data;
  }
  function lowerBound(values, t) {
    let a = 0, b = values.length;
    while (a < b) { const m = (a + b) >>> 1; if (values[m] < t) a = m + 1; else b = m; }
    return a;
  }
  function windowAt(position, duration, span) {
    const length = Math.min(duration, span);
    const start = Math.max(0, Math.min(duration - length, position - length * .35));
    return { start, end: start + length };
  }
  function readLoop(start, end, duration) {
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end > duration || end - start < .1) throw new Error('반복 구간은 곡 범위 안에서 끝이 시작보다 0.1초 이상 뒤여야 합니다.');
    return { start, end };
  }
  function position(offset, elapsed, duration, loop) {
    const t = offset + Math.max(0, elapsed);
    if (loop && t >= loop.end) return loop.start + (t - loop.end) % (loop.end - loop.start);
    return Math.min(duration, t);
  }
  function makeClicks(events, duration, rate) {
    const values = new Float32Array(Math.ceil(duration * rate));
    const length = Math.round(.018 * rate);
    for (const time of events) {
      const offset = Math.round(time * rate);
      for (let i = 0; i < length && offset + i < values.length; i++) {
        const envelope = Math.min(1, i / Math.max(1, rate * .001)) * (1 - i / length);
        values[offset + i] += .45 * envelope * Math.sin(2 * Math.PI * 1400 * i / rate);
      }
    }
    for (let i = 0; i < values.length; i++) values[i] = Math.max(-.8, Math.min(.8, values[i]));
    return values;
  }
  // Pure sampling: seek/loop/pause must not depend on how many frames were drawn.
  function downbeatFrame(events, time, pairs, enabled = true) {
    if (!Number.isInteger(pairs) || pairs < 1 || pairs > 5) throw new Error('모의 배치는 1~5쌍입니다.');
    const levels = Array(pairs).fill(0);
    let eventIndex = lowerBound(events, time);
    if (eventIndex === events.length || events[eventIndex] > time) eventIndex--;
    const age = eventIndex < 0 ? Infinity : time - events[eventIndex];
    const slot = eventIndex < 0 ? -1 : eventIndex % pairs;
    // One pair only. A newer candidate immediately replaces the previous pair.
    if (enabled && Number.isFinite(time) && age >= 0 && age < .6) {
      const attack = .015;
      levels[slot] = age < attack ? age / attack : Math.pow(1 - (age - attack) / (.6 - attack), 2);
    }
    return { a: levels, b: [...levels], eventIndex, slot, age };
  }
  function closeDownbeats(events) {
    const gaps = events.slice(1).map((t, i) => t - events[i]), result = [];
    gaps.forEach((gap, i) => {
      const neighbors = gaps.slice(Math.max(0, i - 3), i).concat(gaps.slice(i + 1, i + 4)).sort((a,b) => a-b);
      if (neighbors.length < 3) return;
      const mid = Math.floor(neighbors.length / 2);
      const median = neighbors.length % 2 ? neighbors[mid] : (neighbors[mid - 1] + neighbors[mid]) / 2;
      if (gap < median * .35) result.push({ first: events[i], second: events[i + 1], gap, typicalGap: median });
    });
    return result; // Review flags only, never delete/filter the analysis.
  }
  const palette = [
    { name: '코랄', rgb: [255, 112, 96] }, { name: '청록', rgb: [64, 220, 204] },
    { name: '골드', rgb: [255, 200, 96] }, { name: '보라', rgb: [164, 128, 255] }
  ];
  const clamp = value => Math.max(0, Math.min(1, value));
  function quantile(values, q) {
    const sorted = values.filter(Number.isFinite).sort((a,b) => a-b);
    if (!sorted.length) return 0;
    const position = (sorted.length - 1) * q, left = Math.floor(position), mix = position - left;
    return sorted[left] * (1 - mix) + sorted[Math.min(sorted.length - 1, left + 1)] * mix;
  }
  function normalizeFeature(values) {
    const transformed = values.map(value => Math.log1p(Math.max(0, value)));
    const low = quantile(transformed, .1), high = quantile(transformed, .9), span = Math.max(1e-9, high - low);
    return transformed.map(value => clamp((value - low) / span));
  }
  function sampleSeries(times, values, time) {
    if (!times.length) return 0;
    const right = lowerBound(times, time);
    if (right <= 0) return values[0];
    if (right >= times.length) return values.at(-1);
    const left = right - 1, span = times[right] - times[left], mix = span > 0 ? (time - times[left]) / span : 0;
    return values[left] * (1 - mix) + values[right] * mix;
  }
  function rangeStats(times, values, start, end) {
    const from = lowerBound(times, start), to = Math.max(from + 1, lowerBound(times, end));
    const slice = values.slice(from, Math.min(values.length, to));
    if (!slice.length) return { mean: 0, upper: 0 };
    return { mean: slice.reduce((sum,value) => sum + value, 0) / slice.length, upper: quantile(slice, .8) };
  }
  function buildDynamics(data) {
    const w = data.waveform, times = w.timesSec;
    const energy = normalizeFeature(w.rms), low = normalizeFeature(w.lowPower), mid = normalizeFeature(w.midPower),
      high = normalizeFeature(w.highPower), onset = normalizeFeature(w.onsetStrength);
    const beatTimes = eventsFor(data, 'beat');
    const featureStep = times.length > 1 ? Math.max(.001, times[1] - times[0]) : .02;
    const beatStrengths = beatTimes.map(time => {
      const energyAtBeat = sampleSeries(times, energy, time);
      const center = lowerBound(times, time), radius = Math.max(1, Math.round(.07 / featureStep));
      const localOnset = Math.max(0, ...onset.slice(Math.max(0, center - radius), Math.min(onset.length, center + radius + 1)));
      return clamp(.2 + energyAtBeat * .45 + localOnset * .35);
    });
    return { times, energy, low, mid, high, onset, beatTimes, beatStrengths };
  }
  function autoClimaxSections(data, dynamics = buildDynamics(data)) {
    const duration = data.durationSec, rawDownbeats = eventsFor(data, 'downbeat');
    // Ignore implausibly short gaps only for structural scoring. Original candidates and lighting transitions stay untouched.
    const downbeats = rawDownbeats.filter((time,index) => index === 0 || time - rawDownbeats[index - 1] >= .75);
    const boundaries = [...new Set([0, ...downbeats.filter(t => t > .1 && t < duration - .1), duration])].sort((a,b) => a-b);
    if (boundaries.length < 4) return [];
    const bars = boundaries.slice(0,-1).map((start,index) => {
      const end = boundaries[index + 1], energy = rangeStats(dynamics.times, dynamics.energy, start, end),
        low = rangeStats(dynamics.times, dynamics.low, start, end).mean,
        mid = rangeStats(dynamics.times, dynamics.mid, start, end).mean,
        high = rangeStats(dynamics.times, dynamics.high, start, end).mean,
        onset = rangeStats(dynamics.times, dynamics.onset, start, end).upper;
      const breadth = (low + mid + high) / 3;
      const beatDensity = (lowerBound(dynamics.beatTimes, end) - lowerBound(dynamics.beatTimes, start)) / Math.max(.5, end - start);
      return { start, end, energy: energy.mean, raw: energy.mean * .5 + breadth * .22 + onset * .18, beatDensity };
    });
    const densityValues = bars.map(bar => bar.beatDensity), densityLow = quantile(densityValues,.1), densityHigh = quantile(densityValues,.9);
    bars.forEach((bar,index) => {
      const density = clamp((bar.beatDensity - densityLow) / Math.max(1e-9, densityHigh - densityLow));
      const local = bars.slice(Math.max(0,index-1),Math.min(bars.length,index+2));
      bar.score = local.reduce((sum,item) => sum + item.raw,0) / local.length * .9 + density * .1;
    });
    const scores = bars.map(bar => bar.score), enter = Math.max(quantile(scores,.58), quantile(scores,.5) + (quantile(scores,.88)-quantile(scores,.5))*.28), exit = enter*.72;
    const active = bars.map(bar => bar.score >= enter);
    // Hysteresis keeps the loud plateau together instead of blinking section labels per bar.
    for (let i=1;i<active.length-1;i++) if (!active[i] && active[i-1] && active[i+1] && bars[i].score >= exit) active[i]=true;
    const groups=[];
    for(let i=0;i<bars.length;) {
      if(!active[i]) { i++; continue; }
      let end=i;
      while(end+1<bars.length && (active[end+1] || (bars[end+1].score>=exit && end+2<bars.length && active[end+2]))) end++;
      const peak=Math.max(...bars.slice(i,end+1).map(bar=>bar.score));
      if(bars[end].end-bars[i].start>=6 || (bars[end].end-bars[i].start>=4 && peak>=quantile(scores,.9)))
        groups.push({start:bars[i].start,end:bars[end].end,score:Number(peak.toFixed(3))});
      i=end+1;
    }
    return groups.sort((a,b)=>b.score-a.score).slice(0,4).sort((a,b)=>a.start-b.start);
  }
  function validateSections(sections, duration) {
    if (!Array.isArray(sections) || sections.length > 20) throw new Error('클라이맥스 구간은 최대 20개입니다.');
    const sorted = sections.map(s => ({ start: s?.start, end: s?.end })).sort((a,b) => a.start - b.start);
    let previousEnd = -1;
    for (const s of sorted) {
      if (!Number.isFinite(s.start) || !Number.isFinite(s.end) || s.start < 0 || s.end > duration || s.end - s.start < .1 || s.start < previousEnd)
        throw new Error('구간은 곡 범위 안에서 0.1초 이상이어야 하며 서로 겹칠 수 없습니다.');
      previousEnd = s.end;
    }
    return sorted;
  }
  function beatPulse(dynamics, time) {
    if (!dynamics?.beatTimes?.length) return { level:0, index:-1, age:Infinity, strength:0 };
    let index=lowerBound(dynamics.beatTimes,time); if(index===dynamics.beatTimes.length||dynamics.beatTimes[index]>time)index--;
    const age=index<0?Infinity:time-dynamics.beatTimes[index], strength=index<0?0:dynamics.beatStrengths[index];
    return { index, age, strength, level:age>=0&&age<.7?strength*Math.exp(-age/.16):0 };
  }
  function showFrame(events, time, pairs, sections, enabled = true, dynamics = null) {
    const frame = downbeatFrame(events, time, pairs, enabled);
    const section = sections.find(s => time >= s.start && time < s.end);
    if (!section && sections.some(s => events[frame.eventIndex] >= s.start && events[frame.eventIndex] < s.end)) {
      frame.a.fill(0); frame.b.fill(0); // Do not replay a climax event as a pair pulse on exit.
    }
    const energy = dynamics ? sampleSeries(dynamics.times,dynamics.energy,time) : 0;
    const pulse = beatPulse(dynamics,time);
    if (enabled && dynamics && !section && frame.slot >= 0) {
      const gate=clamp((energy-.06)/.28), level=clamp((.08*energy + pulse.level*(.35+.65*energy))*gate);
      frame.a.fill(0); frame.b.fill(0); frame.a[frame.slot]=level; frame.b[frame.slot]=level;
    }
    if (!enabled || !events.length || !section) return { ...frame, mode: 'pair', rgb: [255,208,138], colorName: '웜화이트', energy, pulse };
    // Entry uses the current bar's color. Only subsequent downbeats advance it.
    // Absolute event index makes seeks, loops and missed browser frames deterministic.
    const colorIndex = (frame.eventIndex + 1) % palette.length;
    const climaxLevel=dynamics?clamp(.48+energy*.2+pulse.level*(.22+.15*energy)):.75;
    return { ...frame, a: Array(pairs).fill(climaxLevel), b: Array(pairs).fill(climaxLevel), mode: 'climax',
      rgb: palette[colorIndex].rgb, colorName: palette[colorIndex].name, energy, pulse };
  }
  const api = { layers, eventsFor, available, validate, lowerBound, windowAt, readLoop, position, makeClicks, downbeatFrame, closeDownbeats, palette, validateSections, buildDynamics, autoClimaxSections, beatPulse, showFrame };
  if (typeof module !== 'undefined') module.exports = api;
  root.OfflineReviewCore = api;
})(globalThis);
