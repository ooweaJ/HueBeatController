// Deterministic, group-size-aware choreography for Hue Entertainment.
// The timeline is compiled once from the saved analysis and sampled by audio time.
(function(root){
  const clamp=(value,min=0,max=1)=>Math.max(min,Math.min(max,value));
  const percentile=(values,ratio)=>{
    if(!values.length)return 0;
    const sorted=[...values].sort((a,b)=>a-b),index=(sorted.length-1)*ratio,low=Math.floor(index),high=Math.ceil(index);
    return sorted[low]+(sorted[high]-sorted[low])*(index-low);
  };
  const sample=(values,index)=>{
    if(!values.length)return 0;
    const safe=clamp(index,0,values.length-1),left=Math.floor(safe),right=Math.min(values.length-1,left+1),mix=safe-left;
    return (values[left]||0)*(1-mix)+(values[right]||0)*mix;
  };

  function compile(analysis){
    const sourceLevels=analysis.envelope||[],sourceBass=analysis.bassEnvelope||[],sourceStep=analysis.envelopeStep||.1;
    const slotCount=Math.max(1,Math.floor(Number(analysis.slotCount)||1));
    const duration=Math.max(Number(analysis.duration)||sourceLevels.length*sourceStep,.1),step=.05,frameCount=Math.ceil(duration/step);
    const levels=Array.from({length:frameCount},(_,i)=>sample(sourceLevels,i*step/sourceStep));
    const bass=Array.from({length:frameCount},(_,i)=>sample(sourceBass,i*step/sourceStep));
    const slow=levels.map((_,i)=>{
      let total=0,count=0;
      for(let j=Math.max(0,i-Math.round(2/step));j<=i;j++){total+=levels[j];count++;}
      return total/Math.max(1,count);
    });
    const active=slow.filter(value=>value>.015),q35=percentile(active,.35),q58=percentile(active,.58),q78=percentile(active,.78);
    const travelAt=Math.min(.2,q35),buildAt=Math.min(.46,Math.max(travelAt+.12,q58)),highlightAt=Math.max(buildAt+.12,q78);
    const bpm=clamp(Number(analysis.bpm)||120,70,180),beat=Math.max(.333,Math.min(.857,60/bpm));
    const cues=analysis.beatTimes||[],strengths=analysis.cueStrengths||[];
    const firstCue=cues.find(time=>time>=.2)??Math.max(.2,levels.findIndex(value=>value>.04)*step);
    const frames=[];let mode='intro',candidate='intro',candidateSince=0,sectionAt=0,lastPulse=-10,nextCueIndex=0,position=-1,color=0,phrase=-1,highlightStarted=-10,blackoutUntil=-10,lastDrop=-10;

    for(let i=0;i<frameCount;i++){
      const time=i*step,level=levels[i],average=slow[i],previous=levels[Math.max(0,i-1)],bassRise=bass[i]-bass[Math.max(0,i-2)];
      const ending=time>duration-7,remaining=duration-time;
      let desired=ending?'outro':average>=highlightAt?'highlight':average>=buildAt?'build':average>=travelAt?'travel':'intro';
      if(time<firstCue-step*.55)desired='intro';else if(desired==='intro')desired='travel';
      if(desired!==candidate){candidate=desired;candidateSince=time;}
      let sectionEntry=false;
      const hold=desired==='highlight'?.55:desired==='outro'?.2:1.1;
      const firstCueEntry=mode==='intro'&&time>=firstCue-step*.55&&candidate!=='intro';
      if(firstCueEntry||(candidate!==mode&&time-candidateSince>=hold&&time-sectionAt>=3)){
        mode=candidate;sectionAt=time;sectionEntry=true;phrase=-1;
        if(mode==='highlight'||mode==='outro')color=(color+2)%8;
        if(mode==='highlight')highlightStarted=time;
      }

      const localBeat=Math.max(0,Math.floor((time-firstCue)/beat+.08));
      const beatTime=firstCue+localBeat*beat,nearGrid=Math.abs(time-beatTime)<=step*.6;
      while(nextCueIndex<cues.length&&cues[nextCueIndex]<time-step*.55)nextCueIndex++;
      let cue=null;if(nextCueIndex<cues.length&&Math.abs(cues[nextCueIndex]-time)<=step*.55){cue={time:cues[nextCueIndex],strength:strengths[nextCueIndex]??.6};nextCueIndex++;}
      const rawAttack=Boolean(cue)||bassRise>.055||level-previous>.065;
      const beatStride=mode==='intro'?4:mode==='travel'?2:1;
      const gridAttack=!cues.length&&nearGrid&&localBeat%beatStride===0&&level>.018;
      const minimumGap=mode==='intro'?Math.max(1.2,beat*2.5):mode==='travel'?Math.max(.32,beat*.55):mode==='build'?Math.max(.24,beat*.45):mode==='highlight'?Math.max(.2,beat*.42):Math.max(.6,beat*1.2);
      const hit=time>=firstCue-step*.55&&(rawAttack||gridAttack)&&time-lastPulse>=minimumGap;
      if(hit){
        lastPulse=time;
        if(mode==='outro')position=Math.max(0,position-1);
        else position=(position+1)%slotCount;
      }

      let crossing=-1;
      for(let j=i;j<Math.min(frameCount,i+Math.ceil(1.2/step));j++){if(slow[j]>=highlightAt){crossing=j;break;}}
      const timeToCrossing=crossing<0?Infinity:(crossing-i)*step;
      if(mode!=='highlight'&&timeToCrossing>0&&timeToCrossing<=.45&&average<highlightAt&&time-lastDrop>=8){blackoutUntil=time+timeToCrossing+.05;lastDrop=time;}
      const preDrop=time<blackoutUntil;
      const downbeat=localBeat%4===0,phraseIndex=Math.floor(localBeat/8);
      if(phraseIndex!==phrase&&nearGrid){phrase=phraseIndex;if(mode==='highlight')color=(color+3)%8;}

      const sinceHit=time-lastPulse,pulse=sinceHit<0?0:Math.exp(-sinceHit/(mode==='highlight'?.16:.24));
      const base=clamp(.05+level*.55),weights=Array(slotCount).fill(0),colorOffsets=Array(slotCount).fill(0);
      if(mode==='intro'){
        const breathe=.5+.5*Math.sin(time*Math.PI/1.8);
        const ambient=clamp(.025+level*.075,.03,.1)*(.78+.22*breathe);weights.fill(ambient);
      }else if(mode==='travel'||mode==='build'){
        const background=.08,active=Math.max(0,position),punchHold=mode==='build'?.16:.14,decay=mode==='build'?.24:.3;
        weights.fill(background);if(sinceHit>=0&&sinceHit<punchHold)weights[active]=1;else if(sinceHit<punchHold+decay)weights[active]=1-(sinceHit-punchHold)/decay*(1-background);
      }else if(mode==='highlight'){
        const wavePath=slotCount===1?[0]:[...Array(slotCount).keys(),...Array.from({length:Math.max(0,slotCount-2)},(_,index)=>slotCount-2-index)],wave=wavePath[Math.floor(Math.max(0,time-highlightStarted)/Math.max(.25,beat/2))%wavePath.length];
        for(let n=0;n<slotCount;n++){weights[n]=clamp(.18+level*.34+pulse*(downbeat?.42:.24));colorOffsets[n]=(n+phraseIndex)%3;}
        weights[wave]=clamp(.65+level*.25+pulse*.25);if(wave>0)weights[wave-1]=Math.max(weights[wave-1],weights[wave]*.48);
      }else{
        const count=Math.round(clamp(Math.ceil(remaining/1.25),1,slotCount));
        for(let n=0;n<count;n++)weights[n]=clamp((.05+level*.28)*(remaining/7));
      }

      const dropImpact=i>0&&frames[i-1]?.blackout&&!preDrop;
      const bloom=dropImpact||(mode==='highlight'&&((sectionEntry&&time-sectionAt<.16)||(hit&&downbeat&&(cue?.strength??level)>.62)));
      const punchHold=(mode==='travel'||mode==='build')&&sinceHit>=0&&sinceHit<(mode==='build'?.16:.14);
      const blackout=preDrop;
      if(blackout)weights.fill(0);else if(bloom)weights.fill(1);
      const fadeIn=clamp(time/1.2),fadeOut=clamp(remaining/1.8);
      frames.push({mode:blackout?'pre-drop':mode,color,colorOffsets,weights:weights.map(value=>clamp(value*fadeIn*fadeOut)),hit,punchHold,bloom,blackout});
    }
    return {version:5,slotCount,step,beat,thresholds:{travelAt,buildAt,highlightAt},frames};
  }

  function sampleTimeline(timeline,time){return timeline.frames[Math.max(0,Math.min(timeline.frames.length-1,Math.floor(time/timeline.step+1e-7)))];}
  const api={compile,sample:sampleTimeline};root.HueMediaArt=api;if(typeof module!=='undefined')module.exports=api;
})(globalThis);
