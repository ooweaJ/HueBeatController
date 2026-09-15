const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {test} = require('node:test');

test('LedFx transport preserves stereo playback and emits 800-sample mono blocks',()=>{
  let Processor;
  const blocks=[];
  const context=vm.createContext({Float32Array,sampleRate:48000,
    AudioWorkletProcessor:class {constructor(){this.port={postMessage:value=>blocks.push(Array.from(value))};}},
    registerProcessor:(name,type)=>{assert.equal(name,'ledfx-pcm');Processor=type;}
  });
  vm.runInContext(fs.readFileSync('wwwroot/ledfx-audio-worklet.js','utf8'),context);
  const processor=new Processor();
  for(let n=0;n<375;n++){
    const left=new Float32Array(128).fill(.75),right=new Float32Array(128).fill(-.25);
    const out=[new Float32Array(128),new Float32Array(128)];
    assert.equal(processor.process([[left,right]],[out]),true);
    assert.deepEqual(out[0],left);assert.deepEqual(out[1],right);
  }
  assert.equal(blocks.length,60);
  assert.ok(blocks.every(block=>block.length===800&&block.every(value=>value===.25)));
});
