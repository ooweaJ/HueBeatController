const { test } = require('node:test');
const assert = require('node:assert/strict');
const C = require('../wwwroot/analysis-review-core.js');

function fixture() {
  return { durationSec: 5, candidates: {
    librosa: { status: 'complete', onsetsSec: [1, 2.25, 4], beatsSec: [1, 2, 3, 4] },
    'beat-this': { status: 'complete', beatsSec: [.5, 1, 1.5, 2], downbeatsSec: [.5] }
  }, waveform: { timesSec: [0, 1, 2], rms: [0, .1, .2], peak: [0, .4, .5] } };
}
test('onsets, model beats and downbeats remain separate', () => {
  const data = C.validate(fixture());
  assert.deepEqual(C.eventsFor(data, 'onset'), [1, 2.25, 4]);
  assert.deepEqual(C.eventsFor(data, 'beat'), [.5, 1, 1.5, 2]);
  assert.deepEqual(C.eventsFor(data, 'downbeat'), [.5]);
  assert.deepEqual(C.eventsFor(data, 'baseline'), [1, 2, 3, 4]);
});
test('missing model has disabled comparison, no silent fallback', () => {
  const data = fixture(); data.candidates['beat-this'] = {status:'not-run'};
  assert.equal(C.available(data, 'beat'), false);
  assert.deepEqual(C.eventsFor(data, 'beat'), []);
  assert.equal(C.available(data, 'onset'), true);
});
test('invalid timestamps and mismatched waveform are rejected', () => {
  for (const times of [[2, 1], [1, 1], [NaN], [-1], [5]]) {
    const data = fixture(); data.candidates.librosa.onsetsSec = times;
    assert.throws(() => C.validate(data));
  }
  const data = fixture(); data.waveform.peak.pop();
  assert.throws(() => C.validate(data));
});
test('click audio uses absolute candidate times at 44.1 and 48 kHz', () => {
  for (const rate of [44100, 48000]) {
    const audio = C.makeClicks([.25, .75], 1, rate);
    assert.equal(audio.length, rate);
    assert.ok(audio.subarray(0, Math.round(.25 * rate)).every(x => x === 0));
    assert.ok(audio.subarray(Math.round(.25 * rate), Math.round(.27 * rate)).some(x => x !== 0));
    assert.ok(audio.subarray(Math.round(.27 * rate), Math.round(.75 * rate)).every(x => x === 0));
    assert.ok(audio.subarray(Math.round(.77 * rate)).every(x => x === 0));
  }
});
test('end clicks are truncated safely and overlapping clicks are bounded', () => {
  const audio = C.makeClicks([0, .0001, .0002, .999], 1, 48000);
  assert.ok([...audio].every(Number.isFinite));
  assert.ok([...audio].every(x => Math.abs(x) <= .800001));
});
test('transport uses audio time rather than frame count', () => {
  assert.equal(C.position(10, 1.234, 228, null), 11.234);
  assert.equal(C.position(10, -.04, 228, null), 10);
  assert.equal(C.position(227, 4, 228, null), 228);
});
test('loop position wraps for arbitrarily delayed paint', () => {
  assert.equal(C.position(4, 1, 20, { start: 2, end: 5 }), 2);
  assert.equal(C.position(4, 10, 20, { start: 2, end: 5 }), 2);
  assert.equal(C.position(3, .5, 20, { start: 2, end: 5 }), 3.5);
});
test('invalid loop ranges cannot activate', () => {
  for (const [a,b] of [[-1,1], [2,1], [1,1.01], [0,6], [NaN,2]]) assert.throws(() => C.readLoop(a,b,5));
  assert.deepEqual(C.readLoop(1,3,5), {start:1,end:3});
});
test('detail window stays in audio boundaries', () => {
  assert.deepEqual(C.windowAt(0,228,10), {start:0,end:10});
  assert.deepEqual(C.windowAt(228,228,10), {start:218,end:228});
  assert.deepEqual(C.windowAt(1,3,10), {start:0,end:3});
});
test('visible counts honor half-open time windows', () => {
  const events = [0,1,2,3];
  assert.equal(C.lowerBound(events,3)-C.lowerBound(events,1),2);
  assert.equal(C.lowerBound([],5),0);
});
