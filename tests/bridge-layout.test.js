const {test}=require('node:test');
const assert=require('node:assert/strict');
const {reconcileMusicGroups}=require('../wwwroot/bridge-layout.js');

const groups=[{lightIds:['stale-a','a2','a1']},{lightIds:['stale-b','b2','b1']}];
const lights=[
  {id:'a1',name:'왼쪽1',bridgeIndex:1},
  {id:'a2',name:'왼쪽2',bridgeIndex:1},
  {id:'b1',name:'오른쪽1',bridgeIndex:2},
  {id:'b2',name:'오른쪽2',bridgeIndex:2}
];

test('music A/B membership and order follow the actual Bridge layout',()=>{
  const result=reconcileMusicGroups(groups,{1:['a2','a1'],2:['b2','b1']},lights);
  assert.deepEqual(result,[['a2','a1'],['b2','b1']]);
  assert.deepEqual(groups[0].lightIds,['stale-a','a2','a1']);
});

test('reordering Bridge lights changes the matching music row',()=>{
  const result=reconcileMusicGroups(groups,{1:['a1','a2'],2:['b1','b2']},lights);
  assert.deepEqual(result,[['a1','a2'],['b1','b2']]);
});

test('a missing Bridge keeps its saved group while the available Bridge updates',()=>{
  const result=reconcileMusicGroups(groups,{1:['a2','a1'],2:['b1','b2']},lights.filter(light=>light.bridgeIndex===2));
  assert.deepEqual(result,[['stale-a','a2','a1'],['b1','b2']]);
});

test('a transferred light is removed from the unavailable source group',()=>{
  const result=reconcileMusicGroups([{lightIds:['a1','a2']},{lightIds:[]}],{1:['a1','a2'],2:['a1']},[{id:'a1',name:'이동',bridgeIndex:2}]);
  assert.deepEqual(result,[['a2'],['a1']]);
});
