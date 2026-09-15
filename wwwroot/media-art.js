// Offline audio-reactive renderer. Analysis and Hue transport stay separate:
// every 50 ms this module produces one complete state for all A/B light pairs.
(function(root){
  const Score=root.HueShowScore||(typeof require!=='undefined'?require('./show-score.js'):null);
  const clamp=(value,min=0,max=1)=>Math.max(min,Math.min(max,value));
  const paletteSize=8;
  function cueNear(cues,time,type,window=.055){return cues?.some(cue=>cue.type===type&&Math.abs(Number(cue.time)-time)<=window);}
  function beatContext(analysis,time){
    const interval=Math.max(.15,Number(analysis.beatInterval)||.5),start=Number(analysis.beatGridStart)||0,position=Math.max(0,(time-start)/interval),index=Math.floor(position+.08);
    return {interval,index,bar:Math.floor(index/4),inBar:((index%4)+4)%4};
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
    const energyRate=raw.energy>state.energy ? .18 : .045;state.energy+=(raw.energy-state.energy)*energyRate;
    const drive=clamp(state.energy*.34+state.low*(settings.low?.gain??.34)+state.mid*(settings.mid?.gain??.2)+state.high*(settings.high?.gain??.16));
    return {...raw,low:state.low,mid:state.mid,high:state.high,drive};
  }
  function renderReactiveField({slotCount,time,beat,features,punch,hit,peak,calm,colorSeed}){
    const base=peak ? .38+features.drive*.38 : calm ? .045+features.drive*.16 : .13+features.drive*.3;
    const weights=Array(slotCount).fill(base),colorOffsets=Array(slotCount).fill(0),focus=((beat.index%slotCount)+slotCount)%slotCount;
    for(let index=0;index<slotCount;index++){
      const wave=(.5+.5*Math.sin(time*(peak?5.2:2.1)-index*1.35))*(peak ? .12 : .045);
      weights[index]+=wave;
      if(peak)colorOffsets[index]=(index%2)*2+(Math.floor(beat.bar/2)%2);
      else if(!calm)colorOffsets[index]=(index+Math.floor(features.mid*3)+colorSeed)%3;
    }
    if(hit||punch>.03){
      if(peak){
        for(let index=0;index<slotCount;index++)weights[index]+=punch*(.28+(index%2===beat.inBar%2 ? .16 : .04));
      }else{
        weights[focus]+=punch*.62;
        if(slotCount>1){weights[(focus+slotCount-1)%slotCount]+=punch*.13;weights[(focus+1)%slotCount]+=punch*.13;}
      }
    }
    return {weights:weights.map(value=>clamp(value)),colorOffsets};
  }
  function compile(analysis){
    const slotCount=Math.max(1,Math.floor(Number(analysis.slotCount)||1)),duration=Math.max(.1,Number(analysis.duration)||0),step=.05,sourceScore=analysis.lightingScore?.version===2?analysis.lightingScore:Score.compile({...analysis,lightingScore:null}),score=Score.normalize(sourceScore,analysis),frames=[],cues=score.cues||[],hits=(analysis.beatTimes||[]).map((time,index)=>({time:Number(time),strength:clamp(Number(analysis.cueStrengths?.[index])||.6)})),flux=analysis.spectralFluxEnvelope||[],featureStep=Number(analysis.envelopeStep)||.1;
    for(let index=1;index<flux.length-1;index++)if(flux[index]>=.7&&flux[index]>=flux[index-1]&&flux[index]>=flux[index+1])hits.push({time:index*featureStep,strength:clamp(.35+flux[index]*.5)});
    hits.sort((left,right)=>left.time-right.time);const mergedHits=[];for(const hit of hits){const previous=mergedHits.at(-1);if(previous&&hit.time-previous.time<.18){if(hit.strength>previous.strength)Object.assign(previous,hit);}else mergedHits.push(hit);}
    const featureState={energy:0,low:0,mid:0,high:0};let hitCursor=0,lastHitTime=-Infinity,lastHitStrength=0,longDrive=0,peak=false,peakHoldUntil=0,lastPeak=false;
    for(let index=0;index<Math.ceil(duration/step);index++){
      const time=index*step,phrase=Score.phraseAt(score,time),beat=beatContext(analysis,time),features=audioFeaturesAt(analysis,score,time,featureState);
      let hit=false;
      while(hitCursor<mergedHits.length&&mergedHits[hitCursor].time<=time+step*.55){lastHitTime=mergedHits[hitCursor].time;lastHitStrength=clamp(mergedHits[hitCursor].strength*(.35+features.drive*.65));hit=true;hitCursor++;}
      const elapsed=time-lastHitTime,punch=elapsed>=0&&elapsed<.65?lastHitStrength*Math.exp(-elapsed/.15):0;
      longDrive+=(features.drive-longDrive)*(features.drive>longDrive ? .075 : .012);
      const peakEntry=longDrive>=.56||(features.drive>=.72&&(features.onset>=.38||features.bassOnset>=.34||features.flux>=.55));
      if(!peak&&peakEntry){peak=true;peakHoldUntil=time+Math.max(3,beat.interval*8);}
      else if(peak&&time>=peakHoldUntil&&longDrive<.39)peak=false;
      const calm=!peak&&longDrive<.23&&features.drive<.38,peakEntered=peak&&!lastPeak;
      const phraseIndex=Math.max(0,score.phrases.indexOf(phrase)),colorSeed=(phraseIndex*2+Math.floor(beat.bar/4))%paletteSize;
      const rendered=renderReactiveField({slotCount,time,beat,features,punch,hit,peak,calm,colorSeed});
      const blackout=cueNear(cues,time,'blackout',step*.7),bloom=cueNear(cues,time,'full-punch',step*.7)||peakEntered;
      if(peakEntered&&frames.length){for(const previous of frames.slice(-2)){previous.weights.fill(0);previous.blackout=true;}}
      if(blackout)rendered.weights.fill(0);if(bloom)rendered.weights.fill(1);
      const mode=peak?'climax':calm?'intro':phrase?.type==='build'?'build':'verse';
      frames.push({mode,preset:'reactive-field',phraseId:phrase?.id||'',color:colorSeed,colorOffsets:rendered.colorOffsets,weights:rendered.weights,hit,bloom,blackout,reactive:features.drive,low:features.low,mid:features.mid,high:features.high,peak});
      lastPeak=peak;
    }
    return {version:7,scoreVersion:score.version,slotCount,step,frames,score};
  }
  function sample(timeline,time){return timeline?.frames?.[Math.max(0,Math.min(timeline.frames.length-1,Math.floor(time/timeline.step+1e-7)))]||null;}
  const api={compile,sample,renderReactiveField};root.HueMediaArt=api;if(typeof module!=='undefined')module.exports=api;
})(globalThis);
