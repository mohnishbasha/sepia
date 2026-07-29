/**
 * MCP server — Sepia as a browser for someone else's agent.
 *
 * In this mode the host (Claude Code, Codex, Claude Desktop) does the
 * reasoning and Sepia supplies only the browser. There is deliberately no
 * model client here: nothing in this module's import graph reaches `agent/`,
 * so `openai` is never loaded and no API key is required. Keep it that way —
 * importing from `agent/` would pull a model client into a server that has no
 * use for one.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createRequire } from 'node:module';
import { z } from 'zod';
import { createEngine } from '../../engine/index.js';
import type { EngineOptions, SepiaEngine } from '../../engine/index.js';
import { redactCompactView } from '../../privacy/index.js';
import type { CompactView } from '../../types/index.js';

/**
 * Sepia's own version, reported to the host during initialize.
 *
 * Read from package.json rather than duplicated, because a hardcoded version
 * silently goes stale — the previous server reported 0.1.0 long after the
 * package reached 0.2.0. Resolved from both the source tree and dist/.
 */
function packageVersion(): string {
  const require = createRequire(import.meta.url);
  for (const path of ['../../package.json', '../../../package.json']) {
    try {
      const pkg = require(path) as { name?: string; version?: string };
      if (pkg.name === 'sepia' && typeof pkg.version === 'string') return pkg.version;
    } catch {
      // try the next candidate
    }
  }
  return '0.0.0';
}

export interface McpServerOptions {
  /**
   * Browser and engine settings. There is no model configuration because this
   * server never calls a model — the host does.
   */
  engine?: EngineOptions;
  /** Server name reported to the host. */
  name?: string;
  /** Server version reported to the host. */
  version?: string;
}

export interface SepiaMcpServer {
  /** The underlying MCP server, for hosts that need direct access. */
  readonly server: McpServer;
  /** Serve over the given transport. */
  connect(transport: Transport): Promise<void>;
  /** Shut down and release the browser. Safe to call more than once. */
  close(): Promise<void>;
}

// ── Shared description text ──────────────────────────────────────────────────

/**
 * Every element-targeting tool repeats this, because a host that does not know
 * the handle rules will reuse a handle across a navigation and be confused by
 * the resulting STALE_HANDLE.
 */
const HANDLE_RULES =
  'Handles come from `observe` and are only valid for the page that produced them. ' +
  'Navigating invalidates them — call `observe` again after any navigation. ' +
  'A handle that no longer resolves fails closed with STALE_HANDLE rather than ' +
  'acting on a different element.';

const AMBIGUITY_WARNING =
  'Elements that share a role and name (for example several buttons all labelled ' +
  '"Delete") appear as separate handles but identical text. Confirm which one you ' +
  'want — via nearby content or a screenshot — before acting, especially when the ' +
  'action cannot be undone.';

// ── Result rendering ─────────────────────────────────────────────────────────

/** Render a compact view as the indented outline a model reads. */
function renderView(view: CompactView): string {
  const lines = [`URL: ${view.url}`, `Title: ${view.title}`, ''];
  for (const n of view.nodes) {
    const indent = '  '.repeat(n.indent);
    const handle = n.handle ? `[${n.handle}] ` : '';
    const value = n.value ? ` "${n.value}"` : '';
    lines.push(`${indent}${handle}${n.role} "${n.name}"${value}`);
  }
  return lines.join('\n');
}

function ok(text: string): CallToolResult {
  return { content: [{ type: 'text', text }] };
}

function fail(text: string): CallToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

/**
 * Convert an engine result into a tool result.
 *
 * An engine action that reports `ok: false` is a failed tool call from the
 * host's point of view, so it is marked `isError` — otherwise a host reads a
 * refusal as a success and carries on against a page it never changed.
 */
function fromEngineResult(result: {
  ok: boolean;
  error?: { code: string; message: string };
}): CallToolResult {
  if (!result.ok) {
    const code = result.error?.code ?? 'UNKNOWN';
    const message = result.error?.message ?? 'action failed';
    return fail(`${code}: ${message}`);
  }
  return ok(JSON.stringify(result));
}

