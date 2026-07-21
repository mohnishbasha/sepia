# syntax=docker/dockerfile:1.7
# BuildKit required — enables cache mounts for pnpm store and apt packages.
# All cache mounts are ephemeral (not baked into image layers) but persist on
# the build host / GHA runner between runs, making repeated builds much faster.

# ── base: Node.js + pnpm (installed once, shared by all stages) ───────────────
FROM node:22.11.0-bookworm-slim AS base
# Cache mount prevents re-downloading pnpm on every build.
RUN --mount=type=cache,id=npm-global,target=/root/.npm \
    npm install -g pnpm@9.12.3 --silent

# ── deps: all packages (dev + prod) ──────────────────────────────────────────
# Invalidated only when package manifests or lockfile change.
FROM base AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY examples/research-assistant/package.json examples/research-assistant/
# pnpm store cache: packages are fetched once and reused across builds.
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

# ── prod-deps: production packages only ───────────────────────────────────────
# Separate stage keeps the browser layer independent of dev tooling.
FROM base AS prod-deps
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY examples/research-assistant/package.json examples/research-assistant/
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --prod

# ── builder: compile TypeScript → dist/ ───────────────────────────────────────
# Only re-runs when source files change; never triggers browser re-download.
FROM deps AS builder
WORKDIR /app
COPY . .
RUN pnpm tsc -p tsconfig.build.json

# ── playwright-browser: Chromium system libs + binary ─────────────────────────
# Isolated stage so the ~300 MB browser download is cached independently.
# Rebuilt only when the Playwright version in pnpm-lock.yaml changes.
FROM prod-deps AS playwright-browser
ENV PLAYWRIGHT_BROWSERS_PATH=/app/.playwright-browsers
# Two separate RUN commands so system-lib and browser layers cache independently:
# apt packages (first) vs. Chromium binary (second, ~300 MB).
RUN --mount=type=cache,id=apt,sharing=locked,target=/var/cache/apt \
    --mount=type=cache,id=apt-lists,sharing=locked,target=/var/lib/apt/lists \
    pnpm exec playwright install-deps chromium
RUN pnpm exec playwright install chromium

# ── runtime: final image ──────────────────────────────────────────────────────
# Inherits Chromium system libs and binary from playwright-browser.
# No second dep install needed — prod node_modules already present.
FROM playwright-browser AS runtime
ENV NODE_ENV=production

# Create non-root user before COPY so --chown works in one pass.
RUN addgroup --system --gid 1001 sepia \
 && adduser  --system --uid 1001 --gid 1001 --no-create-home sepia

# COPY --chown avoids a recursive chown layer over node_modules + browser binary.
# node_modules and .playwright-browsers remain root-owned but world-readable (755/644).
COPY --from=builder --chown=sepia:sepia /app/dist ./dist
COPY --chown=sepia:sepia fixtures ./fixtures

USER sepia

EXPOSE 3000
ENTRYPOINT ["node", "dist/cli/index.js"]
# Default: start the HTTP server. Override with "run <goal>" for one-shot runs.
CMD ["serve"]
