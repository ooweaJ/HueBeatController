// Deterministic Hue Entertainment renderer driven by a saved timecode score.
(function(root){
  const Score=root.HueShowScore||(typeof require!=='undefined'?require('./show-score.js'):null);
  const clamp=(value,min=0,max=1)=>Math.max(min,Math.min(max,value));
  const paletteSize=8;
  function cueNear(cues,time,type,window=.055){return cues?.some(cue=>cue.type===type&&Math.abs(Number(cue.time)-time)<=window);}
  function beatContext(analysis,time){
    const interval=Math.max(.15,Number(analysis.beatInterval)||.5),start=Number(analysis.beatGridStart)||0,position=Math.max(0,(time-start)/interval),index=Math.floor(position+.08);
    return {interval,index,phase:position-index,bar:Math.floor(index/4),inBar:((index%4)+4)%4,near:Math.abs(position-Math.round(position))<.12};
  }
  function reactiveAt(analysis,score,time,state){
    const step=Number(analysis.envelopeStep)||.1,settings=score.reactive||{},values={low:Score.sample(analysis.bassEnvelope,time,step),mid:Score.sample(analysis.midEnvelope,time,step),high:Score.sample(analysis.highEnvelope,time,step)},enter=settings.enterThreshold??.1,exit=settings.exitThreshold??.05;
    let result=Score.sample(analysis.envelope,time,step)*.14;
    for(const band of ['low','mid','high']){if(!state.active[band]&&values[band]>=enter)state.active[band]=true;else if(state.active[band]&&values[band]<=exit)state.active[band]=false;const target=state.active[band]?values[band]:0,rate=target>state.values[band]?(settings.attack??.58):(settings.release??.12);state.values[band]+=(target-state.values[band])*rate;result+=state.values[band]*(settings[band]?.gain??0);}
    return clamp(result);
  }
  function renderPattern({preset,slotCount,localBeat,barInPhrase,hit,pulse,level}){
    const weights=Array(slotCount).fill(.07),colorOffsets=Array(slotCount).fill(0),index=((Math.floor(localBeat)%slotCount)+slotCount)%slotCount;
    if(preset==='ambient'){const breathing=.5+.5*Math.sin(localBeat*Math.PI/4);weights.fill(.045+level*.12+breathing*.025);}
    else if(preset==='step'){if(hit)weights[index]=1;else weights[index]=.22+level*.28;}
    else if(preset==='accumulate'){const count=Math.min(slotCount,1+(barInPhrase%slotCount));for(let i=0;i<count;i++)weights[i]=.32+level*.35;if(hit)weights[index]=1;}
    else if(preset==='alternate'){for(let i=0;i<slotCount;i++)weights[i]=(i+Math.floor(localBeat))%2===0?.38+level*.35:.06;if(hit)for(let i=Math.floor(localBeat)%2;i<slotCount;i+=2)weights[i]=.95;}
    else if(preset==='wave'){const path=slotCount===1?[0]:[...Array(slotCount).keys(),...Array.from({length:Math.max(0,slotCount-2)},(_,i)=>slotCount-2-i)],wave=path[Math.floor(localBeat*2)%path.length];weights.fill(.12+level*.22);weights[wave]=.72+pulse*.28;if(wave>0)weights[wave-1]=Math.max(weights[wave-1],.32);for(let i=0;i<slotCount;i++)colorOffsets[i]=(i+Math.floor(barInPhrase/2))%3;}
    else if(preset==='expand'){const center=(slotCount-1)/2,radius=(barInPhrase%Math.max(1,Math.ceil(slotCount/2)))+.5;for(let i=0;i<slotCount;i++)weights[i]=Math.abs(i-center)<=radius?.42+level*.35:.05;if(hit)weights[index]=1;}
    else if(preset==='full-punch'){weights.fill(.2+level*.42+pulse*.35);}
    else if(preset==='decay'){const count=Math.max(1,slotCount-(barInPhrase%slotCount));weights.fill(.035);for(let i=0;i<count;i++)weights[i]=clamp(.35+level*.3-pulse*.08);}
    return {weights:weights.map(value=>clamp(value)),colorOffsets};
  }
  function compile(analysis){
    const slotCount=Math.max(1,Math.floor(Number(analysis.slotCount)||1)),duration=Math.max(.1,Number(analysis.duration)||0),step=.05,score=Score.normalize(analysis.lightingScore||Score.compile(analysis),analysis),frames=[],cues=score.cues||[];
    const reactiveState={values:{low:0,mid:0,high:0},active:{low:false,mid:false,high:false}};let lastBeat=-1;
    for(let index=0;index<Math.ceil(duration/step);index++){
      const time=index*step,phrase=Score.phraseAt(score,time),beat=beatContext(analysis,time),localBeat=Math.max(0,(time-phrase.start)/beat.interval),barInPhrase=Math.floor(localBeat/4),hit=beat.near&&beat.index!==lastBeat;
      if(hit)lastBeat=beat.index;
      const reactive=reactiveAt(analysis,score,time,reactiveState);
      const pulse=hit?1:Math.exp(-Math.abs(beat.phase)*beat.interval/.18),rendered=renderPattern({preset:phrase.preset,slotCount,localBeat,barInPhrase,hit,pulse,level:reactive});
      const blackout=cueNear(cues,time,'blackout',step*.7),bloom=cueNear(cues,time,'full-punch',step*.7);
      if(blackout)rendered.weights.fill(0);if(bloom)rendered.weights.fill(1);
      const phraseIndex=score.phrases.indexOf(phrase),color=(phraseIndex*2+Math.floor(barInPhrase/4))%paletteSize;
      frames.push({mode:phrase.type,preset:phrase.preset,phraseId:phrase.id,color,colorOffsets:rendered.colorOffsets,weights:rendered.weights,hit,bloom,blackout,reactive});
    }
    return {version:6,scoreVersion:score.version,slotCount,step,frames,score};
  }
  function sample(timeline,time){return timeline?.frames?.[Math.max(0,Math.min(timeline.frames.length-1,Math.floor(time/timeline.step+1e-7)))]||null;}
  const api={compile,sample,renderPattern};root.HueMediaArt=api;if(typeof module!=='undefined')module.exports=api;
})(globalThis);
