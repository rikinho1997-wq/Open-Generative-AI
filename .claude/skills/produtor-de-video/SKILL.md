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
4. `oga_produce_video` de verdade. Ele devolve `job_id` se demorar; acompanhe com `oga_job_status` (`wait_seconds: 240`).
   Em CPU cada imagem leva ~1 min (modo rápido); avise o usuário do tempo estimado (≈ 1 min × nº de cenas com imagem).
5. Entregue: caminho do `.mp4`, do `.srt`, duração e custo. Olhe a miniatura retornada para conferir o resultado.
6. Para alterar: edite o roteiro e rode de novo com o **mesmo `output_name`** — só o que mudou é regerado.

## Formato do roteiro

```json
{
  "title": "Título do vídeo",
  "output_name": "nome-da-pasta",
  "format": { "aspect_ratio": "16:9", "resolution": "720p", "fps": 30 },
  "voice": { "voice": "pt_BR-faber-medium", "speed": 1.0 },
  "subtitles": { "enabled": true, "burn": true },
  "music": { "path": "C:/musicas/trilha-livre.mp3", "volume": 0.18 },
  "defaults": { "transition": "fade", "style": "photorealistic, cinematic lighting", "fast": true },
  "scenes": [
    { "visual": { "type": "color", "color": "#0b1f3a", "subtitle": "subtítulo" }, "narration": "Abertura…" },
    { "visual": { "type": "image", "prompt": "english visual description" }, "title": "Texto na tela", "narration": "…", "transition": "slideleft" },
    { "visual": { "type": "video", "prompt": "english description of the motion" }, "narration": "…" },
    { "visual": { "type": "file", "path": "C:/fotos/produto.jpg" }, "narration": "…" }
  ]
}
```

- `music` é opcional e deve ser um arquivo local com licença livre fornecido pelo usuário.
- Formatos: `16:9` (YouTube), `9:16` (Reels/Shorts/TikTok), `1:1` (feed).
- Transições: fade, fadeblack, fadewhite, dissolve, wipeleft, wiperight, slideleft, slideright, circleopen, radial, zoomin, pixelize, cut…
- Movimento da imagem (`visual.motion`): auto, zoom_in, zoom_out, pan_left, pan_right, pan_up, pan_down, static.
- `type: "video"` sem Wan2GP vira imagem animada automaticamente (`defaults.video_fallback_to_image`).

## Como escrever bem

- **Duração:** a narração define o tempo (~14 caracteres/s em pt-BR). 120 s ≈ 1.500 caracteres de narração no total.
  Bom padrão: 6–10 cenas de 1–2 frases cada.
- **Prompts visuais em inglês**: sujeito + ambiente + luz + estilo. Ex.: `"elderly fisherman mending nets on a wooden pier at dawn, soft mist"`.
  Os modelos locais (SD 1.5) não escrevem texto: coloque textos em `title` da cena, nunca no prompt.
- Mantenha o mesmo `style` em `defaults` para unidade visual; use `seed` fixo numa cena para reproduzi-la.
- Narração: frases curtas, números por extenso quando a pronúncia importar ("dois mil e vinte e seis").

## Ferramentas avulsas

- `oga_generate_image` — uma imagem (retorna prévia). `aspect_ratio`, `model`, `seed`, `fast`.
- `oga_text_to_speech` — só a narração em WAV.
- `oga_generate_video_clip` — clipe IA de até 10 s (Wan2GP; requer GPU).
- `oga_download_model` — modelos/vozes gratuitos (`dreamshaper-8`, `lcm-lora-sd15`, `z-image-turbo`, `pt_BR-cadu-medium`…).
- `oga_configure_wan2gp` — aponta para o Wan2GP local (pasta) ou remoto (URL MCP, ex. um PC com GPU na rede).

Exemplo completo: `claude-agent/examples/demo-pt-br.json`. Documentação: `claude-agent/README.md`.
