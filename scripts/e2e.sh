#!/usr/bin/env bash
#
# End-to-end verification of the three paths a user actually takes: build the
# package, run it as a consumer gets it, and deploy it (issue #1).
#
# The individual targets already existed — `make build`, `make helm-lint`,
# `make docker-build` — but nothing chained them, so nothing checked that the
# output of one stage is usable as the input of the next. That is the class of
# failure this catches: a tarball missing `dist/`, a bin that is not
# executable, an image that builds and then will not serve.
#
# Stages that need a daemon or a plugin are skipped with a message rather than
# failing the run, so this is usable on a laptop and in CI alike. Skips are
# reported at the end; a skip is never silent.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PASSED=(); FAILED=(); SKIPPED=()
pass()  { PASSED+=("$1");  printf '  \033[32mok\033[0m   %s\n' "$1"; }
fail()  { FAILED+=("$1");  printf '  \033[31mFAIL\033[0m %s\n' "$1"; }
skip()  { SKIPPED+=("$1"); printf '  \033[33mskip\033[0m %s — %s\n' "$1" "$2"; }
stage() { printf '\n\033[1m%s\033[0m\n' "$1"; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# ── build ────────────────────────────────────────────────────────────────────
stage "build"

if pnpm tsc -p tsconfig.build.json >"$WORK/build.log" 2>&1 && chmod +x dist/cli/index.js; then
  pass "compiles to dist/"
else
  fail "compiles to dist/"; tail -20 "$WORK/build.log"
fi

TARBALL=""
if npm pack --pack-destination "$WORK" >"$WORK/pack.log" 2>&1; then
  TARBALL="$(find "$WORK" -maxdepth 1 -name '*.tgz' | head -1)"
  pass "packs a tarball ($(basename "$TARBALL"))"
else
  fail "packs a tarball"; tail -20 "$WORK/pack.log"
fi

if [ -n "$TARBALL" ]; then
  missing=""
  for required in package/dist/cli/index.js package/dist/interfaces/mcp/index.js package/README.md; do
    tar -tzf "$TARBALL" | grep -qx "$required" || missing="$missing $required"
  done
  if [ -z "$missing" ]; then pass "tarball carries the entry points"
  else fail "tarball carries the entry points —$missing"; fi

  # Reported, not asserted: narrowing what ships is packaging policy, and the
  # `files` field that would do it lives in the parked publishing work (#35).
  extra="$(tar -tzf "$TARBALL" | grep -cE '^package/(tests|fixtures|helm|\.github)/' || true)"
  printf '  \033[36mnote\033[0m tarball carries %s files from tests/fixtures/helm/.github\n' "$extra"
fi

# ── run ──────────────────────────────────────────────────────────────────────
stage "run"

if [ -n "$TARBALL" ]; then
  mkdir -p "$WORK/consumer" && cd "$WORK/consumer"
  npm init -y >/dev/null 2>&1
  if npm install --no-audit --no-fund "$TARBALL" >"$WORK/install.log" 2>&1; then
    pass "installs from the tarball into a clean project"

    if [ -x "$WORK/consumer/node_modules/.bin/sepia" ]; then
      pass "installs an executable \`sepia\` command"
    else
      fail "installs an executable \`sepia\` command"
    fi

    cd "$ROOT"
    if node scripts/smoke-mcp.mjs "$WORK/consumer/node_modules/.bin/sepia" >"$WORK/mcp.log" 2>&1; then
      pass "packed MCP server handshakes and lists its tools"
    else
      fail "packed MCP server handshakes and lists its tools"; tail -20 "$WORK/mcp.log"
    fi
  else
    fail "installs from the tarball into a clean project"; tail -20 "$WORK/install.log"
  fi
  cd "$ROOT"
fi

# ── deploy ───────────────────────────────────────────────────────────────────
stage "deploy"

if command -v helm >/dev/null 2>&1; then
  if helm lint helm/sepia >"$WORK/helm.log" 2>&1 &&
     helm template sepia helm/sepia >"$WORK/helm-template.yaml" 2>>"$WORK/helm.log"; then
    pass "helm chart lints and renders"
  else
    fail "helm chart lints and renders"; tail -20 "$WORK/helm.log"
  fi
else
  skip "helm chart lints and renders" "helm not installed"
fi

if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  if [ "${E2E_DOCKER:-1}" = "0" ]; then
    skip "image builds and serves /health" "E2E_DOCKER=0"
  elif DOCKER_BUILDKIT=1 docker build -t sepia:e2e . >"$WORK/docker.log" 2>&1; then
    pass "image builds"
    CID="$(docker run -d -p 18899:3000 -e SEPIA_SERVER_API_KEY=e2e-key sepia:e2e 2>>"$WORK/docker.log")"
    if [ -n "$CID" ]; then
      ok=""
      for _ in $(seq 1 30); do
        if curl -fsS http://127.0.0.1:18899/health >"$WORK/health.json" 2>/dev/null; then ok=1; break; fi
        sleep 1
      done
      if [ -n "$ok" ]; then pass "container serves /health ($(cat "$WORK/health.json"))"
      else fail "container serves /health"; docker logs "$CID" 2>&1 | tail -20; fi
      docker rm -f "$CID" >/dev/null 2>&1
    else
      fail "container starts"; tail -20 "$WORK/docker.log"
    fi
  else
    fail "image builds"; tail -30 "$WORK/docker.log"
  fi
else
  skip "image builds and serves /health" "docker daemon not available"
fi

# ── summary ──────────────────────────────────────────────────────────────────
printf '\n\033[1msummary\033[0m  %d passed, %d failed, %d skipped\n' \
  "${#PASSED[@]}" "${#FAILED[@]}" "${#SKIPPED[@]}"
for s in "${SKIPPED[@]:-}"; do [ -n "$s" ] && printf '  skipped: %s\n' "$s"; done
for f in "${FAILED[@]:-}"; do [ -n "$f" ] && printf '  failed:  %s\n' "$f"; done
[ "${#FAILED[@]}" -eq 0 ] || exit 1
