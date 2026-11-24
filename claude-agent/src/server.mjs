#!/usr/bin/env node
// MCP server (stdio) that lets Claude drive Open Generative AI:
// images, narration, AI video clips and complete narrated multi-scene videos.
//
//   claude mcp add open-generative-ai -- node claude-agent/src/server.mjs
// (the repo's .mcp.json registers it automatically for Claude Code)

import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { pathToFileURL } from 'node:url';
import { MAX_VIDEO_SECONDS, REPO_ROOT, assertPaidAllowed, ensureDir, resolvePaths } from './config.mjs';
import { doctor } from './doctor.mjs';
import { LCM_LORA, downloadImageModel, getImageModel, lcmAvailable, listImageModels } from './engines/sdcpp.mjs';
import { listVideoModels, wan2gpStatus, writeWan2gpConfig } from './engines/wan2gp.mjs';
import { cancelJob, listJobs, startJob, waitForJob } from './jobs.mjs';
import { previewBase64 } from './media.mjs';
import { dryRun, generateClipAny, generateImageAny, produceVideo } from './producer.mjs';
import { StoryboardSchema, slugify } from './storyboard.mjs';
import { RECOMMENDED_VOICES, availableTtsEngines, downloadPiperVoice, listPiperVoices, synthesize } from './tts.mjs';

// stdout carries the MCP protocol; anything a dependency logs must go to stderr.
console.log = (...args) => console.error(...args);

const DEFAULT_WAIT = 45;
const MAX_WAIT = 300;

const INSTRUCTIONS = `Open Generative AI — geração de imagens, narração e vídeos.
Regras:
1. Priorize SEMPRE os motores locais gratuitos (provider "local" para imagem, "wan2gp" para vídeo, Piper/espeak para voz).
2. NUNCA use provider "muapi" (pago) nem allow_paid:true sem o usuário autorizar explicitamente naquela conversa.
3. Vídeos finais têm no máximo ${MAX_VIDEO_SECONDS} s. Use oga_produce_video com dry_run:true para conferir a duração antes de gerar.
4. Escreva prompts visuais em inglês, sem pedir texto escrito na imagem; títulos vão no campo "title" da cena.
5. Tarefas longas retornam job_id: acompanhe com oga_job_status (wait_seconds até ${MAX_WAIT}).
6. Comece com oga_doctor para saber o que está instalado.`;

const server = new McpServer(
    { name: 'open-generative-ai', version: '1.0.0' },
    { instructions: INSTRUCTIONS },
);

function text(data) {
    return { type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) };
}

function errorResult(err) {
    return { content: [text(`Erro: ${err?.message || err}`)], isError: true };
}

async function withPreview(view, file) {
    const content = [text(view)];
    if (view.status === 'done' && file) {
        try {
            content.push({ type: 'image', data: await previewBase64(file), mimeType: 'image/jpeg' });
        } catch { /* preview is best-effort */ }
    }
    return { content };
}

function outputFile(kind, name, ext) {
    const dir = ensureDir(path.join(resolvePaths().outputDir, kind));
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
    return path.join(dir, `${stamp}-${slugify(name).slice(0, 40)}.${ext}`);
}

const waitSchema = z.number().min(0).max(MAX_WAIT).optional()
    .describe(`Quanto esperar (s) antes de devolver o job_id; padrão ${DEFAULT_WAIT}`);

// ─── Tools ─────────────────────────────────────────────────────────────────

server.registerTool('oga_doctor', {
    title: 'Diagnóstico',
    description: 'Mostra o que está instalado e operacional (ffmpeg, sd.cpp, modelos, vozes, Wan2GP, política de API paga) e o que falta configurar.',
    inputSchema: {},
    annotations: { readOnlyHint: true },
}, async () => {
    try {
        return { content: [text(await doctor())] };
    } catch (err) {
        return errorResult(err);
    }
});

server.registerTool('oga_list_models', {
    title: 'Listar modelos',
    description: 'Lista modelos gratuitos locais de imagem (sd.cpp), vídeo (Wan2GP) e vozes (Piper). Com include_paid lista também o catálogo PAGO da MuAPI (só para referência).',
    inputSchema: {
        kind: z.enum(['all', 'image', 'video', 'voice']).default('all'),
        include_paid: z.boolean().default(false),
    },
    annotations: { readOnlyHint: true },
}, async ({ kind, include_paid: includePaid }) => {
    try {
        const out = {};
        if (kind === 'all' || kind === 'image') {
            out.image_local_free = listImageModels();
            out.image_addons = [{ id: LCM_LORA.id, name: LCM_LORA.name, installed: lcmAvailable(), downloadGB: LCM_LORA.sizeGB }];
        }
        if (kind === 'all' || kind === 'video') {
            out.video_local_free = { engine: await wan2gpStatus({ probe: false }), models: listVideoModels() };
        }
        if (kind === 'all' || kind === 'voice') {
            out.voices = { engines: availableTtsEngines(), installed: listPiperVoices().map((v) => v.id), recommended_pt_BR: RECOMMENDED_VOICES };
        }
        if (includePaid) {
            const studio = await import(pathToFileURL(path.join(REPO_ROOT, 'packages/studio/src/models.js')).href);
            const sample = (list) => list.slice(0, 25).map((m) => m.id);
            out.paid_muapi = {
                warning: 'PAGO por geração. Exige MUAPI_API_KEY + OGA_ALLOW_PAID=1 + allow_paid:true e autorização do usuário.',
                counts: { text_to_image: studio.t2iModels.length, text_to_video: studio.t2vModels.length, image_to_video: studio.i2vModels.length },
                text_to_image_sample: sample(studio.t2iModels),
                text_to_video_sample: sample(studio.t2vModels),
            };
        }
        return { content: [text(out)] };
    } catch (err) {
        return errorResult(err);
    }
});

