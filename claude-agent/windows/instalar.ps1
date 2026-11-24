# Instalador do agente Claude do Open Generative AI para Windows.
# Uso (na pasta do projeto):
#   powershell -ExecutionPolicy Bypass -File claude-agent\windows\instalar.ps1
# Pergunta antes de instalar qualquer programa. Nao usa nem pede chaves de API.

$ErrorActionPreference = 'Stop'
$Repo = Resolve-Path (Join-Path $PSScriptRoot '..\..')
Set-Location $Repo

function Write-Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Test-Command($name) { return [bool](Get-Command $name -ErrorAction SilentlyContinue) }
function Confirm-Install($what) {
    $answer = Read-Host "$what nao encontrado. Instalar com winget agora? (s/n)"
    return $answer -match '^(s|sim|y|yes)$'
}
function Refresh-Path {
    $env:Path = [System.Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
                [System.Environment]::GetEnvironmentVariable('Path', 'User')
}
function Install-WithWinget($id, $what) {
    if (-not (Test-Command 'winget')) {
        Write-Host "winget indisponivel. Instale $what manualmente e rode este script de novo." -ForegroundColor Yellow
        return
    }
    winget install --id $id -e --accept-source-agreements --accept-package-agreements
    Refresh-Path
}

Write-Step 'Verificando pre-requisitos'
if (-not (Test-Command 'node')) {
    if (Confirm-Install 'Node.js') { Install-WithWinget 'OpenJS.NodeJS.LTS' 'o Node.js' }
}
if (-not (Test-Command 'node')) { throw 'Node.js 18+ e obrigatorio: https://nodejs.org' }
Write-Host ("Node.js " + (node --version))

if (-not (Test-Command 'ffmpeg')) {
    if (Confirm-Install 'FFmpeg') { Install-WithWinget 'Gyan.FFmpeg' 'o FFmpeg' }
}
if (Test-Command 'ffmpeg') { Write-Host 'FFmpeg OK' } else { Write-Host 'FFmpeg ausente: a montagem de video nao vai funcionar.' -ForegroundColor Yellow }

$hasPython = (Test-Command 'py') -or (Test-Command 'python')
if (-not $hasPython) {
    if (Confirm-Install 'Python 3 (para a voz Piper)') { Install-WithWinget 'Python.Python.3.12' 'o Python' }
}

Write-Step 'Instalando dependencias do agente (claude-agent)'
npm install --prefix claude-agent --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { throw 'npm install falhou' }

Write-Step 'Instalando motores gratuitos (sd.cpp, modelo de imagem, modo rapido, Piper, voz pt-BR)'
Write-Host 'Isso baixa cerca de 2,5 GB na primeira vez.'
node claude-agent\bin\oga.mjs setup

Write-Step 'Diagnostico'
node claude-agent\bin\oga.mjs doctor

Write-Host "`nPronto! Proximos passos:" -ForegroundColor Green
Write-Host '  1. npm install -g @anthropic-ai/claude-code   (se ainda nao tiver o Claude Code)'
Write-Host '  2. claude                                      (nesta pasta; aprove o servidor MCP open-generative-ai)'
Write-Host '  3. Peca: "Crie um video de 60 segundos sobre ... com narracao e legendas"'
Write-Host '  Teste sem o Claude: node claude-agent\bin\oga.mjs produce claude-agent\examples\demo-pt-br.json'
