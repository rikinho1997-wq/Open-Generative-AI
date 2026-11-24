// Pure logic: subtitles, timeline/120-second limit, filters, paid-API gate.
// No network, no binaries, no cost.
import assert from 'node:assert/strict';
import test from 'node:test';
import { assertPaidAllowed, paidPolicy } from '../src/config.mjs';
import { aspectToDimensions, buildSdCliArgs, getImageModel } from '../src/engines/sdcpp.mjs';
import { framesForSeconds } from '../src/engines/wan2gp.mjs';
import { buildAssembleFilter, buildAudioMixFilter, clipStarts, fitText, kenBurnsFilter, outputSize, pickMotion, totalDuration } from '../src/media.mjs';
import { dryRun } from '../src/producer.mjs';
import { CUT_DURATION, LEAD_IN, TAIL, parseStoryboard, planTimeline, slugify } from '../src/storyboard.mjs';
import { chunkWords, splitCues, timeCues, toSrt, wrapLines } from '../src/subtitles.mjs';
import { piperVoiceUrl } from '../src/tts.mjs';

const scene = (narration, extra = {}) => ({ narration, visual: { type: 'color' }, ...extra });

test('splitCues breaks sentences and wraps to two balanced lines', () => {
    const cues = splitCues('Primeira frase curta. Esta segunda frase é bem mais longa e precisa ser quebrada em duas linhas!', { maxChars: 42 });
    assert.equal(cues.length, 2);
    assert.equal(cues[0], 'Primeira frase curta.');
    for (const line of cues[1].split('\n')) assert.ok(line.length <= 42, line);
    assert.equal(cues[1].split('\n').length, 2);
});

test('splitCues chunks a sentence longer than two lines', () => {
    const long = Array.from({ length: 40 }, (_, i) => `palavra${i}`).join(' ');
    const cues = splitCues(long, { maxChars: 30 });
    assert.ok(cues.length > 1);
    for (const cue of cues) {
        assert.ok(cue.split('\n').length <= 2);
        for (const line of cue.split('\n')) assert.ok(line.length <= 30 || !line.includes(' '), line);
    }
});

test('wrapLines keeps short text on one line', () => {
    assert.deepEqual(wrapLines('curto', 42), ['curto']);
});

test('timeCues covers the narration span exactly and toSrt formats times', () => {
    const cues = timeCues(['um', 'dois três quatro'], 10, 4);
    assert.equal(cues[0].start, 10);
    assert.ok(Math.abs(cues[cues.length - 1].end - 14) < 1e-9);
    assert.ok(cues[0].end - cues[0].start < cues[1].end - cues[1].start);
    const srt = toSrt([{ start: 3661.5, end: 3662.25, text: 'Olá' }]);
    assert.match(srt, /^1\n01:01:01,500 --> 01:01:02,250\nOlá\n/);
});

test('storyboard defaults are applied', () => {
    const sb = parseStoryboard({ title: 'X', scenes: [scene('oi')] });
    assert.equal(sb.format.aspect_ratio, '16:9');
    assert.equal(sb.format.fps, 30);
    assert.equal(sb.subtitles.enabled, true);
    assert.equal(sb.defaults.transition, 'fade');
    assert.equal(sb.defaults.fast, true);
    assert.equal(sb.voice.engine, 'auto');
});

test('invalid storyboard gives a readable error', () => {
    assert.throws(() => parseStoryboard({ title: 'X', scenes: [] }), /Roteiro inválido: scenes/);
    assert.throws(() => parseStoryboard({ title: 'X', scenes: [{ visual: { type: 'gif' } }] }), /visual\.type/);
});

