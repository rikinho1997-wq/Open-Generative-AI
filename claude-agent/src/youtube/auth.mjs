// OAuth 2.0 for installed (desktop) apps, as Google recommends:
// loopback redirect to http://127.0.0.1:<random port>, PKCE (S256) and a `state`
// check. https://developers.google.com/identity/protocols/oauth2/native-app
//
// Two permission profiles (least privilege first):
//   upload (default) youtube.upload + youtube.readonly — send videos, confirm the channel,
//                    read processing/status of your videos
//   manage           youtube.upload + youtube.force-ssl — also publish or schedule videos
//                    AFTER upload (videos.update needs it; youtube.upload cannot do it)

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { IS_WINDOWS } from '../config.mjs';
import { assertOutsideRepo, deleteSecret, protectionMode, readSecret, secretInfo, writeSecret, youtubeDir } from './vault.mjs';

export const SCOPE = 'https://www.googleapis.com/auth/youtube.upload';
export const SCOPES = {
    upload: SCOPE,
    readonly: 'https://www.googleapis.com/auth/youtube.readonly',
    manage: 'https://www.googleapis.com/auth/youtube.force-ssl',
};
export const PROFILES = {
    upload: [SCOPES.upload, SCOPES.readonly],
    manage: [SCOPES.upload, SCOPES.manage],
};
const CLIENT_FILE = 'client.json';
const TOKEN_FILE = 'token.json';

// Overridable only for tests, and only with https or a loopback host.
function endpoint(envName, fallback, env = process.env) {
    const value = (env[envName] || '').trim();
    if (!value) return fallback;
    const u = new URL(value);
    if (u.protocol !== 'https:' && !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) {
        throw new Error(`${envName} precisa ser https (ou um endereço local de teste).`);
    }
    return value.replace(/\/+$/, '');
}

export function endpoints(env = process.env) {
    return {
        auth: endpoint('OGA_YT_AUTH_URL', 'https://accounts.google.com/o/oauth2/v2/auth', env),
        token: endpoint('OGA_YT_TOKEN_URL', 'https://oauth2.googleapis.com/token', env),
        revoke: endpoint('OGA_YT_REVOKE_URL', 'https://oauth2.googleapis.com/revoke', env),
        api: endpoint('OGA_YT_API_BASE', 'https://www.googleapis.com', env),
    };
}

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const mask = (s) => (s ? `${s.slice(0, 8)}…${s.slice(-12)}` : null);

export class AuthRequiredError extends Error {}

// ─── Client (the JSON downloaded from Google Cloud) ─────────────────────────
export function parseClientFile(raw) {
    const json = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (json.web) {
        throw new Error('Este arquivo é de um cliente do tipo "Aplicativo da Web". Crie um cliente OAuth do tipo '
            + '"App para computador" (Desktop app) no Google Cloud e baixe o JSON dele.');
    }
    const c = json.installed;
    if (!c?.client_id || !c?.client_secret) {
        throw new Error('JSON inválido: esperado {"installed": {"client_id": …, "client_secret": …}} (cliente "App para computador").');
    }
    return { client_id: c.client_id, client_secret: c.client_secret, project_id: c.project_id || null };
}

// Copies the client file into the private vault. The original download can then be deleted.
export async function importClientFile(sourcePath) {
    if (!fs.existsSync(sourcePath)) throw new Error(`Arquivo não encontrado: ${sourcePath}`);
    const client = parseClientFile(fs.readFileSync(sourcePath, 'utf-8'));
    let insideRepo = false;
    try { assertOutsideRepo(sourcePath); } catch { insideRepo = true; }
    const file = await writeSecret(CLIENT_FILE, { ...client, imported_at: new Date().toISOString() });
    return {
        stored_in: file,
        protection: protectionMode(),
        client_id: mask(client.client_id),
        project_id: client.project_id,
        warning: insideRepo ? `O arquivo original está DENTRO do repositório (${sourcePath}). Apague-o agora — a cópia segura já foi guardada.` : null,
    };
}

