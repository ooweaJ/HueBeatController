const {test}=require('node:test');
const assert=require('node:assert/strict');
const Playback=require('../wwwroot/offline-show-playback.js');

function data(){return {analysisId:'a'.repeat(32),playbackHash:'b'.repeat(64),durationSec:8,
  candidates:{librosa:{status:'complete',onsetsSec:[],beatsSec:[]},'beat-this':{status:'complete',beatsSec:[0,.5,1,1.5,2,2.5,3,3.5,4,4.5,5,5.5,6,6.5,7,7.5],downbeatsSec:[0,2,4,6]}},
  waveform:{timesSec:[0,1,2,3,4,5,6,7],rms:Array(8).fill(.2),peak:Array(8).fill(.3),lowPower:Array(8).fill(.2),midPower:Array(8).fill(.2),highPower:Array(8).fill(.2),onsetStrength:Array(8).fill(.1)}};}
test('offline playback requires a saved show from the matching analysis revision',()=>{
  const analysis=data(),show={schemaVersion:1,analysisId:analysis.analysisId,playbackHash:analysis.playbackHash,version:1,sections:[]};
  const session=Playback.prepare(analysis,show);
  assert.equal(session.showVersion,1);assert.deepEqual(session.events,[0,2,4,6]);
  assert.throws(()=>Playback.prepare(analysis,{...show,version:0}),/먼저 저장/);
  assert.throws(()=>Playback.prepare(analysis,{...show,analysisId:'c'.repeat(32)}),/먼저 저장/);
});
test('preview and actual bridge commands use identical A/B colors and brightness',()=>{
  const analysis=data(),session=Playback.prepare(analysis,{schemaVersion:1,analysisId:analysis.analysisId,playbackHash:analysis.playbackHash,version:2,sections:[]});
  const frame=Playback.frameAt(session,2.2,2,false),preview=Playback.commandsFor(frame,[{lightIds:['A1','A2']},{lightIds:['B1','B2']}],.8);
  const actual=Playback.commandsFor(frame,[{lightIds:['bridge2-a','bridge1-a']},{lightIds:['bridge1-b','bridge2-b']}],.8);
  assert.deepEqual(preview.map(({lightIds,...rest})=>rest),actual.map(({lightIds,...rest})=>rest));
  assert.equal(actual[0].hexColor,actual[2].hexColor);assert.equal(actual[0].brightness,actual[2].brightness);
  assert.deepEqual(Playback.frameAt(session,2.2,2,false),frame);
  assert.throws(()=>Playback.commandsFor(frame,[{lightIds:['A1']},{lightIds:['B1']}],1),/쌍 수/);
});