server.registerTool('oga_download_model', {
    title: 'Baixar modelo gratuito',
    description: `Baixa um modelo/voz gratuito: id do catálogo de imagem (ex. "dreamshaper-8", "z-image-turbo"), "${LCM_LORA.id}" (modo rápido) ou voz Piper (ex. "pt_BR-faber-medium").`,
    inputSchema: { model: z.string(), wait_seconds: waitSchema },
}, async ({ model, wait_seconds: wait = DEFAULT_WAIT }) => {
    try {
        const isVoice = /^[a-z]{2,3}_[A-Z]{2}-/.test(model);
        if (!isVoice && model !== LCM_LORA.id && !getImageModel(model)) {
            throw new Error(`Modelo desconhecido: ${model}. Veja oga_list_models.`);
        }
        const job = startJob('download', `Download de ${model}`, async ({ signal, progress }) => {
            if (isVoice) return downloadPiperVoice(model, { signal });
            return downloadImageModel(model, { signal, onProgress: (p) => progress('baixando', p.progress, p.file) });
        });
        return { content: [text(await waitForJob(job.id, wait))] };
    } catch (err) {
        return errorResult(err);
    }
});

server.registerTool('oga_generate_image', {
    title: 'Gerar imagem',
    description: 'Gera uma imagem. Padrão: sd.cpp local e gratuito (CPU ~1 min no modo rápido). provider "muapi" é PAGO e exige autorização explícita do usuário.',
    inputSchema: {
        prompt: z.string().min(1).describe('Descrição em inglês'),
        negative_prompt: z.string().optional(),
        provider: z.enum(['local', 'wan2gp', 'muapi']).default('local'),
        model: z.string().optional().describe('local: dreamshaper-8, realistic-vision-v51, anything-v5, stable-diffusion-xl-base, z-image-turbo…'),
        aspect_ratio: z.enum(['1:1', '16:9', '9:16', '4:3', '3:4']).default('1:1'),
        steps: z.number().int().min(1).max(100).optional(),
        seed: z.number().int().min(0).optional(),
        fast: z.boolean().default(true).describe('Modo rápido LCM (modelos SD 1.5)'),
        allow_paid: z.boolean().default(false).describe('Somente com autorização explícita do usuário'),
        filename: z.string().optional(),
        wait_seconds: waitSchema,
    },
}, async (args) => {
    try {
        if (args.provider === 'muapi') assertPaidAllowed(args.allow_paid);
        const outPath = outputFile('images', args.filename || args.prompt, 'png');
        const job = startJob('image', `Imagem: ${args.prompt.slice(0, 60)}`, ({ signal, progress }) =>
            generateImageAny({ ...args, outPath }, { signal, onProgress: (e) => progress('gerando', e.progress) }));
        const view = await waitForJob(job.id, args.wait_seconds ?? DEFAULT_WAIT);
        return withPreview(view, view.result?.path);
    } catch (err) {
        return errorResult(err);
    }
});

server.registerTool('oga_generate_video_clip', {
    title: 'Gerar clipe de vídeo IA',
    description: 'Gera um clipe curto (até 10 s) com Wan2GP local/remoto — gratuito, requer GPU NVIDIA/AMD. provider "muapi" é PAGO e exige autorização explícita.',
    inputSchema: {
        prompt: z.string().min(1),
        negative_prompt: z.string().optional(),
        provider: z.enum(['wan2gp', 'muapi']).default('wan2gp'),
        model: z.string().optional().describe('wan2gp:wan21-t2v-1.3b (leve), wan2gp:wan22-t2v, wan2gp:wan22-i2v, wan2gp:ltx-video, wan2gp:hunyuan-video'),
        aspect_ratio: z.enum(['16:9', '9:16', '1:1']).default('16:9'),
        duration_seconds: z.number().min(1).max(10).default(5),
        image_path: z.string().optional().describe('Quadro inicial para image-to-video (wan2gp)'),
        image_url: z.string().optional().describe('Quadro inicial http(s) para image-to-video pago'),
        seed: z.number().int().min(0).optional(),
        steps: z.number().int().min(1).max(100).optional(),
        allow_paid: z.boolean().default(false),
        filename: z.string().optional(),
        wait_seconds: waitSchema,
    },
}, async (args) => {
    try {
        if (args.provider === 'muapi') assertPaidAllowed(args.allow_paid);
        else {
            const status = await wan2gpStatus({ probe: true });
            if (!status.ok) throw new Error(`${status.error} Sem GPU, use oga_produce_video com cenas type="image" (imagem animada).`);
        }
        const outPath = outputFile('clips', args.filename || args.prompt, 'mp4');
        const job = startJob('clip', `Clipe: ${args.prompt.slice(0, 60)}`, ({ signal, progress }) =>
            generateClipAny({ ...args, outPath }, { signal, onProgress: (e) => progress(e.status || 'gerando', e.progress) }));
        const view = await waitForJob(job.id, args.wait_seconds ?? DEFAULT_WAIT);
        return withPreview(view, view.result?.path);
    } catch (err) {
        return errorResult(err);
    }
});

