// Deterministic, layered show renderer for pre-analysed audio.
// The same complete A/B-pair frame is used by the browser simulator and Hue transport.
(function(root){
  const Score=root.HueShowScore||(typeof require!=='undefined'?require('./show-score.js'):null);
  const clamp=(value,min=0,max=1)=>Math.max(min,Math.min(max,value));
  const paletteSize=8;
  const sectionMode=type=>type==='bridge'?'break':(['intro','verse','build','climax','outro'].includes(type)?type:'verse');

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
      // A plateau is not a new attack. Require a real rising edge and local prominence.
      const left=Number(values[index-1])||0,right=Number(values[index+1])||0;
      const history=values.slice(Math.max(0,index-6),index),baseline=history.reduce((sum,v)=>sum+(Number(v)||0),0)/Math.max(1,history.length);
      if(value<threshold||value<=left+1e-6||value<right||value-baseline<.08)continue;
      const time=index*step,previous=events.at(-1);
      if(previous&&time-previous.time<minGap){if(value>previous.raw){previous.time=time;previous.raw=value;previous.strength=clamp(strength(value));}continue;}
      events.push({time,raw:value,strength:clamp(strength(value))});
    }
    return events;
  }
  function mergeKickEvents(analysis){
    const events=(analysis.beatTimes||[]).map((time,index)=>({time:Number(time),strength:clamp(Number(analysis.cueStrengths?.[index])||.6)})).filter(event=>Number.isFinite(event.time)&&event.time>=0).sort((a,b)=>a.time-b.time),merged=[];
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
  function composeFrame({mode,slotCount,features,progress,focus,active,time}){
    const frame=baseLayer(mode,slotCount,features,progress,focus);
    const layers={background:[...frame.weights],kick:0,snare:0,high:0},colorMix=Array(slotCount).fill(0);
    // Each event owns its targets and amplitude until its tail finishes.
    // Max composition preserves accents without saturating overlapping tails.
    for(const event of active){
      const level=eventEnvelope(time,event,event.decay);
      layers[event.kind]=Math.max(layers[event.kind],level);
      for(const target of event.targets){
        frame.weights[target]=Math.max(frame.weights[target],event.base+level*event.amount);
        if(event.kind!=='kick')colorMix[target]=Math.max(colorMix[target],level);
      }
    }
    return {weights:frame.weights.map(value=>clamp(value)),colorOffsets:Array(slotCount).fill(4),colorMix,layers};
  }
  function compile(analysis){
    const slotCount=Math.max(1,Math.floor(Number(analysis.slotCount)||1)),duration=Math.max(.1,Number(analysis.duration)||0),step=.05,sourceScore=analysis.lightingScore?.version===2?analysis.lightingScore:Score.compile({...analysis,lightingScore:null}),score=Score.normalize(sourceScore,analysis),frames=[],cues=score.cues||[],featureStep=Number(analysis.envelopeStep)||.1;
    const kicks=mergeKickEvents(analysis),snares=peakEvents((analysis.onsetEnvelope||[]).map((value,index)=>clamp((Number(value)||0)*.62+(Number(analysis.midEnvelope?.[index])||0)*.38)),featureStep,.58,.22,value=>.35+value*.65),hats=peakEvents((analysis.spectralFluxEnvelope||[]).map((value,index)=>clamp((Number(value)||0)*.55+(Number(analysis.highEnvelope?.[index])||0)*.45)),featureStep,.76,.28,value=>.25+value*.55);
    // Events within 120 ms represent one musical attack: kick > mid accent > high.
    const near=(events,time)=>events.some(event=>Math.abs(event.time-time)<=.12);
    const acceptedSnares=snares.filter(event=>!near(kicks,event.time));
    const acceptedHats=hats.filter(event=>!near(kicks,event.time)&&!near(acceptedSnares,event.time));
    const events=[...kicks.map(e=>({...e,kind:'kick'})),...acceptedSnares.map(e=>({...e,kind:'snare'})),...acceptedHats.map(e=>({...e,kind:'high'}))].sort((a,b)=>a.time-b.time);
    const featureState={energy:0,low:0,mid:0,high:0};
    let cursor=0,movement=-1,lastPhraseId=null,paletteSwap=0,color=0,mode='intro',sceneStart=0,sceneEnd=duration,active=[];
    for(let index=0;index<Math.ceil(duration/step);index++){
      const time=index*step,phrase=Score.phraseAt(score,time),beat=beatContext(analysis,time),features=audioFeaturesAt(analysis,score,time,featureState);
      if(phrase?.id!==lastPhraseId){
        const first=lastPhraseId===null,phraseIndex=score.phrases.indexOf(phrase),previous=score.phrases[phraseIndex-1];
        const delta=Math.abs((phrase?.stats?.energy??0)-(previous?.stats?.energy??0));
        const trusted=phrase?.confirmed===true||(delta>=.18&&time-sceneStart>=4);
        const next=sectionMode(phrase?.type);
        if(first||(trusted&&next!==mode)){
          mode=next;sceneStart=time;sceneEnd=phrase?.end||duration;
          if(!first)color=(color+2)%paletteSize;
          active=[]; // Accepted scene changes explicitly end the previous look.
        }else sceneEnd=Math.max(sceneEnd,phrase?.end||duration);
        lastPhraseId=phrase?.id||'';
      }
      const progress=clamp((time-sceneStart)/Math.max(.01,sceneEnd-sceneStart));
      let hit=false,snareHit=false,hatHit=false;
      while(cursor<events.length&&events[cursor].time<=time+1e-7){
        const event=events[cursor++],kind=event.kind;
        if(kind==='kick'){movement=(movement+1)%slotCount;hit=true;}
        if(kind==='snare'){paletteSwap++;snareHit=true;}
        if(kind==='high')hatHit=true;
        const target=Math.max(0,movement),all=Array.from({length:slotCount},(_,i)=>i);
        const targets=kind==='kick'?(mode==='climax'?all:mode==='build'?all.slice(0,Math.max(1,Math.ceil(progress*slotCount))):[target]):
          kind==='snare'?all.filter(i=>i%2===paletteSwap%2):[(beat.index+paletteSwap)%slotCount];
        const band=kind==='kick'?'low':kind==='snare'?'mid':'high';
        const gain=score.reactive?.[band]?.gain??({low:.34,mid:.2,high:.16}[band]);
        const scale=gain/({low:.34,mid:.2,high:.16}[band]);
        active.push({...event,time,sourceTime:event.time,strength:clamp(event.strength*scale),targets,base:mode==='climax'?.46:.06,
          decay:kind==='kick'?.19:kind==='snare'?.12:.075,amount:kind==='kick'?(mode==='climax'?.54:.9):kind==='snare'?.35:.22});
      }
      active=active.filter(event=>time-event.time<event.decay*4);
      const focus=mode==='build'?Math.min(slotCount-1,Math.floor(progress*slotCount)):Math.max(0,movement)%slotCount;
      const rendered=composeFrame({mode,slotCount,features,progress,focus,active,time});
      // Only explicit cues may force a flash or blackout; classification is not a cue.
      const explicit=cues.filter(cue=>cue.automatic===false||cue.confirmed===true);
      const blackout=explicit.some(c=>c.type==='blackout'&&time>=c.time&&time<c.time+.15);
      const bloom=!blackout&&explicit.some(c=>c.type==='full-punch'&&time>=c.time&&time<c.time+.1);
      if(blackout){rendered.weights.fill(0);active=[];}else if(bloom)rendered.weights.fill(1);
      frames.push({mode,preset:'layered-show',phraseId:phrase?.id||'',color,colorOffsets:rendered.colorOffsets,colorMix:rendered.colorMix,weights:rendered.weights,hit,snareHit,hatHit,bloom,blackout,transitionMs:0,reactive:features.energy,low:features.low,mid:features.mid,high:features.high,focus,layers:rendered.layers});
    }
    return {version:9,scoreVersion:score.version,slotCount,step,frames,score,eventCounts:{kick:kicks.length,snare:acceptedSnares.length,high:acceptedHats.length}};
  }
  function sample(timeline,time){return timeline?.frames?.[Math.max(0,Math.min(timeline.frames.length-1,Math.floor(time/timeline.step+1e-7)))]||null;}
  const api={compile,sample,composeFrame,peakEvents};root.HueMediaArt=api;if(typeof module!=='undefined')module.exports=api;
})(globalThis);
