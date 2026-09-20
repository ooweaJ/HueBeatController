# 사전 분석 의존성 고지

HueBeat는 Beat This 1.1.0 패키지와 공식 final0 모델로 Beat·Downbeat 후보를 추출한다. 조명 규칙과 Cue는 HueBeat의 별도 영역이다. 모델은 설치 스크립트로 내려받고 SHA-256을 검증하며 Git에 포함하지 않는다.

- 원본: https://github.com/CPJKU/beat_this
- 라이선스: https://github.com/CPJKU/beat_this/blob/main/LICENSE
- 공식 README는 코드와 공개 모델 가중치 모두 MIT로 배포한다고 명시한다. 학습 음원 자체의 권리는 별도이며 이 프로젝트는 학습 음원을 배포하지 않는다.
- 패키지 또는 모델을 포함해 배포할 때 아래 고지를 함께 포함한다. librosa, PyTorch 등 다른 의존성의 고지도 해당 배포물에 보존한다.

## Beat This MIT License

Copyright (c) 2024 Institute of Computational Perception, JKU Linz, Austria

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
