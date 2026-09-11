// Deterministic choreography: saved frames are indexed by audio time, so seeking
// and replaying do not depend on timers or the number of delivered requests.
(function(root){
  function compile(analysis){
    const levels=analysis.envelope||[],step=analysis.envelopeStep||.1,frames=[];
    let mode='intro',candidate='intro',candidateSince=0,sectionAt=0,color=0,position=0,lastMove=0,lastHit=-10,previousPosition=-1;
    const modes=['intro','travel','build','highlight'];
    const cues=analysis.beatTimes||[];let cueIndex=0;
    for(let i=0;i<levels.length;i++){
      const time=i*step,level=levels[i];let average=0,count=0;
      for(let j=Math.max(0,i-19);j<=i;j++){average+=levels[j];count++;}average/=count;
      const desired=average>.62?'highlight':average>.32?'build':average>.09?'travel':'intro';
      if(desired!==candidate){candidate=desired;candidateSince=time;}
      let entry=false;
      if(candidate!==mode&&time-candidateSince>=1.2&&time-sectionAt>=4){
        const direction=modes.indexOf(candidate)>modes.indexOf(mode)?1:-1;
        mode=modes[Math.max(0,Math.min(modes.length-1,modes.indexOf(mode)+direction))];
        sectionAt=time;candidateSince=time;color=(color+1)%6;entry=true;previousPosition=-1;
      }
      let cue=false;while(cueIndex<cues.length&&cues[cueIndex]<=time){if(cues[cueIndex]>=time-step)cue=true;cueIndex++;}
      const bass=(analysis.bassEnvelope||[])[i]||0,oldBass=(analysis.bassEnvelope||[])[Math.max(0,i-1)]||0;
      const attack=cue||bass-oldBass>.09||level-(levels[Math.max(0,i-1)]||0)>.07;
      const minGap=mode==='highlight'?.45:mode==='build'?.65:1.1;
      const hit=attack&&time-lastHit>=minGap;
      if(hit){lastHit=time;previousPosition=position;position=(position+1)%5;lastMove=time;}
      const base=.18+level*.62,weights=Array(5).fill(0);
      if(mode==='intro'){
        // The intro stays almost dark, but every locally detected hit moves the
        // single point. A short tail makes the direction readable.
        weights[position]=.035+level*.15;
        if(previousPosition>=0&&previousPosition!==position&&time-lastMove<.28)weights[previousPosition]=Math.max(weights[previousPosition],(.035+level*.15)*.3*(1-(time-lastMove)/.28));
      }
      else if(mode==='travel'){
        weights[position]=base;
        if(previousPosition>=0)weights[previousPosition]=Math.max(weights[previousPosition],base*.5*Math.max(0,1-(time-lastMove)/.45));
      }else if(mode==='build'){
        const length=Math.min(5,Math.max(2,Math.round(average*6)));
        for(let n=0;n<length;n++)weights[n]=base;
        weights[position]=Math.max(weights[position],base*.8);
      }else{
        weights.fill(base*.4);
        const wave=[0,1,2,3,4,3,2,1][Math.floor((time-sectionAt)/.5)%8];
        weights[wave]=base;
        if(wave>0)weights[wave-1]=base*.65;
      }
      // Reserve the full bloom for section entry and strong, separated attacks.
      const bloom=(mode==='highlight'&&time-sectionAt<.2)||(mode==='highlight'&&time-lastHit<.16&&level>.8);
      if(bloom)weights.fill(1);
      else if(hit&&mode!=='intro')weights[position]=Math.min(1,base+.2);
      const ending=Math.min(1,Math.max(0,(analysis.duration-time)/2));
      frames.push({mode,color,weights:weights.map(value=>value*ending),hit:hit||entry,bloom});
    }
    return {version:2,step,frames};
  }
  function sample(timeline,time){return timeline.frames[Math.max(0,Math.min(timeline.frames.length-1,Math.floor(time/timeline.step)))];}
  const api={compile,sample};root.HueMediaArt=api;if(typeof module!=='undefined')module.exports=api;
})(globalThis);
