// Talks to the real MCP server over stdio, as Claude Code does. Offline, no cost.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'server.mjs');

test('MCP server exposes the tools and enforces the free-first policy', async () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'oga-mcp-'));
    const env = { ...process.env, OGA_OUTPUT_DIR: out, MUAPI_API_KEY: '', OGA_ALLOW_PAID: '', OGA_YT_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'oga-mcp-yt-')) };
    const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER], env, stderr: 'ignore' });
    const client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(transport);
    try {
        const { tools } = await client.listTools();
        const names = tools.map((t) => t.name).sort();
        assert.deepEqual(names, [
            'oga_cancel_job', 'oga_configure_wan2gp', 'oga_doctor', 'oga_download_model', 'oga_generate_image',
            'oga_generate_video_clip', 'oga_job_status', 'oga_list_models', 'oga_produce_video', 'oga_text_to_speech',
            'oga_youtube_authorize', 'oga_youtube_logout', 'oga_youtube_status', 'oga_youtube_upload',
        ]);
        const yt = tools.find((t) => t.name === 'oga_youtube_upload');
        assert.deepEqual(yt.inputSchema.properties.privacy.enum, ['private', 'unlisted', 'public']);
        const ytStatus = JSON.parse((await client.callTool({ name: 'oga_youtube_status', arguments: {} })).content[0].text);
        assert.equal(ytStatus.authorized, false);
        assert.ok(!JSON.stringify(ytStatus).includes('client_secret'));
        const produce = tools.find((t) => t.name === 'oga_produce_video');
        assert.ok(produce.inputSchema.properties.storyboard, 'storyboard schema is published to the client');

        const doctor = await client.callTool({ name: 'oga_doctor', arguments: {} });
        const report = JSON.parse(doctor.content[0].text);
        assert.equal(report.max_video_seconds, 120);
        assert.match(report.capabilities.api_paga_muapi, /bloqueada/);

        const dry = await client.callTool({
            name: 'oga_produce_video',
            arguments: { dry_run: true, storyboard: { title: 'T', scenes: [{ narration: 'Olá mundo.', visual: { type: 'color' } }] } },
        });
        const plan = JSON.parse(dry.content[0].text);
        assert.equal(plan.ok, true);
        assert.match(plan.cost, /gratuito/);

        const paid = await client.callTool({ name: 'oga_generate_image', arguments: { prompt: 'a cat', provider: 'muapi', allow_paid: true } });
        assert.equal(paid.isError, true);
        assert.match(paid.content[0].text, /bloqueado/);

        const models = await client.callTool({ name: 'oga_list_models', arguments: { kind: 'image' } });
        const list = JSON.parse(models.content[0].text);
        assert.ok(list.image_local_free.some((m) => m.id === 'dreamshaper-8'));
        assert.ok(list.image_local_free.every((m) => /gratuito/.test(m.cost)));

        const jobs = await client.callTool({ name: 'oga_job_status', arguments: {} });
        assert.deepEqual(JSON.parse(jobs.content[0].text), []);
    } finally {
        await client.close();
        fs.rmSync(out, { recursive: true, force: true });
    }
});
