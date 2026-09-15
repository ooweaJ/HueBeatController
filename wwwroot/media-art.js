// Deterministic, layered show renderer for pre-analysed audio.
// The same complete A/B-pair frame is used by the browser simulator and Hue transport.
(function(root){
  const Score=root.HueShowScore||(typeof require!=='undefined'?require('./show-score.js'):null);
  const clamp=(value,min=0,max=1)=>Math.max(min,Math.min(max,value));
  const paletteSize=8;
  const sectionMode=type=>type==='bridge'?'break':(['intro','verse','build','climax','outro'].includes(type)?type:'verse');

  function cueNear(cues,time,type,window=.055){return cues?.some(cue=>cue.type===type&&Math.abs(Number(cue.time)-time)<=window);}
  function beatContext(analysis,time){
    const interval=Math.max(.15,Number(analysis.beatInterval)||.5),start=Number(analysis.beatGridStart)||0,position=Math.max(0,(time-start)/interval),index=Math.floor(position+.08);
    return {interval,index,phase:position-Math.floor(position),bar:Math.floor(index/4),inBar:((index%4)+4)%4};
  }
  function audioFeaturesAt(analysis,score,time,state){
    const step=Number(analysis.envelopeStep)||.1,settings=score.reactive||{};
    const raw={
      energy:Score.sample(analysis.envelope,time,step),
      low:Score.sample(analysis.bassEnvelope,time,step),
      mid:Score.sample(analysis.midEnvelope,time,step),
      high:Score.sample(analysis.highEnvelope,time,step),
      onset:Score.sample(analysis.onsetEnvelope,time,step),
      bassOnset:Score.sample(analysis.bassOnsetEnvelope,time,step),
      flux:Score.sample(analysis.spectralFluxEnvelope,time,step)
    };
    for(const band of ['low','mid','high']){
      const target=raw[band],rate=target>state[band]?(settings.attack??.58):(settings.release??.12);
      state[band]+=(target-state[band])*rate;
    }
    const energyRate=raw.energy>state.energy ? .18 : .045;
    state.energy+=(raw.energy-state.energy)*energyRate;
    const lowScale=(settings.low?.gain??.34)/.34,midScale=(settings.mid?.gain??.2)/.2,highScale=(settings.high?.gain??.16)/.16;
    return {...raw,energy:state.energy,low:clamp(state.low*lowScale),mid:clamp(state.mid*midScale),high:clamp(state.high*highScale)};
  }
  function peakEvents(values,step,threshold,minGap,strength=(value=>value)){
    const events=[];
    for(let index=1;index<(values?.length||0)-1;index++){
      const value=Number(values[index])||0;
      if(value<threshold||value<Number(values[index-1]||0)||value<Number(values[index+1]||0))continue;
      const time=index*step,previous=events.at(-1);
      if(previous&&time-previous.time<minGap){if(value>previous.raw){previous.time=time;previous.raw=value;previous.strength=clamp(strength(value));}continue;}
      events.push({time,raw:value,strength:clamp(strength(value))});
    }
    return events;
  }
  function mergeKickEvents(analysis){
    const events=(analysis.beatTimes||[]).map((time,index)=>({time:Number(time),strength:clamp(Number(analysis.cueStrengths?.[index])||.6)})).sort((a,b)=>a.time-b.time),merged=[];
    for(const event of events){
      const previous=merged.at(-1);
      if(previous&&event.time-previous.time<.18){if(event.strength>previous.strength)Object.assign(previous,event);}
      else merged.push(event);
    }
    return merged;
  }
  function eventEnvelope(time,event,decay){
    if(!event)return 0;const elapsed=time-event.time;return elapsed>=0&&elapsed<decay*4?event.strength*Math.exp(-elapsed/decay):0;
  }
  function phraseProgress(phrase,time){return phrase?clamp((time-phrase.start)/Math.max(.01,phrase.end-phrase.start)):0;}
  function baseLayer(mode,slotCount,features,progress,focus){
    const weights=Array(slotCount).fill(0),colors=Array(slotCount).fill(0);
    if(mode==='climax')weights.fill(.42+features.energy*.12);
    else if(mode==='build'){
      const active=Math.max(1,Math.ceil(progress*slotCount));
      for(let index=0;index<active;index++)weights[index]=.08+progress*.18+features.energy*.05;
      for(let index=active;index<slotCount;index++)weights[index]=.02;
    }else if(mode==='break'){
      weights.fill(.008);weights[focus]=.055+features.energy*.04;
    }else if(mode==='intro'){
      weights.fill(.018);weights[focus]=.055+features.energy*.055;
    }else if(mode==='outro'){
      weights.fill((.07+features.energy*.06)*(1-progress));
    }else{
      weights.fill(.045+features.energy*.055);weights[focus]+=.055;
    }
    return {weights,colors};
  }
  function composeFrame({mode,slotCount,features,progress,focus,kick,snare,hat,beat,paletteSwap}){
    const frame=baseLayer(mode,slotCount,features,progress,focus),layers={background:[...frame.weights],kick:0,snare:0,high:0};
    const kickLevel=clamp(eventEnvelope(beat.time,kick,.19)*(.55+features.low*.65)),snareLevel=clamp(eventEnvelope(beat.time,snare,.12)*(.55+features.mid*.6)),hatLevel=clamp(eventEnvelope(beat.time,hat,.075)*(.45+features.high*.65));
    layers.kick=kickLevel;layers.snare=snareLevel;layers.high=hatLevel;
    if(kickLevel>.01){
      if(mode==='climax')for(let index=0;index<slotCount;index++)frame.weights[index]+=kickLevel*.52;
      else if(mode==='build'){
        const active=Math.max(1,Math.ceil(progress*slotCount));for(let index=0;index<active;index++)frame.weights[index]+=kickLevel*.48;
      }else{
        frame.weights[focus]+=kickLevel*.86;
        if(slotCount>2){frame.weights[(focus+slotCount-1)%slotCount]+=kickLevel*.08;frame.weights[(focus+1)%slotCount]+=kickLevel*.08;}
      }
    }
    if(snareLevel>.025){
      for(let index=0;index<slotCount;index++)if((index+beat.inBar)%2===paletteSwap%2){frame.weights[index]+=snareLevel*(mode==='climax'?.42:.28);frame.colors[index]=4;}
    }
    if(hatLevel>.035){const glint=(beat.index+paletteSwap)%slotCount;frame.weights[glint]+=hatLevel*.22;frame.colors[glint]=2;}
    return {weights:frame.weights.map(value=>clamp(value)),colorOffsets:frame.colors,layers};
  }
  function compile(analysis){
    const slotCount=Math.max(1,Math.floor(Number(analysis.slotCount)||1)),duration=Math.max(.1,Number(analysis.duration)||0),step=.05,sourceScore=analysis.lightingScore?.version===2?analysis.lightingScore:Score.compile({...analysis,lightingScore:null}),score=Score.normalize(sourceScore,analysis),frames=[],cues=score.cues||[],featureStep=Number(analysis.envelopeStep)||.1;
    const kicks=mergeKickEvents(analysis),snares=peakEvents((analysis.onsetEnvelope||[]).map((value,index)=>clamp((Number(value)||0)*.62+(Number(analysis.midEnvelope?.[index])||0)*.38)),featureStep,.58,.22,value=>.35+value*.65),hats=peakEvents((analysis.spectralFluxEnvelope||[]).map((value,index)=>clamp((Number(value)||0)*.55+(Number(analysis.highEnvelope?.[index])||0)*.45)),featureStep,.76,.28,value=>.25+value*.55);
    const featureState={energy:0,low:0,mid:0,high:0};let kickCursor=0,snareCursor=0,hatCursor=0,lastKick=null,lastSnare=null,lastHat=null,movement=-1,lastPhraseId='',paletteSwap=0,lastMode='';
    for(let index=0;index<Math.ceil(duration/step);index++){
      const time=index*step,phrase=Score.phraseAt(score,time),mode=sectionMode(phrase?.type),progress=phraseProgress(phrase,time),beat=beatContext(analysis,time),features=audioFeaturesAt(analysis,score,time,featureState);beat.time=time;
      let hit=false,snareHit=false,hatHit=false;
      while(kickCursor<kicks.length&&kicks[kickCursor].time<=time+step*.55){lastKick=kicks[kickCursor++];movement=(movement+1)%slotCount;hit=true;}
      while(snareCursor<snares.length&&snares[snareCursor].time<=time+step*.55){lastSnare=snares[snareCursor++];paletteSwap++;snareHit=true;}
      while(hatCursor<hats.length&&hats[hatCursor].time<=time+step*.55){lastHat=hats[hatCursor++];hatHit=true;}
      if(phrase?.id!==lastPhraseId){lastPhraseId=phrase?.id||'';movement=Math.max(0,movement);}
      const focus=mode==='build'?Math.min(slotCount-1,Math.floor(progress*slotCount)):Math.max(0,movement)%slotCount;
      const phraseIndex=Math.max(0,score.phrases.indexOf(phrase)),color=(phraseIndex*2)%paletteSize;
      const rendered=composeFrame({mode,slotCount,features,progress,focus,kick:lastKick,snare:lastSnare,hat:lastHat,beat,paletteSwap});
      const enteredClimax=mode==='climax'&&lastMode!=='climax',blackout=cueNear(cues,time,'blackout',step*.7),bloom=cueNear(cues,time,'full-punch',step*.7)||enteredClimax;
      if(enteredClimax&&frames.length)for(const previous of frames.slice(-3)){previous.weights.fill(0);previous.blackout=true;}
      if(blackout)rendered.weights.fill(0);if(bloom)rendered.weights.fill(1);
      frames.push({mode,preset:'layered-show',phraseId:phrase?.id||'',color,colorOffsets:rendered.colorOffsets,weights:rendered.weights,hit,snareHit,hatHit,bloom,blackout,reactive:features.energy,low:features.low,mid:features.mid,high:features.high,focus,layers:rendered.layers});
      lastMode=mode;
    }
    return {version:8,scoreVersion:score.version,slotCount,step,frames,score,eventCounts:{kick:kicks.length,snare:snares.length,high:hats.length}};
  }
  function sample(timeline,time){return timeline?.frames?.[Math.max(0,Math.min(timeline.frames.length-1,Math.floor(time/timeline.step+1e-7)))]||null;}
  const api={compile,sample,composeFrame,peakEvents};root.HueMediaArt=api;if(typeof module!=='undefined')module.exports=api;
})(globalThis);
