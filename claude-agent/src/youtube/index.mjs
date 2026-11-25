// Shared entry points for the MCP tools and the CLI.

import fs from 'node:fs';
import path from 'node:path';
import { authorize, boundChannel, fetchMyChannel, forgetClient, importClientFile, revoke, status } from './auth.mjs';
import { getVideos, setVisibility, uploadHistory, uploadVideo } from './upload.mjs';

export { authorize, boundChannel, fetchMyChannel, forgetClient, getVideos, importClientFile, revoke, setVisibility, status, uploadHistory };

// Merges a metadata JSON file (e.g. productions/.../youtube-ep01.json) with explicit
// fields; explicit fields win. Relative paths are resolved from the current folder.
export function resolveUploadRequest(args = {}) {
    let fromFile = {};
    if (args.metadata_file) {
        if (!fs.existsSync(args.metadata_file)) throw new Error(`Arquivo de metadados não encontrado: ${args.metadata_file}`);
        fromFile = JSON.parse(fs.readFileSync(args.metadata_file, 'utf-8'));
    }
    const merged = { ...fromFile };
    for (const [k, v] of Object.entries(args)) if (v !== undefined && k !== 'metadata_file') merged[k] = v;
    if (merged.description_file && !merged.description) merged.description = fs.readFileSync(merged.description_file, 'utf-8');
    if (!merged.file) throw new Error('Informe o arquivo de vídeo (file).');
    merged.file = path.resolve(merged.file);
    if (merged.thumbnail) merged.thumbnail = path.resolve(merged.thumbnail);
    if (typeof merged.tags === 'string') merged.tags = merged.tags.split(',').map((t) => t.trim()).filter(Boolean);
    return merged;
}

export async function upload(args, { onProgress, log, signal } = {}) {
    const req = resolveUploadRequest(args);
    return uploadVideo({ file: req.file, meta: req, onProgress, log, signal });
}
