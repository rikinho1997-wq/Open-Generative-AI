// YouTube Data API v3 — videos.insert with the resumable upload protocol,
// plus thumbnails.set. https://developers.google.com/youtube/v3/guides/using_resumable_upload_protocol

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { probeMedia } from '../media.mjs';
import { assertChannel, endpoints, getAccessToken, grantedScopes, hasScope, requireScope } from './auth.mjs';
import { readJson, writeJson } from './vault.mjs';

export const PRIVACY = ['private', 'unlisted', 'public'];
export const CHUNK = 8 * 1024 * 1024; // must be a multiple of 256 KiB
const HISTORY = 'uploads.json';

const clean = (s) => String(s ?? '').replace(/[<>]/g, '').trim();

export function tagsLength(tags) {
    // YouTube counts the commas between tags and adds quotes around tags with spaces.
    return tags.reduce((n, t) => n + t.length + (t.includes(' ') ? 2 : 0), 0) + Math.max(0, tags.length - 1);
}

// Validates metadata against the API limits and builds the video resource.
export function buildVideoResource(meta, now = Date.now()) {
    const errors = [];
    const warnings = [];
    let title = clean(meta.title);
    if (!title) errors.push('Título obrigatório.');
    if (title !== String(meta.title ?? '').trim()) warnings.push('Removi os caracteres < e > do título (proibidos pela API).');
    if ([...title].length > 100) {
        title = [...title].slice(0, 100).join('');
        warnings.push('Título cortado em 100 caracteres (limite da API).');
    }
    let description = clean(meta.description);
    if (Buffer.byteLength(description, 'utf-8') > 5000) {
        while (Buffer.byteLength(description, 'utf-8') > 5000) description = description.slice(0, -1);
        warnings.push('Descrição cortada em 5000 bytes (limite da API).');
    }
    let tags = (meta.tags || []).map(clean).map((t) => t.replace(/,/g, ' ').trim()).filter(Boolean);
    tags = [...new Set(tags)];
    while (tags.length && tagsLength(tags) > 500) tags.pop();
    if (tags.length < (meta.tags || []).length) warnings.push('Algumas tags foram removidas (vazias, repetidas ou acima de 500 caracteres no total).');

    let privacy = meta.privacy || 'private';
    if (!PRIVACY.includes(privacy)) errors.push(`Visibilidade inválida: ${privacy} (use private, unlisted ou public).`);
    let publishAt;
    if (meta.publish_at) {
        const t = Date.parse(meta.publish_at);
        if (Number.isNaN(t)) errors.push(`publish_at inválido: ${meta.publish_at} (use ISO 8601, ex. 2026-12-01T18:00:00-03:00).`);
        else if (t <= now + 60_000) errors.push('publish_at precisa estar no futuro.');
        else {
            publishAt = new Date(t).toISOString();
            if (privacy !== 'private') {
                warnings.push('Agendamento exige vídeo privado até a hora marcada (regra da API): visibilidade ajustada para private.');
                privacy = 'private';
            }
        }
    }
    const status = {
        privacyStatus: privacy,
        selfDeclaredMadeForKids: Boolean(meta.made_for_kids),
        embeddable: meta.embeddable ?? true,
    };
    if (publishAt) status.publishAt = publishAt;
    if (typeof meta.contains_synthetic_media === 'boolean') status.containsSyntheticMedia = meta.contains_synthetic_media;
    if (meta.license) status.license = meta.license;
    const snippet = {
        title,
        description,
        tags,
        categoryId: String(meta.category_id || '28'),
    };
    if (meta.language) {
        snippet.defaultLanguage = meta.language;
        snippet.defaultAudioLanguage = meta.language;
    }
    // Since 16 Nov 2026 the API no longer assumes "no paid product placement":
    // declare it explicitly on every upload.
    const paidProductPlacementDetails = { hasPaidProductPlacement: Boolean(meta.paid_product_placement) };
    return { resource: { snippet, status, paidProductPlacementDetails }, errors, warnings };
}

function sha256File(file) {
    const h = crypto.createHash('sha256');
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(4 * 1024 * 1024);
    let n;
    try {
        while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
    } finally {
        fs.closeSync(fd);
    }
    return h.digest('hex');
}

async function apiError(res) {
    const text = await res.text();
    let msg = text.slice(0, 300);
    try {
        const j = JSON.parse(text);
        const reason = j.error?.errors?.[0]?.reason;
        msg = `${j.error?.message || msg}${reason ? ` (${reason})` : ''}`;
        if (reason === 'quotaExceeded') msg += ' — cota diária esgotada (padrão: 100 envios/dia no bucket de uploads e 10.000 unidades/dia para os demais métodos; zera à meia-noite do Pacífico).';
        if (reason === 'uploadLimitExceeded') msg += ' — limite de envios do canal atingido; tente mais tarde.';
    } catch { /* not JSON */ }
    const err = new Error(`YouTube API HTTP ${res.status}: ${msg}`);
    err.status = res.status;
    return err;
}