// ── Annotations ──────────────────────────────────────────────────────────────

type Annotations = {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: true;
};

/** Reads the page without changing it. */
const READS: Annotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

/** Changes the page, but not in a way that destroys anything. */
const WRITES: Annotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
};

/**
 * May cause irreversible change. Sepia cannot tell a "Delete all" button from a
 * "Delete row 3" button when both render as `button "Delete"`, so anything that
 * activates a control is advertised as destructive and left for the host to gate.
 */
const DESTROYS: Annotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
};

// ── Server ───────────────────────────────────────────────────────────────────

export function createMcpServer(opts: McpServerOptions = {}): SepiaMcpServer {
  const server = new McpServer(
    { name: opts.name ?? 'sepia', version: opts.version ?? packageVersion() },
    { capabilities: { tools: {} } },
  );

  // ── engine lifecycle ──
  // Created on the first tool call that needs a page, not at startup: a host
  // that registers Sepia and never uses it should not pay for a Chromium.
  let engine: SepiaEngine | null = null;
  let starting: Promise<SepiaEngine> | null = null;
  let closed = false;

  // Deliberately no idle teardown. Recreating the engine restarts handle
  // numbering at e1, so a handle the host still holds would silently bind to a
  // different element on the next page — the exact failure handles exist to
  // prevent. Doing it safely needs the engine to carry a handle counter across
  // generations; until then, lazy startup covers the case that matters (a host
  // that registers Sepia and never uses it never launches a browser).

  async function releaseEngine(): Promise<void> {
    const current = engine;
    engine = null;
    starting = null;
    if (current !== null) await current.close().catch(() => {});
  }

  async function getEngine(): Promise<SepiaEngine> {
    if (closed) throw new Error('server is closed');
    if (engine !== null) return engine;
    // Memoise the launch *promise* so concurrent first calls share one browser
    // rather than racing two. A rejection must not stay memoised, though: a
    // transient launch failure would otherwise poison every later call and the
    // session would look healthy while being permanently dead.
    starting ??= createEngine(opts.engine ?? {}).then(
      (e) => {
        engine = e;
        return e;
      },
      (err: unknown) => {
        starting = null;
        throw err;
      },
    );
    return starting;
  }

  /** Run a tool body against the engine, converting failures into tool errors. */
  async function withEngine(
    fn: (e: SepiaEngine) => Promise<CallToolResult>,
  ): Promise<CallToolResult> {
    try {
      const e = await getEngine();
      return await fn(e);
    } catch (err) {
      // Detail goes to the operator, not the host: Playwright errors carry
      // executable and cache paths, and the host is an untrusted-ish consumer
      // that only needs to know the action did not happen.
      process.stderr.write(`[sepia mcp] ${err instanceof Error ? err.stack : String(err)}\n`);
      return fail(
        'BROWSER_ERROR: the browser could not complete that action. ' +
          'Retry, or call `observe` to re-read the page.',
      );
    }
  }

  const handleArg = z.string().min(1).describe('Element handle from `observe`, e.g. "e12"');

  // ── observation ──

  server.registerTool(
    'observe',
    {
      title: 'Observe the page',
      description:
        'Return the current page as a compact outline: one line per meaningful element, ' +
        'with a handle on every interactive one. This is how you find things to act on — ' +
        'call it before your first action on a page and again after anything that changes it. ' +
        AMBIGUITY_WARNING,
      inputSchema: {
        verbosity: z
          .enum(['minimal', 'standard', 'full'])
          .optional()
          .describe('minimal = interactive only; standard = default; full = all text'),
      },
      outputSchema: {
        url: z.string(),
        title: z.string(),
        tokenCount: z.number(),
        nodes: z.array(
          z.object({
            handle: z.string().optional(),
            role: z.string(),
            name: z.string(),
            value: z.string().optional(),
          }),
        ),
      },
      annotations: READS,
    },
    async ({ verbosity }) =>
      withEngine(async (e) => {
        // The host is an LLM context like any other, so the same redaction the
        // agent loop applies must apply here — otherwise MCP is the hole in the
        // "secrets never enter LLM context" invariant.
        const view = redactCompactView(
          await e.observe(verbosity !== undefined ? { verbosity } : {}),
        );
        return {
          content: [{ type: 'text', text: renderView(view) }],
          structuredContent: {
            url: view.url,
            title: view.title,
            tokenCount: view.tokenCount,
            nodes: view.nodes.map((n) => ({
              ...(n.handle !== undefined ? { handle: n.handle } : {}),
              role: n.role,
              name: n.name,
              ...(n.value !== undefined ? { value: n.value } : {}),
            })),
          },
        };
      }),
  );

  server.registerTool(
    'read',
    {
      title: 'Read one element',
      description:
        'Return the full visible text of a single element. Use this when the outline ' +
        'truncated something you need in full. ' +
        HANDLE_RULES,
      inputSchema: { handle: handleArg },
      annotations: READS,
    },
    async ({ handle }) =>
      withEngine(async (e) => {
        const r = await e.read(handle);
        return r.ok
          ? ok(r.text ?? '')
          : fail(`${r.error?.code ?? 'ERROR'}: ${r.error?.message ?? ''}`);
      }),
  );

  server.registerTool(
    'text',
    {
      title: 'Read the page prose',
      description:
        'Return the visible body text of the current page. The outline from `observe` ' +
        'lists controls and headings, not article text — use this when you need what ' +
        'the page actually says. Long pages are truncated and say so.',
      inputSchema: {
        maxChars: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Character cap on the returned text (default 20000)'),
      },
      annotations: READS,
    },
    async ({ maxChars }) =>
      withEngine(async (e) => {
        const opts: { maxChars?: number } = {};
        if (maxChars !== undefined) opts.maxChars = maxChars;
        const r = await e.text(opts);
        if (!r.ok) return fail(`${r.error?.code ?? 'ERROR'}: ${r.error?.message ?? ''}`);
        const body = r.text ?? '';
        return ok(r.truncated === true ? `${body}\n\n[truncated at ${body.length} chars]` : body);
      }),
  );

  server.registerTool(
    'screenshot',
    {
      title: 'Screenshot the page',
      description:
        'Capture the page as a PNG and return it as an image. Useful for confirming ' +
        'which of several identically-labelled controls you want before acting.',
      // Deliberately no `path`: the engine can write a screenshot anywhere on
      // disk, and exposing that over MCP would hand the host model an arbitrary
      // file-write primitive. Local callers use the SDK for that.
      inputSchema: {
        fullPage: z.boolean().optional().describe('Capture the whole scrollable page'),
      },
      annotations: READS,
    },
    async ({ fullPage }) =>
      withEngine(async (e) => {
        const shot = await e.screenshot(fullPage !== undefined ? { fullPage } : {});
        if (!shot.ok || shot.base64 === undefined) {
          return fail(`SCREENSHOT_FAILED: ${shot.error?.message ?? 'no image returned'}`);
        }
        return { content: [{ type: 'image', data: shot.base64, mimeType: 'image/png' }] };
      }),
  );

  // ── navigation ──

  server.registerTool(
    'open',
    {
      title: 'Open a URL',
      description:
        'Navigate to an http(s) URL. Other schemes are rejected. Handles from the ' +
        'previous page stop being valid — call `observe` afterwards.',
      inputSchema: { url: z.string().min(1).describe('An http:// or https:// URL') },
      annotations: { ...WRITES, idempotentHint: true },
    },
    async ({ url }) => withEngine(async (e) => fromEngineResult(await e.open(url))),
  );

  server.registerTool(
    'back',
    {
      title: 'Go back',
      description: 'Go back one entry in history. Handles from the current page stop being valid.',
      inputSchema: {},
      annotations: WRITES,
    },
    async () => withEngine(async (e) => fromEngineResult(await e.back())),
  );

  server.registerTool(
    'forward',
    {
      title: 'Go forward',
      description:
        'Go forward one entry in history. Handles from the current page stop being valid.',
      inputSchema: {},
      annotations: WRITES,
    },
    async () => withEngine(async (e) => fromEngineResult(await e.forward())),
  );

  server.registerTool(
    'wait',
    {
      title: 'Wait for the page',
      description:
        'Wait for a condition before continuing: a URL pattern, an element to resolve, ' +
        'or the network to go idle. Use this instead of retrying a failing action when ' +
        'content is still loading.',
      inputSchema: {
        condition: z
          .discriminatedUnion('type', [
            z.object({ type: z.literal('url'), pattern: z.string() }),
            z.object({ type: z.literal('element'), handle: z.string() }),
            z.object({ type: z.literal('networkIdle') }),
          ])
          .describe('What to wait for'),
        timeoutMs: z.number().int().positive().optional(),
      },
      annotations: READS,
    },
    async ({ condition, timeoutMs }) =>
      withEngine(async (e) => {
        const r = await e.wait(condition, timeoutMs);
        return r.timedOut ? fail('TIMEOUT: condition not met') : ok(JSON.stringify(r));
      }),
  );

  // ── interaction ──

  server.registerTool(
    'click',
    {
      title: 'Click an element',
      description:
        'Click the element a handle refers to. ' + HANDLE_RULES + ' ' + AMBIGUITY_WARNING,
      inputSchema: { handle: handleArg },
      annotations: DESTROYS,
    },
    async ({ handle }) => withEngine(async (e) => fromEngineResult(await e.click(handle))),
  );

  server.registerTool(
    'type',
    {
      title: 'Type into a field',
      description:
        'Replace the contents of a text field. Set `submit` to press Enter afterwards. ' +
        HANDLE_RULES,
      inputSchema: {
        handle: handleArg,
        text: z.string().describe('Text to enter; replaces any existing value'),
        submit: z.boolean().optional().describe('Press Enter after typing'),
      },
      annotations: DESTROYS,
    },
    async ({ handle, text, submit }) =>
      withEngine(async (e) =>
        fromEngineResult(await e.type(handle, text, submit !== undefined ? { submit } : {})),
      ),
  );

  server.registerTool(
    'select',
    {
      title: 'Choose a dropdown option',
      description:
        'Choose an option in a select or combobox by its visible label or value. ' +
        'Use this rather than clicking — clicking a dropdown does not choose anything. ' +
        HANDLE_RULES,
      inputSchema: { handle: handleArg, option: z.string().min(1) },
      annotations: DESTROYS,
    },
    async ({ handle, option }) =>
      withEngine(async (e) => fromEngineResult(await e.select(handle, option))),
  );

  server.registerTool(
    'check',
    {
      title: 'Check or uncheck a box',
      description:
        'Set a checkbox or radio button. Use this rather than clicking, so the resulting ' +
        'state is what you asked for regardless of what it was before. ' +
        HANDLE_RULES,
      inputSchema: {
        handle: handleArg,
        checked: z.boolean().optional().describe('Desired state; defaults to checked'),
      },
      annotations: DESTROYS,
    },
    async ({ handle, checked }) =>
      withEngine(async (e) => fromEngineResult(await e.check(handle, checked ?? true))),
  );

  server.registerTool(
    'press',
    {
      title: 'Press a key',
      description:
        'Send a keyboard key to the page, e.g. "Enter", "Escape", "Tab". Goes to whatever ' +
        'currently has focus, not to a specific element.',
      inputSchema: { key: z.string().min(1).describe('Playwright key name, e.g. "Enter"') },
      annotations: DESTROYS,
    },
    async ({ key }) => withEngine(async (e) => fromEngineResult(await e.press(key))),
  );

  server.registerTool(
    'hover',
    {
      title: 'Hover over an element',
      description:
        'Move the pointer over an element to reveal menus or tooltips that only appear ' +
        'on hover. ' +
        HANDLE_RULES,
      inputSchema: { handle: handleArg },
      annotations: WRITES,
    },
    async ({ handle }) => withEngine(async (e) => fromEngineResult(await e.hover(handle))),
  );

  server.registerTool(
    'scroll',
    {
      title: 'Scroll the page',
      description:
        'Scroll up or down, or bring a specific element into view. Content below the fold ' +
        'may be missing from `observe` until you scroll to it, so scroll before concluding ' +
        'something is absent.',
      inputSchema: {
        target: z
          .string()
          .default('down')
          .describe('"up", "down", or an element handle to scroll into view'),
        distance: z.number().int().optional().describe('Pixels; defaults to 300'),
      },
      annotations: WRITES,
    },
    async ({ target, distance }) =>
      withEngine(async (e) => fromEngineResult(await e.scroll(target, distance))),
  );

  // ── tabs ──

  server.registerTool(
    'tabs_list',
    {
      title: 'List tabs',
      description: 'List open tabs with their ids, URLs and titles.',
      inputSchema: {},
      annotations: READS,
    },
    async () => withEngine(async (e) => ok(JSON.stringify(await e.tabs.list(), null, 2))),
  );

  server.registerTool(
    'tabs_new',
    {
      title: 'Open a new tab',
      description: 'Open a new tab, optionally navigating it to a URL. Returns the new tab id.',
      inputSchema: { url: z.string().optional() },
      annotations: WRITES,
    },
    async ({ url }) => withEngine(async (e) => ok(JSON.stringify(await e.tabs.new(url)))),
  );

  server.registerTool(
    'tabs_switch',
    {
      title: 'Switch tab',
      description:
        'Make another tab active. Handles belong to the page that produced them, so call ' +
        '`observe` after switching.',
      inputSchema: { tabId: z.string().min(1) },
      annotations: { ...WRITES, idempotentHint: true },
    },
    async ({ tabId }) => withEngine(async (e) => ok(JSON.stringify(await e.tabs.switch(tabId)))),
  );

  server.registerTool(
    'tabs_close',
    {
      title: 'Close a tab',
      description: 'Close a tab by id, or the last one if no id is given.',
      inputSchema: { tabId: z.string().optional() },
      annotations: DESTROYS,
    },
    async ({ tabId }) => withEngine(async (e) => ok(JSON.stringify(await e.tabs.close(tabId)))),
  );

  // Release the browser when the host disconnects, not just on an explicit close.
  server.server.onclose = () => void releaseEngine();

  return {
    server,
    async connect(transport: Transport): Promise<void> {
      await server.connect(transport);
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      await releaseEngine();
      await server.close().catch(() => {});
    },
  };
}

/** Give a hung browser this long to close before exiting anyway. */
const SHUTDOWN_GRACE_MS = 5_000;

/** Serve over stdio — the transport hosts use to launch Sepia as a subprocess. */
export async function startMcpServer(opts: McpServerOptions = {}): Promise<SepiaMcpServer> {
  const sepia = createMcpServer(opts);
  await sepia.connect(new StdioServerTransport());

  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    // Never let a wedged browser hold the process open — the host is already
    // gone, and an unreaped Chromium outlives us.
    const grace = new Promise<void>((r) => setTimeout(r, SHUTDOWN_GRACE_MS).unref?.());
    void Promise.race([sepia.close().catch(() => {}), grace]).finally(() => process.exit(0));
  };

  // The MCP stdio shutdown sequence starts by closing the server's stdin and
  // only escalates to signals if that is ignored. SDK 1.29's stdio transport
  // does not surface EOF as a transport close, so listen for it directly:
  // with a browser open the event loop stays alive and the process would
  // otherwise hang until SIGKILL, orphaning the browser.
  process.stdin.on('end', shutdown);
  process.stdin.on('close', shutdown);
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  return sepia;
}
