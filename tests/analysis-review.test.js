const { test } = require('node:test');
const assert = require('node:assert/strict');
const C = require('../wwwroot/analysis-review-core.js');

function fixture() {
  return { durationSec: 5, candidates: {
    librosa: { status: 'complete', onsetsSec: [1, 2.25, 4], beatsSec: [1, 2, 3, 4] },
    'beat-this': { status: 'complete', beatsSec: [.5, 1, 1.5, 2], downbeatsSec: [.5] }
  }, waveform: { timesSec: [0, 1, 2], rms: [0, .1, .2], peak: [0, .4, .5],
    lowPower:[0,.2,.4],midPower:[0,.1,.3],highPower:[0,.05,.2],onsetStrength:[0,.5,.3] } };
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

test('manual sections validate, sort without mutation, and reject invalid/overlapping ranges', () => {
  const sections=[{start:5,end:7},{start:1,end:3}];
  assert.deepEqual(C.validateSections(sections,10),[sections[1],sections[0]]);
  assert.equal(sections[0].start,5);
  for(const s of [[{start:1,end:1}], [{start:-1,end:2}], [{start:1,end:11}], [{start:NaN,end:2}],
    [{start:1,end:4},{start:3,end:5}], [null], Array(21).fill({start:1,end:2})]) assert.throws(()=>C.validateSections(s,10));
  assert.deepEqual(C.validateSections([{start:0,end:2},{start:2,end:3}],10),[{start:0,end:2},{start:2,end:3}]);
});
test('climax holds every pair at 75 percent with color changes only on downbeats', () => {
  const events=[1,3,5,7], sections=[{start:2,end:6}];
  for(const pairs of [1,2,3,4,5]) {
    const a=C.showFrame(events,2,pairs,sections), b=C.showFrame(events,2.99,pairs,sections);
    assert.equal(a.mode,'climax'); assert.deepEqual(a.a,Array(pairs).fill(.75)); assert.deepEqual(a.a,a.b);
    assert.deepEqual(a.rgb,b.rgb);
    assert.notDeepEqual(a.rgb,C.showFrame(events,3,pairs,sections).rgb);
    assert.deepEqual(C.showFrame(events,3,pairs,sections).rgb,C.showFrame(events,4.99,pairs,sections).rgb);
    assert.notDeepEqual(a.rgb,C.showFrame(events,5,pairs,sections).rgb);
  }
});
test('section exit does not resurrect a climax pulse and next outside event resumes pair effect', () => {
  const events=[1,3,5], sections=[{start:2,end:3.1}];
  assert.equal(C.showFrame(events,3.099,5,sections).mode,'climax');
  assert.deepEqual(C.showFrame(events,3.1,5,sections).a,[0,0,0,0,0]);
  assert.deepEqual(C.showFrame(events,5.02,5,sections).a,C.downbeatFrame(events,5.02,5).a);
});
test('no sections preserves old effect; disabled and missing candidates stay dark', () => {
  assert.deepEqual(C.showFrame([1,2],1.02,3,[]).a,C.downbeatFrame([1,2],1.02,3).a);
  const sections=[{start:0,end:5}];
  assert.deepEqual(C.showFrame([1,2],1.02,3,sections,false).a,[0,0,0]);
  assert.deepEqual(C.showFrame([],1.02,3,sections).a,[0,0,0]);
});
test('climax sampling is deterministic after seek/loop and does not alter analysis events', () => {
  const events=[1,3,5,7,9], original=[...events], sections=[{start:2,end:8}];
  const expected=C.showFrame(events,5.4,5,sections);
  for(let t=0;t<10;t+=.04) C.showFrame(events,t,5,sections);
  assert.deepEqual(C.showFrame(events,5.4,5,sections),expected);
  assert.deepEqual(C.showFrame(events,C.position(5.4,6,10,{start:2,end:8}),5,sections),expected);
  assert.deepEqual(events,original);
});
test('dynamics normalizes analysis features and scores beat accents without changing arrays', () => {
  const data=fixture(), rms=[...data.waveform.rms], dynamics=C.buildDynamics(data);
  assert.equal(dynamics.energy.length,data.waveform.timesSec.length);
  assert.equal(dynamics.climaxBeatStrengths.length,C.eventsFor(data,'beat').length);
  assert.equal(dynamics.impactTimes.length,dynamics.impactStrengths.length);
  assert.equal(dynamics.lightingDownbeats.length,dynamics.downbeatStrengths.length);
  assert.equal(dynamics.accentTimes.length,dynamics.accentStrengths.length);
  assert.ok(dynamics.accentThreshold>=.62&&dynamics.accentThreshold<=.72);
  assert.ok(dynamics.climaxBeatStrengths.every(value=>value>=0&&value<=1));
  assert.deepEqual(data.waveform.rms,rms);
});
test('lighting downbeats remove close duplicates relative to the last accepted event', () => {
  assert.deepEqual(C.dedupeEvents([1,1.24,2,2.5,3]),[1,2,3]);
});
test('intro uses downbeats only and fully decays before an in-bar accent', () => {
  const dynamics={times:[0,1,2,3,4],energy:[.5,.5,.5,.5,.5],openingEnd:4,downbeatStrengths:[.8,.8],accentTimes:[1.5],accentStrengths:[.35]};
  const attack=C.showFrame([1,3],1.01,3,[],true,dynamics),between=C.showFrame([1,3],1.6,3,[],true,dynamics);
  assert.equal(attack.mode,'intro'); assert.ok(attack.a[0]>.7); assert.deepEqual(attack.a.slice(1),[0,0]);
  assert.deepEqual(between.a,[0,0,0]);
});
test('general scene permits one restrained accent without advancing the pair', () => {
  const dynamics={times:[0,1,2,3,4],energy:[.5,.5,.5,.5,.5],openingEnd:1.2,downbeatStrengths:[.8,.8],accentTimes:[2],accentStrengths:[.3]};
  const accent=C.showFrame([1,3],2.01,3,[],true,dynamics),next=C.showFrame([1,3],3.01,3,[],true,dynamics);
  assert.equal(accent.mode,'groove'); assert.equal(accent.slot,0); assert.ok(accent.a[0]>.25&&accent.a[0]<.4);
  assert.equal(next.slot,1); assert.ok(next.a[1]>.7); assert.equal(next.a[0],0);
});
test('climax keeps all lamps on while beats add brightness and only downbeats change color', () => {
  const dynamics={times:[0,1,2,3,4,5],energy:[.6,.6,.6,.6,.6,.6],beatTimes:[1,2,3,4],climaxBeatStrengths:[.8,.8,.8,.8],impactTimes:[],impactStrengths:[]};
  const sections=[{start:.5,end:5}], events=[1,3];
  const attack=C.showFrame(events,2.01,3,sections,true,dynamics), decay=C.showFrame(events,2.6,3,sections,true,dynamics);
  assert.ok(attack.a[0]>decay.a[0]); assert.deepEqual(attack.a,attack.b);
  assert.deepEqual(attack.rgb,decay.rgb);
  assert.notDeepEqual(decay.rgb,C.showFrame(events,3,3,sections,true,dynamics).rgb);
});
test('normal impacts are detected from audio peaks independently of beat timestamps', () => {
  const times=Array.from({length:40},(_,i)=>i/10), spike=times.map(t=>Math.abs(t-1.3)<.001?1:0);
  const data={durationSec:4,candidates:{librosa:{status:'complete',onsetsSec:[],beatsSec:[]},'beat-this':{status:'complete',beatsSec:[1,2,3],downbeatsSec:[0,2]}},
    waveform:{timesSec:times,rms:times.map(()=>.2),peak:times.map(()=>.3),lowPower:spike,midPower:times.map(()=>.1),highPower:times.map(()=>.1),onsetStrength:spike}};
  const dynamics=C.buildDynamics(C.validate(data));
  assert.ok(dynamics.impactTimes.some(time=>Math.abs(time-1.3)<.001));
  assert.ok(!dynamics.beatTimes.some(time=>Math.abs(time-1.3)<.001));
});
test('automatic climax candidates use sustained bar energy and snap to downbeats', () => {
  const times=Array.from({length:120},(_,i)=>i), high=i=>times.map(t=>t>=40&&t<82?i:.04);
  const data={durationSec:120,candidates:{librosa:{status:'complete',onsetsSec:[],beatsSec:[]},'beat-this':{status:'complete',beatsSec:Array.from({length:60},(_,i)=>i*2),downbeatsSec:Array.from({length:15},(_,i)=>i*8)}},
    waveform:{timesSec:times,rms:high(.8),peak:high(.9),lowPower:high(10),midPower:high(8),highPower:high(6),onsetStrength:high(.7)}};
  const sections=C.autoClimaxSections(C.validate(data));
  assert.ok(sections.length>=1); assert.ok(sections.some(section=>section.start>=32&&section.start<=48&&section.end>=72&&section.end<=88));
  for(const section of sections){assert.ok(data.candidates['beat-this'].downbeatsSec.includes(section.start)||section.start===0);assert.ok(data.candidates['beat-this'].downbeatsSec.includes(section.end)||section.end===120);}
});
test('automatic climax exits on spectral release even when RMS stays loud', () => {
  const times=Array.from({length:120},(_,i)=>i), inRange=(t,a,b,high,low=.04)=>t>=a&&t<b?high:low;
  const data={durationSec:120,candidates:{librosa:{status:'complete',onsetsSec:[],beatsSec:[]},'beat-this':{status:'complete',beatsSec:Array.from({length:60},(_,i)=>i*2),downbeatsSec:Array.from({length:15},(_,i)=>i*8)}},
    waveform:{timesSec:times,rms:times.map(t=>inRange(t,40,104,.8)),peak:times.map(t=>inRange(t,40,104,.9)),
      lowPower:times.map(t=>inRange(t,40,104,10)),midPower:times.map(t=>inRange(t,40,104,8)),
      highPower:times.map(t=>inRange(t,40,80,6)),onsetStrength:times.map(t=>inRange(t,40,80,.8))}};
  const sections=C.autoClimaxSections(C.validate(data));
  assert.equal(sections.length,1); assert.equal(sections[0].end,80);
});
