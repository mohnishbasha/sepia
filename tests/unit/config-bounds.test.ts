/**
 * SR-12 — config is bounded wherever it is built, not just at the HTTP edge.
 *
 * `sanitizeRunConfig()` protects the HTTP path, but an SDK caller doing
 * `createAgent({ agent: { retryBackoffMs: 1e9 } })` bypasses it entirely and
 * gets the same hang. mergeConfig is the one funnel every entry point shares.
 */

import { describe, it, expect } from 'vitest';
import { mergeConfig, defaultConfig, CONFIG_BOUNDS } from '../../config/index.js';

describe('SR-12 — mergeConfig clamps hostile numbers', () => {
  it('clamps a retryBackoffMs that would hang the run for days', () => {
    const cfg = mergeConfig({ agent: { ...defaultConfig.agent, retryBackoffMs: 1_000_000_000 } });
    expect(cfg.agent.retryBackoffMs).toBe(CONFIG_BOUNDS.retryBackoffMs.max);
  });

  it('clamps negatives up to the minimum', () => {
    const cfg = mergeConfig({ agent: { ...defaultConfig.agent, retryBackoffMs: -1 } });
    expect(cfg.agent.retryBackoffMs).toBe(0);
  });

  it('clamps maxSteps and maxRetries', () => {
    const cfg = mergeConfig({
      agent: { ...defaultConfig.agent, maxSteps: 1_000_000, maxRetries: 9_999 },
    });
    expect(cfg.agent.maxSteps).toBe(CONFIG_BOUNDS.maxSteps.max);
    expect(cfg.agent.maxRetries).toBe(CONFIG_BOUNDS.maxRetries.max);
  });

  it('clamps confidenceThreshold into 0..1', () => {
    expect(
      mergeConfig({ agent: { ...defaultConfig.agent, confidenceThreshold: 42 } }).agent
        .confidenceThreshold,
    ).toBe(1);
    expect(
      mergeConfig({ agent: { ...defaultConfig.agent, confidenceThreshold: -42 } }).agent
        .confidenceThreshold,
    ).toBe(0);
  });

  it('clamps browser.settleTimeoutMs', () => {
    const cfg = mergeConfig({
      browser: { ...defaultConfig.browser, settleTimeoutMs: 1_000_000_000 },
    });
    expect(cfg.browser.settleTimeoutMs).toBe(CONFIG_BOUNDS.settleTimeoutMs.max);
  });

  it('replaces a non-finite value with the default', () => {
    const cfg = mergeConfig({ agent: { ...defaultConfig.agent, retryBackoffMs: NaN } });
    expect(cfg.agent.retryBackoffMs).toBe(defaultConfig.agent.retryBackoffMs);
  });

  it('leaves sensible values exactly as given', () => {
    const cfg = mergeConfig({
      agent: { ...defaultConfig.agent, maxSteps: 12, retryBackoffMs: 750 },
    });
    expect(cfg.agent.maxSteps).toBe(12);
    expect(cfg.agent.retryBackoffMs).toBe(750);
  });

  it('the defaults are themselves within bounds', () => {
    const cfg = mergeConfig({});
    expect(cfg.agent).toEqual(defaultConfig.agent);
  });
});
