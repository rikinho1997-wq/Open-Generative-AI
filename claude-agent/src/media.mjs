// ffmpeg building blocks: scene clips (Ken Burns on stills, fitted AI clips,
// title cards), transitions (xfade), burned-in subtitles, narration + music mix
// with ducking and loudness normalisation.
//
// ffmpeg always runs with cwd = the project folder and refers to subtitle, text
// and font files by RELATIVE name, which sidesteps filter-graph path escaping
// (drive letters and backslashes on Windows).

import fs from 'node:fs';
import path from 'node:path';
import { IS_WINDOWS, resolveBinaries } from './config.mjs';
import { run } from './proc.mjs';

export const TRANSITIONS = [
    'fade', 'fadeblack', 'fadewhite', 'dissolve', 'wipeleft', 'wiperight', 'wipeup', 'wipedown',
    'slideleft', 'slideright', 'slideup', 'slidedown', 'smoothleft', 'smoothright', 'circleopen',
    'circleclose', 'radial', 'pixelize', 'zoomin', 'hblur', 'cut',
];
export const MOTIONS = ['zoom_in', 'zoom_out', 'pan_left', 'pan_right', 'pan_up', 'pan_down', 'static'];
const AUTO_MOTIONS = ['zoom_in', 'pan_right', 'zoom_out', 'pan_left'];

const X264 = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p'];

function bins() {
    const b = resolveBinaries();
    if (!b.ffmpeg || !b.ffprobe) throw new Error('ffmpeg/ffprobe não encontrados no PATH (instale o FFmpeg).');
    return b;
}

export async function ffmpeg(args, { cwd, signal } = {}) {
    return run(bins().ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { cwd, signal });
}

export async function probeMedia(file) {
    const { stdout } = await run(bins().ffprobe, [
        '-v', 'error', '-show_entries', 'format=duration:stream=codec_type,width,height', '-of', 'json', file,
    ]);
    const data = JSON.parse(stdout);
    const video = (data.streams || []).find((s) => s.codec_type === 'video');
    return {
        duration: Number(data.format?.duration) || 0,
        width: video?.width || 0,
        height: video?.height || 0,
        hasVideo: Boolean(video),
        hasAudio: (data.streams || []).some((s) => s.codec_type === 'audio'),
    };
}

export async function probeDuration(file) {
    return (await probeMedia(file)).duration;
}

export function outputSize(aspectRatio = '16:9', resolution = '720p') {
    const short = resolution === '1080p' ? 1080 : resolution === '480p' ? 480 : 720;
    const long = Math.round((short * 16) / 9 / 2) * 2;
    if (aspectRatio === '9:16') return { width: short, height: long };
    if (aspectRatio === '1:1') return { width: short, height: short };
    return { width: long, height: short };
}

export function pickMotion(motion, index) {
    if (!motion || motion === 'auto') return AUTO_MOTIONS[index % AUTO_MOTIONS.length];
    return MOTIONS.includes(motion) ? motion : 'zoom_in';
}

// zoompan expressions; `on` is the output frame index, N the frame count.
export function kenBurnsFilter({ width, height, fps, frames, motion }) {
    const n = Math.max(1, frames - 1);
    const z = 0.16;
    const centerX = '(iw-iw/zoom)/2';
    const centerY = '(ih-ih/zoom)/2';
    const exprs = {
        zoom_in: { z: `1+${z}*on/${n}`, x: centerX, y: centerY },
        zoom_out: { z: `${1 + z}-${z}*on/${n}`, x: centerX, y: centerY },
        pan_right: { z: `${1 + z}`, x: `(iw-iw/zoom)*on/${n}`, y: centerY },
        pan_left: { z: `${1 + z}`, x: `(iw-iw/zoom)*(1-on/${n})`, y: centerY },
        pan_down: { z: `${1 + z}`, x: centerX, y: `(ih-ih/zoom)*on/${n}` },
        pan_up: { z: `${1 + z}`, x: centerX, y: `(ih-ih/zoom)*(1-on/${n})` },
        static: { z: '1', x: '0', y: '0' },
    }[motion] || null;
    const W2 = width * 2;
    const H2 = height * 2;
    return [
        `scale=${W2}:${H2}:force_original_aspect_ratio=increase:flags=lanczos`,
        `crop=${W2}:${H2}`,
        `zoompan=z='${exprs.z}':x='${exprs.x}':y='${exprs.y}':d=${frames}:s=${width}x${height}:fps=${fps}`,
    ].join(',');
}

