const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const C=require('../wwwroot/piano-core.js');
function setup(){
  class Element {
    constructor(){this.events={};this.children=[];this.value='';this.checked=false;this.classList={toggle(){}};}
    addEventListener(name,fn){(this.events[name]??=[]).push(fn);}
    fire(name){return Promise.all((this.events[name]||[]).map(fn=>fn({target:this})));}
    append(...children){this.children.push(...children);}
    replaceChildren(){this.children=[];}
    setAttribute(){}
  }
  const elements={};const $=id=>elements[id]??=new Element();
  const groups=[{lightIds:['a','b']},{lightIds:['c']}],lights=['a','b','c'].map((id,i)=>({id,name:`전구 ${i}`,bridgeIndex:1,connectivity:'connected',colorCapable:true}));
  const initial={enabled:false,sound:true,assignments:[{lightId:'a',note:6}],configurationIds:{1:'area'}};
  const calls=[],window={HuePiano:C},document={getElementById:$,createElement:()=>new Element()};
  const fetch=async(path,options)=>{
    const body=options.body?JSON.parse(options.body):undefined;calls.push({path,method:options.method,body});
    return {ok:true,json:async()=>body||structuredClone(initial)};
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../wwwroot/piano-operator.js'),'utf8'),{window,document,location:{href:'http://localhost:5188/'},URL,fetch});
  return {window,$,calls,groups,options:{getLights:()=>lights,getGroups:()=>groups,getConfigurations:()=>[{id:'area',bridgeIndex:1,name:'현장',channelCount:3}],getSelectedConfigurations:()=>({1:'area'})}};
}
test('operator saves arbitrary per-lamp notes and duplicate notes without rewriting music settings',async()=>{
  const ui=setup(),before=JSON.stringify(ui.groups);await ui.window.HuePianoOperator.init(ui.options);
  assert.equal(ui.$('pianoMappings').children[0].children[2].value,'6');
  for(const row of ui.$('pianoMappings').children){const select=row.children[2];select.value='2';await select.fire('change');}
  await ui.$('pianoSave').fire('click');const saved=ui.calls.find(c=>c.method==='PUT');
  assert.equal(saved.path,'/api/piano/settings');assert.deepEqual(saved.body.assignments,[{lightId:'a',note:2},{lightId:'b',note:2},{lightId:'c',note:2}]);
  assert.equal(JSON.stringify(ui.groups),before);assert.ok(ui.calls.every(c=>c.path!=='/api/controller-settings'));
});
test('A/B import is explicit, stays a draft, and visitor address is separate',async()=>{
  const ui=setup();await ui.window.HuePianoOperator.init(ui.options);
  assert.equal(ui.calls.length,1);assert.equal(ui.$('pianoVisitorUrl').textContent,'http://localhost:5188/piano/');
  await ui.$('pianoCopyMusic').fire('click');assert.equal(ui.calls.length,1);
  await ui.$('pianoSave').fire('click');
  assert.deepEqual(ui.calls.at(-1).body.assignments,[{lightId:'a',note:0},{lightId:'b',note:1},{lightId:'c',note:0}]);
});
