const assert = require('node:assert/strict');
require('../wwwroot/show-score.js');
const MediaArt = require('../wwwroot/media-art.js');

const sampleCount = 240;
const analysis = {
  duration: 24,
  envelopeStep: .1,
  envelope: Array(sampleCount).fill(.38),
  bassEnvelope: Array(sampleCount).fill(.42),
  midEnvelope: Array(sampleCount).fill(.28),
  highEnvelope: Array(sampleCount).fill(.18),
  onsetEnvelope: Array(sampleCount).fill(.08),
  bassOnsetEnvelope: Array(sampleCount).fill(.08),
  spectralFluxEnvelope: Array(sampleCount).fill(.08),
  beatInterval: .5,
  beatGridStart: 0,
  beatTimes: Array.from({length: 44}, (_, index) => 1 + index * .5),
  cueStrengths: Array(44).fill(.9),
  slotCount: 5,
  lightingScore: {
    version: 2,
    barsPerPhrase: 4,
    phrases: [
      {id: 'intro', start: 0, end: 6, type: 'intro', preset: 'layered-show'},
      {id: 'verse', start: 6, end: 12, type: 'verse', preset: 'layered-show'},
      {id: 'build', start: 12, end: 18, type: 'build', preset: 'layered-show'},
      {id: 'climax', start: 18, end: 24, type: 'climax', preset: 'layered-show', confirmed: true}
    ],
    cues: [],
    reactive: {}
  }
};

analysis.onsetEnvelope[73] = .95;
analysis.spectralFluxEnvelope[78] = 1;
analysis.highEnvelope[78] = .95;

const timeline = MediaArt.compile(analysis);
assert.equal(timeline.version, 9);
assert.equal(timeline.slotCount, 5);
assert.equal(timeline.frames.length, 480);
assert.ok(timeline.eventCounts.kick > 0);
assert.ok(timeline.eventCounts.snare > 0);
assert.ok(timeline.eventCounts.high > 0);

for (const frame of timeline.frames) {
  assert.equal(frame.weights.length, 5);
  assert.equal(frame.colorOffsets.length, 5);
  assert.ok(frame.weights.every(value => value >= 0 && value <= 1));
}

const introKick = MediaArt.sample(timeline, 2);
assert.ok(Math.max(...introKick.weights) > .6, 'intro kick should punch one pair');
assert.ok(introKick.weights.filter(value => value > .5).length < 5, 'intro must preserve negative space');

const climaxEntry = MediaArt.sample(timeline, 18);
const beforeClimax = MediaArt.sample(timeline, 17.9);
const climaxKick = MediaArt.sample(timeline, 19);
assert.equal(climaxEntry.bloom, false, 'classification alone must not flash');
assert.equal(beforeClimax.blackout, false, 'classification alone must not black out');
assert.ok(Math.min(...climaxKick.weights) > .4, 'climax kick should animate the full field');

const verseA = MediaArt.sample(timeline, 8.1);
const verseB = MediaArt.sample(timeline, 11.9);
assert.equal(verseA.color, verseB.color, 'base palette must stay fixed inside a phrase');

console.log(`media-art v${timeline.version}: ${timeline.frames.length} frames, ${JSON.stringify(timeline.eventCounts)}`);

assert.equal(MediaArt.peakEvents(Array(30).fill(.8),.1,.58,.22).length,0,'constant sound is not an attack');
assert.equal(MediaArt.peakEvents([0,0,.9,.9,.9,0,0],.1,.58,.22).length,1,'one plateau has at most one rising attack');

const quiet={...analysis,duration:3,beatTimes:[.51,.81],cueStrengths:[1,1],
  onsetEnvelope:Array(30).fill(0),spectralFluxEnvelope:Array(30).fill(0),
  lightingScore:{version:2,phrases:[{id:'steady',start:0,end:3,type:'verse'}],cues:[]}};
const timing=MediaArt.compile(quiet);
assert.equal(MediaArt.sample(timing,.5).hit,false,'do not consume a future event');
const first=MediaArt.sample(timing,.55);
assert.equal(first.hit,true);
assert.equal(first.focus,0,'first attack must use first pair');
assert.ok(first.layers.kick>.9,'hit flag and maximum pulse must share a frame');
const second=MediaArt.sample(timing,.85);
assert.equal(second.focus,1);
assert.ok(second.weights[0]>.15,'old tail must remain on original pair');
assert.ok(second.weights[1]>.9);

const stable={...quiet,beatTimes:[],lightingScore:{version:2,phrases:[
  {id:'a',start:0,end:1,type:'verse',stats:{energy:.4}},
  {id:'b',start:1,end:3,type:'climax',stats:{energy:.42}}
],cues:[]}};
const held=MediaArt.compile(stable);
assert.equal(MediaArt.sample(held,1.5).mode,'verse','weak boundary must preserve the look');
assert.equal(MediaArt.sample(held,1.5).color,MediaArt.sample(held,.5).color);

const accents={...quiet,beatTimes:[],onsetEnvelope:Array(30).fill(0)};
accents.onsetEnvelope[5]=1;
const accentTimeline=MediaArt.compile(accents);
const before=MediaArt.sample(accentTimeline,.5),after=MediaArt.sample(accentTimeline,.6);
assert.deepEqual(before.colorMix.map(v=>v>0),after.colorMix.map(v=>v>0),'accent targets stay fixed over beat boundaries');
assert.ok(Math.max(...after.colorMix)<Math.max(...before.colorMix),'accent colour fades with its tail');
const colliding=MediaArt.compile({...accents,beatTimes:[.51]});
assert.equal(colliding.eventCounts.snare,0,'one attack must not create a second accent');

const manual=MediaArt.compile({...quiet,lightingScore:{...quiet.lightingScore,cues:[
  {time:1,type:'blackout',automatic:false},{time:2,type:'full-punch',automatic:false}
]}});
assert.ok(MediaArt.sample(manual,1.05).weights.every(v=>v===0));
assert.ok(MediaArt.sample(manual,2.05).weights.every(v=>v===1));
assert.deepEqual(MediaArt.compile(quiet).frames,timing.frames,'repeated playback must be deterministic');
for(const slotCount of [1,2,5]){
  const sized=MediaArt.compile({...quiet,slotCount});
  assert.ok(sized.frames.every(f=>f.weights.length===slotCount&&f.weights.every(Number.isFinite)));
}
console.log('Timing, false peaks, fixed tails, priority, scene hold and manual cues passed.');
