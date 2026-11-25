// Procedural sound effects, synthesised in plain JavaScript: no samples and no
// downloads, so every sound is original and safe for commercial use.
//
//   whoosh, swish, riser, impact   — transitions and emphasis
//   brake, horn, car_pass, traffic — road / vehicle context (traffic is an ambience bed)
//   pop, ding, click, clock        — UI-style accents for diagrams and counters

import fs from 'node:fs';
import path from 'node:path';
import { writeWav } from './music.mjs';

const SR = 44100;
const TWO_PI = Math.PI * 2;

export const SFX_NAMES = ['whoosh', 'swish', 'riser', 'impact', 'brake', 'horn', 'car_pass', 'traffic', 'pop', 'ding', 'click', 'clock'];

function rng(seed = 1) {
    let s = seed >>> 0 || 1;
    return () => {
        s ^= s << 13; s >>>= 0;
        s ^= s >>> 17;
        s ^= s << 5; s >>>= 0;
        return (s / 4294967296) * 2 - 1;
    };
}

// RBJ band-pass biquad whose centre frequency can change every sample.
function bandpass() {
    let x1 = 0; let x2 = 0; let y1 = 0; let y2 = 0;
    return (x, f, q) => {
        const w = (TWO_PI * Math.min(f, SR * 0.45)) / SR;
        const alpha = Math.sin(w) / (2 * q);
        const a0 = 1 + alpha;
        const b0 = alpha / a0; const b2 = -alpha / a0;
        const a1 = (-2 * Math.cos(w)) / a0; const a2 = (1 - alpha) / a0;
        const y = b0 * x + b2 * x2 - a1 * y1 - a2 * y2;
        x2 = x1; x1 = x; y2 = y1; y1 = y;
        return y;
    };
}

function onePoleLow(cutoff) {
    const a = Math.exp((-TWO_PI * cutoff) / SR);
    let y = 0;
    return (x) => (y = (1 - a) * x + a * y);
}

const env = (t, attack, release, total) => {
    if (t < attack) return t / attack;
    if (t > total - release) return Math.max(0, (total - t) / release);
    return 1;
};

function buffer(seconds) {
    const n = Math.max(1, Math.round(seconds * SR));
    return { L: new Float32Array(n), R: new Float32Array(n), n };
}

function finish(b, peak = 0.9) {
    let max = 0;
    for (let i = 0; i < b.n; i++) max = Math.max(max, Math.abs(b.L[i]), Math.abs(b.R[i]));
    const g = max > 0 ? peak / max : 1;
    for (let i = 0; i < b.n; i++) { b.L[i] *= g; b.R[i] *= g; }
    return { L: b.L, R: b.R, sampleRate: SR };
}

function sweepNoise(seconds, from, to, { q = 1.2, peakAt = 0.5, panFrom = -0.6, panTo = 0.6, seed = 3 } = {}) {
    const b = buffer(seconds);
    const noise = rng(seed);
    const bp = bandpass();
    for (let i = 0; i < b.n; i++) {
        const u = i / b.n;
        const f = u < peakAt ? from * (to / from) ** (u / peakAt) : to * (from / to) ** ((u - peakAt) / (1 - peakAt));
        const a = u < peakAt ? (u / peakAt) ** 2 : ((1 - u) / (1 - peakAt)) ** 1.5;
        const s = bp(noise(), f, q) * a;
        const pan = panFrom + (panTo - panFrom) * u;
        b.L[i] = s * Math.cos(((pan + 1) * Math.PI) / 4);
        b.R[i] = s * Math.sin(((pan + 1) * Math.PI) / 4);
    }
    return b;
}

