const { test } = require('node:test');
const assert = require('node:assert/strict');
const Ambient = require('../wwwroot/ambient-art.js');

const bridges = [
  { bridgeIndex:1, lightIds:['a1','a2','a3','a4'] },
  { bridgeIndex:2, lightIds:['b1','b2','b3','b4'] }
];

test('same mode gives matching bridge positions the same frame', () => {
  const frame = Ambient.buildFrame({ bridges, elapsedSec:3, cycleSec:12, syncMode:'same' });
  for (let index = 0; index < 4; index++) {
    assert.equal(frame.lights[index].color, frame.lights[index + 4].color);
    assert.equal(frame.lights[index].brightness, frame.lights[index + 4].brightness);
  }
});

test('mirror mode reflects the second bridge around the first', () => {
  const frame = Ambient.buildFrame({ bridges, elapsedSec:1.5, cycleSec:12, syncMode:'mirror' });
  for (let index = 0; index < 4; index++) {
    assert.equal(frame.lights[index].color, frame.lights[7 - index].color);
    assert.equal(frame.lights[index].brightness, frame.lights[7 - index].brightness);
  }
});

test('continuous mode treats both bridges as one ordered strip', () => {
  const frame = Ambient.buildFrame({ bridges, elapsedSec:0, cycleSec:12, syncMode:'continuous' });
  assert.equal(frame.lights.length, 8);
  assert.notEqual(frame.lights[0].color, frame.lights[4].color);
  assert.ok(frame.lights.every(light => light.brightness >= 18 && light.brightness <= 78));
});

test('fixed-color brightness wave keeps colors stable while brightness moves', () => {
  const first = Ambient.buildFrame({ bridges:[bridges[0]], elapsedSec:0, effect:'brightness', direction:'forward' });
  const later = Ambient.buildFrame({ bridges:[bridges[0]], elapsedSec:2, effect:'brightness', direction:'forward' });
  assert.deepEqual(first.lights.map(light => light.color), later.lights.map(light => light.color));
  assert.notDeepEqual(first.lights.map(light => light.brightness), later.lights.map(light => light.brightness));
});

test('frame generation is deterministic and supports reverse and ping-pong motion', () => {
  const options = { bridges, elapsedSec:4.25, cycleSec:10, direction:'pingpong', minBrightness:8, maxBrightness:92 };
  assert.deepEqual(Ambient.buildFrame(options), Ambient.buildFrame(options));
  assert.notEqual(Ambient.travelAt(2, 10, 'forward'), Ambient.travelAt(2, 10, 'reverse'));
  assert.ok(Ambient.travelAt(2, 10, 'pingpong') >= 0 && Ambient.travelAt(2, 10, 'pingpong') <= 1);
});
