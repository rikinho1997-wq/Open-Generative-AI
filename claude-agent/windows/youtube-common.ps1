# Funcoes comuns aos scripts do YouTube (youtube-setup.ps1 e youtube-menu.ps1).
# Nao rode este arquivo sozinho. Nada aqui grava credenciais ou tokens: quem cuida
# disso e o agente (node claude-agent\bin\oga.mjs youtube ...), no cofre fora do Git.

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

$script:Repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$script:Oga = Join-Path $script:Repo 'claude-agent\bin\oga.mjs'
Set-Location $script:Repo

function Get-DownloadsFolder {
    try {
        $p = (New-Object -ComObject Shell.Application).NameSpace('shell:Downloads').Self.Path
        if ($p -and (Test-Path -LiteralPath $p)) { return $p }
    } catch {}
    return (Join-Path $env:USERPROFILE 'Downloads')
}
$script:Downloads = Get-DownloadsFolder

# ─── Mensagens ───────────────────────────────────────────────────────────────
function Write-Title([string]$msg) {
    Write-Host ''
    Write-Host ('=' * 64) -ForegroundColor DarkYellow
    Write-Host "  $msg" -ForegroundColor Yellow
    Write-Host ('=' * 64) -ForegroundColor DarkYellow
}
function Write-Step([string]$n, [string]$msg) { Write-Host ''; Write-Host "[$n] $msg" -ForegroundColor Cyan }
function Write-Ok([string]$msg) { Write-Host "  [ok] $msg" -ForegroundColor Green }
function Write-Warn([string]$msg) { Write-Host "  [!]  $msg" -ForegroundColor Yellow }
function Write-Info([string]$msg) { Write-Host "       $msg" }

function Read-YesNo([string]$question, [bool]$default = $true) {
    $hint = if ($default) { '(S/n)' } else { '(s/N)' }
    while ($true) {
        $a = ([string](Read-Host "  $question $hint")).Trim().ToLower()
        if (-not $a) { return $default }
        if ($a -match '^(s|sim|y|yes)$') { return $true }
        if ($a -match '^(n|nao|não|no)$') { return $false }
        Write-Host '  Responda s (sim) ou n (não).'
    }
}

function Wait-Enter([string]$msg = 'Pressione Enter para continuar') { [void](Read-Host "  $msg") }

# ─── Node.js e dependências ──────────────────────────────────────────────────
function Update-SessionPath {
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
}

function Assert-Node {
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
        Write-Warn 'Node.js não encontrado.'
        if ((Get-Command winget -ErrorAction SilentlyContinue) -and (Read-YesNo 'Instalar o Node.js LTS (gratuito) com o winget agora?')) {
            winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements
            Update-SessionPath
        }
    }
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
        throw 'Instale o Node.js 18 ou mais novo (https://nodejs.org), feche esta janela e rode de novo.'
    }
    $version = (node --version).Trim()
    if ([int]($version.TrimStart('v').Split('.')[0]) -lt 18) { throw "Node.js $version é antigo: instale o 18 ou mais novo." }
    if (-not (Test-Path (Join-Path $script:Repo 'claude-agent\node_modules'))) {
        Write-Info 'Instalando as dependências do agente (só na primeira vez)...'
        npm install --prefix claude-agent --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { throw 'npm install falhou (veja as mensagens acima).' }
    }
    Write-Ok "Node.js $version"
}

# Roda a CLI do agente. Mensagens e progresso aparecem na tela (stderr);
# o resultado (JSON no stdout) volta como objeto. Erro: devolve $null.
function Invoke-Oga([string[]]$OgaArgs) {
    $eap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { $out = (& node $script:Oga @OgaArgs) | Out-String } finally { $ErrorActionPreference = $eap }
    if ($LASTEXITCODE -ne 0) { return $null }
    $text = $out.Trim()
    if (-not $text) { return $null }
    try { return ($text | ConvertFrom-Json) } catch { return $text }
}

