#!/usr/bin/env node
// Command-line front end for the same engines the MCP server exposes.
// Handy on Windows, for long renders in a terminal, and for Claude via Bash.
//
//   node claude-agent/bin/oga.mjs doctor
//   node claude-agent/bin/oga.mjs setup
//   node claude-agent/bin/oga.mjs image "a lighthouse at dusk, oil painting" --ar 16:9
//   node claude-agent/bin/oga.mjs tts "Olá, mundo!"
//   node claude-agent/bin/oga.mjs produce claude-agent/examples/demo-pt-br.json
//   node claude-agent/bin/oga.mjs produce roteiro.json --dry-run

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { ensureDir, resolvePaths } from '../src/config.mjs';
import { doctor } from '../src/doctor.mjs';
import { downloadImageModel, listImageModels } from '../src/engines/sdcpp.mjs';
import { listVideoModels, wan2gpStatus, writeWan2gpConfig } from '../src/engines/wan2gp.mjs';
import { dryRun, generateClipAny, generateImageAny, produceVideo } from '../src/producer.mjs';
import { runSetup } from '../src/setup.mjs';
import { slugify } from '../src/storyboard.mjs';
import { downloadPiperVoice, listPiperVoices, synthesize } from '../src/tts.mjs';

const HELP = `Open Generative AI — CLI do agente (gratuito/local por padrão)

Comandos:
  doctor                         Diagnóstico do que funciona e do que falta
  setup [--model id] [--voice v] [--no-lcm]
                                 Instala sd.cpp, modelo de imagem, modo rápido, Piper e voz pt-BR
  models                         Lista modelos e vozes gratuitos
  download <id>                  Baixa modelo (dreamshaper-8, lcm-lora-sd15, z-image-turbo…) ou voz (pt_BR-cadu-medium)
  image "<prompt>" [--ar 16:9] [--model id] [--steps n] [--seed n] [--no-fast] [--out arquivo.png]
  tts "<texto>" [--voice v] [--engine piper|sapi|espeak] [--speed 1.0] [--out arquivo.wav]
  clip "<prompt>" [--model id] [--seconds 5] [--image quadro.png]   (Wan2GP, requer GPU)
  produce <roteiro.json> [--dry-run] [--allow-paid]
  wan2gp [--dir pasta] [--python exe] [--url http://host:7866/mcp]

Pago (MuAPI) só com MUAPI_API_KEY + OGA_ALLOW_PAID=1 + --allow-paid.`;

const { values: opts, positionals } = parseArgs({
    allowPositionals: true,
    options: {
        ar: { type: 'string' },
        model: { type: 'string' },
        steps: { type: 'string' },
        seed: { type: 'string' },
        out: { type: 'string' },
        voice: { type: 'string' },
        engine: { type: 'string' },
        speed: { type: 'string' },
        seconds: { type: 'string' },
        image: { type: 'string' },
        dir: { type: 'string' },
        python: { type: 'string' },
        url: { type: 'string' },
        provider: { type: 'string' },
        'no-fast': { type: 'boolean' },
        'no-lcm': { type: 'boolean' },
        'dry-run': { type: 'boolean' },
        'allow-paid': { type: 'boolean' },
        json: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
    },
});

const [command, ...rest] = positionals;
const print = (data) => console.log(typeof data === 'string' ? data : JSON.stringify(data, null, 2));
const num = (v) => (v === undefined ? undefined : Number(v));

function progressPrinter(prefix) {
    let last = -1;
    return (stage, value, message) => {
        const pct = typeof value === 'number' ? Math.round(value * 100) : last;
        if (message) process.stderr.write(`\n[${prefix}] ${message}`);
        if (pct !== last && pct >= 0) {
            process.stderr.write(`\r[${prefix}] ${stage || ''} ${pct}%   `);
            last = pct;
        }
    };
}

function defaultOut(kind, name, ext) {
    const dir = ensureDir(path.join(resolvePaths().outputDir, kind));
    return path.join(dir, `${Date.now()}-${slugify(name).slice(0, 40)}.${ext}`);
}

