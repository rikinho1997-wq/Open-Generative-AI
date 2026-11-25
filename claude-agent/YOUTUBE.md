# Envio ao YouTube (YouTube Data API v3) — guia para Windows

O agente envia vídeos ao canal **AGORA FAZ SENTIDO** pela **API oficial e gratuita** do YouTube:

- OAuth 2.0 de app para computador (PKCE) e confirmação do canal;
- tokens criptografados fora do projeto;
- envio retomável, sempre **privado** no primeiro momento;
- publicação e agendamento depois.

Nenhum serviço pago é usado, e nenhuma credencial ou token vai para o GitHub.

> Faça a configuração **no seu computador**, onde está o navegador. Numa sessão do Claude na nuvem, o retorno do
> Google iria para o `127.0.0.1` do seu PC, não para o servidor.

---

## O que mudou na API em 2026 (documentação oficial, consultada em 25/11/2026)

| Data | Mudança | O que o agente faz |
|---|---|---|
| **16/11/2026** | `paidProductPlacementDetails.hasPaidProductPlacement` **deixou de ter padrão `false`**. Sem o campo, o vídeo fica sem declaração. | Sempre envia o campo: `false`, ou `true` com `--paid-placement`. |
| **03/11/2026** | `thumbnails.set` passou a aceitar thumbnails de **Shorts**, só **depois do processamento**. | Em Shorts, espera o processamento e só então aplica a thumbnail. |
| **02/11/2026** | Projetos **não verificados não ficam mais presos ao modo privado**: a restrição de 2020, que exigia auditoria, acabou. **Sem `privacyStatus`, o envio agora fica público.** Algumas contas ainda forçam privado. | Sempre envia `privacyStatus` explícito, **privado por padrão**. Não é preciso auditoria para publicar. |
| 15/10/2026 | `madeForKids` só muda quando é enviado. | Sempre envia `selfDeclaredMadeForKids` (padrão `false`). |
| 14/09/2026 | Thumbnail: limite de **2 MB → 50 MB**. | Aceita até 50 MB. |
| **01/06/2026** | **Cota granular**: `videos.insert` e `search.list` ganharam cotas próprias. | Veja a tabela abaixo. |
| 04/12/2025 | Custo de um envio caiu de ~1.600 para ~100 unidades. | Superado pela cota granular. |

### Cota gratuita por projeto (padrão)

A cota zera à **meia-noite do horário do Pacífico**: 5h de Brasília, ou 4h de março a novembro, no horário de verão dos EUA.

| O quê | Limite diário | Custo |
|---|---|---|
| Envios (`videos.insert`) | **100 envios/dia**, cota própria | 1 por envio |
| Buscas (`search.list`) | 100/dia, cota própria | 1 (o agente não usa) |
| Todo o resto | **10.000 unidades/dia** | thumbnail 50 · publicar/agendar (`videos.update`) 50 · listar vídeos/canal 1 |

