# ╔══════════════════════════════════════════════════════════════════╗
# ║                         Leadzy Studio                           ║
# ╚══════════════════════════════════════════════════════════════════╝

SHELL := /bin/bash

ESC     := $(shell printf '\033')
PINK    := $(ESC)[38;5;198m
ORANGE  := $(ESC)[38;5;209m
GREEN   := $(ESC)[38;5;114m
YELLOW  := $(ESC)[38;5;221m
RED     := $(ESC)[38;5;203m
CYAN    := $(ESC)[38;5;116m
WHITE   := $(ESC)[1;37m
DIM     := $(ESC)[2m
BOLD    := $(ESC)[1m
RESET   := $(ESC)[0m

VERSION := $(shell node -p "require('./package.json').version" 2>/dev/null || echo "?.?.?")
BRANCH  := $(shell git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")
PROJECT ?=

.DEFAULT_GOAL := help
.SILENT:
MAKEFLAGS += --no-print-directory

.PHONY: help setup install bridge media-tools doctor dev open build icons desktop app dmg release publish verify-app verify-dmg verify-zip test lint typecheck format format-check check info clean

help: ## Mostra este menu
	@echo ""
	@echo "  $(BOLD)$(PINK)╭──────────────────────────────────────────────────╮$(RESET)"
	@echo "  $(BOLD)$(PINK)│$(RESET)                                                  $(BOLD)$(PINK)│$(RESET)"
	@echo "  $(BOLD)$(PINK)│$(RESET)     $(ORANGE)✓$(RESET)  $(BOLD)$(WHITE)Leadzy Studio$(RESET)  $(DIM)v$(VERSION) · $(BRANCH)$(RESET)"
	@echo "  $(BOLD)$(PINK)│$(RESET)        Editor de vídeo local e agent-native      $(BOLD)$(PINK)│$(RESET)"
	@echo "  $(BOLD)$(PINK)│$(RESET)                                                  $(BOLD)$(PINK)│$(RESET)"
	@echo "  $(BOLD)$(PINK)╰──────────────────────────────────────────────────╯$(RESET)"
	@echo ""
	@echo "  $(BOLD)$(WHITE)Uso:$(RESET)  make $(GREEN)<comando>$(RESET) $(DIM)PROJECT=/pasta/do/criativo$(RESET)"
	@echo ""
	@echo "  $(BOLD)$(CYAN)── Primeiros passos ─────────────────────────────────$(RESET)"
	@echo "  $(GREEN)  setup             $(RESET) Instala dependências, mídia e valida o ambiente"
	@echo "  $(GREEN)  bridge            $(RESET) Instala o comando studio e as skills dos agentes"
	@echo "  $(GREEN)  doctor            $(RESET) Diagnóstico de Node, FFmpeg, UI e agentes"
	@echo "  $(GREEN)  info              $(RESET) Mostra versões e plataforma"
	@echo ""
	@echo "  $(BOLD)$(CYAN)── Desenvolvimento ──────────────────────────────────$(RESET)"
	@echo "  $(GREEN)  dev               $(RESET) Abre pelo código $(DIM)(use PROJECT=/pasta)$(RESET)"
	@echo "  $(GREEN)  open              $(RESET) Igual a dev, com nome explícito"
	@echo "  $(GREEN)  build             $(RESET) Compila servidor, CLI e interface"
	@echo "  $(GREEN)  icons             $(RESET) Regenera ícones web, PWA e macOS da logo oficial"
	@echo "  $(GREEN)  desktop           $(RESET) Abre o aplicativo Electron em desenvolvimento"
	@echo ""
	@echo "  $(BOLD)$(CYAN)── Aplicativo macOS ─────────────────────────────────$(RESET)"
	@echo "  $(GREEN)  app               $(RESET) Gera Leadzy Studio.app ARM64"
	@echo "  $(GREEN)  dmg               $(RESET) Gera o instalador DMG ARM64"
	@echo "  $(GREEN)  release           $(RESET) Gera E confere o DMG de entrega (use este)"
	@echo "  $(GREEN)  publish           $(RESET) Envia a versão para os clientes atualizarem"
	@echo "  $(GREEN)  verify-app        $(RESET) Valida assinatura e metadados do .app"
	@echo "  $(GREEN)  verify-dmg        $(RESET) Valida integridade e checksum do DMG"
	@echo "  $(GREEN)  verify-zip        $(RESET) Valida o pacote que atualiza quem já instalou"
	@echo "  $(GREEN)  media-tools       $(RESET) Baixa FFmpeg + FFprobe portáteis"
	@echo ""
	@echo "  $(BOLD)$(CYAN)── Qualidade ────────────────────────────────────────$(RESET)"
	@echo "  $(GREEN)  check             $(RESET) Typecheck + lint + formato + testes + build"
	@echo "  $(GREEN)  test              $(RESET) Testes Vitest"
	@echo "  $(GREEN)  lint              $(RESET) ESLint"
	@echo "  $(GREEN)  typecheck         $(RESET) TypeScript strict"
	@echo "  $(GREEN)  format            $(RESET) Formata com Prettier"
	@echo "  $(GREEN)  clean             $(RESET) Remove somente artefatos gerados"
	@echo ""

setup: install media-tools build doctor ## Prepara o ambiente local sem instalar integrações globais
	@echo ""
	@echo "  $(BOLD)$(GREEN)✓ Ambiente pronto. Rode make dev PROJECT=/pasta/do/criativo$(RESET)"
	@echo "  $(DIM)Opcional: make bridge instala o comando studio e as skills dos agentes.$(RESET)"
	@echo ""

install: ## Instala dependências bloqueadas pelo lockfile
	@pnpm install --frozen-lockfile

bridge: ## Instala o CLI global e as skills para Claude Code/Codex
	@pnpm link --global
	@studio install-skill

media-tools: ## Instala FFmpeg e FFprobe portáteis no macOS
	@pnpm media:setup

doctor: ## Verifica a instalação
	@pnpm run doctor

dev open: ## Abre o editor pelo código
	@if [ -z "$(PROJECT)" ]; then echo "$(YELLOW)! Informe PROJECT=/pasta/do/criativo$(RESET)"; exit 2; fi
	@pnpm studio open "$(PROJECT)"

build: ## Compila o build de produção
	@pnpm build

icons: ## Regenera ícones web, PWA e macOS da logo oficial
	@pnpm icons:build

desktop: ## Abre o Electron para desenvolvimento
	@LEADZY_STUDIO_PROJECT="$(PROJECT)" pnpm desktop:start

app: ## Gera o .app macOS ARM64
	@pnpm desktop:package

dmg: ## Gera o instalador DMG macOS ARM64
	@pnpm desktop:make

# Único caminho para gerar algo que vai para outra pessoa: as conferências
# fazem parte do build, em vez de dependerem de alguém lembrar de rodá-las.
#
# Sub-make em vez de pré-requisitos: com `-j` o make só garante a ordem da
# esquerda para a direita quando roda serialmente, e invertido as conferências
# aprovariam o instalador ANTERIOR enquanto o novo ainda está sendo gerado.
release: ## Gera o DMG de entrega e valida assinatura e notarização
	@$(MAKE) dmg
	@$(MAKE) verify-app
	@$(MAKE) verify-dmg

# Constrói, CONFERE e só então envia. As conferências ficam entre as duas
# metades de propósito: o upload usa os artefatos já validados, em vez de
# reconstruir e mandar algo que ninguém olhou.
publish: ## Envia a versão atual para o repositório de releases (rascunho)
	@[ -n "$$GITHUB_TOKEN" ] || (echo "$(RED)Defina GITHUB_TOKEN. Use um token fine-grained restrito a leadzy-studio-releases, com permissão apenas de Contents: write. Evite tokens clássicos com acesso amplo à organização.$(RESET)"; exit 2)
	@command -v gh >/dev/null 2>&1 || (echo "$(RED)gh não encontrado. Sem ele não dá para saber se a versão já foi publicada, e publicar duas vezes a mesma versão envia o binário ANTIGO em silêncio. Instale com 'brew install gh'.$(RESET)"; exit 2)
	@V=$$(node -p "require('./package.json').version"); \
	  OUT=$$(gh release view "v$$V" --repo leadzy/leadzy-studio-releases 2>&1); \
	  if [ $$? -eq 0 ]; then \
	    echo "$(RED)Já existe uma release v$$V. O publicador ignora arquivos repetidos EM SILÊNCIO, então republicar aqui enviaria o binário antigo aos clientes. Suba a versão no package.json.$(RESET)"; \
	    exit 2; \
	  fi; \
	  case "$$OUT" in \
	    *"release not found"*|*"Not Found"*|*"not found"*) : ;; \
	    *) echo "$(RED)Não deu para consultar as releases, então não dá para garantir que esta versão é inédita: $$OUT$(RESET)"; exit 2 ;; \
	  esac
	@pnpm desktop:publish-build
	@$(MAKE) verify-app
	@$(MAKE) verify-dmg
	@$(MAKE) verify-zip
	@pnpm desktop:publish-upload
	@echo ""
	@echo "$(GREEN)✓ Enviado como RASCUNHO. Nada chega a quem já instalou até você publicar:$(RESET)"
	@echo "  https://github.com/leadzy/leadzy-studio-releases/releases"
	@echo ""
	@V=$$(node -p "require('./package.json').version"); \
	  echo "$(RED)NÃO edite o título da release.$(RESET) Ele precisa continuar exatamente 'v$$V'."
	@echo "  O aplicativo lê a versão do título e recusa o que não conseguir ler. Um título"
	@echo "  reescrito interrompe a atualização de TODO mundo, e o erro só apareceria no log"
	@echo "  da máquina do cliente. Descrição e notas podem ser editadas à vontade."

# `codesign --verify` só atesta que o lacre bate, e passa igual num bundle
# ad-hoc que o macOS recusa em qualquer outra máquina. Quem responde pela
# distribuição é o spctl: ele exige Developer ID e notarização.
verify-app: ## Verifica assinatura e identidade do aplicativo gerado
	@test -d "out/Leadzy Studio-darwin-arm64/Leadzy Studio.app" || (echo "$(RED)Aplicativo ausente. Rode make app.$(RESET)"; exit 2)
	@codesign --verify --deep --strict --verbose=2 "out/Leadzy Studio-darwin-arm64/Leadzy Studio.app"
	@codesign -dvv "out/Leadzy Studio-darwin-arm64/Leadzy Studio.app" 2>&1 | grep -q "Authority=Developer ID Application" || (echo "$(RED)Assinatura não é Developer ID: este app será recusado em outro Mac.$(RESET)"; exit 2)
	@codesign -dv "out/Leadzy Studio-darwin-arm64/Leadzy Studio.app" 2>&1 | grep -q "flags=.*runtime" || (echo "$(RED)Sem hardened runtime: a notarização não é aceita assim.$(RESET)"; exit 2)
	@spctl --assess -vv "out/Leadzy Studio-darwin-arm64/Leadzy Studio.app" 2>&1 | grep -q "source=Notarized Developer ID" || (echo "$(RED)Não notarizado. Rode make dmg com as credenciais no .env.$(RESET)"; exit 2)
	@echo "$(GREEN)✓ $$(/usr/libexec/PlistBuddy -c 'Print :CFBundleDisplayName' 'out/Leadzy Studio-darwin-arm64/Leadzy Studio.app/Contents/Info.plist') · $$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' 'out/Leadzy Studio-darwin-arm64/Leadzy Studio.app/Contents/Info.plist') · Developer ID, notarizado$(RESET)"

# O ZIP é o artefato que chega sozinho em quem já instalou, então merece as
# mesmas provas do DMG. Extrai com ditto, do mesmo jeito que o mecanismo de
# atualização faz, porque descompactar errado destrói os links do framework.
verify-zip: ## Verifica assinatura e notarização do pacote de atualização
	@V=$$(node -p "require('./package.json').version"); \
	  ZIP=$$(ls out/make/zip/darwin/*/*-$$V.zip 2>/dev/null | head -1); \
	  test -n "$$ZIP" || (echo "$(RED)ZIP da versão $$V ausente. out/make guarda as versões anteriores, e conferir a errada não prova nada. Rode make dmg.$(RESET)"; exit 2); \
	  TMP=$$(mktemp -d); \
	  ditto -x -k "$$ZIP" "$$TMP" || (rm -rf "$$TMP"; echo "$(RED)ZIP corrompido.$(RESET)"; exit 2); \
	  APP=$$(ls -d "$$TMP"/*.app | head -1); \
	  codesign --verify --deep --strict "$$APP" 2>/dev/null || (rm -rf "$$TMP"; echo "$(RED)Assinatura inválida dentro do ZIP.$(RESET)"; exit 2); \
	  spctl --assess -vv "$$APP" 2>&1 | grep -q "source=Notarized Developer ID" || (rm -rf "$$TMP"; echo "$(RED)ZIP não notarizado: a atualização seria recusada.$(RESET)"; exit 2); \
	  xcrun stapler validate "$$APP" >/dev/null 2>&1 || (rm -rf "$$TMP"; echo "$(RED)Selo ausente no app dentro do ZIP.$(RESET)"; exit 2); \
	  rm -rf "$$TMP"; \
	  echo "$(GREEN)✓ ZIP de atualização notarizado e selado$(RESET)"

verify-dmg: ## Verifica integridade e imprime SHA-256 do instalador
	@test -f "out/make/Leadzy-Studio.dmg" || (echo "$(RED)DMG ausente. Rode make dmg.$(RESET)"; exit 2)
	@hdiutil verify "out/make/Leadzy-Studio.dmg"
	@spctl --assess -vv -t open --context context:primary-signature "out/make/Leadzy-Studio.dmg" 2>&1 | grep -q "source=Notarized Developer ID" || (echo "$(RED)DMG sem assinatura notarizada: o macOS recusa no download.$(RESET)"; exit 2)
	@xcrun stapler validate "out/make/Leadzy-Studio.dmg" >/dev/null 2>&1 || (echo "$(RED)DMG sem selo grudado: falha se o cliente estiver offline.$(RESET)"; exit 2)
	@echo "$(GREEN)✓ DMG notarizado e selado$(RESET)"
	@shasum -a 256 "out/make/Leadzy-Studio.dmg"

test: ## Executa os testes
	@pnpm test

lint: ## Executa o ESLint
	@pnpm lint

typecheck: ## Verifica os tipos
	@pnpm typecheck

format: ## Formata o repositório
	@pnpm format

format-check: ## Confere a formatação
	@pnpm format:check

check: typecheck lint format-check test build ## Gate completo antes de publicar
	@echo "$(BOLD)$(GREEN)✓ Todas as verificações passaram.$(RESET)"

info: ## Mostra informações do ambiente
	@echo "Leadzy Studio v$(VERSION)"
	@echo "Branch:  $(BRANCH)"
	@echo "Node:    $$(node --version 2>/dev/null || echo ausente)"
	@echo "pnpm:    $$(pnpm --version 2>/dev/null || echo ausente)"
	@echo "Sistema: $$(uname -s 2>/dev/null) $$(uname -m 2>/dev/null)"

clean: ## Remove somente builds e pacotes gerados
	@node -e "const fs=require('node:fs'); for (const p of ['dist','out','build/resources']) fs.rmSync(p,{recursive:true,force:true})"
	@echo "$(GREEN)✓ Artefatos gerados removidos.$(RESET)"
