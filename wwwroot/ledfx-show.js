// Original LedFx melbank input; HueBeat's own transient/arrangement rules.
// No PCM FFT, fixed BPM, song timestamp rules or RGB feedback analysis here.
(function(root){
  const clamp=(v,a=0,b=1)=>Math.max(a,Math.min(b,v));
  class Show {
    constructor(){this.reset();}
    reset(){
      this.lastInput=-Infinity;this.previous=[0,0,0];this.mean=[.012,.012,.012];this.deviation=[.006,.006,.006];
      this.level=0;this.baseline=0;this.breadth=0;this.hits=[];this.lastHit=-Infinity;this.hitCount=0;this.index=-1;
      this.pulses=[];this.mode='sparse';this.modeSince=-Infinity;this.candidateSince=null;this.interval=.5;
      this.source='대기';this.bands=[0,0,0];this.flux=0;this.threshold=0;this.lastStrength=0;
      this.lastRender=-Infinity;this.activeMode='auto';this.signature='';
      this.lastMove=-Infinity;this.lastBass=-Infinity;this.moveCount=0;
      this.eventPeak=[0,0,0];this.valley=[0,0,0];this.armed=[true,true,true];this.candidateCount=0;
      this.envelopePeak=0;this.envelopeReady=true;
    }
    ingest(values, frequencies, now, options={}){
      if(!Number.isFinite(now)||!Array.isArray(values)||!Array.isArray(frequencies)||values.length!==frequencies.length||values.length<3)return false;
      if(values.some(v=>!Number.isFinite(v))||frequencies.some(v=>!Number.isFinite(v)))return false;
      if(now<=this.lastInput)return false;
      const signature=frequencies.join(',');
      if(now-this.lastInput>.6||this.signature!==signature){this.reset();this.signature=signature;}
      const first=!Number.isFinite(this.lastInput),dt=first?1/60:clamp(now-this.lastInput,.001,.1);
      const sums=[0,0,0],counts=[0,0,0];
      values.forEach((v,i)=>{const f=frequencies[i];if(f<30||f>12000)return;const b=f<250?0:f<2500?1:2;sums[b]+=Math.max(0,v);counts[b]++;});
      const raw=sums.map((s,i)=>counts[i]?s/counts[i]:0);
      this.bands=raw.map(v=>v/(1+v));
      const energy=(this.bands[0]+this.bands[1]+this.bands[2])/3;
      if(energy<this.envelopePeak*.65)this.envelopeReady=true;
      const freshAccent=energy>this.envelopePeak*1.35;
      this.envelopePeak=Math.max(this.envelopePeak,energy);
      this.level+=(energy-this.level)*(1-Math.exp(-dt/.7));
      this.baseline+=(energy-this.baseline)*(1-Math.exp(-dt/8));
      // Dense, broad-band passages favour full punches; isolated bass does not.
      const broad=this.bands.every(v=>v>Math.max(.008,Math.max(...this.bands)*.06))?1:0;
      this.breadth+=(broad-this.breadth)*(1-Math.exp(-dt/.7));
      const sensitivity=clamp(Number(options.sensitivity)||1,.5,2);
      const rises=this.bands.map((v,i)=>Math.max(0,v-this.previous[i]));
      const thresholds=this.mean.map((v,i)=>Math.max(.018,v+1.5*this.deviation[i])/sensitivity);
      const ratios=rises.map((v,i)=>this.bands[i]>.045?v/thresholds[i]:0);
      const winner=ratios.indexOf(Math.max(...ratios));
      this.flux=rises[winner];this.threshold=thresholds[winner];
      // Event gate: a tail/ripple is not another onset. A band must recover
      // through a meaningful valley before another attack can be accepted.
      this.bands.forEach((v,i)=>{
        this.eventPeak[i]=Math.max(this.eventPeak[i],v);
        this.valley[i]=Math.min(this.valley[i],v);
        if(v<this.eventPeak[i]*.55)this.armed[i]=true;
      });
      const candidate=!first&&ratios[winner]>1&&now-this.lastHit>=.12;
      if(candidate)this.candidateCount++;
      const eligible=ratios.map((r,i)=>this.armed[i]&&r>1&&
        this.bands[i]-this.valley[i]>Math.max(.035,this.eventPeak[i]*.25)?r:0);
      const eventBand=eligible.indexOf(Math.max(...eligible));
      const hit=candidate&&eligible[eventBand]>0&&(this.envelopeReady||freshAccent);
      this.hits=this.hits.filter(t=>now-t<4);
      if(hit){
        if(Number.isFinite(this.lastHit)&&now-this.lastHit<2){this.interval=.65*this.interval+.35*clamp(now-this.lastHit,.25,1.5);}
        this.lastHit=now;this.hits.push(now);this.hitCount++;
        this.source=['저음','중역','고역'][eventBand];
        this.lastStrength=clamp(.55+rises[eventBand]*2.5,.55,1);
        // Lock all bands so delayed harmonics of one sound cannot fan out
        // into several lighting events. New valleys can rearm independently.
        this.armed=[false,false,false];this.eventPeak=this.bands.slice();this.valley=this.bands.slice();
        this.envelopeReady=false;this.envelopePeak=energy;
      }
      const requested=['auto','sparse','full'].includes(options.mode)?options.mode:'auto';
      if(requested!==this.activeMode){this.pulses=[];this.candidateSince=null;this.activeMode=requested;}
      if(requested==='auto'){
        const recent=this.hits.filter(t=>now-t<2.2).length;
        const strong=recent>=4&&this.level>.08&&this.breadth>.5&&(this.level>this.baseline*1.15||this.level>.18);
        const desired=this.mode==='sparse'?(strong?'full':'sparse'):
          (recent<2||this.breadth<.2||this.level<Math.max(.04,this.baseline*.8)?'sparse':'full');
        if(desired!==this.mode){
          if(this.candidateSince===null)this.candidateSince=now;
          if(now-this.candidateSince>(desired==='full'?.65:1.8)&&now-this.modeSince>2.5){this.mode=desired;this.modeSince=now;this.candidateSince=null;}
        }else this.candidateSince=null;
      }else{this.mode=requested;this.modeSince=now;}
      const pairs=clamp(Math.trunc(options.pairs||5),1,5);
      if(hit){
        if(this.index<0){this.index=0;this.lastMove=now;}
        else if(options.move!==false&&this.mode==='sparse'){
          this.index=(this.index+1)%pairs;this.lastMove=now;this.moveCount++;
        }
        if(options.move===false)this.index=0;
        const halfLife=this.mode==='full'?clamp(this.interval*.25,.07,.18):clamp((Number(options.decayMs)||100)/1000,.06,.18);
        // Retrigger from zero, not an additive envelope that sticks at full brightness.
        if(this.mode==='full')this.pulses=Array.from({length:pairs},(_,i)=>({index:i,time:now,strength:this.lastStrength,halfLife,full:true}));
        else this.pulses=[{index:this.index,time:now,strength:this.lastStrength,halfLife,full:false}];
      }
      const a=1-Math.exp(-dt/1.2);
      rises.forEach((v,i)=>{this.deviation[i]+=a*(Math.abs(v-this.mean[i])-this.deviation[i]);this.mean[i]+=a*(v-this.mean[i]);});
      this.previous=this.bands.slice();this.lastInput=now;
      return hit;
    }
    frame(now,options={}){
      const pairs=clamp(Math.trunc(options.pairs||5),1,5),weights=Array(pairs).fill(0);
      const fresh=now-this.lastInput<.6;
      if(fresh){
        for(const p of this.pulses){
          const age=now-p.time;
          if(!p.full&&age>p.halfLife*4)continue;
          const attack=clamp(age/.016);
          const value=p.strength*attack*Math.pow(.5,Math.max(0,age-.016)/p.halfLife);
          if(p.index<pairs&&value>=.012)weights[p.index]=Math.max(weights[p.index],value);
        }
      }
      const master=clamp((Number(options.brightness) || (options.brightness===0?0:80))/100);
      // Restrained palette, stable through a pulse; no white sparks or rainbow mix.
      const rgb=weights.flatMap(w=>[255,184,112].map(c=>Math.round(c*w*master)));
      return {rgb,weights,mode:this.mode,fresh,hitCount:this.hitCount,candidateCount:this.candidateCount,moveCount:this.moveCount,index:this.index,source:this.source,
        hitAge:now-this.lastHit,bands:this.bands.slice(),level:this.level,flux:this.flux,threshold:this.threshold};
    }
  }
  if(typeof module!=='undefined')module.exports={Show};else root.HueBeatShow={Show};
})(typeof globalThis!=='undefined'?globalThis:this);