const sleep = (ms, signal) => new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener?.('abort', () => { clearTimeout(t); reject(new Error('Envio cancelado.')); }, { once: true });
});

// Wraps a request: refreshes the token on 401 and retries 5xx / network errors with backoff.
async function withRetries(fn, { signal, attempts = 8, log = () => {} } = {}) {
    let token = await getAccessToken();
    for (let i = 0; ; i++) {
        if (signal?.aborted) throw new Error('Envio cancelado.');
        let res;
        try {
            res = await fn(token);
        } catch (err) {
            if (i >= attempts) throw err;
            log(`Falha de rede (${err.message}); nova tentativa em ${2 ** Math.min(i, 5)} s`);
            await sleep(1000 * 2 ** Math.min(i, 5), signal);
            continue;
        }
        if (res.status === 401 && i < 2) {
            token = await getAccessToken({ force: true });
            continue;
        }
        if ([500, 502, 503, 504].includes(res.status) && i < attempts) {
            log(`YouTube respondeu ${res.status}; nova tentativa em ${2 ** Math.min(i, 5)} s`);
            await sleep(1000 * 2 ** Math.min(i, 5), signal);
            continue;
        }
        return res;
    }
}

export async function uploadVideo({ file, meta, chunkSize = CHUNK, onProgress = () => {}, log = () => {}, signal } = {}) {
    if (!file || !fs.existsSync(file)) throw new Error(`Vídeo não encontrado: ${file}`);
    if (path.extname(file).toLowerCase() !== '.mp4') throw new Error('Envie um arquivo .mp4.');
    const { resource, errors, warnings } = buildVideoResource(meta);
    if (errors.length) throw new Error(`Metadados inválidos: ${errors.join(' ')}`);
    const size = fs.statSync(file).size;
    const info = await probeMedia(file).catch(() => null);
    if (info && (!info.hasVideo || !info.hasAudio)) warnings.push('O arquivo não tem trilha de vídeo e de áudio.');
    const sha256 = sha256File(file);
    if (meta.sha256 && String(meta.sha256).toLowerCase() !== sha256) {
        warnings.push('O arquivo não é idêntico ao vídeo final indicado nos metadados (SHA-256 diferente).');
    }
    const history = readJson(HISTORY, []);
    const previous = history.find((h) => h.sha256 === sha256);
    if (previous && !meta.allow_duplicate) {
        throw new Error(`Este arquivo já foi enviado em ${previous.uploaded_at} (vídeo ${previous.video_id}, https://youtu.be/${previous.video_id}). `
            + 'Para enviar de novo mesmo assim, use allow_duplicate: true.');
    }
    const api = endpoints().api;
    // Make sure the token still acts for the right channel (when we can read it).
    const channel = await assertChannel(meta.expected_channel);

    // 1. Start a resumable session.
    const params = new URLSearchParams({ uploadType: 'resumable', part: 'snippet,status,paidProductPlacementDetails', notifySubscribers: String(Boolean(meta.notify_subscribers)) });
    const init = await withRetries((token) => fetch(`${api}/upload/youtube/v3/videos?${params}`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json; charset=UTF-8',
            'X-Upload-Content-Length': String(size),
            'X-Upload-Content-Type': 'video/mp4',
        },
        body: JSON.stringify(resource),
        signal,
    }), { signal, log });
    if (!init.ok) throw await apiError(init);
    const session = init.headers.get('location');
    if (!session) throw new Error('YouTube não devolveu o endereço da sessão de envio.');

    // 2. Send the bytes in chunks. After a network error or 5xx, ask the server
    //    how many bytes it has (Content-Range: bytes */size) and resume from there.
    const fd = fs.openSync(file, 'r');
    let offset = 0;
    let video = null;
    let failures = 0;
    const put = async (headers, body) => fetch(session, {
        method: 'PUT', redirect: 'manual', signal,
        headers: { Authorization: `Bearer ${await getAccessToken()}`, ...headers }, body,
    });
    try {
        while (!video) {
            if (signal?.aborted) throw new Error('Envio cancelado.');
            const end = Math.min(offset + chunkSize, size) - 1;
            const body = Buffer.alloc(end - offset + 1);
            fs.readSync(fd, body, 0, body.length, offset);
            let res = await put({ 'Content-Length': String(body.length), 'Content-Range': `bytes ${offset}-${end}/${size}` }, body).catch(() => null);
            if (res?.status === 401) {
                await getAccessToken({ force: true });
                continue;
            }
            if (!res || [500, 502, 503, 504].includes(res.status)) {
                if (++failures > 8) throw new Error('Envio interrompido: falhas repetidas de rede/servidor. Tente de novo mais tarde.');
                const wait = 1000 * 2 ** Math.min(failures - 1, 5);
                log(`Bloco não confirmado (${res ? `HTTP ${res.status}` : 'erro de rede'}); consultando o progresso em ${wait / 1000} s…`);
                await sleep(wait, signal);
                res = await put({ 'Content-Length': '0', 'Content-Range': `bytes */${size}` }).catch(() => null);
                if (!res || res.status === 401 || res.status >= 500) continue;
            }
            if (res.status === 308) {
                const range = res.headers.get('range');
                offset = range ? Number(range.split('-')[1]) + 1 : 0;
                failures = 0;
                onProgress(offset / size);
                continue;
            }
            if (res.status === 200 || res.status === 201) {
                video = await res.json();
                onProgress(1);
                break;
            }
            if (res.status === 404 || res.status === 410) throw new Error('A sessão de envio expirou no YouTube; envie de novo.');
            throw await apiError(res);
        }
    } finally {
        fs.closeSync(fd);
    }

    // 3. Optional custom thumbnail (needs a verified channel; failure is only a warning).
    //    Shorts: since 3 Nov 2026 thumbnails are supported, but only after processing.
    let thumbnail = null;
    if (meta.thumbnail) {
        try {
            if (!fs.existsSync(meta.thumbnail)) throw new Error(`arquivo não encontrado: ${meta.thumbnail}`);
            const img = fs.readFileSync(meta.thumbnail);
            if (img.length > 50 * 1024 * 1024) throw new Error('a thumbnail precisa ter no máximo 50 MB');
            const isShort = info && info.height > info.width && info.duration <= 180;
            if (isShort) {
                if (hasScope(await grantedScopes(), 'read')) {
                    log('Short: aguardando o YouTube terminar o processamento para aplicar a thumbnail…');
                    await waitForProcessing(video.id, { signal, log, timeoutMs: meta.processing_timeout_ms ?? 15 * 60_000 });
                } else {
                    warnings.push('Short: sem permissão de leitura para esperar o processamento; a thumbnail pode não ser aplicada.');
                }
            }
            const type = /\.png$/i.test(meta.thumbnail) ? 'image/png' : 'image/jpeg';
            const res = await withRetries((token) => fetch(`${api}/upload/youtube/v3/thumbnails/set?videoId=${encodeURIComponent(video.id)}&uploadType=media`, {
                method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': type }, body: img, signal,
            }), { signal, log });
            if (!res.ok) throw await apiError(res);
            thumbnail = 'definida';
        } catch (err) {
            thumbnail = `não definida: ${err.message}`;
            warnings.push(`Thumbnail não aplicada (${err.message}). Thumbnails personalizadas exigem canal verificado (youtube.com/verify).`);
        }
    }

    const returnedPrivacy = video.status?.privacyStatus;
    if (returnedPrivacy && returnedPrivacy !== resource.status.privacyStatus) {
        warnings.push(`Pedido: ${resource.status.privacyStatus}; o YouTube registrou: ${returnedPrivacy}. Desde 2/11/2026 projetos não `
            + 'auditados não são mais restritos ao privado, mas configurações da conta do criador podem forçar o privado (Central de Ajuda do YouTube).');
    }
    const result = {
        video_id: video.id,
        url: `https://youtu.be/${video.id}`,
        studio: `https://studio.youtube.com/video/${video.id}/edit`,
        title: resource.snippet.title,
        channel: channel ? { id: channel.id, title: channel.title } : null,
        privacy: returnedPrivacy || resource.status.privacyStatus,
        publish_at: video.status?.publishAt || resource.status.publishAt || null,
        upload_status: video.status?.uploadStatus || null,
        thumbnail,
        bytes: size,
        sha256,
        warnings,
    };
    history.push({ video_id: video.id, title: result.title, privacy: result.privacy, publish_at: result.publish_at, file: path.resolve(file), sha256, bytes: size, uploaded_at: new Date().toISOString() });
    writeJson(HISTORY, history);
    return result;
}

