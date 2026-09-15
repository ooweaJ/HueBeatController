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
      {id: 'climax', start: 18, end: 24, type: 'climax', preset: 'layered-show'}
    ],
    cues: [],
    reactive: {}
  }
};

analysis.onsetEnvelope[73] = .95;
analysis.spectralFluxEnvelope[79] = 1;
analysis.highEnvelope[79] = .95;

const timeline = MediaArt.compile(analysis);
assert.equal(timeline.version, 8);
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
assert.equal(climaxEntry.bloom, true, 'climax should enter with a full bloom');
assert.equal(beforeClimax.blackout, true, 'climax should be preceded by a blackout');
assert.ok(Math.min(...climaxKick.weights) > .4, 'climax kick should animate the full field');

const verseA = MediaArt.sample(timeline, 8.1);
const verseB = MediaArt.sample(timeline, 11.9);
assert.equal(verseA.color, verseB.color, 'base palette must stay fixed inside a phrase');

console.log(`media-art v${timeline.version}: ${timeline.frames.length} frames, ${JSON.stringify(timeline.eventCounts)}`);
