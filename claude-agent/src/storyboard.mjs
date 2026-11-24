// Storyboard format for multi-scene narrated videos, and the timeline maths.
//
// Each scene shows one visual (AI image with a Ken Burns move, AI video clip,
// your own file, or a title card) while its narration plays. Scene length is
// driven by the narration audio, so the video is always in sync.

import { z } from 'zod';
import { MAX_VIDEO_SECONDS } from './config.mjs';
import { MOTIONS, TRANSITIONS, totalDuration, clipStarts } from './media.mjs';

export const LEAD_IN = 0.35; // silence before a scene's narration starts
export const TAIL = 0.45; // breathing room after it ends
export const MIN_SCENE = 2.5;
export const CUT_DURATION = 0.04; // a "cut" is a one-frame fade
// Average speaking rate of the pt-BR Piper voices (characters per second).
export const CHARS_PER_SECOND = 14.5;

const Transition = z.enum(TRANSITIONS);

export const VisualSchema = z.object({
    type: z.enum(['image', 'video', 'file', 'color']).default('image')
        .describe('image = imagem IA animada (Ken Burns); video = clipe IA (Wan2GP, requer GPU); file = arquivo seu; color = cartela de título'),
    prompt: z.string().max(2000).optional().describe('Descrição visual em INGLÊS (os modelos entendem melhor). Sem texto escrito na imagem.'),
    negative_prompt: z.string().max(1000).optional(),
    path: z.string().optional().describe('Para type=file: caminho de imagem ou vídeo local'),
    color: z.string().optional().describe('Para type=color: ex. "#101828"'),
    subtitle: z.string().max(160).optional().describe('Para type=color: linha menor abaixo do título'),
    provider: z.enum(['local', 'wan2gp', 'muapi']).optional()
        .describe('local (sd.cpp, grátis) é o padrão para imagem; wan2gp (grátis, GPU) para vídeo; muapi é PAGO'),
    model: z.string().optional(),
    seed: z.number().int().min(0).optional(),
    steps: z.number().int().min(1).max(100).optional(),
    motion: z.enum([...MOTIONS, 'auto']).optional(),
});

export const SceneSchema = z.object({
    narration: z.string().max(1500).optional().describe('Texto falado nesta cena (também vira legenda)'),
    visual: VisualSchema,
    duration: z.number().min(1).max(60).optional().describe('Duração mínima em segundos; a narração pode alongar a cena'),
    title: z.string().max(140).optional().describe('Texto sobreposto no topo da cena'),
    transition: Transition.optional().describe('Transição PARA a próxima cena'),
    transition_duration: z.number().min(0).max(2).optional(),
});

