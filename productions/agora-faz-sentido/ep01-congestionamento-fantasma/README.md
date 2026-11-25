# AGORA FAZ SENTIDO · Ep. 01 — Congestionamento fantasma

Produção completa feita com o agente Open Generative AI (`claude-agent/`), só com recursos gratuitos e locais.

| Arquivo | O que é |
|---|---|
| `storyboard-16x9.json` | Roteiro do vídeo principal: 24 cenas, 1920×1080, 30 fps, 120 s, efeitos sonoros e identidade visual |
| `storyboard-shorts-9x16.json` | Roteiro condensado do Shorts: 11 cenas, 1080×1920, ~49 s |
| `shorts-animation-map.json` | Qual animação do episódio ilustra cada cena do Shorts |
| `trafficsim.py` | Simulação de tráfego (Intelligent Driver Model + tempo de reação) |
| `animations.py` | Animações 2D/diagramas (Pillow), sincronizadas à narração real |
| `sfx_cues.py` | Posiciona os efeitos sonoros nos eventos das animações |
| `thumbnail.py` | Thumbnail 1280×720 |
| `publicacao.md` | Título, descrição, capítulos, referências e notas de precisão |

## Reproduzir

```bash
# pré-requisitos: node claude-agent/bin/oga.mjs setup ; voz pt_BR-faber-medium ; fonte Montserrat em
# ~/.config/open-generative-ai/local-ai/fonts (pacote npm @expo-google-fonts/montserrat, licença OFL)
python3 -m venv ~/.config/open-generative-ai/local-ai/anim-venv && ~/.config/open-generative-ai/local-ai/anim-venv/bin/pip install numpy pillow
PY=~/.config/open-generative-ai/local-ai/anim-venv/bin/python
P=productions/agora-faz-sentido/ep01-congestionamento-fantasma

# 1. imagens cinematográficas (9) — oga_generate_image (MCP) ou CLI, Dreamshaper 8 + LCM, 16:9,
#    salvas como outputs/agora-faz-sentido/ep01/images/afs-01.png … afs-09.png (prompts em publicacao.md/abaixo)
# 2. narração e linha do tempo reais
node claude-agent/bin/oga.mjs produce $P/storyboard-16x9.json --plan
# 3. animações sincronizadas e efeitos sonoros
$PY $P/animations.py --timeline outputs/afs-ep01-congestionamento-fantasma/timeline.json --out outputs/agora-faz-sentido/ep01/anim/16x9
$PY $P/sfx_cues.py $P/storyboard-16x9.json outputs/afs-ep01-congestionamento-fantasma/timeline.json
# 4. montagem final
node claude-agent/bin/oga.mjs produce $P/storyboard-16x9.json
# Shorts: mesmo fluxo com storyboard-shorts-9x16.json, --vertical e --map (ver shorts-animation-map.json)
```

## Parâmetros da simulação (escolhidos numericamente)

- Pista circular (Sugiyama et al., 2008): 22 carros, 230 m, IDM v0=15 m/s, T=0,55 s, s0=1 m, a=0,5 m/s², b=2 m/s².
  O congestionamento surge espontaneamente; distância mínima ≈ 0,6 m (sem colisões).
- Carro "inteligente": IDM calmo (T=2,2 s, a=0,25 m/s², v0=8,5 m/s). Na simulação, a velocidade média sobe de ~11–13
  para ~23 km/h e ninguém para — resultado ilustrativo, na linha de Stern et al. (2018).
- Estrada aberta: 40 carros a 90 km/h, IDM T=1,2 s, a=1,2 m/s², tempo de reação 1,0 s (Treiber, Kesting & Helbing, 2006).
  O líder cai só para ~78 km/h; do 16º carro em diante todos param. Sem tempo de reação a perturbação se dissipa.
