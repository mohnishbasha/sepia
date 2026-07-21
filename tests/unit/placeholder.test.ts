import { describe, it, expect } from 'vitest';
import { defaultConfig } from '../../config/index.js';
import { createHandleMap } from '../../resolver/index.js';
import { redactSecrets } from '../../privacy/index.js';
import { createLogger } from '../../telemetry/index.js';
import { isValidActionName } from '../../actions/index.js';
import { getPreset } from '../../fingerprint/index.js';
import { mergeConfig } from '../../config/index.js';

describe('config', () => {
  it('defaultConfig has correct defaults', () => {
    expect(defaultConfig.agent.maxSteps).toBe(50);
    expect(defaultConfig.browser.ephemeral).toBe(true);
    expect(defaultConfig.privacy.telemetry).toBe(false);
  });

  it('mergeConfig overrides fields', () => {
    const cfg = mergeConfig({ agent: { maxSteps: 10, maxTokensPerRun: 50_000, verbosity: 'minimal', retryBackoffMs: 500, maxRetries: 1, confidenceThreshold: 0.5 } });
    expect(cfg.agent.maxSteps).toBe(10);
    expect(cfg.browser.headless).toBe(true);
  });
});

describe('resolver', () => {
  it('createHandleMap returns empty map', () => {
    const map = createHandleMap();
    expect(map.size).toBe(0);
  });
});

describe('privacy', () => {
  it('redactSecrets replaces password fields', () => {
    const input = '{"password": "hunter2", "user": "alice"}';
    const result = redactSecrets(input);
    expect(result.redacted).not.toContain('hunter2');
    expect(result.redacted).toContain('[REDACTED]');
  });

  it('redactSecrets does not modify unrelated text', () => {
    const input = '{"user": "alice", "email": "alice@example.com"}';
    const result = redactSecrets(input);
    expect(result.redacted).toBe(input);
    expect(result.count).toBe(0);
  });
});

describe('telemetry', () => {
  it('createLogger returns no-op when disabled', () => {
    const logger = createLogger({ enabled: false });
    expect(() => logger.info('test')).not.toThrow();
    expect(() => logger.step({ timestamp: 0, sessionId: 's', runId: 'r', stepN: 1, action: 'click', confidence: 1, tokensUsed: 0, latencyMs: 0, ok: true })).not.toThrow();
  });
});

describe('actions', () => {
  it('isValidActionName accepts valid names', () => {
    expect(isValidActionName('click')).toBe(true);
    expect(isValidActionName('type')).toBe(true);
    expect(isValidActionName('observe')).toBe(true);
  });

  it('isValidActionName rejects invalid names', () => {
    expect(isValidActionName('eval')).toBe(false);
    expect(isValidActionName('executeScript')).toBe(false);
    expect(isValidActionName('')).toBe(false);
  });
});

describe('fingerprint', () => {
  it('getPreset returns chrome-130-linux-x86_64', () => {
    const preset = getPreset('chrome-130-linux-x86_64');
    expect(preset.os).toBe('linux');
    expect(preset.chromeVersion).toMatch(/^130\./);
  });

  it('getPreset throws on unknown preset', () => {
    expect(() => getPreset('unknown-preset')).toThrow(/Unknown fingerprint preset/);
  });
});
