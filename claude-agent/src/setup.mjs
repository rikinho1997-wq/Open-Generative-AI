// One-shot installer for the free local stack: sd.cpp engine, a default image
// model + LCM fast-mode LoRA, Piper TTS (Python venv) and a pt-BR voice.
// Everything lands in the shared local-ai folder; nothing is installed system-wide.

import fs from 'node:fs';
import path from 'node:path';
import { IS_WINDOWS, ensureDir, repoModule, resolveBinaries, resolvePaths, which } from './config.mjs';
import { downloadTo } from './download.mjs';
import { LCM_LORA, downloadImageModel, getImageModel } from './engines/sdcpp.mjs';
import { run } from './proc.mjs';
import { downloadPiperVoice, listPiperVoices } from './tts.mjs';

// Same Metal build the desktop app installs on Apple Silicon.
const MAC_ARM_BINARY = 'https://github.com/Anil-matcha/Open-Generative-AI/releases/download/v1.0.3-binaries/sd-cli-metal-macos-arm64.zip';

async function fetchJson(url) {
    const curl = which('curl');
    if (curl && (process.env.HTTPS_PROXY || process.env.https_proxy) && process.env.NODE_USE_ENV_PROXY !== '1') {
        const { stdout } = await run(curl, ['-sL', '--fail', '-H', 'User-Agent: open-generative-ai', url]);
        return JSON.parse(stdout);
    }
    const res = await fetch(url, { headers: { 'User-Agent': 'open-generative-ai' } });
    if (!res.ok) throw new Error(`HTTP ${res.status} em ${url}`);
    return res.json();
}

function findFile(dir, name) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            const found = findFile(full, name);
            if (found) return found;
        } else if (entry.name === name) return full;
    }
    return null;
}

async function extractZip(zip, dest) {
    if (IS_WINDOWS) await run('tar', ['-xf', zip, '-C', dest]); // bsdtar ships with Windows 10+
    else await run('unzip', ['-o', '-q', zip, '-d', dest]);
}

async function detectNvidia() {
    if (!which('nvidia-smi')) return null;
    try {
        const { stdout } = await run('nvidia-smi', ['-L'], { timeoutMs: 8000 });
        return /GPU \d+/i.test(stdout) ? 'nvidia' : null;
    } catch {
        return null;
    }
}

// Plan B when release binaries cannot be downloaded (blocked network, no build
// for this platform): compile sd-cli from source. Needs git, cmake and a C++ compiler.
export async function buildSdCliFromSource(log = console.log) {
    const paths = resolvePaths();
    const git = which('git');
    const cmake = which('cmake');
    if (!git || !cmake || IS_WINDOWS) {
        throw new Error('compilação local indisponível (requer git + cmake + compilador C++; no Windows use o binário pronto)');
    }
    const work = ensureDir(path.join(paths.tmpDir, 'sdcpp-build'));
    const src = path.join(work, 'src');
    const build = path.join(work, 'build');
    log('⚙ Compilando sd.cpp do código-fonte (CPU; ~5–10 min)…');
    if (!fs.existsSync(path.join(src, 'CMakeLists.txt'))) {
        fs.rmSync(src, { recursive: true, force: true });
        await run(git, ['clone', '--depth', '1', '--recurse-submodules', '--shallow-submodules',
            'https://github.com/leejet/stable-diffusion.cpp.git', src]);
    }
    const generator = which('ninja') ? ['-G', 'Ninja'] : [];
    await run(cmake, ['-S', src, '-B', build, ...generator, '-DCMAKE_BUILD_TYPE=Release', '-DSD_BUILD_SHARED_LIBS=OFF']);
    await run(cmake, ['--build', build, '--config', 'Release', '-j', '4', '--target', 'sd-cli']);
    const built = findFile(build, 'sd-cli');
    if (!built) throw new Error('compilação terminou sem gerar sd-cli');
    ensureDir(paths.binDir);
    const target = path.join(paths.binDir, 'sd-cli');
    fs.copyFileSync(built, target);
    fs.chmodSync(target, 0o755);
    fs.rmSync(work, { recursive: true, force: true });
    log(`✔ sd.cpp compilado: ${target}`);
    return target;
}

export async function installSdCli(log = console.log) {
    try {
        return await installSdCliBinary(log);
    } catch (err) {
        log(`✖ Binário pronto indisponível (${err.message.split('\n')[0]})`);
        return buildSdCliFromSource(log);
    }
}

