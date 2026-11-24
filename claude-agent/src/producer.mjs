// End-to-end production: storyboard → narration → visuals → scene clips →
// transitions + subtitles → audio mix → final MP4 (+ .srt, thumbnail, manifest).
//
// Assets are content-addressed inside the project folder (outputs/<name>/), so
// re-running the same storyboard only regenerates what changed — edit one
// narration line and no image is generated again.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { assertPaidAllowed, ensureDir, resolvePaths } from './config.mjs';
import { DEFAULT_IMAGE_MODEL, generateLocalImage } from './engines/sdcpp.mjs';
import { DEFAULT_VIDEO_MODEL, generateWan2gp, wan2gpStatus } from './engines/wan2gp.mjs';
import { paidGenerateImage, paidGenerateVideo } from './engines/muapi.mjs';
import {
    assembleVideo, extractThumbnail, mixAudio, muxFinal, outputSize, pickMotion, probeMedia,
    renderColorScene, renderImageScene, renderVideoScene, subtitleStyle,
} from './media.mjs';
import { estimateNarrationSeconds, limitError, parseStoryboard, planTimeline, slugify } from './storyboard.mjs';
import { splitCues, timeCues, toSrt } from './subtitles.mjs';
import { synthesize } from './tts.mjs';
import { generateMusic } from './music.mjs';

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp']);

function hash(value) {
    return crypto.createHash('sha1').update(JSON.stringify(value)).digest('hex').slice(0, 10);
}

const pad = (i) => String(i + 1).padStart(2, '0');

// ─── Single generations (shared with the MCP tools) ─────────────────────────

export async function generateImageAny(params, { signal, onProgress } = {}) {
    const provider = params.provider || 'local';
    if (provider === 'muapi') return paidGenerateImage({ ...params });
    if (provider === 'wan2gp') {
        return generateWan2gp({ ...params, model: params.model || 'wan2gp:flux-dev', signal, onProgress });
    }
    return generateLocalImage({ ...params, model: params.model || DEFAULT_IMAGE_MODEL, signal, onProgress });
}

export async function generateClipAny(params, { signal, onProgress } = {}) {
    const provider = params.provider || 'wan2gp';
    if (provider === 'muapi') return paidGenerateVideo({ ...params });
    return generateWan2gp({ ...params, model: params.model || DEFAULT_VIDEO_MODEL, signal, onProgress });
}

// ─── Planning without generating anything ──────────────────────────────────

export function dryRun(input) {
    const sb = parseStoryboard(input);
    const estimates = sb.scenes.map((s) => (s.narration ? estimateNarrationSeconds(s.narration, sb.voice.speed) : 0));
    const plan = planTimeline(sb, estimates);
    const paidScenes = sb.scenes.map((s, i) => (s.visual.provider === 'muapi' ? i + 1 : null)).filter(Boolean);
    return {
        ok: plan.withinLimit,
        estimated_total_seconds: plan.total,
        estimated_narration_fit_seconds: plan.natural_seconds,
        target_seconds: plan.target_seconds,
        ...(plan.targetError ? { problem: plan.targetError } : {}),
        max_seconds: plan.maxSeconds,
        scenes: sb.scenes.map((s, i) => ({
            scene: i + 1,
            visual: s.visual.type,
            provider: s.visual.provider || (s.visual.type === 'video' ? 'wan2gp' : s.visual.type === 'image' ? 'local' : '-'),
            estimated_seconds: plan.durations[i],
            narration_chars: (s.narration || '').length,
        })),
        paid_scenes: paidScenes,
        cost: paidScenes.length ? `PAGO: ${paidScenes.length} geração(ões) MuAPI` : 'gratuito (somente motores locais)',
        note: 'Estimativa pela contagem de caracteres; a duração real vem do áudio gerado.',
    };
}

// ─── Full production ─────────────────────────────────────────────────────────