async function loadClient() {
    const envFile = (process.env.OGA_YT_CLIENT_SECRET || '').trim();
    const stored = await readSecret(CLIENT_FILE);
    if (stored) return stored;
    if (envFile && fs.existsSync(envFile)) return parseClientFile(fs.readFileSync(envFile, 'utf-8'));
    throw new AuthRequiredError('Credenciais OAuth não configuradas. Rode: node claude-agent/bin/oga.mjs youtube setup --client-secret <arquivo.json>');
}

// ─── Browser ─────────────────────────────────────────────────────────────────
export function openInBrowser(url) {
    // No shell: the URL is passed as a single argument (its & and ? stay intact).
    const [cmd, args] = IS_WINDOWS ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
        : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
    try {
        const child = spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true });
        child.on('error', () => {});
        child.unref();
        return true;
    } catch {
        return false;
    }
}

async function tokenRequest(params) {
    const res = await fetch(endpoints().token, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(params).toString(),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
        const err = new Error(`Google OAuth: ${body.error || res.status}${body.error_description ? ` — ${body.error_description}` : ''}`);
        err.code = body.error;
        throw err;
    }
    return body;
}

const PAGE = (ok, msg) => `<!doctype html><meta charset="utf-8"><title>Open Generative AI</title>
<body style="font-family:system-ui;background:#0B1F3A;color:#fff;display:grid;place-items:center;height:100vh;margin:0">
<div style="text-align:center"><h1 style="color:${ok ? '#FFC20E' : '#ff6b6b'}">${ok ? 'Autorização concluída' : 'Autorização não concluída'}</h1>
<p>${msg}</p></div></body>`;

// Full browser consent. Resolves with a status object once tokens are stored.
export async function authorize({ open = openInBrowser, log = () => {}, timeoutMs = 300_000, signal, profile = 'upload' } = {}) {
    const scopes = PROFILES[profile];
    if (!scopes) throw new Error(`Perfil de permissão inválido: ${profile} (use upload ou manage).`);
    const client = await loadClient();
    const verifier = b64url(crypto.randomBytes(48));
    const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
    const state = b64url(crypto.randomBytes(24));

    const server = http.createServer();
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const { port } = server.address();
    const redirectUri = `http://127.0.0.1:${port}/oauth2callback`;
    const url = `${endpoints().auth}?${new URLSearchParams({
        client_id: client.client_id,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: scopes.join(' '),
        access_type: 'offline',
        prompt: 'select_account consent', // always show the account/channel picker
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state,
    })}`;

    const code = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => finish(new Error('Tempo esgotado esperando a autorização no navegador (5 min).')), timeoutMs);
        const onAbort = () => finish(new Error('Autorização cancelada.'));
        signal?.addEventListener?.('abort', onAbort, { once: true });
        function finish(err, value) {
            clearTimeout(timer);
            signal?.removeEventListener?.('abort', onAbort);
            server.close();
            if (err) reject(err); else resolve(value);
        }
        server.on('request', (req, res) => {
            const u = new URL(req.url, redirectUri);
            if (u.pathname !== '/oauth2callback') {
                res.writeHead(404).end();
                return;
            }
            const error = u.searchParams.get('error');
            if (error || u.searchParams.get('state') !== state) {
                const msg = error === 'access_denied' ? 'Você recusou o acesso.' : 'Resposta inválida (state não confere).';
                res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' }).end(PAGE(false, msg));
                finish(new Error(`Autorização recusada ou inválida: ${error || 'state inválido'}`));
                return;
            }
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
                .end(PAGE(true, 'Pode fechar esta aba e voltar ao terminal / Claude.'));
            finish(null, u.searchParams.get('code'));
        });
        log(`Abra no navegador para autorizar (se não abrir sozinho):\n${url}`);
        if (!open(url)) log('Não consegui abrir o navegador automaticamente; copie o link acima.');
    });

    const tokens = await tokenRequest({
        code,
        client_id: client.client_id,
        client_secret: client.client_secret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
        code_verifier: verifier,
    });
    if (!tokens.refresh_token) {
        throw new Error('O Google não devolveu um refresh token. Revogue o acesso em https://myaccount.google.com/permissions e autorize de novo.');
    }
    const granted = String(tokens.scope || '').split(' ');
    if (!granted.includes(SCOPE)) {
        throw new Error(`Permissão youtube.upload não concedida (escopos recebidos: ${tokens.scope}). Marque a permissão de envio na tela do Google.`);
    }
    const missing = scopes.filter((sc) => !granted.includes(sc));
    cached = null;
    await writeSecret(TOKEN_FILE, {
        refresh_token: tokens.refresh_token,
        access_token: tokens.access_token,
        expiry_date: Date.now() + (tokens.expires_in || 3600) * 1000,
        scope: tokens.scope,
        profile,
        client_id: client.client_id,
        obtained_at: new Date().toISOString(),
    });
    // Which channel did the user pick on Google's screen? (needs readonly or force-ssl)
    let channel = null;
    if (hasScope(granted, 'read')) {
        try {
            channel = await fetchMyChannel();
            await bindChannel(channel);
        } catch (err) {
            log(`Não consegui ler o canal autorizado: ${err.message}`);
        }
    }
    return { ...(await status()), channel, missing_permissions: missing.length ? missing : undefined };
}

