"""Local pre-analysis worker. No Bridge imports, network access or light output.

Only explicit prepare_model.py downloads weights. All analysis uses the pinned local file.
Results are observations, NOT lighting events and NOT input to legacy track upgrades.
"""
import argparse
import hashlib
import importlib.metadata
from pathlib import Path
import platform
import sys
import time
import uuid

import numpy as np
import soundfile as sf
import soxr

from store import now, read_json, sha256, snapshot, validate_analysis, verify_snapshot, write_new_json

REPO = Path(__file__).resolve().parents[2]
SR = 22050
HOP = 256
NFFT = 2048
MAX_SECONDS = 600


def mono_for_analysis(audio):
    """Keep playback stereo; detect cancellation instead of analyzing near-silence."""
    mono = audio.mean(axis=1)
    channel_rms = np.sqrt(np.mean(audio.astype(np.float64) ** 2, axis=0))
    mix_rms = float(np.sqrt(np.mean(mono.astype(np.float64) ** 2)))
    loudest = int(np.argmax(channel_rms))
    if channel_rms[loudest] > 1e-7 and mix_rms < .25 * channel_rms[loudest]:
        return audio[:, loudest], f'channel-{loudest + 1}', ['stereo-cancellation: loudest channel used for analysis only']
    return mono, 'mean', []


def prepare_project(source, root, title=None):
    source, root = Path(source).resolve(), Path(root).resolve()
    if source.suffix.lower() not in ('.wav', '.mp3'):
        raise ValueError('This comparison supports WAV and MP3 only')
    if source.stat().st_size > 512 * 1024 ** 2:
        raise ValueError('Comparison limit: 512 MiB per source')
    info = sf.info(source)
    if info.channels not in (1, 2) or not .1 <= info.duration <= MAX_SECONDS:
        raise ValueError('Comparison limit: mono/stereo, 0.1 to 600 seconds')
    source_hash = sha256(source)
    root.mkdir(parents=True, exist_ok=True)
    project = root / source_hash
    if project.exists():
        manifest = read_json(project / 'manifest.json')
        if manifest['sourceHash'] != source_hash or sha256(project / 'playback.wav') != manifest['playbackHash']:
            raise ValueError('Existing project integrity failure; nothing was overwritten')
        return project, manifest
    stage = root / (source_hash + '.pending-' + uuid.uuid4().hex)
    stage.mkdir()
    audio, source_rate = sf.read(source, dtype='float32', always_2d=True)
    if not np.isfinite(audio).all():
        raise ValueError('Nonfinite audio samples are not supported')
    source_peak = float(np.max(np.abs(audio)))
    if audio.shape[1] == 1:
        audio = np.repeat(audio, 2, axis=1)
    if source_rate != 48000:
        audio = soxr.resample(audio, source_rate, 48000, quality='HQ')
    # Float WAV preserves source/resampling peaks above 1 without clipping or gain changes.
    playback = stage / 'playback.wav'
    sf.write(playback, audio, 48000, subtype='FLOAT')
    if sha256(source) != source_hash:
        raise RuntimeError('Source changed while creating canonical audio')
    manifest = {
        'schemaVersion': 1, 'kind': 'offline-audio-project', 'createdAt': now(),
        'trackId': source_hash, 'sourceHash': source_hash, 'sourceFileName': title or source.name,
        'sourceSampleRate': source_rate, 'sourceFrames': info.frames,
        'playbackHash': sha256(playback), 'playbackFile': 'playback.wav',
        'sampleRate': 48000, 'channels': 2, 'frames': len(audio), 'durationSec': len(audio) / 48000,
        'sourcePeak': source_peak, 'playbackPeak': float(np.max(np.abs(audio))),
        'playbackSamplesAboveFullScale': int(np.count_nonzero(np.abs(audio) > 1)),
        'conversion': {'decoder': 'soundfile', 'encoding': 'FLOAT_32', 'resampler': 'soxr-HQ',
                       'trimmedSamples': 0, 'gain': 1, 'timeOriginSec': 0},
    }
    write_new_json(stage / 'manifest.json', manifest)
    stage.rename(project)  # New path only; no replace/overwrite.
    return project, manifest