const SYNTHS = {
    whoosh: () => finish(sweepNoise(0.8, 250, 3200, { peakAt: 0.55 })),
    swish: () => finish(sweepNoise(0.35, 900, 6000, { peakAt: 0.4, q: 1.6, seed: 9 }), 0.7),
    riser: () => {
        const b = sweepNoise(2.0, 200, 5000, { peakAt: 0.98, q: 0.9, panFrom: 0, panTo: 0, seed: 5 });
        for (let i = 0; i < b.n; i++) {
            const t = i / SR;
            const f = 180 * (1200 / 180) ** (t / 2);
            const s = 0.25 * Math.sin(TWO_PI * f * t) * (t / 2) ** 2;
            b.L[i] += s; b.R[i] += s;
        }
        return finish(b, 0.8);
    },
    impact: () => {
        const b = buffer(1.4);
        const noise = rng(7);
        const lp = onePoleLow(300);
        let phase = 0;
        for (let i = 0; i < b.n; i++) {
            const t = i / SR;
            const f = 35 + 45 * Math.exp(-t * 6);
            phase += (TWO_PI * f) / SR;
            const boom = Math.sin(phase) * Math.exp(-t * 2.8);
            const burst = lp(noise()) * Math.exp(-t * 14) * 2.5;
            const click = t < 0.004 ? noise() * 0.6 : 0;
            const s = boom + burst + click;
            b.L[i] = s; b.R[i] = s;
        }
        return finish(b);
    },
    brake: () => {
        const b = buffer(1.4);
        const noise = rng(11);
        const bp = bandpass();
        let phase = 0;
        for (let i = 0; i < b.n; i++) {
            const t = i / SR;
            const f = 1350 - 180 * (t / 1.4) + 28 * Math.sin(TWO_PI * 11 * t);
            phase += (TWO_PI * f) / SR;
            const e = env(t, 0.06, 0.35, 1.4);
            const squeal = (Math.sin(phase) + 0.35 * Math.sin(2 * phase) + 0.12 * Math.sin(3 * phase)) * 0.45;
            const hiss = bp(noise(), 2600, 2) * 1.2;
            const thunk = t < 0.25 ? Math.sin(TWO_PI * 70 * t) * Math.exp(-t * 18) * 0.8 : 0;
            const s = (squeal + hiss) * e + thunk;
            b.L[i] = s; b.R[i] = s * 0.92;
        }
        return finish(b, 0.75);
    },
    horn: () => {
        const b = buffer(0.65);
        const lp = onePoleLow(2200);
        for (let i = 0; i < b.n; i++) {
            const t = i / SR;
            let s = 0;
            for (const f of [415, 523]) {
                for (let h = 1; h <= 8; h++) s += Math.sin(TWO_PI * f * h * t) / h;
            }
            s = lp(s * 0.25) * env(t, 0.02, 0.09, 0.65);
            b.L[i] = s; b.R[i] = s;
        }
        return finish(b, 0.7);
    },
    car_pass: () => {
        const b = buffer(2.0);
        const noise = rng(13);
        const lp = onePoleLow(900);
        let phase = 0;
        for (let i = 0; i < b.n; i++) {
            const t = i / SR;
            const u = t / 2.0;
            const doppler = 1 + 0.06 * Math.tanh((0.5 - u) * 8); // pitch drops as it passes
            phase += (TWO_PI * 85 * doppler) / SR;
            let engine = 0;
            for (let h = 1; h <= 6; h++) engine += Math.sin(h * phase) / h;
            const road = lp(noise()) * 2;
            const a = Math.exp(-((u - 0.5) ** 2) / 0.03);
            const s = (engine * 0.35 + road) * a;
            const pan = -0.9 + 1.8 * u;
            b.L[i] = s * Math.cos(((pan + 1) * Math.PI) / 4);
            b.R[i] = s * Math.sin(((pan + 1) * Math.PI) / 4);
        }
        return finish(b, 0.8);
    },
    traffic: (duration = 6) => {
        const b = buffer(duration);
        const nl = rng(17); const nr = rng(19); const nh = rng(23);
        let brownL = 0; let brownR = 0;
        const lpL = onePoleLow(380); const lpR = onePoleLow(380);
        const hiss = bandpass();
        for (let i = 0; i < b.n; i++) {
            const t = i / SR;
            brownL = (brownL + nl() * 0.02) * 0.998;
            brownR = (brownR + nr() * 0.02) * 0.998;
            const hum = (Math.sin(TWO_PI * 52 * t) + 0.5 * Math.sin(TWO_PI * 104 * t)) * (0.6 + 0.4 * Math.sin(TWO_PI * 0.13 * t)) * 0.08;
            const h = hiss(nh(), 1800, 0.7) * 0.12 * (0.7 + 0.3 * Math.sin(TWO_PI * 0.07 * t + 1));
            const e = env(t, 0.6, 0.8, duration);
            b.L[i] = (lpL(brownL) * 3 + hum + h) * e;
            b.R[i] = (lpR(brownR) * 3 + hum * 0.9 + h) * e;
        }
        return finish(b, 0.6);
    },
    pop: () => {
        const b = buffer(0.2);
        let phase = 0;
        for (let i = 0; i < b.n; i++) {
            const t = i / SR;
            const f = 480 + 700 * (1 - Math.exp(-t * 60));
            phase += (TWO_PI * f) / SR;
            const s = Math.sin(phase) * Math.exp(-t * 28) * (t < 0.003 ? t / 0.003 : 1);
            b.L[i] = s; b.R[i] = s;
        }
        return finish(b, 0.7);
    },
    ding: () => {
        const b = buffer(1.3);
        for (let i = 0; i < b.n; i++) {
            const t = i / SR;
            const s = Math.sin(TWO_PI * 1320 * t) * Math.exp(-t * 3.5)
                + 0.45 * Math.sin(TWO_PI * 1320 * 2.76 * t) * Math.exp(-t * 6)
                + 0.2 * Math.sin(TWO_PI * 1320 * 5.4 * t) * Math.exp(-t * 9);
            const a = t < 0.004 ? t / 0.004 : 1;
            b.L[i] = s * a; b.R[i] = s * a;
        }
        return finish(b, 0.55);
    },
    click: () => {
        const b = buffer(0.06);
        const noise = rng(29);
        const bp = bandpass();
        for (let i = 0; i < b.n; i++) {
            const t = i / SR;
            const s = (bp(noise(), 3500, 1.5) * 2 + Math.sin(TWO_PI * 2900 * t) * 0.5) * Math.exp(-t * 90);
            b.L[i] = s; b.R[i] = s;
        }
        return finish(b, 0.6);
    },
    clock: (duration = 3) => {
        const b = buffer(duration);
        const noise = rng(31);
        const bp = bandpass();
        for (let i = 0; i < b.n; i++) {
            const t = i / SR;
            const k = Math.floor(t / 0.5);
            const local = t - k * 0.5;
            const f = k % 2 ? 2400 : 3100;
            const s = local < 0.03 ? (bp(noise(), f, 4) * 3 + Math.sin(TWO_PI * f * local) * 0.3) * Math.exp(-local * 160) : bp(0, f, 4);
            b.L[i] = s; b.R[i] = s;
        }
        return finish(b, 0.55);
    },
};

export function synthesizeSfx(name, { duration } = {}) {
    const synth = SYNTHS[name];
    if (!synth) throw new Error(`Efeito sonoro desconhecido: ${name}. Disponíveis: ${SFX_NAMES.join(', ')}`);
    return synth(duration);
}

export function generateSfx(name, outPath, { duration } = {}) {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    if (!fs.existsSync(outPath)) writeWav(outPath, synthesizeSfx(name, { duration }));
    return outPath;
}
