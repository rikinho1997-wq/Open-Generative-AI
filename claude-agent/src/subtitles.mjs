// Subtitles built from the narration script itself (no speech recognition needed):
// split into readable cues, wrap to at most two lines, and spread the cues over the
// narration audio in proportion to their length.

const SENTENCE_RE = /[^.!?…]+(?:[.!?…]+["'”’)\]]*|$)/g;

// Split a long sentence into chunks of similar length (never above `limit`), so a
// cue never ends with an orphan like "de LED.". Breaks after a comma when one is
// close to the target length.
export function chunkWords(sentence, limit) {
    const text = sentence.trim();
    if (text.length <= limit) return [text];
    const target = text.length / Math.ceil(text.length / limit);
    let best = null;
    for (let i = 1; i < text.length; i++) {
        if (text[i] !== ' ') continue;
        const left = text.slice(0, i);
        if (left.length > limit) break;
        // A comma near the target is the most natural place to cut.
        const score = Math.abs(left.length - target) - (/[,;:]$/.test(left) ? target * 0.35 : 0);
        if (!best || score < best.score) best = { score, i };
    }
    if (!best) return [text.slice(0, limit), ...chunkWords(text.slice(limit), limit)];
    return [text.slice(0, best.i), ...chunkWords(text.slice(best.i + 1), limit)];
}

export function wrapLines(text, maxChars) {
    if (text.length <= maxChars) return [text];
    let best = null;
    for (let i = 0; i < text.length; i++) {
        if (text[i] !== ' ') continue;
        const a = text.slice(0, i);
        const b = text.slice(i + 1);
        const worst = Math.max(a.length, b.length);
        if (!best || worst < best.worst) best = { worst, lines: [a, b] };
    }
    return best ? best.lines : [text];
}

export function splitCues(text, { maxChars = 42, maxLines = 2 } = {}) {
    const clean = String(text || '').replace(/\s+/g, ' ').trim();
    if (!clean) return [];
    const limit = maxChars * maxLines;
    const sentences = (clean.match(SENTENCE_RE) || [clean]).map((s) => s.trim()).filter(Boolean);
    const cues = [];
    for (const sentence of sentences) {
        const parts = sentence.length <= limit ? [sentence] : chunkWords(sentence, limit);
        for (const part of parts) cues.push(wrapLines(part, maxChars).join('\n'));
    }
    return cues;
}

// Spread cues over [start, start + duration] proportionally to their length.
export function timeCues(cues, start, duration) {
    if (!cues.length || !(duration > 0)) return [];
    const weights = cues.map((c) => c.replace(/\n/g, ' ').length + 6);
    const total = weights.reduce((a, b) => a + b, 0);
    let t = start;
    return cues.map((text, i) => {
        const d = (duration * weights[i]) / total;
        const cue = { start: t, end: t + d, text };
        t += d;
        return cue;
    });
}

function srtTime(seconds) {
    const ms = Math.max(0, Math.round(seconds * 1000));
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    const pad = (n, w = 2) => String(n).padStart(w, '0');
    return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms % 1000, 3)}`;
}

export function toSrt(cues) {
    return cues
        .map((cue, i) => `${i + 1}\n${srtTime(cue.start)} --> ${srtTime(cue.end)}\n${cue.text}\n`)
        .join('\n');
}
