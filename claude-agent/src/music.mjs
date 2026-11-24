// Original instrumental background music, synthesised locally in plain JavaScript
// (no samples, no downloads, no AI model) — royalty-free by construction.
// Soft piano arpeggios + warm pad + bass over a four-chord progression, with an
// intro, a fuller middle section and an outro; FFmpeg adds reverb and loudness.

import fs from 'node:fs';
import path from 'node:path';
import { ffmpeg } from './media.mjs';

export const MOODS = ['emotional', 'hopeful', 'calm', 'reflective'];

// root = MIDI note of the key's tonic in octave 3; chords as semitones from it.
const PRESETS = {
    emotional: { root: 50, bpm: 64, chords: [[0, 4, 7], [7, 11, 14], [9, 12, 16], [5, 9, 12]] }, // D: I V vi IV
    hopeful: { root: 55, bpm: 72, chords: [[5, 9, 12], [0, 4, 7], [7, 11, 14], [9, 12, 16]] }, // G: IV I V vi
    calm: { root: 48, bpm: 60, chords: [[0, 4, 7], [9, 12, 16], [5, 9, 12], [7, 11, 14]] }, // C: I vi IV V
    reflective: { root: 57, bpm: 60, chords: [[0, 3, 7], [-4, 0, 3], [3, 7, 10], [-2, 2, 5]] }, // Am: i VI III VII
};

const SR = 44100;
const TWO_PI = Math.PI * 2;
const freq = (midi) => 440 * 2 ** ((midi - 69) / 12);

function rng(seed) {
    let s = seed >>> 0 || 1;
    return () => {
        s ^= s << 13; s >>>= 0;
        s ^= s >>> 17;
        s ^= s << 5; s >>>= 0;
        return s / 4294967296;
    };
}

function addPiano(L, R, midi, start, hold, vel, pan) {
    const f = freq(midi);
    const len = Math.min(L.length - Math.floor(start * SR), Math.floor((hold + 1.6) * SR));
    const i0 = Math.floor(start * SR);
    const gl = Math.cos(((pan + 1) * Math.PI) / 4);
    const gr = Math.sin(((pan + 1) * Math.PI) / 4);
    const decay = 0.9 + Math.max(0, midi - 55) * 0.035;
    const harmonics = [1, 0.45, 0.22, 0.12, 0.06];
    for (let k = 0; k < len; k++) {
        const t = k / SR;
        let env = (t < 0.006 ? t / 0.006 : 1) * Math.exp(-t * decay);
        if (t > hold) env *= Math.exp(-(t - hold) * 5);
        if (env < 1e-4) break;
        let s = 0;
        for (let h = 0; h < harmonics.length; h++) {
            const n = h + 1;
            s += harmonics[h] * Math.sin(TWO_PI * f * n * (1 + 0.0003 * n * n) * t) * Math.exp(-t * n * 0.6);
        }
        s *= env * vel;
        L[i0 + k] += s * gl;
        R[i0 + k] += s * gr;
    }
}

function addPad(L, R, notes, start, dur, vol) {
    const i0 = Math.floor(start * SR);
    const release = 1.8;
    const len = Math.min(L.length - i0, Math.floor((dur + release) * SR));
    const attack = Math.min(1.4, dur / 2);
    for (const midi of notes) {
        const f = freq(midi);
        for (let k = 0; k < len; k++) {
            const t = k / SR;
            let env = t < attack ? t / attack : 1;
            if (t > dur) env *= Math.max(0, 1 - (t - dur) / release);
            const trem = 1 + 0.08 * Math.sin(TWO_PI * 0.23 * t);
            const a = Math.sin(TWO_PI * f * 0.9975 * t) + 0.18 * Math.sin(TWO_PI * f * 2 * t);
            const b = Math.sin(TWO_PI * f * 1.0025 * t) + 0.18 * Math.sin(TWO_PI * f * 2.003 * t);
            L[i0 + k] += a * env * vol * trem;
            R[i0 + k] += b * env * vol * trem;
        }
    }
}

function addBass(L, R, midi, start, dur, vol) {
    const f = freq(midi);
    const i0 = Math.floor(start * SR);
    const len = Math.min(L.length - i0, Math.floor((dur + 0.6) * SR));
    for (let k = 0; k < len; k++) {
        const t = k / SR;
        let env = (t < 0.04 ? t / 0.04 : 1) * Math.exp(-t * 0.35);
        if (t > dur) env *= Math.max(0, 1 - (t - dur) / 0.6);
        const s = (Math.sin(TWO_PI * f * t) + 0.25 * Math.sin(TWO_PI * f * 2 * t)) * env * vol;
        L[i0 + k] += s;
        R[i0 + k] += s;
    }
}

