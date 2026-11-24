// Paths, binaries and policy for the Claude agent.
//
// The agent shares its model folder with the desktop app (Settings → Local Models),
// so a model downloaded in one is usable by the other:
//   Windows: %APPDATA%\open-generative-ai\local-ai
//   macOS:   ~/Library/Application Support/open-generative-ai/local-ai
//   Linux:   ~/.config/open-generative-ai/local-ai
// OPEN_GENERATIVE_AI_LOCAL_AI_DIR overrides it, exactly as in the desktop app.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

export const AGENT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const REPO_ROOT = path.resolve(AGENT_ROOT, '..');

const requireRepo = createRequire(path.join(REPO_ROOT, 'package.json'));

// The desktop app's pure (electron-free) modules, reused as-is.
export function repoModule(relativePath) {
    return requireRepo(path.join(REPO_ROOT, relativePath));
}

export const IS_WINDOWS = process.platform === 'win32';

export function defaultUserDataDir(platform = process.platform, env = process.env) {
    const home = os.homedir();
    if (platform === 'win32') {
        return path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'open-generative-ai');
    }
    if (platform === 'darwin') {
        return path.join(home, 'Library', 'Application Support', 'open-generative-ai');
    }
    return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'open-generative-ai');
}

export function resolvePaths(env = process.env) {
    const { resolveLocalAiPaths } = repoModule('electron/lib/localInferencePaths.js');
    const userDataPath = defaultUserDataDir(process.platform, env);
    const local = resolveLocalAiPaths({ userDataPath, env });
    const outputDir = path.resolve((env.OGA_OUTPUT_DIR || '').trim() || path.join(REPO_ROOT, 'outputs'));
    return {
        userDataPath,
        dataDir: local.dataDir,
        binDir: local.binDir,
        modelsDir: local.modelsDir,
        tmpDir: local.tmpDir,
        voicesDir: path.join(local.dataDir, 'voices'),
        ttsVenvDir: path.join(local.dataDir, 'tts-venv'),
        // Same file the desktop app writes from Settings → Local Models → Wan2GP.
        wan2gpConfigFile: path.join(userDataPath, 'local-ai', 'wan2gp.json'),
        wan2gpWorkDir: path.join(local.dataDir, 'wan2gp'),
        outputDir,
    };
}

export function ensureDir(dir) {
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

// Find an executable on PATH (PATHEXT-aware on Windows). Returns null when absent.
export function which(command, env = process.env) {
    if (!command) return null;
    if (command.includes('/') || command.includes('\\')) {
        return fs.existsSync(command) ? command : null;
    }
    const exts = IS_WINDOWS
        ? ['', ...(env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').map((e) => e.toLowerCase())]
        : [''];
    for (const dir of (env.PATH || '').split(path.delimiter)) {
        if (!dir) continue;
        for (const ext of exts) {
            const candidate = path.join(dir, command + ext);
            try {
                if (fs.statSync(candidate).isFile()) return candidate;
            } catch { /* not here */ }
        }
    }
    return null;
}

function firstExisting(candidates) {
    for (const candidate of candidates) {
        if (candidate && fs.existsSync(candidate)) return candidate;
    }
    return null;
}

export function resolveBinaries(env = process.env, paths = resolvePaths(env)) {
    const exe = IS_WINDOWS ? '.exe' : '';
    const venvBin = IS_WINDOWS ? path.join(paths.ttsVenvDir, 'Scripts') : path.join(paths.ttsVenvDir, 'bin');
    return {
        ffmpeg: which((env.OGA_FFMPEG || '').trim() || 'ffmpeg', env),
        ffprobe: which((env.OGA_FFPROBE || '').trim() || 'ffprobe', env),
        // OPEN_GENERATIVE_AI_SD_CLI is the desktop app's own override (#396).
        sdCli: firstExisting([
            (env.OPEN_GENERATIVE_AI_SD_CLI || '').trim(),
            path.join(paths.binDir, `sd-cli${exe}`),
        ]) || which('sd-cli', env),
        piper: firstExisting([
            (env.OGA_PIPER || '').trim(),
            path.join(venvBin, `piper${exe}`),
        ]) || which('piper', env),
        espeak: which((env.OGA_ESPEAK || '').trim() || 'espeak-ng', env)
            || (IS_WINDOWS ? firstExisting(['C:\\Program Files\\eSpeak NG\\espeak-ng.exe']) : null)
            || which('espeak', env),
        powershell: IS_WINDOWS ? which('powershell', env) : null,
    };
}

// ─── Paid API policy ────────────────────────────────────────────────────────
// MuAPI is pay-per-generation. It is never used unless ALL three are true:
//   1. MUAPI_API_KEY is set in the environment (never in a file in the repo),
//   2. OGA_ALLOW_PAID=1 is set by the user,
//   3. the individual tool call passes allow_paid: true (Claude must ask first).
export function paidPolicy(env = process.env) {
    const keySet = Boolean((env.MUAPI_API_KEY || '').trim());
    const envAllowed = ['1', 'true', 'yes'].includes(String(env.OGA_ALLOW_PAID || '').trim().toLowerCase());
    return { keySet, envAllowed, enabled: keySet && envAllowed };
}

export function assertPaidAllowed(allowPaidFlag, env = process.env) {
    const policy = paidPolicy(env);
    const missing = [];
    if (!policy.keySet) missing.push('MUAPI_API_KEY não está definida no ambiente');
    if (!policy.envAllowed) missing.push('OGA_ALLOW_PAID=1 não está definido');
    if (allowPaidFlag !== true) missing.push('a chamada não passou allow_paid: true (exige autorização explícita do usuário)');
    if (missing.length) {
        throw new Error(`Provedor pago (MuAPI) bloqueado: ${missing.join('; ')}. `
            + 'Use os motores locais gratuitos ou peça autorização ao usuário.');
    }
}

export const MAX_VIDEO_SECONDS = Number(process.env.OGA_MAX_VIDEO_SECONDS) > 0
    ? Math.min(Number(process.env.OGA_MAX_VIDEO_SECONDS), 600)
    : 120;