# ─── Arquivos ────────────────────────────────────────────────────────────────
function Select-File([string]$title, [string]$filter, [string]$initialDir = $script:Downloads) {
    try {
        Add-Type -AssemblyName System.Windows.Forms
        $dlg = New-Object System.Windows.Forms.OpenFileDialog
        $dlg.Title = $title
        $dlg.Filter = $filter
        $dlg.Multiselect = $false
        if ($initialDir -and (Test-Path -LiteralPath $initialDir)) { $dlg.InitialDirectory = $initialDir }
        # Dono "sempre no topo": a janela não fica escondida atrás do console.
        $owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true; ShowInTaskbar = $false }
        try {
            if ($dlg.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { return $dlg.FileName }
            return $null
        } finally { $owner.Dispose(); $dlg.Dispose() }
    } catch {
        Write-Warn "Não consegui abrir a janela de seleção ($($_.Exception.Message))."
        $p = ([string](Read-Host '  Cole o caminho completo do arquivo (ou Enter para cancelar)')).Trim().Trim('"')
        if ($p) { return $p }
        return $null
    }
}

# Procura um arquivo entregue (ex.: o MP4 baixado da conversa) no projeto,
# em Downloads, na Área de Trabalho e em Vídeos — inclusive "nome (1).mp4".
function Find-Deliverable([string]$relPath) {
    if (-not $relPath) { return $null }
    $name = Split-Path $relPath -Leaf
    $dirs = @($script:Downloads, [Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('MyVideos')) | Where-Object { $_ }
    $candidates = @((Join-Path $script:Repo $relPath)) + ($dirs | ForEach-Object { Join-Path $_ $name })
    foreach ($c in $candidates) { if (Test-Path -LiteralPath $c) { return (Resolve-Path -LiteralPath $c).Path } }
    $base = [IO.Path]::GetFileNameWithoutExtension($name)
    $ext = [IO.Path]::GetExtension($name)
    foreach ($d in $dirs) {
        if (-not (Test-Path -LiteralPath $d)) { continue }
        $hit = Get-ChildItem -LiteralPath $d -File -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -like "$base*$ext" } | Sort-Object LastWriteTime -Descending | Select-Object -First 1
        if ($hit) { return $hit.FullName }
    }
    return $null
}

function Get-Sha256([string]$file) { return (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() }

function Format-Size([long]$bytes) { return ('{0:N1} MB' -f ($bytes / 1MB)) }

# Data ISO (ou DateTime, que o PowerShell 7 cria sozinho a partir do JSON) no horário local.
function Format-When($iso) {
    if (-not $iso) { return '' }
    try {
        $dto = if ($iso -is [datetime]) { [DateTimeOffset]::new($iso.ToUniversalTime()) }
               elseif ($iso -is [DateTimeOffset]) { $iso }
               else { [DateTimeOffset]::Parse([string]$iso, [Globalization.CultureInfo]::InvariantCulture) }
        return $dto.ToLocalTime().ToString('dd/MM/yyyy HH:mm')
    } catch { return [string]$iso }
}

function Format-Privacy([string]$p) {
    switch ($p) { 'public' { 'PÚBLICO' } 'unlisted' { 'não listado' } 'private' { 'privado' } default { $p } }
}

# ─── Canal ───────────────────────────────────────────────────────────────────
function Get-NormalizedName([string]$s) {
    if (-not $s) { return '' }
    $sb = New-Object System.Text.StringBuilder
    foreach ($ch in $s.Normalize([Text.NormalizationForm]::FormD).ToCharArray()) {
        if ([Globalization.CharUnicodeInfo]::GetUnicodeCategory($ch) -ne [Globalization.UnicodeCategory]::NonSpacingMark) { [void]$sb.Append($ch) }
    }
    return ($sb.ToString().ToLowerInvariant() -replace '[^a-z0-9]', '')
}

# (Atenção: no PowerShell $channel e $Channel são a MESMA variável; por isso $info.)
function Test-ChannelMatch($info, [string]$expected) {
    if (-not $info) { return $false }
    if (-not $expected) { return $true }
    $want = Get-NormalizedName $expected
    return ($info.id -eq $expected) -or ((Get-NormalizedName $info.title) -eq $want) -or
        ($info.custom_url -and ((Get-NormalizedName $info.custom_url) -eq $want))
}

# Confere se nenhum arquivo de credencial está exposto ao Git (versionado ou não ignorado).
function Test-NoSecretsInRepo {
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) { return }
    if (-not (Test-Path (Join-Path $script:Repo '.git'))) { return }
    $eap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $exposed = @(git -C $script:Repo ls-files --cached --others --exclude-standard -- '*client_secret*' '*token.json' '*.oauth.json' 2>$null)
    } finally { $ErrorActionPreference = $eap }
    $exposed = @($exposed | Where-Object { $_ })
    if ($exposed.Count) {
        Write-Warn 'ATENÇÃO: arquivos de credencial dentro do projeto que o Git poderia enviar ao GitHub:'
        $exposed | ForEach-Object { Write-Host "         $_" -ForegroundColor Red }
        Write-Info 'Apague-os (a cópia protegida já está no cofre). Se algum já foi enviado ao GitHub,'
        Write-Info 'redefina a chave secreta do cliente no Google Cloud e rode este assistente de novo.'
    } else {
        Write-Ok 'Nenhum arquivo de credencial exposto ao Git no projeto.'
    }
}