// Returns { L, R } Float32Arrays at 44.1 kHz.
export function synthesize({ seconds, mood = 'emotional', seed = 7 }) {
    const preset = PRESETS[mood] || PRESETS.emotional;
    const total = Math.max(4, seconds);
    const L = new Float32Array(Math.ceil(total * SR));
    const R = new Float32Array(L.length);
    const random = rng(seed);
    const beat = 60 / preset.bpm;
    const chordLen = beat * 8; // two bars per chord
    const end = total - 3; // leave room for the final ring-out
    let c = 0;
    for (let t0 = 0; t0 < end; t0 += chordLen, c++) {
        const chord = preset.chords[c % preset.chords.length].map((x) => preset.root + x);
        const last = t0 + chordLen >= end;
        const pos = t0 / total;
        const section = last || pos > 0.86 ? 'outro' : pos < 0.12 ? 'intro' : pos < 0.45 ? 'a' : 'b';
        const span = Math.min(chordLen, total - t0);
        addPad(L, R, chord.map((n) => n + 12), t0, span, section === 'b' ? 0.035 : 0.028);
        if (section !== 'intro') addBass(L, R, chord[0] - 12, t0, span, section === 'b' ? 0.2 : 0.14);

        const tones = [chord[0] + 12, chord[1] + 12, chord[2] + 12, chord[0] + 24, chord[1] + 24];
        const humanize = () => (random() - 0.5) * 0.016;
        const vel = (base) => base * (0.88 + random() * 0.24);
        const pan = () => (random() - 0.5) * 0.6;
        if (section === 'intro' || section === 'outro') {
            for (let bar = 0; bar < 2; bar++) {
                const t = t0 + bar * beat * 4;
                if (t >= end) break;
                const fadeOut = section === 'outro' ? Math.max(0.35, 1 - (t - total * 0.86) / (total * 0.14)) : 1;
                addPiano(L, R, tones[0], t + humanize(), beat * 3, vel(0.16) * fadeOut, pan());
                addPiano(L, R, tones[2], t + beat * 2 + humanize(), beat * 2, vel(0.11) * fadeOut, pan());
            }
            if (last) addPiano(L, R, tones[3], t0 + beat * 4, beat * 6, 0.13, 0);
        } else {
            const pattern = section === 'a' ? [0, 1, 2, 1] : [0, 1, 2, 3, 4, 3, 2, 1];
            const step = section === 'a' ? beat : beat / 2;
            const steps = Math.round(chordLen / step);
            for (let k = 0; k < steps; k++) {
                const t = t0 + k * step;
                if (t >= end) break;
                const accent = k % (section === 'a' ? 4 : 8) === 0 ? 1.25 : 1;
                addPiano(L, R, tones[pattern[k % pattern.length]], t + humanize(), step * 1.5, vel(section === 'a' ? 0.12 : 0.1) * accent, pan());
            }
            if (section === 'b') {
                // A simple melody line on chord tones, an octave above the arpeggio.
                for (let k = 0; k < 4; k++) {
                    if (random() < 0.35) continue;
                    const t = t0 + k * beat * 2;
                    if (t >= end) break;
                    const note = chord[Math.floor(random() * 3)] + 24 + (random() < 0.3 ? 12 : 0);
                    addPiano(L, R, note, t + humanize(), beat * 2, vel(0.1), pan() * 0.5);
                }
            }
        }
    }
    let peak = 0;
    for (let i = 0; i < L.length; i++) peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
    const gain = peak > 0 ? 0.8 / peak : 1;
    for (let i = 0; i < L.length; i++) {
        L[i] *= gain;
        R[i] *= gain;
    }
    return { L, R, sampleRate: SR };
}

export function writeWav(file, { L, R, sampleRate }) {
    const frames = L.length;
    const buf = Buffer.alloc(44 + frames * 4);
    buf.write('RIFF', 0);
    buf.writeUInt32LE(36 + frames * 4, 4);
    buf.write('WAVEfmt ', 8);
    buf.writeUInt32LE(16, 16);
    buf.writeUInt16LE(1, 20);
    buf.writeUInt16LE(2, 22);
    buf.writeUInt32LE(sampleRate, 24);
    buf.writeUInt32LE(sampleRate * 4, 28);
    buf.writeUInt16LE(4, 32);
    buf.writeUInt16LE(16, 34);
    buf.write('data', 36);
    buf.writeUInt32LE(frames * 4, 40);
    for (let i = 0; i < frames; i++) {
        buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, L[i])) * 32767), 44 + i * 4);
        buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, R[i])) * 32767), 46 + i * 4);
    }
    fs.writeFileSync(file, buf);
}

// Full track: synthesis + room reverb + gentle EQ + fades + loudness.
export async function generateMusic({ seconds, mood = 'emotional', seed = 7, outPath, signal }) {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    const raw = `${outPath}.raw.wav`;
    writeWav(raw, synthesize({ seconds, mood, seed }));
    const fadeStart = Math.max(0, seconds - 4).toFixed(2);
    try {
        await ffmpeg(['-i', raw, '-af', [
            'aecho=0.8:0.72:73|151|293|587:0.32|0.24|0.16|0.09',
            'highpass=f=40',
            'lowpass=f=9500',
            'afade=t=in:d=2',
            `afade=t=out:st=${fadeStart}:d=4`,
            'loudnorm=I=-20:TP=-2:LRA=9',
            'aresample=44100',
        ].join(','), '-t', String(seconds), outPath], { signal });
    } finally {
        fs.rmSync(raw, { force: true });
    }
    return { path: outPath, seconds, mood, engine: 'sintetizador interno (trilha original, livre de direitos)' };
}
