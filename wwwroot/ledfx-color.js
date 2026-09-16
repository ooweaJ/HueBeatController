// Colour-only adapter. Preserve max(R,G,B), the brightness sent to Hue,
// for every pixel and frame. This is not perceptual luminance matching.
(function(root){
  function powerSingleColor(rgb, hex='#ffb870') {
    if(!/^#[0-9a-f]{6}$/i.test(hex))throw Error('Invalid colour');
    const color=[1,3,5].map(i=>parseInt(hex.slice(i,i+2),16));
    const peak=Math.max(...color);
    if(!peak)throw Error('Black cannot preserve brightness');
    const result=[];
    for(let i=0;i<rgb.length;i+=3){
      const brightness=Math.max(rgb[i],rgb[i+1],rgb[i+2]);
      result.push(...color.map(c=>Math.round(c/peak*brightness)));
    }
    return result;
  }
  const api={powerSingleColor};
  if(typeof module!=='undefined')module.exports=api;
  else root.LedFxColor=api;
})(typeof globalThis!=='undefined'?globalThis:this);
