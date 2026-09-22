(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  root.HueBridgeLayout=api;
})(typeof window!=='undefined'?window:globalThis,function(){
  'use strict';
  function reconcileMusicGroups(groups,orders,lights){
    const known=new Map(lights.map(light=>[String(light.id),Number(light.bridgeIndex||1)]));
    return groups.map((group,index)=>{
      const bridgeIndex=index+1;
      const members=lights.filter(light=>Number(light.bridgeIndex||1)===bridgeIndex);
      if(!members.length){
        // A temporarily unavailable Bridge must not erase its saved placement.
        return group.lightIds.filter(id=>!known.has(String(id))||known.get(String(id))===bridgeIndex);
      }
      const byId=new Set(members.map(light=>String(light.id)));
      const ordered=(orders[bridgeIndex]||[]).map(String).filter(id=>byId.delete(id));
      const missing=members.filter(light=>byId.has(String(light.id)))
        .sort((a,b)=>a.name.localeCompare(b.name,'ko',{numeric:true}));
      return [...ordered,...missing.map(light=>String(light.id))];
    });
  }
  return {reconcileMusicGroups};
});
