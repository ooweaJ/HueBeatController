const {test}=require('node:test');
const assert=require('node:assert/strict');
const {powerSingleColor}=require('../wwwroot/ledfx-color.js');
test('single colour preserves every pixel brightness and black frames',()=>{
  for(const hex of ['#ffb870','#70c8ff','#cf9fff']){
    for(let peak=0;peak<256;peak++){
      const rgb=[peak,peak>>1,0,0,0,peak,0,0,0];
      const before=rgb.slice(),result=powerSingleColor(rgb,hex);
      assert.deepEqual(rgb,before);
      for(let i=0;i<rgb.length;i+=3)
        assert.equal(Math.max(...result.slice(i,i+3)),Math.max(...rgb.slice(i,i+3)));
      assert.deepEqual(result.slice(6),[0,0,0]);
    }
  }
});
test('punch and decay envelope remains identical',()=>{
  const envelope=[0,3,40,255,220,170,80,20,1,0];
  const mapped=envelope.map(v=>Math.max(...powerSingleColor([v,Math.round(v*.8),0])));
  assert.deepEqual(mapped,envelope);
  assert.throws(()=>powerSingleColor([1,2,3],'#000000'));
});