export function uploadHistory() {
    return readJson(HISTORY, []);
}


// ─── After upload: status, publication and scheduling ───────────────────────────
async function apiGet(pathAndQuery, { signal } = {}) {
    const res = await fetch(`${endpoints().api}${pathAndQuery}`, { headers: { Authorization: `Bearer ${await getAccessToken()}` }, signal });
    if (!res.ok) throw await apiError(res);
    return res.json();
}

// videos.list — 1 unit. Status, processing and title of up to 50 of your videos.
export async function getVideos(ids, { signal } = {}) {
    await requireScope('read', 'Consultar vídeos');
    const list = [...new Set(ids)].slice(0, 50);
    if (!list.length) return [];
    const data = await apiGet(`/youtube/v3/videos?part=snippet,status,processingDetails&id=${list.map(encodeURIComponent).join(',')}`, { signal });
    return (data.items || []).map((v) => ({
        video_id: v.id,
        title: v.snippet?.title,
        channel_id: v.snippet?.channelId,
        privacy: v.status?.privacyStatus,
        publish_at: v.status?.publishAt || null,
        upload_status: v.status?.uploadStatus,
        processing: v.processingDetails?.processingStatus || null,
        url: `https://youtu.be/${v.id}`,
    }));
}

export async function waitForProcessing(videoId, { signal, log = () => {}, timeoutMs = 15 * 60_000, intervalMs = 15_000 } = {}) {
    const until = Date.now() + timeoutMs;
    for (;;) {
        const [v] = await getVideos([videoId], { signal });
        const state = v?.processing;
        if (state === 'succeeded') return v;
        if (state === 'failed' || state === 'terminated') throw new Error(`o processamento do vídeo falhou (${state})`);
        if (Date.now() > until) throw new Error('o processamento ainda não terminou; aplique a thumbnail depois');
        log(`Processamento: ${state || 'aguardando'}…`);
        await sleep(intervalMs, signal);
    }
}