// Valid access token, refreshed when it expires in less than a minute. Kept in
// memory between calls so the vault (DPAPI on Windows) is not reopened per request.
let cached = null;

export async function getAccessToken({ force = false } = {}) {
    if (!force && cached && cached.dir === youtubeDir() && cached.expiry - Date.now() > 60_000) return cached.token;
    const tok = await readSecret(TOKEN_FILE);
    if (!tok?.refresh_token) throw new AuthRequiredError('YouTube não autorizado. Rode: node claude-agent/bin/oga.mjs youtube auth');
    if (!force && tok.access_token && tok.expiry_date - Date.now() > 60_000) {
        cached = { dir: youtubeDir(), token: tok.access_token, expiry: tok.expiry_date };
        return tok.access_token;
    }
    const client = await loadClient();
    let fresh;
    try {
        fresh = await tokenRequest({
            client_id: client.client_id,
            client_secret: client.client_secret,
            refresh_token: tok.refresh_token,
            grant_type: 'refresh_token',
        });
    } catch (err) {
        if (err.code === 'invalid_grant') {
            throw new AuthRequiredError('A autorização do YouTube expirou ou foi revogada. Rode de novo: node claude-agent/bin/oga.mjs youtube auth. '
                + 'Se isso acontece a cada 7 dias, mude a tela de consentimento do Google Cloud de "Teste" para "Em produção" (veja YOUTUBE.md).');
        }
        throw err;
    }
    await writeSecret(TOKEN_FILE, {
        ...tok,
        access_token: fresh.access_token,
        expiry_date: Date.now() + (fresh.expires_in || 3600) * 1000,
        refresh_token: fresh.refresh_token || tok.refresh_token, // Google may rotate it
        refreshed_at: new Date().toISOString(),
    });
    cached = { dir: youtubeDir(), token: fresh.access_token, expiry: Date.now() + (fresh.expires_in || 3600) * 1000 };
    return fresh.access_token;
}

export async function revoke() {
    const tok = await readSecret(TOKEN_FILE).catch(() => null);
    let revoked = false;
    if (tok?.refresh_token) {
        const res = await fetch(endpoints().revoke, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ token: tok.refresh_token }).toString(),
        }).catch(() => null);
        revoked = Boolean(res?.ok);
    }
    deleteSecret(TOKEN_FILE);
    cached = null;
    return { revoked_at_google: revoked, local_token_deleted: true };
}

export async function forgetClient() {
    deleteSecret(CLIENT_FILE);
    return { client_deleted: true };
}

