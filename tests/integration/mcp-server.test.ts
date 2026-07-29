/**
 * MCP-1..MCP-8 — the MCP interface contract.
 *
 * The MCP server had zero test coverage. It is the mode where the *host* agent
 * (Claude Code, Codex) supplies the reasoning and Sepia supplies only the
 * browser, so its contract is the tool surface itself — what exists, what each
 * tool promises, and when the browser is alive.
 *
 * These run a real MCP Client against a real MCP Server over an in-memory
 * transport, so the assertions exercise genuine protocol traffic rather than
 * calling handlers directly. The engine underneath is mocked: the browser is
 * covered elsewhere, and mocking it is what lets us assert *when* it is created.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { makeMockEngine } from '../helpers/agent-harness.js';
import type { SepiaEngine } from '../../engine/index.js';
import type * as EngineModule from '../../engine/index.js';

vi.mock('../../engine/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof EngineModule>();
  return { ...actual, createEngine: vi.fn() };
});

let engine: SepiaEngine;
let client: Client;
let handle: { close: () => Promise<void> };

/** Connect a real client to a real Sepia MCP server over paired in-memory transports. */
async function connect(opts: Record<string, unknown> = {}) {
  const { createEngine } = await import('../../engine/index.js');
  const { createMcpServer } = await import('../../interfaces/mcp/index.js');

  engine = makeMockEngine();
  vi.mocked(createEngine).mockResolvedValue(engine);

  const sepia = createMcpServer(opts);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();

  client = new Client({ name: 'test-host', version: '1.0.0' }, { capabilities: {} });
  await Promise.all([sepia.connect(serverSide), client.connect(clientSide)]);

  handle = sepia;
  return { sepia, createEngine: vi.mocked(createEngine) };
}

async function toolNames(): Promise<string[]> {
  const { tools } = await client.listTools();
  return tools.map((t) => t.name).sort();
}

beforeEach(() => vi.clearAllMocks());

afterEach(async () => {
  await handle?.close().catch(() => {});
  await client?.close().catch(() => {});
});

// ── MCP-1 — the browser is not launched until it is needed ───────────────────

describe('MCP-1 — lazy browser', () => {
  it('does not launch a browser when the host connects', async () => {
    const { createEngine } = await connect();

    expect(createEngine).not.toHaveBeenCalled();
  });

  it('does not launch a browser merely to list tools', async () => {
    const { createEngine } = await connect();

    await client.listTools();

    expect(createEngine).not.toHaveBeenCalled();
  });

  it('launches on the first tool call that needs a page', async () => {
    const { createEngine } = await connect();

    await client.callTool({ name: 'open', arguments: { url: 'https://example.com' } });

    expect(createEngine).toHaveBeenCalledTimes(1);
  });

  it('reuses the same browser across calls', async () => {
    const { createEngine } = await connect();

    await client.callTool({ name: 'open', arguments: { url: 'https://example.com' } });
    await client.callTool({ name: 'observe', arguments: {} });
    await client.callTool({ name: 'observe', arguments: {} });

    expect(createEngine).toHaveBeenCalledTimes(1);
  });
});

// ── MCP-2 — the browser is released ──────────────────────────────────────────

describe('MCP-2 — teardown', () => {
  it('closes the browser when the server closes', async () => {
    const { sepia } = await connect();
    await client.callTool({ name: 'open', arguments: { url: 'https://example.com' } });

    await sepia.close();

    expect(vi.mocked(engine.close)).toHaveBeenCalled();
  });

  it('closing without ever starting a browser is not an error', async () => {
    const { sepia } = await connect();

    await expect(sepia.close()).resolves.not.toThrow();
    expect(vi.mocked(engine.close)).not.toHaveBeenCalled();
  });

  it('is idempotent — closing twice does not double-close the browser', async () => {
    const { sepia } = await connect();
    await client.callTool({ name: 'open', arguments: { url: 'https://example.com' } });

    await sepia.close();
    await sepia.close();

    expect(vi.mocked(engine.close)).toHaveBeenCalledTimes(1);
  });
});

