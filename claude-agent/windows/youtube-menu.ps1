# Menu do YouTube — Open Generative AI (Windows).
# Dois cliques em  claude-agent\windows\YouTube-Menu.cmd  (ou no atalho da Área de Trabalho).
# Envia (sempre privado), lista, publica, agenda e desconecta. Rode antes o Configurar-YouTube.cmd.
[CmdletBinding()]
param([string]$Channel = 'AGORA FAZ SENTIDO')

. (Join-Path $PSScriptRoot 'youtube-common.ps1')
try { $Host.UI.RawUI.WindowTitle = "YouTube — $Channel" } catch {}

Assert-Node

function Show-Header {
    $st = Invoke-Oga @('youtube', 'status')
    Write-Title "YouTube — $Channel"
    if (-not $st -or -not $st.authorized) {
        Write-Warn 'Ainda não autorizado. Use a opção 7 (ou o Configurar-YouTube.cmd).'
    } else {
        $ch = if ($st.channel) { "$($st.channel.title) ($($st.channel.id))" } else { 'não confirmado' }
        $pub = if ($st.can_publish_later) { 'enviar + publicar/agendar' } else { 'só enviar' }
        Write-Info "Canal: $ch   |   Permissões: $pub   |   Cofre: $($st.protection)"
        if ($st.channel -and -not (Test-ChannelMatch $st.channel $Channel)) {
            Write-Warn "O canal autorizado não é $Channel. Use a opção 7 para autorizar o canal certo."
        }
    }
    return $st
}

# Lista os vídeos enviados por este computador (status ao vivo; 1 unidade de cota).
function Get-MyVideos {
    $history = @(Invoke-Oga @('youtube', 'history') | Where-Object { $_ })
    if (-not $history.Count) { return @() }
    $scopes = @($script:st.granted_scopes)
    $canRead = $script:st.authorized -and (($scopes -contains 'youtube.readonly') -or ($scopes -contains 'youtube.force-ssl'))
    $live = if ($canRead) { @(Invoke-Oga @('youtube', 'videos') | Where-Object { $_ }) } else { @() }
    $list = @()
    foreach ($h in ($history | Select-Object -Last 20)) {
        $v = $live | Where-Object { $_.video_id -eq $h.video_id } | Select-Object -First 1
        if ($v) { $list += $v }
        else { $list += [pscustomobject]@{ video_id = $h.video_id; title = $h.title; privacy = $h.privacy; publish_at = $h.publish_at; processing = '?'; url = "https://youtu.be/$($h.video_id)" } }
    }
    [array]::Reverse($list)
    return $list
}


function Show-Videos($list) {
    if (-not $list.Count) { Write-Info 'Nenhum vídeo enviado por este computador ainda.'; return }
    $i = 0
    foreach ($v in $list) {
        $i++
        $vis = Format-Privacy $v.privacy
        if ($v.publish_at) { $vis = "agendado p/ $(Format-When $v.publish_at)" }
        Write-Host ('  {0,2}) {1}' -f $i, $v.title)
        Write-Info "    $vis  |  processamento: $($v.processing)  |  $($v.url)"
    }
}

# Pede um vídeo: número da lista, link ou ID.
function Select-Video([string]$action) {
    $list = @(Get-MyVideos)
    Show-Videos $list
    $answer = ([string](Read-Host "  Qual vídeo $($action)? (número, link ou ID; Enter para voltar)")).Trim()
    if (-not $answer) { return $null }
    if ($answer -match '^\d+$' -and [int]$answer -ge 1 -and [int]$answer -le $list.Count) { return $list[[int]$answer - 1] }
    $id = Get-VideoIdFromText $answer
    if ($id) { return [pscustomobject]@{ video_id = $id; title = $id; privacy = $null } }
    Write-Warn 'Não reconheci esse vídeo.'
    return $null
}

function Read-ScheduleDate {
    Write-Info 'Data e hora da publicação no horário deste computador. Exemplos: 05/12/2026 18:00  ou  2026-12-05 18:00'
    $text = ([string](Read-Host '  Quando publicar?')).Trim()
    if (-not $text) { return $null }
    $formats = [string[]]@('dd/MM/yyyy HH:mm', 'd/M/yyyy H:mm', 'dd/MM/yyyy H:mm', 'yyyy-MM-dd HH:mm', 'yyyy-MM-dd H:mm', 'dd/MM/yy HH:mm')
    $dt = [datetime]::MinValue
    if (-not [datetime]::TryParseExact($text, $formats, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AssumeLocal, [ref]$dt)) {
        Write-Warn 'Data inválida. Use dia/mês/ano hora:minuto, por exemplo 05/12/2026 18:00.'
        return $null
    }
    $when = [DateTimeOffset]::new($dt)
    if ($when -le [DateTimeOffset]::Now.AddMinutes(5)) { Write-Warn 'Escolha um horário pelo menos alguns minutos no futuro.'; return $null }
    return $when
}

