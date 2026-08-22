import type { Verbosity } from '../types/index.js';

export type { Verbosity };

export type PromptStyle = 'default' | 'minimal';
export type TokenEstimation = 'api' | 'local' | 'auto';

export interface ModelConfig {
  endpoint: string;
  model: string;
  apiKey?: string;
  maxTokensPerStep: number;
  jsonMode?: boolean;
  promptStyle?: PromptStyle;
  tokenEstimation?: TokenEstimation;
}

export interface BrowserConfig {
  executablePath?: string;
  profile: string;
  headless: boolean;
  ephemeral: boolean;
  humanTiming: boolean;
  /** Directory where named persistent profiles are stored. Required when ephemeral=false. */
  profileStorePath?: string;
  /** Cap on each page-settle wait, in ms. Bounds observation cost on never-idle pages. */
  settleTimeoutMs?: number;
}

export interface AgentConfig {
  maxSteps: number;
  maxTokensPerRun: number;
  verbosity: Verbosity;
  retryBackoffMs: number;
  maxRetries: number;
  confidenceThreshold: number;
  maxHistorySteps?: number;
  /**
   * Maximum number of consecutive identical (action, handle) steps on an
   * unchanged page before the run is stopped as a loop (AC-AG10).
   */
  loopThreshold?: number;
}

export interface PrivacyConfig {
  telemetry: boolean;
}

export interface SecurityConfig {
  allowedDomains?: string[];
  robotsAwareness: boolean;
  rateLimitMs?: number;
}

export interface SepiaConfig {
  model: ModelConfig;
  browser: BrowserConfig;
  agent: AgentConfig;
  privacy: PrivacyConfig;
  security: SecurityConfig;
}

export const defaultConfig: SepiaConfig = {
  model: {
    endpoint: 'https://api.anthropic.com/v1',
    model: 'claude-sonnet-4-6',
    maxTokensPerStep: 100_000,
    jsonMode: false,
    promptStyle: 'default',
    tokenEstimation: 'auto',
  },
  browser: {
    // Must match the browser actually bundled with the pinned Playwright, or
    // the profile is internally incoherent — the exact tell it exists to avoid.
    profile: 'chrome-149-linux-x86_64',
    headless: true,
    ephemeral: true,
    humanTiming: false,
    settleTimeoutMs: 1_500,
  },
  agent: {
    maxSteps: 50,
    maxTokensPerRun: 100_000,
    verbosity: 'standard',
    retryBackoffMs: 1_000,
    maxRetries: 3,
    confidenceThreshold: 0.7,
    maxHistorySteps: 10,
    loopThreshold: 3,
  },
  privacy: {
    telemetry: false,
  },
  security: {
    robotsAwareness: false,
  },
};

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? Partial<T[K]> : T[K] };

/**
 * Accepted ranges for numeric settings.
 *
 * Several of these become timer durations or loop bounds, so an unbounded value
 * is a denial of service rather than a mere misconfiguration — a `retryBackoffMs`
 * of 1e9 parks a run for eleven days. Bounds are enforced here, in the single
 * funnel every entry point shares, so the SDK is protected as well as the HTTP
 * API (SR-12).
 */
export const CONFIG_BOUNDS = {
  maxSteps: { min: 1, max: 200 },
  maxTokensPerRun: { min: 1, max: 10_000_000 },
  maxTokensPerStep: { min: 1, max: 10_000_000 },
  retryBackoffMs: { min: 0, max: 30_000 },
  maxRetries: { min: 0, max: 10 },
  confidenceThreshold: { min: 0, max: 1 },
  maxHistorySteps: { min: 1, max: 100 },
  loopThreshold: { min: 2, max: 20 },
  settleTimeoutMs: { min: 0, max: 30_000 },
  rateLimitMs: { min: 0, max: 60_000 },
} as const;

/** Clamp into range; fall back to `fallback` when the value is not a finite number. */
function bounded(
  value: number | undefined,
  bounds: { min: number; max: number },
  fallback: number,
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  if (value < bounds.min) return bounds.min;
  if (value > bounds.max) return bounds.max;
  return value;
}

export function mergeConfig(overrides: DeepPartial<SepiaConfig>): SepiaConfig {
  const model = { ...defaultConfig.model, ...overrides.model };
  const browser = { ...defaultConfig.browser, ...overrides.browser };
  const agent = { ...defaultConfig.agent, ...overrides.agent };
  const security = { ...defaultConfig.security, ...overrides.security };

  model.maxTokensPerStep = bounded(
    model.maxTokensPerStep,
    CONFIG_BOUNDS.maxTokensPerStep,
    defaultConfig.model.maxTokensPerStep,
  );

  agent.maxSteps = bounded(agent.maxSteps, CONFIG_BOUNDS.maxSteps, defaultConfig.agent.maxSteps);
  agent.maxTokensPerRun = bounded(
    agent.maxTokensPerRun,
    CONFIG_BOUNDS.maxTokensPerRun,
    defaultConfig.agent.maxTokensPerRun,
  );
  agent.retryBackoffMs = bounded(
    agent.retryBackoffMs,
    CONFIG_BOUNDS.retryBackoffMs,
    defaultConfig.agent.retryBackoffMs,
  );
  agent.maxRetries = bounded(
    agent.maxRetries,
    CONFIG_BOUNDS.maxRetries,
    defaultConfig.agent.maxRetries,
  );
  agent.confidenceThreshold = bounded(
    agent.confidenceThreshold,
    CONFIG_BOUNDS.confidenceThreshold,
    defaultConfig.agent.confidenceThreshold,
  );
  if (agent.maxHistorySteps !== undefined) {
    agent.maxHistorySteps = bounded(
      agent.maxHistorySteps,
      CONFIG_BOUNDS.maxHistorySteps,
      defaultConfig.agent.maxHistorySteps ?? 10,
    );
  }
  if (agent.loopThreshold !== undefined) {
    // AC-AG10: undefined disables loop detection entirely; otherwise clamp to bounds.
    agent.loopThreshold = bounded(
      agent.loopThreshold,
      CONFIG_BOUNDS.loopThreshold,
      defaultConfig.agent.loopThreshold ?? 3,
    );
  }

  if (browser.settleTimeoutMs !== undefined) {
    browser.settleTimeoutMs = bounded(
      browser.settleTimeoutMs,
      CONFIG_BOUNDS.settleTimeoutMs,
      defaultConfig.browser.settleTimeoutMs ?? 1_500,
    );
  }
  if (security.rateLimitMs !== undefined) {
    security.rateLimitMs = bounded(security.rateLimitMs, CONFIG_BOUNDS.rateLimitMs, 0);
  }

  return {
    model,
    browser,
    agent,
    privacy: { ...defaultConfig.privacy, ...overrides.privacy },
    security,
  };
}
