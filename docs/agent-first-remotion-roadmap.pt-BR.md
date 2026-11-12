# Leadzy Studio agent-first — análise de paridade com Remotion

> Estado analisado em 10 de agosto de 2026. O objetivo não é transformar o
> Leadzy Studio em um clone do Remotion. É absorver os padrões que aumentam a
> capacidade e a autonomia do agente sem perder a edição local, determinística,
> validada e transcript-first.

## Decisão de produto

O Leadzy Studio deve continuar com engine própria baseada em FFmpeg e com
`edit/edit.json` como fonte da verdade.

O Remotion usa React como fonte da verdade e, por isso, aceita praticamente
qualquer visual que HTML, CSS, SVG, Canvas, WebGL ou WebGPU consigam produzir.
O Leadzy Studio **também já consegue receber qualquer visual que o agente
consiga desenhar**, desde que ele seja congelado como PNG, WebM ou outro asset
local — o end card criado com HyperFrames prova esse fluxo. A diferença está no
nível em que essa liberdade existe: no Remotion o desenho continua sendo código
nativo e parametrizável; no Studio ele entra hoje como um arquivo que o editor
consegue posicionar e redimensionar, mas cujos textos, cores, cenas e animações
internas não conhece.

Portanto, a lacuna não é de poder visual. É de **semântica, reedição e ciclo de
vida** do visual gerado. Se o agente quiser mudar uma palavra em um WebM, hoje
precisa encontrar a fonte externa, renderizar novamente e substituir o asset.

O melhor caminho para o Studio é combinar:

- um núcleo editorial tipado e restrito para cortes, áudio, legendas, camadas e
  entrega;
- operações semânticas pequenas para o agente, sem reescrever o documento
  completo a cada mudança;
- uma biblioteca extensível de elementos e efeitos declarativos;
- uma composição visual de primeira classe para assets renderizados por
  HyperFrames ou outro gerador, guardando fonte, parâmetros, renderer, versão,
  poster e artefato final sem executar JavaScript arbitrário no processo
  principal do Studio;
- preview rápido, render determinístico e QA como contratos obrigatórios.

Não é necessário adotar o runtime do Remotion agora. Além do custo técnico, o
produto de automação do Remotion possui licenciamento comercial próprio. Podemos
adotar ideias e padrões públicos sem copiar o Editor Starter ou a Timeline paga.

## O que já fazemos melhor para um agente

O Remotion é agent-friendly porque o código React é editável por qualquer coding
agent e porque oferece documentação e skills modulares. O Studio já tem uma base
mais segura para edição automática de vídeo real:

- schema Zod estrito;
- `status` e `validate` com JSON estável;
- `editHash` otimista, lock entre processos e gravação atômica;
- histórico recuperável antes e depois da escrita do agente;
- mídia original somente leitura e assets portáveis dentro de `edit/`;
- corte por palavra, detecção de silêncio, repetição e vícios;
- transcrição word-level e legendas ligadas ao tempo da fonte;
- preview e final com snapshots de origem;
- QA semântico do vídeo exportado;
- redução de ruído, loudness e comparação A/B de áudio;
- aplicação desktop local, sem upload obrigatório.

Essa é a vantagem estrutural do Leadzy Studio. Devemos preservar a liberdade de
o agente desenhar qualquer coisa, mas cercá-la com manifestos, parâmetros e
artefatos reproduzíveis — em vez de reduzir tudo a um campo de prompt que gera
código livre e descartável.

## Matriz de capacidade

Legenda: **sim** = existe com contrato utilizável; **parcial** = existe, mas com
vocabulário ou paridade de preview limitada; **não** = ainda não existe;
**depois** = não é prioridade para ads e reels.

