// Integration: real ffmpeg + free TTS rendering, the Wan2GP local engine against
// the repo's fake wgp.py, and the paid-API gate. Offline, no cost.
// Tests that need ffmpeg / a TTS engine skip themselves when those are missing.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { REPO_ROOT, resolveBinaries } from '../src/config.mjs';
import { generateWan2gp, wan2gpStatus } from '../src/engines/wan2gp.mjs';
import { ffmpeg, probeMedia } from '../src/media.mjs';
import { produceVideo } from '../src/producer.mjs';
import { availableTtsEngines } from '../src/tts.mjs';

const bins = resolveBinaries();
const tts = availableTtsEngines();
const hasFfmpeg = Boolean(bins.ffmpeg && bins.ffprobe);
const ttsEngine = tts.espeak ? 'espeak' : tts.piper ? 'piper' : null;

function withEnv(vars, fn) {
    const saved = {};
    for (const [k, v] of Object.entries(vars)) {
        saved[k] = process.env[k];
        process.env[k] = v;
    }
    return Promise.resolve().then(fn).finally(() => {
        for (const [k, v] of Object.entries(saved)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    });
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'oga-test-'));

test('renders a narrated, subtitled multi-scene video with transitions and music', { skip: !hasFfmpeg || !ttsEngine }, async () => {
    const dir = tmp();
    const still = path.join(dir, 'still.png');
    const clip = path.join(dir, 'clip.mp4');
    const music = path.join(dir, 'music.wav');
    await ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=s=640x360', '-frames:v', '1', still]);
    await ffmpeg(['-f', 'lavfi', '-i', 'testsrc=s=320x240:r=24:d=2', '-pix_fmt', 'yuv420p', clip]);
    await ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=220:duration=3', music]);

    await withEnv({ OGA_OUTPUT_DIR: dir }, async () => {
        const result = await produceVideo({
            title: 'Teste automatizado',
            output_name: 'teste',
            format: { aspect_ratio: '16:9', resolution: '480p', fps: 24 },
            voice: { engine: ttsEngine },
            music: { path: music, volume: 0.2 },
            scenes: [
                { visual: { type: 'color', subtitle: 'abertura' }, narration: 'Primeira cena de teste.', transition: 'fadeblack' },
                { visual: { type: 'file', path: still, motion: 'pan_left' }, title: 'Imagem', narration: 'Segunda cena, com imagem animada.', transition: 'wipeleft' },
                { visual: { type: 'file', path: clip }, narration: 'Terceira cena, com um clipe curto que precisa ser alongado.', transition: 'cut' },
                { visual: { type: 'color', color: '#222222' }, title: 'Fim', duration: 2 },
            ],
        });
        const info = await probeMedia(result.video);
        assert.ok(info.hasVideo && info.hasAudio);
        assert.equal(info.width, 854);
        assert.equal(info.height, 480);
        assert.ok(Math.abs(info.duration - result.duration_seconds) < 0.1);
        assert.ok(result.duration_seconds > 8 && result.duration_seconds <= 120);
        const srt = fs.readFileSync(result.subtitles, 'utf-8');
        assert.match(srt, /Primeira cena de teste\./);
        assert.match(srt, /00:00:00,350 -->/);
        assert.ok(fs.existsSync(result.thumbnail));
        assert.match(result.cost, /R\$ 0/);
        assert.ok(fs.existsSync(path.join(result.project_dir, 'manifest.json')));

        // Second run reuses narration from the project cache.
        const again = await produceVideo(JSON.parse(fs.readFileSync(path.join(result.project_dir, 'storyboard.json'), 'utf-8')));
        assert.ok(!again.engines.some((e) => e.startsWith('voz:')), 'narration should come from cache');
    });
    fs.rmSync(dir, { recursive: true, force: true });
});

test('a paid scene without authorization is refused before anything is generated', async () => {
    const dir = tmp();
    await withEnv({ OGA_OUTPUT_DIR: dir, MUAPI_API_KEY: '', OGA_ALLOW_PAID: '' }, async () => {
        await assert.rejects(
            produceVideo({ title: 'Pago', scenes: [{ visual: { type: 'image', prompt: 'x', provider: 'muapi' } }] }),
            /bloqueado/,
        );
        assert.deepEqual(fs.readdirSync(dir), []);
    });
    fs.rmSync(dir, { recursive: true, force: true });
});

test('Wan2GP local engine runs wgp.py --process and returns the clip', async () => {
    const work = tmp();
    const fake = path.join(REPO_ROOT, 'tests', 'fixtures', 'fake-wan2gp');
    await withEnv({
        OGA_WAN2GP_DIR: fake,
        OGA_WAN2GP_PYTHON: process.execPath, // the fixture is a node script
        OGA_WAN2GP_URL: '',
        OPEN_GENERATIVE_AI_LOCAL_AI_DIR: work,
    }, async () => {
        const status = await wan2gpStatus();
        assert.equal(status.ok, true);
        assert.equal(status.mode, 'local');
        const outPath = path.join(work, 'out', 'clip.mp4');
        const result = await generateWan2gp({ prompt: 'ok', seed: 7, duration_seconds: 5, outPath });
        assert.equal(result.seed, 7);
        assert.equal(fs.readFileSync(result.path, 'utf-8'), 'fake video');
        await assert.rejects(generateWan2gp({ prompt: 'fail', outPath }), /out of memory/i);
    });
    fs.rmSync(work, { recursive: true, force: true });
});
