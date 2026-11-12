# Build e validação no Windows

O destino preparado é **Windows x64**. O instalador Squirrel gera `Setup.exe`,
pacote `.nupkg` e `RELEASES`; há também um ZIP portátil. A validação nativa abaixo
é necessária antes de publicar: a revisão local foi feita em Mac e não havia
uma VM Windows utilizável.

## Preparar a máquina de build

1. Usar Windows 11 atualizado e reservar pelo menos 10 GB livres.
2. Instalar **Node.js 22 x64**, inclusive se o Windows da VM for ARM64. O
   processo Node deve informar `x64`; o app usa a emulação do Windows ARM.
   Windows ARM64 nativo não é um destino deste pacote.
3. Instalar Git e habilitar Corepack/pnpm 10.29.1. Se `better-sqlite3` precisar
   compilar, instalar Python 3 e Visual Studio Build Tools com **Desktop
   development with C++**, MSVC x64 e Windows SDK.
4. Fazer checkout novo em disco local, por exemplo `C:\dev\leadzy-studio`.
   Não copiar `node_modules`, `bin`, `dist` ou `build/resources` do Mac.

No PowerShell, dentro do checkout:

```powershell
node -p "process.platform + '/' + process.arch"
corepack enable
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm media:setup
$env:Path = "$PWD\bin;$env:Path"
pnpm test
pnpm desktop:make:win --unsigned
node scripts/verify-desktop-package.mjs "out/Leadzy Studio-win32-x64"
```

O build baixa FFmpeg/FFprobe 9.0.1 x64 de URL versionada e confere SHA-256,
prepara `.ico`, inclui Chrome Headless Shell e recompila SQLite para o ABI do
Electron. Não depende de `make`, `sips`, Homebrew ou shell Unix.

Saídas:

- `out/Leadzy Studio-win32-x64/`: aplicativo portátil;
- `out/make/squirrel.windows/x64/`: instalador, `.nupkg` e `RELEASES`;
- `out/make/zip/win32/x64/`: ZIP portátil.

O workflow manual **Windows desktop candidate** faz o build em runner Windows
e guarda os artefatos por 14 dias. Não publica releases. Esses candidatos são
sem assinatura de distribuição e precisam da validação abaixo.

## Validação pelo funcionário

1. Instalar pelo `Setup.exe` em conta comum. Conferir abertura, ícone, atalhos
   e desinstalação. Repetir sem Node/pnpm/FFmpeg no PATH do usuário.
2. Criar projeto em caminho com espaços e acentos, como
   `C:\Users\Ana\Videos\Promoção setembro`; importar, cortar, salvar, fechar,
   reabrir, renderizar legendas e revelar o resultado no Explorer.
3. Desconectar a rede e repetir render simples e de uma composição cujos
   assets são locais. Templates com CDN/fontes remotas ainda precisam de rede;
   transcrição ElevenLabs também. Browser e codecs acompanham o app.
4. Testar troca de projetos, projeto vazio e vídeo incompatível: a janela
   deve continuar utilizável com mensagens legíveis nas falhas.
5. Optar pela integração CLI e executar `studio.cmd` pelo caminho exibido.
   Para usar `studio` em qualquer terminal, adicionar
   `%USERPROFILE%\.local\bin` ao PATH do usuário e abrir outro terminal.
6. Validar atualização de uma versão menor para uma maior em canal de teste.
   Conferir persistência do projeto, atalhos e que `studio.cmd` passa a apontar
   para a pasta nova. O app só atualiza bridges previamente instalados por ele.

Registrar Windows/arquitetura, versão app, comandos, logs, screenshots e
SHA-256 (`Get-FileHash -Algorithm SHA256 <arquivo>`). O smoke script confere
módulos, SQLite nativo, FFmpeg/libass, FFprobe e browser; não substitui UI,
render real, instalação ou atualização.

## Assinatura e publicação

Para distribuir, definir `WINDOWS_CERTIFICATE_FILE` (PFX) e
`WINDOWS_CERTIFICATE_PASSWORD` no ambiente seguro e executar
`pnpm desktop:make:win` sem `--unsigned`. Conferir Authenticode do instalador e
do aplicativo instalado. O auto-updater só é ativado em instalação Squirrel;
o ZIP portátil serve para teste e distribuição manual.

Os artefatos Windows e Mac da **mesma versão** devem compor uma única release
em `leadzy/leadzy-studio-releases`. Manter o título `vX.Y.Z`, subir os três
arquivos Squirrel juntos e preservar o ZIP Mac. Não executar `make publish` no
Mac depois de criar uma release Windows dessa mesma versão: ele recusa uma
release já existente. Publicar o rascunho somente após validar ambas as plataformas.

Referências: [Squirrel.Windows no Forge](https://www.electronforge.io/config/makers/squirrel.windows)
e [autoUpdater do Electron](https://www.electronjs.org/docs/latest/api/auto-updater).
