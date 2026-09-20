"""No real Bridge, server or user data used. Run with the isolated analysis Python."""
import copy
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools' / 'offline'))
import numpy as np
import soundfile as sf
from analyze import extract_baseline, mono_for_analysis, prepare_project, seconds
from evaluate import evaluate, match_events
from prepare_model import check_model
from store import read_json, sha256, snapshot, validate_analysis, validate_times, verify_snapshot, write_new_json


def valid_analysis():
    return {'schemaVersion': 1, 'kind': 'offline-analysis', 'analysisId': 'test',
            'sourceHash': 'a' * 64, 'playbackHash': 'b' * 64, 'durationSec': 4,
            'candidates': {'librosa': {'status': 'complete', 'onsetsSec': [1., 2.], 'beatsSec': [1., 2.],
                                     'downbeatStatus': 'not-supported'}},
            'features': {'timesSec': [0., 1.], 'rms': [0., .1]}}


class StoreTests(unittest.TestCase):
    def test_canonical_rhythm_preserves_model_events(self):
        value = valid_analysis()
        value['candidates']['beat-this'] = {'status': 'complete', 'beatsSec': [.12, .67, 1.25, 1.84], 'downbeatsSec': [.67]}
        value['rhythm'] = {'source': 'beat-this', 'status': 'complete', 'timeOriginSec': 0,
                           'beatsSec': [.12, .67, 1.25, 1.84], 'downbeatsSec': [.67], 'onsetsSec': [1., 2.]}
        validate_analysis(value)
        value['rhythm']['downbeatsSec'] = [.12]
        with self.assertRaises(ValueError):
            validate_analysis(value)

    def test_rejects_invalid_timestamps(self):
        for events in ([1, 1], [2, 1], [-1], [4], [float('nan')], [float('inf')], [True]):
            with self.subTest(events=events), self.assertRaises(ValueError):
                validate_times(events, 4)
        validate_times([], 4)

    def test_separate_contract(self):
        value = valid_analysis()
        validate_analysis(value)
        for patch in ({'beatTimes': [1]}, {'lightingEvents': []}, {'durationSec': float('nan')}):
            with self.subTest(patch=patch), self.assertRaises(ValueError):
                validate_analysis(value | patch)
        bad = copy.deepcopy(value)
        bad['features']['rms'] = [1]
        with self.assertRaises(ValueError):
            validate_analysis(bad)

    def test_append_only_json(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / 'revision.json'
            write_new_json(target, {'manual': True, 'deletedEvents': ['cue-1']})
            before = sha256(target)
            with self.assertRaises(FileExistsError):
                write_new_json(target, {'manual': False})
            self.assertEqual(before, sha256(target))

    def test_snapshot_and_verify_do_not_rewrite_legacy(self):
        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory)
            (repo / 'data' / 'tracks').mkdir(parents=True)
            original = repo / 'data' / 'tracks' / 'track.json'
            write_new_json(original, {'manual': True})
            backup = snapshot(repo)
            self.assertEqual(verify_snapshot(repo, backup), [])
            write_new_json(repo / 'data' / 'tracks' / 'new.json', {})
            self.assertEqual(verify_snapshot(repo, backup), ['tracks/new.json'])
            self.assertEqual(read_json(original), {'manual': True})

    def test_missing_or_wrong_model_fails_locally(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / 'model.ckpt'
            with self.assertRaises(ValueError):
                check_model(target)
            target.write_bytes(b'not a model')
            with self.assertRaises(ValueError):
                check_model(target)


class AudioTests(unittest.TestCase):
    def test_canonical_time_origin_and_reuse(self):
        for rate in (44100, 48000):
            with self.subTest(rate=rate), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                source = root / 'source.wav'
                signal = np.zeros((rate * 3, 2), dtype=np.float32)
                signal[rate, :] = .5
                sf.write(source, signal, rate, subtype='FLOAT')
                original = sha256(source)
                project, manifest = prepare_project(source, root / 'projects')
                converted, sr = sf.read(project / 'playback.wav', always_2d=True)
                self.assertEqual(sr, 48000)
                self.assertLessEqual(abs(np.argmax(np.abs(converted[:, 0])) / sr - 1), 1 / sr)
                self.assertEqual(manifest['durationSec'], 3)
                self.assertEqual(manifest['conversion']['trimmedSamples'], 0)
                self.assertEqual(sha256(source), original)
                self.assertEqual(prepare_project(source, root / 'projects'), (project, manifest))
                with (project / 'playback.wav').open('ab') as stream:
                    stream.write(b'corruption')
                with self.assertRaises(ValueError):
                    prepare_project(source, root / 'projects')

    def test_float_peaks_are_preserved(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / 'float.wav'
            signal = np.zeros((48000, 2), dtype=np.float32)
            signal[24000] = [1.35, -1.2]
            sf.write(source, signal, 48000, subtype='FLOAT')
            project, manifest = prepare_project(source, root / 'projects')
            output, _ = sf.read(project / 'playback.wav', dtype='float32')
            np.testing.assert_array_equal(signal, output)
            self.assertEqual(manifest['playbackSamplesAboveFullScale'], 2)

    def test_stereo_cancellation_does_not_erase_signal(self):
        a = np.sin(np.arange(1000) * .1).astype(np.float32)
        mono, mix, warnings = mono_for_analysis(np.column_stack([a, -a]))
        np.testing.assert_array_equal(mono, a)
        self.assertEqual(mix, 'channel-1')
        self.assertTrue(warnings)

    def test_silence_has_no_candidates(self):
        features, candidate = extract_baseline(np.zeros(48000 * 2, dtype=np.float32), 48000)
        self.assertEqual(candidate['onsetsSec'], [])
        self.assertEqual(candidate['beatsSec'], [])
        self.assertEqual(max(features['rms']), 0)

    def test_synthetic_onsets_are_not_shifted_by_leading_silence(self):
        rate = 48000
        y = np.zeros(rate * 5, dtype=np.float32)
        rng = np.random.default_rng(1)
        for t in (1., 2., 3., 4.):
            hit = .3 * rng.uniform(-1, 1, 2400) * np.exp(-np.arange(2400) / 400)
            y[int(t * rate):int(t * rate) + len(hit)] += hit
        _, candidate = extract_baseline(y, rate)
        score = match_events([1., 2., 3., 4.], candidate['onsetsSec'], .05)
        self.assertEqual(score['matched'], 4)
        self.assertEqual(score['predicted'], 4)

    def test_outside_final_frame_is_counted(self):
        values, removed = seconds([-0.01, 0, 1., 2.], 2.)
        self.assertEqual(values, [0., 1.])
        self.assertEqual(removed, 2)


class EvaluationTests(unittest.TestCase):
    def test_one_to_one_matching(self):
        result = match_events([1., 2.], [.99, 1.01, 2.03], .05)
        self.assertEqual(result['matched'], 2)
        self.assertEqual(result['precision'], 2 / 3)
        self.assertEqual(result['recall'], 1.)
        self.assertIsNone(match_events([], [], .05)['f1'])

    def test_unreviewed_is_not_empty_ground_truth(self):
        analysis = valid_analysis()
        labels = {'playbackHash': 'b' * 64, 'clips': [{'id': 'intro', 'startSec': 0, 'endSec': 4}]}
        self.assertEqual(evaluate(analysis, labels)['reports'], [])
        labels['clips'][0]['onsetsSec'] = [1., 2.]
        self.assertEqual(len(evaluate(analysis, labels)['reports']), 1)
        labels['playbackHash'] = 'c' * 64
        with self.assertRaises(ValueError):
            evaluate(analysis, labels)


if __name__ == '__main__':
    unittest.main()