server.registerTool('oga_text_to_speech', {
    title: 'Narração (TTS)',
    description: 'Gera narração WAV gratuita e offline (Piper neural pt-BR; SAPI no Windows; eSpeak NG).',
    inputSchema: {
        text: z.string().min(1).max(5000),
        voice: z.string().optional().describe('Ex.: pt_BR-faber-medium, pt_BR-cadu-medium'),
        engine: z.enum(['auto', 'piper', 'sapi', 'espeak']).default('auto'),
        speed: z.number().min(0.5).max(2).default(1),
        language: z.string().default('pt-BR'),
        filename: z.string().optional(),
    },
}, async (args) => {
    try {
        const outPath = outputFile('audio', args.filename || args.text, 'wav');
        const result = await synthesize({ ...args, outPath });
        return { content: [text(result)] };
    } catch (err) {
        return errorResult(err);
    }
});

server.registerTool('oga_produce_video', {
    title: 'Produzir vídeo completo',
    description: `Produz um vídeo de várias cenas (até ${MAX_VIDEO_SECONDS} s) com narração, legendas, transições e trilha opcional, a partir de um roteiro. `
        + 'Cada cena: narration (texto falado) + visual (image | video | file | color). Use dry_run:true primeiro para validar e estimar a duração. '
        + 'Reusar o mesmo output_name reaproveita o que já foi gerado.',
    inputSchema: {
        storyboard: StoryboardSchema,
        dry_run: z.boolean().default(false),
        allow_paid: z.boolean().default(false).describe('Somente com autorização explícita do usuário'),
        wait_seconds: waitSchema,
    },
}, async ({ storyboard, dry_run: isDry, allow_paid: allowPaid, wait_seconds: wait = DEFAULT_WAIT }) => {
    try {
        if (isDry) return { content: [text(dryRun(storyboard))] };
        const job = startJob('video', `Vídeo: ${storyboard.title}`, ({ signal, progress, log }) =>
            produceVideo(storyboard, { allowPaid, signal, progress, log }));
        const view = await waitForJob(job.id, wait);
        return withPreview(view, view.result?.thumbnail);
    } catch (err) {
        return errorResult(err);
    }
});

server.registerTool('oga_job_status', {
    title: 'Status de tarefa',
    description: 'Consulta uma tarefa (job_id) esperando até wait_seconds pela conclusão, ou lista todas.',
    inputSchema: { job_id: z.string().optional(), wait_seconds: waitSchema },
    annotations: { readOnlyHint: true },
}, async ({ job_id: id, wait_seconds: wait = DEFAULT_WAIT }) => {
    try {
        if (!id) return { content: [text(listJobs())] };
        const view = await waitForJob(id, wait);
        if (!view) throw new Error(`Tarefa não encontrada: ${id} (o servidor pode ter sido reiniciado).`);
        const preview = view.result?.thumbnail || (/\.(png|jpe?g|webp)$/i.test(view.result?.path || '') ? view.result.path : null)
            || (/\.(mp4|webm|mov|mkv)$/i.test(view.result?.path || '') ? view.result.path : null);
        return withPreview(view, preview);
    } catch (err) {
        return errorResult(err);
    }
});

server.registerTool('oga_cancel_job', {
    title: 'Cancelar tarefa',
    description: 'Cancela uma tarefa em fila ou em execução.',
    inputSchema: { job_id: z.string() },
    annotations: { destructiveHint: true },
}, async ({ job_id: id }) => {
    const view = cancelJob(id);
    return view ? { content: [text(view)] } : errorResult(`Tarefa não encontrada: ${id}`);
});

server.registerTool('oga_configure_wan2gp', {
    title: 'Configurar Wan2GP',
    description: 'Configura o motor de vídeo gratuito Wan2GP: pasta local (dir) ou URL do servidor MCP do Wan2GP em outra máquina (url, ex. http://192.168.0.10:7866/mcp). Mesma configuração do app desktop.',
    inputSchema: {
        dir: z.string().optional(),
        python: z.string().optional(),
        url: z.string().optional(),
    },
}, async (args) => {
    try {
        const config = writeWan2gpConfig(args);
        return { content: [text({ config, status: await wan2gpStatus({ probe: true }) })] };
    } catch (err) {
        return errorResult(err);
    }
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('[open-generative-ai] MCP server pronto (stdio)');
