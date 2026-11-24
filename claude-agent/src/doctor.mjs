// Environment report: what works right now, what still needs setup.

import fs from 'node:fs';
import { IS_WINDOWS, MAX_VIDEO_SECONDS, paidPolicy, resolveBinaries, resolvePaths, which } from './config.mjs';
import { lcmAvailable, listImageModels } from './engines/sdcpp.mjs';
import { listVideoModels, wan2gpStatus } from './engines/wan2gp.mjs';
import { availableTtsEngines } from './tts.mjs';

export async function doctor({ probeWan2gp = true } = {}) {
    const paths = resolvePaths();
    const bins = resolveBinaries(process.env, paths);
    const images = listImageModels(paths);
    const tts = availableTtsEngines();
    const wan = await wan2gpStatus({ probe: probeWan2gp });
    const paid = paidPolicy();
    const gpu = which('nvidia-smi') ? 'NVIDIA detectada (nvidia-smi)' : 'nenhuma GPU NVIDIA detectada';
    const installedImages = images.filter((m) => m.installed).map((m) => m.id);

    const capabilities = {
        montagem_de_video_ffmpeg: Boolean(bins.ffmpeg && bins.ffprobe),
        imagem_local_gratuita: Boolean(bins.sdCli) && installedImages.length > 0,
        modo_rapido_lcm: lcmAvailable(paths),
        narracao_gratuita: tts.piper || tts.sapi || tts.espeak,
        narracao_neural_piper: tts.piper,
        legendas: Boolean(bins.ffmpeg),
        video_ia_local_wan2gp: wan.ok,
        api_paga_muapi: paid.enabled ? 'habilitada pelo usuário (cada chamada ainda exige allow_paid)' : 'bloqueada (padrão)',
    };
    const todo = [];
    if (!capabilities.montagem_de_video_ffmpeg) todo.push(IS_WINDOWS ? 'Instale o FFmpeg: winget install Gyan.FFmpeg' : 'Instale o FFmpeg (apt install ffmpeg / brew install ffmpeg)');
    if (!bins.sdCli) todo.push('Instale o motor sd.cpp: node claude-agent/bin/oga.mjs setup');
    if (!installedImages.length) todo.push('Baixe um modelo de imagem: oga_download_model model="dreamshaper-8"');
    if (!capabilities.modo_rapido_lcm) todo.push('Opcional (CPU): oga_download_model model="lcm-lora-sd15" para o modo rápido');
    if (!tts.piper) todo.push('Para narração natural: node claude-agent/bin/oga.mjs setup (instala Piper + voz pt_BR-faber-medium)');
    if (!wan.ok) todo.push('Vídeo IA (opcional, requer GPU NVIDIA/AMD): instale o Wan2GP e use oga_configure_wan2gp');

    return {
        platform: `${process.platform}-${process.arch}, Node ${process.version}`,
        gpu,
        capabilities,
        binaries: bins,
        image_models_installed: installedImages,
        tts,
        wan2gp: wan,
        paid_policy: {
            muapi_key_in_env: paid.keySet,
            OGA_ALLOW_PAID: paid.envAllowed,
            note: 'Chamadas pagas exigem MUAPI_API_KEY + OGA_ALLOW_PAID=1 + allow_paid:true na chamada.',
        },
        paths: {
            models: paths.modelsDir,
            voices: paths.voicesDir,
            outputs: paths.outputDir,
            outputs_exists: fs.existsSync(paths.outputDir),
        },
        max_video_seconds: MAX_VIDEO_SECONDS,
        free_video_models: listVideoModels().filter((m) => m.type === 'video').map((m) => m.id),
        todo,
    };
}
