# Envio automático ao YouTube (YouTube Data API v3)

O agente envia vídeos ao canal pela **API oficial e gratuita** do YouTube: OAuth 2.0 de app para computador
(com PKCE), envio resumível, título/descrição/tags, thumbnail, visibilidade e agendamento.
Escopo pedido: só `youtube.upload` (o mínimo para enviar vídeos).

> **Faça a autorização e os envios no seu computador** (Windows/macOS/Linux), onde está o navegador.
> Numa sessão do Claude na nuvem, o retorno do Google vai para o `127.0.0.1` do *seu* PC, não do container.

---

## 1. Ajustes no Google Cloud (5 minutos)

Você já criou o projeto, ativou a API e criou o cliente **App para computador**. Confira também:

1. **Tela de consentimento OAuth** (Google Auth Platform → Público-alvo):
   - Tipo de usuário **Externo**, com o seu e-mail (dono/gerente do canal) em **Usuários de teste**.
   - **Importante:** enquanto o app estiver em **"Teste"**, o Google faz a autorização **expirar a cada 7 dias**.
     Para automação contínua, clique em **Publicar app** ("Em produção"). Não precisa de verificação para uso próprio:
     na autorização aparecerá *"O Google não verificou este app"* → **Avançado** → **Acessar (não seguro)**.
     Isso é esperado para um app seu (limite de 100 usuários).
2. **Escopo** `.../auth/youtube.upload` adicionado em Acesso a dados (você já fez).

## 2. Guardar o JSON de credenciais com segurança

1. Google Cloud → **APIs e serviços → Credenciais** → seu cliente *App para computador* → **Baixar JSON**
   (arquivo `client_secret_….apps.googleusercontent.com.json`).
2. **Não** coloque esse arquivo na pasta do projeto. Importe-o para o cofre local:

   ```powershell
   node claude-agent\bin\oga.mjs youtube setup --client-secret "$env:USERPROFILE\Downloads\client_secret_XXXX.json"
   ```

   O agente copia o conteúdo para o **cofre fora do Git** e protege assim:

   | Sistema | Onde fica | Proteção |
   |---|---|---|
   | Windows | `%APPDATA%\open-generative-ai\youtube\` | criptografado com **DPAPI** (só a sua conta do Windows abre) |
   | macOS / Linux | `~/Library/Application Support/…/youtube` · `~/.config/open-generative-ai/youtube` | pasta 0700 e arquivos 0600 |
   | Qualquer um, opcional | idem | **AES-256-GCM** com senha, se `OGA_YT_PASSPHRASE` estiver definida |

3. **Apague o JSON baixado** (ou guarde-o num gerenciador de senhas). O cofre já tem a cópia.
4. Proteções extras: o `.gitignore` bloqueia `client_secret*.json` e `token.json`, e o agente se recusa a gravar
   credenciais dentro do repositório. **Nunca** cole o client secret, códigos ou tokens no chat.

## 3. Autorização inicial pelo navegador (uma vez)

```powershell
node claude-agent\bin\oga.mjs youtube auth
```

1. O navegador abre na tela do Google (se não abrir, copie o link exibido no terminal).
2. Escolha a conta e o **canal AGORA FAZ SENTIDO** (se for uma Conta de Marca, selecione-a na lista).
3. Permita **"Gerenciar seus vídeos do YouTube"** → aparece a página *Autorização concluída*.
4. O *refresh token* fica criptografado no cofre; o *access token* (1 h) é renovado sozinho a cada envio.

Pelo Claude (com o Claude Code rodando no seu PC): *"autorize o YouTube"* → ferramenta `oga_youtube_authorize`.

Conferir: `node claude-agent\bin\oga.mjs youtube status` (nunca mostra segredos).

## 4. Primeiro envio — privado, para revisão

Os metadados do episódio 1 já estão prontos em
`productions/agora-faz-sentido/ep01-congestionamento-fantasma/youtube-ep01.json` (privado, pt-BR, Ciência e
tecnologia, thumbnail, sem notificar inscritos).

```powershell
node claude-agent\bin\oga.mjs youtube upload --meta productions\agora-faz-sentido\ep01-congestionamento-fantasma\youtube-ep01.json
```

Resultado: link `https://youtu.be/…` e o link do YouTube Studio para revisar. Pelo Claude:
*"envie o episódio 1 ao YouTube como privado"* → `oga_youtube_upload` com `metadata_file`.

Outras opções: `--title`, `--description-file`, `--tags "a,b"`, `--category 28`, `--language pt-BR`,
`--thumbnail thumb.jpg`, `--synthetic` (declara conteúdo realista gerado por IA), `--allow-duplicate`.
O agente bloqueia o reenvio do mesmo arquivo por engano (histórico em `youtube history`).

## 5. Visibilidade e agendamento — e o limite da API

- `--privacy private | unlisted | public` (padrão: **private**).
- `--publish-at 2026-12-01T18:00:00-03:00` agenda a publicação; pela regra da API o vídeo fica **privado até a hora marcada**.
- **Limite oficial:** segundo a documentação da API, vídeos enviados por **projetos não auditados** criados após
  28/07/2020 ficam **restritos ao modo privado**. Para liberar público, não listado e agendamento pela API, peça a
  auditoria gratuita do projeto no formulário *"YouTube API Services – Audit and Quota Extension Form"* (Google).
  Até lá, use envios privados e revise no Studio. Se o resultado mostrar visibilidade diferente da pedida, o agente avisa.

## 6. Cotas e outros limites (gratuitos)

- Cota padrão: **10.000 unidades/dia**. Cada envio custa cerca de **1.600** (≈ 6 vídeos por dia); thumbnail, cerca de 50.
- Thumbnail personalizada exige canal verificado por telefone (youtube.com/verify). Se falhar, o vídeo sobe mesmo assim.
- Legendas `.srt`: a API de legendas exige um escopo mais amplo (`youtube.force-ssl`). Os vídeos já têm legenda gravada;
  para enviar a faixa `.srt` separada, use o YouTube Studio.

## 7. Revogar e emergências

- Revogar acesso: `node claude-agent\bin\oga.mjs youtube logout` (ou https://myaccount.google.com/permissions).
- Se o client secret vazar: Google Cloud → Credenciais → seu cliente → **Redefinir chave secreta**, rode
  `youtube logout`, baixe o novo JSON e repita `youtube setup` + `youtube auth`.

## 8. Problemas comuns

| Mensagem | Causa e solução |
|---|---|
| `invalid_grant` / "autorização expirou" | Token revogado ou app em "Teste" (7 dias). Publique o app (seção 1) e rode `youtube auth`. |
| `access_denied` / "acesso bloqueado" | Sua conta não está em Usuários de teste, ou você recusou a permissão. |
| `redirect_uri_mismatch` / "tipo Aplicativo da Web" | O cliente não é *App para computador*. Crie um desse tipo. |
| `quotaExceeded` | Cota diária esgotada; tente no dia seguinte. |
| `youtubeSignupRequired` | A conta escolhida não tem canal; selecione a conta/canal certo na autorização. |
