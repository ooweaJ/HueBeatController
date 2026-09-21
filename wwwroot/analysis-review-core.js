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
    if (data?.rhythm && ['beat', 'downbeat', 'onset'].includes(layer)) {
      if (layer !== 'onset' && data.rhythm.status !== 'complete') return [];
      return data.rhythm[spec.field] || [];
    }
    const candidate = data?.candidates?.[spec?.candidate];
    return candidate?.status === 'complete' && Array.isArray(candidate[spec.field]) ? candidate[spec.field] : [];
  }
  function available(data, layer) {
    if (data?.rhythm && ['beat', 'downbeat'].includes(layer)) return data.rhythm.status === 'complete';
    return data?.candidates?.[layers[layer].candidate]?.status === 'complete';
  }
  function validate(data) {
    const duration = data?.durationSec;
    if (!Number.isFinite(duration) || duration <= 0 || duration > 600) throw new Error('지원 범위를 벗어난 음원 길이입니다.');
    if (data.rhythm && (data.rhythm.schemaVersion !== 1 || data.rhythm.source !== 'beat-this' || data.rhythm.timeOriginSec !== 0 ||
        !['complete', 'not-run'].includes(data.rhythm.status) ||
        ['beatsSec', 'downbeatsSec', 'onsetsSec'].some(key => !Array.isArray(data.rhythm[key]))))
      throw new Error('박자·마디 첫 박자 분석 형식이 올바르지 않습니다.');
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
    if (!Number.isInteger(pairs) || pairs < 1 || pairs > 8) throw new Error('모의 배치는 1~8쌍입니다.');
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
  function dedupeEvents(events, minimumGap = .75) {
    const cleaned=[];
    for(const time of events) if(!cleaned.length||time-cleaned.at(-1)>=minimumGap)cleaned.push(time);
    return cleaned;
  }
  function buildDynamics(data) {
    const w = data.waveform, times = w.timesSec;
    const energy = normalizeFeature(w.rms), low = normalizeFeature(w.lowPower), mid = normalizeFeature(w.midPower),
      high = normalizeFeature(w.highPower), onset = normalizeFeature(w.onsetStrength);
    const beatTimes = eventsFor(data, 'beat');
    const featureStep = times.length > 1 ? Math.max(.001, times[1] - times[0]) : .02;
    const beatMeasures = beatTimes.map(time => {
      const energyAtBeat = sampleSeries(times, energy, time);
      const center = lowerBound(times, time), radius = Math.max(1, Math.round(.07 / featureStep));
      const localOnset = Math.max(0, ...onset.slice(Math.max(0, center - radius), Math.min(onset.length, center + radius + 1)));
      const localLow = Math.max(0, ...low.slice(Math.max(0, center - radius), Math.min(low.length, center + radius + 1)));
      const lowRise = Math.max(0, localLow - sampleSeries(times, low, Math.max(0, time - .12)));
      return { time, energy: energyAtBeat, onset: localOnset,
        accent: clamp(localOnset * .58 + lowRise * .27 + energyAtBeat * .15) };
    });
    const climaxBeatStrengths = beatMeasures.map(item => clamp(.45 + item.energy * .3 + item.onset * .25));
    // Outside a climax, actual attacks are events of their own. Beat grids are not commands.
    const riseFrames=Math.max(1,Math.round(.12/featureStep)),historyFrames=Math.max(2,Math.round(.2/featureStep));
    const impactEnvelope=onset.map((value,index)=>clamp(value*.65+Math.max(0,low[index]-low[Math.max(0,index-riseFrames)])*.35));
    const impactThreshold=Math.max(.55,quantile(impactEnvelope,.92)), impactTimes=[], impactStrengths=[];
    for(let index=1;index<impactEnvelope.length-1;index++) {
      const value=impactEnvelope[index];
      if(value<impactThreshold||value<=impactEnvelope[index-1]||value<impactEnvelope[index+1])continue;
      const history=impactEnvelope.slice(Math.max(0,index-historyFrames),index);
      const baseline=history.reduce((sum,item)=>sum+item,0)/Math.max(1,history.length);
      if(value-baseline<.18)continue;
      const time=times[index],strength=clamp(.55+(value-impactThreshold)/Math.max(.01,1-impactThreshold)*.45),last=impactTimes.length-1;
      if(last>=0&&time-impactTimes[last]<.45) {
        if(strength>impactStrengths[last]){impactTimes[last]=time;impactStrengths[last]=strength;}
      } else {impactTimes.push(time);impactStrengths.push(strength);}
    }
    // Lighting scenes use a cleaned downbeat track. Silent bars do not consume a lamp slot,
    // and an implausibly close duplicate (for example 240 ms later) cannot create a double flash.
    const structuralDownbeats=dedupeEvents(eventsFor(data,'downbeat'));
    const bars=structuralDownbeats.map((start,index)=>{
      const end=structuralDownbeats[index+1]??data.durationSec;
      const energyStats=rangeStats(times,energy,start,end),onsetStats=rangeStats(times,onset,start,end);
      // Relative energy describes dynamics, not silence: quiet intros can have
      // zero normalized energy even though the original audio is clearly audible.
      const audible = rangeStats(times,w.rms,start,end).upper > .001;
      return {start,end,energy:energyStats.mean,onset:onsetStats.upper,
        active:audible};
    });
    const activeBars=bars.filter(bar=>bar.active),lightingDownbeats=activeBars.map(bar=>bar.start);
    const downbeatStrengths=activeBars.map(bar=>clamp(.68+bar.energy*.25));
    // The opening is deliberately simple for one conventional eight-bar phrase. Later bars may
    // add only one restrained accent; accents never advance the lamp pair or change the colour.
    const openingEnd=activeBars[8]?.start??data.durationSec;
    const bestByBar=bars.map(bar=>{
      const candidates=beatMeasures.filter(item=>item.time>bar.start+.18&&item.time<bar.end-.18);
      return candidates.reduce((best,item)=>!best||item.accent>best.accent?item:best,null);
    });
    const accentCandidates=bestByBar.filter(Boolean),accentThreshold=Math.min(.72,Math.max(.62,quantile(accentCandidates.map(item=>item.accent),.6)));
    const accentTimes=[],accentStrengths=[];
    bestByBar.forEach((item,index)=>{
      if(!item||!bars[index].active||item.accent<accentThreshold)return;
      accentTimes.push(item.time);
      accentStrengths.push(clamp(.18+(item.accent-accentThreshold)/Math.max(.01,1-accentThreshold)*.2));
    });
    const fillBars = bars.map(bar => {
      const inside = beatTimes.slice(lowerBound(beatTimes, bar.start + .08), lowerBound(beatTimes, bar.end - .08));
      const measured = inside.length === 3;
      return { ...bar, third: measured ? inside[1] : bar.start + (bar.end - bar.start) * .5,
        fourth: measured ? inside[2] : bar.start + (bar.end - bar.start) * .75, measured };
    });
    return { times, energy, low, mid, high, onset, beatTimes, climaxBeatStrengths, fillBars,
      beatAccentStrengths:beatMeasures.map(item=>item.accent),
      impactTimes, impactStrengths, impactThreshold, lightingDownbeats, downbeatStrengths,
      openingEnd, accentTimes, accentStrengths, accentThreshold };
  }
  function autoClimaxSections(data, dynamics = buildDynamics(data)) {
    const duration = data.durationSec, rawDownbeats = eventsFor(data, 'downbeat');
    // Ignore implausibly short gaps for structural scoring. The review candidates stay untouched,
    // while the lighting plan uses the same cleaned track to avoid visible double flashes.
    const downbeats = dedupeEvents(rawDownbeats);
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
      return { start, end, energy: energy.mean, low, mid, high, onset,
        raw: energy.mean * .5 + breadth * .22 + onset * .18, beatDensity };
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
      // The plateau threshold often fires one or two bars after the musical entrance.
      // Include only already-loud, near-threshold lead-in bars; stop at a real energy change.
      let start=i;
      for(let step=0;step<2&&start>0;step++) {
        const previous=bars[start-1];
        if(previous.energy<Math.max(.46,bars[i].energy*.78))break;
        start--;
      }
      // A section can stay loud after its musical release. A simultaneous loss of high-band
      // energy and attack strength near the tail is a stronger exit signal than RMS alone.
      let adjustedEnd=end;
      for(let cursor=Math.max(start+1,end-2);cursor<=end;cursor++) {
        const previous=bars[cursor-1], current=bars[cursor];
        if(previous.high-current.high>=.28&&previous.onset-current.onset>=.1){adjustedEnd=cursor-1;break;}
      }
      const selected=bars.slice(start,adjustedEnd+1),peak=Math.max(...selected.map(bar=>bar.score));
      const hasMusicalTexture=Math.max(...selected.map(bar=>bar.high))>=.3||Math.max(...selected.map(bar=>bar.onset))>=.72;
      if(hasMusicalTexture&&(bars[adjustedEnd].end-bars[start].start>=6 || (bars[adjustedEnd].end-bars[start].start>=4 && peak>=quantile(scores,.9))))
        groups.push({start:bars[start].start,end:bars[adjustedEnd].end,score:Number(peak.toFixed(3))});
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
  function eventPulse(times, strengths, time, release) {
    if (!times?.length) return { level:0, index:-1, age:Infinity, strength:0 };
    let index=lowerBound(times,time); if(index===times.length||times[index]>time)index--;
    const age=index<0?Infinity:time-times[index], strength=index<0?0:(strengths?.[index]??1);
    return { index, age, strength, level:age>=0&&age<release?strength*Math.pow(1-age/release,2):0 };
  }
  function beatPulse(dynamics,time){return eventPulse(dynamics?.beatTimes,dynamics?.climaxBeatStrengths,time,.34);}
  function climaxBeatBlackout(dynamics,time,section){
    const times=dynamics?.beatTimes||[],nextIndex=lowerBound(times,time+.000001),next=times[nextIndex];
    if(next===undefined||next<=section.start+.2||next>=section.end)return false;
    const previous=Math.max(section.start,times[nextIndex-1]??section.start);
    const duration=Math.min(.17,(next-previous)*.4);
    return next-time<=duration;
  }
  function climaxBeatPunch(pulse){
    return pulse.index<0||pulse.age<0||pulse.age>=.28?0:Math.pow(1-clamp((pulse.age-.1)/.18),2);
  }
  function impactPulse(dynamics,time){return eventPulse(dynamics?.impactTimes,dynamics?.impactStrengths,time,.42);}
  function stageAt(time, sections, dynamics) {
    if(sections.some(section=>time>=section.start&&time<section.end))return 'climax';
    const firstClimax=sections.length?Math.min(...sections.map(section=>section.start)):Infinity;
    const completedClimax=sections.some(section=>section.end<=time);
    return !completedClimax&&time<Math.min(dynamics?.openingEnd??0,firstClimax)?'intro':'groove';
  }
  // Pure time sampling: accumulating lamps must look identical after seeking or looping.
  function variationStyle(pairs, variation, colorStep = variation) {
    const type = variation % 4, natural = Array.from({length:pairs},(_,i)=>i);
    const center = [...natural].sort((a,b)=>Math.abs(a-(pairs-1)/2)-Math.abs(b-(pairs-1)/2)||a-b);
    const outside = []; for(let a=0,b=pairs-1;a<=b;a++,b--){outside.push(a);if(a!==b)outside.push(b);}
    const order = [natural,[...natural].reverse(),center,outside][type];
    const pairColors = natural.map(i=>palette[(colorStep+(type===2?i%2:type===3?i:0))%palette.length].rgb);
    return {order,pairColors,pattern:['정순 · 단색','역순 · 단색','중앙→바깥 · 두 색','바깥→중앙 · 여러 색'][type]};
  }
  function accumulationFrame(time, pairs, sections, dynamics, enabled, mode, waveEnabled = false) {
    const bars = dynamics.fillBars, levels = Array(pairs).fill(0);
    let index = lowerBound(bars.map(bar => bar.start), time);
    if (index === bars.length || bars[index].start > time) index--;
    const blocked = bar => !bar.active || sections.some(s => s.start < Math.min(time, bar.end) && s.end > bar.start);
    let first = index;
    while (first > 0 && !blocked(bars[first - 1])) first--;
    const step = Math.max(0, index - first), barInCycle = step % 8, cycle = Math.floor(step / 8);
    const completed = sections.filter(s=>s.end <= (bars[index]?.start ?? 0)).length;
    const variation = cycle + completed, style = variationStyle(pairs,variation,cycle+completed*2);
    const color = palette[(cycle+completed*2) % palette.length];
    let phase = 'dark', filled = 0, measured = true;
    const bar = bars[index];
    if (enabled && bar && time < bar.end && !blocked(bar)) {
      filled = Math.ceil((barInCycle + 1) * pairs / 8);
      phase = 'fill'; measured = bar.measured;
      let level = (32 + 28 * (barInCycle + 1) / 8) / 100;
      if (barInCycle === 7) {
        phase = 'hold';
        if (time >= bar.third && time < bar.fourth) {
          level *= 1 - clamp((time - bar.third) / Math.max(.001, (bar.fourth - bar.third) * .35));
          phase = level > 0 ? 'fade' : 'blackout';
        } else if (time >= bar.fourth) {
          level = Math.pow(1 - clamp((time - bar.fourth) / Math.max(.001, (bar.end - bar.fourth) * .65)), 2);
          phase = level > 0 ? 'punch' : 'blackout';
        }
      }
      for (let i = 0; i < filled; i++) levels[style.order[i]] = level;
      // Optional restrained variation: only the third regular eight-bar cycle.
      // Keep every accumulated pair lit; move brightness, not position or colour.
      if (waveEnabled && mode === 'groove' && cycle % 3 === 2 && barInCycle < 7 && filled > 1) {
        const progress=clamp((time-bar.start)/Math.max(.001,bar.end-bar.start));
        const center=progress*(filled-1);
        for(let position=0;position<filled;position++){
          const distance=Math.abs(position-center),accent=Math.max(0,1-distance);
          levels[style.order[position]]=Math.min(.85,level+.22*accent);
        }
      }
    }
    const wave=waveEnabled&&mode==='groove'&&cycle%3===2&&barInCycle<7&&filled>1&&phase==='fill';
    return { a: levels, b: [...levels], mode, rgb: color.rgb, pairColors: style.pairColors, fillOrder: style.order, pattern: wave?`${style.pattern} · 밝기 물결`:style.pattern,
      colorName: variation%4>=2 ? (variation%4===2?'두 색':'여러 색') : color.name,
      energy: sampleSeries(dynamics.times, dynamics.energy, time), eventIndex: index, slot: filled ? style.order[filled-1] : -1,
      accumulation: { bar: barInCycle + 1, cycle: cycle + 1, filled, phase, measured, wave },
      pulse: { kind: phase === 'punch' ? 'finish' : 'downbeat', level: Math.max(...levels), index } };
  }
  function preparation(section, sections, dynamics, pairs) {
    const bars = dynamics.fillBars;
    let last = lowerBound(bars.map(b=>b.start),section.start)-1;
    if(last<0 || bars[last].end < section.start-.001) return null;
    const selected=[];
    for(let i=last;i>=0&&selected.length<4;i--){
      const b=bars[i];
      if(!b.active || sections.some(s=>s!==section && s.start<b.end && s.end>b.start))break;
      selected.unshift(b);
    }
    if(!selected.length)return null;
    const start=selected[0].start;
    const previous=accumulationFrame(start-.000001,pairs,sections,dynamics,true,'groove');
    const seed=previous.a.some(v=>v>0)?previous:accumulationFrame(start,pairs,sections,dynamics,true,'groove');
    const lit=previous.a.map((v,i)=>v>0?i:-1).filter(i=>i>=0);
    return {selected,start,seed,lit,remaining:seed.fillOrder.filter(i=>!lit.includes(i)),
      level:Math.max(.355,Math.min(.65,Math.max(...previous.a)))};
  }
  function preparationFrame(time,pairs,sections,dynamics,enabled,section) {
    const plan=preparation(section,sections,dynamics,pairs);
    if(!plan || time<plan.start)return null;
    const index=Math.max(0,lowerBound(plan.selected.map(b=>b.start),time+.000001)-1);
    const added=Math.ceil(plan.remaining.length*Math.min(1,(index+1)/Math.max(1,plan.selected.length-1)));
    const lit=[...plan.lit,...plan.remaining.slice(0,added)];
    const progress=clamp((time-plan.start)/Math.max(.001,plan.selected.at(-1).start-plan.start));
    const ending=index===plan.selected.length-1;
    const fadeStart=plan.selected.at(-1).start;
    const fadeDuration=Math.min(.2,(section.start-fadeStart)/2);
    const fade=ending?(time>=fadeStart+fadeDuration?0:Math.pow(1-clamp((time-fadeStart)/Math.max(.000001,fadeDuration)),2)):1;
    const level=(ending?(plan.selected.length===1?plan.level:.7):plan.level+(.7-plan.level)*progress)*fade;
    const visible=ending&&plan.selected.length===1?plan.lit:lit;
    const levels=Array.from({length:pairs},(_,i)=>enabled&&visible.includes(i)?level:0);
    const phase=ending?(level>0&&visible.length?'fade':'blackout'):'fill';
    return {...plan.seed,a:levels,b:[...levels],mode:'buildup',pattern:'클라이맥스 진입 준비',
      accumulation:null,preparation:{bar:index+1,total:plan.selected.length,filled:levels.filter(v=>v>0).length,phase,end:section.start},
      pulse:{kind:'buildup',level:enabled?level:0,index}};
  }
  function showFrame(events, time, pairs, sections, enabled = true, dynamics = null, options = {}) {
    const frame = downbeatFrame(events, time, pairs, enabled);
    const section = sections.find(s => time >= s.start && time < s.end);
    if (!section && dynamics?.fillBars) {
      const next=sections.filter(s=>s.start>time).sort((a,b)=>a.start-b.start)[0];
      const buildup=next?preparationFrame(time,pairs,sections,dynamics,enabled,next):null;
      return buildup || accumulationFrame(time, pairs, sections, dynamics, enabled, stageAt(time, sections, dynamics), options.wave === true);
    }
    const latestEvent=events[frame.eventIndex], latestWasClimax=!section&&sections.some(s => latestEvent >= s.start && latestEvent < s.end);
    if (latestWasClimax) {
      frame.a.fill(0); frame.b.fill(0); // Do not replay a climax event as a pair pulse on exit.
    }
    const energy = dynamics ? sampleSeries(dynamics.times,dynamics.energy,time) : 0;
    const stage=stageAt(time,sections,dynamics);
    const mainPulse=eventPulse(events,dynamics?.downbeatStrengths,time,.58);
    const accentPulse=stage==='groove'?eventPulse(dynamics?.accentTimes,dynamics?.accentStrengths,time,.28):{level:0,index:-1,age:Infinity,strength:0};
    const pulse=section?{...beatPulse(dynamics,time),kind:'beat'}
      : mainPulse.level>=accentPulse.level?{...mainPulse,kind:'downbeat'}:{...accentPulse,kind:'accent'};
    if (enabled && dynamics && !section && frame.slot >= 0) {
      const level=latestWasClimax?0:clamp(pulse.level);
      frame.a.fill(0); frame.b.fill(0); frame.a[frame.slot]=level; frame.b[frame.slot]=level;
    }
    if (!enabled || !events.length || !section) return { ...frame, mode: stage, rgb: [255,208,138], colorName: '웜화이트', energy, pulse };
    const blackout=climaxBeatBlackout(dynamics,time,section),beatAttack=climaxBeatPunch(pulse);
    // Entry uses the current bar's color. Only subsequent downbeats advance it.
    // Absolute event index makes seeks, loops and missed browser frames deterministic.
    const colorIndex = (frame.eventIndex + 1) % palette.length;
    if (dynamics?.fillBars) {
      const entry = Math.max(0, lowerBound(events, section.start + .00001) - 1);
      const bar = Math.max(0,frame.eventIndex-entry), colorPhase = Math.floor(bar/4)%3;
      const plan=preparation(section,sections,dynamics,pairs);
      const previousColor=plan?.seed.pairColors[0];
      const entryColor=previousColor?((palette.findIndex(c=>c.rgb.every((v,i)=>v===previousColor[i]))+1)%palette.length):colorIndex;
      const sceneColor=(entryColor+bar)%palette.length;
      const style = variationStyle(pairs,colorPhase===0?0:colorPhase===1?2:3,sceneColor);
      const alternating = Math.floor(bar/2)%2===1;
      const nextBeat=dynamics.beatTimes?.find(t=>t>section.start+.05)??section.start+.5;
      const entrance=Math.pow(1-clamp((time-section.start)/Math.max(.001,(nextBeat-section.start)*.65)),2);
      const baseline=clamp(.48+energy*.2);
      const levels = Array.from({length:pairs},(_,i)=>blackout?0:
        baseline+(1-baseline)*Math.max(entrance,(!alternating||i%2===pulse.index%2)?beatAttack:0));
      return {...frame,a:levels,b:[...levels],mode:'climax',rgb:palette[sceneColor].rgb,pairColors:style.pairColors,
        colorName:['단색','두 색','여러 색'][colorPhase],pattern:blackout?'박자 직전 암전':alternating?'홀짝 교대 펀치':'전체 펀치',energy,pulse};
    }
    const baseline=clamp(.48+energy*.2),climaxLevel=dynamics?(blackout?0:baseline+(1-baseline)*beatAttack):.75;
    return { ...frame, a: Array(pairs).fill(climaxLevel), b: Array(pairs).fill(climaxLevel), mode: 'climax',
      rgb: palette[colorIndex].rgb, colorName: palette[colorIndex].name, energy, pulse };
  }
  const api = { layers, eventsFor, available, validate, lowerBound, windowAt, readLoop, position, makeClicks, downbeatFrame, closeDownbeats, palette, validateSections, dedupeEvents, buildDynamics, autoClimaxSections, beatPulse, impactPulse, stageAt, showFrame };
  if (typeof module !== 'undefined') module.exports = api;
  root.OfflineReviewCore = api;
})(globalThis);
