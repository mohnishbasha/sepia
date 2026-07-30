import { createEngine } from '../../engine/index.js';
import type { EngineOptions } from '../../engine/index.js';
import { createAgent as createAgentImpl } from '../../agent/index.js';
import { dispatchBatch, parseBatch } from '../../actions/index.js';
import type { BatchResult, TypedAction } from '../../actions/index.js';
import type { SepiaConfig } from '../../config/index.js';
import type {
  CompactView,
  ActionResult,
  ReadResult,
  WaitResult,
  TabInfo,
  WaitConditionType,
  Verbosity,
  ScreenshotResult,
  TextResult,
} from '../../types/index.js';
import type { RunTrace } from '../../agent/index.js';

export { mergeConfig } from '../../config/index.js';

export type { BatchResult, TypedAction };

export type {
  SepiaConfig,
  CompactView,
  ActionResult,
  ReadResult,
  WaitResult,
  TabInfo,
  RunTrace,
  WaitConditionType,
  Verbosity,
  ScreenshotResult,
  TextResult,
};

export interface SepiaSession {
  observe: (opts?: { verbosity?: Verbosity }) => Promise<CompactView>;
  click: (handle: string) => Promise<ActionResult>;
  type: (handle: string, text: string, opts?: { submit?: boolean }) => Promise<ActionResult>;
  select: (handle: string, option: string) => Promise<ActionResult>;
  check: (handle: string, checked: boolean) => Promise<ActionResult>;
  hover: (handle: string) => Promise<ActionResult>;
  scroll: (target: 'up' | 'down' | string, distance?: number) => Promise<ActionResult>;
  press: (key: string) => Promise<ActionResult>;
  read: (handle: string) => Promise<ReadResult>;
  text: (opts?: { maxChars?: number }) => Promise<TextResult>;
  /**
   * Run a plan of handle-based steps without a model call per step (#29). Each
   * step still passes the confidence gate, so a page that shifts mid-plan fails
   * closed on the affected step.
   */
  batch: (steps: unknown, opts?: { continueOnError?: boolean }) => Promise<BatchResult>;
  screenshot: (opts?: { path?: string; fullPage?: boolean }) => Promise<ScreenshotResult>;
  wait: (condition: WaitConditionType, timeoutMs?: number) => Promise<WaitResult>;
  open: (url: string) => Promise<ActionResult>;
  back: () => Promise<ActionResult>;
  forward: () => Promise<ActionResult>;
  tabs: {
    new: (url?: string) => Promise<{ ok: boolean; tabId?: string }>;
    close: (id?: string) => Promise<{ ok: boolean }>;
    list: () => Promise<TabInfo[]>;
    switch: (id: string) => Promise<{ ok: boolean }>;
  };
  close: () => Promise<void>;
}

export interface SepiaAgent {
  run: (goal: string) => Promise<RunTrace>;
}

// SDK factory functions — Phase 2 M3
export async function createSession(config: SepiaConfig): Promise<SepiaSession> {
  const engineOpts: EngineOptions = {
    headless: config.browser.headless,
    confidenceThreshold: config.agent.confidenceThreshold,
    profile: config.browser.profile,
    ...(config.browser.settleTimeoutMs !== undefined
      ? { settleTimeoutMs: config.browser.settleTimeoutMs }
      : {}),
  };
  if (config.security.allowedDomains !== undefined) {
    engineOpts.security = { allowedDomains: config.security.allowedDomains };
  }
  if (config.browser.executablePath !== undefined) {
    engineOpts.executablePath = config.browser.executablePath;
  }
  const engine = await createEngine(engineOpts);

  return {
    observe: (opts) => engine.observe(opts),
    click: (handle) => engine.click(handle),
    type: (handle, text, opts) => engine.type(handle, text, opts),
    select: (handle, option) => engine.select(handle, option),
    check: (handle, checked) => engine.check(handle, checked),
    hover: (handle) => engine.hover(handle),
    scroll: (target, distance) => engine.scroll(target, distance),
    press: (key) => engine.press(key),
    read: (handle) => engine.read(handle),
    text: (textOpts) => engine.text(textOpts),
    batch: (steps, batchOpts) => dispatchBatch(parseBatch(steps), engine, batchOpts),
    screenshot: (shotOpts) => engine.screenshot(shotOpts),
    wait: (condition, timeoutMs) => engine.wait(condition, timeoutMs),
    open: (url) => engine.open(url),
    back: () => engine.back(),
    forward: () => engine.forward(),
    tabs: engine.tabs,
    close: () => engine.close(),
  };
}

export function createAgent(config: SepiaConfig): SepiaAgent {
  return createAgentImpl(config);
}
