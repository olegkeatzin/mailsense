# MailSense — Makefile для сборки, тестирования и упаковки
# Требования: Node >= 20, pnpm >= 10.
# Для упаковки Electron в первый раз нужен доступ к github.com (скачивание бинарников).

SHELL := /bin/bash
PNPM  := pnpm

.PHONY: help install core server web electron build test run dev-server dev-web typecheck package-linux package-deb package-win package-win-exe package-win-nsis package clean

help: ## Список команд
	@echo "MailSense — цели:"
	@echo "  make install        установить зависимости (pnpm install)"
	@echo "  make build          собрать всё: core + server + web + electron"
	@echo "  make test           юнит-тесты (Jest)"
	@echo "  make run            запустить headless-сервер http://127.0.0.1:8123"
	@echo "  make dev-server     dev-сервер API (tsx watch, порт 8123)"
	@echo "  make dev-web        dev-сервер SPA (Vite, порт 5173)"
	@echo "  make package-linux  собрать .deb (apps/electron/release/)"
	@echo "  make package-deb    собрать .deb (Linux)"
	@echo "  make package-win    собрать Windows zip (apps/electron/release/)"
	@echo "  make package        собрать оба пакета"
	@echo "  make clean          удалить dist/ и release/"

install: ## Установить зависимости
	$(PNPM) install

core: ## Собрать @mailsense/core
	$(PNPM) --filter @mailsense/core build

server: ## Собрать @mailsense/server
	$(PNPM) --filter @mailsense/server build

web: ## Собрать @mailsense/web (SPA)
	$(PNPM) --filter @mailsense/web build

electron: core server ## Собрать Electron main/preload (bundle core+server)
	$(PNPM) --filter mailsense-electron build

build: core server web electron ## Собрать всё

test: ## Юнит-тесты
	$(PNPM) --filter @mailsense/core test

run: core server web ## Запустить headless-сервер (продакшн)
	$(PNPM) --filter @mailsense/server start

dev-server: ## Dev-сервер API (tsx watch)
	$(PNPM) --filter @mailsense/server dev

dev-web: ## Dev-сервер SPA (Vite, проксирует /api на 8123)
	$(PNPM) --filter @mailsense/web dev

typecheck: ## Проверка типов SPA
	$(PNPM) --filter @mailsense/web typecheck

package-linux: build ## Собрать .deb (Linux)
	cd apps/electron && $(PNPM) dist:linux

package-deb: build ## Собрать .deb (Linux)
	cd apps/electron && $(PNPM) dist:deb

package-win: build ## Собрать Windows zip
	cd apps/electron && $(PNPM) dist:win

package-win-exe: build ## Собрать Windows portable .exe (один файл, без установки)
	cd apps/electron && $(PNPM) dist:win-portable

package-win-nsis: build ## Собрать Windows NSIS-инсталлятор (.exe setup)
	cd apps/electron && $(PNPM) dist:win-nsis

package: package-linux package-win ## Собрать оба пакета

clean: ## Очистить артефакты сборки
	rm -rf packages/core/dist packages/server/dist packages/web/dist apps/electron/dist apps/electron/release
