# Revisão de qualidade e preparação desktop — 11/09/2026

## Decisão

**Publicação conjunta Mac/Windows ainda pendente de validação dos instaladores.**
As correções encontradas nesta revisão estão no workspace. A suíte completa,
o build de produção e o fluxo de edição/exportação sintética passaram no Mac.
Windows recebeu preparação de build e correções de compatibilidade, mas não
foi executado em Windows real: a instalação da VM ficou com o funcionário,
conforme solicitado.

Estado de partida: branch `feat/editor-controls-agent-workflow`, commit
`c92376c994efa8c6551a326a4daae4d1a774d701`, versão `0.1.0`. A revisão cobre o
código atual e as mudanças locais feitas nesta sessão. Não houve commit,
push, atualização de versão ou publicação de release.

## Problemas corrigidos

| Prioridade | Problema e efeito                                                                                                                    | Correção                                                                                                                      |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| P1         | Pacote Electron excluía `updateNotice.mjs`, importado na inicialização: o app empacotado não abria.                                  | Inclusão do módulo e teste do grafo de imports do pacote.                                                                     |
| P1         | JSON de edição truncado ou ilegível era classificado como ausente; reabrir podia gravar uma edição nova sobre o arquivo existente.   | Separação entre ausência, conteúdo inválido e falha de leitura; regressão comprova preservação byte a byte.                   |
| P1         | Respostas atrasadas de recarga/reconexão podiam substituir mudanças locais e histórico de desfazer.                                  | Guards de revisão do documento, hash salvo e ordem das requisições; hidratação antiga também não substitui dados novos.       |
| P1         | Cmd/Ctrl+S dividia clipes; Cmd/Ctrl+Q/W podia aparar o vídeo.                                                                        | Separação dos atalhos de edição e do sistema; salvar tem ação própria, modais/sliders isolam comandos, blur libera Alt/snap.  |
| P1         | Mídia e arquivos de biblioteca legítimos eram recusados no Windows por comparações com separadores Unix.                             | Resolução canônica dos caminhos mantendo a proteção contra saída da pasta e symlinks.                                         |
| P1         | Falha de salvamento no renderer podia ser confirmada como sucesso antes de aplicar uma atualização.                                  | Preload retorna resultado explícito; o processo principal não reinicia quando salvar falha.                                   |
| P2         | Restaurar histórico não recuperava uma edição atual ausente/inválida; a cópia de segurança podia anteceder uma gravação concorrente. | Recuperação explícita permitida, falhas de I/O continuam bloqueando e snapshot do estado substituído é criado dentro do lock. |
| P2         | Resultado de QA podia ser associado ao render antigo quando dois registros compartilhavam o mesmo segundo.                           | Desempate determinístico por ID do render.                                                                                    |
| P2         | Ao pausar, PiP podia continuar até 300 ms fora do quadro principal.                                                                  | Tolerância de 50 ms para pausa/scrub.                                                                                         |
| P2         | Descoberta de agentes, comandos `.cmd/.exe`, Explorer e watcher tinham suposições Unix.                                              | Busca com PATHEXT e tratamento específico de caminhos, ambiente e abertura no Windows.                                        |

O build desktop passa a ter ícone Windows, recursos `.exe`, instalador Squirrel,
ZIP e verificação do runtime empacotado. O Chrome Headless Shell usado pelo
HyperFrames é preparado no computador de build e incluído no aplicativo.
Templates que carregam scripts externos, como o template de título com GSAP
via CDN, continuam dependendo de rede.

**P1 adicional — sincronização em muitos cortes AAC.** O smoke do pacote revelou
que timestamps iniciais do áudio alongavam segmentos intermediários, propagando
o erro na concatenação. Vinte cortes de 120 ms deveriam durar 2,4 s, mas
produziam vídeo de 2,760625 s e áudio de duração diferente. A normalização da
grade PCM nos dois extratores corrigiu o resultado para **2,400000 s nos dois
streams, 60 quadros a 25 fps**. Sete testes reais cobrem cortes, velocidade,
crossfade, velocidades mistas e áudio com atraso intencional. Os argumentos
do filtro integram a chave de cache; segmentos anteriores são invalidados.

