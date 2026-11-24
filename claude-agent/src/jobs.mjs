// Background jobs. Generation is CPU/GPU-bound, so heavy jobs run one at a time
// in a queue; tools start a job, wait a bounded time, and hand back a job id when
// it is still running (MCP clients time out long tool calls).

import crypto from 'node:crypto';

const jobs = new Map();
let queue = Promise.resolve();

function publicView(job) {
    return {
        job_id: job.id,
        kind: job.kind,
        description: job.description,
        status: job.status,
        stage: job.stage,
        progress: Math.round(job.progress * 100),
        messages: job.messages.slice(-8),
        started_at: job.startedAt,
        finished_at: job.finishedAt,
        elapsed_seconds: job.startedAt ? Math.round(((job.finishedAt ? Date.parse(job.finishedAt) : Date.now()) - Date.parse(job.startedAt)) / 1000) : 0,
        ...(job.status === 'done' ? { result: job.result } : {}),
        ...(job.error ? { error: job.error } : {}),
    };
}

export function startJob(kind, description, fn) {
    const controller = new AbortController();
    const job = {
        id: `${kind}-${crypto.randomBytes(4).toString('hex')}`,
        kind,
        description,
        status: 'queued',
        stage: 'na fila',
        progress: 0,
        messages: [],
        createdAt: new Date().toISOString(),
        startedAt: null,
        finishedAt: null,
        result: null,
        error: null,
        controller,
        waiters: new Set(),
    };
    jobs.set(job.id, job);
    const notify = () => {
        for (const resolve of job.waiters) resolve();
        job.waiters.clear();
    };
    const ctx = {
        signal: controller.signal,
        progress(stage, value, message) {
            if (stage) job.stage = stage;
            if (typeof value === 'number') job.progress = Math.max(job.progress, Math.min(1, value));
            if (message) job.messages.push(message);
        },
        log(message) {
            job.messages.push(message);
        },
    };
    queue = queue.then(async () => {
        if (controller.signal.aborted) {
            job.status = 'cancelled';
            job.finishedAt = new Date().toISOString();
            notify();
            return;
        }
        job.status = 'running';
        job.stage = 'iniciando';
        job.startedAt = new Date().toISOString();
        try {
            job.result = await fn(ctx);
            job.status = 'done';
            job.progress = 1;
            job.stage = 'concluído';
        } catch (err) {
            job.status = controller.signal.aborted ? 'cancelled' : 'error';
            job.error = err?.message || String(err);
        } finally {
            job.finishedAt = new Date().toISOString();
            notify();
        }
    });
    return job;
}

export function getJob(id) {
    return jobs.get(id) || null;
}

export function listJobs() {
    return [...jobs.values()].map(publicView);
}

export function cancelJob(id) {
    const job = jobs.get(id);
    if (!job) return null;
    if (job.status === 'queued' || job.status === 'running') job.controller.abort();
    return publicView(job);
}

// Resolve when the job finishes or after `seconds`, whichever comes first.
export async function waitForJob(id, seconds) {
    const job = jobs.get(id);
    if (!job) return null;
    if (['done', 'error', 'cancelled'].includes(job.status) || !(seconds > 0)) return publicView(job);
    await new Promise((resolve) => {
        const timer = setTimeout(() => {
            job.waiters.delete(done);
            resolve();
        }, seconds * 1000);
        const done = () => {
            clearTimeout(timer);
            resolve();
        };
        job.waiters.add(done);
    });
    return publicView(job);
}

export { publicView };
