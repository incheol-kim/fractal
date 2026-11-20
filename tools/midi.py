"""Minimal standard-library MIDI reader (format 0/1, tempo fixed by caller)."""
import struct


def _vlq(data, i):
    v = 0
    while True:
        b = data[i]
        i += 1
        v = (v << 7) | (b & 0x7F)
        if not b & 0x80:
            return v, i


def parse(path):
    """Return (ppq, tracks); each track is a list of (tick, kind, a, b, c)."""
    with open(path, "rb") as f:
        data = f.read()
    if data[:4] != b"MThd":
        raise ValueError("not a MIDI file")
    _, ntrks, ppq = struct.unpack(">HHH", data[8:14])
    i = 8 + struct.unpack(">I", data[4:8])[0]
    tracks = []
    for _ in range(ntrks):
        if data[i:i + 4] != b"MTrk":
            raise ValueError("bad track chunk")
        n = struct.unpack(">I", data[i + 4:i + 8])[0]
        j, end = i + 8, i + 8 + n
        i = end
        tick, status, events = 0, 0, []
        while j < end:
            delta, j = _vlq(data, j)
            tick += delta
            b = data[j]
            if b == 0xFF:  # meta
                typ = data[j + 1]
                ln, k = _vlq(data, j + 2)
                events.append((tick, "meta", typ, data[k:k + ln], 0))
                j = k + ln
                continue
            if b in (0xF0, 0xF7):  # sysex
                ln, k = _vlq(data, j + 1)
                j = k + ln
                continue
            if b & 0x80:
                status = b
                j += 1
            hi = status & 0xF0
            if hi in (0xC0, 0xD0):
                events.append((tick, "pc" if hi == 0xC0 else "ch", data[j], 0, status & 0x0F))
                j += 1
            else:
                a, c = data[j], data[j + 1]
                j += 2
                kind = {0x80: "off", 0x90: "on", 0xA0: "at", 0xB0: "cc", 0xE0: "pb"}[hi]
                if kind == "on" and c == 0:
                    kind = "off"
                events.append((tick, kind, a, c, status & 0x0F))
        tracks.append(events)
    return ppq, tracks


def _sec(tick, ppq, bpm):
    return tick * 60.0 / (bpm * ppq)


def notes(track, ppq, bpm=130.0):
    """Return [(t_midi, dur, pitch, vel)] sorted by time (seconds, MIDI time)."""
    open_ = {}
    out = []
    for tick, kind, a, b, ch in track:
        if kind == "on":
            open_.setdefault((ch, a), []).append((tick, b))
        elif kind == "off":
            q = open_.get((ch, a))
            if q:
                t0, vel = q.pop(0)
                out.append((_sec(t0, ppq, bpm), _sec(tick - t0, ppq, bpm), a, vel))
    out.sort(key=lambda n: (n[0], n[2]))
    return out


def pedal(track, ppq, bpm=130.0):
    """Return [(t_midi, value)] for sustain pedal (CC 64)."""
    return [(_sec(t, ppq, bpm), b) for t, kind, a, b, ch in track if kind == "cc" and a == 64]