A revisão independente também corrigiu o bridge CLI após atualização, a
migração do formato legado no Mac, o caminho do browser no CLI empacotado e
guards contra flags ambíguas e reutilização de FFmpeg de outra versão ou
arquitetura. A releitura final não reteve outros defeitos concretos no diff.

## Evidências executadas

| Área                         | Cobertura                       | Evidência ou limite                                                                                                                                                                                                     |
| ---------------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Suíte automatizada           | Verificada no Mac               | Base: 1.734 testes; candidato final: 1.789 testes em 132 arquivos, todos passando, incluindo FFmpeg 9.0.1, os últimos ajustes desktop e as regressões de sincronização AAC.                                             |
| TypeScript e ESLint          | Verificados                     | `pnpm typecheck` e `pnpm lint` passaram.                                                                                                                                                                                |
| Produção                     | Verificada                      | `pnpm build` passou. Vite informa um chunk acima de 500 kB; não impediu a compilação ou a abertura do editor.                                                                                                           |
| HTTP local                   | Verificado                      | 119 testes de HTTP reais e suíte completa: Host/Origin, streaming/ranges, edição, histórico, biblioteca e jobs.                                                                                                         |
| Regressões de perda de dados | Verificadas                     | Testes reproduzidos falhando antes das correções de JSON inválido, recarga concorrente e associação de QA.                                                                                                              |
| Interface                    | Verificada em projeto sintético | Abrir mídia, atualização externa via CLI, Cmd+S, corte S, desfazer, refazer, autosave e exportação. Console sem erros no smoke.                                                                                         |
| Render                       | Verificado no Mac               | CLI e interface geraram MP4 H.264 1080×1920 + AAC 48 kHz, duração de 3 s; frame exportado inspecionado. Pasta e arquivo de origem tinham espaços e acentos.                                                             |
| Pacote Mac                   | Verificado para teste local     | Forge gerou o `.app` ARM64; verificador do pacote confirmou módulos, ABI SQLite Electron, FFmpeg/libass, FFprobe e Chrome 152. Home abriu pelo aplicativo empacotado; render sem cache pelo runtime do pacote terminou. |
| Windows                      | Parcial                         | Casos com `node:path.win32`, descoberta PATHEXT e preparação de instalador. Falta build/instalação/render em Windows real.                                                                                              |
| Transcrição e QA por voz     | Não executados                  | Não foram feitas chamadas pagas à ElevenLabs. O smoke usa vídeo e tom sintéticos, sem legendas.                                                                                                                         |

A primeira execução de testes dentro do sandbox não pôde abrir portas locais
nem pipes do `tsx`. A mesma suíte passou com a execução local autorizada;
essas falhas de ambiente não foram mascaradas alterando os testes.

O comando `pnpm format:check` inicial encontrou apenas `tmp-render-max.ts`,
arquivo temporário que já existia fora do Git. Ele foi preservado. A conferência
de formatação da entrega considera os arquivos versionados e os novos arquivos
desta revisão e passou; esse arquivo temporário não entra no pacote.

Pacote local: `out/qa-desktop/Leadzy Studio-darwin-arm64/Leadzy Studio.app`
(aproximadamente 820 MB). A assinatura conferida é **ad-hoc**, sem Developer ID
ou notarização. É um candidato para teste local, não um instalador público.
FFmpeg e FFprobe incluídos são 9.0.1 ARM64, baixados com SHA-256 conferido.
O primeiro render empacotado mostrou 21 ms adicionais; investigar essa pequena
diferença revelou a falha acumulativa descrita acima. O pacote foi reconstruído
após a correção. SHA-256 do `app.asar` final:
`d6b1bc104aa2d08cbad01963178135e56a5462896b525730654a3e4b4630af19`.
O mesmo projeto foi renderizado novamente pelo pacote final, sem reutilizar
os segmentos antigos: vídeo e áudio terminaram em **3,000000 s**, ambos com
início em zero; vídeo com 75 quadros a 25 fps.