async function installSdCliBinary(log) {
    const paths = resolvePaths();
    const bins = resolveBinaries(process.env, paths);
    if (bins.sdCli) {
        log(`✔ sd.cpp já instalado: ${bins.sdCli}`);
        return bins.sdCli;
    }
    ensureDir(paths.binDir);
    const binaryName = IS_WINDOWS ? 'sd-cli.exe' : 'sd-cli';
    const { pickBinaryAssetForPlatform, rankWindowsAssets } = repoModule('electron/lib/localInferenceAssets.js');
    let assets = [];
    let release = null;
    if (process.platform === 'darwin' && process.arch === 'arm64') {
        assets = [{ name: path.basename(MAC_ARM_BINARY), url: MAC_ARM_BINARY }];
    } else {
        const gpu = IS_WINDOWS ? await detectNvidia() : null;
        const releases = await fetchJson('https://api.github.com/repos/leejet/stable-diffusion.cpp/releases?per_page=15');
        for (const r of releases) {
            const zips = (r.assets || []).filter((a) => a.name.endsWith('.zip'));
            const names = zips.map((a) => a.name);
            const ranked = IS_WINDOWS
                ? rankWindowsAssets({ zipNames: names, gpu })
                : [pickBinaryAssetForPlatform({ platform: process.platform, arch: process.arch, zipNames: names })].filter(Boolean);
            if (ranked.length) {
                release = r;
                assets = ranked.map((n) => {
                    const a = zips.find((z) => z.name === n);
                    return { name: a.name, url: a.browser_download_url };
                });
                break;
            }
        }
    }
    if (!assets.length) throw new Error(`Nenhum binário sd.cpp publicado para ${process.platform}-${process.arch}.`);

    for (const asset of assets) {
        try {
            log(`↓ Baixando motor sd.cpp: ${asset.name}`);
            const zip = path.join(paths.binDir, asset.name);
            await downloadTo(asset.url, zip);
            await extractZip(zip, paths.binDir);
            fs.rmSync(zip, { force: true });
            const found = findFile(paths.binDir, binaryName);
            if (!found) throw new Error('sd-cli não encontrado no pacote');
            if (path.dirname(found) !== paths.binDir) {
                for (const f of fs.readdirSync(path.dirname(found))) {
                    fs.renameSync(path.join(path.dirname(found), f), path.join(paths.binDir, f));
                }
            }
            const target = path.join(paths.binDir, binaryName);
            if (!IS_WINDOWS) fs.chmodSync(target, 0o755);
            // Windows CUDA builds need the CUDA runtime DLLs next to the binary.
            if (IS_WINDOWS && fs.existsSync(path.join(paths.binDir, 'ggml-cuda.dll')) && release) {
                const cudart = (release.assets || []).find((a) => /^cudart-sd-bin-win-cu\d+-x64\.zip$/.test(a.name));
                if (cudart) {
                    const cz = path.join(paths.binDir, cudart.name);
                    await downloadTo(cudart.browser_download_url, cz);
                    await extractZip(cz, paths.binDir);
                    fs.rmSync(cz, { force: true });
                }
            }
            await run(target, ['--help'], { timeoutMs: 20000 }).catch((err) => {
                if (err.code === undefined || (err.code >>> 0) >= 0xC0000000) throw err;
            });
            log(`✔ sd.cpp instalado: ${target}`);
            return target;
        } catch (err) {
            log(`✖ ${asset.name} falhou (${err.message.split('\n')[0]}); tentando a próxima opção…`);
            for (const f of fs.readdirSync(paths.binDir)) fs.rmSync(path.join(paths.binDir, f), { recursive: true, force: true });
        }
    }
    throw new Error('Não foi possível instalar o sd.cpp automaticamente. Instale pelo app desktop (Settings → Local Models) '
        + 'ou compile: https://github.com/leejet/stable-diffusion.cpp');
}

async function findPython() {
    const candidates = IS_WINDOWS ? [['py', ['-3']], ['python', []]] : [['python3', []], ['python', []]];
    for (const [cmd, pre] of candidates) {
        const exe = which(cmd);
        if (!exe) continue;
        try {
            const { stdout } = await run(exe, [...pre, '-c', 'import sys; print(sys.version_info[0]*100+sys.version_info[1])']);
            if (Number(stdout.trim()) >= 309) return { exe, pre };
        } catch { /* try the next one */ }
    }
    return null;
}

export async function installPiper(log = console.log) {
    const paths = resolvePaths();
    if (resolveBinaries(process.env, paths).piper) {
        log('✔ Piper já instalado');
        return;
    }
    const python = await findPython();
    if (!python) throw new Error('Python 3.9+ não encontrado. Instale (Windows: winget install Python.Python.3.12) e rode o setup de novo.');
    log(`↓ Criando ambiente Python para o Piper em ${paths.ttsVenvDir}`);
    await run(python.exe, [...python.pre, '-m', 'venv', paths.ttsVenvDir]);
    const pip = IS_WINDOWS ? path.join(paths.ttsVenvDir, 'Scripts', 'pip.exe') : path.join(paths.ttsVenvDir, 'bin', 'pip');
    await run(pip, ['install', '--quiet', 'piper-tts']);
    log('✔ Piper instalado');
}

export async function runSetup({ model = 'dreamshaper-8', voice = 'pt_BR-faber-medium', lcm = true, log = console.log } = {}) {
    const bins = resolveBinaries();
    const problems = [];
    if (!bins.ffmpeg || !bins.ffprobe) {
        problems.push(IS_WINDOWS ? 'FFmpeg ausente: winget install Gyan.FFmpeg (e reabra o terminal)' : 'FFmpeg ausente: instale pelo gerenciador de pacotes');
    } else log(`✔ FFmpeg: ${bins.ffmpeg}`);

    const step = async (label, fn) => {
        try { await fn(); } catch (err) { problems.push(`${label}: ${err.message}`); log(`✖ ${label}: ${err.message}`); }
    };
    await step('sd.cpp', () => installSdCli(log));
    if (model) {
        await step(`modelo ${model}`, async () => {
            if (!getImageModel(model)) throw new Error('modelo desconhecido');
            log(`↓ Modelo de imagem ${model} (pode levar alguns minutos)…`);
            await downloadImageModel(model);
            log(`✔ Modelo ${model} pronto`);
        });
    }
    if (lcm) {
        await step('LCM-LoRA', async () => {
            await downloadImageModel(LCM_LORA.id);
            log('✔ Modo rápido (LCM-LoRA) pronto');
        });
    }
    await step('Piper', () => installPiper(log));
    if (voice) {
        await step(`voz ${voice}`, async () => {
            if (!listPiperVoices().some((v) => v.id === voice)) await downloadPiperVoice(voice);
            log(`✔ Voz ${voice} pronta`);
        });
    }
    if (!resolveBinaries().espeak && !IS_WINDOWS) log('ℹ Opcional: instale o eSpeak NG como voz reserva (apt install espeak-ng).');
    return { problems };
}