const FONT_CANDIDATES = IS_WINDOWS
    ? ['C:\\Windows\\Fonts\\segoeuib.ttf', 'C:\\Windows\\Fonts\\arialbd.ttf', 'C:\\Windows\\Fonts\\arial.ttf']
    : [
        '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
        '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf',
        '/System/Library/Fonts/Supplemental/Arial Bold.ttf',
        '/Library/Fonts/Arial Bold.ttf',
        '/usr/share/fonts/TTF/DejaVuSans-Bold.ttf',
    ];

// Copy a bold font next to the project so drawtext can use a relative fontfile.
export function ensureProjectFont(projectDir) {
    const target = path.join(projectDir, 'font.ttf');
    if (fs.existsSync(target)) return 'font.ttf';
    const source = FONT_CANDIDATES.find((f) => fs.existsSync(f));
    if (!source) return null;
    fs.copyFileSync(source, target);
    return 'font.ttf';
}

export function subtitleFontName() {
    if (IS_WINDOWS || process.platform === 'darwin') return 'Arial';
    return 'DejaVu Sans';
}

function drawTextFilter({ textFile, fontFile, size, y, box = true }) {
    const font = fontFile ? `fontfile=${fontFile}` : 'font=Sans';
    const boxPart = box ? ':box=1:boxcolor=black@0.45:boxborderw=14' : '';
    return `drawtext=${font}:textfile=${textFile}:fontcolor=white:fontsize=${size}${boxPart}`
        + `:x=(w-text_w)/2:y=${Math.round(y)}:shadowcolor=black@0.6:shadowx=2:shadowy=2`;
}

function writeTextFile(projectDir, name, text) {
    const rel = path.posix.join('text', name);
    fs.mkdirSync(path.join(projectDir, 'text'), { recursive: true });
    fs.writeFileSync(path.join(projectDir, rel), String(text).trim(), 'utf-8');
    return rel;
}

export function wrapWords(text, perLine) {
    const lines = [];
    let current = '';
    for (const word of String(text).replace(/\s+/g, ' ').trim().split(' ')) {
        const next = current ? `${current} ${word}` : word;
        if (current && next.length > perLine) {
            lines.push(current);
            current = word;
        } else {
            current = next;
        }
    }
    if (current) lines.push(current);
    return lines;
}

// drawtext neither wraps nor centres multi-line text, so wrap here (shrinking the
// font until it fits in `maxLines`) and draw each line centred on its own.
export function fitText(text, { width, size, maxLines = 3 }) {
    let fontSize = size;
    for (;;) {
        const perLine = Math.max(6, Math.floor((width * 0.88) / (fontSize * 0.62)));
        const lines = wrapWords(text, perLine);
        if ((lines.length <= maxLines && lines.every((l) => l.length <= perLine)) || fontSize <= 14) {
            return { size: fontSize, lines, lineHeight: Math.round(fontSize * 1.3) };
        }
        fontSize = Math.round(fontSize * 0.88);
    }
}

function textBlock({ projectDir, key, text, fontFile, width, size, top, box, maxLines }) {
    const fit = fitText(text, { width, size, maxLines });
    const filters = fit.lines.map((line, i) => drawTextFilter({
        textFile: writeTextFile(projectDir, `${key}-${i + 1}.txt`, line),
        fontFile,
        size: fit.size,
        y: top + i * fit.lineHeight,
        box,
    }));
    return { filters, height: fit.lines.length * fit.lineHeight };
}

function titleOverlay({ projectDir, title, index, width, height }) {
    const fontFile = ensureProjectFont(projectDir);
    return textBlock({ projectDir, key: `title-${index}`, text: title, fontFile, width, size: Math.round(Math.min(width, height) / 14), top: height * 0.06, box: true, maxLines: 3 }).filters;
}

// Scene from a still image with a Ken Burns move.
export async function renderImageScene({ projectDir, image, out, duration, width, height, fps, motion, title, index, signal }) {
    const frames = Math.max(2, Math.round(duration * fps));
    const filters = [kenBurnsFilter({ width, height, fps, frames, motion })];
    if (title) filters.push(...titleOverlay({ projectDir, title, index, width, height }));
    filters.push('format=yuv420p');
    await ffmpeg(['-i', image, '-vf', filters.join(','), '-frames:v', String(frames), '-r', String(fps), ...X264, '-an', out],
        { cwd: projectDir, signal });
    return out;
}

