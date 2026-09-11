# 음악 연동 무대 조명 레퍼런스 조사

조사일: 2026-09-11

## 조사 목적

단순 음량 또는 저음 피크 검출만으로 조명을 자동 변경하는 현재 방식에서 벗어나, 실제 무대 조명 콘솔·DJ 자동 조명·미디어 서버가 음악을 해석하고 연출하는 구조를 Hue Entertainment 시스템에 적용한다.

## 핵심 결론

실제 공연용 시스템은 음악 파형 하나가 조명 전체를 직접 결정하게 두지 않는다. 다음 네 층을 결합한다.

```text
1. Timecode/Cue       곡의 특정 시각에 정확한 장면 실행
2. Beatgrid/Phrase    박자·마디·프레이즈 단위로 패턴 정렬
3. Look/Preset        미리 설계된 색·밝기·공간 패턴 선택
4. Audio Reactive     저·중·고역으로 밝기·속도·효과량을 보조 변조
```

따라서 `HOLD`, `PULSE`, `STEP`은 음악 구조를 판정하는 상위 알고리즘이 아니다. 선택된 Look 또는 패턴을 그리는 하위 동작으로 사용해야 한다.

## 1. 전문 무대 조명: Cue Sequence와 Timecode

grandMA3는 조명 값을 Cue에 저장하고 Cue를 Sequence로 구성한다. Timecode Show는 정해진 시각에 이벤트를 실행하거나 페이더 값을 움직인다. 이벤트는 타임라인에서 추가·이동·수정할 수 있고, Cue마다 fade, delay, transition을 별도로 지정할 수 있다.

이 방식의 의미:

- 중요한 장면은 오디오 피크를 실시간 추측하지 않는다.
- 곡 재생 시각에 맞춘 확정 이벤트를 실행한다.
- 밝기 상승, 암전, 색상 전환은 서로 다른 fade와 transition을 가진다.
- 자동으로 만든 결과도 사람이 타임라인에서 수정할 수 있어야 한다.

참고:

