// OPTIONAL paid cloud provider (MuAPI, the backend the web/desktop studios use).
// Every call here costs credits. It is blocked unless the user opted in — see
// paidPolicy() in config.mjs — and the key is only ever read from the environment.
//
// Reuses the studio's own API client (packages/studio/src/muapi.js), so payloads
// match what the app sends for the same model id.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT, assertPaidAllowed } from '../config.mjs';

async function studio() {
    const url = pathToFileURL(path.join(REPO_ROOT, 'packages', 'studio', 'src', 'muapi.js')).href;
    return import(url);
}

async function save(url, outPath) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Download do resultado falhou: HTTP ${res.status}`);
    const ext = path.extname(new URL(url).pathname) || path.extname(outPath);
    const finalPath = outPath.replace(/\.[^.]+$/, ext);
    fs.mkdirSync(path.dirname(finalPath), { recursive: true });
    fs.writeFileSync(finalPath, Buffer.from(await res.arrayBuffer()));
    return finalPath;
}

export async function paidGenerateImage({ allow_paid: allowPaid, model, prompt, aspect_ratio: aspectRatio, seed, outPath }) {
    assertPaidAllowed(allowPaid);
    if (!model) throw new Error('Informe o id do modelo MuAPI (ex.: "flux-schnell").');
    const { generateImage } = await studio();
    const result = await generateImage(process.env.MUAPI_API_KEY, { model, prompt, aspect_ratio: aspectRatio, seed });
    if (!result?.url) throw new Error('MuAPI não retornou URL de imagem.');
    return { path: await save(result.url, outPath), model, engine: 'muapi (PAGO)', request_id: result.request_id };
}

export async function paidGenerateVideo({ allow_paid: allowPaid, model, prompt, aspect_ratio: aspectRatio, duration_seconds: duration, image_url: imageUrl, outPath }) {
    assertPaidAllowed(allowPaid);
    if (!model) throw new Error('Informe o id do modelo de vídeo MuAPI.');
    const api = await studio();
    const params = { model, prompt, aspect_ratio: aspectRatio, duration };
    let result;
    if (imageUrl) {
        if (!/^https?:\/\//.test(imageUrl)) throw new Error('Para image-to-video pago, image_url precisa ser uma URL http(s) pública.');
        result = await api.generateI2V(process.env.MUAPI_API_KEY, { ...params, image_url: imageUrl });
    } else {
        result = await api.generateVideo(process.env.MUAPI_API_KEY, params);
    }
    if (!result?.url) throw new Error('MuAPI não retornou URL de vídeo.');
    return { path: await save(result.url, outPath), model, engine: 'muapi (PAGO)', request_id: result.request_id };
}