// ── MCP-3 — every engine capability is reachable ─────────────────────────────

describe('MCP-3 — tool surface', () => {
  const EXPECTED = [
    'back',
    'check',
    'click',
    'forward',
    'hover',
    'observe',
    'open',
    'press',
    'read',
    'screenshot',
    'scroll',
    'select',
    'tabs_close',
    'tabs_list',
    'tabs_new',
    'tabs_switch',
    'text',
    'type',
    'wait',
  ].sort();

  it('exposes every engine capability', async () => {
    await connect();

    expect(await toolNames()).toEqual(EXPECTED);
  });

  it('gives every tool a description', async () => {
    await connect();
    const { tools } = await client.listTools();

    const undocumented = tools.filter((t) => !t.description || t.description.length < 20);
    expect(undocumented.map((t) => t.name)).toEqual([]);
  });

  it('uses names a host can address — no dots', async () => {
    await connect();

    // Dot-notation reads as namespacing to some hosts and is rejected by others.
    expect((await toolNames()).filter((n) => n.includes('.'))).toEqual([]);
  });
});

describe('MCP-3b — server identity', () => {
  it('reports the package version, so it cannot drift', async () => {
    const { readFileSync } = await import('node:fs');
    const pkg = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf-8'),
    ) as { version: string };

    await connect();
    const info = client.getServerVersion();

    expect(info?.version).toBe(pkg.version);
  });
});

// ── MCP-4 — tools dispatch to the engine ─────────────────────────────────────

describe('MCP-4 — dispatch', () => {
  it('open routes the url through', async () => {
    await connect();

    await client.callTool({ name: 'open', arguments: { url: 'https://example.com/x' } });

    expect(vi.mocked(engine.open)).toHaveBeenCalledWith('https://example.com/x');
  });

  it('type passes handle, text and submit', async () => {
    await connect();

    await client.callTool({
      name: 'type',
      arguments: { handle: 'e2', text: 'hello', submit: true },
    });

    expect(vi.mocked(engine.type)).toHaveBeenCalledWith('e2', 'hello', { submit: true });
  });

  it('wait forwards a structured condition', async () => {
    await connect();

    await client.callTool({
      name: 'wait',
      arguments: { condition: { type: 'networkIdle' }, timeoutMs: 3000 },
    });

    expect(vi.mocked(engine.wait)).toHaveBeenCalledWith({ type: 'networkIdle' }, 3000);
  });

  it('tabs_new reaches the tab namespace', async () => {
    await connect();

    await client.callTool({ name: 'tabs_new', arguments: { url: 'https://example.com' } });

    expect(vi.mocked(engine.tabs.new)).toHaveBeenCalledWith('https://example.com');
  });

  it('tabs_list reaches the tab namespace', async () => {
    await connect();

    await client.callTool({ name: 'tabs_list', arguments: {} });

    expect(vi.mocked(engine.tabs.list)).toHaveBeenCalled();
  });
});

// ── MCP-5 — arguments are validated, not coerced ─────────────────────────────

describe('MCP-5 — argument validation', () => {
  it('rejects open with no url instead of navigating to an empty string', async () => {
    await connect();

    const res = await client.callTool({ name: 'open', arguments: {} });

    expect(res.isError).toBe(true);
    expect(vi.mocked(engine.open)).not.toHaveBeenCalled();
  });

  it('rejects click with no handle', async () => {
    await connect();

    const res = await client.callTool({ name: 'click', arguments: {} });

    expect(res.isError).toBe(true);
    expect(vi.mocked(engine.click)).not.toHaveBeenCalled();
  });

  it('rejects a non-string handle', async () => {
    await connect();

    const res = await client.callTool({ name: 'click', arguments: { handle: 42 } });

    expect(res.isError).toBe(true);
    expect(vi.mocked(engine.click)).not.toHaveBeenCalled();
  });

  it('rejects an unknown verbosity', async () => {
    await connect();

    const res = await client.callTool({ name: 'observe', arguments: { verbosity: 'loud' } });

    expect(res.isError).toBe(true);
  });
});

