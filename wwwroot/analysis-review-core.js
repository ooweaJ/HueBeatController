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
    if (!w || !Array.isArray(w.timesSec) || !w.timesSec.length || w.timesSec.length !== w.rms?.length || w.timesSec.length !== w.peak?.length) throw new Error('파형 데이터가 올바르지 않습니다.');
    let previous = -1;
    w.timesSec.forEach((t, i) => {
      if (!Number.isFinite(t) || t <= previous || t < 0 || t >= duration || !Number.isFinite(w.rms[i]) || w.rms[i] < 0 || !Number.isFinite(w.peak[i]) || w.peak[i] < 0) throw new Error('파형 시간축 또는 음량이 손상되었습니다.');
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
  const api = { layers, eventsFor, available, validate, lowerBound, windowAt, readLoop, position, makeClicks };
  if (typeof module !== 'undefined') module.exports = api;
  root.OfflineReviewCore = api;
})(globalThis);