| Família                           | Remotion                                           | Leadzy Studio hoje                                  | Decisão                                           |
| --------------------------------- | -------------------------------------------------- | --------------------------------------------------- | ------------------------------------------------- |
| Fonte de verdade programável      | Componentes React e props                          | `edit.json` tipado                                  | **sim**; manter JSON                              |
| Skills para coding agents         | Skills modulares e docs em Markdown                | Skill instalada + guia por criativo                 | **sim**; modularizar mais                         |
| MCP de documentação               | Descontinuado em favor de skills                   | CLI + skill local                                   | **sim**; não criar MCP só por criar               |
| Descoberta de capacidades         | APIs, docs e skills                                | Agente precisa ler schema/guia                      | **não**; criar `studio capabilities --json`       |
| Mutação por agente                | Código/props livres                                | Documento completo via `edit apply`                 | **parcial**; criar operações semânticas           |
| Concorrência e recuperação        | Depende da aplicação                               | hash, lock, atomicidade e histórico                 | **sim**, vantagem do Studio                       |
| Jump cuts                         | Segmentos pre-montados no player                   | Blocos corretos; um `<video>` por fonte e hard seek | **parcial**; pre-montar blocos vizinhos           |
| Trim, split e ripple              | Composição por sequências / editor                 | Linha-base e camadas editáveis                      | **sim**, ampliar comandos do agente               |
| Velocidade                        | Constante, por segmento e rampas por remapeamento  | Global e por bloco base, 0,5–2×                     | **parcial**; camada + curvas depois               |
| Camadas                           | Pilha livre                                        | base, vídeo, overlay e efeito                       | **sim**, com tipos restritos                      |
| Layout                            | CSS livre                                          | fullscreen, split, PiP e cell                       | **sim**, bom para o produto                       |
| Transformações                    | posição, escala, rotação, skew, opacidade e origem | posição e escala                                    | **parcial**; adicionar crop, rotação e opacidade  |
| Keyframes e easing                | cálculo por frame, spring e interpolate            | efeitos com parâmetros estáticos                    | **não**; criar envelope/keyframe genérico         |
| Transições                        | apresentações, timing e overlays de emenda         | crossfade, fade-black e fade-white                  | **parcial**; ampliar depois do keyframe           |
| Efeitos de imagem                 | cor, blur, sombra, reveal, chroma key e multipass  | zoom, flash e shake                                 | **não**; criar cadeia declarativa de filtros      |
| Máscaras e blend modes            | possíveis via Canvas/CSS/shaders                   | inexistentes                                        | **não**; P2                                       |
| Texto e formas                    | HTML/SVG livres                                    | título renderizado como asset                       | **parcial**; elementos tipados reutilizáveis      |
| Elementos reutilizáveis           | galeria de backgrounds, captions, data e overlays  | biblioteca de assets + title                        | **parcial**; criar registry local                 |
| Visual arbitrário pelo agente     | código React permanece editável                    | agente gera PNG/WebM/HyperFrames e importa          | **sim** no resultado; falta reedição semântica    |
| Fontes                            | locais, web e Google Fonts                         | tema de legenda por família                         | **parcial**; importar e congelar fonte no projeto |
| GIF, Lottie, SVG e image sequence | componentes próprios                               | overlay por arquivo, cobertura variável             | **parcial**; normalizar ingestão e poster         |
| HTML/Canvas/shaders/3D/mapas      | superfície aberta                                  | inexistente no núcleo                               | **depois**; via asset externo isolado             |
| Vídeo transparente e green screen | alpha e color key                                  | alpha por asset; sem chroma key geral               | **parcial**; adicionar color key                  |
| Faixas de áudio                   | áudio livre, trim, delay, volume e pitch           | áudio acompanha vídeo e modos mute/duck/solo        | **não**; criar `audio` track                      |
| Música e SFX                      | elementos de áudio independentes                   | não são tipos de primeira classe                    | **não**; P1                                       |
| Envelopes de volume               | volume variável por frame                          | loudness global e duck fixo                         | **não**; keyframes de ganho + fade                |
| Tratamento de voz                 | depende da aplicação                               | denoise, room tone, LUFS, de-click/crossfade        | **sim**, vantagem do Studio                       |
| Waveform e silêncio               | APIs/recipes                                       | waveform, silêncio e autocut                        | **sim**                                           |
| Captions word-level               | importação, transcrição e vários componentes       | word-level, correções, ocultação, tema e lock       | **sim**                                           |
| Captions avançadas                | layouts/componentes arbitrários e exportação       | três presets + tema                                 | **parcial**; animações, speaker e SRT/VTT         |
| Parâmetros e schema               | props + schema + metadata dinâmica                 | schema do projeto                                   | **sim** no projeto; falta template parametrizado  |
| Templates/design system           | composições e props reutilizáveis                  | presets pontuais                                    | **não**; brand kit + template variables           |
| Variantes em lote                 | datasets e props de render                         | um documento/uma saída                              | **não**; render matrix                            |
| Preview incorporável              | Player com preload, buffer e controles             | player próprio com proxies                          | **parcial**; melhorar buffer e premount           |
| Render parcial                    | still, frames e intervalos                         | frames de QA e vídeo completo                       | **parcial**; `render --range`                     |
| Formatos de saída                 | MP4, WebM, GIF, still, alpha, ProRes e áudio       | MP4 H.264 + provas M4A                              | **parcial**; presets de entrega                   |
| Render local e cloud              | navegador, servidor, Lambda e Cloud Run            | FFmpeg local                                        | **sim** para v1; worker remoto opcional depois    |
| Fila, retomada e batch            | depende da integração                              | jobs locais sem fila persistente completa           | **parcial**; P3                                   |
| Recorder                          | facecam e tela separadas                           | importa mídia existente                             | **depois**; não é o foco imediato                 |
| QA do resultado                   | testes definidos pela aplicação                    | retranscrição, drift, cortes e frames               | **sim**, vantagem forte do Studio                 |