// Scene from an AI or user video clip: cover-crop, slow down up to 1.6x, then
// freeze the last frame if it is still too short; trim when too long.
export async function renderVideoScene({ projectDir, video, out, duration, width, height, fps, title, index, signal }) {
    const source = await probeDuration(video);
    const factor = source > 0 ? Math.min(1.6, Math.max(1, duration / source)) : 1;
    const filters = [
        `setpts=${factor.toFixed(4)}*PTS`,
        `fps=${fps}`,
        `scale=${width}:${height}:force_original_aspect_ratio=increase:flags=lanczos`,
        `crop=${width}:${height}`,
        `tpad=stop_mode=clone:stop_duration=${Math.ceil(duration + 1)}`,
    ];
    if (title) filters.push(...titleOverlay({ projectDir, title, index, width, height }));
    filters.push('format=yuv420p');
    await ffmpeg(['-i', video, '-vf', filters.join(','), '-t', duration.toFixed(3), '-r', String(fps), ...X264, '-an', out],
        { cwd: projectDir, signal });
    return out;
}

// Title card on a solid colour (no generation needed).
export async function renderColorScene({ projectDir, out, duration, width, height, fps, color = '#101828', title, subtitle, index, signal }) {
    const safeColor = /^(#|0x)?[0-9a-fA-F]{6}$|^[a-zA-Z]+$/.test(color) ? color : '#101828';
    const fontFile = ensureProjectFont(projectDir);
    const filters = ['vignette=PI/5'];
    const short = Math.min(width, height);
    const head = title ? fitText(title, { width, size: Math.round(short / 10), maxLines: 3 }) : null;
    const sub = subtitle ? fitText(subtitle, { width, size: Math.round(short / 20), maxLines: 3 }) : null;
    const gap = head && sub ? Math.round(short / 30) : 0;
    const blockHeight = (head ? head.lines.length * head.lineHeight : 0) + gap + (sub ? sub.lines.length * sub.lineHeight : 0);
    let top = (height - blockHeight) / 2 - height * 0.05;
    if (title) {
        const block = textBlock({ projectDir, key: `card-title-${index}`, text: title, fontFile, width, size: Math.round(short / 10), top, box: false, maxLines: 3 });
        filters.push(...block.filters);
        top += block.height + gap;
    }
    if (subtitle) {
        filters.push(...textBlock({ projectDir, key: `card-sub-${index}`, text: subtitle, fontFile, width, size: Math.round(short / 20), top, box: false, maxLines: 3 }).filters);
    }
    filters.push('format=yuv420p');
    await ffmpeg([
        '-f', 'lavfi', '-i', `color=c=${safeColor}:s=${width}x${height}:r=${fps}:d=${duration.toFixed(3)}`,
        '-vf', filters.join(','), ...X264, '-an', out,
    ], { cwd: projectDir, signal });
    return out;
}

// Start time of every clip once consecutive clips overlap by their transition.
export function clipStarts(durations, transitionDurations) {
    const starts = [0];
    for (let i = 1; i < durations.length; i++) {
        starts.push(starts[i - 1] + durations[i - 1] - transitionDurations[i - 1]);
    }
    return starts;
}

export function totalDuration(durations, transitionDurations) {
    if (!durations.length) return 0;
    const starts = clipStarts(durations, transitionDurations);
    return starts[starts.length - 1] + durations[durations.length - 1];
}

// libass renders SRT on a 288-px-high canvas scaled to the video, so the same
// FontSize looks alike at 720p and 1080p; portrait video needs a smaller one.
export function subtitleStyle({ width, height, fontSize, position = 'bottom' }) {
    const portrait = height > width;
    const size = fontSize || (portrait ? 10 : 16);
    const alignment = position === 'top' ? 8 : 2;
    return [
        `FontName=${subtitleFontName()}`,
        `FontSize=${size}`,
        'PrimaryColour=&H00FFFFFF',
        'OutlineColour=&H00000000',
        'BackColour=&H80000000',
        'BorderStyle=1',
        'Outline=1.6',
        'Shadow=0.8',
        'Bold=1',
        `Alignment=${alignment}`,
        'MarginV=22',
    ].join(',');
}

// Joins scene clips with xfade transitions (+ optional burned-in subtitles).
export function buildAssembleFilter({ count, durations, transitions, fps, subtitlesFile, style }) {
    const parts = [];
    for (let i = 0; i < count; i++) parts.push(`[${i}:v]settb=AVTB,fps=${fps},format=yuv420p[v${i}]`);
    let last = 'v0';
    const transitionDurations = transitions.map((t) => t.duration);
    const starts = clipStarts(durations, transitionDurations);
    for (let i = 1; i < count; i++) {
        const t = transitions[i - 1];
        const type = t.type === 'cut' ? 'fade' : t.type;
        const label = `x${i}`;
        parts.push(`[${last}][v${i}]xfade=transition=${type}:duration=${t.duration.toFixed(3)}:offset=${starts[i].toFixed(3)}[${label}]`);
        last = label;
    }
    if (subtitlesFile) {
        parts.push(`[${last}]subtitles=filename=${subtitlesFile}:force_style='${style}'[vout]`);
    } else {
        parts.push(`[${last}]null[vout]`);
    }
    return parts.join(';');
}

export async function assembleVideo({ projectDir, clips, durations, transitions, fps, out, subtitlesFile, style, signal }) {
    const filter = buildAssembleFilter({ count: clips.length, durations, transitions, fps, subtitlesFile, style });
    const inputs = clips.flatMap((c) => ['-i', c]);
    await ffmpeg([...inputs, '-filter_complex', filter, '-map', '[vout]', ...X264, '-r', String(fps), '-an', out],
        { cwd: projectDir, signal });
    return out;
}

export function buildAudioMixFilter({ narrations, total, musicIndex, musicVolume = 0.18, duck = true }) {
    const fmt = 'aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo';
    const parts = [];
    narrations.forEach((n, i) => {
        const ms = Math.max(0, Math.round(n.start * 1000));
        parts.push(`[${i}:a]${fmt},adelay=delays=${ms}:all=1[n${i}]`);
    });
    const end = total.toFixed(3);
    const fadeStart = Math.max(0, total - 2.5).toFixed(3);
    const loud = 'loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000';
    if (narrations.length) {
        const labels = narrations.map((_, i) => `[n${i}]`).join('');
        parts.push(`${labels}amix=inputs=${narrations.length}:normalize=0:dropout_transition=0,apad,atrim=0:${end}[narr]`);
    }
    if (musicIndex !== undefined && musicIndex !== null) {
        parts.push(`[${musicIndex}:a]${fmt},volume=${musicVolume},atrim=0:${end},afade=t=in:d=1,afade=t=out:st=${fadeStart}:d=2.5[mus]`);
        if (narrations.length) {
            if (duck) {
                parts.push('[narr]asplit=2[narrmix][narrsc]');
                parts.push('[mus][narrsc]sidechaincompress=threshold=0.03:ratio=6:attack=30:release=500[duck]');
                parts.push(`[narrmix][duck]amix=inputs=2:normalize=0,atrim=0:${end},${loud}[aout]`);
            } else {
                parts.push(`[narr][mus]amix=inputs=2:normalize=0,atrim=0:${end},${loud}[aout]`);
            }
        } else {
            parts.push(`[mus]apad,atrim=0:${end},${loud}[aout]`);
        }
    } else if (narrations.length) {
        parts.push(`[narr]${loud}[aout]`);
    } else {
        return null;
    }
    return parts.join(';');
}

export async function mixAudio({ projectDir, narrations, total, music, out, signal }) {
    const inputs = narrations.flatMap((n) => ['-i', n.path]);
    let musicIndex = null;
    if (music?.path) {
        inputs.push('-stream_loop', '-1', '-i', music.path);
        musicIndex = narrations.length;
    }
    const filter = buildAudioMixFilter({
        narrations,
        total,
        musicIndex,
        musicVolume: music?.volume ?? 0.18,
        duck: music?.duck ?? true,
    });
    if (!filter) {
        await ffmpeg(['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-t', total.toFixed(3), '-c:a', 'aac', '-b:a', '128k', out],
            { cwd: projectDir, signal });
        return out;
    }
    await ffmpeg([...inputs, '-filter_complex', filter, '-map', '[aout]', '-t', total.toFixed(3), '-c:a', 'aac', '-b:a', '192k', out],
        { cwd: projectDir, signal });
    return out;
}

export async function muxFinal({ projectDir, video, audio, out, signal }) {
    await ffmpeg(['-i', video, '-i', audio, '-map', '0:v', '-map', '1:a', '-c', 'copy', '-shortest', '-movflags', '+faststart', out],
        { cwd: projectDir, signal });
    return out;
}

export async function extractThumbnail({ video, out, at = 1 }) {
    await ffmpeg(['-ss', String(at), '-i', video, '-frames:v', '1', '-vf', 'scale=640:-2', '-q:v', '4', out]);
    return out;
}

// Small JPEG preview (base64) so Claude can look at a result through MCP.
export async function previewBase64(file, maxWidth = 512) {
    const tmp = path.join(path.dirname(file), `.preview-${process.pid}-${Date.now()}.jpg`);
    try {
        await ffmpeg(['-i', file, '-frames:v', '1', '-vf', `scale='min(${maxWidth},iw)':-2`, '-q:v', '5', tmp]);
        return fs.readFileSync(tmp).toString('base64');
    } finally {
        fs.rmSync(tmp, { force: true });
    }
}
