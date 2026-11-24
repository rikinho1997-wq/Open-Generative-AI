// Free local image generation with stable-diffusion.cpp (sd-cli) — the same engine,
// catalog and model folder as the desktop app (electron/lib/localInference.js),
// driven headlessly. Runs on CPU everywhere; CUDA/Vulkan/Metal builds are faster.

import fs from 'node:fs';
import path from 'node:path';
import { repoModule, resolveBinaries, resolvePaths } from '../config.mjs';
import { downloadTo } from '../download.mjs';
import { run } from '../proc.mjs';

const catalog = () => repoModule('electron/lib/modelCatalog.js');
const runtime = () => repoModule('electron/lib/localInferenceRuntime.js');

export const DEFAULT_IMAGE_MODEL = 'dreamshaper-8';

// LCM-LoRA (OpenRAIL++) turns any SD 1.5 model into a 4–6 step, CFG-free sampler:
// roughly 6–8× faster on CPU, a little softer in detail.
export const LCM_LORA = {
    id: 'lcm-lora-sd15',
    name: 'LCM-LoRA SD 1.5 (modo rápido)',
    filename: 'lcm-lora-sdv1-5.safetensors',
    sizeGB: 0.13,
    downloadUrl: 'https://huggingface.co/latent-consistency/lcm-lora-sdv1-5/resolve/main/pytorch_lora_weights.safetensors',
};
export const DEFAULT_NEGATIVE = 'lowres, blurry, deformed, bad anatomy, extra fingers, watermark, text, signature, logo, jpeg artifacts';

export function lcmAvailable(paths = resolvePaths()) {
    return fs.existsSync(path.join(paths.modelsDir, LCM_LORA.filename));
}

// Mirrors arToDimensions() in electron/lib/localInference.js.
export function aspectToDimensions(aspectRatio, modelType) {
    const base = (modelType === 'sdxl' || modelType === 'z-image') ? 1024 : 512;
    const long = (ratio) => Math.round(base * ratio / 64) * 64;
    const map = {
        '1:1': [base, base],
        '16:9': [long(16 / 9), base],
        '9:16': [base, long(16 / 9)],
        '4:3': [long(4 / 3), base],
        '3:4': [base, long(4 / 3)],
    };
    return map[aspectRatio] || [base, base];
}

function modelFiles(model, paths) {
    const { ZIMAGE_AUXILIARY } = catalog();
    const files = [{ id: model.id, path: path.join(paths.modelsDir, model.filename), url: model.downloadUrl, sizeGB: model.sizeGB }];
    if (model.requiresAuxiliary) {
        for (const aux of Object.values(ZIMAGE_AUXILIARY)) {
            files.push({ id: aux.id, path: path.join(paths.modelsDir, aux.filename), url: aux.downloadUrl, sizeGB: aux.sizeGB });
        }
    }
    return files;
}

export function listImageModels(paths = resolvePaths()) {
    const { LOCAL_MODEL_CATALOG } = catalog();
    return LOCAL_MODEL_CATALOG.map((m) => {
        const files = modelFiles(m, paths);
        const missing = files.filter((f) => !fs.existsSync(f.path));
        return {
            id: m.id,
            name: m.name,
            type: m.type,
            description: m.description,
            license: 'open weights (see model card)',
            cost: 'gratuito (local)',
            downloadGB: Number(files.reduce((s, f) => s + (f.sizeGB || 0), 0).toFixed(2)),
            installed: missing.length === 0,
            missingFiles: missing.map((f) => path.basename(f.path)),
            defaultSteps: m.defaultSteps,
            aspectRatios: m.aspectRatios,
        };
    });
}

export function getImageModel(id) {
    const { LOCAL_MODEL_CATALOG } = catalog();
    return LOCAL_MODEL_CATALOG.find((m) => m.id === id) || null;
}

export async function downloadImageModel(id, { onProgress, signal } = {}) {
    if (id === LCM_LORA.id) {
        const dest = path.join(resolvePaths().modelsDir, LCM_LORA.filename);
        await downloadTo(LCM_LORA.downloadUrl, dest, { signal, onProgress: (p) => onProgress?.({ file: LCM_LORA.filename, progress: p }) });
        return { model: id, files: [dest] };
    }
    const model = getImageModel(id);
    if (!model) throw new Error(`Modelo local desconhecido: ${id}`);
    const paths = resolvePaths();
    const files = modelFiles(model, paths);
    for (let i = 0; i < files.length; i++) {
        const f = files[i];
        if (fs.existsSync(f.path)) continue;
        await downloadTo(f.url, f.path, {
            signal,
            onProgress: (p) => onProgress?.({ file: path.basename(f.path), progress: (i + p) / files.length }),
        });
    }
    return { model: id, files: files.map((f) => f.path) };
}

