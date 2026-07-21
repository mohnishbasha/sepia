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
}

export interface AgentConfig {
  maxSteps: number;
  maxTokensPerRun: number;
  verbosity: Verbosity;
  retryBackoffMs: number;
  maxRetries: number;
  confidenceThreshold: number;
  maxHistorySteps?: number;
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
    profile: 'chrome-130-linux-x86_64',
    headless: true,
    ephemeral: true,
    humanTiming: false,
  },
  agent: {
    maxSteps: 50,
    maxTokensPerRun: 100_000,
    verbosity: 'standard',
    retryBackoffMs: 1_000,
    maxRetries: 3,
    confidenceThreshold: 0.7,
    maxHistorySteps: 10,
  },
  privacy: {
    telemetry: false,
  },
  security: {
    robotsAwareness: false,
  },
};

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? Partial<T[K]> : T[K] };

export function mergeConfig(overrides: DeepPartial<SepiaConfig>): SepiaConfig {
  return {
    model: { ...defaultConfig.model, ...overrides.model },
    browser: { ...defaultConfig.browser, ...overrides.browser },
    agent: { ...defaultConfig.agent, ...overrides.agent },
    privacy: { ...defaultConfig.privacy, ...overrides.privacy },
    security: { ...defaultConfig.security, ...overrides.security },
  };
}
