/**
 * MCP-10/MCP-11 — the real stdio transport, exercised end to end.
 *
 * Everything else mocks the engine and uses an in-memory transport. This file
 * spawns the actual `sepia mcp` process and speaks JSON-RPC to it over pipes,
 * because two failure modes only exist in the real process:
 *
 *  - stdout purity. The stdio transport frames messages as newline-delimited
 *    JSON on stdout, so a single stray `console.log` anywhere in the import
 *    graph corrupts the channel for every host.
 *  - shutdown. The MCP stdio shutdown sequence starts by closing the server's
 *    stdin; SDK 1.29 does not surface that as a transport close, so a server
 *    that only listens for signals hangs until the host escalates to SIGKILL,
 *    stranding a Chromium process tree.
 */

import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { describe, it, expect, afterEach } from 'vitest';

const CLI = new URL('../../cli/index.ts', import.meta.url).pathname;

let child: ChildProcessWithoutNullStreams | undefined;

function startServer(): ChildProcessWithoutNullStreams {
  child = spawn('pnpm', ['tsx', CLI, 'mcp'], {
    cwd: new URL('../..', import.meta.url).pathname,
    env: { ...process.env, TMPDIR: `${new URL('../..', import.meta.url).pathname}/.tmp` },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return child;
}

function rpc(proc: ChildProcessWithoutNullStreams, msg: unknown): void {
  proc.stdin.write(JSON.stringify(msg) + '\n');
}

/** Resolve once `predicate` accepts a parsed stdout message, or on timeout. */
function waitForMessage(
  proc: ChildProcessWithoutNullStreams,
  predicate: (m: Record<string, unknown>) => boolean,
  timeoutMs = 45_000,
): Promise<{ message: Record<string, unknown> | null; stdout: string }> {
  return new Promise((resolve) => {
    let buf = '';
    let all = '';
    const timer = setTimeout(() => resolve({ message: null, stdout: all }), timeoutMs);

    proc.stdout.on('data', (chunk: Buffer) => {
      buf += chunk.toString();
      all += chunk.toString();
      let nl: number;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line === '') continue;
        try {
          const parsed = JSON.parse(line) as Record<string, unknown>;
          if (predicate(parsed)) {
            clearTimeout(timer);
            resolve({ message: parsed, stdout: all });
            return;
          }
        } catch {
          // A non-JSON line is exactly the corruption this suite guards against;
          // surface it by resolving with the raw stdout for the assertion.
          clearTimeout(timer);
          resolve({ message: null, stdout: all });
          return;
        }
      }
    });
  });
}

const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'stdio-test', version: '1.0.0' },
  },
};

afterEach(() => {
  child?.kill('SIGKILL');
  child = undefined;
});

describe('MCP-10 — stdout carries only JSON-RPC', () => {
  it('answers initialize with parseable JSON and nothing else on stdout', async () => {
    const proc = startServer();
    rpc(proc, INITIALIZE);

    const { message, stdout } = await waitForMessage(proc, (m) => m['id'] === 1);

    expect(message, `stdout was not clean JSON-RPC:\n${stdout}`).not.toBeNull();
    expect(message?.['jsonrpc']).toBe('2.0');
    expect((message?.['result'] as Record<string, unknown>)?.['serverInfo']).toBeDefined();
  }, 60_000);

  it('reports the package version, not a stale hardcoded one', async () => {
    const proc = startServer();
    rpc(proc, INITIALIZE);

    const { message } = await waitForMessage(proc, (m) => m['id'] === 1);
    const info = (message?.['result'] as Record<string, unknown>)?.['serverInfo'] as
      Record<string, unknown> | undefined;

    expect(info?.['version']).not.toBe('0.1.0');
  }, 60_000);

  it('lists every tool over the real transport', async () => {
    const proc = startServer();
    rpc(proc, INITIALIZE);
    await waitForMessage(proc, (m) => m['id'] === 1);
    rpc(proc, { jsonrpc: '2.0', method: 'notifications/initialized' });
    rpc(proc, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });

    const { message, stdout } = await waitForMessage(proc, (m) => m['id'] === 2);
    const tools = ((message?.['result'] as Record<string, unknown>)?.['tools'] ?? []) as Array<{
      name: string;
    }>;

    expect(tools.length, `stdout:\n${stdout}`).toBe(18);
    expect(tools.map((t) => t.name)).toContain('tabs_new');
  }, 60_000);
});

/** PIDs of processes whose parent is `pid` — the browser Sepia launched. */
function childPids(pid: number): number[] {
  const out = spawnSync('pgrep', ['-P', String(pid)], { encoding: 'utf-8' }).stdout ?? '';
  return out
    .split('\n')
    .map((l) => Number(l.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('MCP-11 — shutdown releases the browser', () => {
  it('exits and reaps its browser when the host closes stdin', async () => {
    const proc = startServer();
    rpc(proc, INITIALIZE);
    await waitForMessage(proc, (m) => m['id'] === 1);
    rpc(proc, { jsonrpc: '2.0', method: 'notifications/initialized' });

    // Launch a real browser first. With one open, the process has live handles
    // and will NOT drain on its own — this is where a server that ignores stdin
    // EOF hangs until the host escalates to SIGKILL, orphaning Chromium.
    rpc(proc, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'open', arguments: { url: 'https://example.com' } },
    });
    await waitForMessage(proc, (m) => m['id'] === 2);

    const browsers = childPids(proc.pid!);
    expect(browsers.length, 'expected a browser child process').toBeGreaterThan(0);

    const exited = new Promise<number | null>((resolve) => proc.on('exit', (c) => resolve(c)));

    // The MCP stdio shutdown sequence begins with the host closing stdin, and
    // only escalates to signals if the server fails to exit on its own.
    proc.stdin.end();

    const code = await Promise.race([
      exited,
      new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 20_000)),
    ]);
    expect(code, 'server did not exit after stdin closed').not.toBe('timeout');

    await new Promise((r) => setTimeout(r, 1500));
    expect(browsers.filter(alive), 'browser processes were orphaned rather than closed').toEqual(
      [],
    );
  }, 90_000);
});
