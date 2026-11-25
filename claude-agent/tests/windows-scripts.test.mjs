// Guards for the Windows helper scripts (claude-agent/windows): encoding that Windows
// PowerShell 5.1 reads correctly, and a syntax check when a PowerShell is available.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'windows');
const files = fs.readdirSync(dir);
const ps1 = files.filter((f) => f.endsWith('.ps1'));
const cmd = files.filter((f) => f.endsWith('.cmd'));

test('PowerShell scripts are UTF-8 with BOM and CRLF (Windows PowerShell 5.1 misreads accents otherwise)', () => {
    assert.ok(ps1.includes('youtube-setup.ps1') && ps1.includes('youtube-menu.ps1') && ps1.includes('youtube-common.ps1'));
    for (const f of ps1) {
        const buf = fs.readFileSync(path.join(dir, f));
        assert.deepEqual([...buf.subarray(0, 3)], [0xef, 0xbb, 0xbf], `${f}: BOM`);
        assert.ok(!/(^|[^\r])\n/.test(buf.toString('utf-8')), `${f}: CRLF only`);
    }
});

test('.cmd launchers are ASCII + CRLF and run PowerShell with -STA and a per-process bypass', () => {
    assert.deepEqual(cmd.sort(), ['Configurar-YouTube.cmd', 'YouTube-Menu.cmd']);
    for (const f of cmd) {
        const text = fs.readFileSync(path.join(dir, f), 'latin1');
        assert.ok(/^[\x00-\x7f]*$/.test(text), `${f}: ASCII`);
        assert.ok(!/(^|[^\r])\n/.test(text), `${f}: CRLF`);
        assert.match(text, /powershell\.exe -NoProfile -STA -ExecutionPolicy Bypass -File "%~dp0[\w-]+\.ps1"/);
    }
});

test('the installer only ever uploads as private and pins the expected channel', () => {
    const common = fs.readFileSync(path.join(dir, 'youtube-common.ps1'), 'utf-8');
    const upload = common.slice(common.indexOf('function Invoke-PrivateUpload'));
    assert.match(upload, /'--privacy', 'private'/);
    assert.match(upload, /'--expect-channel', \$Channel/);
    assert.ok(!/'youtube', 'upload'[^\n]*'public'/.test(common));
    // PowerShell variable names are case-insensitive: a "$channel = ..." would overwrite the -Channel parameter.
    for (const f of ['youtube-setup.ps1', 'youtube-menu.ps1']) {
        assert.ok(!/(?<!\])\$channel\s*=/i.test(fs.readFileSync(path.join(dir, f), 'utf-8')), `${f}: no $channel assignment`);
    }
});

const pwsh = ['pwsh', 'powershell'].find((p) => spawnSync(p, ['-NoProfile', '-Command', '1'], { stdio: 'ignore' }).status === 0);
test('PowerShell parser finds no syntax errors', { skip: !pwsh && 'PowerShell não instalado' }, () => {
    const script = 'foreach ($f in ($env:OGA_PS_FILES -split [char]10)) { $t=$null; $e=$null; '
        + '[void][System.Management.Automation.Language.Parser]::ParseFile($f, [ref]$t, [ref]$e); '
        + 'foreach ($x in $e) { "$($f):$($x.Extent.StartLineNumber): $($x.Message)" } }';
    const env = { ...process.env, OGA_PS_FILES: ps1.map((f) => path.join(dir, f)).join('\n'), NO_COLOR: '1' };
    const r = spawnSync(pwsh, ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf-8', env });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), '');
});