## O detalhe dos jump cuts

O documento do Studio já modela jump cuts corretamente: cada bloco da linha-base
carrega `source`, `in`, `out` e `speed`, e a duração final é derivada da sequência.
O gargalo está apenas no preview.

Hoje o player mantém um elemento `<video>` por fonte. Ao entrar em outro bloco da
mesma fonte, ele faz hard seek para garantir que um silêncio removido não volte a
tocar. Em arquivos grandes ou codecs com GOP longo, esse seek pode atrasar um
frame ou mostrar uma pequena pausa.

O padrão recomendado pelo Remotion é manter elementos separados por segmento e
preparar o próximo aproximadamente 1,5 segundo antes. No Studio devemos usar uma
versão limitada desse padrão:

- manter o bloco ativo, o anterior e os próximos 1–2 blocos montados;
- buscar o próximo bloco ainda invisível;
- só promovê-lo a relógio principal quando possuir frame decodificado;
- limitar o pool para não abrir dezenas de decoders;
- continuar usando proxy para playback e original para render;
- medir tempo até o primeiro frame e contagem de stalls em desenvolvimento.

Isso melhora a sensação de corte sem alterar o `edit.json` nem o render.

## Arquitetura agent-first alvo

```text
pedido humano
    ↓
skill roteia a intenção
    ↓
studio capabilities / inspect / transcript search
    ↓
plano de operações semânticas (dry-run)
    ↓
validação + diff legível + expectHash
    ↓
apply atômico + histórico + provenance
    ↓
preview por intervalo + frames relevantes
    ↓
QA automático + relatório estruturado
```

### 1. Catálogo descobrível

Adicionar `studio capabilities --json` com:

- versão do documento e da CLI;
- tipos de faixa, bloco, efeito e transição;
- limites numéricos;
- comandos e operações disponíveis;
- codecs/filtros realmente encontrados no FFmpeg local;
- recursos opcionais instalados, como HyperFrames;
- schema JSON exportável e exemplos mínimos.

O agente deve perguntar ao binário o que ele sabe fazer, em vez de presumir pela
memória do modelo.

### 2. Operações semânticas

O maior gap agent-first é exigir que o agente reenvie o `edit.json` inteiro.
Manter `edit apply` como escape hatch, mas adicionar operações pequenas:

- `clip.split`, `clip.trim`, `clip.remove`, `clip.move`, `clip.speed`;
- `layer.add`, `layer.move`, `layer.layout`, `layer.audio`;
- `overlay.add`, `overlay.update`, `overlay.remove`;
- `effect.add`, `effect.update`, `effect.remove`;
- `transition.set`, `transition.remove`;
- `subtitle.configure`, `subtitle.correct`, `subtitle.hide`;
- `audio.track.add`, `audio.gain`, `audio.fade`, `audio.duck`;
- `output.configure`.

Cada chamada deve aceitar `expectHash`, `--dry-run` e `--json`, devolver o diff
semântico e nunca depender de posição visual na interface.

Para isso, blocos precisam de IDs estáveis. Índices de array são frágeis quando
dois agentes ou a UI alteram a timeline.

### 3. Modelo de animação declarativo

Em vez de abrir o schema para JavaScript, criar propriedades animáveis com um
contrato comum:

```json
{
  "property": "opacity",
  "keyframes": [
    { "at": 0, "value": 0, "easing": "ease-out" },
    { "at": 0.2, "value": 1 }
  ]
}
```

Primeiras propriedades: `opacity`, `scale`, `x`, `y`, `rotation`, `volume` e
`blur`. O render converte o mesmo envelope para FFmpeg; o player interpreta a
mesma estrutura no navegador. Presets como punch-in, slide, pop e fade devem ser
macros que geram esse formato, não novos tipos rígidos para sempre.

### 4. Registry de elementos

Criar elementos instaláveis e versionados, inspirados no conceito de Remotion
Elements, mas renderizados pelo nosso pipeline:

```text
edit/elements/<id>/
  element.json       manifesto, schema dos parâmetros e versão
  preview.png        poster para timeline/inspector
  asset.webm         render congelado quando aplicável
  source/            fonte HTML/HyperFrames/etc. para o agente regenerar
```

Categorias iniciais: CTA, lower third, end card, preço/oferta, destaque de texto,
background animado e callout de produto. O agente escolhe um elemento pelo
manifesto ou cria um elemento inteiramente novo, preenche parâmetros validados e
o Studio cuida de duração, posição, poster, cache e render. Assim, o teto
criativo continua sendo o que o agente consegue desenhar; o registry apenas faz
esse desenho deixar de ser uma "caixa-preta".

