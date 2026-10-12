# MailSense — Makefile для сборки, тестирования и упаковки
# Требования: Node >= 20, pnpm >= 10.
# Для упаковки Electron в первый раз нужен доступ к github.com (скачивание бинарников).

SHELL := /bin/bash
PNPM  := pnpm

.PHONY: help install core docflow server web electron build test pg run dev-server dev-web typecheck package-linux package-deb package-win package-win-exe package-win-nsis package clean

help: ## Список команд
	@echo "MailSense — цели:"
	@echo "  make install        установить зависимости (pnpm install)"
	@echo "  make build          собрать всё: core + server + web + electron"
	@echo "  make test           юнит-тесты (Jest; документам нужна PostgreSQL)"
	@echo "  make pg             поднять PostgreSQL для разработки и тестов"
	@echo "  make run            запустить headless-сервер http://127.0.0.1:8123"
	@echo "  make dev-server     dev-сервер API (tsx watch, порт 8123)"
	@echo "  make dev-web        dev-сервер SPA (Vite, порт 5173)"
	@echo "  make package-linux  .deb, адрес: SERVER_URL=http://… (то же, что package-deb)"
	@echo "  make package-deb    .deb, адрес: SERVER_URL=http://… (синоним)"
	@echo "  make package-win    собрать Windows zip (apps/electron/release/)"
	@echo "  make package        собрать оба пакета"
	@echo "  make clean          удалить dist/ и release/"

install: ## Установить зависимости
	$(PNPM) install

core: ## Собрать @mailsense/core (почта)
	$(PNPM) --filter @mailsense/core build

docflow: ## Собрать @mailsense/docflow (серверная часть)
	$(PNPM) --filter @mailsense/docflow build

server: ## Собрать @mailsense/server
	$(PNPM) --filter @mailsense/server build

web: ## Собрать @mailsense/web (SPA)
	$(PNPM) --filter @mailsense/web build

electron: core docflow server ## Собрать Electron main/preload (bundle core+docflow+server)
	$(PNPM) --filter mailsense-electron build

build: core docflow server web electron ## Собрать всё

pg: ## Поднять PostgreSQL для разработки и тестов (порт 55432)
	docker compose -f docker/docker-compose.dev.yml up -d

test: ## Юнит-тесты (почта + серверная часть; документам нужна PostgreSQL — make pg)
	$(PNPM) --filter @mailsense/core test
	$(PNPM) --filter @mailsense/docflow test

run: core docflow server web ## Запустить headless-сервер (продакшн)
	$(PNPM) --filter @mailsense/server start

dev-server: ## Dev-сервер API (tsx watch)
	$(PNPM) --filter @mailsense/server dev

dev-web: ## Dev-сервер SPA (Vite, проксирует /api на 8123)
	$(PNPM) --filter @mailsense/web dev

typecheck: ## Проверка типов SPA
	$(PNPM) --filter @mailsense/web typecheck

# Оба таргета делают одно и то же, и оба вшивают адрес сервера — ровно как make package-win.
#   make package-linux SERVER_URL=http://mail.enterprise.local:8123
#   make package-deb   SERVER_URL=http://mail.enterprise.local:8123
# Синонимы, а не две реализации: раньше package-linux молча игнорировал SERVER_URL, и один и тот же
# по смыслу таргет давал разные пакеты.
package-linux: package-deb ## Собрать .deb (Linux); адрес сервера: make package-linux SERVER_URL=http://…

package-deb: build ## Собрать .deb (Linux); адрес сервера: make package-deb SERVER_URL=http://…
	cd apps/electron && node scripts/make-server-json.mjs "$(SERVER_URL)"
	cd apps/electron && $(PNPM) dist:deb

package-win: build ## Собрать Windows zip; адрес сервера: make package-win SERVER_URL=http://mail.example.local:8123
	cd apps/electron && node scripts/make-server-json.mjs "$(SERVER_URL)"
	cd apps/electron && $(PNPM) dist:win

package-win-exe: build ## Собрать Windows portable .exe (один файл, без установки)
	cd apps/electron && $(PNPM) dist:win-portable

package-win-nsis: build ## Собрать Windows NSIS-инсталлятор (.exe setup)
	cd apps/electron && $(PNPM) dist:win-nsis

package: package-linux package-win ## Собрать оба пакета

clean: ## Очистить артефакты сборки
	rm -rf packages/core/dist packages/server/dist packages/web/dist apps/electron/dist apps/electron/release
