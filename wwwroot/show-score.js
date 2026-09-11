// Phrase, preset and cue compiler shared by the editor and Entertainment renderer.
(function(root){
  const clamp=(value,min=0,max=1)=>Math.max(min,Math.min(max,value));
  const mean=values=>values.length?values.reduce((sum,value)=>sum+(Number(value)||0),0)/values.length:0;
  const TYPES=['intro','verse','build','climax','bridge','outro'];
  const PRESETS=['ambient','step','accumulate','alternate','wave','expand','full-punch','decay'];
  const TYPE_LABELS={intro:'도입',verse:'전개',build:'빌드업',climax:'클라이맥스',bridge:'브리지',outro:'아웃트로'};
  const PRESET_LABELS={ambient:'잔잔한 유지',step:'순차 이동',accumulate:'누적 점등',alternate:'좌우 교차',wave:'파도 이동',expand:'중앙 확장', 'full-punch':'전체 펀치',decay:'점차 감소'};
  const DEFAULT_PRESET={intro:'ambient',verse:'step',build:'accumulate',climax:'wave',bridge:'alternate',outro:'decay'};

  function sample(values,time,step=.1){
    if(!values?.length)return 0;
    const position=clamp(time/step,0,values.length-1),left=Math.floor(position),right=Math.min(values.length-1,left+1),mix=position-left;
    return (Number(values[left])||0)*(1-mix)+(Number(values[right])||0)*mix;
  }
  function rangeMean(values,start,end,step=.1){
    if(!values?.length)return 0;
    const from=Math.max(0,Math.floor(start/step)),to=Math.min(values.length,Math.max(from+1,Math.ceil(end/step)));
    return mean(values.slice(from,to));
  }
  function barsFromAnalysis(analysis){
    const duration=Math.max(.1,Number(analysis.duration)||0),beatInterval=Math.max(.15,Number(analysis.beatInterval)||.5),grid=analysis.beatGrid?.length?analysis.beatGrid:[];
    const phase=((Number(analysis.downbeatPhase)||0)%4+4)%4;
    let starts=analysis.downbeats?.length?[...analysis.downbeats]:grid.filter((_,index)=>index%4===phase);
    if(!starts.length){const origin=Math.max(0,Number(analysis.beatGridStart)||0);for(let time=origin;time<duration;time+=beatInterval*4)starts.push(time);}
    if(starts[0]>.02)starts.unshift(0);
    starts=[...new Set(starts.map(value=>Number(clamp(value,0,duration).toFixed(5))))].sort((a,b)=>a-b);
    if(starts.at(-1)<duration-.02)starts.push(duration);
    return starts;
  }
  function statsFor(analysis,start,end){
    const step=Number(analysis.envelopeStep)||.1;
    const energy=rangeMean(analysis.envelope,start,end,step),bass=rangeMean(analysis.bassEnvelope,start,end,step),mid=rangeMean(analysis.midEnvelope,start,end,step),high=rangeMean(analysis.highEnvelope,start,end,step);
    const hits=(analysis.beatTimes||[]).filter(time=>time>=start&&time<end).length;
    return {energy,bass,mid,high,hitDensity:hits/Math.max(1,end-start)};
  }
  function classify(stats,index,count,previousEnergy){
    if(index===0)return 'intro';
    if(index===count-1)return 'outro';
    if(stats.energy>=.64||stats.hitDensity>=2.35)return 'climax';
    if(stats.energy-previousEnergy>=.12)return 'build';
    if(stats.energy<=.3&&index>1)return 'bridge';
    return 'verse';
  }
  function automaticCuesFor(phrases){
    const cues=[];phrases.forEach((phrase,index)=>{if(index&&phrase.type==='climax'&&phrases[index-1].type!=='climax'){cues.push({id:`auto-blackout-${index}`,time:Number(Math.max(0,phrase.start-.18).toFixed(5)),type:'blackout',automatic:true});cues.push({id:`auto-punch-${index}`,time:Number(phrase.start.toFixed(5)),type:'full-punch',automatic:true});}});return cues;
  }
  function compile(analysis,options={}){
    const bars=barsFromAnalysis(analysis),barsPerPhrase=Math.max(4,Math.round(Number(options.barsPerPhrase)||8)),duration=Math.max(.1,Number(analysis.duration)||0),old=analysis.lightingScore;
    const boundaries=[0];for(let bar=barsPerPhrase;bar<bars.length-1;bar+=barsPerPhrase)boundaries.push(bars[bar]);if(boundaries.at(-1)!==duration)boundaries.push(duration);
    const raw=boundaries.slice(0,-1).map((start,index)=>({start,end:boundaries[index+1],stats:statsFor(analysis,start,boundaries[index+1])}));
    const phrases=raw.map((item,index)=>{
      const previous=raw[Math.max(0,index-1)]?.stats.energy||0,type=classify(item.stats,index,raw.length,previous),oldPhrase=old?.phrases?.find(value=>Math.abs(Number(value.start)-item.start)<.03);
      const selectedType=TYPES.includes(oldPhrase?.type)?oldPhrase.type:type,preset=PRESETS.includes(oldPhrase?.preset)?oldPhrase.preset:DEFAULT_PRESET[selectedType];
      return {id:oldPhrase?.id||`phrase-${index+1}`,start:Number(item.start.toFixed(5)),end:Number(item.end.toFixed(5)),startBar:Math.max(0,bars.findIndex(value=>Math.abs(value-item.start)<.03)),bars:Math.max(1,Math.round((item.end-item.start)/(Math.max(.15,Number(analysis.beatInterval)||.5)*4))),type:selectedType,preset,stats:item.stats};
    });
    const automaticCues=automaticCuesFor(phrases);
    const manualCues=(old?.cues||[]).filter(cue=>!cue.automatic&&['blackout','full-punch'].includes(cue.type)&&Number(cue.time)>=0&&Number(cue.time)<=duration).map(cue=>({...cue,time:Number(cue.time)}));
    return {version:1,barsPerPhrase,createdAt:new Date().toISOString(),phrases,cues:[...automaticCues,...manualCues].sort((a,b)=>a.time-b.time),reactive:{low:{gain:old?.reactive?.low?.gain??.34},mid:{gain:old?.reactive?.mid?.gain??.2},high:{gain:old?.reactive?.high?.gain??.16},attack:old?.reactive?.attack??.58,release:old?.reactive?.release??.12,enterThreshold:old?.reactive?.enterThreshold??.1,exitThreshold:old?.reactive?.exitThreshold??.05}};
  }
  function normalize(score,analysis){
    const duration=Math.max(.1,Number(analysis.duration)||0),phrases=(score?.phrases||[]).map((phrase,index)=>({...phrase,id:phrase.id||`phrase-${index+1}`,start:clamp(Number(phrase.start)||0,0,duration),end:clamp(Number(phrase.end)||duration,0,duration),type:TYPES.includes(phrase.type)?phrase.type:'verse',preset:PRESETS.includes(phrase.preset)?phrase.preset:'step'})).sort((a,b)=>a.start-b.start);
    phrases.forEach((phrase,index)=>{phrase.end=index+1<phrases.length?phrases[index+1].start:duration;phrase.bars=Math.max(1,Math.round((phrase.end-phrase.start)/(Math.max(.15,Number(analysis.beatInterval)||.5)*4)));});
    const manual=(score?.cues||[]).filter(cue=>!cue.automatic&&Number.isFinite(Number(cue.time))).map(cue=>({...cue,time:Number(cue.time)}));
    return {...score,version:1,phrases,cues:[...automaticCuesFor(phrases),...manual].sort((a,b)=>a.time-b.time)};
  }
  function phraseAt(score,time){return score?.phrases?.find((phrase,index)=>time>=phrase.start&&(time<phrase.end||index===score.phrases.length-1))||score?.phrases?.[0]||null;}
  const api={TYPES,PRESETS,TYPE_LABELS,PRESET_LABELS,DEFAULT_PRESET,compile,normalize,phraseAt,sample,barsFromAnalysis};
  root.HueShowScore=api;if(typeof module!=='undefined')module.exports=api;
})(globalThis);