async function main() {
    if (!command || opts.help) return print(HELP);
    switch (command) {
    case 'doctor':
        return print(await doctor());
    case 'setup': {
        const { problems } = await runSetup({ model: opts.model || 'dreamshaper-8', voice: opts.voice || 'pt_BR-faber-medium', lcm: !opts['no-lcm'] });
        const report = await doctor({ probeWan2gp: false });
        print({ capabilities: report.capabilities, todo: report.todo, problems });
        return;
    }
    case 'models':
        return print({ image: listImageModels(), video: listVideoModels(), voices: listPiperVoices().map((v) => v.id), wan2gp: await wan2gpStatus({ probe: false }) });
    case 'download': {
        const id = rest[0];
        if (!id) throw new Error('Informe o id: download dreamshaper-8');
        if (/^[a-z]{2,3}_[A-Z]{2}-/.test(id)) return print(await downloadPiperVoice(id));
        const p = progressPrinter('download');
        return print(await downloadImageModel(id, { onProgress: (e) => p('baixando', e.progress) }));
    }
    case 'image': {
        const prompt = rest.join(' ');
        const outPath = opts.out ? path.resolve(opts.out) : defaultOut('images', prompt, 'png');
        const p = progressPrinter('imagem');
        const result = await generateImageAny({
            prompt,
            model: opts.model,
            provider: opts.provider || 'local',
            aspect_ratio: opts.ar || '1:1',
            steps: num(opts.steps),
            seed: num(opts.seed),
            fast: !opts['no-fast'],
            allow_paid: Boolean(opts['allow-paid']),
            outPath,
        }, { onProgress: (e) => p('gerando', e.progress) });
        process.stderr.write('\n');
        return print(result);
    }
    case 'tts': {
        const text = rest.join(' ');
        const outPath = opts.out ? path.resolve(opts.out) : defaultOut('audio', text, 'wav');
        return print(await synthesize({ text, outPath, voice: opts.voice, engine: opts.engine || 'auto', speed: num(opts.speed) || 1 }));
    }
    case 'clip': {
        const prompt = rest.join(' ');
        const outPath = opts.out ? path.resolve(opts.out) : defaultOut('clips', prompt, 'mp4');
        const p = progressPrinter('clipe');
        const result = await generateClipAny({
            prompt,
            model: opts.model,
            provider: opts.provider || 'wan2gp',
            aspect_ratio: opts.ar || '16:9',
            duration_seconds: num(opts.seconds) || 5,
            image_path: opts.image ? path.resolve(opts.image) : undefined,
            allow_paid: Boolean(opts['allow-paid']),
            outPath,
        }, { onProgress: (e) => p(e.status || 'gerando', e.progress) });
        process.stderr.write('\n');
        return print(result);
    }
    case 'produce': {
        const file = rest[0];
        if (!file) throw new Error('Informe o arquivo do roteiro: produce roteiro.json');
        const storyboard = JSON.parse(fs.readFileSync(file, 'utf-8'));
        if (opts['dry-run']) return print(dryRun(storyboard));
        const p = progressPrinter('vídeo');
        const result = await produceVideo(storyboard, {
            allowPaid: Boolean(opts['allow-paid']),
            progress: p,
            log: (m) => process.stderr.write(`\n[vídeo] ${m}`),
        });
        process.stderr.write('\n');
        return print(result);
    }
    case 'wan2gp': {
        const cfg = {};
        if (opts.dir !== undefined) cfg.dir = opts.dir;
        if (opts.python !== undefined) cfg.python = opts.python;
        if (opts.url !== undefined) cfg.url = opts.url;
        if (Object.keys(cfg).length) writeWan2gpConfig(cfg);
        return print(await wan2gpStatus({ probe: true }));
    }
    default:
        print(HELP);
        process.exitCode = 2;
    }
}

main().catch((err) => {
    console.error(`\nErro: ${err.message}`);
    process.exitCode = 1;
});
