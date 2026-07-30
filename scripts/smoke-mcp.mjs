#!/usr/bin/env node
/**
 * Smoke test the MCP server as a consumer gets it.
 *
 * Run against an installed package, not the source tree — the point is to catch
 * the failures that only exist after packing: a missing file in `dist/`, a bin
 * that is not executable, an import that resolved locally but not from a
 * tarball. `make ci` cannot see any of those.
 *
 *   node scripts/smoke-mcp.mjs <path-to-sepia-bin>
 *
 * Why a driver instead of piping JSON-RPC in from the shell: the server shuts
 * down on stdin EOF, which is correct behaviour — a host that goes away should
 * not leave a browser running. But a pipe reaches EOF immediately, so the
 * shutdown races any call that has to launch Chromium, and the response never
 * arrives. Measured: `tools/list` answered in time, `tools/call` did not. A
 * release gate that depends on winning that race fails for reasons unrelated to
 * the release.
 */

import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

const bin = process.argv[2];
if (bin === undefined) {
  console.error('usage: node scripts/smoke-mcp.mjs <path-to-sepia-bin>');
  process.exit(2);
}

const TIMEOUT_MS = 60_000;

/** Tools whose absence means the packed server is not the server we built. */
const REQUIRED_TOOLS = ['observe', 'click', 'type', 'text', 'batch', 'tabs_switch'];

function startServer(env) {
  const child = spawn(bin, ['mcp'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
  });

  const pending = new Map();
  let buffer = '';
  let stderr = '';

  child.stdout.setEncoding('utf-8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line === '') continue;

      let message;
      try {
        message = JSON.parse(line);
      } catch {
        // Anything unparseable on stdout is itself a failure: the transport is
        // JSON-RPC only, and a stray console.log corrupts the stream.
        fail(`non-JSON line on stdout: ${line.slice(0, 200)}`);
        return;
      }
      const resolve = pending.get(message.id);
      if (resolve !== undefined) {
        pending.delete(message.id);
        resolve(message);
      }
    }
  });

  child.stderr.setEncoding('utf-8');
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });

  function send(message) {
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  function request(id, method, params) {
    send({ jsonrpc: '2.0', id, method, params });
    return new Promise((resolve, reject) => {
      pending.set(id, resolve);
      setTimeout(
        () => reject(new Error(`timed out waiting for ${method}\nstderr:\n${stderr}`)),
        TIMEOUT_MS,
      ).unref();
    });
  }

  return { child, send, request, stderrText: () => stderr };
}

function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

async function handshake(server) {
  await server.request(1, 'initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'sepia-smoke', version: '1.0.0' },
  });
  server.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
}

// ── 1. the packed server starts, handshakes and lists its tools ──────────────

const listing = startServer({});
try {
  await handshake(listing);
  const response = await listing.request(2, 'tools/list', {});
  const names = (response.result?.tools ?? []).map((t) => t.name);

  const missing = REQUIRED_TOOLS.filter((t) => !names.includes(t));
  if (missing.length > 0) fail(`packed server is missing tools: ${missing.join(', ')}`);

  console.log(`ok: ${String(names.length)} tools listed (${names.sort().join(', ')})`);
} finally {
  listing.child.stdin.end();
}

// ── 2. with no browser installed, it says what to run ───────────────────────
//
// This is the first thing a new consumer hits, because installing the package
// does not fetch a browser. Pointing the browser path at an empty directory
// reproduces a clean machine.

const noBrowser = startServer({
  PLAYWRIGHT_BROWSERS_PATH: mkdtempSync(`${tmpdir()}/sepia-smoke-no-browser-`),
});
try {
  await handshake(noBrowser);
  const response = await noBrowser.request(3, 'tools/call', {
    name: 'observe',
    arguments: {},
  });
  const text = JSON.stringify(response.result?.content ?? '');

  if (response.result?.isError !== true) fail('a missing browser was not reported as an error');
  if (!text.includes('playwright install')) {
    fail(`a missing browser did not name the install command: ${text.slice(0, 300)}`);
  }
  console.log('ok: a missing browser reports the command that fixes it');
} finally {
  noBrowser.child.stdin.end();
}

console.log('MCP smoke test passed.');
