// Free, offline narration (text-to-speech). Engines, best first:
//   piper  — neural, open source (MIT), natural pt-BR voices (faber, cadu, jeff)
//   sapi   — Windows' built-in voices (e.g. "Microsoft Maria" pt-BR), Windows only
//   espeak — eSpeak NG, open source, robotic but available everywhere
//   none   — silence (video without narration)

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { IS_WINDOWS, resolveBinaries, resolvePaths } from './config.mjs';
import { downloadTo } from './download.mjs';
import { run } from './proc.mjs';
import { probeDuration } from './media.mjs';

export const DEFAULT_LANGUAGE = 'pt-BR';
export const RECOMMENDED_VOICES = ['pt_BR-faber-medium', 'pt_BR-cadu-medium', 'pt_BR-jeff-medium'];

export function listPiperVoices(paths = resolvePaths()) {
    let entries = [];
    try { entries = fs.readdirSync(paths.voicesDir); } catch { return []; }
    return entries
        .filter((name) => name.endsWith('.onnx') && entries.includes(`${name}.json`))
        .map((name) => ({ id: name.replace(/\.onnx$/, ''), path: path.join(paths.voicesDir, name) }));
}

// "pt_BR-faber-medium" → rhasspy/piper-voices path "pt/pt_BR/faber/medium/pt_BR-faber-medium.onnx"
export function piperVoiceUrl(voiceId, ext = 'onnx') {
    const m = /^([a-z]{2,3})_([A-Z]{2})-([A-Za-z0-9_]+)-(x_low|low|medium|high)$/.exec(voiceId);
    if (!m) throw new Error(`Nome de voz Piper inválido: ${voiceId} (ex.: pt_BR-faber-medium)`);
    const [, lang, region, name, quality] = m;
    return `https://huggingface.co/rhasspy/piper-voices/resolve/main/${lang}/${lang}_${region}/${name}/${quality}/${voiceId}.${ext}`;
}

export async function downloadPiperVoice(voiceId, { signal } = {}) {
    const paths = resolvePaths();
    const onnx = path.join(paths.voicesDir, `${voiceId}.onnx`);
    await downloadTo(piperVoiceUrl(voiceId, 'onnx.json'), `${onnx}.json`, { signal });
    await downloadTo(piperVoiceUrl(voiceId, 'onnx'), onnx, { signal });
    return { voice: voiceId, path: onnx };
}

function pickPiperVoice(requested, language, voices) {
    if (requested) {
        if (fs.existsSync(requested)) return { id: path.basename(requested, '.onnx'), path: requested };
        return voices.find((v) => v.id === requested) || null;
    }
    const envVoice = (process.env.OGA_PIPER_VOICE || '').trim();
    if (envVoice) {
        const found = voices.find((v) => v.id === envVoice);
        if (found) return found;
    }
    const prefix = (language || DEFAULT_LANGUAGE).replace('-', '_');
    const matching = voices.filter((v) => v.id.startsWith(prefix));
    return RECOMMENDED_VOICES.map((id) => matching.find((v) => v.id === id)).find(Boolean) || matching[0] || null;
}

export function availableTtsEngines() {
    const bins = resolveBinaries();
    const voices = listPiperVoices();
    return {
        piper: Boolean(bins.piper) && voices.length > 0,
        piperBinary: bins.piper,
        piperVoices: voices.map((v) => v.id),
        sapi: IS_WINDOWS && Boolean(bins.powershell),
        espeak: Boolean(bins.espeak),
        espeakBinary: bins.espeak,
    };
}