function Show-Change($r) {
    if (-not $r) { Write-Warn 'Não foi possível alterar (veja a mensagem acima).'; return }
    $after = if ($r.after.publish_at) { "privado, agendado para $(Format-When $r.after.publish_at)" } else { Format-Privacy $r.after.privacy }
    Write-Ok "$($r.title): $(Format-Privacy $r.before.privacy) -> $after"
    Write-Info $r.url
}

while ($true) {
    $st = Show-Header
    Write-Host ''
    Write-Host '   1  Enviar um vídeo (sempre PRIVADO)'
    Write-Host '   2  Ver meus vídeos enviados'
    Write-Host '   3  Publicar agora (público ou não listado)'
    Write-Host '   4  Agendar a publicação'
    Write-Host '   5  Voltar um vídeo para privado / cancelar agendamento'
    Write-Host '   6  Abrir o YouTube Studio'
    Write-Host '   7  Autorizar de novo (trocar canal ou ativar publicar/agendar)'
    Write-Host '   8  Desconectar este computador (revoga o acesso e apaga o token)'
    Write-Host '   0  Sair'
    $choice = ([string](Read-Host '  Opção')).Trim()
    try {
        switch ($choice) {
            '1' {
                Write-Info 'Opcional: um arquivo de metadados (.json) com título, descrição, tags e thumbnail.'
                $metaPath = $null
                if (Read-YesNo 'Usar um arquivo de metadados?' $true) {
                    $metaPath = Select-File 'Selecione o arquivo de metadados do YouTube (.json)' 'Metadados (*.json)|*.json' (Join-Path $Repo 'productions')
                }
                [void](Invoke-PrivateUpload -MetaPath $metaPath -Channel $Channel)
            }
            '2' { Show-Videos @(Get-MyVideos) }
            '3' {
                if (-not $st.can_publish_later) { Write-Warn 'Sem permissão para publicar por aqui: use a opção 7 e permita publicar/agendar.'; break }
                $v = Select-Video 'publicar'
                if (-not $v) { break }
                $vis = if (Read-YesNo 'Publicar como PÚBLICO? (n = não listado: só quem tiver o link vê)' $true) { 'public' } else { 'unlisted' }
                $label = if ($vis -eq 'public') { 'visível para TODOS' } else { 'visível para quem tiver o link' }
                if (Read-YesNo "Confirmar: ""$($v.title)"" ficará $label agora?" $false) {
                    Show-Change (Invoke-Oga @('youtube', 'publish', $v.video_id, '--privacy', $vis))
                }
            }
            '4' {
                if (-not $st.can_publish_later) { Write-Warn 'Sem permissão para agendar por aqui: use a opção 7 e permita publicar/agendar.'; break }
                Write-Info 'Regra da API: só dá para agendar um vídeo PRIVADO que nunca foi publicado.'
                $v = Select-Video 'agendar'
                if (-not $v) { break }
                $when = Read-ScheduleDate
                if (-not $when) { break }
                $iso = $when.ToString("yyyy-MM-dd'T'HH:mm:sszzz", [Globalization.CultureInfo]::InvariantCulture)
                if (Read-YesNo "Confirmar: ""$($v.title)"" será publicado em $($when.ToString('dd/MM/yyyy HH:mm')) (até lá fica privado)?" $true) {
                    Show-Change (Invoke-Oga @('youtube', 'schedule', $v.video_id, '--at', $iso))
                }
            }
            '5' {
                if (-not $st.can_publish_later) { Write-Warn 'Sem permissão para alterar por aqui: use a opção 7.'; break }
                $v = Select-Video 'tornar privado'
                if ($v -and (Read-YesNo "Tornar ""$($v.title)"" privado (cancela agendamento, se houver)?" $true)) {
                    Show-Change (Invoke-Oga @('youtube', 'publish', $v.video_id, '--privacy', 'private'))
                }
            }
            '6' {
                $url = if ($st.channel) { "https://studio.youtube.com/channel/$($st.channel.id)/videos" } else { 'https://studio.youtube.com' }
                Start-Process $url
            }
            '7' {
                & (Join-Path $PSScriptRoot 'youtube-setup.ps1') -Channel $Channel -SkipUpload
            }
            '8' {
                if (Read-YesNo 'Desconectar? O acesso é revogado no Google e o token é apagado deste PC.' $false) {
                    $r = Invoke-Oga @('youtube', 'logout')
                    if ($r) { Write-Ok 'Desconectado. As credenciais do cliente continuam no cofre (para reautorizar).' }
                }
            }
            '0' { return }
            default { Write-Warn 'Opção inválida.' }
        }
    } catch {
        Write-Host "Erro: $($_.Exception.Message)" -ForegroundColor Red
    }
    Write-Host ''
    Wait-Enter
}
