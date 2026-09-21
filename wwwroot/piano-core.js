(function(root) {
  'use strict';
  const notes = [
    ['도','C4','#ff3030',261.6256,'KeyA'], ['레','D4','#ff8800',293.6648,'KeyS'],
    ['미','E4','#ffdc00',329.6276,'KeyD'], ['파','F4','#20d35b',349.2282,'KeyF'],
    ['솔','G4','#1688ff',391.9954,'KeyG'], ['라','A4','#3730b8',440,'KeyH'],
    ['시','B4','#a53bff',493.8833,'KeyJ'], ['도','C5','#ff3030',523.2511,'KeyK']
  ].map(([name,pitch,color,hz,key],index)=>({name,pitch,color,hz,key,index}));
  const steps=[0,2,4,5,7,9,11];
  const keys=Array.from({length:22},(_,index)=>{
    const degree=index%7,octave=3+Math.floor(index/7),midi=12*(octave+1)+steps[degree];
    const slot=degree===0&&octave>=5?7:degree;
    return {...notes[slot],index,slot,pitch:'CDEFGAB'[degree]+octave,hz:440*Math.pow(2,(midi-69)/12),
      range:index<7?'low':index<15?'middle':'high',key:index>=7&&index<15?notes[index-7].key:null};
  });
  function createState(countKeys = keys.length) {
    const owners=new Map(), down=Array(countKeys).fill(-Infinity), released=Array(countKeys).fill(-Infinity);
    function count(note) { return [...owners.values()].filter(n=>n===note).length; }
    function release(owner,now) {
      if(!owners.has(owner))return;
      const note=owners.get(owner);owners.delete(owner);
      if(!count(note))released[note]=Math.max(now,down[note]+80);
    }
    return {
      press(owner,note,now) {
        if(!Number.isInteger(note)||note<0||note>=countKeys)return;
        if(owners.get(owner)===note)return;
        release(owner,now);
        if(!count(note))down[note]=now;
        owners.set(owner,note);
      },
      release,
      clear() { owners.clear();down.fill(-Infinity);released.fill(-Infinity); },
      held() { return Array.from({length:countKeys},(_,i)=>count(i)>0); },
      frame(now) { return Array.from({length:countKeys},(_,i)=>count(i)?1:Math.pow(1-Math.min(1,Math.max(0,(now-released[i])/180)),2)); }
    };
  }
  function noteLevels(levels) {
    const result=Array(8).fill(0);
    keys.forEach((key,i)=>result[key.slot]=Math.max(result[key.slot],Math.max(0,Math.min(1,levels[i]||0))));
    return result;
  }
  function copyGroups(groups) {
    const seen=new Set();return (groups||[]).flatMap(group=>(group.lightIds||[]).slice(0,8).flatMap((lightId,note)=>{
      if(seen.has(lightId))return [];seen.add(lightId);return [{lightId,note}];
    }));
  }
  const api={notes,keys,createState,noteLevels,copyGroups};
  if(typeof module!=='undefined')module.exports=api;
  root.HuePiano=api;
})(typeof window!=='undefined'?window:globalThis);
