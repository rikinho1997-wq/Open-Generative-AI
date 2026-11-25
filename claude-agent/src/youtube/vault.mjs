// Local, private storage for the YouTube OAuth client file and tokens.
//
// Location (never inside the repository):
//   Windows: %APPDATA%\open-generative-ai\youtube
//   macOS:   ~/Library/Application Support/open-generative-ai/youtube
//   Linux:   ~/.config/open-generative-ai/youtube
//   override: OGA_YT_DIR
//
// Protection, strongest available first:
//   dpapi            Windows: encrypted with the Windows Data Protection API, bound to
//                    your Windows user account (another account or PC cannot read it)
//   aes-256-gcm      any OS, when OGA_YT_PASSPHRASE is set (key derived with scrypt)
//   file-permissions folder 0700 / file 0600: only your OS user can read it
// Every file is written atomically (temp file + rename).

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { IS_WINDOWS, REPO_ROOT, defaultUserDataDir, resolveBinaries } from '../config.mjs';
import { run } from '../proc.mjs';

export function youtubeDir(env = process.env) {
    const custom = (env.OGA_YT_DIR || '').trim();
    return path.resolve(custom || path.join(defaultUserDataDir(process.platform, env), 'youtube'));
}

export function assertOutsideRepo(file) {
    const rel = path.relative(REPO_ROOT, path.resolve(file));
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
        throw new Error(`Por segurança, credenciais não podem ficar dentro do repositório (${file}). `
            + 'Use a pasta padrão (fora do Git) ou defina OGA_YT_DIR para outro local.');
    }
}

function ensurePrivateDir(dir) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (!IS_WINDOWS) fs.chmodSync(dir, 0o700);
}

// ─── Protection back-ends ────────────────────────────────────────────────────
const DPAPI_SCRIPT = (mode) => `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$inp = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())
$out = [System.Security.Cryptography.ProtectedData]::${mode}($inp, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
[Console]::Out.Write([Convert]::ToBase64String($out))
`;

async function dpapi(mode, base64) {
    const ps = resolveBinaries().powershell;
    if (!ps) throw new Error('PowerShell não encontrado para usar a DPAPI do Windows.');
    const encoded = Buffer.from(DPAPI_SCRIPT(mode), 'utf16le').toString('base64');
    const { stdout } = await run(ps, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { input: base64 });
    return stdout.trim();
}

function aesKey(passphrase, salt) {
    return crypto.scryptSync(passphrase, salt, 32, { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
}

export function protectionMode(env = process.env) {
    if ((env.OGA_YT_PASSPHRASE || '').length > 0) return 'aes-256-gcm';
    if (IS_WINDOWS && env.OGA_YT_NO_DPAPI !== '1') return 'dpapi';
    return 'file-permissions';
}

async function seal(obj, env = process.env) {
    const plain = Buffer.from(JSON.stringify(obj), 'utf-8');
    const mode = protectionMode(env);
    if (mode === 'aes-256-gcm') {
        const salt = crypto.randomBytes(16);
        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv('aes-256-gcm', aesKey(env.OGA_YT_PASSPHRASE, salt), iv);
        const data = Buffer.concat([cipher.update(plain), cipher.final()]);
        return { version: 1, protection: mode, salt: salt.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
    }
    if (mode === 'dpapi') return { version: 1, protection: mode, data: await dpapi('Protect', plain.toString('base64')) };
    return { version: 1, protection: mode, data: obj };
}

async function unseal(box, env = process.env) {
    if (box.protection === 'aes-256-gcm') {
        if (!env.OGA_YT_PASSPHRASE) throw new Error('Este cofre foi criado com senha: defina OGA_YT_PASSPHRASE.');
        try {
            const d = crypto.createDecipheriv('aes-256-gcm', aesKey(env.OGA_YT_PASSPHRASE, Buffer.from(box.salt, 'base64')), Buffer.from(box.iv, 'base64'));
            d.setAuthTag(Buffer.from(box.tag, 'base64'));
            return JSON.parse(Buffer.concat([d.update(Buffer.from(box.data, 'base64')), d.final()]).toString('utf-8'));
        } catch {
            throw new Error('Não foi possível abrir o cofre: OGA_YT_PASSPHRASE incorreta ou arquivo alterado.');
        }
    }
    if (box.protection === 'dpapi') return JSON.parse(Buffer.from(await dpapi('Unprotect', box.data), 'base64').toString('utf-8'));
    return box.data;
}

// ─── Public API ──────────────────────────────────────────────────────────────
export async function writeSecret(name, obj, env = process.env) {
    const dir = youtubeDir(env);
    assertOutsideRepo(dir);
    ensurePrivateDir(dir);
    const file = path.join(dir, name);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(await seal(obj, env), null, 1), { mode: 0o600 });
    if (!IS_WINDOWS) fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
    return file;
}

export async function readSecret(name, env = process.env) {
    const file = path.join(youtubeDir(env), name);
    if (!fs.existsSync(file)) return null;
    if (!IS_WINDOWS) {
        const mode = fs.statSync(file).mode & 0o777;
        if (mode & 0o077) fs.chmodSync(file, 0o600); // tighten permissions if they were loosened
    }
    return unseal(JSON.parse(fs.readFileSync(file, 'utf-8')), env);
}

export function secretInfo(name, env = process.env) {
    const file = path.join(youtubeDir(env), name);
    if (!fs.existsSync(file)) return null;
    let protection = 'desconhecida';
    try { protection = JSON.parse(fs.readFileSync(file, 'utf-8')).protection; } catch { /* unreadable */ }
    return { file, protection, mode: IS_WINDOWS ? null : (fs.statSync(file).mode & 0o777).toString(8) };
}

export function deleteSecret(name, env = process.env) {
    const file = path.join(youtubeDir(env), name);
    if (fs.existsSync(file)) {
        // overwrite before unlinking so the old bytes do not linger in the same blocks
        fs.writeFileSync(file, crypto.randomBytes(Math.max(64, fs.statSync(file).size)));
        fs.rmSync(file, { force: true });
    }
}

// Plain (non-secret) bookkeeping, e.g. the upload history.
export function readJson(name, fallback, env = process.env) {
    try { return JSON.parse(fs.readFileSync(path.join(youtubeDir(env), name), 'utf-8')); } catch { return fallback; }
}

export function writeJson(name, data, env = process.env) {
    const dir = youtubeDir(env);
    ensurePrivateDir(dir);
    fs.writeFileSync(path.join(dir, name), JSON.stringify(data, null, 2), { mode: 0o600 });
}