export const StoryboardSchema = z.object({
    title: z.string().min(1).max(140),
    output_name: z.string().regex(/^[A-Za-z0-9_-]{1,60}$/).optional()
        .describe('Nome da pasta/arquivo de saída. Reusar o mesmo nome reaproveita imagens e áudios já gerados.'),
    language: z.string().default('pt-BR'),
    format: z.object({
        aspect_ratio: z.enum(['16:9', '9:16', '1:1']).default('16:9'),
        resolution: z.enum(['480p', '720p', '1080p']).default('720p'),
        fps: z.number().int().min(12).max(60).default(30),
    }).default({}),
    voice: z.object({
        engine: z.enum(['auto', 'piper', 'sapi', 'espeak', 'none']).default('auto'),
        voice: z.string().optional().describe('Ex.: pt_BR-faber-medium, pt_BR-cadu-medium'),
        speed: z.number().min(0.5).max(2).default(1),
    }).default({}),
    subtitles: z.object({
        enabled: z.boolean().default(true),
        burn: z.boolean().default(true).describe('Gravar a legenda na imagem (além do .srt separado)'),
        max_chars: z.number().int().min(16).max(60).optional(),
        font_size: z.number().min(6).max(40).optional(),
        position: z.enum(['bottom', 'top']).default('bottom'),
    }).default({}),
    music: z.object({
        path: z.string().describe('Arquivo de música local (mp3/wav/m4a). Use só músicas com licença livre.'),
        volume: z.number().min(0).max(1).default(0.18),
        duck: z.boolean().default(true).describe('Abaixar a música enquanto há narração'),
    }).optional(),
    defaults: z.object({
        transition: Transition.default('fade'),
        transition_duration: z.number().min(0).max(2).default(0.6),
        image_model: z.string().default('dreamshaper-8'),
        video_model: z.string().default('wan2gp:wan21-t2v-1.3b'),
        style: z.string().max(400).optional().describe('Sufixo de estilo aplicado a todos os prompts (ex.: "cinematic lighting, 35mm")'),
        negative_prompt: z.string().max(1000).optional(),
        motion: z.enum([...MOTIONS, 'auto']).default('auto'),
        fast: z.boolean().default(true).describe('LCM: 5 passos em vez de 20 (muito mais rápido em CPU)'),
        steps: z.number().int().min(1).max(100).optional(),
        video_fallback_to_image: z.boolean().default(true)
            .describe('Se o Wan2GP não estiver disponível, gerar imagem animada no lugar do clipe'),
    }).default({}),
    scenes: z.array(SceneSchema).min(1).max(40),
});

export function parseStoryboard(input) {
    const parsed = StoryboardSchema.safeParse(input);
    if (!parsed.success) {
        const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(raiz)'}: ${i.message}`).join('; ');
        throw new Error(`Roteiro inválido: ${issues}`);
    }
    return parsed.data;
}

export function estimateNarrationSeconds(text, speed = 1) {
    const chars = String(text || '').replace(/\s+/g, ' ').trim().length;
    return chars ? chars / CHARS_PER_SECOND / speed + 0.4 : 0;
}

export function slugify(text) {
    const slug = String(text || 'video')
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
        .slice(0, 50);
    return slug || 'video';
}

// narrationSeconds[i] is the narration audio length of scene i (0 when silent).
export function planTimeline(storyboard, narrationSeconds) {
    const scenes = storyboard.scenes;
    const n = scenes.length;
    const transitions = [];
    for (let i = 0; i < n - 1; i++) {
        const type = scenes[i].transition || storyboard.defaults.transition;
        const requested = scenes[i].transition_duration ?? storyboard.defaults.transition_duration;
        transitions.push({ type, duration: type === 'cut' || requested <= 0 ? CUT_DURATION : Math.min(1.5, requested) });
    }
    const durations = scenes.map((scene, i) => {
        const tIn = i > 0 ? transitions[i - 1].duration : 0;
        const tOut = i < n - 1 ? transitions[i].duration : 0;
        const narr = narrationSeconds[i] || 0;
        const needed = narr > 0 ? LEAD_IN + narr + TAIL + tOut : MIN_SCENE;
        return Number(Math.max(scene.duration || 0, needed, MIN_SCENE, tIn + tOut + 0.5).toFixed(3));
    });
    const starts = clipStarts(durations, transitions.map((t) => t.duration));
    const total = totalDuration(durations, transitions.map((t) => t.duration));
    return {
        durations,
        transitions,
        starts,
        narrationStarts: starts.map((s) => s + LEAD_IN),
        total: Number(total.toFixed(3)),
        maxSeconds: MAX_VIDEO_SECONDS,
        withinLimit: total <= MAX_VIDEO_SECONDS + 0.05,
    };
}

export function limitError(plan) {
    const perScene = plan.durations.map((d, i) => `cena ${i + 1}: ${d.toFixed(1)} s`).join(', ');
    return new Error(`O vídeo teria ${plan.total.toFixed(1)} s, acima do limite de ${plan.maxSeconds} s. `
        + `Encurte a narração ou remova cenas (${perScene}).`);
}
