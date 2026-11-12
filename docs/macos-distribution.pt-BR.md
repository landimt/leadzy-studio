# Build e distribuição no macOS

Este guia cobre o aplicativo desktop Apple Silicon (`arm64`). O build local gera
um `.app` autossuficiente e um instalador `.dmg`; o usuário final não precisa
instalar Node.js, pnpm, SQLite, FFmpeg ou FFprobe.

## Pré-requisitos do computador de build

- macOS 12 ou mais recente em um Mac Apple Silicon;
- Node.js 22;
- Corepack/pnpm 10;
- Xcode Command Line Tools (`xcode-select --install`);
- `make` e acesso à internet no primeiro setup.

```bash
git clone https://github.com/landimt/leadzy-studio.git
cd leadzy-studio
corepack enable
make setup
make check
```

`make setup` instala as dependências fixadas no lockfile, prepara FFmpeg e
FFprobe portáteis e roda o diagnóstico do ambiente.

## Gerar e conferir os artefatos

Para qualquer build que vai para outra pessoa, use um comando só:

```bash
make release
```

Ele gera o DMG e só termina se a assinatura for Developer ID, o hardened
runtime estiver ativo, a notarização tiver sido aceita e o selo estiver
grudado, no aplicativo e na imagem. As duas configurações de assinatura
(`MACOS_SIGN_IDENTITY` e `APPLE_KEYCHAIN_PROFILE`) ficam no `.env`. Faltando
qualquer uma, o `make release` falha em vez de entregar um instalador que o
macOS recusa no computador do cliente: sem nenhuma das duas ele empacota,
assina em modo ad-hoc e reprova na conferência; com a identidade e sem a
credencial de notarização ele para antes de empacotar.

Para trabalhar localmente, os passos avulsos continuam:

```bash
make app
make dmg
```

Saídas:

- `out/Leadzy Studio-darwin-arm64/Leadzy Studio.app`
- `out/make/Leadzy-Studio.dmg`

Para testar sem enviar nada à Apple nem substituir o pacote anterior:

```bash
pnpm desktop:package --unsigned --out=out/qa-desktop
node scripts/verify-desktop-package.mjs \
  'out/qa-desktop/Leadzy Studio-darwin-arm64/Leadzy Studio.app'
```

`--unsigned` produz um artefato local ad-hoc, sem notarização, que não deve ser
distribuído. Sem essa opção, a assinatura e notarização configuradas continuam
ativas. Os scripts usam a arquitetura do Node de build e verificam FFmpeg e
FFprobe antes de reutilizar o cache. A validação local continua Apple Silicon.

O pacote usa uma lista de inclusão: entram somente o processo Electron, o
servidor compilado, as dependências de produção e os recursos portáteis. Fontes,
vídeos de teste, caches, dependências de desenvolvimento e `.env` ficam fora do
aplicativo.

Sem um certificado Apple, o Forge aplica uma assinatura **ad-hoc**, adequada
para teste no mesmo Mac. Um arquivo baixado da internet ainda pode ser bloqueado
pelo Gatekeeper; não publique esse artefato como versão comercial.

## Assinar e notarizar para distribuição pública

É necessário ter uma conta paga do Apple Developer Program e um certificado
`Developer ID Application` instalado no Keychain do Mac de build. Para um DMG,
o certificado `Developer ID Installer` não é necessário — ele serve para
pacotes `.pkg`.

Confira o certificado instalado:

```bash
security find-identity -v -p codesigning
```

### Opção recomendada: credenciais no Keychain

O `notarytool` pode pedir a senha específica do app interativamente, sem
colocá-la no histórico do shell, e guardar o perfil no Keychain:

```bash
xcrun notarytool store-credentials 'leadzy-studio-notary' \
  --apple-id 'release@suaempresa.com' \
  --team-id 'TEAMID'

export MACOS_SIGN_IDENTITY='Developer ID Application: Sua Empresa (TEAMID)'
export APPLE_KEYCHAIN_PROFILE='leadzy-studio-notary'

make dmg
make verify-dmg
```

### Alternativa para CI: App Store Connect API key

Guarde o arquivo `.p8` e os valores somente no cofre de segredos da CI:

```bash
export MACOS_SIGN_IDENTITY='Developer ID Application: Sua Empresa (TEAMID)'
export APPLE_API_KEY='/caminho/seguro/AuthKey_ABC1234567.p8'
export APPLE_API_KEY_ID='ABC1234567'
export APPLE_API_ISSUER='00000000-0000-0000-0000-000000000000'

make dmg
```

Também é possível usar Apple ID diretamente pelo ambiente:

```bash
export MACOS_SIGN_IDENTITY='Developer ID Application: Sua Empresa (TEAMID)'
export APPLE_ID='release@suaempresa.com'
export APPLE_APP_SPECIFIC_PASSWORD='senha-especifica-do-app'
export APPLE_TEAM_ID='TEAMID'

make dmg
make verify-dmg
```

Quando a identidade e um dos três conjuntos de credenciais estão presentes, o
Forge ativa hardened runtime, assina com Developer ID e envia o aplicativo para
notarização. Nenhuma credencial deve ir para `.env`, Git ou logs de CI.

Antes de publicar, valide também:

```bash
codesign --verify --deep --strict --verbose=2 \
  'out/Leadzy Studio-darwin-arm64/Leadzy Studio.app'
spctl --assess --type execute --verbose=4 \
  'out/Leadzy Studio-darwin-arm64/Leadzy Studio.app'
xcrun stapler validate \
  'out/Leadzy Studio-darwin-arm64/Leadzy Studio.app'
```

## Limites atuais

- O artefato atual é somente Apple Silicon. Intel/universal exige binários
  FFmpeg/FFprobe para `x64`, rebuild do `better-sqlite3` e uma segunda matriz de
  empacotamento.
- O aplicativo descompactado é grande porque inclui Electron e builds completos
  de FFmpeg/FFprobe com os codecs e filtros usados pelo editor. O DMG comprimido
  é consideravelmente menor.
- A licença e os avisos de terceiros precisam acompanhar cada release; veja
  [`docs/legal/THIRD_PARTY_NOTICES.md`](legal/THIRD_PARTY_NOTICES.md).
- Chrome Headless Shell acompanha o app para composições com recursos locais.
  Templates que referenciam CDN/fontes remotas ainda exigem rede, assim como
  transcrição. Incluir o browser não torna conteúdo remoto disponível offline.
- O caminho Windows está em [windows-distribution.pt-BR.md](windows-distribution.pt-BR.md).

## Checklist de release

1. Atualizar `version` em `package.json`.
2. Rodar `make clean`, `make setup` e `make check`.
3. Configurar os segredos Apple e rodar `make dmg`.
4. Rodar `make verify-app`, `make verify-dmg`, `spctl` e `stapler validate`.
5. Testar instalação e render em outro Mac Apple Silicon limpo.
6. Publicar o DMG e seu SHA-256 na release do GitHub.