export async function status() {
    const client = secretInfo(CLIENT_FILE);
    const token = secretInfo(TOKEN_FILE);
    const out = {
        storage_dir: youtubeDir(),
        client_configured: Boolean(client) || Boolean(process.env.OGA_YT_CLIENT_SECRET),
        authorized: false,
        protection: token?.protection || client?.protection || protectionMode(),
        scope_profiles: { upload: PROFILES.upload.map((x) => x.split('/').pop()), manage: PROFILES.manage.map((x) => x.split('/').pop()) },
    };
    if (client) {
        try { out.client_id = mask((await readSecret(CLIENT_FILE)).client_id); } catch (err) { out.client_error = err.message; }
    }
    if (token) {
        try {
            const t = await readSecret(TOKEN_FILE);
            out.authorized = Boolean(t.refresh_token);
            out.profile = t.profile || 'upload';
            out.granted_scopes = String(t.scope || '').split(' ').filter(Boolean).map((x) => x.replace('https://www.googleapis.com/auth/', ''));
            out.can_publish_later = hasScope(t.scope, 'manage');
            out.channel = t.channel_id ? { id: t.channel_id, title: t.channel_title, custom_url: t.channel_url || null } : null;
            out.access_token_valid_for_s = Math.max(0, Math.round((t.expiry_date - Date.now()) / 1000));
            out.authorized_at = t.obtained_at;
            out.last_refresh = t.refreshed_at || null;
        } catch (err) {
            out.token_error = err.message;
        }
    }
    return out;
}


// ─── Scopes and the authorised channel ─────────────────────────────────────────
export function hasScope(granted, need) {
    const list = Array.isArray(granted) ? granted : String(granted || '').split(' ');
    if (need === 'read') return list.includes(SCOPES.readonly) || list.includes(SCOPES.manage) || list.includes('https://www.googleapis.com/auth/youtube');
    if (need === 'manage') return list.includes(SCOPES.manage) || list.includes('https://www.googleapis.com/auth/youtube');
    return list.includes(SCOPES.upload) || hasScope(list, 'manage');
}

export async function grantedScopes() {
    const tok = await readSecret(TOKEN_FILE);
    return String(tok?.scope || '').split(' ').filter(Boolean);
}

export async function requireScope(need, action) {
    if (hasScope(await grantedScopes(), need)) return;
    const how = need === 'manage'
        ? 'autorize com o perfil de gerenciamento: node claude-agent/bin/oga.mjs youtube auth --manage'
        : 'autorize de novo: node claude-agent/bin/oga.mjs youtube auth';
    throw new AuthRequiredError(`${action} exige uma permissão que esta autorização não tem; ${how}`);
}

// channels.list?mine=true — 1 quota unit. Returns the channel the token acts for.
export async function fetchMyChannel() {
    await requireScope('read', 'Ler o canal');
    const res = await fetch(`${endpoints().api}/youtube/v3/channels?part=snippet&mine=true`, {
        headers: { Authorization: `Bearer ${await getAccessToken()}` },
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`YouTube API HTTP ${res.status}: ${body.error?.message || 'erro ao ler o canal'}`);
    const item = (body.items || [])[0];
    if (!item) throw new Error('A conta autorizada não tem canal no YouTube. Autorize de novo escolhendo o canal correto.');
    return { id: item.id, title: item.snippet?.title || '', custom_url: item.snippet?.customUrl || null };
}

export async function bindChannel(channel) {
    const tok = await readSecret(TOKEN_FILE);
    await writeSecret(TOKEN_FILE, { ...tok, channel_id: channel.id, channel_title: channel.title, channel_url: channel.custom_url, channel_bound_at: new Date().toISOString() });
}

export async function boundChannel() {
    const tok = await readSecret(TOKEN_FILE);
    return tok?.channel_id ? { id: tok.channel_id, title: tok.channel_title, custom_url: tok.channel_url || null } : null;
}

const norm = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');

// Refuses to continue unless the token still acts for the expected channel.
export async function assertChannel(expected) {
    if (!hasScope(await grantedScopes(), 'read')) return null; // cannot check with upload-only tokens
    const live = await fetchMyChannel();
    const bound = await boundChannel();
    if (bound && bound.id !== live.id) {
        throw new Error(`O token agora aponta para o canal "${live.title}" (${live.id}), mas o canal vinculado é "${bound.title}" (${bound.id}). Envio bloqueado.`);
    }
    if (expected && live.id !== expected && norm(live.title) !== norm(expected) && norm(live.custom_url) !== norm(expected)) {
        throw new Error(`Canal autorizado: "${live.title}" (${live.id}); esperado: "${expected}". Envio bloqueado — autorize de novo escolhendo o canal certo.`);
    }
    return live;
}