// ── MCP-6 — hosts can tell safe tools from destructive ones ──────────────────

describe('MCP-6 — tool annotations', () => {
  async function annotationsFor(name: string) {
    const { tools } = await client.listTools();
    return tools.find((t) => t.name === name)?.annotations;
  }

  it.each(['observe', 'read', 'screenshot', 'tabs_list'])('marks %s read-only', async (name) => {
    await connect();
    expect((await annotationsFor(name))?.readOnlyHint).toBe(true);
  });

  it.each(['click', 'type', 'select', 'check', 'press'])(
    'marks %s as not read-only',
    async (name) => {
      await connect();
      expect((await annotationsFor(name))?.readOnlyHint).toBe(false);
    },
  );

  it('flags click as potentially destructive', async () => {
    await connect();

    // A host cannot tell "Delete all" from "Delete row 3" — see issue #3 — so a
    // click must be advertised as capable of doing damage.
    expect((await annotationsFor('click'))?.destructiveHint).toBe(true);
  });

  it('marks every tool as operating on the open web', async () => {
    await connect();
    const { tools } = await client.listTools();

    expect(tools.filter((t) => t.annotations?.openWorldHint !== true)).toEqual([]);
  });
});

// ── MCP-7 — observe returns data, not a JSON string ──────────────────────────

describe('MCP-7 — structured output', () => {
  it('returns the compact view as structured content', async () => {
    await connect();

    const res = await client.callTool({ name: 'observe', arguments: {} });

    expect(res.structuredContent).toMatchObject({
      url: 'https://example.com',
      title: 'Example',
    });
  });

  it('still includes a readable text rendering for hosts that ignore structure', async () => {
    await connect();

    const res = await client.callTool({ name: 'observe', arguments: {} });

    const text = (res.content as Array<{ type: string; text?: string }>)
      .filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join('');
    expect(text).toContain('e2');
  });

  it('declares an output schema for observe', async () => {
    await connect();
    const { tools } = await client.listTools();

    expect(tools.find((t) => t.name === 'observe')?.outputSchema).toBeDefined();
  });
});

// ── MCP-12 — a failed launch does not brick the session ──────────────────────

describe('MCP-12 — launch failure recovery', () => {
  it('reports a launch failure as a tool error', async () => {
    const { createEngine } = await connect();
    vi.mocked(createEngine).mockRejectedValueOnce(new Error('no browser'));

    const res = await client.callTool({ name: 'observe', arguments: {} });

    expect(res.isError).toBe(true);
  });

  it('retries on the next call instead of failing forever', async () => {
    const { createEngine } = await connect();
    vi.mocked(createEngine).mockRejectedValueOnce(new Error('transient launch failure'));

    // Memoising the launch *promise* is what makes concurrent first calls share
    // one browser — but a memoised rejection would poison every later call, so a
    // transient failure must not be cached.
    await client.callTool({ name: 'observe', arguments: {} });
    const after = await client.callTool({ name: 'observe', arguments: {} });

    expect(after.isError).toBeFalsy();
  });
});

// ── MCP-13 — internals are not leaked to the host ────────────────────────────

describe('MCP-13 — error messages', () => {
  it('does not echo raw exception text to the host', async () => {
    await connect();
    vi.mocked(engine.observe).mockRejectedValue(
      new Error(
        "browserType.launch: Executable doesn't exist at /Users/someone/.cache/ms-playwright/x",
      ),
    );

    const res = await client.callTool({ name: 'observe', arguments: {} });

    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).not.toContain('/Users/someone');
  });
});

// ── MCP-14 — page secrets do not reach the host model ────────────────────────