## Dependências

A auditoria inicial encontrou 9 alertas altos e 3 moderados. Após a atualização
do lockfile, `pnpm audit --prod --audit-level high` passou: zero alertas altos,
um moderado. O resultado existente foi reaproveitado; uma consulta adicional
foi recusada pela revisão automática por transmitir metadados ao registro npm.

Residual: `adm-zip@0.6.0`, dependência transitiva de HyperFrames,
`GHSA-vwc7-r8mq-g2x9` / `CVE-2026-76845`. O aviso descreve extração que segue
symlinks preexistentes com overwrite habilitado. O resultado da auditoria não
indica versão corrigida. Isso é um alerta da dependência; esta revisão não
demonstrou exploração pelo fluxo do Studio.

## Antes de publicar

1. Consolidar as correções revisadas em um commit e escolher uma versão inédita.
   Os artefatos desta sessão mantêm `0.1.0` e não representam uma atualização
   já liberada para clientes.
2. Para distribuição Mac pública, gerar o candidato assinado/notarizado e
   repetir abertura/render com hardened runtime, além dos gates
   `make verify-app`, `make verify-dmg` e `make verify-zip` do guia macOS.
3. No Windows x64, seguir o guia de distribuição Windows e testar o instalador,
   abrir/exportar em uma conta limpa e verificar o comando `studio` após
   atualização. O workflow manual produz candidatos de teste, sem publicar
   uma release automaticamente.
4. Conferir os avisos e fontes correspondentes dos binários incluídos,
   conforme `docs/legal/THIRD_PARTY_NOTICES.md`.

## Melhorias seguintes

- Caracterizar cortes cujo início fica entre quadros. Em um cenário
  exploratório com fonte a 25 fps e áudio atrasado 0,5 s, o bloco
  `0,25–1,25 s` produziu stream de vídeo de `0,960000 s`; `0,24–1,24 s`
  produziu 1 s. O alinhamento do atraso de áudio passou na medição RMS.
  Framecount e duração de áudio daquele caso não foram registrados e o
  comportamento não foi comparado com o código anterior. É um residual
  inconclusivo de seek/quantização, não uma regressão demonstrada do patch AAC.
- Promover o smoke dos pacotes Mac e Windows a gate recorrente da CI,
  depois da primeira validação nativa, incluindo atualização entre versões.
  A suíte do código sozinha não detectou o módulo ausente no pacote anterior.
- Tornar o template de título independente do CDN de GSAP. O browser agora
  acompanha o app, mas um template com dependências remotas ainda falha sem rede.
- Avaliar carregamento separado das ferramentas menos usadas. O build aponta
  um chunk da interface acima de 500 kB; qualquer divisão deve ser guiada por
  medição de abertura e interação, não por uma refatoração indiscriminada.

A revisão de código foi direcionada a persistência, concorrência, arquivos,
renderização, interface e distribuição. A execução de toda a suíte não equivale
a inspeção manual de cada linha nem a validação de todas as combinações de
hardware, mídia e serviços externos.

## Complemento: elemento do preview atravessando a exportação

Reproduzido no Chrome, no projeto `video-01`: o cartão do editor tinha
`z-index: 51`, acima do diálogo de exportação (`50`). O palco do preview não
criava um contexto de empilhamento, permitindo que seus elementos cobrissem
o diálogo. A segunda cópia visível vinha da interface por trás da janela.

Adicionado `isolation: isolate` em `.player-stage`. A ordem interna das camadas
permanece igual, mas fica contida no palco. Validado visualmente no mesmo
projeto com o diálogo aberto e fechado: cartão correto no editor e apenas
o cartão do vídeo dentro da exportação. Nenhuma mídia foi alterada.

Validação adicional: build da interface, formatação do CSS e 15 testes de
empilhamento/seleção da fonte de exportação passaram; console sem erros.
O pacote Mac registrado acima foi gerado antes deste complemento e precisa
ser regenerado para incorporar esta correção na distribuição.

## Complemento: edição do trecho por duplo clique

