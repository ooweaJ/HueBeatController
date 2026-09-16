"""Score manually labeled event timestamps, not analyzer agreement or lighting taste."""
import argparse
import json
from pathlib import Path

from store import read_json, validate_analysis, validate_times


def match_events(reference, predicted, tolerance):
    if tolerance <= 0:
        raise ValueError('Tolerance must be positive')
    i = j = 0
    errors = []
    while i < len(reference) and j < len(predicted):
        delta = predicted[j] - reference[i]
        if delta < -tolerance:
            j += 1
        elif delta > tolerance:
            i += 1
        else:
            errors.append(delta)
            i += 1
            j += 1
    tp = len(errors)
    precision = tp / len(predicted) if predicted else None
    recall = tp / len(reference) if reference else None
    f1 = 2 * tp / (len(reference) + len(predicted)) if reference or predicted else None
    return {'reference': len(reference), 'predicted': len(predicted), 'matched': tp,
            'precision': precision, 'recall': recall, 'f1': f1,
            'signedErrorsSec': errors, 'toleranceSec': tolerance}


def evaluate(analysis, labels):
    validate_analysis(analysis)
    if labels['playbackHash'] != analysis['playbackHash']:
        raise ValueError('Labels refer to a different canonical audio asset')
    reports = []
    for clip in labels['clips']:
        start, end = clip['startSec'], clip['endSec']
        if not 0 <= start < end <= analysis['durationSec']:
            raise ValueError('Invalid labeled interval')
        ambiguous = clip.get('ambiguousRangesSec', [])
        for a, b in ambiguous:
            if not start <= a < b <= end:
                raise ValueError('Ambiguous range outside labeled interval')
        def included(t):
            return start <= t < end and not any(a <= t < b for a, b in ambiguous)
        for field, tolerance in [('onsetsSec', .05), ('beatsSec', .07), ('downbeatsSec', .07)]:
            if field not in clip:
                continue  # Missing annotations mean unknown, not empty truth.
            validate_times(clip[field], analysis['durationSec'])
            if any(not start <= t < end for t in clip[field]):
                raise ValueError('Reference events outside labeled interval')
            reference = list(filter(included, clip[field]))
            for name, candidate in analysis['candidates'].items():
                if candidate['status'] != 'complete':
                    continue
                if field == 'onsetsSec' and candidate.get('onsetStatus') == 'not-supported':
                    continue
                if field == 'downbeatsSec' and candidate.get('downbeatStatus') == 'not-supported':
                    continue
                predicted = list(filter(included, candidate.get(field, [])))
                reports.append({'clip': clip['id'], 'candidate': name, 'layer': field,
                                'metrics': match_events(reference, predicted, tolerance)})
    return {'analysisId': analysis['analysisId'], 'reports': reports,
            'note': 'Manually annotated event accuracy only. Not lighting quality or overall acceptance.'}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('analysis', type=Path)
    parser.add_argument('labels', type=Path)
    args = parser.parse_args()
    print(json.dumps(evaluate(read_json(args.analysis), read_json(args.labels)), ensure_ascii=False, indent=2))
