// Free local AI video with Wan2GP (https://github.com/deepbeepmeep/Wan2GP):
// Wan 2.1/2.2, Hunyuan Video 1.5, LTX-2, plus Flux / Qwen-Image.
// Needs an NVIDIA (CUDA) or AMD (ROCm) GPU on the machine that runs Wan2GP.
//
// Reuses the desktop app's pure modules (electron/lib/wan2gp*.js) and its config
// file, so whatever is set in Settings → Local Models → Wan2GP works here too:
//   local  — the Wan2GP folder on this machine (runs `wgp.py --process`)
//   remote — WanGP's MCP server on another machine (e.g. your Windows gaming PC)
// Env overrides: OGA_WAN2GP_DIR, OGA_WAN2GP_PYTHON, OGA_WAN2GP_URL.

import fs from 'node:fs';
import path from 'node:path';
import { repoModule, resolvePaths } from '../config.mjs';

const catalogModule = () => repoModule('electron/lib/wan2gpCatalog.js');
const localModule = () => repoModule('electron/lib/wan2gpLocal.js');
const mcpModule = () => repoModule('electron/lib/wan2gpMcp.js');

export const DEFAULT_VIDEO_MODEL = 'wan2gp:wan21-t2v-1.3b';

// Native frame rate per family, used to turn seconds into a frame count.
const FAMILY_FPS = { wan: 16, hunyuan: 24, ltx: 24 };

export function readWan2gpConfig(env = process.env, paths = resolvePaths(env)) {
    let fileCfg = {};
    try { fileCfg = JSON.parse(fs.readFileSync(paths.wan2gpConfigFile, 'utf-8')); } catch { /* not configured */ }
    return {
        dir: (env.OGA_WAN2GP_DIR || fileCfg.dir || '').trim(),
        python: (env.OGA_WAN2GP_PYTHON || fileCfg.python || '').trim(),
        url: (env.OGA_WAN2GP_URL || fileCfg.url || '').trim().replace(/\/+$/, ''),
    };
}

export function writeWan2gpConfig(cfg, paths = resolvePaths()) {
    const current = readWan2gpConfig({}, paths);
    const next = {
        dir: (cfg.dir ?? current.dir ?? '').trim(),
        python: (cfg.python ?? current.python ?? '').trim(),
        url: (cfg.url ?? current.url ?? '').trim().replace(/\/+$/, ''),
    };
    fs.mkdirSync(path.dirname(paths.wan2gpConfigFile), { recursive: true });
    fs.writeFileSync(paths.wan2gpConfigFile, JSON.stringify(next, null, 2));
    return next;
}

export function wan2gpMode(cfg) {
    if (cfg.dir) return 'local';
    if (cfg.url) return 'remote';
    return null;
}

export function framesForSeconds(model, seconds) {
    const fps = FAMILY_FPS[model.family] || 16;
    const raw = Math.max(1, Math.round(seconds * fps));
    if (model.family === 'ltx') return Math.floor(raw / 8) * 8 + 1; // LTX wants 8k+1
    return Math.floor(raw / 4) * 4 + 1; // Wan/Hunyuan want 4k+1
}

export async function wan2gpStatus({ probe = true } = {}) {
    const cfg = readWan2gpConfig();
    const mode = wan2gpMode(cfg);
    if (!mode) {
        return { ok: false, mode: null, error: 'Wan2GP não configurado (precisa de GPU NVIDIA/AMD). Use oga_configure_wan2gp.' };
    }
    if (mode === 'local') {
        const local = localModule();
        const install = local.resolveInstall(cfg);
        const check = local.checkInstall(install);
        return check.ok ? { ok: true, mode, dir: cfg.dir } : { ok: false, mode, error: check.error };
    }
    if (!probe) return { ok: true, mode, url: cfg.url, note: 'não verificado' };
    try {
        const info = await mcpModule().createMcpClient(cfg.url).probe();
        return { ok: true, mode, url: cfg.url, server: `${info.server} ${info.version}` };
    } catch (err) {
        return { ok: false, mode, url: cfg.url, error: `Servidor MCP do Wan2GP inacessível: ${err.message}` };
    }
}

