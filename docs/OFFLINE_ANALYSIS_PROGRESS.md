# 사전 분석·편집형 연출 — 진행 기록

2026-09-16 / `experiment/ledfx-engine`

## 지금 어디까지 왔나

승인한 구현 계획의 **0단계 보존 기반과 1단계 비교 도구**를 구현했다. 기존 웹 화면과 전구 연출은 교체하지 않았다. 분석기의 채택, 실제 음악 정확도 및 연출 품질 합격은 아직 아니다.

| 단계 | 현재 상태 | 다음 통과 조건 |
| --- | --- | --- |
| 0 보존·계약 | 기존 설정·음원·편집 데이터 백업, 해시 검증, 독립 프로젝트/분석 revision 구현 | 다곡 평가 세트 확보. 악보 편집 계약은 3단계에서 구현 |
| 1 분석기 비교 | librosa/Beat This 별도 설치, 예시 1곡 실행, 클릭 확인 음원 생성 | 수동 정답 주석과 여러 곡 비교 후 후보 결정 |
| 2 분석 검토 화면 | 미착수 | 박자·타격 후보를 따로 듣고 누락/중복 표시할 화면 |
| 3–6 악보·구간·출력·배포 | 미착수 | 앞 단계 검증 뒤 순서대로 진행 |

## 실제로 확인한 결과

- 기존 저장 파일 5개(설정 2개, LedFx 설정, 음원, 곡별 분석·편집 JSON)를 별도 백업했다. 분석 뒤 원본 해시가 동일했다. 로그·임시 파일은 보존 대상에서 제외했다.
- 같은 음원을 48kHz 스테레오 재생 자산으로 분리했다. 시간 원점은 원본의 0초이며 앞부분 무음을 자르지 않았다.
- 모델은 공식 `final0`의 SHA-256을 고정했다. 모델이 없거나 해시가 다르면 실패하며, 분석 중 Python 소켓 연결을 차단했다. 기존 LedFx 가상환경은 변경하지 않았다.
- 재분석은 새 폴더로만 저장한다. 기존 `data/tracks`나 자동 업그레이드 API를 호출하지 않는다. 임시 `.pending` 폴더는 완료 결과로 취급하지 않는다.
- 두 번째 독립 실행에서도 특징 배열과 박자·타격 시각 배열이 정확히 같았고 두 분석 버전이 모두 남았다. 백업과 비교 자료는 .NET 빌드/배포 수집 대상에서도 제외했다.
- 기본 제한은 WAV/MP3, 모노/스테레오, 10분·512MiB이다. 실행 래퍼는 15분·작업자 메모리 4GiB 제한 및 Ctrl+C 취소를 제공한다. 현장용 처리 속도 보장은 아니다.

### 예시 1곡의 실행 수치 — 정확도 점수가 아님

길이 228초의 기존 예시 WAV, 이 개발 PC의 CPU 기준 첫 실행이다. 패키지 다운로드/설치 시간과 클릭 오디오 내보내기 시간은 포함하지 않는다. 후보별 시간에는 import·초기화 비용이 포함된다.

| 항목 | librosa 0.11.0 | Beat This 1.1.0 / final0 |
| --- | ---: | ---: |
| 소리 시작 후보 | 683개 | 제공하지 않음 |
| Beat 후보 | 369개 | 406개 |
| Downbeat 후보 | 제공하지 않음 | 104개 |
| 후보 분석 소요 | 약 17.9초 | 약 6.8초 |

전체 약 26.5초, 작업자 최대 메모리 약 1.28GiB. 5분 곡이나 다른 PC의 벤치마크로 일반화할 수 없다. 서로 다른 박자 수는 비교할 필요가 있다는 뜻이지, 어느 쪽이 맞다는 뜻이 아니다. 예전 120 BPM 표시를 정답으로 가정하지 않았다.

공통 음원과 라이브러리 캐시가 준비된 두 번째 실행은 약 10.1초, 최대 약 1.13GiB였다. 첫 실행과 캐시 재사용 실행을 혼동하지 않는다.

### 원본 음원에서 발견한 변환 위험

예시 파일은 32bit float WAV이고 peak 약 1.366, 전체 채널 샘플 중 1,368개가 ±1을 넘었다. 이를 정수 PCM으로 변환하면 잘릴 수 있다. 계획의 ‘24bit 정수 PCM 공통 자산’ 후보 대신 **48kHz stereo float32 WAV**로 보존했다. 정규화나 이득 변경을 하지 않았다. 최종 오디오 출력의 헤드룸은 별도 검토해야 한다.

클릭 확인용 WAV는 원음 복사본을 낮춘 뒤 클릭을 더한 파생 파일이다. 공연에 쓸 공통 재생 자산이 아니며 원음을 바꾸지 않는다.

## 자동 검증과 아직 검증하지 않은 것

13개 자동 시험 통과: 44.1/48kHz의 시간 원점·앞 무음 보존, 프로젝트 재사용/변조 감지, float peak 보존, 역위상 상쇄 대응, 무음, 합성 타격 4개 검출, 시각 범위·중복·단위 계약, 새 버전 전용 저장, 백업 무변경, 모델 손상, 일대일 주석 평가, 미검토와 빈 정답 구별.

