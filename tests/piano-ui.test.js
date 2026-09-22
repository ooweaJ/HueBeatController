const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const C=require('../wwwroot/piano-core.js');
// Exercise the real input/output controller without a browser, network or Hue device.
function setup(enabled=false,configVolume=50,sessionVolume=configVolume){
  class Element {
    constructor(){this.events={};this.children=[];this.dataset={};this.style={setProperty(){}};this.classList={toggle(){}};this.checked=false;this.tagName='BUTTON';}
    addEventListener(name,fn){(this.events[name]??=[]).push(fn);}
    fire(name,event={}){return Promise.all((this.events[name]||[]).map(fn=>fn({preventDefault(){},target:this,...event})));}
    append(child){this.children.push(child);}
    setAttribute(){}
    setPointerCapture(){}
    closest(){return this.dataset.note===undefined?null:this;}
  }
  let now=0,timer,point=null;
  const ids=Object.fromEntries(['status','welcomeStatus','welcome','begin','ribbons','lowKeys','middleKeys','highKeys','fullscreen','keyboard'].map(id=>[id,new Element()]));
  const document=new Element(),window=new Element();window.HuePiano=C;
  const audioContexts=[];
  class AudioContext {
    constructor(){this.destination={};this.state='running';this.currentTime=0;audioContexts.push(this);}
    createGain(){const gain={value:0};const node={gain,connect(){},disconnect(){}};this.master??=node;return node;}
    resume(){return Promise.resolve();}
  }
  document.getElementById=id=>ids[id];document.createElement=()=>new Element();document.elementFromPoint=()=>point;
  document.documentElement=new Element();
  const calls=[];
  let waitFrame=null;
  const fetch=async(path,options)=>{
    const body=options.body?JSON.parse(options.body):undefined;calls.push({path,body});
    if(path.endsWith('/frame')&&waitFrame){const wait=waitFrame;waitFrame=null;await wait;}
    const data=path.endsWith('/config')?{enabled,sound:false,volume:configVolume}:path.endsWith('/session')?{token:'visitor-token',sound:false,volume:sessionVolume}:{};
    return {ok:true,json:async()=>data};
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../wwwroot/piano/visitor.js'),'utf8'),{
    window,document,location:{search:''},URLSearchParams,performance:{now:()=>now},setInterval:fn=>timer=fn,fetch,AbortSignal,queueMicrotask,Blob,navigator:{sendBeacon(){}},console,AudioContext
  });
  return {window,document,ids,calls,audioContexts,setPoint:value=>point=value,setTime:value=>now=value,tick:()=>timer(),holdFrame:p=>waitFrame=p};
}
const settle=async()=>{for(let i=0;i<8;i++)await new Promise(resolve=>setImmediate(resolve));};
test('visitor preview renders three registers and never starts Hue output',async()=>{
  const ui=setup();assert.equal(ui.ids.middleKeys.children.length,8);assert.equal(ui.ids.lowKeys.children.length,7);assert.equal(ui.ids.highKeys.children.length,7);
  await ui.ids.begin.fire('click');ui.setPoint(ui.ids.middleKeys.children[0]);
  await ui.ids.keyboard.fire('pointerdown',{pointerId:1,pointerType:'touch'});
  await ui.window.fire('keydown',{code:'KeyD',repeat:false});await ui.ids.keyboard.fire('pointercancel',{pointerId:1});
  await ui.window.fire('blur');ui.tick();assert.deepEqual(ui.calls.map(c=>c.path),['/api/piano/config']);
});
test('pending frame cannot overwrite a later release, and stop carries the session token',async()=>{
  const ui=setup(true);await ui.ids.begin.fire('click');await settle();assert.equal(ui.ids.welcome.hidden,true);
  let done;ui.holdFrame(new Promise(resolve=>done=resolve));await ui.window.fire('keydown',{code:'KeyA',repeat:false});
  const lit=ui.calls.filter(c=>c.path.endsWith('/frame')).at(-1);assert.equal(lit.body.levels[0],1);assert.equal(lit.body.token,'visitor-token');
  ui.setTime(10);await ui.window.fire('keyup',{code:'KeyA'});ui.setTime(400);ui.tick();done();await settle();ui.tick();await settle();
  assert.ok(ui.calls.filter(c=>c.path.endsWith('/frame')).at(-1).body.levels.every(v=>v===0));
  ui.document.hidden=true;await ui.document.fire('visibilitychange');await settle();
  assert.equal(ui.calls.at(-1).path,'/api/piano/stop');assert.equal(ui.calls.at(-1).body.token,'visitor-token');assert.equal(ui.ids.welcome.hidden,false);
});
test('slide from lower to higher register cancels cleanly when touch is interrupted',async()=>{
  const ui=setup(true);await ui.ids.begin.fire('click');await settle();
  ui.setPoint(ui.ids.lowKeys.children[0]);await ui.ids.keyboard.fire('pointerdown',{pointerId:7,pointerType:'touch'});await settle();
  ui.setPoint(ui.ids.highKeys.children[6]);await ui.ids.keyboard.fire('pointermove',{pointerId:7});await settle();
  assert.equal(ui.calls.filter(c=>c.path.endsWith('/frame')).at(-1).body.levels[7],1);
  await ui.ids.keyboard.fire('pointercancel',{pointerId:7});await ui.window.fire('blur');await settle();ui.tick();await settle();
  assert.ok(ui.calls.filter(c=>c.path.endsWith('/frame')).at(-1).body.levels.every(v=>v===0));
});
test('visitor applies saved volume to sound only, with session value taking precedence',async()=>{
  const preview=setup(false,80);await preview.ids.begin.fire('click');
  assert.equal(preview.audioContexts[0].master.gain.value,.12);
  assert.deepEqual(preview.calls.map(c=>c.path),['/api/piano/config']);
  const live=setup(true,80,20);await live.ids.begin.fire('click');
  assert.equal(live.audioContexts[0].master.gain.value,.03);
  assert.equal(live.calls.at(-1).path,'/api/piano/frame');
  const muted=setup(false,0);await muted.ids.begin.fire('click');
  assert.equal(muted.audioContexts[0].master.gain.value,0);
  const loud=setup(false,100);await loud.ids.begin.fire('click');
  assert.equal(loud.audioContexts[0].master.gain.value,.15);
});