export function resolveEngine(requested = 'auto', language = DEFAULT_LANGUAGE, voice) {
    const engines = availableTtsEngines();
    if (requested === 'none') return 'none';
    if (requested !== 'auto') {
        if (requested === 'piper' && engines.piper) return 'piper';
        if (requested === 'sapi' && engines.sapi) return 'sapi';
        if (requested === 'espeak' && engines.espeak) return 'espeak';
        throw new Error(`Motor de voz "${requested}" indisponível. Disponíveis: ${Object.entries(engines)
            .filter(([k, v]) => ['piper', 'sapi', 'espeak'].includes(k) && v).map(([k]) => k).join(', ') || 'nenhum'}`);
    }
    if (engines.piper && pickPiperVoice(voice, language, listPiperVoices())) return 'piper';
    if (engines.sapi) return 'sapi';
    if (engines.espeak) return 'espeak';
    if (engines.piper) return 'piper';
    throw new Error('Nenhum motor de voz gratuito encontrado. Instale o Piper (oga setup) ou o eSpeak NG.');
}

const SAPI_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$voices = $s.GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object { $_.VoiceInfo }
$pick = $null
if ($env:OGA_SAPI_VOICE) { $pick = $voices | Where-Object { $_.Name -like ('*' + $env:OGA_SAPI_VOICE + '*') } | Select-Object -First 1 }
if (-not $pick) { $pick = $voices | Where-Object { $_.Culture.Name -eq $env:OGA_SAPI_CULTURE } | Select-Object -First 1 }
if ($pick) { $s.SelectVoice($pick.Name) }
$s.Rate = [int]$env:OGA_SAPI_RATE
$s.SetOutputToWaveFile($env:OGA_SAPI_OUT)
$s.Speak([IO.File]::ReadAllText($env:OGA_SAPI_TEXT, [Text.Encoding]::UTF8))
$s.Dispose()
`;

export async function synthesize({ text, outPath, engine = 'auto', voice, speed = 1, language = DEFAULT_LANGUAGE, signal }) {
    const clean = String(text || '').replace(/\s+/g, ' ').trim();
    if (!clean) throw new Error('Texto da narração vazio.');
    const chosen = resolveEngine(engine, language, voice);
    const bins = resolveBinaries();
    const rate = Math.min(2, Math.max(0.5, Number(speed) || 1));
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    let voiceUsed = null;

    if (chosen === 'piper') {
        const picked = pickPiperVoice(voice, language, listPiperVoices());
        if (!picked) throw new Error(`Nenhuma voz Piper para ${language}. Baixe com oga_download_model (ex.: ${RECOMMENDED_VOICES[0]}).`);
        voiceUsed = picked.id;
        await run(bins.piper, ['-m', picked.path, '-f', outPath, '--length-scale', (1 / rate).toFixed(3), '--sentence-silence', '0.25'], {
            input: clean,
            signal,
        });
    } else if (chosen === 'sapi') {
        const tmpText = path.join(os.tmpdir(), `oga-tts-${process.pid}-${Date.now()}.txt`);
        fs.writeFileSync(tmpText, clean, 'utf-8');
        voiceUsed = voice || `SAPI ${language}`;
        try {
            // -EncodedCommand (UTF-16LE base64) avoids every command-line quoting pitfall.
            const encoded = Buffer.from(SAPI_SCRIPT, 'utf16le').toString('base64');
            await run(bins.powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
                signal,
                env: {
                    ...process.env,
                    OGA_SAPI_VOICE: voice || '',
                    OGA_SAPI_CULTURE: language,
                    OGA_SAPI_RATE: String(Math.max(-10, Math.min(10, Math.round((rate - 1) * 10)))),
                    OGA_SAPI_OUT: outPath,
                    OGA_SAPI_TEXT: tmpText,
                },
            });
        } finally {
            fs.rmSync(tmpText, { force: true });
        }
    } else if (chosen === 'espeak') {
        voiceUsed = voice || language.toLowerCase();
        await run(bins.espeak, ['-v', voiceUsed, '-s', String(Math.round(165 * rate)), '-w', outPath, '--stdin'], { input: clean, signal });
    } else {
        throw new Error('Motor "none" não gera áudio.');
    }

    if (!fs.existsSync(outPath)) throw new Error(`O motor de voz ${chosen} não gerou o arquivo.`);
    return { path: outPath, duration: await probeDuration(outPath), engine: chosen, voice: voiceUsed };
}
