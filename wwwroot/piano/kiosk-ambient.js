(function (root) {
  'use strict';

  function create(options) {
    const {api, buildFrame, now, every, clearEvery, onError = () => {}} = options;
    let owner = null, timer = null, pending = null, plan = [], settings = {}, startedAt = 0;

    async function loadPlan() {
      const saved = await api('/api/controller-settings');
      const data = saved.settings || {}, controls = data.controls || {}, ambient = controls.ambient || {};
      const targets = ambient.target === '1' || ambient.target === '2' ? [Number(ambient.target)] : [1, 2];
      const result = (await Promise.all(targets.map(async bridgeIndex => {
        const configurationId = String(controls.entertainmentConfigurationIds?.[bridgeIndex] ||
          (bridgeIndex === 1 ? controls.entertainmentConfigurationId : '') || '');
        if (!configurationId) return null;
        let configurations;
        try { configurations = await api(`/api/entertainment/configurations?bridgeIndex=${bridgeIndex}`); }
        catch { return null; } // A temporarily missing Bridge must not erase or block the other side.
        const configuration = configurations.find(item => item.id === configurationId);
        if (!configuration?.lightIds?.length) return null;
        const allowed = new Set(configuration.lightIds.map(String));
        const ordered = (data.bridgeLightOrders?.[bridgeIndex] || []).map(String).filter(id => allowed.has(id));
        const seen = new Set(ordered);
        return {bridgeIndex, configurationId, lightIds:ordered.concat([...allowed].filter(id => !seen.has(id)))};
      }))).filter(Boolean);
      if (!result.length) throw new Error('상시 연출에 사용할 Entertainment 영역을 운영 화면에서 선택해 주세요.');
      plan = result;
      settings = {
        effect:ambient.effect || 'rainbow', syncMode:ambient.syncMode || 'mirror',
        direction:ambient.direction || 'forward', cycleSec:Number(ambient.cycle) || 14,
        minBrightness:Number(ambient.min) || 18, maxBrightness:Number(ambient.max) || 78,
        colorMove:ambient.colorMove !== false
      };
      return plan;
    }

    async function tick() {
      if (!owner || pending) return;
      const frame = buildFrame({...settings, elapsedSec:(now() - startedAt) / 1000,
        bridges:plan.map(({bridgeIndex, lightIds}) => ({bridgeIndex, lightIds}))});
      const commands = frame.lights.map(light => ({lightIds:[light.id], hexColor:light.color,
        brightness:light.brightness, transitionMs:80, on:true, groupKey:`ambient-${light.bridgeIndex}`}));
      const currentOwner = owner;
      pending = api('/api/entertainment/frame', {commands, scheduleAheadMs:0, owner:currentOwner})
        .catch(error => {
          if (owner !== currentOwner) return;
          owner = null;
          if (timer) clearEvery(timer);
          timer = null;
          api('/api/entertainment/stop-ambient', {owner:currentOwner}).catch(() => {});
          onError(error);
        }).finally(() => { pending = null; });
      await pending;
    }

    async function start() {
      if (owner) return;
      const status = await api('/api/entertainment/status');
      if (status.active) {
        if (status.purpose !== 'ambient' || !status.owner)
          throw new Error('다른 조명 연출이 사용 중입니다. 운영 화면에서 먼저 종료해 주세요.');
      }
      const selected = await loadPlan();
      if (status.active) {
        const active = (status.bridges || []).filter(item => item.status?.active);
        if (active.length !== selected.length || active.some(item =>
          !selected.some(planItem => planItem.bridgeIndex === item.bridgeIndex &&
            planItem.configurationId.toLowerCase() === String(item.status.configurationId).toLowerCase())))
          throw new Error('운영 중인 상시 연출 영역과 저장된 키오스크 영역이 다릅니다. 운영 설정을 확인해 주세요.');
      }
      const result = status.active
        ? await api('/api/entertainment/claim-ambient', {})
        : await api('/api/entertainment/start', {bridges:selected.map(item => ({
          bridgeIndex:item.bridgeIndex, configurationId:item.configurationId
        })), requireIdle:true, purpose:'ambient'});
      owner = result.owner;
      startedAt = now();
      timer = every(tick, 50);
      await tick();
    }

    async function stop() {
      if (timer) clearEvery(timer);
      timer = null;
      if (pending) await pending;
      const status = await api('/api/entertainment/status');
      const currentOwner = status.active && status.purpose === 'ambient' ? status.owner : null;
      owner = null;
      if (!currentOwner) return;
      try {
        if (!plan.length) try { await loadPlan(); } catch { /* Still release the owned stream. */ }
        const commands = plan.flatMap(item => item.lightIds.map(id => ({
          lightIds:[id], hexColor:null, brightness:0, transitionMs:0, on:false
        })));
        if (commands.length) try {
          await api('/api/entertainment/frame', {commands, scheduleAheadMs:0, owner:currentOwner});
        } catch { /* Piano session sends its own blackout after taking the area. */ }
      } finally {
        await api('/api/entertainment/stop-ambient', {owner:currentOwner});
      }
    }

    return {start, stop, isRunning:() => Boolean(owner)};
  }

  const exported = {create};
  if (typeof module !== 'undefined' && module.exports) module.exports = exported;
  else root.HueKioskAmbient = exported;
})(typeof globalThis !== 'undefined' ? globalThis : this);
