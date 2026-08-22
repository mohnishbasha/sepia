/**
 * AC-I2..AC-I6 — the CLI can run headed.
 *
 * Issue #15: `browser.headless` defaulted to true and nothing on the `run`
 * path could change it — `runCommand` never touched the browser config block
 * while the HTTP allowlist did. These tests pin the precedence chain
 * (`--headed` > `SEPIA_HEADLESS` > configured default), the accepted env
 * grammar, and the loud failure on unusable values, at both levels:
 * the pure resolver and the wiring into the merged config handed to
 * `createAgent()`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const createAgent = vi.hoisted(() => vi.fn());
vi.mock('../../agent/index.js', () => ({ createAgent }));

const startServer = vi.hoisted(() => vi.fn());
vi.mock('../../interfaces/http/index.js', () => ({ startServer }));

const startMcpServer = vi.hoisted(() => vi.fn());
vi.mock('../../interfaces/mcp/index.js', () => ({ startMcpServer }));

import { mcpCommand, runCommand } from '../../cli/commands.js';
import { HEADLESS_ENV_VAR, parseHeadlessEnv, resolveHeadless } from '../../cli/headless.js';
import type { SepiaConfig } from '../../config/index.js';

class ExitError extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${String(code)})`);
  }
}

/** Run `runCommand`, tolerating its terminal process.exit, and return the config passed to createAgent(). */
async function runAndCapture(args: string[]): Promise<SepiaConfig> {
  await runCommand(args).catch(() => undefined);
  const call = createAgent.mock.calls.at(-1) as [SepiaConfig] | undefined;
  if (call === undefined) throw new Error('createAgent was not called');
  return call[0];
}

describe('SEPIA_HEADLESS grammar (parseHeadlessEnv)', () => {
  it.each([
    ['true', true],
    ['1', true],
    ['false', false],
    ['0', false],
    [undefined, undefined],
    ['', undefined],
  ] as const)('parses %j as %j', (raw, expected) => {
    expect(parseHeadlessEnv(raw)).toBe(expected);
  });

  it('rejects anything else loudly, including case variants and whitespace', () => {
    for (const bad of ['yes', 'False', 'TRUE', ' off ', '2', 'flase']) {
      expect(() => parseHeadlessEnv(bad)).toThrowError(new RegExp(`invalid ${HEADLESS_ENV_VAR}`));
    }
  });
});

describe('resolveHeadless precedence', () => {
  it('the --headed flag wins over any env value', () => {
    expect(resolveHeadless(true, 'true')).toBe(false);
    expect(resolveHeadless(true, '0')).toBe(false);
    expect(resolveHeadless(true, undefined)).toBe(false);
  });

  it('without the flag, the env value decides; with neither, the default stands', () => {
    expect(resolveHeadless(false, 'false')).toBe(false);
    expect(resolveHeadless(false, 'true')).toBe(true);
    expect(resolveHeadless(false, undefined)).toBeUndefined();
  });
});

describe('runCommand threads the override into browser.headless', () => {
  let stderrText = '';

  beforeEach(() => {
    createAgent.mockReset().mockImplementation(() => ({
      run: async () => ({ outcome: 'success', answer: 'ok' }),
    }));
    process.env['SEPIA_API_KEY'] = 'test-key';
    delete process.env[HEADLESS_ENV_VAR];
    vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
      stderrText += String(chunk);
      return true;
    }) as typeof process.stderr.write);
    // Vitest replaces process.exit with a failing stub by default; take it
    // over so exit codes are observable as thrown sentinels.
    vi.spyOn(process, 'exit').mockImplementation((code?: number | string | null) => {
      throw new ExitError(code === null || code === undefined ? undefined : Number(code));
    });
  });

  it('AC-I2: an explicit --headed flag forces headed mode', async () => {
    const config = await runAndCapture(['goal', '--headed']);
    expect(config.browser.headless).toBe(false);
  });

  it('AC-I3: SEPIA_HEADLESS=false or 0 alone runs headed', async () => {
    for (const value of ['false', '0']) {
      process.env[HEADLESS_ENV_VAR] = value;
      const config = await runAndCapture(['goal']);
      expect(config.browser.headless).toBe(false);
    }
  });

  it('AC-I3: SEPIA_HEADLESS=true or 1 alone stays headless', async () => {
    for (const value of ['true', '1']) {
      process.env[HEADLESS_ENV_VAR] = value;
      const config = await runAndCapture(['goal']);
      expect(config.browser.headless).toBe(true);
    }
  });

  it('AC-I4: the flag beats a contradicting SEPIA_HEADLESS', async () => {
    for (const value of ['true', '1']) {
      process.env[HEADLESS_ENV_VAR] = value;
      const config = await runAndCapture(['goal', '--headed']);
      expect(config.browser.headless).toBe(false);
    }
  });

  it('AC-I5: with neither flag nor env var, the configured default (headless) stands', async () => {
    const config = await runAndCapture(['goal']);
    expect(config.browser.headless).toBe(true);
  });

  it('AC-I5: an empty SEPIA_HEADLESS counts as unset', async () => {
    process.env[HEADLESS_ENV_VAR] = '';
    const config = await runAndCapture(['goal']);
    expect(config.browser.headless).toBe(true);
  });

  it('AC-I6: a nonsense SEPIA_HEADLESS value exits 2 with a diagnostic and never starts a run', async () => {
    process.env[HEADLESS_ENV_VAR] = 'flase';
    await expect(runCommand(['goal'])).rejects.toThrowError(ExitError);
    expect(createAgent).not.toHaveBeenCalled();
  });

  it('the diagnostic names the variable and every accepted value', async () => {
    process.env[HEADLESS_ENV_VAR] = 'maybe';
    await expect(runCommand(['goal'])).rejects.toThrowError(ExitError);

    expect(stderrText).toContain(HEADLESS_ENV_VAR);
    expect(stderrText).toContain('"true", "1", "false", "0"');
    expect(createAgent).not.toHaveBeenCalled();
  });
});

describe('mcpCommand shares the same rule', () => {
  beforeEach(() => {
    startMcpServer.mockReset().mockResolvedValue(undefined);
    delete process.env[HEADLESS_ENV_VAR];
    delete process.env['SEPIA_BROWSER_PATH'];
    vi.spyOn(process.stderr, 'write').mockImplementation(
      (() => true) as typeof process.stderr.write,
    );
    vi.spyOn(process, 'exit').mockImplementation((code?: number | string | null) => {
      throw new ExitError(code === null || code === undefined ? undefined : Number(code));
    });
  });

  it('unset SEPIA_HEADLESS keeps the engine headless', async () => {
    await mcpCommand();
    expect(startMcpServer).toHaveBeenCalledWith(
      expect.objectContaining({ engine: expect.objectContaining({ headless: true }) }),
    );
  });

  it('SEPIA_HEADLESS=false shows the window, as documented', async () => {
    process.env[HEADLESS_ENV_VAR] = 'false';
    await mcpCommand();
    expect(startMcpServer).toHaveBeenCalledWith(
      expect.objectContaining({ engine: expect.objectContaining({ headless: false }) }),
    );
  });

  it('a nonsense value fails loudly instead of silently running headless', async () => {
    process.env[HEADLESS_ENV_VAR] = 'nope';
    await expect(mcpCommand()).rejects.toThrowError(ExitError);
    expect(startMcpServer).not.toHaveBeenCalled();
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env[HEADLESS_ENV_VAR];
  delete process.env['SEPIA_API_KEY'];
});