describe('MCP-14 — secret redaction', () => {
  it('redacts secret field values from the observed page', async () => {
    await connect();
    vi.mocked(engine.observe).mockResolvedValue({
      url: 'https://example.com/login',
      title: 'Login',
      verbosity: 'standard',
      tokenCount: 20,
      timestampMs: 0,
      nodes: [
        { handle: 'e1', role: 'textbox', name: 'Password', indent: 0, value: 'hunter2' },
        { handle: 'e2', role: 'button', name: 'Sign in', indent: 0 },
      ],
    });

    const res = await client.callTool({ name: 'observe', arguments: {} });

    // The host is an LLM context like any other. The agent path redacts before
    // the model sees a view; MCP must not be the hole in that invariant.
    const payload = JSON.stringify(res.content) + JSON.stringify(res.structuredContent);
    expect(payload).not.toContain('hunter2');
    expect(payload).toContain('[REDACTED]');
  });

  it('leaves ordinary values intact', async () => {
    await connect();
    vi.mocked(engine.observe).mockResolvedValue({
      url: 'https://example.com',
      title: 'Form',
      verbosity: 'standard',
      tokenCount: 10,
      timestampMs: 0,
      nodes: [{ handle: 'e1', role: 'textbox', name: 'Email', indent: 0, value: 'a@b.com' }],
    });

    const res = await client.callTool({ name: 'observe', arguments: {} });

    expect(JSON.stringify(res.structuredContent)).toContain('a@b.com');
  });
});

// ── MCP-9 — screenshot does not hand the host a file-write primitive ─────────

describe('MCP-9 — screenshot is capture-only over MCP', () => {
  it('does not accept a filesystem path', async () => {
    await connect();
    const { tools } = await client.listTools();

    // engine.screenshot({path}) writes wherever it is told. Exposed over MCP
    // that is an arbitrary-write primitive driven by a model, so the tool
    // returns image data instead and the path stays SDK-only.
    const props = tools.find((t) => t.name === 'screenshot')?.inputSchema?.properties ?? {};
    expect(Object.keys(props)).not.toContain('path');
  });

  it('ignores a path even if the host sends one', async () => {
    await connect();

    await client.callTool({ name: 'screenshot', arguments: { path: '/etc/passwd' } });

    const call = vi.mocked(engine.screenshot).mock.calls[0]?.[0];
    expect(call?.path).toBeUndefined();
  });

  it('returns the capture as image content', async () => {
    await connect();
    vi.mocked(engine.screenshot).mockResolvedValue({ ok: true, base64: 'iVBORw0KGgo=' });

    const res = await client.callTool({ name: 'screenshot', arguments: {} });

    const kinds = (res.content as Array<{ type: string }>).map((c) => c.type);
    expect(kinds).toContain('image');
  });
});

// ── MCP-8 — failures surface as tool errors ──────────────────────────────────

describe('MCP-8 — error handling', () => {
  it('reports a failed engine action without throwing at the protocol level', async () => {
    await connect();
    vi.mocked(engine.click).mockResolvedValue({
      ok: false,
      confidence: 0,
      error: { code: 'STALE_HANDLE', message: 'Handle e9 is stale', handle: 'e9' },
    });

    const res = await client.callTool({ name: 'click', arguments: { handle: 'e9' } });

    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain('STALE_HANDLE');
  });

  it('surfaces a thrown engine error as a tool error', async () => {
    await connect();
    vi.mocked(engine.observe).mockRejectedValue(new Error('browser crashed'));

    const res = await client.callTool({ name: 'observe', arguments: {} });

    expect(res.isError).toBe(true);
  });

  it('a failed call does not tear down the session', async () => {
    await connect();
    vi.mocked(engine.observe).mockRejectedValueOnce(new Error('transient'));

    await client.callTool({ name: 'observe', arguments: {} });
    const after = await client.callTool({ name: 'observe', arguments: {} });

    expect(after.isError).toBeFalsy();
  });
});
