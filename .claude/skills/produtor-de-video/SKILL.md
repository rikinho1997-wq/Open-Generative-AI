---
name: produtor-de-video
description: Gera imagens, narrações e vídeos narrados de várias cenas (até 120 s, com legendas, transições e trilha) usando o Open Generative AI com motores locais gratuitos. Use quando o usuário pedir para criar/gerar uma imagem, ilustração, narração, locução, clipe, vídeo, reels, shorts, vídeo explicativo ou apresentação em vídeo. Also triggers on English requests to generate images or videos with this project.
---

# Produtor de vídeo — Open Generative AI

Você controla o projeto pelas ferramentas MCP `oga_*` (servidor `open-generative-ai`, registrado em `.mcp.json`).
Se as ferramentas MCP não estiverem disponíveis, use a CLI equivalente via Bash: `node claude-agent/bin/oga.mjs <comando>`
(`doctor`, `image`, `tts`, `produce roteiro.json [--dry-run]`). Para renderizações longas pela CLI, rode em segundo plano.

## Regras inegociáveis

1. **Gratuito primeiro.** Imagem = `provider: "local"` (sd.cpp). Vídeo IA = `wan2gp` (só com GPU). Voz = Piper/SAPI/eSpeak.
2. **Nunca** use `provider: "muapi"` nem `allow_paid: true` sem o usuário autorizar explicitamente, nesta conversa,
   aquela geração paga. Se ele pedir um modelo que só existe pago (Kling, Veo, Sora, Flux Pro…), explique que é pago e pergunte.
3. Nunca escreva chaves de API em arquivos, commits ou mensagens. A chave MuAPI só pode vir da variável de ambiente `MUAPI_API_KEY`.
4. Vídeo final ≤ 120 s. Sempre rode `oga_produce_video` com `dry_run: true` antes de produzir.

## Fluxo para um vídeo

1. `oga_doctor` (uma vez por sessão) → veja `capabilities` e `todo`. Se faltar algo, diga ao usuário o comando exato do `todo`.
2. Escreva o roteiro (formato abaixo). Mostre ao usuário a lista de cenas (narração + visual) e ajuste se ele pedir.
3. `oga_produce_video` com `dry_run: true` → confira `ok` e `estimated_total_seconds`.
4. `oga_produce_video` de verdade. Ele devolve `job_id` se demorar; acompanhe chamando `oga_job_status` (`wait_seconds: 50`) repetidamente até `status: "done"`.
   Em CPU cada imagem leva ~1 min (modo rápido); avise o usuário do tempo estimado (≈ 1 min × nº de cenas com imagem).
5. Confira o resultado (miniatura, quadros, áudio) e **envie o MP4 final como anexo para download** na conversa
   (SendUserFile, `display: "attach"`), com resolução, duração, codecs e o `sha256` do resultado na legenda.
   Isso é obrigatório em toda entrega de vídeo — nunca entregue só o caminho interno. Inclua também o `.srt`.
   Sem anexos disponíveis: publique um Artifact privado com o MP4 como asset (≤ 15 MB) e entregue o link.
6. Para alterar: edite o roteiro e rode de novo com o **mesmo `output_name`** — só o que mudou é regerado.

## Formato do roteiro

```json
{
  "title": "Título do vídeo",
  "output_name": "nome-da-pasta",
  "format": { "aspect_ratio": "16:9", "resolution": "720p", "fps": 30, "target_seconds": 120 },
  "voice": { "voice": "pt_BR-faber-medium", "speed": 1.0 },
  "subtitles": { "enabled": true, "burn": true },
  "music": { "generate": true, "mood": "emotional", "volume": 0.16 },
  "defaults": { "transition": "fade", "style": "photorealistic, cinematic lighting", "fast": true },
  "scenes": [
    { "visual": { "type": "color", "color": "#0b1f3a", "subtitle": "subtítulo" }, "narration": "Abertura…" },
    { "visual": { "type": "image", "prompt": "english visual description" }, "title": "Texto na tela", "narration": "…", "transition": "slideleft" },
    { "visual": { "type": "video", "prompt": "english description of the motion" }, "narration": "…" },
    { "visual": { "type": "file", "path": "C:/fotos/produto.jpg" }, "narration": "…" }
  ]
}
```

- `music` é opcional: `generate: true` cria uma trilha instrumental original livre de direitos (moods: emotional, hopeful,
  calm, reflective); ou `path` para um arquivo local com licença livre fornecido pelo usuário.
