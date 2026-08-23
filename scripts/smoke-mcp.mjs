#!/usr/bin/env node
/**
 * Drive an installed Sepia over real stdio JSON-RPC.
 *
 *   node scripts/smoke-mcp.mjs <path-to-sepia-bin>
 *
 * Used by `make e2e` to check the *packed* artifact, not the source tree: a
 * missing file in `dist/`, a bin that is not executable, or an import that
 * resolved locally but not from a tarball are all invisible to `make ci` and
 * fatal to anyone installing the package.
 *
 * A driver rather than piping JSON in from the shell, because the server shuts
 * down on stdin EOF — correct behaviour, since a host that goes away should not
 * leave a browser running — and a pipe reaches EOF immediately, racing any call
 * that has to do real work.
 */

import { spawn } from 'node:child_process';

const bin = process.argv[2];
if (bin === undefined) {
  console.error('usage: node scripts/smoke-mcp.mjs <path-to-sepia-bin>');
  process.exit(2);
}

const TIMEOUT_MS = 60_000;
const REQUIRED_TOOLS = ['observe', 'click', 'type', 'text', 'batch', 'tabs_switch'];

const child = spawn(bin, ['mcp'], { stdio: ['pipe', 'pipe', 'pipe'] });
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
      // stdout is the JSON-RPC transport; a stray console.log corrupts it.
      console.error(`FAIL: non-JSON on stdout: ${line.slice(0, 200)}`);
      process.exit(1);
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

try {
  await request(1, 'initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'sepia-e2e', version: '1.0.0' },
  });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });

  const response = await request(2, 'tools/list', {});
  const names = (response.result?.tools ?? []).map((t) => t.name);
  const missing = REQUIRED_TOOLS.filter((t) => !names.includes(t));
  if (missing.length > 0) {
    console.error(`FAIL: packed server is missing tools: ${missing.join(', ')}`);
    process.exit(1);
  }
  console.log(`ok: ${String(names.length)} tools listed`);
} finally {
  child.stdin.end();
}