def seconds(values, duration):
    values = np.asarray(values, dtype=float).reshape(-1)
    if not np.isfinite(values).all():
        raise ValueError('Analyzer returned a nonfinite time')
    # Frame centers beyond the final decoded sample are not audio events.
    inside = values[(values >= 0) & (values < duration)]
    return [float(x) for x in inside], len(values) - len(inside)


def extract_baseline(mono, sample_rate):
    import librosa
    duration = len(mono) / sample_rate
    y = soxr.resample(mono, sample_rate, SR, quality='HQ') if sample_rate != SR else mono
    spectrum = np.abs(librosa.stft(y, n_fft=NFFT, hop_length=HOP, center=True))
    power = spectrum ** 2
    frequencies = librosa.fft_frequencies(sr=SR, n_fft=NFFT)
    count = min(spectrum.shape[1], int(np.ceil(duration * SR / HOP)))
    strength = librosa.onset.onset_strength(y=y, sr=SR, hop_length=HOP, n_fft=NFFT, center=True)
    onsets = librosa.onset.onset_detect(onset_envelope=strength, sr=SR, hop_length=HOP,
                                       units='time', backtrack=False)
    if np.max(np.abs(y)) < 1e-7:
        beats, tempo = np.array([]), None
    else:
        raw_tempo, beats = librosa.beat.beat_track(onset_envelope=strength, sr=SR,
                                                  hop_length=HOP, units='time')
        tempo = float(np.asarray(raw_tempo).reshape(-1)[0]) if np.size(raw_tempo) else None
    framed = librosa.util.frame(np.pad(y, NFFT // 2), frame_length=NFFT, hop_length=HOP)
    features = {
        'timesSec': (np.arange(count) * HOP / SR).tolist(),
        'rms': np.sqrt(np.mean(framed[:, :count] ** 2, axis=0)).tolist(),
        'peak': np.max(np.abs(framed[:, :count]), axis=0).tolist(),
        'onsetStrength': strength[:count].tolist(),
    }
    for name, lo, hi in [('lowPower', 20, 250), ('midPower', 250, 2000), ('highPower', 2000, SR / 2 + 1)]:
        features[name] = np.mean(power[(frequencies >= lo) & (frequencies < hi), :count], axis=0).tolist()
    onsets, removed_onsets = seconds(onsets, duration)
    beats, removed_beats = seconds(beats, duration)
    return features, {
        'status': 'complete', 'onsetsSec': onsets, 'beatsSec': beats, 'downbeatsSec': [],
        'downbeatStatus': 'not-supported', 'globalTempoEstimateBpm': tempo,
        'outOfRangeRemoved': removed_onsets + removed_beats,
        'confidence': None,
        'parameters': {'sampleRate': SR, 'hopSamples': HOP, 'fftSamples': NFFT,
                       'center': True, 'backtrack': False, 'trimBeats': True,
                       'onsetDetect': 'librosa-0.11.0-default-peak-pick',
                       'tempo': 'librosa global tempo estimate; not a synthesized beat grid'},
    }


def extract_beat_this(mono, sample_rate, model):
    from prepare_model import check_model, MODEL_SHA256
    check_model(model)  # Fail before library can attempt an implicit network download.
    import torch
    from beat_this.inference import Audio2Beats
    torch.set_num_threads(4)
    torch.manual_seed(0)
    tracker = Audio2Beats(checkpoint_path=str(Path(model).resolve()), device='cpu', dbn=False)
    beats, downbeats = tracker(mono, sample_rate)
    duration = len(mono) / sample_rate
    beats, removed_beats = seconds(beats, duration)
    downbeats, removed_downbeats = seconds(downbeats, duration)
    return {
        'status': 'complete', 'beatsSec': beats, 'downbeatsSec': downbeats, 'onsetsSec': [],
        'onsetStatus': 'not-supported', 'model': 'final0', 'modelSha256': MODEL_SHA256,
        'parameters': {'device': 'cpu', 'threads': 4, 'dbn': False, 'float16': False,
                       'frameRateHz': 50, 'chunkFrames': 1500, 'borderFrames': 6,
                       'overlapMode': 'keep_first', 'manualOffsetSec': 0},
        'outOfRangeRemoved': removed_beats + removed_downbeats, 'confidence': None,
    }


def review_audio(project, stage, result):
    """Click listening aids are derivative audio only; canonical playback stays untouched."""
    audio, rate = sf.read(project / 'playback.wav', dtype='float32', always_2d=True)
    duration = result['durationSec']
    starts = sorted(set([0.0, max(0., duration / 2 - 12.5), max(0., duration - 30)]))
    review = stage / 'review'
    review.mkdir()
    rows = []
    for index, start in enumerate(starts):
        for candidate_name, candidate in result['candidates'].items():
            for field in ('onsetsSec', 'beatsSec', 'downbeatsSec'):
                if not candidate.get(field):
                    continue
                excerpt = audio[round(start * rate):round(min(duration, start + 25) * rate)].copy() * .55
                click = .18 * np.sin(2 * np.pi * 1400 * np.arange(round(.02 * rate)) / rate)
                click *= np.linspace(1, 0, len(click))
                for event in candidate[field]:
                    offset = round((event - start) * rate)
                    if 0 <= offset < len(excerpt):
                        length = min(len(click), len(excerpt) - offset)
                        excerpt[offset:offset + length] += click[:length, None]
                filename = f'{index + 1}-{candidate_name}-{field}.wav'
                sf.write(review / filename, np.clip(excerpt, -1, 1), rate, subtype='PCM_16')
                rows.append({'file': 'review/' + filename, 'startSec': start,
                             'durationSec': len(excerpt) / rate, 'candidate': candidate_name, 'layer': field})
    write_new_json(stage / 'listening.json', {'purpose': 'Review candidates, not lighting quality', 'clips': rows})


def compare(source, root, model, baseline_only=False, make_review=False, title=None):
    from psutil import Process
    if not baseline_only:
        from prepare_model import check_model
        check_model(model)
    start = time.perf_counter()
    project, manifest = prepare_project(source, root, title)
    audio, sample_rate = sf.read(project / 'playback.wav', dtype='float32', always_2d=True)
    mono, mix, warnings = mono_for_analysis(audio)
    if manifest['playbackSamplesAboveFullScale']:
        warnings.append('float-source-above-full-scale: preserved, output headroom needs review')
    analysis_id = uuid.uuid4().hex
    revisions = project / 'analyses'
    revisions.mkdir(exist_ok=True)
    stage = revisions / (analysis_id + '.pending')
    stage.mkdir()
    tick = time.perf_counter()
    print('Extracting librosa baseline...', flush=True)
    features, baseline = extract_baseline(mono, sample_rate)
    baseline['elapsedSec'] = time.perf_counter() - tick
    model_result = {'status': 'not-run', 'reason': 'explicit baseline-only comparison'}
    if not baseline_only:
        print('Extracting Beat This beats/downbeats on CPU...', flush=True)
        tick = time.perf_counter()
        model_result = extract_beat_this(mono, sample_rate, model)
        model_result['elapsedSec'] = time.perf_counter() - tick
    result = {
        'schemaVersion': 1, 'kind': 'offline-analysis', 'analysisId': analysis_id,
        'toolVersion': 'huebeat-offline/2',
        'implementationSha256': hashlib.sha256(b''.join(
            Path(__file__).with_name(name).read_bytes()
            for name in ('analyze.py', 'store.py', 'prepare_model.py'))).hexdigest(),
        'createdAt': now(), 'sourceHash': manifest['sourceHash'], 'playbackHash': manifest['playbackHash'],
        'durationSec': manifest['durationSec'], 'audioTimeOriginSec': 0,
        'analysisMix': mix, 'warnings': warnings, 'features': features,
        'featureUnits': {'rms': 'linear PCM amplitude', 'peak': 'linear PCM amplitude',
                         'onsetStrength': 'spectral flux, relative not probability',
                         'bandPower': 'mean unnormalized STFT magnitude squared, not loudness'},
        'candidates': {'librosa': baseline, 'beat-this': model_result},
        'rhythm': {
            'schemaVersion': 1, 'source': 'beat-this', 'status': model_result['status'],
            'model': model_result.get('model'), 'modelSha256': model_result.get('modelSha256'),
            'beatsSec': model_result.get('beatsSec', []),
            'downbeatsSec': model_result.get('downbeatsSec', []),
            'onsetsSec': baseline['onsetsSec'], 'onsetSource': 'librosa',
            'timeOriginSec': 0, 'parameters': model_result.get('parameters'),
        },
        'environment': {'python': platform.python_version(), 'platform': platform.platform(),
                        'packages': dict(sorted((d.metadata['Name'], d.version) for d in importlib.metadata.distributions()))},
        'performance': {'elapsedSec': time.perf_counter() - start,
                        'processPeakRssBytes': getattr(Process().memory_info(), 'peak_wset', None),
                        'includes': 'decode + analysis; cold imports/JIT/model load included, review export excluded'},
        'validation': {'musicalAccuracy': 'not-evaluated: manual ground truth required',
                       'lightingQuality': 'not-evaluated: no lighting score generated'},
    }
    validate_analysis(result)
    if sha256(project / 'playback.wav') != manifest['playbackHash'] or sha256(source) != manifest['sourceHash']:
        raise ValueError('Audio changed during analysis; refusing to finalize')
    write_new_json(stage / 'analysis.json', result)
    if make_review:
        review_audio(project, stage, result)
    summary = {
        'analysisId': analysis_id, 'durationSec': result['durationSec'], 'performance': result['performance'],
        'candidates': {name: {'status': c['status'], 'onsets': len(c.get('onsetsSec', [])),
                             'beats': len(c.get('beatsSec', [])), 'downbeats': len(c.get('downbeatsSec', [])),
                             'elapsedSec': c.get('elapsedSec')} for name, c in result['candidates'].items()},
        'accuracy': 'UNMEASURED. Counts and analyzer agreement are not correctness metrics.'}
    write_new_json(stage / 'summary.json', summary)
    final = revisions / analysis_id
    stage.rename(final)
    print(str(final), flush=True)
    return final


def main():
    # Refuse implicit model/package downloads and accidental device/network requests.
    def local_only(event, args):
        if event == 'socket.connect':
            raise RuntimeError('Network is disabled in the offline analysis worker')
    sys.addaudithook(local_only)
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    commands.add_parser('snapshot')
    verify = commands.add_parser('verify')
    verify.add_argument('backup', type=Path)
    run = commands.add_parser('compare', aliases=['analyze'])
    run.add_argument('audio', type=Path)
    run.add_argument('--baseline-only', action='store_true')
    run.add_argument('--review-audio', action='store_true')
    run.add_argument('--title')
    run.add_argument('--result-file', type=Path)
    args = parser.parse_args()
    if args.command == 'snapshot':
        print(snapshot(REPO))
    elif args.command == 'verify':
        changed = verify_snapshot(REPO, args.backup)
        print('Unchanged' if not changed else 'Changed paths: ' + ', '.join(changed))
        return 1 if changed else 0
    else:
        if args.command == 'analyze' and args.baseline_only:
            raise ValueError('Production analysis requires Beat This; no baseline fallback')
        final = compare(args.audio, REPO / 'data' / 'offline-projects',
                        REPO / 'tmp' / 'offline-models' / 'final0.ckpt', args.baseline_only, args.review_audio, args.title)
        if args.result_file:
            write_new_json(args.result_file, {'projectId': final.parent.parent.name, 'analysisId': final.name})
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print('Cancelled. Pending output is not a completed analysis.', file=sys.stderr)
        sys.exit(130)