# ─── Envio privado (usado pelo assistente e pelo menu) ───────────────────────
# Prepara e envia um vídeo SEMPRE como privado. Devolve o resultado do envio ou $null.
function Invoke-PrivateUpload {
    param([string]$MetaPath, [string]$Video, [string]$Channel)
    $meta = $null
    if ($MetaPath) {
        $meta = Get-Content -LiteralPath $MetaPath -Raw -Encoding UTF8 | ConvertFrom-Json
    }

    # 1) O vídeo
    if (-not $Video -and $meta) {
        $Video = Find-Deliverable $meta.file
        if ($Video) { Write-Ok "Vídeo encontrado: $Video" }
    }
    if (-not $Video) {
        Write-Info 'Selecione o arquivo MP4 (o que você baixou desta conversa costuma estar em Downloads).'
        $Video = Select-File 'Selecione o vídeo MP4 para enviar' 'Vídeo MP4 (*.mp4)|*.mp4'
        if (-not $Video) { Write-Warn 'Nenhum vídeo selecionado.'; return $null }
    }
    if (-not (Test-Path -LiteralPath $Video)) { Write-Warn "Arquivo não encontrado: $Video"; return $null }
    $size = (Get-Item -LiteralPath $Video).Length

    # 2) Integridade e envio repetido
    Write-Info 'Conferindo a integridade do arquivo (SHA-256)...'
    $hash = Get-Sha256 $Video
    if ($meta -and $meta.sha256) {
        if ($hash -eq ([string]$meta.sha256).ToLowerInvariant()) { Write-Ok 'Arquivo idêntico ao vídeo final entregue (SHA-256 confere).' }
        else {
            Write-Warn 'Este arquivo NÃO é idêntico ao vídeo final indicado nos metadados (SHA-256 diferente).'
            if (-not (Read-YesNo 'Enviar este arquivo mesmo assim?' $false)) { return $null }
        }
    }
    $history = @(Invoke-Oga @('youtube', 'history'))
    $previous = $history | Where-Object { $_ -and $_.sha256 -eq $hash } | Select-Object -First 1
    if ($previous) {
        Write-Ok "Este vídeo já foi enviado em $(Format-When $previous.uploaded_at): https://youtu.be/$($previous.video_id) ($(Format-Privacy $previous.privacy))."
        Write-Info 'Nada a fazer: para publicar ou agendar, use o menu (YouTube-Menu.cmd).'
        return $previous
    }

    # 3) Título e thumbnail
    $ogaArgs = @('youtube', 'upload', $Video)
    $tmpMeta = $null
    if ($MetaPath) {
        $ogaArgs += @('--meta', $MetaPath)
        $title = $meta.title
    } else {
        $default = [IO.Path]::GetFileNameWithoutExtension($Video)
        $title = ([string](Read-Host "  Título do vídeo (Enter = $default)")).Trim()
        if (-not $title) { $title = $default }
        # Título num JSON temporário: aspas e acentos chegam intactos (o PowerShell 5.1 estraga aspas em argumentos).
        $tmpMeta = Join-Path ([IO.Path]::GetTempPath()) ('oga-youtube-' + [guid]::NewGuid().ToString('N') + '.json')
        [IO.File]::WriteAllText($tmpMeta, (@{ title = $title; language = 'pt-BR' } | ConvertTo-Json), (New-Object System.Text.UTF8Encoding $false))
        $ogaArgs += @('--meta', $tmpMeta)
    }
    $thumb = $null
    if ($meta -and $meta.thumbnail) {
        $thumb = Find-Deliverable $meta.thumbnail
        if ($thumb) { Write-Ok "Thumbnail encontrada: $thumb" }
    }
    if (-not $thumb -and (Read-YesNo 'Escolher uma thumbnail (JPG/PNG)? Funciona em canais verificados por telefone.' ([bool]($meta -and $meta.thumbnail)))) {
        $thumb = Select-File 'Selecione a thumbnail (1280x720)' 'Imagens (*.jpg;*.jpeg;*.png)|*.jpg;*.jpeg;*.png'
    }
    if ($thumb) { $ogaArgs += @('--thumbnail', $thumb) } else { $ogaArgs += '--no-thumbnail' }

    # 4) Sempre privado, sempre no canal esperado
    $ogaArgs += @('--privacy', 'private')
    if ($Channel) { $ogaArgs += @('--expect-channel', $Channel) }

    Write-Host ''
    Write-Info "Título:       $title"
    Write-Info "Arquivo:      $(Split-Path $Video -Leaf) ($(Format-Size $size))"
    Write-Info "Canal:        $Channel"
    Write-Info 'Visibilidade: PRIVADO (só você vê; publique depois pelo menu)'
    Write-Info 'Cota:         1 envio do limite diário de envios (+ ~50 unidades pela thumbnail)'
    try {
        if (-not (Read-YesNo 'Enviar agora?' $true)) { return $null }
        $result = Invoke-Oga $ogaArgs
    } finally {
        if ($tmpMeta) { Remove-Item -LiteralPath $tmpMeta -Force -ErrorAction SilentlyContinue }
    }
    if (-not $result) { Write-Warn 'O envio não foi concluído (veja a mensagem acima). Pode rodar de novo: o envio é retomável.'; return $null }
    Write-Host ''
    Write-Ok "Enviado como $(Format-Privacy $result.privacy): $($result.url)"
    Write-Info "Revisar no YouTube Studio: $($result.studio)"
    if ($result.thumbnail) { Write-Info "Thumbnail: $($result.thumbnail)" }
    foreach ($w in @($result.warnings)) { if ($w) { Write-Warn $w } }
    if (Read-YesNo 'Abrir o YouTube Studio para revisar o vídeo?' $true) { Start-Process $result.studio }
    return $result
}

# ─── Escolher um vídeo já enviado ────────────────────────────────────────────
function Get-VideoIdFromText([string]$text) {
    $t = ([string]$text).Trim()
    $m = [regex]::Match($t, '(?:youtu\.be/|[?&]v=|/video/|/shorts/)([A-Za-z0-9_-]{11})')
    if ($m.Success) { return $m.Groups[1].Value }
    if ($t -match '^[A-Za-z0-9_-]{11}$') { return $t }
    return $null
}
