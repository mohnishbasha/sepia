/**
 * SR-12 — caller-supplied numeric config is bounded, and internal errors are
 * not echoed back.
 *
 * Found by CodeQL on PR #2:
 *   - js/resource-exhaustion (high): `setTimeout(r, config.agent.retryBackoffMs)`
 *     runs with a duration an HTTP caller controls. SR-11 allowlisted
 *     `retryBackoffMs` without bounding it, so a single authenticated request
 *     could pin a concurrency slot for days.
 *   - js/stack-trace-exposure (medium): the 500 handler returned `String(err)`
 *     to the caller.
 */

import { describe, it, expect } from 'vitest';
import { sanitizeRunConfig } from '../../interfaces/http/index.js';

describe('SR-12 — numeric config is clamped to sane bounds', () => {
  it('clamps an absurd retryBackoffMs', () => {
    const clean = sanitizeRunConfig({ agent: { retryBackoffMs: 999_999_999 } });
    expect(clean.agent?.retryBackoffMs).toBeLessThanOrEqual(30_000);
  });

  it('clamps a negative retryBackoffMs to zero', () => {
    const clean = sanitizeRunConfig({ agent: { retryBackoffMs: -5 } });
    expect(clean.agent?.retryBackoffMs).toBe(0);
  });

  it('clamps maxSteps', () => {
    expect(
      sanitizeRunConfig({ agent: { maxSteps: 10_000_000 } }).agent?.maxSteps,
    ).toBeLessThanOrEqual(200);
    expect(sanitizeRunConfig({ agent: { maxSteps: 0 } }).agent?.maxSteps).toBeGreaterThanOrEqual(1);
  });

  it('clamps maxRetries', () => {
    expect(sanitizeRunConfig({ agent: { maxRetries: 500 } }).agent?.maxRetries).toBeLessThanOrEqual(
      10,
    );
  });

  it('clamps confidenceThreshold into 0..1', () => {
    expect(
      sanitizeRunConfig({ agent: { confidenceThreshold: 50 } }).agent?.confidenceThreshold,
    ).toBeLessThanOrEqual(1);
    expect(
      sanitizeRunConfig({ agent: { confidenceThreshold: -3 } }).agent?.confidenceThreshold,
    ).toBeGreaterThanOrEqual(0);
  });

  it('clamps settleTimeoutMs', () => {
    expect(
      sanitizeRunConfig({ browser: { settleTimeoutMs: 999_999_999 } }).browser?.settleTimeoutMs,
    ).toBeLessThanOrEqual(30_000);
  });

  it('clamps security.rateLimitMs', () => {
    expect(
      sanitizeRunConfig({ security: { rateLimitMs: 999_999_999 } }).security?.rateLimitMs,
    ).toBeLessThanOrEqual(60_000);
  });

  it('drops non-numeric values entirely rather than passing them through', () => {
    const clean = sanitizeRunConfig({ agent: { maxSteps: 'lots', retryBackoffMs: null } });
    expect(clean.agent?.maxSteps).toBeUndefined();
    expect(clean.agent?.retryBackoffMs).toBeUndefined();
  });

  it('drops NaN and Infinity', () => {
    const clean = sanitizeRunConfig({ agent: { maxSteps: NaN, maxTokensPerRun: Infinity } });
    expect(clean.agent?.maxSteps).toBeUndefined();
    expect(clean.agent?.maxTokensPerRun).toBeUndefined();
  });

  it('leaves a sensible value untouched', () => {
    expect(sanitizeRunConfig({ agent: { maxSteps: 12, retryBackoffMs: 500 } }).agent).toMatchObject(
      {
        maxSteps: 12,
        retryBackoffMs: 500,
      },
    );
  });

  it('still rejects a non-enum verbosity', () => {
    expect(sanitizeRunConfig({ agent: { verbosity: 'shouty' } }).agent?.verbosity).toBeUndefined();
  });
});
