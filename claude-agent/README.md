# Agente Claude para o Open Generative AI

Transforma o Claude (Claude Code, no terminal, no app desktop ou na web) em um agente que gera **imagens**,
**narrações** e **vídeos narrados de várias cenas (até 120 s)** com legendas, transições e trilha sonora —
usando **motores locais gratuitos e de código aberto** por padrão.

Você pede em português, o Claude escreve o roteiro, mostra para você, gera tudo e entrega o `.mp4`.

> Exemplo de pedido: *"Crie um vídeo vertical de 60 segundos explicando como fazer café coado, com narração
> e legendas."*

---

## 1. O que está operacional

| Função | Motor | Custo | Precisa de GPU? | Status |
|---|---|---|---|---|
| Gerar imagem | sd.cpp + Dreamshaper 8 (SD 1.5) | grátis | não (CPU: 1–3 min/imagem no modo rápido) | ✅ testado |
| Modo rápido de imagem | LCM-LoRA (5 passos) | grátis | não | ✅ testado |
| Outros modelos de imagem | Realistic Vision, Anything v5, SDXL, Z-Image Turbo/Base | grátis | recomendado para SDXL/Z-Image | ⚙️ baixar com `download` |
| Narração natural pt-BR | Piper (vozes faber, cadu, jeff) | grátis | não | ✅ testado |
| Narração reserva | eSpeak NG / vozes do Windows (SAPI) | grátis | não | ✅ eSpeak testado · SAPI só no Windows (não testado aqui) |
| Legendas (.srt + gravadas no vídeo) | geradas do roteiro | grátis | não | ✅ testado |
| Transições, Ken Burns, cartelas de título | FFmpeg | grátis | não | ✅ testado |
| Música de fundo com *ducking* | FFmpeg | grátis | não | ✅ testado |
| Montagem multi-cena até 120 s | pipeline do agente | grátis | não | ✅ testado |
| Clipes de vídeo por IA (texto→vídeo, imagem→vídeo) | Wan2GP: Wan 2.1/2.2, LTX-2, Hunyuan | grátis | **sim** (NVIDIA/AMD, ≥ 8 GB VRAM) | ⚙️ instalar o Wan2GP (seção 6) |
| 600+ modelos na nuvem (Kling, Veo, Sora, Flux Pro…) | MuAPI | **pago** | não | 🔒 bloqueado por padrão (seção 7) |

---

## 2. Instalação rápida

Pré-requisitos: **Node.js 18+** (recomendado 22), **FFmpeg**, **Python 3.9+** (para a voz Piper) e **Git**.

```bash
git clone --recurse-submodules https://github.com/rikinho1997-wq/Open-Generative-AI.git
cd Open-Generative-AI
npm install --prefix claude-agent      # só o agente (leve) — o app completo usa "npm run setup"
node claude-agent/bin/oga.mjs setup     # motor sd.cpp, modelo, modo rápido, Piper e voz pt-BR (~2,5 GB)
node claude-agent/bin/oga.mjs doctor    # confere o que está funcionando
```

No **Windows**, use o instalador guiado (seção 5).

Tudo fica na pasta de modelos do app desktop (compartilhada com ele):
Windows `%APPDATA%\open-generative-ai\local-ai` · macOS `~/Library/Application Support/open-generative-ai/local-ai` ·
Linux `~/.config/open-generative-ai/local-ai`. Para usar outro disco: variável `OPEN_GENERATIVE_AI_LOCAL_AI_DIR`.

Os vídeos e imagens gerados vão para `outputs/` (fora do Git). Para mudar: `OGA_OUTPUT_DIR`.

---

## 3. Usando com o Claude

Abra o Claude Code **na pasta do projeto**:

```bash
claude
```

O arquivo `.mcp.json` registra o servidor `open-generative-ai` automaticamente (aprove quando o Claude perguntar).
A Skill `.claude/skills/produtor-de-video` ensina ao Claude o fluxo completo. Depois é só pedir:

- *"Gere uma imagem 16:9 de um farol ao entardecer, estilo pintura a óleo."*
- *"Faça a narração deste texto com a voz cadu."*
- *"Crie um vídeo de 90 segundos sobre a história do café, 8 cenas, formato 9:16, com legendas."*
- *"Refaça a cena 3 com uma imagem mais escura e troque a transição para fadeblack."*

O Claude mostra o roteiro, valida a duração (`dry_run`), produz e devolve o caminho do vídeo e uma miniatura.

