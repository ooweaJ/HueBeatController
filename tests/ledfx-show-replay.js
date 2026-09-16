// Optional real-audio integration check. Capture first with ledfx-show-probe.py.
const fs=require('node:fs'),assert=require('node:assert/strict');
const {Show}=require('../wwwroot/ledfx-show');
const reports=JSON.parse(fs.readFileSync('tmp/ledfx-show-probe.json','utf8'));
for(const report of reports){
  for(const mode of ['auto','sparse','full']){
    const show=new Show();let full=0,lit=0,peak=0;
    for(const row of report.rows){
      show.ingest(row.values,row.frequencies,row.time,{mode});
      const frame=show.frame(row.time+.017);
      full+=frame.mode==='full';lit+=frame.rgb.some(v=>v>0);peak=Math.max(peak,...frame.rgb);
      assert.ok(frame.rgb.every(v=>Number.isFinite(v)&&v>=0&&v<=255));
    }
    assert.ok(show.hitCount>0,report.label+' no hits');
    assert.ok(show.frame(report.rows.at(-1).time+1).rgb.every(v=>v===0));
    console.log(JSON.stringify({window:report.label,mode,hits:show.hitCount,moves:show.moveCount,fullFrames:full,litFrames:lit,frames:report.rows.length,peak}));
  }
}