// Publish now, change visibility, or schedule a private, never-published video.
// videos.update (50 units) overwrites every status field it receives and clears
// the ones it does not — so the current status is read first and sent back.
export async function setVisibility(videoId, { privacy, publish_at: publishAtInput } = {}, { signal, now = Date.now() } = {}) {
    await requireScope('manage', 'Publicar ou agendar depois do envio');
    if (!videoId) throw new Error('Informe o ID do vídeo.');
    const data = await apiGet(`/youtube/v3/videos?part=status,snippet&id=${encodeURIComponent(videoId)}`, { signal });
    const current = (data.items || [])[0];
    if (!current) throw new Error(`Vídeo ${videoId} não encontrado neste canal.`);
    const status = {
        privacyStatus: current.status.privacyStatus,
        embeddable: current.status.embeddable,
        license: current.status.license,
        publicStatsViewable: current.status.publicStatsViewable,
    };
    let publishAt;
    if (publishAtInput) {
        const t = Date.parse(publishAtInput);
        if (Number.isNaN(t)) throw new Error(`Data inválida: ${publishAtInput} (use ISO 8601, ex. 2026-12-01T18:00:00-03:00).`);
        if (t <= now + 60_000) throw new Error('A data de agendamento precisa estar no futuro.');
        if (current.status.privacyStatus !== 'private') {
            throw new Error('Só é possível agendar um vídeo privado que nunca foi publicado (regra da API). Este vídeo já está '
                + `"${current.status.privacyStatus}".`);
        }
        publishAt = new Date(t).toISOString();
        status.privacyStatus = 'private';
        status.publishAt = publishAt;
    } else {
        if (!PRIVACY.includes(privacy)) throw new Error(`Visibilidade inválida: ${privacy} (use private, unlisted ou public).`);
        status.privacyStatus = privacy; // omitting publishAt cancels any previous schedule
    }
    for (const k of Object.keys(status)) if (status[k] === undefined) delete status[k];
    const res = await fetch(`${endpoints().api}/youtube/v3/videos?part=status`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${await getAccessToken()}`, 'Content-Type': 'application/json; charset=UTF-8' },
        body: JSON.stringify({ id: videoId, status }),
        signal,
    });
    if (!res.ok) throw await apiError(res);
    const updated = await res.json();
    const result = {
        video_id: videoId,
        title: current.snippet?.title,
        before: { privacy: current.status.privacyStatus, publish_at: current.status.publishAt || null },
        after: { privacy: updated.status?.privacyStatus, publish_at: updated.status?.publishAt || null },
        url: `https://youtu.be/${videoId}`,
    };
    const history = readJson(HISTORY, []);
    const entry = history.find((h) => h.video_id === videoId);
    if (entry) {
        entry.privacy = result.after.privacy;
        entry.publish_at = result.after.publish_at;
        entry.updated_at = new Date().toISOString();
        writeJson(HISTORY, history);
    }
    return result;
}