기존 .NET Release 빌드 성공(경고·오류 0). 웹 JavaScript는 변경하지 않았다.

**미검증:** 실제 음악 타격/박자 정답, 여러 곡의 범용성, 악센트 선택, 조명 미감, 클라이맥스 인식, MP3 디코딩의 실제 파일 비교, 장시간/취소/메모리 초과의 장애 주입, 실제 전구 지연. 단위 테스트 통과로 이 항목들을 합격 처리하지 않는다.

## 다음에 할 일

1. 기존 1곡의 시작·중간·끝 25초 확인 음원을 듣고 박자와 소리 시작을 따로 주석 처리한다. 현재 자동 선정 구간은 음악적 구간 분류가 아니다.
2. 권한이 있는 다른 성격의 음원을 추가해 총 8곡 이상 확보한다. 3곡은 튜닝하지 않는 검증곡으로 미리 분리한다.
3. 곡별 onset ±50ms, Beat ±70ms 정확도를 계산한다. 원하는 조명 악센트는 별도로 표시한다. 후보 일치율이나 후보 개수로 정확도를 대신하지 않는다.
4. 결과를 보고 후보를 선택하거나 조합한다. 비교가 불충분하면 보류를 유지한다.
5. 다음 구현은 **전구 없이 쓰는 분석 검토 화면**이다. 최종 큐 생성·전구 출력 교체는 아직 진행하지 않는다.

## 파일 위치와 실행법

컨트롤러 폴더의 PowerShell에서 실행한다. 첫 설치만 인터넷이 필요하며 Python 3.12를 사용한다. 원래 `setup-ledfx.ps1`과 별개다.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\setup-offline-analysis.ps1
$analysisPython = '.\tmp\offline-analysis-venv\Scripts\python.exe'
& $analysisPython tools/offline/run.py snapshot
& $analysisPython tools/offline/run.py compare 'C:\음원\곡.wav' --review-audio
& $analysisPython tools/offline/run.py verify 'data\offline-backups\백업ID'
& $analysisPython -m unittest discover -s tests -p test_offline_analysis.py -v
```

`--baseline-only`는 사용자가 명시했을 때만 모델 없이 librosa를 비교한다. 실패할 때 자동 선택되는 대체 경로가 아니다.

```text
data/
  tracks/                         기존 파일, 새 도구에서는 읽기만
  offline-backups/<백업ID>/       개인 설정 포함: 공유·Git 업로드 금지
  offline-projects/<음원해시>/
    manifest.json                 원본·재생 해시, 변환 및 시간 원점
    playback.wav                  분석과 재생의 공통 시간축용 복사본
    analyses/<분석ID>/
      analysis.json               특징 + 후보별 박자·시작 시각
      summary.json                개수·성능, 정확도는 미측정 표시
      listening.json              확인용 파일과 원곡 시작 시각
      review/*.wav               클릭을 겹친 확인용 오디오
```

분석 JSON에는 조명 큐·장비 ID·인증키를 넣지 않는다. 원본 분석과 사람이 고친 악보를 합치는 기능은 아직 없다. 같은 음원의 재분석은 이전 폴더를 덮어쓰지 않는 새 분석 ID를 만든다.

`docs/offline-evaluation-template.json`을 개인 데이터 폴더로 복사해 평가곡과 주석을 기록한다. `onsetsSec`, `beatsSec`, `downbeatsSec`는 각각 검토한 배열만 추가한다. 누락된 필드는 미검토, 빈 배열은 검토했으나 사건 없음이다.

```powershell
& $analysisPython tools/offline/evaluate.py 'data\offline-projects\해시\analyses\ID\analysis.json' 'data\labels.json'
```

## 도구와 라이선스 확인 범위

- [librosa](https://github.com/librosa/librosa/blob/main/LICENSE.md): ISC. 비교 기준으로 0.11.0을 고정했으며 최신 버전이라는 뜻이 아니다.
- [Beat This](https://github.com/CPJKU/beat_this): 코드와 공개 모델 MIT 안내. Beat/Downbeat 후보만 사용하며 DBN/madmom은 설치하지 않았다.
- CPU torch/torchaudio 2.8.0, Python 3.12. 전체 설치 버전은 `tools/offline/requirements-win-py312.lock.txt`, 각 결과에는 실제 환경을 기록한다.
- final0 SHA-256: `8c328b45f59d8dd3dff219253ff6a8d6482be57d0133a29140e2febbf8eb8331`.
- 분석 실행 자체는 로컬 전용이다. 완전 무인터넷 신규 설치 패키지와 전체 전이 의존성 라이선스 동봉/배포 감사는 아직 완료하지 않았다. 모델·가상환경·음원·분석 JSON·개인 백업은 Git에서 제외한다.

## 작업 재개 메모

이번 결과를 기존 웹 자동 업그레이드에 연결하지 말 것. 우선 주석 평가와 검토 화면을 준비한다. 새 연출 알고리즘을 선택하기 전에 ‘타격 후보가 틀렸는가’와 ‘맞는 후보를 너무 많이 연출하는가’를 따로 확인해야 한다.
