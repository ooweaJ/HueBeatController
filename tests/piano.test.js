const {test}=require('node:test');
const assert=require('node:assert/strict');
const C=require('../wwwroot/piano-core.js');
test('22 natural notes ascend continuously, with eight larger middle keys',()=>{
  assert.equal(C.keys.length,22);assert.equal(new Set(C.keys.map(k=>k.pitch)).size,22);
  assert.equal(C.keys.filter(k=>k.range==='middle').length,8);
  assert.deepEqual(C.keys.filter(k=>k.range==='middle').map(k=>k.pitch),['C4','D4','E4','F4','G4','A4','B4','C5']);
  for(let i=1;i<C.keys.length;i++)assert.ok(C.keys[i].hz>C.keys[i-1].hz);
  assert.equal(C.keys[0].pitch,'C3');assert.equal(C.keys.at(-1).pitch,'C6');
  assert.deepEqual(C.notes.map(n=>n.color),['#ff3030','#ff8800','#ffdc00','#20d35b','#1688ff','#3730b8','#a53bff','#ff3030']);
});
test('multi-touch chord, duplicate fingers and sliding preserve remaining inputs',()=>{
  const s=C.createState();s.press('p1',7,0);s.press('p2',7,10);s.press('p3',11,10);
  s.release('p1',20);assert.equal(s.frame(100)[7],1);assert.equal(s.frame(100)[11],1);
  s.press('p2',8,100);assert.equal(s.frame(100)[8],1);assert.equal(s.frame(280)[7],0);
  s.release('p3',300);assert.ok(s.frame(390)[11]>0);assert.equal(s.frame(480)[11],0);
  s.clear();assert.deepEqual(s.frame(500),Array(22).fill(0));
});
test('short taps remain visible and repeated release cannot retrigger',()=>{
  const s=C.createState();s.press(1,14,100);s.release(1,110);
  assert.equal(s.frame(150)[14],1);assert.equal(s.frame(360)[14],0);
  s.release(1,400);assert.equal(s.frame(400)[14],0);
});
test('same degree in different octaves shares a lamp without cutting the remaining voice',()=>{
  const s=C.createState();s.press('low',1,0);s.press('middle',8,0);s.press('high',15,0);
  assert.equal(C.noteLevels(s.frame(100))[1],1);s.release('middle',100);s.release('high',100);
  assert.equal(C.noteLevels(s.frame(500))[1],1);s.release('low',500);assert.equal(C.noteLevels(s.frame(700))[1],0);
  assert.equal(C.keys[0].slot,0);assert.equal(C.keys[7].slot,0);assert.equal(C.keys[14].slot,7);assert.equal(C.keys[21].slot,7);
});
test('optional A/B import copies notes without mutating music groups or duplicating lights',()=>{
  const groups=[{lightIds:['a','b','c']},{lightIds:['d','b','e']}],before=JSON.stringify(groups);
  assert.deepEqual(C.copyGroups(groups),[{lightId:'a',note:0},{lightId:'b',note:1},{lightId:'c',note:2},{lightId:'d',note:0},{lightId:'e',note:2}]);
  assert.equal(JSON.stringify(groups),before);
});