O duplo clique nos blocos da linha-base, vídeo sobreposto, áudio, imagem,
elemento animado e efeito abre o editor de trecho. A seleção pode deslizar pelo
arquivo completo ou ter suas bordas ajustadas; mudanças só são aplicadas na
confirmação e entram no histórico como uma operação. Também há um botão
“Editar trecho” na timeline, ajuste numérico e ampliação da faixa selecionada.

Vídeo e áudio preservam a posição do bloco. A linha-base mantém a sequência:
alterar sua duração desloca os blocos seguintes, como nos outros cortes do
editor. Imagens e efeitos editam o intervalo de exibição na timeline. Elementos
animados persistem `sourceIn`, respeitado no player e no FFmpeg; períodos que
já mantinham o último quadro continuam disponíveis. Sessões abertas antes de
outra edição e camadas bloqueadas não podem sobrescrever o documento.

Testado visualmente com os seis tipos de bloco em mídia sintética e com a
caixinha do projeto `video-01`, sem aplicar um novo recorte nesse projeto.
A renderização sintética confirmou o início escolhido na animação e manteve
7 segundos de duração. O servidor local foi atualizado no mesmo endereço.
Os pacotes desktop anteriores precisam ser regenerados para incluir a função.

Verificação final desta função: typecheck, lint, build, formatação dos arquivos
alterados e `git diff --check` passaram. A suíte final passou com 1.817 testes
em 134 arquivos (`pnpm exec vitest run --maxWorkers=1`). Nas execuções paralelas,
testes nativos de inicialização e rasterização excederam o limite de 5 segundos;
o limite foi preservado e a execução serial terminou sem falhas.

## Complemento: Home, fechamento e estado do ímã

Removido o selo clicável “editado por agente”: ele apenas dispensava o aviso,
pois a edição já era aplicada por SSE. Testes confirmam atualizações sucessivas
sem interação e recuperação após reconexão, preservando o aviso de conflito
quando há alterações locais não salvas.

O servidor agora encerra as conexões abertas ao fechar. Antes, o pedido de
voltar à Home aguardava a conexão SSE mantida pela própria tela do editor.
Uma regressão HTTP cobre o fechamento com SSE ativo; o botão foi testado no
aplicativo instalado e voltou à Home sem F5.

As miniaturas usam as dimensões do arquivo exportado ao solicitar a imagem ao
Quick Look e são exibidas com `object-fit: contain`. Isso evita tanto o
achatamento de vídeos verticais quanto cortes de enquadramento na Home.
O ímã usa fundo sólido quando ligado, aparência neutra quando desligado e
estado pausado com Alt. Seu estilo não depende de `data-slot`, que o tooltip
substitui no componente composto. Ligado e desligado foram conferidos na UI.

Validação: 341 testes únicos nas suítes de estado, servidor e Electron passaram
(incluindo a repetição da suíte Electron após atualizar a lista de imports),
typecheck, ESLint dos arquivos alterados, formatação e build passaram.
A versão local foi instalada em `/Applications/Leadzy Studio.app`, com cópia
anterior preservada. Artefatos em `out/mac-ui-fixes-final`; assinatura ad-hoc,
sem notarização. O teste visual não realizou exportação do projeto do usuário;
na abertura houve um aviso de outra renderização já em andamento, sem alterar
ou remover seu bloqueio.

## Revisão de entrega — 30/09/2026

O estado consolidado em `5250772` passou novamente em typecheck, lint,
formatação, build e 1.825 testes em 134 arquivos no Mac. O script temporário
foi preservado em `out/review-preserved/`, fora do Git.

A auditoria atual encontrou seis alertas altos novos em `adm-zip` e
`brace-expansion`. Atualizados no lockfile para `adm-zip@0.6.1` e
`brace-expansion@1.1.21/2.1.7/5.0.12`, respeitando as faixas dos consumidores;
a resolução também atualizou `ip-address` de 10.7.0 para 10.7.2. A auditoria
de produção passou com três alertas moderados e nenhum alto/crítico.
O roundtrip de criação/extração de ZIP usado por HyperFrames passou.
