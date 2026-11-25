// YouTube integration against a FAKE Google server on 127.0.0.1: OAuth (PKCE,
// state), token refresh, resumable upload with an injected 503, thumbnail.
// No real credentials, no network, no cost.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AuthRequiredError, SCOPE, SCOPES, authorize, endpoints, getAccessToken, importClientFile, revoke, status } from '../src/youtube/auth.mjs';
import { buildVideoResource, getVideos, setVisibility, tagsLength, uploadHistory, uploadVideo } from '../src/youtube/upload.mjs';
import { readSecret, writeSecret } from '../src/youtube/vault.mjs';

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function fakeGoogle() {
    const st = {
        challenge: null, redirect: null, received: Buffer.alloc(0), size: 0, fail503: true, meta: null, thumb: false, revoked: false, refreshes: 0,
        scopes: SCOPE, uploadParts: null, channel: { id: 'UCagora', snippet: { title: 'AGORA FAZ SENTIDO', customUrl: '@agorafazsentido' } },
        video: null, updates: [],
    };
    const videoDone = () => {
        st.video = {
            id: 'VID123',
            snippet: { title: st.meta.snippet.title, channelId: st.channel.id },
            status: { privacyStatus: st.meta.status.privacyStatus, publishAt: st.meta.status.publishAt, embeddable: true, license: 'youtube', publicStatsViewable: true, uploadStatus: 'uploaded' },
            processingDetails: { processingStatus: 'succeeded' },
        };
        return { id: 'VID123', status: { privacyStatus: st.meta.status.privacyStatus, uploadStatus: 'uploaded', publishAt: st.meta.status.publishAt } };
    };
    const server = http.createServer(async (req, res) => {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        const body = Buffer.concat(chunks);
        const u = new URL(req.url, 'http://x');
        const json = (code, obj, headers = {}) => { res.writeHead(code, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(obj)); };
        if (u.pathname === '/token') {
            const p = new URLSearchParams(body.toString());
            if (p.get('client_secret') !== 'segredo-teste') return json(401, { error: 'invalid_client' });
            if (p.get('grant_type') === 'authorization_code') {
                const ok = p.get('code') === 'codigo-ok' && p.get('redirect_uri') === st.redirect
                    && b64url(crypto.createHash('sha256').update(p.get('code_verifier')).digest()) === st.challenge;
                return ok ? json(200, { access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600, scope: st.scopes, token_type: 'Bearer' })
                    : json(400, { error: 'invalid_grant', error_description: 'PKCE/redirect mismatch' });
            }
            if (p.get('grant_type') === 'refresh_token') {
                st.refreshes++;
                return p.get('refresh_token') === 'rt-1' ? json(200, { access_token: `at-${st.refreshes + 1}`, expires_in: 3600 })
                    : json(400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' });
            }
        }
        if (u.pathname === '/revoke') { st.revoked = true; return json(200, {}); }
        if (!/^Bearer at-\d+$/.test(req.headers.authorization || '')) return json(401, { error: { message: 'Invalid Credentials' } });
        if (u.pathname === '/youtube/v3/channels') return json(200, { items: [st.channel] });
        if (u.pathname === '/youtube/v3/videos' && req.method === 'GET') return json(200, { items: st.video ? [st.video] : [] });
        if (u.pathname === '/youtube/v3/videos' && req.method === 'PUT') {
            const upd = JSON.parse(body.toString());
            st.updates.push({ part: u.searchParams.get('part'), body: upd });
            // Like the real API: the status part is replaced; fields not sent are cleared.
            st.video.status = { ...upd.status, uploadStatus: 'processed' };
            return json(200, st.video);
        }
        if (u.pathname === '/upload/youtube/v3/videos' && req.method === 'POST') {
            st.uploadParts = u.searchParams.get('part');
            st.meta = JSON.parse(body.toString());
            st.size = Number(req.headers['x-upload-content-length']);
            res.writeHead(200, { Location: `http://127.0.0.1:${server.address().port}/session/1` });
            return res.end();
        }
        if (u.pathname === '/session/1' && req.method === 'PUT') {
            const range = req.headers['content-range'];
            if (range === `bytes */${st.size}`) {
                if (st.received.length === st.size) return json(201, videoDone());
                res.writeHead(308, st.received.length ? { Range: `bytes=0-${st.received.length - 1}` } : {});
                return res.end();
            }
            const m = /bytes (\d+)-(\d+)\/(\d+)/.exec(range);
            const start = Number(m[1]);
            if (start !== st.received.length) return json(400, { error: { message: 'bad offset' } });
            if (start > 0 && st.fail503) { // half of this chunk arrives, then the server fails
                st.fail503 = false;
                st.received = Buffer.concat([st.received, body.subarray(0, body.length >> 1)]);
                return json(503, { error: { message: 'backend error' } });
            }
            st.received = Buffer.concat([st.received, body]);
            if (st.received.length === st.size) return json(201, videoDone());
            res.writeHead(308, { Range: `bytes=0-${st.received.length - 1}` });
            return res.end();
        }
        if (u.pathname === '/upload/youtube/v3/thumbnails/set') { st.thumb = u.searchParams.get('videoId'); return json(200, { items: [] }); }
        json(404, { error: { message: 'not found' } });
    });
    return { server, st };
}

async function withEnv(vars, fn) {
    const saved = {};
    for (const [k, v] of Object.entries(vars)) { saved[k] = process.env[k]; process.env[k] = v; }
    try { return await fn(); } finally {
        for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'oga-yt-'));

test('vault encrypts with a passphrase and keeps files private', async () => {
    const dir = tmp();
    await withEnv({ OGA_YT_DIR: dir, OGA_YT_PASSPHRASE: 'frase-de-teste-longa' }, async () => {
        const file = await writeSecret('token.json', { refresh_token: 'segredo-super-secreto' });
        const raw = fs.readFileSync(file, 'utf-8');
        assert.ok(!raw.includes('segredo-super-secreto'), 'token must not be stored in clear text');
        assert.equal(JSON.parse(raw).protection, 'aes-256-gcm');
        if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
        assert.equal((await readSecret('token.json')).refresh_token, 'segredo-super-secreto');
        process.env.OGA_YT_PASSPHRASE = 'senha-errada';
        await assert.rejects(readSecret('token.json'), /incorreta/);
    });
});

test('credentials can never be stored inside the repository', async () => {
    await withEnv({ OGA_YT_DIR: path.join(process.cwd(), 'tmp-yt') }, async () => {
        await assert.rejects(writeSecret('x.json', {}), /dentro do repositório/);
    });
});

test('client file import rejects web clients and accepts desktop clients', async () => {
    const dir = tmp();
    await withEnv({ OGA_YT_DIR: dir, OGA_YT_PASSPHRASE: '' }, async () => {
        const web = path.join(dir, 'web.json');
        fs.writeFileSync(web, JSON.stringify({ web: { client_id: 'a', client_secret: 'b' } }));
        await assert.rejects(importClientFile(web), /App para computador/);
        const desk = path.join(tmp(), 'client_secret_123.json');
        fs.writeFileSync(desk, JSON.stringify({ installed: { client_id: '1234567890-abcdefghijklmnop.apps.googleusercontent.com', client_secret: 'segredo-teste', project_id: 'agora-faz-sentido' } }));
        const r = await importClientFile(desk);
        assert.equal(r.project_id, 'agora-faz-sentido');
        assert.ok(!r.client_id.includes('abcdefghijklmnop.apps'), 'client id is masked');
        const s = await status();
        assert.equal(s.client_configured, true);
        assert.equal(s.authorized, false);
    });
});

test('endpoint overrides must be https or loopback', () => {
    assert.throws(() => endpoints({ OGA_YT_TOKEN_URL: 'http://evil.example.com/token' }), /https/);
    assert.equal(endpoints({ OGA_YT_TOKEN_URL: 'http://127.0.0.1:9/token' }).token, 'http://127.0.0.1:9/token');
    assert.equal(endpoints({}).token, 'https://oauth2.googleapis.com/token');
});

test('metadata follows the YouTube API rules', () => {
    const now = Date.parse('2026-11-25T12:00:00Z');
    const r = buildVideoResource({
        title: 'Título <com> sinais ' + 'x'.repeat(120),
        description: 'ok',
        tags: ['trânsito', 'trânsito', 'efeito sanfona', 'a,b'],
        privacy: 'public',
        publish_at: '2026-12-01T18:00:00-03:00',
        language: 'pt-BR',
    }, now);
    assert.deepEqual(r.errors, []);
    assert.equal([...r.resource.snippet.title].length, 100);
    assert.ok(!/[<>]/.test(r.resource.snippet.title));
    assert.equal(r.resource.status.privacyStatus, 'private', 'scheduling forces private');
    assert.equal(r.resource.status.publishAt, '2026-12-01T21:00:00.000Z');
    assert.deepEqual(r.resource.snippet.tags, ['trânsito', 'efeito sanfona', 'a b']);
    assert.equal(r.resource.snippet.defaultAudioLanguage, 'pt-BR');
    assert.equal(r.resource.status.selfDeclaredMadeForKids, false);
    assert.ok(r.warnings.some((w) => /private/.test(w)));
    assert.equal(tagsLength(['a b', 'cd']), 3 + 2 + 2 + 1);
    const many = buildVideoResource({ title: 'x', tags: Array.from({ length: 80 }, (_, i) => `tag numero ${i}`) }, now);
    assert.ok(tagsLength(many.resource.snippet.tags) <= 500);
    assert.match(buildVideoResource({ title: 'x', publish_at: '2020-01-01T00:00:00Z' }, now).errors.join(), /futuro/);
    assert.match(buildVideoResource({ title: 'x', privacy: 'secret' }, now).errors.join(), /inválida/);
    assert.equal(buildVideoResource({ title: 'x' }, now).resource.status.privacyStatus, 'private', 'private by default');
});

test('OAuth loopback + PKCE, encrypted tokens, resumable upload with a 503, thumbnail, history, refresh, revoke', async () => {
    const { server, st } = fakeGoogle();
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const dir = tmp();
    const env = {
        OGA_YT_DIR: dir, OGA_YT_PASSPHRASE: 'frase-de-teste-longa',
        OGA_YT_AUTH_URL: `${base}/auth`, OGA_YT_TOKEN_URL: `${base}/token`, OGA_YT_REVOKE_URL: `${base}/revoke`, OGA_YT_API_BASE: base,
    };
    try {
        await withEnv(env, async () => {
            const clientFile = path.join(tmp(), 'client.json');
            fs.writeFileSync(clientFile, JSON.stringify({ installed: { client_id: 'id-teste.apps.googleusercontent.com', client_secret: 'segredo-teste' } }));
            await importClientFile(clientFile);

            // A fake "browser": checks the consent URL, then redirects back like Google does.
            const browser = (url) => {
                const u = new URL(url);
                assert.equal(u.searchParams.get('scope'), `${SCOPES.upload} ${SCOPES.readonly}`);
                assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
                assert.equal(u.searchParams.get('access_type'), 'offline');
                assert.equal(u.searchParams.get('prompt'), 'select_account consent', 'account/channel picker always shown');
                st.challenge = u.searchParams.get('code_challenge');
                st.redirect = u.searchParams.get('redirect_uri');
                assert.match(st.redirect, /^http:\/\/127\.0\.0\.1:\d+\/oauth2callback$/);
                setTimeout(() => fetch(`${st.redirect}?code=codigo-ok&state=${u.searchParams.get('state')}`), 20);
                return true;
            };
            const s = await authorize({ open: browser, timeoutMs: 5000 });
            assert.equal(s.authorized, true);
            assert.equal(s.protection, 'aes-256-gcm');
            assert.ok(!fs.readFileSync(path.join(dir, 'token.json'), 'utf-8').includes('rt-1'));

            const video = path.join(tmp(), 'ep.mp4');
            const bytes = crypto.randomBytes(1_200_000);
            fs.writeFileSync(video, bytes);
            const thumb = path.join(tmp(), 'thumb.jpg');
            fs.writeFileSync(thumb, crypto.randomBytes(2000));
            const progress = [];
            const r = await uploadVideo({
                file: video,
                chunkSize: 256 * 1024,
                meta: { title: 'Congestionamento fantasma', description: 'desc', tags: ['ciência'], publish_at: '2030-01-01T12:00:00Z', thumbnail: thumb, language: 'pt-BR' },
                onProgress: (p) => progress.push(p),
            });
            assert.equal(r.video_id, 'VID123');
            assert.equal(r.url, 'https://youtu.be/VID123');
            assert.equal(r.privacy, 'private');
            assert.equal(r.publish_at, '2030-01-01T12:00:00.000Z');
            assert.equal(r.thumbnail, 'definida');
            assert.ok(st.received.equals(bytes), 'server received exactly the file, despite the 503');
            assert.equal(st.fail503, false);
            assert.equal(st.meta.snippet.title, 'Congestionamento fantasma');
            assert.equal(st.meta.status.privacyStatus, 'private');
            assert.deepEqual(st.meta.paidProductPlacementDetails, { hasPaidProductPlacement: false }, 'explicit since 16 Nov 2026');
            assert.equal(st.uploadParts, 'snippet,status,paidProductPlacementDetails');
            assert.equal(st.thumb, 'VID123');
            assert.equal(progress.at(-1), 1);
            assert.equal(uploadHistory().length, 1);
            await assert.rejects(uploadVideo({ file: video, meta: { title: 'de novo' } }), /já foi enviado/);

            // Expired access token → refreshed with the stored refresh token.
            const tok = await readSecret('token.json');
            await writeSecret('token.json', { ...tok, expiry_date: Date.now() - 1000 });
            assert.equal(await getAccessToken({ force: true }), `at-${st.refreshes + 1}`);
            // Revoked refresh token → clear instruction to re-authorise.
            await writeSecret('token.json', { ...(await readSecret('token.json')), refresh_token: 'revoked', expiry_date: 0 });
            await assert.rejects(getAccessToken({ force: true }), (err) => err instanceof AuthRequiredError && /youtube auth/.test(err.message));

            await writeSecret('token.json', { ...(await readSecret('token.json')), refresh_token: 'rt-1' });
            const rv = await revoke();
            assert.equal(rv.revoked_at_google, true);
            assert.equal(st.revoked, true);
            assert.equal(fs.existsSync(path.join(dir, 'token.json')), false);
        });
    } finally {
        server.close();
    }
});

test('a callback with the wrong state is refused', async () => {
    const dir = tmp();
    await withEnv({ OGA_YT_DIR: dir, OGA_YT_PASSPHRASE: 'x-teste', OGA_YT_AUTH_URL: 'http://127.0.0.1:9/auth' }, async () => {
        const f = path.join(tmp(), 'c.json');
        fs.writeFileSync(f, JSON.stringify({ installed: { client_id: 'id', client_secret: 's' } }));
        await importClientFile(f);
        const browser = (url) => {
            const redirect = new URL(url).searchParams.get('redirect_uri');
            setTimeout(() => fetch(`${redirect}?code=x&state=forjado`).catch(() => {}), 20);
            return true;
        };
        await assert.rejects(authorize({ open: browser, timeoutMs: 5000 }), /state inválido/);
    });
});

test('manage profile: channel is bound, a different channel is blocked, publish and schedule keep other status fields', async () => {
    const { server, st } = fakeGoogle();
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const dir = tmp();
    const env = {
        OGA_YT_DIR: dir, OGA_YT_PASSPHRASE: 'frase-de-teste-longa',
        OGA_YT_AUTH_URL: `${base}/auth`, OGA_YT_TOKEN_URL: `${base}/token`, OGA_YT_REVOKE_URL: `${base}/revoke`, OGA_YT_API_BASE: base,
    };
    try {
        await withEnv(env, async () => {
            const clientFile = path.join(tmp(), 'client.json');
            fs.writeFileSync(clientFile, JSON.stringify({ installed: { client_id: 'id-teste', client_secret: 'segredo-teste' } }));
            await importClientFile(clientFile);
            const browser = (url) => {
                const u = new URL(url);
                st.scopes = u.searchParams.get('scope'); // Google grants what was asked
                st.challenge = u.searchParams.get('code_challenge');
                st.redirect = u.searchParams.get('redirect_uri');
                setTimeout(() => fetch(`${st.redirect}?code=codigo-ok&state=${u.searchParams.get('state')}`), 20);
                return true;
            };
            const s = await authorize({ open: browser, timeoutMs: 5000, profile: 'manage' });
            assert.equal(st.scopes, `${SCOPES.upload} ${SCOPES.manage}`);
            assert.equal(s.channel.title, 'AGORA FAZ SENTIDO');
            assert.equal(s.can_publish_later, true);
            assert.equal((await status()).channel.id, 'UCagora');

            const video = path.join(tmp(), 'ep.mp4');
            fs.writeFileSync(video, crypto.randomBytes(300_000));
            st.fail503 = false;
            const r = await uploadVideo({ file: video, chunkSize: 256 * 1024, meta: { title: 'Teste', expected_channel: 'Agora Faz Sentido' } });
            assert.equal(r.channel.id, 'UCagora');
            assert.equal(r.privacy, 'private');

            // Publish later: current status is read and sent back (embeddable, license… kept).
            const pub = await setVisibility('VID123', { privacy: 'public' });
            assert.equal(pub.before.privacy, 'private');
            assert.equal(pub.after.privacy, 'public');
            const sent = st.updates.at(-1);
            assert.equal(sent.part, 'status');
            assert.deepEqual(sent.body.status, { privacyStatus: 'public', embeddable: true, license: 'youtube', publicStatsViewable: true });
            // Scheduling a video that is already public is refused (API rule).
            await assert.rejects(setVisibility('VID123', { publish_at: '2030-01-01T12:00:00Z' }), /nunca foi publicado/);
            // Scheduling a private video works and keeps it private until then.
            st.video.status.privacyStatus = 'private';
            const sch = await setVisibility('VID123', { publish_at: '2030-01-01T09:00:00-03:00' });
            assert.deepEqual(sch.after, { privacy: 'private', publish_at: '2030-01-01T12:00:00.000Z' });
            await assert.rejects(setVisibility('VID123', { publish_at: '2001-01-01T00:00:00Z' }), /futuro/);
            assert.equal((await getVideos(['VID123']))[0].processing, 'succeeded');
            assert.equal(uploadHistory().at(-1).publish_at, '2030-01-01T12:00:00.000Z');

            // The token now acts for another channel → uploads are blocked.
            st.channel = { id: 'UCoutro', snippet: { title: 'Outro canal' } };
            fs.writeFileSync(video, crypto.randomBytes(1000));
            await assert.rejects(uploadVideo({ file: video, meta: { title: 'x' } }), /bloqueado/);
        });
    } finally {
        server.close();
    }
});

test('publishing later needs the manage permission', async () => {
    const dir = tmp();
    await withEnv({ OGA_YT_DIR: dir, OGA_YT_PASSPHRASE: 'x-teste' }, async () => {
        await writeSecret('token.json', { refresh_token: 'r', access_token: 'a', expiry_date: Date.now() + 3600e3, scope: `${SCOPES.upload} ${SCOPES.readonly}` });
        await assert.rejects(setVisibility('VID', { privacy: 'public' }), /--manage/);
    });
});
