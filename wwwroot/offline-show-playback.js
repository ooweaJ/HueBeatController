// Shared, deterministic offline show frame and A/B-to-Hue command mapping.
(function(root){
  const Core=root.OfflineReviewCore||(typeof require!=='undefined'?require('./analysis-review-core.js'):null);
  const clamp=(value,min=0,max=1)=>Math.max(min,Math.min(max,value));
  function prepare(analysis,show){
    Core.validate(analysis);
    if(show?.schemaVersion!==1||show.analysisId!==analysis.analysisId||show.playbackHash!==analysis.playbackHash||!Number.isInteger(show.version)||show.version<1)
      throw new Error('검토 화면에서 이 분석 revision의 클라이맥스 구간을 먼저 저장하세요.');
    const sections=Core.validateSections(show.sections,analysis.durationSec);
    const dynamics=Core.buildDynamics(analysis);
    return {analysisId:analysis.analysisId,showVersion:show.version,durationSec:analysis.durationSec,sections,dynamics,
      events:dynamics.lightingDownbeats};
  }
  function frameAt(session,time,pairs,wave=false){
    if(!session||!Number.isFinite(time))throw new Error('재생할 연출 데이터가 없습니다.');
    return Core.showFrame(session.events,clamp(time,0,session.durationSec),pairs,session.sections,true,session.dynamics,{wave:wave===true});
  }
  function hex(rgb){
    return '#'+rgb.map(channel=>Math.round(clamp(Number(channel)||0,0,255)).toString(16).padStart(2,'0')).join('');
  }
  function commandsFor(frame,groups,master=1){
    if(!frame||!Array.isArray(groups)||groups.length!==2||groups[0].lightIds.length!==groups[1].lightIds.length||groups[0].lightIds.length!==frame.a.length)
      throw new Error('A/B 전구 쌍 수와 연출 프레임 크기가 다릅니다.');
    const factor=clamp(Number(master)||0);
    return groups.flatMap((group,row)=>group.lightIds.map((id,index)=>{
      const level=clamp((row===0?frame.a:frame.b)[index])*factor;
      return {lightIds:[id],hexColor:hex(frame.pairColors?.[index]||frame.rgb),brightness:Math.round(level*10000)/100,
        on:level>.001,transitionMs:0,groupKey:`offline-${row}`};
    }));
  }
  const api={prepare,frameAt,commandsFor,hex};
  root.HueOfflineShowPlayback=api;if(typeof module!=='undefined')module.exports=api;
})(globalThis);
