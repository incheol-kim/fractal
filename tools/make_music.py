"""Build assets/music.json from the MIDI + WAV and copy the mp3 to assets/fractal.mp3."""
import json
import os
import shutil
import subprocess
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)

import midi  # noqa: E402

NAME = "2026-11-07 fractal"  # the MIDI and the mixdown folder (named after the piece since 2026-11-20)
MIDI = os.path.join(ROOT, "resources", "midi", NAME + ".mid")
MIX = os.path.join(ROOT, "resources", "Mixdown", NAME)
# The final master (same mix, limiter redone; same length and start as the first export).
# The final video is made with this WAV; the page plays the mp3 beside it.
MASTER = "2026-11-07 fractal - final"
WAV = os.path.join(MIX, MASTER + ".wav")
MP3 = os.path.join(MIX, MASTER + ".mp3")
OUT = os.path.join(ROOT, "assets")

OFFSET = 0.923077
BAR = 1.846154
DUR = 47.076938             # the audio's length (s)
CELLO_TRACK, PIANO_TRACK = 1, 4
ATTACK_GAP = 0.045


def r4(x):
    return round(float(x), 4)


def group_attacks(piano):
    attacks = []
    last = None
    for i, n in enumerate(piano):
        if attacks and n[0] - last <= ATTACK_GAP:
            attacks[-1][1].append(i)
        else:
            attacks.append([n[0], [i]])
        last = n[0]
    return attacks


def read_wav_mono(path):
    raw = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", path, "-f", "f32le", "-ac", "1", "-"],
        check=True, capture_output=True).stdout
    return np.frombuffer(raw, dtype="<f4").astype(np.float64)


def envelope(path, sr=48000, win_s=0.01):
    # ffmpeg downmix (-ac 1) averages the channels
    x = read_wav_mono(path)
    w = int(round(sr * win_s))
    n = len(x) // w
    rms = np.sqrt((x[: n * w].reshape(n, w) ** 2).mean(axis=1))
    # keep the trailing partial window too
    if len(x) > n * w:
        rms = np.append(rms, np.sqrt((x[n * w:] ** 2).mean()))
    return [int(v) for v in np.rint(rms / rms.max() * 1000)]


def build(with_env=True):
    ppq, tracks = midi.parse(MIDI)

    def shift(ns):
        return [[r4(t - OFFSET), r4(d), p, v] for t, d, p, v in ns]

    cello = shift(midi.notes(tracks[CELLO_TRACK], ppq))
    piano_raw = [(t - OFFSET, d, p, v) for t, d, p, v in midi.notes(tracks[PIANO_TRACK], ppq)]
    piano = [[r4(t), r4(d), p, v] for t, d, p, v in piano_raw]
    attacks = [[r4(t), idx] for t, idx in group_attacks(piano_raw)]
    ped = [[r4(t - OFFSET), v] for t, v in midi.pedal(tracks[PIANO_TRACK], ppq)]
    m = {
        "dur": r4(DUR), "offset": r4(OFFSET), "bar": r4(BAR), "m1": r4(OFFSET),
        "cello": cello, "piano": piano, "attacks": attacks, "pedal": ped,
        "env": envelope(WAV) if with_env else [],
        "sections": {
            "A": [0.923, 15.692], "B": [15.692, 30.30], "C": [30.30, 41.538],
            "coda": [41.538, 45.231], "tail": [45.231, 47.077],
        },
    }
    return m


def main():
    m = build()
    os.makedirs(OUT, exist_ok=True)
    with open(os.path.join(OUT, "music.json"), "w", encoding="utf-8") as f:
        json.dump(m, f, separators=(",", ":"))
    shutil.copyfile(MP3, os.path.join(OUT, "fractal.mp3"))
    print("wrote assets/music.json and assets/fractal.mp3")


if __name__ == "__main__":
    main()
