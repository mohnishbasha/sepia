.DEFAULT_GOAL := help
SHELL         := /bin/bash
NODE_VERSION  := 22.11.0
PNPM_VERSION  := 9.12.3
# Route Vitest temp files to a local dir (avoids sandbox EACCES on macOS)
TMPDIR        := $(CURDIR)/.tmp
export TMPDIR

.PHONY: help setup install build run dev \
        test test-unit test-contract test-integration \
        test-tokens test-mutation test-fingerprint \
        test-leak test-boundary test-resilience test-example \
        run-example lint fmt fmt-check typecheck security ci clean \
        patch chromium-build patch-check

# ── Help ──────────────────────────────────────────────────────────────────────

help: ## Show available targets
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
	  | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-22s\033[0m %s\n", $$1, $$2}'

# ── Setup ─────────────────────────────────────────────────────────────────────

setup: ## Install toolchain and pinned dependencies (run once after clone)
	@echo "Node: $$(node --version)  (expected v$(NODE_VERSION))"
	@echo "pnpm: installing..."
	npm install -g pnpm@$(PNPM_VERSION) --silent
	pnpm install
	pnpm playwright install chromium --with-deps

install: setup ## Alias for setup

# ── Build ─────────────────────────────────────────────────────────────────────

build: ## Compile TypeScript → dist/
	pnpm tsc -p tsconfig.build.json

# ── Run ───────────────────────────────────────────────────────────────────────

run: ## Run CLI locally. Usage: make run ARGS='run "book a table for 2"'
	pnpm tsx cli/index.ts $(ARGS)

dev: ## Run CLI in watch/dev mode
	pnpm tsx watch cli/index.ts

run-example: ## Run research-assistant example. Usage: make run-example QUERIES="TypeScript generics,Rust ownership"
	pnpm tsx examples/research-assistant/src/index.ts "$(QUERIES)"

# ── Tests ─────────────────────────────────────────────────────────────────────

test: ## Full test suite
	pnpm vitest run

test-unit: ## Unit tests (config, resolver, privacy, telemetry, actions, fingerprint)
	pnpm vitest run tests/unit

test-contract: ## Action API contract tests
	pnpm vitest run tests/contract

test-integration: ## End-to-end integration tests (requires browser engine)
	pnpm vitest run tests/integration

test-tokens: ## Token-budget tests — 20-page corpus (requires serializer + M1)
	pnpm vitest run tests/token-budget

test-mutation: ## Handle mutation stability tests (requires resolver + M2)
	pnpm vitest run tests/mutation

test-fingerprint: ## JA3/JA4 fingerprint coherence tests (requires patched Chromium + M4)
	pnpm vitest run tests/fingerprint

test-leak: ## Cross-profile isolation leak tests (requires M5)
	pnpm vitest run tests/cross-profile

test-boundary: ## Data-boundary audit tests
	pnpm vitest run tests/data-boundary

test-resilience: ## Resilience tests — slow network, dropped session (requires engine + M3)
	pnpm vitest run tests/resilience

test-example: ## Research-assistant example smoke tests (requires M3)
	pnpm vitest run tests/example

# ── Code quality ──────────────────────────────────────────────────────────────

lint: ## ESLint (enforces one-way imports, no-eval, naming rules)
	pnpm eslint .

fmt: ## Format with Prettier
	pnpm prettier --write "**/*.{ts,mjs,json,md}" --ignore-path .gitignore

fmt-check: ## Check formatting (non-destructive, used in CI)
	pnpm prettier --check "**/*.{ts,mjs,json,md}" --ignore-path .gitignore

typecheck: ## TypeScript type-check without emitting (tsc --noEmit)
	pnpm tsc --noEmit

# ── Security ──────────────────────────────────────────────────────────────────

security: ## SAST + SCA — fails on known-critical CVEs
	pnpm audit --audit-level=critical

# ── Chromium patch set (M4) ───────────────────────────────────────────────────

patch: ## Apply all patches to the Chromium checkout in patches/chromium/
	@echo "Applying patch set to patches/chromium/ ..."
	@for p in patches/*.patch; do \
	  echo "  applying $$p"; \
	  patch -d patches/chromium -p1 < "$$p" || exit 1; \
	done
	@echo "All patches applied."

chromium-build: ## Build patched Chromium binary → bin/chromium
	@echo "Building patched Chromium (this takes ~4-8 hours on first run)..."
	@echo "See patches/README.md for prerequisites."
	cd patches/chromium && ninja -C out/Release chrome

patch-check: ## Verify patches apply cleanly to the current Chromium checkout
	$(MAKE) patch && echo "Patch check passed."

# ── CI gate ───────────────────────────────────────────────────────────────────

ci: ## Exact gate run by CI: build + lint + typecheck + test + security
	$(MAKE) build
	$(MAKE) lint
	$(MAKE) typecheck
	$(MAKE) test
	$(MAKE) security

# ── Cleanup ───────────────────────────────────────────────────────────────────

clean: ## Remove build artifacts and coverage
	rm -rf dist/ coverage/ *.tsbuildinfo
	find examples -name dist -type d -exec rm -rf {} + 2>/dev/null || true
