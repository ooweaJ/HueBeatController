const {test}=require('node:test');
const assert=require('node:assert/strict');
const {create}=require('../wwwroot/piano/kiosk-ambient.js');
const {buildFrame}=require('../wwwroot/ambient-art.js');

function harness(external=false) {
  const calls=[];
  let active=external, owner=external?'operator-owner':null, timer=null;
  const api=async(path,body)=>{
    calls.push({path,body});
    if(path==='/api/entertainment/status')return {active,purpose:active?'ambient':null,owner,
      bridges:active?[{bridgeIndex:2,status:{active:true,configurationId:'area-2'}}]:[]};
    if(path==='/api/controller-settings')return {settings:{
      bridgeLightOrders:{2:['bulb-2','bulb-1']},
      controls:{entertainmentConfigurationIds:{2:'area-2'},ambient:{target:'both',effect:'rainbow',cycle:10,min:12,max:80}}
    }};
    if(path.includes('configurations?bridgeIndex=2'))return [{id:'area-2',lightIds:['bulb-1','bulb-2']}];
    if(path.includes('configurations?bridgeIndex=1'))throw new Error('Bridge 1 offline');
    if(path==='/api/entertainment/start'){
      assert.equal(body.purpose,'ambient');assert.equal(body.requireIdle,true);
      assert.deepEqual(body.bridges,[{bridgeIndex:2,configurationId:'area-2'}]);
      active=true;owner='kiosk-owner';return {owner};
    }
    if(path==='/api/entertainment/frame')return {updatedChannels:2};
    if(path==='/api/entertainment/claim-ambient'){
      assert.equal(owner,'operator-owner');owner='kiosk-owner';return {owner};
    }
    if(path==='/api/entertainment/stop-ambient'){
      assert.equal(body.owner,owner);active=false;owner=null;return {};
    }
    throw new Error(`Unexpected ${path}`);
  };
  const ambient=create({api,buildFrame,now:()=>1000,every:fn=>{timer=fn;return 1;},clearEvery:()=>{timer=null;}});
  return {ambient,calls,tick:()=>timer?.()};
}

test('idle kiosk uses saved Bridge 2 ordering and safely blacks out before piano',async()=>{
  const env=harness();await env.ambient.start();
  const first=env.calls.find(call=>call.path==='/api/entertainment/frame');
  assert.equal(first.body.owner,'kiosk-owner');
  assert.deepEqual(first.body.commands.map(command=>command.lightIds[0]),['bulb-2','bulb-1']);
  await env.ambient.stop();
  assert.equal(env.calls.filter(call=>call.path==='/api/entertainment/frame').at(-1).body.commands[0].on,false);
  assert.equal(env.calls.at(-1).path,'/api/entertainment/stop-ambient');
});

test('kiosk claims operator ambient without restarting its stream',async()=>{
  const env=harness(true);await env.ambient.start();
  assert.equal(env.calls.some(call=>call.path==='/api/entertainment/start'),false);
  assert.equal(env.calls.some(call=>call.path==='/api/entertainment/claim-ambient'),true);
  await env.ambient.stop();
  assert.equal(env.calls.at(-1).body.owner,'kiosk-owner');
});
