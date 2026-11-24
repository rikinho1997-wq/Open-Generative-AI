// Child-process helpers. Commands are always spawned without a shell, so
// prompts and narration text can never be interpreted as shell syntax.

import { spawn } from 'node:child_process';

const OUTPUT_CAP = 256 * 1024;

export function run(command, args, { cwd, env, input, signal, onOutput, timeoutMs } = {}) {
    return new Promise((resolve, reject) => {
        if (!command) {
            reject(new Error('Executable not found'));
            return;
        }
        let stdout = '';
        let stderr = '';
        let settled = false;
        const child = spawn(command, args, {
            cwd,
            env: env || process.env,
            windowsHide: true,
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        const finish = (fn, value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            signal?.removeEventListener?.('abort', onAbort);
            fn(value);
        };
        const onAbort = () => {
            child.kill('SIGTERM');
            finish(reject, new Error('Cancelado'));
        };
        const timer = timeoutMs ? setTimeout(() => {
            child.kill('SIGKILL');
            finish(reject, new Error(`${command} excedeu o tempo limite de ${Math.round(timeoutMs / 1000)} s`));
        }, timeoutMs) : null;
        if (signal) {
            if (signal.aborted) return onAbort();
            signal.addEventListener('abort', onAbort, { once: true });
        }
        child.stdout.on('data', (d) => {
            const text = d.toString();
            stdout = (stdout + text).slice(-OUTPUT_CAP);
            onOutput?.(text);
        });
        child.stderr.on('data', (d) => {
            const text = d.toString();
            stderr = (stderr + text).slice(-OUTPUT_CAP);
            onOutput?.(text);
        });
        child.on('error', (err) => finish(reject, new Error(`Não foi possível executar ${command}: ${err.message}`)));
        child.on('close', (code, sig) => {
            if (code === 0) {
                finish(resolve, { stdout, stderr, code });
            } else {
                const tail = stderr.trim().split('\n').slice(-12).join('\n');
                const err = new Error(`${command} terminou com código ${code ?? sig}:\n${tail}`);
                err.stdout = stdout;
                err.stderr = stderr;
                err.code = code;
                finish(reject, err);
            }
        });
        if (input !== undefined) child.stdin.end(input);
        else child.stdin.end();
    });
}
