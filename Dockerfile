# ── Stage 1: builder ──────────────────────────────────────────────────────────
# Compile TypeScript; produces dist/ used by the runtime stage.
FROM node:22.11.0-bookworm-slim AS builder

WORKDIR /app

RUN npm install -g pnpm@9.12.3 --silent

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY examples/research-assistant/package.json examples/research-assistant/
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm tsc -p tsconfig.build.json

# ── Stage 2: runtime ──────────────────────────────────────────────────────────
# Production-only deps + Playwright Chromium binary.
FROM node:22.11.0-bookworm-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production
# Store Playwright browsers inside the workdir so they survive the chown below.
ENV PLAYWRIGHT_BROWSERS_PATH=/app/.playwright-browsers

RUN npm install -g pnpm@9.12.3 --silent

# Install production deps only.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY examples/research-assistant/package.json examples/research-assistant/
RUN pnpm install --frozen-lockfile --prod

# Download Chromium + system libraries (runs as root for apt-get).
RUN pnpm exec playwright install --with-deps chromium

# Copy compiled output and fixture pages from builder.
COPY --from=builder /app/dist ./dist
COPY fixtures ./fixtures

# Drop to a non-root user for runtime.
RUN addgroup --system --gid 1001 sepia \
 && adduser  --system --uid 1001 --gid 1001 --no-create-home sepia \
 && chown -R sepia:sepia /app

USER sepia

EXPOSE 3000

ENTRYPOINT ["node", "dist/cli/index.js"]
# Default command: start the HTTP server.
# Override with "run <goal>" to execute a one-shot agent run.
CMD ["serve"]
