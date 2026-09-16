const {test}=require('node:test'),assert=require('node:assert/strict');
const {Show}=require('../wwwroot/ledfx-show');
const frequencies=[60,150,500,1800,4000,8000];
function feed(show,seconds,fn,options={}){
  const frames=[];for(let n=0;n<seconds*60;n++){const t=n/60;show.ingest(fn(t,n),frequencies,t,options);frames.push(show.frame(t+.017,options));}return frames;
}
test('sustained tone fires once and then becomes fully dark; silence never hits',()=>{
  const show=new Show();const frames=feed(show,5,t=>t<.5?[0,0,0,0,0,0]:[1,1,0,0,0,0],{mode:'sparse'});
  assert.equal(show.hitCount,1);assert.ok(frames.some(f=>f.rgb.some(v=>v>0)));assert.ok(frames.at(-1).rgb.every(v=>v===0));
  const silent=new Show();feed(silent,5,()=>[0,0,0,0,0,0]);assert.equal(silent.hitCount,0);
});
test('120 BPM pulses retrigger in full mode and have dark gaps',()=>{
  const show=new Show();const frames=feed(show,6,(t,n)=>n%30===15?[1,1,.7,.7,.4,.4]:[0,0,0,0,0,0],{mode:'full',brightness:100});
  assert.equal(show.hitCount,12);
  assert.ok(frames.some(f=>f.weights.every(w=>w>.5)));
  assert.ok(frames.filter(f=>Math.max(...f.weights)<.15).length>60);
});
test('higher frequency hits work without bass; groups are arbitrary 1..5 pairs',()=>{
  for(let pairs=1;pairs<=5;pairs++){
    const show=new Show();const frames=feed(show,3,(t,n)=>n%30===15?[0,0,0,0,1,1]:[0,0,0,0,0,0],{mode:'sparse',pairs});
    assert.equal(show.hitCount,6);assert.equal(show.source,'고역');assert.equal(show.index,5%pairs);
    assert.ok(frames.every(f=>f.rgb.length===pairs*3&&f.rgb.every(v=>v>=0&&v<=255)));
  }
});
test('stale input, seek reset and zero master cannot leave a lamp on',()=>{
  const show=new Show();show.ingest([0,0,0,0,0,0],frequencies,0);show.ingest([1,1,1,1,1,1],frequencies,.2);
  assert.ok(show.frame(.23).rgb.some(v=>v));assert.ok(show.frame(1).rgb.every(v=>v===0));
  assert.ok(show.frame(.23,{brightness:0}).rgb.every(v=>v===0));
  show.reset();assert.equal(show.hitCount,0);assert.ok(show.frame(1).rgb.every(v=>v===0));
});
test('automatic mode requires sustained rhythmic evidence and exits after quiet',()=>{
  const show=new Show();const frames=feed(show,12,(t,n)=>t<7?(n%24<8?[2,2,2,2,2,2]:[.1,.1,.1,.1,.1,.1]):[0,0,0,0,0,0]);
  assert.ok(frames.some(f=>f.mode==='full'));assert.equal(frames.at(-1).mode,'sparse');
  assert.ok(frames.at(-1).rgb.every(v=>v===0));
});
