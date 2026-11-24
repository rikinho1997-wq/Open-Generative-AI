// Resumable downloads. Uses the desktop app's downloader (electron/lib/localInferenceDownload.js).
// Node's built-in fetch ignores HTTPS_PROXY unless NODE_USE_ENV_PROXY=1, so behind a
// proxy without that flag we fall back to curl, which reads the proxy settings itself.

import fs from 'node:fs';
import path from 'node:path';
import { repoModule, which } from './config.mjs';
import { run } from './proc.mjs';

function behindProxyWithoutNodeSupport(env = process.env) {
    const proxy = env.HTTPS_PROXY || env.https_proxy;
    return Boolean(proxy) && env.NODE_USE_ENV_PROXY !== '1';
}

export async function downloadTo(url, destPath, { onProgress, signal } = {}) {
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    if (fs.existsSync(destPath)) return destPath;

    const curl = which('curl');
    if (behindProxyWithoutNodeSupport() && curl) {
        const part = `${destPath}.part`;
        await run(curl, ['-L', '--fail', '--retry', '3', '-C', '-', '-s', '-o', part, url], { signal });
        fs.renameSync(part, destPath);
        onProgress?.(1);
        return destPath;
    }

    const { downloadFile } = repoModule('electron/lib/localInferenceDownload.js');
    await downloadFile(url, destPath, (p) => onProgress?.(p));
    return destPath;
}
