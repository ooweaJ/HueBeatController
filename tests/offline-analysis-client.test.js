const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const script = fs.readFileSync(require.resolve('../wwwroot/offline-analysis-client.js'), 'utf8');

function client(responses) {
  const calls = [], stored = new Map();
  const scope = { window: {}, FormData, Date, Promise, setTimeout: fn => fn(),
    sessionStorage: { setItem: (k,v) => stored.set(k,v), removeItem: k => stored.delete(k) },
    fetch: async (url, options) => { calls.push({url, options}); const r = responses.shift(); assert.ok(r, 'Unexpected network call'); return r; } };
  vm.runInNewContext(script, scope);
  return { api: scope.window.HueOfflineAnalysis, calls, stored };
}
const json = (body, status = 200) => new Response(JSON.stringify(body), {status, headers: {'content-type':'application/json'}});
const file = () => new File(['audio'], 'song.wav');

test('upload waits for stored revision before opening its review URL', async () => {
  const c = client([json({id:'job',status:'running'},202), json({id:'job',status:'running',message:'working'}),
    json({id:'job',status:'complete',projectId:'track',analysisId:'revision'})]);
  const result = await c.api.analyze(file());
  assert.equal(c.calls.length, 3);
  assert.equal(c.calls[0].options.body.get('audio').name, 'song.wav');
  assert.equal(c.api.reviewUrl(result), '/analysis-review.html?project=track&revision=revision');
  assert.equal(c.stored.size, 0);
});
test('missing model and failed worker do not use a browser fallback', async () => {
  const missing = client([json({message:'setup required'},503)]);
  await assert.rejects(missing.api.analyze(file()), /setup required/);
  assert.equal(missing.calls.length, 1);
  const failed = client([json({id:'job'},202),json({status:'failed',message:'invalid audio'})]);
  await assert.rejects(failed.api.analyze(file()), /invalid audio/);
  assert.equal(failed.stored.size, 0);
});
test('expired job removes resume key so refresh can recover', async () => {
  const c = client([new Response(null,{status:404})]);
  c.stored.set('hue-offline-analysis-job','old');
  await assert.rejects(c.api.wait('old'));
  assert.equal(c.stored.size, 0);
});
test('unsupported and empty files are rejected before uploading', async () => {
  const c = client([]);
  await assert.rejects(c.api.analyze(new File(['x'],'song.ogg')));
  await assert.rejects(c.api.analyze(new File([],'song.wav')));
  assert.equal(c.calls.length, 0);
});