Para usar em **outra pasta** ou em outro cliente MCP (Claude Desktop, Cursor…):

```bash
claude mcp add open-generative-ai -- node /caminho/Open-Generative-AI/claude-agent/src/server.mjs
```

### Ferramentas MCP

| Ferramenta | Para quê |
|---|---|
| `oga_doctor` | O que está instalado e o que falta |
| `oga_list_models` | Modelos e vozes gratuitos (e, se pedir, o catálogo pago só para consulta) |
| `oga_download_model` | Baixar modelo/voz gratuito |
| `oga_generate_image` | Uma imagem (devolve prévia) |
| `oga_text_to_speech` | Uma narração WAV |
| `oga_generate_video_clip` | Clipe IA de até 10 s (Wan2GP) |
| `oga_produce_video` | Vídeo completo a partir de roteiro (com `dry_run`) |
| `oga_job_status` / `oga_cancel_job` | Acompanhar/cancelar tarefas longas |
| `oga_configure_wan2gp` | Apontar para o Wan2GP local ou remoto |

---

## 4. Usando sem o Claude (linha de comando)

```bash
node claude-agent/bin/oga.mjs image "a lighthouse at dusk, oil painting" --ar 16:9
node claude-agent/bin/oga.mjs tts "Olá! Esta é a narração." --voice pt_BR-cadu-medium
node claude-agent/bin/oga.mjs produce claude-agent/examples/demo-pt-br.json --dry-run
node claude-agent/bin/oga.mjs produce claude-agent/examples/demo-pt-br.json
```

### O roteiro (JSON)

Veja o exemplo completo em [`examples/demo-pt-br.json`](examples/demo-pt-br.json). Cada cena tem:

- `narration` — texto falado (vira legenda automaticamente). A cena dura o tempo da narração.
- `visual.type` — `image` (imagem IA com movimento), `video` (clipe IA; sem GPU vira imagem animada),
  `file` (sua foto/vídeo) ou `color` (cartela de título).
- `visual.prompt` — descrição **em inglês**, sem texto escrito; textos vão em `title`.
- `title`, `transition` (`fade`, `fadeblack`, `slideleft`, `circleopen`, `cut`…), `visual.motion` (`zoom_in`, `pan_left`…).

Opções gerais: `format` (`16:9`, `9:16`, `1:1`; `480p`/`720p`/`1080p`), `voice`, `subtitles`, `music`
(arquivo local com licença livre) e `defaults` (estilo visual comum, transição padrão, modo rápido).

**Limite de 120 s:** ≈ 1.500 caracteres de narração no total. O `--dry-run` avisa antes de gerar.
**Reaproveitamento:** rodar de novo com o mesmo `output_name` só regenera o que mudou.

Resultado em `outputs/<output_name>/`: `<nome>.mp4`, `<nome>.srt`, `thumbnail.jpg`, `manifest.json`
(duração, motores usados, custo) e as imagens/áudios de cada cena.

---

## 5. Windows (execução local — recomendado)