test('planTimeline keeps narration clear of transitions', () => {
    const sb = parseStoryboard({ title: 'X', scenes: [scene('a'), scene('b', { transition: 'cut' }), scene('c')] });
    const plan = planTimeline(sb, [4, 6, 0]);
    assert.equal(plan.transitions[0].duration, 0.6);
    assert.equal(plan.transitions[1].duration, CUT_DURATION);
    // Scene 1 must fit lead-in + narration + tail + its outgoing transition.
    assert.ok(plan.durations[0] >= LEAD_IN + 4 + TAIL + 0.6 - 1e-9);
    assert.ok(plan.durations[1] >= LEAD_IN + 6 + TAIL + CUT_DURATION - 1e-9);
    assert.equal(plan.durations[2], 2.5);
    // Narration of scene i ends before scene i+1 starts.
    for (let i = 0; i < 2; i++) {
        const narrEnd = plan.narrationStarts[i] + [4, 6][i];
        assert.ok(narrEnd <= plan.starts[i + 1] + 1e-9);
    }
    assert.ok(Math.abs(plan.total - totalDuration(plan.durations, plan.transitions.map((t) => t.duration))) < 1e-6);
});

test('the 120-second limit is enforced', () => {
    const sb = parseStoryboard({ title: 'X', scenes: Array.from({ length: 5 }, () => scene('x')) });
    assert.equal(planTimeline(sb, [20, 20, 20, 20, 20]).withinLimit, true);
    assert.equal(planTimeline(sb, [25, 25, 25, 25, 25]).withinLimit, false);
    const long = 'Uma frase de narração que se repete muitas vezes. '.repeat(30);
    const report = dryRun({ title: 'X', scenes: [scene(long), scene(long), scene(long)] });
    assert.equal(report.ok, false);
    assert.ok(report.estimated_total_seconds > 120);
});

test('dryRun flags paid scenes and reports free cost otherwise', () => {
    const free = dryRun({ title: 'X', scenes: [{ visual: { type: 'image', prompt: 'a cat' } }] });
    assert.deepEqual(free.paid_scenes, []);
    assert.match(free.cost, /gratuito/);
    const paid = dryRun({ title: 'X', scenes: [{ visual: { type: 'image', prompt: 'a cat', provider: 'muapi' } }] });
    assert.deepEqual(paid.paid_scenes, [1]);
    assert.match(paid.cost, /PAGO/);
});

test('paid API needs key + OGA_ALLOW_PAID + per-call flag', () => {
    assert.equal(paidPolicy({}).enabled, false);
    assert.throws(() => assertPaidAllowed(true, {}), /MUAPI_API_KEY/);
    assert.throws(() => assertPaidAllowed(true, { MUAPI_API_KEY: 'k' }), /OGA_ALLOW_PAID/);
    assert.throws(() => assertPaidAllowed(false, { MUAPI_API_KEY: 'k', OGA_ALLOW_PAID: '1' }), /allow_paid/);
    assert.doesNotThrow(() => assertPaidAllowed(true, { MUAPI_API_KEY: 'k', OGA_ALLOW_PAID: '1' }));
});

test('xfade offsets follow the overlapped timeline', () => {
    const durations = [5, 4, 6];
    const transitions = [{ type: 'fade', duration: 0.5 }, { type: 'cut', duration: CUT_DURATION }];
    assert.deepEqual(clipStarts(durations, [0.5, CUT_DURATION]).map((v) => Number(v.toFixed(3))), [0, 4.5, 8.46]);
    const filter = buildAssembleFilter({ count: 3, durations, transitions, fps: 30, subtitlesFile: 'x.srt', style: 'FontSize=16' });
    assert.match(filter, /xfade=transition=fade:duration=0\.500:offset=4\.500\[x1\]/);
    assert.match(filter, /\[x1\]\[v2\]xfade=transition=fade:duration=0\.040:offset=8\.460\[x2\]/);
    assert.match(filter, /\[x2\]subtitles=filename=x\.srt:force_style='FontSize=16'\[vout\]/);
});

