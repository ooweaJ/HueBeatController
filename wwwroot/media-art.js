// Deterministic five-pair choreography for Hue Entertainment.
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
    const frames=[];let mode='intro',candidate='intro',candidateSince=0,sectionAt=0,lastPulse=-10,lastCueIndex=-1,position=0,direction=1,color=0,phrase=-1,highlightStarted=-10,blackoutUntil=-10,lastDrop=-10;

    const cueNear=(time,radius)=>{
      while(lastCueIndex+1<cues.length&&cues[lastCueIndex+1]<=time+radius)lastCueIndex++;
      if(lastCueIndex<0)return null;
      const cueTime=cues[lastCueIndex],distance=Math.abs(cueTime-time);
      return distance<=radius?{time:cueTime,strength:strengths[lastCueIndex]??.6}:null;
    };

    for(let i=0;i<frameCount;i++){
      const time=i*step,level=levels[i],average=slow[i],previous=levels[Math.max(0,i-1)],bassRise=bass[i]-bass[Math.max(0,i-2)];
      const ending=time>duration-7,remaining=duration-time;
      let desired=ending?'outro':average>=highlightAt?'highlight':average>=buildAt?'build':average>=travelAt?'travel':'intro';
      if(time<firstCue+2.5)desired='intro';
      if(desired!==candidate){candidate=desired;candidateSince=time;}
      let sectionEntry=false;
      const hold=desired==='highlight'?.55:desired==='outro'?.2:1.1;
      if(candidate!==mode&&time-candidateSince>=hold&&time-sectionAt>=3){
        mode=candidate;sectionAt=time;sectionEntry=true;color=(color+2)%8;phrase=-1;
        if(mode==='highlight')highlightStarted=time;
      }

      const localBeat=Math.max(0,Math.floor((time-firstCue)/beat+.08));
      const beatTime=firstCue+localBeat*beat,nearGrid=Math.abs(time-beatTime)<=step*.6;
      const cue=cueNear(time,step*.75),rawAttack=Boolean(cue)||bassRise>.055||level-previous>.065;
      const beatStride=mode==='intro'?4:mode==='travel'?2:1;
      const gridAttack=nearGrid&&localBeat%beatStride===0&&level>.018;
      const minimumGap=mode==='intro'?Math.max(1.4,beat*3.5):mode==='travel'?Math.max(.72,beat*1.5):mode==='build'?Math.max(.42,beat*.85):mode==='highlight'?Math.max(.24,beat*.48):Math.max(.75,beat*1.5);
      const hit=(rawAttack||gridAttack||sectionEntry)&&time-lastPulse>=minimumGap;
      if(hit){
        lastPulse=time;
        if(mode==='outro')position=Math.max(0,position-1);
        else{position+=direction;if(position>=4){position=4;direction=-1;}else if(position<=0){position=0;direction=1;}}
      }

      let crossing=-1;
      for(let j=i;j<Math.min(frameCount,i+Math.ceil(1.2/step));j++){if(slow[j]>=highlightAt){crossing=j;break;}}
      const timeToCrossing=crossing<0?Infinity:(crossing-i)*step;
      if(mode!=='highlight'&&timeToCrossing>0&&timeToCrossing<=.2&&average<highlightAt&&time-lastDrop>=8){blackoutUntil=time+timeToCrossing;lastDrop=time;}
      const preDrop=time<blackoutUntil;
      const downbeat=localBeat%4===0,phraseIndex=Math.floor(localBeat/8);
      if(phraseIndex!==phrase&&nearGrid){phrase=phraseIndex;color=(color+(mode==='highlight'?3:1))%8;}

      const sinceHit=time-lastPulse,pulse=sinceHit<0?0:Math.exp(-sinceHit/(mode==='highlight'?.16:.24));
      const base=clamp(.05+level*.55),weights=Array(5).fill(0),colorOffsets=Array(5).fill(0);
      if(mode==='intro'){
        const breathe=.5+.5*Math.sin(time*Math.PI/1.8);
        weights[position]=clamp(.018+level*.075+pulse*.07)*(.65+.35*breathe);
        if(position>0)weights[position-1]=weights[position]*.13;
      }else if(mode==='travel'){
        weights[position]=clamp(base*.55+pulse*.35);
        const tail=position-direction;
        if(tail>=0&&tail<5)weights[tail]=weights[position]*.28;
        colorOffsets[position]=1;
      }else if(mode==='build'){
        const count=Math.round(clamp(1+(average-travelAt)/Math.max(.01,highlightAt-travelAt)*4,2,5));
        for(let n=0;n<count;n++){weights[n]=clamp(base*.46+pulse*(.22+n*.045));colorOffsets[n]=n%3;}
        weights[position]=Math.max(weights[position],clamp(base*.65+pulse*.32));
      }else if(mode==='highlight'){
        const wave=[0,1,2,3,4,3,2,1][Math.floor(Math.max(0,time-highlightStarted)/Math.max(.25,beat/2))%8];
        for(let n=0;n<5;n++){weights[n]=clamp(.18+level*.34+pulse*(downbeat?.42:.24));colorOffsets[n]=(n+phraseIndex)%3;}
        weights[wave]=clamp(.65+level*.25+pulse*.25);if(wave>0)weights[wave-1]=Math.max(weights[wave-1],weights[wave]*.48);
      }else{
        const count=Math.round(clamp(Math.ceil(remaining/1.25),1,5));
        for(let n=0;n<count;n++)weights[n]=clamp((.05+level*.28)*(remaining/7));
      }

      const dropImpact=i>0&&frames[i-1]?.blackout&&!preDrop;
      const bloom=dropImpact||(mode==='highlight'&&((sectionEntry&&time-sectionAt<.16)||(hit&&downbeat&&(cue?.strength??level)>.62)));
      const blackout=preDrop&&time-lastPulse>.12;
      if(blackout)weights.fill(0);else if(bloom)weights.fill(1);
      const fadeIn=clamp(time/1.2),fadeOut=clamp(remaining/1.8);
      frames.push({mode:blackout?'pre-drop':mode,color,colorOffsets,weights:weights.map(value=>clamp(value*fadeIn*fadeOut)),hit,bloom,blackout});
    }
    return {version:3,step,beat,thresholds:{travelAt,buildAt,highlightAt},frames};
  }

  function sampleTimeline(timeline,time){return timeline.frames[Math.max(0,Math.min(timeline.frames.length-1,Math.floor(time/timeline.step)))];}
  const api={compile,sample:sampleTimeline};root.HueMediaArt=api;if(typeof module!=='undefined')module.exports=api;
})(globalThis);