export async function produceVideo(input, { allowPaid = false, signal, progress = () => {}, log = () => {} } = {}) {
    const sb = parseStoryboard(input);
    const paidScenes = sb.scenes.filter((s) => s.visual.provider === 'muapi');
    if (paidScenes.length) assertPaidAllowed(allowPaid);

    const estimate = dryRun(sb);
    if (estimate.estimated_narration_fit_seconds > Math.min(estimate.max_seconds, estimate.target_seconds || Infinity) * 1.1) {
        throw new Error(`Estimativa de ${estimate.estimated_total_seconds.toFixed(0)} s excede o limite de ${estimate.max_seconds} s. `
            + 'Encurte a narração ou reduza as cenas.');
    }

    const paths = resolvePaths();
    const name = sb.output_name || slugify(sb.title);
    const projectDir = ensureDir(path.join(paths.outputDir, name));
    for (const sub of ['narration', 'visuals', 'clips']) ensureDir(path.join(projectDir, sub));
    fs.writeFileSync(path.join(projectDir, 'storyboard.json'), JSON.stringify(input, null, 2));
    const started = Date.now();
    const { width, height } = outputSize(sb.format.aspect_ratio, sb.format.resolution);
    const fps = sb.format.fps;
    const n = sb.scenes.length;
    const report = sb.scenes.map((s, i) => ({ scene: i + 1, visual: s.visual.type }));
    const engines = new Set();

    // 1. Narration ───────────────────────────────────────────────────────────
    const narration = [];
    for (let i = 0; i < n; i++) {
        const text = sb.scenes[i].narration;
        if (!text || sb.voice.engine === 'none') {
            narration.push(null);
            continue;
        }
        progress('narração', (i / n) * 0.12, `Narração da cena ${i + 1}/${n}`);
        const key = hash({ text, voice: sb.voice, language: sb.language });
        const out = path.join(projectDir, 'narration', `scene-${pad(i)}-${key}.wav`);
        let result;
        const cached = fs.existsSync(out);
        if (cached) {
            result = { path: out, duration: (await probeMedia(out)).duration, engine: sb.voice.engine === 'auto' ? 'tts' : sb.voice.engine, voice: sb.voice.voice };
        } else {
            result = await synthesize({ text, outPath: out, engine: sb.voice.engine, voice: sb.voice.voice, speed: sb.voice.speed, language: sb.language, signal });
        }
        engines.add(`voz: ${result.engine}${result.voice ? ` (${result.voice})` : ''}`);
        narration.push(result);
        report[i].narration_seconds = Number(result.duration.toFixed(2));
        report[i].narration_source = cached ? 'cache' : 'gerada agora';
    }

    // 2. Timeline (real durations) ─────────────────────────────────────────────
    const plan = planTimeline(sb, narration.map((r) => r?.duration || 0));
    if (!plan.withinLimit) throw limitError(plan);
    log(`Linha do tempo: ${plan.total.toFixed(3)} s em ${n} cenas`
        + (plan.padding_per_scene ? ` (+${plan.padding_per_scene.toFixed(2)} s de pausa por cena para fechar a duração-alvo)` : ''));

    // 3. Visuals ────────────────────────────────────────────────────────────────
    let wan2gp = null;
    const visuals = [];
    for (let i = 0; i < n; i++) {
        const scene = sb.scenes[i];
        const v = scene.visual;
        const base = 0.12 + (i / n) * 0.6;
        const step = 0.6 / n;
        const onProgress = (e) => {
            if (typeof e?.progress === 'number') progress(null, base + step * e.progress);
        };
        const prompt = [v.prompt, sb.defaults.style].filter(Boolean).join(', ');
        const negative = v.negative_prompt ?? sb.defaults.negative_prompt;

        if (v.type === 'color') {
            visuals.push({ kind: 'color' });
            continue;
        }
        if (v.type === 'file') {
            if (!v.path || !fs.existsSync(v.path)) throw new Error(`Cena ${i + 1}: arquivo não encontrado: ${v.path}`);
            const isImage = IMAGE_EXTENSIONS.has(path.extname(v.path).toLowerCase());
            visuals.push({ kind: isImage ? 'image' : 'video', path: v.path });
            continue;
        }
        if (!prompt) throw new Error(`Cena ${i + 1}: visual.prompt é obrigatório para type=${v.type}.`);

        let wantVideo = v.type === 'video';
        if (wantVideo && v.provider !== 'muapi') {
            wan2gp = wan2gp || await wan2gpStatus({ probe: true });
            if (!wan2gp.ok) {
                if (!sb.defaults.video_fallback_to_image) throw new Error(`Cena ${i + 1}: ${wan2gp.error}`);
                log(`Cena ${i + 1}: Wan2GP indisponível — usando imagem animada no lugar do clipe.`);
                report[i].fallback = 'imagem animada (Wan2GP indisponível)';
                wantVideo = false;
            }
        }

        if (wantVideo) {
            const params = {
                prompt,
                negative_prompt: negative,
                model: v.model || (v.provider === 'muapi' ? undefined : sb.defaults.video_model),
                provider: v.provider === 'muapi' ? 'muapi' : 'wan2gp',
                aspect_ratio: sb.format.aspect_ratio,
                duration_seconds: Math.min(10, plan.durations[i]),
                seed: v.seed,
                steps: v.steps,
                allow_paid: allowPaid,
            };
            const key = hash(params);
            const cached = fs.readdirSync(path.join(projectDir, 'visuals')).find((f) => f.startsWith(`scene-${pad(i)}-${key}.`));
            progress('visuais', base, `Clipe de vídeo da cena ${i + 1}/${n}`);
            const out = cached
                ? { path: path.join(projectDir, 'visuals', cached), engine: params.provider === 'muapi' ? 'muapi (PAGO)' : 'wan2gp (gratuito)', cached: true }
                : await generateClipAny({ ...params, outPath: path.join(projectDir, 'visuals', `scene-${pad(i)}-${key}.mp4`) }, { signal, onProgress });
            engines.add(`vídeo: ${out.engine}`);
            visuals.push({ kind: 'video', path: out.path });
            report[i].source = out.cached ? `${out.engine} — cache` : out.engine;
            continue;
        }

        const provider = v.provider === 'muapi' ? 'muapi' : v.provider === 'wan2gp' ? 'wan2gp' : 'local';
        const params = {
            prompt,
            negative_prompt: negative,
            model: v.model || (provider === 'local' ? sb.defaults.image_model : undefined),
            provider,
            aspect_ratio: sb.format.aspect_ratio,
            steps: v.steps ?? sb.defaults.steps,
            seed: v.seed ?? (1000 + i),
            fast: sb.defaults.fast,
            allow_paid: allowPaid,
        };
        const key = hash(params);
        const cached = fs.readdirSync(path.join(projectDir, 'visuals')).find((f) => f.startsWith(`scene-${pad(i)}-${key}.`));
        progress('visuais', base, `Imagem da cena ${i + 1}/${n}`);
        const out = cached
            ? { path: path.join(projectDir, 'visuals', cached), engine: { local: 'sd.cpp (local, gratuito)', wan2gp: 'wan2gp (gratuito)', muapi: 'muapi (PAGO)' }[provider], cached: true }
            : await generateImageAny({ ...params, outPath: path.join(projectDir, 'visuals', `scene-${pad(i)}-${key}.png`) }, { signal, onProgress });
        engines.add(`imagem: ${out.engine}${provider === 'local' ? ` — ${params.model}${params.fast ? ' + LCM' : ''}` : ''}`);
        visuals.push({ kind: 'image', path: out.path });
        report[i].source = out.cached ? `${out.engine} — cache` : out.engine;
    }

    // 4. Scene clips ─────────────────────────────────────────────────────────────
    const clips = [];
    for (let i = 0; i < n; i++) {
        progress('montagem das cenas', 0.72 + (i / n) * 0.12, `Renderizando cena ${i + 1}/${n}`);
        const scene = sb.scenes[i];
        const out = path.join(projectDir, 'clips', `scene-${pad(i)}.mp4`);
        const common = { projectDir, out, duration: plan.durations[i], width, height, fps, title: scene.title, index: i + 1, signal };
        const visual = visuals[i];
        if (visual.kind === 'color') {
            await renderColorScene({ ...common, color: scene.visual.color, title: scene.title || sb.title, subtitle: scene.visual.subtitle });
        } else if (visual.kind === 'video') {
            await renderVideoScene({ ...common, video: visual.path });
        } else {
            await renderImageScene({ ...common, image: visual.path, motion: pickMotion(scene.visual.motion || sb.defaults.motion, i) });
        }
        clips.push(out);
        report[i].seconds = plan.durations[i];
    }

    // 5. Subtitles ─────────────────────────────────────────────────────────────
    const portrait = height > width;
    const maxChars = sb.subtitles.max_chars || (portrait ? 26 : 42);
    const cues = [];
    for (let i = 0; i < n; i++) {
        if (!narration[i] || !sb.scenes[i].narration) continue;
        cues.push(...timeCues(splitCues(sb.scenes[i].narration, { maxChars }), plan.narrationStarts[i], narration[i].duration));
    }
    const srtName = `${name}.srt`;
    const hasSubs = sb.subtitles.enabled && cues.length > 0;
    if (hasSubs) fs.writeFileSync(path.join(projectDir, srtName), toSrt(cues), 'utf-8');

    // 6. Transitions + burned subtitles ─────────────────────────────────────────
    progress('transições e legendas', 0.86, 'Unindo cenas com transições');
    const silentVideo = path.join(projectDir, 'video-sem-audio.mp4');
    await assembleVideo({
        projectDir,
        clips,
        durations: plan.durations,
        transitions: plan.transitions,
        fps,
        out: silentVideo,
        subtitlesFile: hasSubs && sb.subtitles.burn ? srtName : null,
        style: subtitleStyle({ width, height, fontSize: sb.subtitles.font_size, position: sb.subtitles.position }),
        signal,
    });

    // 7. Audio mix ─────────────────────────────────────────────────────────────
    progress('áudio', 0.92, 'Mixando narração e música');
    let music = sb.music;
    if (music && !music.path && music.generate) {
        const seconds = Math.ceil(plan.total) + 1;
        const out = path.join(projectDir, `trilha-${music.mood}-${hash({ mood: music.mood, seconds })}.wav`);
        if (!fs.existsSync(out)) await generateMusic({ seconds, mood: music.mood, outPath: out, signal });
        engines.add(`música: trilha original gerada localmente (${music.mood})`);
        music = { ...music, path: out };
    }
    if (music?.path && !fs.existsSync(music.path)) throw new Error(`Música não encontrada: ${music.path}`);
    const audio = path.join(projectDir, 'audio.m4a');
    await mixAudio({
        projectDir,
        narrations: narration.map((r, i) => (r ? { path: r.path, start: plan.narrationStarts[i] } : null)).filter(Boolean),
        total: plan.total,
        music,
        out: audio,
        signal,
    });

    // 8. Final file ─────────────────────────────────────────────────────────────
    progress('finalizando', 0.97, 'Gerando arquivo final');
    const finalVideo = path.join(projectDir, `${name}.mp4`);
    await muxFinal({ projectDir, video: silentVideo, audio, out: finalVideo, signal });
    const thumbnail = await extractThumbnail({ video: finalVideo, out: path.join(projectDir, 'thumbnail.jpg'), at: Math.min(1.5, plan.total / 2) });
    const info = await probeMedia(finalVideo);
    fs.rmSync(silentVideo, { force: true });

    const result = {
        video: finalVideo,
        subtitles: hasSubs ? path.join(projectDir, srtName) : null,
        thumbnail,
        project_dir: projectDir,
        duration_seconds: Number(info.duration.toFixed(2)),
        resolution: `${info.width}x${info.height}`,
        fps,
        scenes: report,
        engines: [...engines],
        cost: paidScenes.length ? `PAGO: ${paidScenes.length} geração(ões) MuAPI` : 'R$ 0 — somente motores locais gratuitos',
        render_seconds: Math.round((Date.now() - started) / 1000),
    };
    fs.writeFileSync(path.join(projectDir, 'manifest.json'), JSON.stringify(result, null, 2));
    return result;
}