test('audio mix delays narration, ducks music and normalises loudness', () => {
    const filter = buildAudioMixFilter({ narrations: [{ start: 0.35 }, { start: 5.2 }], total: 12, musicIndex: 2 });
    assert.match(filter, /adelay=delays=350:all=1\[n0\]/);
    assert.match(filter, /adelay=delays=5200:all=1\[n1\]/);
    assert.match(filter, /sidechaincompress/);
    assert.match(filter, /loudnorm=I=-16/);
    assert.equal(buildAudioMixFilter({ narrations: [], total: 3, musicIndex: null }), null);
});

test('output sizes and motions', () => {
    assert.deepEqual(outputSize('16:9', '720p'), { width: 1280, height: 720 });
    assert.deepEqual(outputSize('9:16', '1080p'), { width: 1080, height: 1920 });
    assert.deepEqual(outputSize('1:1', '720p'), { width: 720, height: 720 });
    assert.equal(pickMotion('auto', 0), 'zoom_in');
    assert.equal(pickMotion('pan_left', 3), 'pan_left');
    assert.match(kenBurnsFilter({ width: 1280, height: 720, fps: 30, frames: 150, motion: 'zoom_in' }), /zoompan=z='1\+0\.16\*on\/149'.*s=1280x720:fps=30/);
});

test('sd-cli arguments for normal and LCM fast mode', () => {
    const model = getImageModel('dreamshaper-8');
    const base = { model, modelsDir: '/m', prompt: 'a cat', negativePrompt: 'blurry', outPath: '/o.png', width: 512, height: 512, steps: 20, cfgScale: 7.5, seed: 1 };
    const normal = buildSdCliArgs(base);
    assert.deepEqual(normal.slice(0, 4), ['-m', '/m/DreamShaper_8_pruned.safetensors', '-p', 'a cat']);
    assert.ok(normal.includes('euler_a'));
    assert.ok(normal.includes('-n'));
    const fast = buildSdCliArgs({ ...base, fast: true, steps: 5, cfgScale: 1 });
    assert.equal(fast[3], 'a cat <lora:lcm-lora-sdv1-5:1>');
    assert.ok(fast.includes('lcm'));
    assert.ok(fast.includes('--lora-model-dir'));
    assert.ok(!fast.includes('-n'));
    assert.deepEqual(aspectToDimensions('16:9', 'sd1'), [896, 512]);
    assert.deepEqual(aspectToDimensions('9:16', 'sdxl'), [1024, 1792]);
});

test('Wan2GP frame counts match each family', () => {
    assert.equal(framesForSeconds({ family: 'wan' }, 5), 81);
    assert.equal(framesForSeconds({ family: 'ltx' }, 5), 121);
});

test('Piper voice URL and slugs', () => {
    assert.equal(piperVoiceUrl('pt_BR-faber-medium'),
        'https://huggingface.co/rhasspy/piper-voices/resolve/main/pt/pt_BR/faber/medium/pt_BR-faber-medium.onnx');
    assert.throws(() => piperVoiceUrl('../../etc'), /inválido/);
    assert.equal(slugify('Energia Solar: Como Funciona?'), 'energia-solar-como-funciona');
});

test('long sentences split into balanced chunks without orphans', () => {
    const chunks = chunkWords('Primeira dica: troque lâmpadas antigas por lâmpadas de LED.', 52);
    assert.equal(chunks.length, 2);
    assert.ok(Math.min(...chunks.map((c) => c.length)) >= 20, JSON.stringify(chunks));
});

test('titles wrap and shrink to fit portrait and landscape frames', () => {
    const portrait = fitText('Economize energia em casa', { width: 720, size: 72 });
    assert.ok(portrait.lines.length >= 2 && portrait.lines.length <= 3);
    for (const line of portrait.lines) assert.ok(line.length * portrait.size * 0.62 <= 720 * 0.88 + 1, line);
    const landscape = fitText('Energia solar em 1 minuto', { width: 1280, size: 72 });
    assert.deepEqual(landscape.lines, ['Energia solar em 1 minuto']);
    const huge = fitText('palavra '.repeat(40), { width: 720, size: 72, maxLines: 3 });
    assert.ok(huge.size < 72);
});
