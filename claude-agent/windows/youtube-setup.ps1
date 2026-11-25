# Assistente de configuração do YouTube — Open Generative AI (Windows).
#
# Jeito fácil: dê dois cliques em  claude-agent\windows\Configurar-YouTube.cmd
# Pelo PowerShell (na pasta do projeto):
#   powershell -NoProfile -STA -ExecutionPolicy Bypass -File claude-agent\windows\youtube-setup.ps1
#
# Etapas: 1) escolher o JSON do cliente OAuth   2) autorizar a conta Google no navegador
#         3) confirmar o canal                   4) tokens no cofre protegido (DPAPI)
#         5) primeiro envio PRIVADO para teste   6) publicar/agendar depois (menu)
#
# Usa só a API oficial e gratuita do YouTube. Credenciais e tokens ficam em
# %APPDATA%\open-generative-ai\youtube (fora do projeto) e nunca vão para o GitHub.
[CmdletBinding()]
param(
    [string]$ClientSecret,                 # caminho do JSON (pula a janela de seleção)
    [string]$Channel = 'AGORA FAZ SENTIDO',
    [string]$Meta = 'productions\agora-faz-sentido\ep01-congestionamento-fantasma\youtube-ep01.json',
    [string]$Video,                        # MP4 do primeiro envio (padrão: procurado automaticamente)
    [switch]$NoManage,                     # só enviar; sem permissão para publicar/agendar depois
    [switch]$SkipUpload                    # configura tudo, mas não envia o vídeo de teste
)

. (Join-Path $PSScriptRoot 'youtube-common.ps1')
trap {
    Write-Host ''
    Write-Host "Erro: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host 'Nada foi publicado. Corrija o problema e rode o assistente de novo (ele retoma de onde parou).'
    exit 1
}

try { $Host.UI.RawUI.WindowTitle = "YouTube — $Channel" } catch {}
Write-Title "Configurar o envio ao YouTube — canal $Channel"
Write-Info 'Gratuito: usa a API oficial do YouTube (YouTube Data API v3).'
Write-Info 'Seus segredos ficam só neste computador, criptografados para a sua conta do Windows.'

Write-Step '0/6' 'Verificando o Node.js'
Assert-Node

$st = Invoke-Oga @('youtube', 'status')
if (-not $st) { throw 'Não consegui consultar o agente (veja a mensagem acima).' }

# ─── 1. JSON do cliente OAuth ─────────────────────────────────────────────────
Write-Step '1/6' 'Credenciais OAuth (arquivo JSON do Google Cloud)'
$clientChanged = $false
$importNow = (-not $st.client_configured) -or [bool]$ClientSecret
if ($st.client_configured -and -not $ClientSecret) {
    Write-Ok "Credenciais já guardadas no cofre (cliente $($st.client_id))."
    $importNow = Read-YesNo 'Trocar por outro arquivo JSON?' $false
}
if ($importNow) {
    if (-not $ClientSecret) {
        Write-Info 'Confira no Google Cloud (Google Auth Platform) antes de continuar:'
        Write-Info '  - Clientes: tipo "App para computador" -> Baixar JSON (client_secret_....json)'
        Write-Info '  - Público-alvo: sua conta em "Usuários de teste" ou app "Em produção"'
        Write-Info '  - Acesso a dados: youtube.upload, youtube.readonly e youtube.force-ssl'
        if (Read-YesNo 'Abrir o Google Cloud Console no navegador para conferir ou baixar o JSON?' $false) {
            Start-Process 'https://console.cloud.google.com/auth/clients'
            Wait-Enter 'Quando o JSON estiver baixado, pressione Enter'
        }
        Write-Info 'Selecione o arquivo JSON na janela que vai abrir.'
        $ClientSecret = Select-File 'Selecione o JSON do cliente OAuth (client_secret_....json)' 'Credenciais OAuth (*.json)|*.json'
    }
    if (-not $ClientSecret) { throw 'Nenhum arquivo selecionado. Rode o assistente de novo quando tiver o JSON.' }
    $imported = Invoke-Oga @('youtube', 'setup', '--client-secret', $ClientSecret)
    if (-not $imported) { throw 'Não foi possível importar o arquivo (veja a mensagem acima).' }
    Write-Ok "Cliente $($imported.client_id) guardado no cofre ($($imported.protection))."
    if ($imported.warning) { Write-Warn $imported.warning }
    if ($st.authorized) {
        # O token antigo pertence ao cliente anterior: revoga para não deixar acesso solto.
        [void](Invoke-Oga @('youtube', 'logout'))
        Write-Info 'Autorização anterior revogada (era de outro cliente OAuth).'
    }
    if (Read-YesNo 'Apagar o arquivo JSON original agora? A cópia protegida já está no cofre (recomendado).' $true) {
        Remove-Item -LiteralPath $ClientSecret -Force
        Write-Ok 'Arquivo original apagado. Se precisar, baixe de novo no Google Cloud.'
    } else {
        Write-Warn 'Guarde o JSON fora da pasta do projeto (ex.: num gerenciador de senhas).'
    }
    $clientChanged = $true
}

