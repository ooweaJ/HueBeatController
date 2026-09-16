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
test('downbeat preview is dark before first event and after decay', () => {
  for (const time of [0, .99, 1.6, 1.99, 5]) {
    assert.deepEqual(C.downbeatFrame([1,2],time,3).a,[0,0,0]);
  }
  assert.equal(C.downbeatFrame([1,2],1.015,3).a[0] > .99,true);
});
test('every new candidate replaces the previous pair, including close candidates', () => {
  const frame = C.downbeatFrame([1,1.24],1.255,5);
  assert.equal(frame.a[0],0);
  assert.ok(frame.a[1] > .99);
  assert.deepEqual(frame.a,frame.b);
  assert.equal(frame.a.filter(x=>x>0).length,1);
});
test('pair count is dynamic and circular, with all remaining lamps dark', () => {
  for (const pairs of [1,2,3,4,5]) {
    const frame = C.downbeatFrame([1,2,3,4,5,6],6.02,pairs);
    assert.equal(frame.a.length,pairs);
    assert.equal(frame.slot,5%pairs);
    assert.ok(frame.a[5%pairs] > .9);
    assert.deepEqual(frame.a,frame.b);
  }
  assert.throws(()=>C.downbeatFrame([],0,6));
});
test('disabled preview is dark and sampling has no history dependency', () => {
  const events=[1,2,3,4];
  const expected=C.downbeatFrame(events,3.1,5);
  for(let t=0;t<3;t+=.016) C.downbeatFrame(events,t,5);
  assert.deepEqual(C.downbeatFrame(events,3.1,5),expected);
  assert.deepEqual(C.downbeatFrame(events,3.1,5,false).a,[0,0,0,0,0]);
  assert.deepEqual(C.downbeatFrame([],3.1,5).a,[0,0,0,0,0]);
});
test('close candidate review flags anomalous spacing but never changes input', () => {
  const events=[52,54.02,56,57.76,58,60.02,62.02];
  const copy=[...events], flags=C.closeDownbeats(events);
  assert.equal(flags.length,1);
  assert.equal(flags[0].first,57.76);
  assert.equal(flags[0].second,58);
  assert.ok(Math.abs(flags[0].gap-.24)<1e-8);
  assert.deepEqual(events,copy);
});
test('regular fast music is not marked as a duplicate solely due to short gaps', () => {
  assert.deepEqual(C.closeDownbeats([0,.25,.5,.75,1,1.25,1.5]),[]);
  assert.deepEqual(C.closeDownbeats([0,.2]),[]);
});