export function listVideoModels() {
    const { WAN2GP_CATALOG } = catalogModule();
    return WAN2GP_CATALOG.map((m) => ({
        id: m.id,
        name: m.name,
        type: m.type,
        description: m.description,
        needsImage: Boolean(m.needsImage),
        cost: 'gratuito (local, requer GPU)',
        engine: 'wan2gp',
    }));
}

// Generates one clip (or image for the Flux/Qwen entries). Resolves { path, seed }.
export async function generateWan2gp({
    prompt,
    negative_prompt: negativePrompt,
    model: modelId = DEFAULT_VIDEO_MODEL,
    aspect_ratio: aspectRatio = '16:9',
    duration_seconds: durationSeconds,
    steps,
    seed,
    image_path: imagePath,
    outPath,
    onProgress,
    signal,
}) {
    const { getModelById, buildWan2gpSettings } = catalogModule();
    const model = getModelById(modelId);
    if (!model) throw new Error(`Modelo Wan2GP desconhecido: ${modelId}`);
    const cfg = readWan2gpConfig();
    const mode = wan2gpMode(cfg);
    if (!mode) throw new Error('Wan2GP não configurado. Configure a pasta local ou a URL do servidor MCP (oga_configure_wan2gp).');

    const params = { prompt, negative_prompt: negativePrompt, aspect_ratio: aspectRatio, steps, seed };
    if (model.type === 'video' && durationSeconds) params.video_length = framesForSeconds(model, durationSeconds);
    const paths = resolvePaths();
    const runDir = path.join(paths.wan2gpWorkDir, 'runs', `${Date.now()}`);
    fs.mkdirSync(runDir, { recursive: true });
    fs.mkdirSync(path.dirname(outPath), { recursive: true });

    if (mode === 'local') {
        const local = localModule();
        const install = local.resolveInstall(cfg);
        const check = local.checkInstall(install);
        if (!check.ok) throw new Error(check.error);
        const settings = buildWan2gpSettings(model, params, { imageStart: imagePath });
        const { child, done } = local.runGeneration({ install, settings, runDir, onProgress });
        const onAbort = () => local.killTree(child);
        signal?.addEventListener?.('abort', onAbort, { once: true });
        try {
            const mediaPath = await done;
            const finalPath = outPath.replace(/\.[^.]+$/, path.extname(mediaPath));
            fs.copyFileSync(mediaPath, finalPath);
            return { path: finalPath, seed: settings.seed, model: model.id, engine: 'wan2gp local (gratuito)' };
        } finally {
            signal?.removeEventListener?.('abort', onAbort);
        }
    }

    const client = mcpModule().createMcpClient(cfg.url);
    const imageStart = imagePath
        ? await client.uploadImage({ name: path.basename(imagePath), bytes: fs.readFileSync(imagePath) })
        : undefined;
    const settings = buildWan2gpSettings(model, params, { imageStart });
    let jobId = null;
    const onAbort = () => client.cancel(jobId).catch(() => {});
    signal?.addEventListener?.('abort', onAbort, { once: true });
    try {
        const item = await client.generate(settings, { onProgress, onJobId: (id) => { jobId = id; }, signal });
        const { filename, bytes } = await client.download(item.media_id);
        const ext = path.extname(filename || '') || '.mp4';
        const finalPath = outPath.replace(/\.[^.]+$/, ext);
        fs.writeFileSync(finalPath, bytes);
        return { path: finalPath, seed: settings.seed, model: model.id, engine: 'wan2gp remoto via MCP (gratuito)' };
    } finally {
        signal?.removeEventListener?.('abort', onAbort);
    }
}