# ─── 2 e 3. Autorização no navegador + canal ─────────────────────────────────
Write-Step '2/6' 'Autorizar a conta Google no navegador'
$manage = -not $NoManage
if ($manage) {
    Write-Info 'Para publicar e agendar DEPOIS do envio, o Google pede a permissão'
    Write-Info '"Ver, editar e excluir permanentemente seus vídeos do YouTube..." (youtube.force-ssl).'
    Write-Info 'O agente só usa essa permissão quando você pedir para publicar ou agendar.'
    $manage = Read-YesNo 'Permitir publicar/agendar depois por este computador?' $true
}

$st = Invoke-Oga @('youtube', 'status')
$needAuth = $true
if (-not $clientChanged -and $st.authorized -and (Test-ChannelMatch $st.channel $Channel) -and ($st.can_publish_later -or -not $manage)) {
    Write-Ok "Já autorizado no canal $($st.channel.title) ($($st.channel.id))."
    $needAuth = Read-YesNo 'Autorizar de novo mesmo assim?' $false
}

$authorized = $st.channel
for ($attempt = 1; $needAuth -and $attempt -le 3; $attempt++) {
    Write-Host ''
    Write-Info 'O navegador vai abrir na tela do Google. Nela:'
    Write-Info '  a) Escolha a conta Google dona ou gerente do canal.'
    Write-Info "  b) Se aparecer a lista de canais/Contas de Marca, escolha  $Channel."
    Write-Info '  c) Se aparecer "O Google não verificou este app": Avançado -> Acessar (é o seu próprio app).'
    Write-Info '  d) Marque TODAS as permissões pedidas e clique em Continuar.'
    Write-Info '  e) Quando aparecer "Autorização concluída", volte para esta janela.'
    Wait-Enter 'Pressione Enter para abrir o navegador'

    $authArgs = @('youtube', 'auth')
    if ($manage) { $authArgs += '--manage' }
    $auth = Invoke-Oga $authArgs
    if (-not $auth) {
        if (Read-YesNo 'A autorização não foi concluída. Tentar de novo?' $true) { continue }
        throw 'Autorização cancelada.'
    }

    # 3. Canal escolhido na tela do Google
    Write-Step '3/6' "Confirmando o canal $Channel"
    if (-not $auth.channel) {
        Write-Warn 'Não deu para confirmar o canal: a permissão de ver a conta do YouTube não foi concedida.'
        [void](Invoke-Oga @('youtube', 'logout'))
        Write-Info 'Autorização desfeita. Na próxima tentativa, marque todas as permissões.'
        continue
    }
    if (Test-ChannelMatch $auth.channel $Channel) {
        $authorized = $auth.channel
        Write-Ok "Canal confirmado: $($authorized.title) ($($authorized.id))."
        if ($auth.missing_permissions) {
            Write-Warn 'Permissão de publicar/agendar não concedida: os envios funcionam, mas publique pelo YouTube Studio.'
        }
        $needAuth = $false
        break
    }
    Write-Warn "Você autorizou o canal ""$($auth.channel.title)"", não ""$Channel""."
    [void](Invoke-Oga @('youtube', 'logout'))
    Write-Info 'Autorização desfeita (nenhum envio foi feito). Tente de novo escolhendo o canal certo;'
    Write-Info 'se o canal não aparecer, clique em "Usar outra conta" ou confira se você é dono/gerente dele.'
}
if ($needAuth) { throw "Não foi possível autorizar o canal $Channel. Rode o assistente de novo." }
if (-not $authorized) {
    Write-Step '3/6' "Confirmando o canal $Channel"
    $authorized = Invoke-Oga @('youtube', 'channel')
    if (Test-ChannelMatch $authorized $Channel) { Write-Ok "Canal confirmado: $($authorized.title) ($($authorized.id))." }
    else { throw "O token não está no canal $Channel. Rode o assistente de novo e autorize de novo." }
}