export function buildSdCliArgs({ model, modelsDir, prompt, negativePrompt, outPath, width, height, steps, cfgScale, seed, fast = false }) {
    const { ZIMAGE_AUXILIARY } = catalog();
    const modelPath = path.join(modelsDir, model.filename);
    // Z-Image GGUFs are standalone diffusion transformers (see localInference.js).
    const modelFlag = (model.type === 'z-image' || model.type === 'flux') ? '--diffusion-model' : '-m';
    const args = [
        modelFlag, modelPath,
        '-p', prompt,
        '-o', outPath,
        '--steps', String(steps),
        '-H', String(height),
        '-W', String(width),
        '--cfg-scale', String(cfgScale),
        '--seed', String(seed),
        '--sampling-method', fast ? 'lcm' : (model.sampler || 'euler_a'),
        '-v',
    ];
    if (fast) {
        args[3] = `${prompt} <lora:${path.basename(LCM_LORA.filename, '.safetensors')}:1>`;
        args.push('--lora-model-dir', modelsDir);
    }
    if (negativePrompt && !fast) args.push('-n', negativePrompt);
    if (model.type === 'z-image') {
        args.push('--llm', path.join(modelsDir, ZIMAGE_AUXILIARY.llm.filename));
        args.push('--vae', path.join(modelsDir, ZIMAGE_AUXILIARY.vae.filename));
        if (model.scheduler) args.push('--scheduler', model.scheduler);
    }
    return args;
}

export async function generateLocalImage({
    prompt,
    negative_prompt: negativePrompt,
    model: modelId = DEFAULT_IMAGE_MODEL,
    aspect_ratio: aspectRatio = '1:1',
    width,
    height,
    steps,
    guidance_scale: guidanceScale,
    seed,
    fast = false,
    outPath,
    onProgress,
    signal,
}) {
    if (!String(prompt || '').trim()) throw new Error('O prompt é obrigatório.');
    const paths = resolvePaths();
    const bins = resolveBinaries(process.env, paths);
    if (!bins.sdCli) {
        throw new Error('Motor sd.cpp (sd-cli) não instalado. Rode "node claude-agent/bin/oga.mjs setup" '
            + 'ou instale-o no app desktop (Settings → Local Models).');
    }
    const model = getImageModel(modelId);
    if (!model) throw new Error(`Modelo local desconhecido: ${modelId}. Use oga_list_models.`);
    const missing = modelFiles(model, paths).filter((f) => !fs.existsSync(f.path));
    if (missing.length) {
        throw new Error(`Modelo "${model.name}" não baixado (${missing.map((f) => path.basename(f.path)).join(', ')}). `
            + `Use oga_download_model com model="${model.id}".`);
    }

    const { resolveGenerationSteps, resolveGuidanceScale, parseGenerationProgressChunk } = runtime();
    let [w, h] = aspectToDimensions(aspectRatio, model.type);
    if (width && height) {
        w = Math.max(64, Math.round(width / 64) * 64);
        h = Math.max(64, Math.round(height / 64) * 64);
    }
    // Fast mode only applies to SD 1.5 checkpoints and needs the LCM-LoRA file.
    const useFast = Boolean(fast) && model.type === 'sd1' && lcmAvailable(paths);
    const finalSteps = useFast ? (steps || 5) : resolveGenerationSteps({ steps }, model);
    const cfgScale = useFast ? 1 : resolveGuidanceScale({ guidance_scale: guidanceScale }, model);
    const finalSeed = Number.isInteger(seed) && seed >= 0 ? seed : Math.floor(Math.random() * 2147483647);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });

    const args = buildSdCliArgs({
        model,
        modelsDir: paths.modelsDir,
        prompt: String(prompt),
        negativePrompt: negativePrompt ?? DEFAULT_NEGATIVE,
        outPath,
        width: w,
        height: h,
        steps: finalSteps,
        cfgScale,
        seed: finalSeed,
        fast: useFast,
    });
    const progressState = { tail: '', lastStep: 0, lastTotalSteps: 0 };
    const started = Date.now();
    await run(bins.sdCli, args, {
        signal,
        env: { ...process.env, LD_LIBRARY_PATH: path.dirname(bins.sdCli), DYLD_LIBRARY_PATH: path.dirname(bins.sdCli) },
        onOutput: (chunk) => {
            for (const event of parseGenerationProgressChunk(chunk, progressState)) onProgress?.(event);
        },
    });
    if (!fs.existsSync(outPath)) throw new Error('sd-cli terminou mas não gerou a imagem.');
    return {
        path: outPath,
        model: model.id,
        width: w,
        height: h,
        steps: finalSteps,
        seed: finalSeed,
        fast: useFast,
        seconds: Math.round((Date.now() - started) / 1000),
        engine: 'sd.cpp (local, gratuito)',
    };
}
