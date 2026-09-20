(() => {
  'use strict';
  async function responseJson(response) {
    if (!response.headers.get('content-type')?.includes('application/json'))
      throw new Error('새 분석 API를 사용할 수 없습니다. 서버를 재시작하세요.');
    const value = await response.json();
    if (!response.ok) throw new Error(value.message || '분석 작업을 읽지 못했습니다.');
    return value;
  }
  async function analyze(file, onProgress = () => {}) {
    if (!/\.(wav|mp3)$/i.test(file.name) || !file.size || file.size > 512 * 1024 * 1024)
      throw new Error('512MB 이하의 WAV 또는 MP3를 선택하세요. 최대 길이는 10분입니다.');
    onProgress('음원을 서버로 보내는 중…');
    const form = new FormData(); form.append('audio', file, file.name);
    const job = await responseJson(await fetch('/api/offline-analysis/jobs', { method: 'POST', body: form }));
    sessionStorage.setItem('hue-offline-analysis-job', job.id);
    return wait(job.id, onProgress);
  }
  async function wait(id, onProgress = () => {}) {
    const started = Date.now();
    while (Date.now() - started < 16 * 60 * 1000) {
      const response = await fetch(`/api/offline-analysis/jobs/${encodeURIComponent(id)}`, { cache: 'no-store' });
      if (response.status === 404) {
        sessionStorage.removeItem('hue-offline-analysis-job');
        throw new Error('서버가 재시작됐거나 작업 기록이 만료됐습니다. 분석 목록을 새로고침해 확인하세요.');
      }
      const job = await responseJson(response);
      onProgress(job.message);
      if (job.status === 'complete' || job.status === 'failed') {
        sessionStorage.removeItem('hue-offline-analysis-job');
        if (job.status === 'failed') throw new Error(job.message);
        return job;
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    throw new Error('분석 상태 확인 시간이 초과됐습니다. 화면을 새로고침해 확인하세요.');
  }
  function reviewUrl(job) {
    return `/analysis-review.html?project=${encodeURIComponent(job.projectId)}&revision=${encodeURIComponent(job.analysisId)}`;
  }
  window.HueOfflineAnalysis = { analyze, wait, reviewUrl };
})();