O uso aparece em Google Cloud → APIs e serviços → Cotas. Para pedir mais cota, use o
[Quota Extension Form](https://support.google.com/youtube/contact/yt_api_form). Não é necessário para um canal.

Fontes oficiais:

- [Revision history](https://developers.google.com/youtube/v3/revision_history)
- [Quota calculator](https://developers.google.com/youtube/v3/determine_quota_cost)
- [videos.insert](https://developers.google.com/youtube/v3/docs/videos/insert)
- [videos.update](https://developers.google.com/youtube/v3/docs/videos/update)
- [thumbnails.set](https://developers.google.com/youtube/v3/docs/thumbnails/set)

---

## Passo a passo no Windows (cerca de 10 minutos)

### Passo 1 — Conferir o Google Cloud

Você já criou o projeto, ativou a YouTube Data API v3 e criou o cliente **App para computador**. Em
[Google Auth Platform](https://console.cloud.google.com/auth/overview), confira:

1. **Público-alvo**:
   - tipo **Externo**;
   - seu e-mail (dono ou gerente do canal) em **Usuários de teste**.

   Enquanto o app estiver em **"Teste"**, o Google faz a autorização **expirar a cada 7 dias**. Para automação contínua,
   clique em **Publicar app** ("Em produção"). Para uso próprio não é preciso verificação: aparecerá *"O Google não
   verificou este app"* → **Avançado** → **Acessar**.
2. **Acesso a dados** → **Adicionar ou remover escopos**. Marque:
   - `.../auth/youtube.upload`: enviar vídeos (você já tem);
   - `.../auth/youtube.readonly`: confirmar qual canal foi autorizado;
   - `.../auth/youtube.force-ssl`: publicar e agendar depois do envio (opcional).
3. **Clientes** → seu cliente *App para computador* → **Baixar JSON** (`client_secret_….json`, vai para Downloads).

### Passo 2 — Baixar o projeto e o vídeo

1. Na pasta do projeto, atualize o código com `git pull`, ou baixe de novo pelo GitHub.
2. Deixe o MP4 do episódio 1 que você baixou desta conversa na pasta **Downloads**, com o nome original
   `AGORA-FAZ-SENTIDO-ep01-congestionamento-fantasma-1080p.mp4`. Se quiser a thumbnail, deixe também
   `thumbnail-1280x720.jpg`. O assistente encontra os dois sozinho e confere o SHA-256.
3. Precisa do **Node.js 18+**. Se faltar, o assistente oferece instalar pelo `winget`, de graça.

### Passo 3 — Rodar o assistente

Abra a pasta `claude-agent\windows` do projeto e dê **dois cliques em `Configurar-YouTube.cmd`**. Ou rode no PowerShell,
dentro da pasta do projeto:

```powershell
powershell -NoProfile -STA -ExecutionPolicy Bypass -File claude-agent\windows\youtube-setup.ps1
```

O assistente faz tudo em sequência:

| Etapa | O que acontece |
|---|---|
| **1. JSON OAuth** | Abre uma janela do Windows para você **selecionar o `client_secret_….json`**. Ele é copiado para o cofre criptografado e o assistente oferece **apagar o original**. |
| **2. Navegador** | Abre a tela do Google. Escolha a conta e, na lista de canais ou Contas de Marca, o **AGORA FAZ SENTIDO**. Marque todas as permissões. |
| **3. Canal** | Lê o canal autorizado (`channels.list`). Se não for o AGORA FAZ SENTIDO, **revoga e pede de novo**, e nada é enviado. O canal fica vinculado: envios futuros são bloqueados se o token mudar de canal. |
| **4. Tokens** | Mostra onde e como ficaram guardados (DPAPI) e confere se não há credencial exposta ao Git dentro do projeto. |
| **5. Envio de teste** | Encontra o MP4 e a thumbnail, confere o SHA-256 e envia o episódio 1 como **PRIVADO**. Depois abre o YouTube Studio para você revisar. |
| **6. Depois** | Cria o atalho **"YouTube - Agora Faz Sentido"** na Área de Trabalho, que abre o menu de publicar e agendar. |

Se algo falhar, rode de novo: o assistente pula o que já está pronto. Opções úteis:

- `-ClientSecret caminho.json`: pula a janela de seleção do arquivo;
- `-Video arquivo.mp4`: escolhe outro vídeo para o envio de teste;
- `-SkipUpload`: configura tudo sem enviar;
- `-NoManage`: autoriza só envio, sem publicar ou agendar.

### Passo 4 — Revisar, publicar e agendar

Dê dois cliques no atalho **"YouTube - Agora Faz Sentido"** ou em `claude-agent\windows\YouTube-Menu.cmd`:

```
1  Enviar um vídeo (sempre PRIVADO)        5  Voltar para privado / cancelar agendamento
2  Ver meus vídeos enviados                6  Abrir o YouTube Studio
3  Publicar agora (público ou não listado)  7  Autorizar de novo (trocar canal / ativar publicar)
4  Agendar a publicação                    8  Desconectar este computador
```

- **Publicar** pede confirmação explícita antes de deixar o vídeo público.
- **Agendar**: digite a data e a hora no horário do seu PC, por exemplo `05/12/2026 18:00`. Até lá o vídeo fica
  privado. Pela regra da API, só dá para agendar um vídeo **privado que nunca foi publicado**.
- Publicar ou agendar preservam as outras configurações de status do vídeo. O agente relê o status atual antes de
  enviar, porque o `videos.update` apaga os campos omitidos.

Pelo Claude Code no seu PC também funciona, por exemplo: *"publique o episódio 1"* ou *"agende o episódio 1 para
sexta às 18h"*. As ferramentas usadas são `oga_youtube_set_visibility` e `oga_youtube_videos`.

---

## Linha de comando (equivalente ao assistente)

```powershell
node claude-agent\bin\oga.mjs youtube setup --client-secret "$env:USERPROFILE\Downloads\client_secret_XXXX.json"
node claude-agent\bin\oga.mjs youtube auth --manage          # --manage = permitir publicar/agendar depois
node claude-agent\bin\oga.mjs youtube channel                # canal autorizado
node claude-agent\bin\oga.mjs youtube upload "$env:USERPROFILE\Downloads\AGORA-FAZ-SENTIDO-ep01-congestionamento-fantasma-1080p.mp4" `
    --meta productions\agora-faz-sentido\ep01-congestionamento-fantasma\youtube-ep01.json `
    --thumbnail "$env:USERPROFILE\Downloads\thumbnail-1280x720.jpg" --privacy private --expect-channel "AGORA FAZ SENTIDO"
node claude-agent\bin\oga.mjs youtube videos                 # status, visibilidade e agendamento
node claude-agent\bin\oga.mjs youtube publish VIDEO_ID --privacy public
node claude-agent\bin\oga.mjs youtube schedule VIDEO_ID --at 2026-12-05T18:00:00-03:00
node claude-agent\bin\oga.mjs youtube status | history | logout
```

Outras opções de `upload`:

- `--title`, `--description-file`, `--tags "a,b"`, `--category 28`, `--language pt-BR`;
- `--no-thumbnail`;
- `--synthetic`: declara conteúdo realista alterado ou gerado por IA. Avalie em cada vídeo, conforme as regras do
  YouTube;
- `--paid-placement`: declara merchandising pago;
- `--allow-duplicate`: o agente bloqueia reenvio do mesmo arquivo por engano.

---

## Segurança

| Item | Onde fica | Proteção |
|---|---|---|
| Cliente OAuth e tokens | `%APPDATA%\open-generative-ai\youtube\` | **DPAPI**: só a sua conta do Windows, neste PC, consegue abrir |
| Alternativa | idem | **AES-256-GCM** com senha, se a variável `OGA_YT_PASSPHRASE` estiver definida |

- O agente **recusa** gravar credenciais dentro do projeto, e o `.gitignore` bloqueia `client_secret*.json`,
  `token.json` e `*.oauth.json`.
- O assistente confere com o Git se algum arquivo de credencial está exposto no projeto.
- Permissões pedidas: o **mínimo** para cada perfil:
  - só envio: `youtube.upload` + `youtube.readonly`;
  - com publicar/agendar: `youtube.upload` + `youtube.force-ssl`, usado apenas quando você pede.
- **Nunca** cole o client secret, códigos ou tokens no chat.
- **Revogar**: opção 8 do menu, `youtube logout` ou https://myaccount.google.com/permissions.
- **Se o client secret vazar**:
  1. Google Cloud → Clientes → **Redefinir chave secreta**;
  2. baixe o novo JSON;
  3. rode o assistente de novo. Ele troca o cliente e revoga a autorização antiga.

## Problemas comuns

| Mensagem | Causa e solução |
|---|---|
| `invalid_grant` / "autorização expirou" | App em "Teste" (7 dias) ou acesso revogado. Publique o app (passo 1) e rode o assistente. |
| `access_denied` / "acesso bloqueado" | Sua conta não está em Usuários de teste, ou você recusou a permissão. |
| "Você autorizou o canal X, não AGORA FAZ SENTIDO" | Na tela do Google, escolha a Conta de Marca do canal. Se ela não aparecer, use "Usar outra conta" e confira se você é dono ou gerente. |
| "exige uma permissão que esta autorização não tem" | Autorize com publicar/agendar: menu → 7, ou `youtube auth --manage`. |
| `redirect_uri_mismatch` / "Aplicativo da Web" | O cliente não é *App para computador*. Crie um desse tipo. |
| `quotaExceeded` / `uploadLimitExceeded` | Cota do dia esgotada (100 envios ou 10.000 unidades). Espere a virada, às 5h de Brasília (4h de março a novembro). |
| Thumbnail "não definida" | Canal sem verificação por telefone (youtube.com/verify) ou Short ainda em processamento. O vídeo sobe mesmo assim. |
| A janela de seleção não abre | O assistente pede o caminho do arquivo. Cole o caminho, por exemplo com "Copiar como caminho" no Explorer. |
| "a execução de scripts foi desabilitada" | Use os arquivos `.cmd`: eles rodam o PowerShell com `-ExecutionPolicy Bypass` só para esse script. |