1. Clone o repositório (precisa do [Git](https://git-scm.com/download/win)).
2. Abra o **PowerShell** na pasta do projeto e rode:

   ```powershell
   powershell -ExecutionPolicy Bypass -File claude-agent\windows\instalar.ps1
   ```

   O script confere/instala (perguntando antes) Node.js, FFmpeg e Python via `winget`, instala o agente,
   baixa o motor sd.cpp certo para a sua máquina (CUDA se tiver NVIDIA, senão CPU), o modelo de imagem,
   o modo rápido, o Piper e a voz pt-BR, e no fim roda o diagnóstico.
3. Instale o Claude Code (`npm install -g @anthropic-ai/claude-code`) e rode `claude` na pasta do projeto.

Sem o Piper, o Windows usa as vozes do sistema (SAPI). Para ter uma voz pt-BR do sistema:
Configurações → Hora e idioma → Fala → Adicionar vozes → Português (Brasil). Algumas vozes novas do Windows
não aparecem para o SAPI; por isso o **Piper é o recomendado** (o instalador já o configura).

Se você já usa o **app desktop** do Open Generative AI, os modelos baixados em *Settings → Local Models* servem
para o agente também (mesma pasta).

---

## 6. Vídeo por IA de verdade (Wan2GP, grátis com GPU)

Sem GPU, as cenas `type: "video"` viram imagens animadas (Ken Burns). Para gerar clipes de vídeo por IA:

1. Num PC com **GPU NVIDIA (8 GB+ VRAM) ou AMD**, instale o [Wan2GP](https://github.com/deepbeepmeep/Wan2GP)
   seguindo o README dele (`git clone https://github.com/deepbeepmeep/Wan2GP` e o instalador do projeto).
2. Aponte o agente para ele:

   ```bash
   node claude-agent/bin/oga.mjs wan2gp --dir "C:\IA\Wan2GP"
   ```

   Ou, se o Wan2GP roda em **outra máquina** da rede, inicie lá o servidor MCP dele e use a URL:

   ```bash
   python wgp.py --mcp --mcp-api-version 1 --mcp-transport streamable-http --mcp-host 0.0.0.0 --mcp-port 7866
   node claude-agent/bin/oga.mjs wan2gp --url http://192.168.0.10:7866/mcp
   ```
3. Modelos: `wan2gp:wan21-t2v-1.3b` (mais leve, 480p), `wan2gp:wan22-t2v`, `wan2gp:wan22-i2v` (anima uma imagem),
   `wan2gp:ltx-video` (720p, rápido), `wan2gp:hunyuan-video`. Os pesos baixam sozinhos no primeiro uso.

---

## 7. APIs pagas (desligadas por padrão)

O Open Generative AI também acessa 600+ modelos comerciais pela MuAPI, que **cobra por geração**. O agente só usa
esse caminho se **as três** condições forem verdadeiras:

1. `MUAPI_API_KEY` definida como variável de ambiente (nunca em arquivo do repositório);
2. `OGA_ALLOW_PAID=1` definida por você;
3. a chamada traz `allow_paid: true` — e o Claude foi instruído a só fazer isso com sua autorização explícita.

```powershell
# Windows, só na sessão atual do terminal:
$env:MUAPI_API_KEY = "sua-chave"; $env:OGA_ALLOW_PAID = "1"; claude
```

Nenhuma chave é gravada em arquivo. `.env` e `.env.*` já estão no `.gitignore`.

---

## 8. Limitações conhecidas

- **CPU é lenta para imagem** (medido em 4 núcleos, sem GPU): modo rápido ≈ 1,3 min (512×512) a 3 min (16:9, 896×512)
  por imagem; modo normal ≈ 3,5 min (512×512). O vídeo de demonstração (4 imagens, 35 s) levou ~9,5 min;
  montar um vídeo de 98 s a partir de imagens prontas levou ~1 min. Com GPU NVIDIA, segundos por imagem.
- **SD 1.5 não escreve texto** na imagem e tem resolução nativa 512 px (o vídeo é ampliado para 720p).
  Para mais qualidade, use SDXL/Z-Image (exigem mais memória) ou o Wan2GP (Flux/Qwen-Image) com GPU.
- **Clipes de vídeo IA exigem GPU** (Wan2GP é só CUDA/ROCm).
- **Duração máxima 120 s** (ajustável por `OGA_MAX_VIDEO_SECONDS`, até 600).
- **Licenças:** Dreamshaper (CreativeML OpenRAIL-M), LCM-LoRA (OpenRAIL++), Piper (GPL-3.0; vozes com licença
  própria no *model card*). Verifique antes de uso comercial. Música: use apenas faixas com licença livre.

## 9. No Claude Code na nuvem (claude.ai/code)

Funciona, com estas diferenças — tudo foi testado num container de 4 núcleos, sem GPU:

- Imagens (CPU), narração, legendas, transições e montagem: **funcionam**.
- Clipes de vídeo IA (Wan2GP): **não** (sem GPU) — as cenas viram imagens animadas.
- O ambiente precisa liberar `huggingface.co` e `us.aws.cdn.hf.co` para baixar modelos e vozes
  (já configurado no ambiente de nuvem **Open-Generative-AI**).
- O script de setup desse ambiente instala as dependências, o Piper e as vozes pt-BR em cada sessão nova.
  A parte pesada roda sob demanda: `npm run agent:setup` (~10 min: compila o sd.cpp — os downloads do
  GitHub Releases são bloqueados lá — e baixa o modelo de imagem). Peça ao Claude: *"rode o agent:setup"*.
- O container é temporário: modelos e vídeos somem ao fim da sessão. Baixe o `.mp4` antes de sair.

## 10. Testes (sem custo)

```bash
cd claude-agent && npm test
```

22 testes: legendas, títulos, linha do tempo e limite de 120 s, bloqueio de API paga, filtros do FFmpeg,
renderização real de vídeo com narração/legendas/música, Wan2GP com um `wgp.py` falso e o servidor MCP via stdio.