- `format.target_seconds`: duração exata; a sobra vira pausas entre cenas (a narração precisa caber).
- Formatos: `16:9` (YouTube), `9:16` (Reels/Shorts/TikTok), `1:1` (feed).
- Transições: fade, fadeblack, fadewhite, dissolve, smoothleft/right/up/down, wipeleft, wiperight, slideleft, slideright, circleopen, radial, zoomin, pixelize, cut…
- Vozes: pt-BR `pt_BR-faber-medium`/`pt_BR-cadu-medium`; espanhol latino `es_MX-claude-high` (feminina) ou `es_AR-daniela-high`
  (baixe com `oga_download_model`). Use `language` coerente (ex. `es-MX`).
- Movimento da imagem (`visual.motion`): auto, zoom_in, zoom_out, pan_left, pan_right, pan_up, pan_down, static.
- `type: "video"` sem Wan2GP vira imagem animada automaticamente (`defaults.video_fallback_to_image`).

## Como escrever bem

- **Duração:** a narração define o tempo (~14 caracteres/s). 120 s com 12 cenas ≈ 1.400 caracteres de narração.
  Meça antes: o `dry_run` estima; a duração real vem do áudio.
  Bom padrão: 6–10 cenas de 1–2 frases cada.
- **Prompts visuais em inglês**: sujeito + ambiente + luz + estilo. Ex.: `"elderly fisherman mending nets on a wooden pier at dawn, soft mist"`.
  Os modelos locais (SD 1.5) não escrevem texto: coloque textos em `title` da cena, nunca no prompt.
- No modo rápido (`fast`, padrão) o prompt negativo é ignorado: descreva no prompt positivo o que deve aparecer
  (ex.: roupas recatadas, "seen from behind", planos abertos — rostos de perto saem piores no SD 1.5).
- Confira as imagens geradas (pasta `visuals/`); para refazer uma cena, mude o `seed` dela e rode de novo.
- Mantenha o mesmo `style` em `defaults` para unidade visual; use `seed` fixo numa cena para reproduzi-la.
- Narração: frases curtas, números por extenso quando a pronúncia importar ("dois mil e vinte e seis").

## Produção avançada (canal, explicativos)

- Ritmo dinâmico: `defaults.lead_in: 0.05`, `defaults.tail: 0.12`, transições de 0.3 s; uma frase por cena (3–6 s).
- Identidade visual: `branding` (fonte .ttf + cores de título e legenda). Efeitos: `scenes[].sfx`.
- Animações/diagramas próprios: rode `produce --plan` (ou `oga_produce_video` com `plan_only`), renderize os clipes
  com as durações de `timeline.json` e use-os como `visual.type: "file"`. Exemplo: `productions/agora-faz-sentido/`.
- Shorts a partir de imagens 16:9: `visual.fit: "blur"`. Master de upload: `format.quality: "high"`.
- Antes de entregar: confira quadros (contato a cada 4 s), `freezedetect` (nada parado > 1,5 s), loudness (~-16 LUFS)
  e se nada fica sob as legendas (faixa inferior ~18% do quadro).

## Publicar no YouTube

- Só quando o usuário pedir o envio. `oga_youtube_status` primeiro; sem autorização, oriente pelo `claude-agent/YOUTUBE.md`
  (no Windows: dois cliques em `claude-agent\windows\Configurar-YouTube.cmd`).
- `oga_youtube_upload` com `metadata_file` (ex.: `productions/.../youtube-ep01.json`) ou campos diretos. Padrão **privado**;
  público, não listado ou `publish_at` apenas a pedido explícito. Informe o link `youtu.be` e o do Studio.
  Para o canal do projeto, passe `expected_channel: "AGORA FAZ SENTIDO"` (o envio é bloqueado se o token for de outro canal).
- Publicar/agendar depois: `oga_youtube_videos` para ver o status e `oga_youtube_set_visibility` (`privacy` ou `publish_at`),
  só a pedido explícito. Agendamento só vale para vídeo privado nunca publicado; exige autorização com `manage`.
- Nunca peça nem mostre client secret, códigos ou tokens no chat.

## Ferramentas avulsas

- `oga_generate_image` — uma imagem (retorna prévia). `aspect_ratio`, `model`, `seed`, `fast`.
- `oga_text_to_speech` — só a narração em WAV.
- `oga_generate_video_clip` — clipe IA de até 10 s (Wan2GP; requer GPU).
- `oga_download_model` — modelos/vozes gratuitos (`dreamshaper-8`, `lcm-lora-sd15`, `z-image-turbo`, `pt_BR-cadu-medium`…).
- `oga_configure_wan2gp` — aponta para o Wan2GP local (pasta) ou remoto (URL MCP, ex. um PC com GPU na rede).

Exemplo completo: `claude-agent/examples/demo-pt-br.json`. Documentação: `claude-agent/README.md`.