- [grandMA3 Cues and Sequences](https://help.malighting.com/grandMA3/2.1/HTML/cue_sequence.html)
- [grandMA3 Timecode Show](https://help.malighting.com/grandMA3/2.4/HTML/timecode.html)
- [grandMA3 Time Ranges and Events](https://help.malighting.com/grandMA3/2.1/HTML/timecode_time_ranges_events.html)
- [grandMA3 Cue Timing](https://help.malighting.com/grandMA3/2.4/HTML/cue_timing.html)

## 2. DJ 자동 조명: Beatgrid + Phrase + Preset

SoundSwitch는 음원별 Script와, Script가 없는 곡을 위한 Autoloop를 구분한다. 자동 스크립트는 Beatgrid에 연출을 맞추고, Phrase Detection으로 Intro, Main, Middle, Bridge, Outro 같은 구간을 나눈다. 사용자는 감지된 프레이즈의 종류와 길이를 수정하고, 프레이즈마다 다른 자동 연출 프리셋을 조합할 수 있다.

Autoloop는 짧은 반응 하나가 아니라 8·16·32·64·128마디 길이의 조명 클립이다. 이 점이 중요하다. 실제로는 매 타격마다 다음 색을 즉석에서 고르는 대신, 음악의 마디 위에서 이미 설계된 패턴을 재생한다.

우리 시스템에 적용할 점:

- BPM 숫자만 저장하지 말고 Beatgrid와 마디 첫 박자를 만들어야 한다.
- 곡을 프레이즈 단위로 나눠야 한다.
- 프레이즈 유형에 따라 패턴 프리셋을 선택해야 한다.
- 자동 분석 결과를 사람이 수정할 수 있어야 한다.

참고:

- [SoundSwitch 소개: Scripts와 Autoloops](https://support.soundswitch.com/en/support/solutions/articles/69000847099-introduction-to-soundswitch)
- [SoundSwitch Autoscripting](https://support.soundswitch.com/en/support/solutions/articles/69000847098-soundswitch-autoscripting-audio-files-playlists-and-crates)
- [SoundSwitch Phrase Editing](https://support.soundswitch.com/en/support/solutions/articles/69000844233-soundswitch-phrase-editing)
- [SoundSwitch AutoScripting 설명 영상](https://www.youtube.com/watch?v=0b22G5i4Ut4)

## 3. 실시간 음원 반응: 주 연출이 아닌 파라미터 입력

QLC+ Audio Triggers는 입력 음원을 주파수 막대로 나누고 각 대역을 DMX 채널, Function, Widget에 연결한다. 켜지는 임계값과 꺼지는 임계값을 따로 두어 경계 부근의 깜빡임을 막고, divisor로 매 박자·2박자·4박자처럼 트리거 빈도를 줄인다.

Resolume은 저·중·고역 또는 지정한 FFT 대역을 파라미터에 연결한다. Gain으로 반응량을 조절하고 Fall로 피크 이후 감소 속도를 정하며, Envelope를 이용해 입력값의 반응 곡선을 디자인한다. BPM Sync는 반복 애니메이션의 시간 기준으로 별도 사용한다.

우리 시스템에 적용할 점:

- 저음은 전체 장면을 결정하지 않고 밝기 펀치의 입력으로 쓴다.
- 중음·고음은 색상 선명도나 보조 반짝임에 사용할 수 있다.
- Attack와 Release/Fall을 분리해야 한다.
- 진입/이탈 임계값을 달리하는 히스테리시스가 필요하다.
- 매 타격이 아니라 박자 divisor를 적용해 연출 밀도를 제한한다.

참고:

- [QLC+ Audio Triggers](https://docs.qlcplus.org/v5/virtual-console/audio-triggers)
- [Resolume Audio Analysis와 BPM Sync](https://resolume.com/support/parameter-animation)
- [Resolume Animation Envelopes](https://resolume.com/support/en/6/envelopes)
- [Resolume FFT 설명](https://resolume.com/support/de/wire-fft)

## 4. 음악 분석 라이브러리가 제공하는 데이터

Essentia Music Extractor는 단순 BPM 외에도 beat 위치, beat별 주파수 대역 에너지, onset rate, 스펙트럼 특징, key, scale, chord 변화율 등을 추출한다. librosa는 onset envelope 기반 beat tracking과 chroma 기반 시간 구간 분할 기능을 제공한다.

우리에게 필요한 분석 출력:

```text
Timing
- beat 위치
- downbeat/마디 위치
- BPM과 신뢰도

Phrase
- 프레이즈 경계
- 반복 구간 유사도
- 구간별 에너지와 타격 밀도

Reactive
- 저·중·고역 에너지
- onset 강도
- attack/release envelope

Tonal
- chroma
- key/scale 후보
- 화성 변화량
```

참고:

- [Essentia Music Extractor descriptors](https://github.com/MTG/essentia/blob/master/doc/sphinxdoc/streaming_extractor_music.rst)
- [Essentia.js API](https://mtg.github.io/essentia.js/docs/api/Essentia.html)
- [librosa beat tracking](https://librosa.org/doc/main/api/generated/librosa.beat.beat_track.html)
- [librosa temporal segmentation](https://librosa.org/doc/main/generated/librosa.segment.agglomerative.html)

## Hue 시스템에 적용할 새 구조

### 분석 결과

```js
{
  beatGrid: [],
  downbeats: [],
  phrases: [
    { start, end, type, energy, density, confidence }
  ],
  reactiveCurves: {
    low: [],
    mid: [],
    high: [],
    onset: []
  }
}
```

### 조명 악보

```js
{
  sections: [
    { start, end, look: "ambient", pattern: "slow-pair", bars: 8 },
    { start, end, look: "build", pattern: "accumulate", bars: 16 },
    { start, end, look: "climax", pattern: "wave-punch", bars: 16 }
  ],
  cues: [
    { time, action: "blackout", fadeMs: 80 },
    { time, action: "full-punch", holdMs: 140 }
  ]
}
```

### 재생 규칙

- 프레이즈가 현재 Look과 패턴을 선택한다.
- Beatgrid가 패턴 진행 시점을 결정한다.
- Downbeat가 강한 변화의 기준이 된다.
- 저음 FFT는 선택된 패턴의 밝기 펀치만 조절한다.
- Cue가 암전, 전체 점등처럼 반드시 맞아야 하는 순간을 실행한다.
- Hue Entertainment는 완성된 프레임을 전달하는 출력 계층으로만 사용한다.

## 권장 개발 순서

### R1 — Beatgrid 검증

곡 전체의 beat와 downbeat를 추출해 파형에 표시한다. 사용자가 그리드가 음악과 맞는지 확인하고 시작점과 BPM 절반/두 배 오류를 수정할 수 있게 한다.

### R2 — Phrase 분할과 편집

Intro/Main/Bridge/Outro 이름을 자동 제안하고, 타임라인에서 경계 이동·분할·유형 변경을 지원한다.

### R3 — 8/16마디 패턴 프리셋

Ambient, Step, Accumulate, Alternate, Wave, Full Punch 같은 패턴을 마디 단위 클립으로 제작한다. A/B 배열 크기에 맞춰 자동 변형한다.

### R4 — Audio Reactive 보조값

저·중·고역에 Gain, Attack, Release, 진입/이탈 임계값을 적용하고 선택된 패턴의 밝기와 효과량만 변조한다.

### R5 — Timecode 조명 악보

분석된 곡마다 최종 Cue와 패턴 배치를 저장한다. 재생 중에는 재분석하지 않고 오디오 시간과 싱크 보정값으로 악보를 실행한다.

## 이번 조사로 중단할 방향

- 0.5초 구간마다 가장 큰 피크 하나를 조명 타격으로 선택
- 순간 음량 백분위만으로 INTRO/CLIMAX를 계속 재판정
- 모든 저음 타격마다 색상과 위치를 동시에 변경
- 완전 자동 분석 결과를 편집 없이 공연에 바로 사용

## 현실적인 제품 목표

완전 자동 생성기는 초안 생성기로 사용한다. 공연 품질은 `자동 Beatgrid/Phrase 분석 + 검증 가능한 타임라인 + 패턴 프리셋 + 최소 수동 보정`의 조합으로 확보한다. 파일이 고정된 행사에서는 이 방식이 실시간 음원 반응만 사용하는 것보다 재현성과 싱크가 높다.