# ─── 4. Tokens protegidos ────────────────────────────────────────────────────
Write-Step '4/6' 'Conferindo o armazenamento seguro dos tokens'
$st = Invoke-Oga @('youtube', 'status')
$prot = switch ($st.protection) {
    'dpapi' { 'criptografado com DPAPI (só a sua conta do Windows abre)' }
    'aes-256-gcm' { 'criptografado com AES-256-GCM (senha OGA_YT_PASSPHRASE)' }
    default { 'protegido só por permissões de arquivo' }
}
Write-Ok "Cofre: $($st.storage_dir)"
Write-Ok "Proteção: $prot"
Write-Ok ('Permissões: ' + (@($st.granted_scopes) -join ', '))
if ($st.protection -eq 'file-permissions') { Write-Warn 'DPAPI indisponível: defina OGA_YT_PASSPHRASE para criptografar os tokens.' }
Test-NoSecretsInRepo

# ─── 5. Primeiro envio, privado ──────────────────────────────────────────────
Write-Step '5/6' 'Primeiro envio — PRIVADO, para revisão'
$uploaded = $null
if ($SkipUpload) {
    Write-Info 'Envio de teste pulado (-SkipUpload).'
} elseif (Read-YesNo 'Enviar agora o episódio 1 como PRIVADO para teste?' $true) {
    $metaPath = if ([IO.Path]::IsPathRooted($Meta)) { $Meta } else { Join-Path $Repo $Meta }
    if (-not (Test-Path -LiteralPath $metaPath)) {
        Write-Warn "Metadados não encontrados ($Meta). Você vai escolher o MP4 e digitar o título."
        $metaPath = $null
    }
    $uploaded = Invoke-PrivateUpload -MetaPath $metaPath -Video $Video -Channel $Channel
} else {
    Write-Info 'Tudo bem: envie depois pelo menu (YouTube-Menu.cmd) ou pedindo ao Claude.'
}

# ─── 6. Publicar e agendar depois ────────────────────────────────────────────
Write-Step '6/6' 'Publicar e agendar depois'
$menuCmd = Join-Path $PSScriptRoot 'YouTube-Menu.cmd'
if ($st.can_publish_later) {
    Write-Ok 'Este computador pode publicar e agendar vídeos depois do envio.'
} else {
    Write-Warn 'Sem a permissão de publicar/agendar: publique pelo YouTube Studio ou rode o assistente de novo.'
}
Write-Info "Menu do YouTube: $menuCmd"
Write-Info '  enviar (privado), ver vídeos, publicar agora, agendar, voltar a privado, desconectar.'
if (Read-YesNo 'Criar um atalho "YouTube - Agora Faz Sentido" na Área de Trabalho para o menu?' $true) {
    try {
        $lnk = Join-Path ([Environment]::GetFolderPath('Desktop')) 'YouTube - Agora Faz Sentido.lnk'
        $shell = New-Object -ComObject WScript.Shell
        $sc = $shell.CreateShortcut($lnk)
        $sc.TargetPath = $menuCmd
        $sc.WorkingDirectory = $Repo
        $sc.Description = 'Enviar, publicar e agendar vídeos no YouTube (Open Generative AI)'
        $sc.Save()
        Write-Ok "Atalho criado: $lnk"
    } catch {
        Write-Warn "Não consegui criar o atalho: $($_.Exception.Message)"
    }
}

Write-Title 'Pronto!'
Write-Info "Canal: $($authorized.title)  |  Tokens: $prot"
if ($uploaded) { Write-Info "Vídeo de teste (privado): https://youtu.be/$($uploaded.video_id)" }
Write-Info 'Próximos passos:'
Write-Info '  1. Revise o vídeo no YouTube Studio (ele está privado).'
Write-Info '  2. Para publicar ou agendar: atalho "YouTube - Agora Faz Sentido" (ou YouTube-Menu.cmd).'
Write-Info '  3. Pelo Claude Code neste PC: "publique o episódio 1" / "agende para sexta às 18h".'
Write-Info 'Cota grátis por dia: 100 envios + 10.000 unidades (publicar/agendar = 50). Zera à meia-noite do Pacífico.'