### 5. Templates e brand kits

Separar conteúdo de identidade:

- cores, fontes, logo e safe areas em um brand kit;
- estrutura editorial em um template;
- dados do vídeo em variáveis validadas;
- render de várias proporções e CTAs a partir da mesma edição.

Esse é o equivalente útil de props e motion design systems do Remotion para o
nosso produto.

## Roadmap recomendado

### P0 — contrato do agente

1. IDs estáveis para tracks e blocos, com migração automática.
2. `studio capabilities --json` e exportação do schema.
3. `studio edit plan/apply` com operações semânticas, dry-run e diff.
4. `studio inspect` por faixa/bloco/intervalo e busca na transcrição.
5. provenance por operação: agente, intenção, timestamp e hashes.

Critério: um agente realiza 90% das edições normais sem montar manualmente um
documento completo e sem ler código do Studio.

### P1 — edição e preview

1. Pool pre-montado para jump cuts suaves.
2. `render --range <in>-<out>` para validação rápida.
3. faixa de áudio, música, SFX, gain, fade e ducking.
4. crop, rotação, opacidade e blend básico.
5. keyframes compartilhados entre player e FFmpeg.
6. filtros iniciais: brightness, contrast, saturation, blur, shadow e color key.

Critério: preview contínuo em cortes curtos e paridade visual mensurável com o
render nos recursos novos.

### P2 — criatividade escalável

1. registry de elementos com manifestos versionados;
2. brand kits e templates parametrizados;
3. importação normalizada de SVG, GIF, Lottie, fontes e image sequences;
4. end cards, lower thirds, CTAs e backgrounds reutilizáveis;
5. composição visual arbitrária por HyperFrames/outro renderer, com fonte,
   parâmetros, poster e asset congelado;
6. captions por speaker, animações e exportação SRT/VTT.

Critério: o agente compõe um reel visualmente rico usando blocos descobríveis ou
criando um visual novo, sem inventar formatos de integração nem deixar um asset
impossível de regenerar.

### P3 — entrega e escala

1. presets MP4/WebM/GIF/still/alpha e metadados de saída;
2. matriz de variantes por aspecto, idioma, CTA e brand kit;
3. fila persistente, cancelamento e retomada;
4. worker remoto opcional mantendo o mesmo render plan;
5. QA de safe area, clipping, freeze frame e comparação visual;
6. recorder somente se a demanda do produto justificar.

## O que não devemos copiar agora

- Remotion como dependência central do render;
- React/JavaScript arbitrário dentro do `edit.json` ou do processo principal;
  a fonte pode existir isolada em `edit/assets/src/` e gerar um artefato local;
- o Editor Starter ou a Timeline comercial;
- Lambda/Cloud Run antes de existir demanda por render em lote;
- shaders, 3D e mapas no núcleo do schema;
- dezenas de efeitos rígidos sem antes criar keyframes e cadeia de filtros;
- um MCP próprio que duplique a skill e a CLI. O próprio Remotion está
  descontinuando seu MCP em favor de skills e documentação atualizável.

## Primeiro pacote executável

Começar pelo **Agent Operations v1**, não pela galeria de efeitos:

1. capabilities + JSON Schema;
2. IDs estáveis;
3. operações `clip`, `layer`, `overlay`, `effect`, `subtitle` e `output`;
4. dry-run/diff/expectHash;
5. testes de concorrência e round-trip;
6. atualizar a skill gerenciada do criativo para usar as operações.

Na sequência, implementar o pool de jump cuts e `render --range`. Essa ordem
faz cada recurso visual novo nascer automaticamente utilizável pelo agente, em
vez de aumentar a UI e deixar a automação para depois.

## Referências oficiais consultadas

- [Jump Cutting](https://www.remotion.dev/docs/videos/jumpcuts)
- [Parameterized videos](https://www.remotion.dev/docs/parameterized-rendering)
- [Player e preloading/premounting](https://www.remotion.dev/docs/player/)
- [Transforms](https://www.remotion.dev/docs/transforms)
- [Transitions](https://www.remotion.dev/docs/transitioning)
- [Effects](https://www.remotion.dev/docs/effects)
- [Audio](https://www.remotion.dev/docs/using-audio)
- [Rendering](https://www.remotion.dev/docs/render)
- [Remotion Elements](https://www.remotion.dev/elements)
- [Editor Starter](https://www.remotion.dev/docs/editor-starter)
- [Recorder](https://www.remotion.dev/docs/recorder)
- [Building with Remotion and AI](https://www.remotion.dev/docs/ai/)
- [Agent Skills](https://www.remotion.dev/docs/ai/skills)
- [Code generation with structured output](https://www.remotion.dev/docs/ai/generate)
- [MCP deprecated](https://www.remotion.dev/docs/ai/mcp)
