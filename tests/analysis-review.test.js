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

test('canonical rhythm keeps variable beat spacing and downbeat phase without rebuilding a four-beat grid', () => {
  const data = fixture();
  data.rhythm = { schemaVersion: 1, source: 'beat-this', status: 'complete', timeOriginSec: 0,
    beatsSec: [.14, .65, 1.19, 1.72, 2.3], downbeatsSec: [.65, 2.3], onsetsSec: [.2, 1.3] };
  C.validate(data);
  assert.deepEqual(C.eventsFor(data, 'beat'), data.rhythm.beatsSec);
  assert.deepEqual(C.eventsFor(data, 'downbeat'), [.65, 2.3]);
  assert.deepEqual(C.buildDynamics(data).beatTimes, data.rhythm.beatsSec);
  const frame = C.downbeatFrame(C.eventsFor(data, 'downbeat'), 2.32, 8);
  assert.equal(frame.slot, 1);
  assert.deepEqual(frame.a, frame.b);
  assert.equal(frame.a.length, 8);
  data.rhythm.status = 'not-run';
  assert.deepEqual(C.eventsFor(data, 'downbeat'), []);
  assert.equal(C.available(data, 'beat'), false);
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
  for (const pairs of [1,2,3,4,5,6,7,8]) {
    const frame = C.downbeatFrame([1,2,3,4,5,6],6.02,pairs);
    assert.equal(frame.a.length,pairs);
    assert.equal(frame.slot,5%pairs);
    assert.ok(frame.a[5%pairs] > .9);
    assert.deepEqual(frame.a,frame.b);
  }
  assert.throws(()=>C.downbeatFrame([],0,9));
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

function accumulationFixture() {
  const events=Array.from({length:18},(_,i)=>i*2);
  const dynamics={times:[0,36],energy:[.5,.5],openingEnd:16,
    beatTimes:Array.from({length:72},(_,i)=>i*.5),climaxBeatStrengths:Array(72).fill(.8),
    fillBars:events.map(start=>({start,end:start+2,active:true,third:start+1,fourth:start+1.5,measured:true}))};
  return {events,dynamics,frame:(t,sections=[],enabled=true,pairs=8)=>C.showFrame(events,t,pairs,sections,enabled,dynamics)};
}
test('quiet intro starts at the first downbeat even when later sections are much louder; real silence stays dark', () => {
  const times=Array.from({length:400},(_,i)=>i*.1);
  const levels=times.map(t=>t<4?.02:t<8?0:t<12?.00001:.8);
  const data={durationSec:40,candidates:{'beat-this':{status:'complete',beatsSec:Array.from({length:80},(_,i)=>i*.5),downbeatsSec:Array.from({length:20},(_,i)=>i*2)},librosa:{status:'complete',onsetsSec:[]}},
    waveform:{timesSec:times,rms:levels,peak:levels,lowPower:levels,midPower:levels,highPower:levels,onsetStrength:levels}};
  const d=C.buildDynamics(C.validate(data)), frame=t=>C.showFrame(d.lightingDownbeats,t,8,[],true,d);
  assert.equal(d.fillBars[0].active,true);
  assert.ok(frame(0).a[0]>0); assert.ok(frame(2).a[1]>0);
  assert.deepEqual(frame(5).a,Array(8).fill(0));
  assert.deepEqual(frame(9).a,Array(8).fill(0));
  assert.equal(frame(12).a.filter(x=>x>0).length,1);
});
test('eight-bar accumulation holds previous pairs and changes color only on the next cycle', () => {
  const {frame}=accumulationFixture();
  for(let bar=0;bar<8;bar++) {
    const a=frame(bar*2+.25), held=frame(bar*2+.9);
    assert.deepEqual(a.a,Array.from({length:8},(_,i)=>i<=bar?(32+28*(bar+1)/8)/100:0));
    assert.deepEqual(a.a,a.b); assert.deepEqual(held.a,a.a);
    assert.deepEqual(a.rgb,frame(0).rgb);
  }
  assert.deepEqual(frame(16).a,[0,0,0,0,0,0,0,.355]);
  assert.notDeepEqual(frame(16).rgb,frame(14).rgb);
  assert.equal(frame(32).accumulation.cycle,3);
});
test('eighth bar fades on beat three, punches on beat four and blacks out before the next downbeat', () => {
  const {frame,dynamics}=accumulationFixture();
  // Unequal beat spacing verifies that timestamps, not fixed seconds, drive the ending.
  dynamics.fillBars[7].third=15.1; dynamics.fillBars[7].fourth=15.65;
  assert.deepEqual(frame(15).a,Array(8).fill(.6));
  assert.equal(frame(15.2).accumulation.phase,'fade');
  assert.deepEqual(frame(15.5).a,Array(8).fill(0));
  assert.deepEqual(frame(15.65).a,Array(8).fill(1));
  assert.deepEqual(frame(15.9).a,Array(8).fill(0));
  assert.deepEqual(frame(15.65).rgb,frame(14).rgb);
  assert.equal(frame(16).accumulation.bar,1);
});
test('accumulation seeks deterministically, stays dark when disabled and restarts after silence or climax', () => {
  const {frame,dynamics}=accumulationFixture(), expected=frame(11.7);
  for(let t=0;t<35;t+=.1)frame(t);
  assert.deepEqual(frame(11.7),expected);
  assert.deepEqual(frame(11.7,[],false).a,Array(8).fill(0));
  assert.deepEqual(frame(-.1).a,Array(8).fill(0));
  assert.deepEqual(frame(36).a,Array(8).fill(0));
  dynamics.fillBars[3].active=false;
  assert.deepEqual(frame(6.5).a,Array(8).fill(0));
  assert.deepEqual(frame(8).a,[.355,0,0,0,0,0,0,0]);
  const sections=[{start:10.5,end:13}];
  assert.deepEqual(frame(10.2,sections).a,Array(8).fill(0));
  assert.equal(frame(11,sections).mode,'climax');
  assert.deepEqual(frame(13.2,sections).a,Array(8).fill(0));
  assert.deepEqual(frame(14,sections).a,[0,0,0,0,0,0,0,.355]);
});
test('fill-bar timing uses measured internal beats and explicitly marks proportional fallback', () => {
  const data=fixture(), dynamics=C.buildDynamics(data);
  assert.equal(dynamics.fillBars[0].third,1.5);
  assert.equal(dynamics.fillBars[0].fourth,2);
  assert.equal(dynamics.fillBars[0].measured,true);
  data.candidates['beat-this'].beatsSec=[.5,1];
  const bar=C.buildDynamics(data).fillBars[0];
  assert.equal(bar.measured,false);
  assert.equal(bar.third,.5+(5-.5)*.5);
  assert.equal(bar.fourth,.5+(5-.5)*.75);
});

test('four fill variations preserve pair colors and use exact directional order', () => {
  const {events,dynamics}=accumulationFixture();
  for(let i=18;i<34;i++){events.push(i*2);dynamics.fillBars.push({start:i*2,end:i*2+2,active:true,third:i*2+1,fourth:i*2+1.5,measured:true});}
  const orders=[[0,1,2,3,4,5,6,7],[7,6,5,4,3,2,1,0],[3,4,2,5,1,6,0,7],[0,7,1,6,2,5,3,4]];
  for(let cycle=0;cycle<4;cycle++){
    const first=C.showFrame(events,cycle*16+.1,8,[],true,dynamics);
    for(let bar=0;bar<8;bar++){
      const f=C.showFrame(events,cycle*16+bar*2+.1,8,[],true,dynamics);
      assert.deepEqual(f.a.map((v,i)=>v>0?i:-1).filter(i=>i>=0),orders[cycle].slice(0,bar+1).sort((a,b)=>a-b));
      assert.deepEqual(f.a,f.b);assert.deepEqual(f.pairColors,first.pairColors);
    }
    assert.equal(new Set(first.pairColors.map(JSON.stringify)).size,[1,1,2,4][cycle]);
  }
});
test('optional brightness wave keeps accumulated A/B pairs lit and never changes section entry', () => {
  const {events,dynamics}=accumulationFixture();
  for(let i=18;i<26;i++){events.push(i*2);dynamics.fillBars.push({start:i*2,end:i*2+2,active:true,third:i*2+1,fourth:i*2+1.5,measured:true});}
  const normal=C.showFrame(events,34.2,8,[],true,dynamics);
  const wave=C.showFrame(events,34.2,8,[],true,dynamics,{wave:true});
  const later=C.showFrame(events,35.5,8,[],true,dynamics,{wave:true});
  assert.equal(normal.accumulation.wave,false);assert.equal(wave.accumulation.wave,true);
  assert.deepEqual(wave.a,wave.b);assert.deepEqual(wave.pairColors,normal.pairColors);
  assert.deepEqual(wave.a.map(Boolean),normal.a.map(Boolean));
  assert.ok(wave.a.some((level,index)=>level>normal.a[index]));assert.notDeepEqual(wave.a,later.a);
  assert.deepEqual(C.showFrame(events,18.2,8,[],true,dynamics,{wave:true}).a,C.showFrame(events,18.2,8,[],true,dynamics).a);
  const section=[{start:38,end:44}];
  assert.deepEqual(C.showFrame(events,37.9,8,section,true,dynamics,{wave:true}),C.showFrame(events,37.9,8,section,true,dynamics));
  assert.deepEqual(C.showFrame(events,38,8,section,true,dynamics,{wave:true}),C.showFrame(events,38,8,section,true,dynamics));
});
test('climax progresses colors and alternates pulses without extinguishing other pairs', () => {
  const {events,dynamics}=accumulationFixture(),sections=[{start:0,end:36}];
  const frame=t=>C.showFrame(events,t,8,sections,true,dynamics);
  const count=f=>new Set(f.pairColors.map(JSON.stringify)).size;
  assert.equal(count(frame(0)),1);assert.equal(count(frame(8)),2);assert.equal(count(frame(16)),4);
  assert.equal(frame(0).a[0],frame(0).a[1]);
  assert.ok(frame(4).a[0]>frame(4).a[1]);assert.ok(frame(4.5).a[1]>frame(4.5).a[0]);
  assert.ok(frame(4).a.every(x=>x>0));assert.deepEqual(frame(4).a,frame(4).b);
  const saved=frame(10.13);frame(25);assert.deepEqual(frame(10.13),saved);
  assert.deepEqual(frame(4).pairColors,frame(4.5).pairColors);
});

test('preparation fades smoothly at the last bar then holds blackout before a new-color entry punch', () => {
  const {frame}=accumulationFixture(),sections=[{start:20,end:30}];
  const before=frame(11.99,sections),first=frame(12,sections);
  assert.equal(before.preparation,undefined); assert.equal(first.mode,'buildup');
  for(let i=0;i<8;i++)if(before.a[i]>0){assert.ok(first.a[i]>=before.a[i]);assert.deepEqual(first.pairColors[i],before.pairColors[i]);}
  let previous=first;
  for(let time=12;time<18;time+=.05){
    const f=frame(time,sections);
    assert.equal(f.mode,'buildup');assert.deepEqual(f.a,f.b);
    assert.ok(f.a.filter(x=>x>0).length>=previous.a.filter(x=>x>0).length);
    assert.deepEqual(f.pairColors,first.pairColors);previous=f;
  }
  assert.ok(frame(15.95,sections).a.every(x=>x>0)); // old eighth-bar blackout
  assert.ok(frame(17.999,sections).a.every(x=>x>0));
  assert.deepEqual(frame(18,sections).a,Array(8).fill(.7));
  let prior=.7;
  for(const time of [18.025,18.05,18.1,18.15,18.199]) {
    const f=frame(time,sections);
    assert.ok(f.a.every(v=>v>0&&v<prior));assert.deepEqual(f.a,f.b);
    assert.equal(f.preparation.phase,'fade');prior=f.a[0];
    frame(29,sections);assert.deepEqual(frame(time,sections),f);
  }
  for(const time of [18.2,18.5,19,19.999]) {
    const dark=frame(time,sections);
    assert.deepEqual(dark.a,Array(8).fill(0));assert.deepEqual(dark.a,dark.b);
    assert.equal(dark.preparation.phase,'blackout');assert.equal(dark.preparation.filled,0);
  }
  const entrance=frame(20,sections);
  assert.deepEqual(entrance.a,Array(8).fill(1));
  assert.notDeepEqual(entrance.pairColors[0],first.pairColors[0]);
  assert.deepEqual(frame(19,sections,false).a,Array(8).fill(0));
  const sampled=frame(13.3,sections);frame(29,sections);assert.deepEqual(frame(13.3,sections),sampled);
});
test('preparation respects silence and prior sections, and supports manual off-beat entrances', () => {
  const {frame,dynamics}=accumulationFixture();
  dynamics.fillBars[7].active=false;
  const sections=[{start:20.25,end:30}];
  assert.equal(frame(15,sections).preparation,undefined);
  assert.equal(frame(16,sections).preparation.total,3);
  assert.deepEqual(frame(20.24,sections).a,Array(8).fill(0));
  assert.deepEqual(frame(20.25,sections).a,Array(8).fill(1));
  const adjacent=[{start:10,end:17},{start:20,end:30}];
  assert.equal(frame(17.5,adjacent).preparation,undefined);
  assert.equal(frame(18,adjacent).preparation.total,1);
  assert.deepEqual(frame(18,adjacent).a,Array(8).fill(0));
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
