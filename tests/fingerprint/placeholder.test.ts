// Playwright Chromium is installed by `make setup`.
// If tests fail with 'Executable doesn't exist', run: pnpm playwright install chromium

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium } from 'playwright';
import type { Browser, Page } from 'playwright';
import {
  getPreset,
  validateCoherence,
  validateAndStart,
  PRESETS,
} from '../../fingerprint/index.js';
import type { CoherenceCheckResult } from '../../fingerprint/index.js';

// ── Unit tests (no browser) ───────────────────────────────────────────────────

describe('fingerprint — unit tests (no browser)', () => {
  it('PRESETS has at least one entry', () => {
    expect(Object.keys(PRESETS).length).toBeGreaterThanOrEqual(1);
  });

  it('getPreset returns correct preset with jsProbes', () => {
    const preset = getPreset('chrome-130-linux-x86_64');
    expect(preset.id).toBe('chrome-130-linux-x86_64');
    expect(preset.chromeVersion).toBe('130.0.6723.91');
    expect(preset.vendor).toBe('Google Inc.');
    expect(preset.jsProbes).toBeDefined();
    expect(typeof preset.jsProbes).toBe('object');
    expect(preset.jsProbes['typeof navigator.webdriver']).toBe('undefined');
    expect(preset.jsProbes['navigator.vendor']).toBe('Google Inc.');
    expect(preset.jsProbes['window.chrome !== undefined']).toBe('true');
  });

  it('getPreset throws for unknown preset id', () => {
    expect(() => getPreset('unknown-preset-id')).toThrowError(/Unknown fingerprint preset/);
  });

  it('CoherenceCheckResult structure is correct with a mock', () => {
    const result: CoherenceCheckResult = {
      passed: true,
      checks: [
        { name: 'typeof navigator.webdriver', passed: true },
        { name: 'navigator.vendor', passed: true },
      ],
    };
    expect(result.passed).toBe(true);
    expect(result.checks).toHaveLength(2);
    expect(result.checks[0]?.name).toBe('typeof navigator.webdriver');
    expect(result.checks[0]?.passed).toBe(true);
    expect(result.checks[1]?.name).toBe('navigator.vendor');
  });
});

// ── Browser tests (AC-F3, AC-F4, AC-F5) ─────────────────────────────────────
//
// These tests launch a Playwright Chromium browser with anti-detection init
// scripts applied — matching how the sepia engine sets up a browser context
// with the fingerprint preset active (FR-35, FR-37).

describe('fingerprint — browser tests', () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    // Apply the anti-detection init scripts that the sepia engine normally
    // applies when booting a session with a fingerprint preset:
    //   • Remove navigator.webdriver (FR-35)
    //   • Inject window.chrome runtime object (FR-35)
    const context = await browser.newContext();
    // Mask navigator.webdriver and inject window.chrome via a script string.
    // Using a string avoids DOM-lib dependency in the Node.js tsconfig.
    await context.addInitScript(`
      Object.defineProperty(navigator, 'webdriver', {
        get: () => undefined,
        configurable: true,
      });
      window['chrome'] = { runtime: {} };
    `);
    page = await context.newPage();
    await page.goto('about:blank');
  }, 60_000);

  afterAll(async () => {
    await browser.close();
  }, 30_000);

  // AC-F1: requires patched Chromium (make chromium-build)
  it.todo('JA3 fingerprint matches Chrome 130 — requires patched Chromium (make chromium-build)');

  // AC-F2: requires patched Chromium (make chromium-build)
  it.todo('JA4 fingerprint matches Chrome 130 — requires patched Chromium (make chromium-build)');

  // AC-F3: navigator.webdriver is undefined in a sepia-configured browser context
  it('AC-F3: navigator.webdriver probe passes in sepia-configured browser', async () => {
    const preset = getPreset('chrome-149-linux-x86_64');
    const result = await validateCoherence(preset, page);

    const webdriverCheck = result.checks.find((c) => c.name === 'typeof navigator.webdriver');
    expect(webdriverCheck).toBeDefined();
    expect(webdriverCheck?.passed).toBe(true);
  }, 30_000);

  // AC-F4: full cross-signal coherence — all non-JA3/JA4 checks pass
  it('AC-F4: all non-JA3/JA4 coherence checks pass', async () => {
    const preset = getPreset('chrome-149-linux-x86_64');
    const result = await validateCoherence(preset, page);

    // Top-level passed field must be true (all non-TLS checks pass)
    expect(result.passed).toBe(true);

    // Each non-TLS check must individually pass
    const nonTlsChecks = result.checks.filter(
      (c) => !c.name.includes('JA3') && !c.name.includes('JA4'),
    );
    for (const check of nonTlsChecks) {
      expect(check.passed, `Probe "${check.name}" failed: ${check.details ?? ''}`).toBe(true);
    }

    // JA3/JA4 checks are present but informational (no patched binary in CI)
    const tlsChecks = result.checks.filter((c) => c.name.includes('JA3') || c.name.includes('JA4'));
    expect(tlsChecks.length).toBeGreaterThanOrEqual(2);
    for (const check of tlsChecks) {
      expect(check.details).toMatch(/patched Chromium/i);
    }
  }, 30_000);

  // AC-F5: session fails to start if any coherence check fails
  it('AC-F5: validateAndStart throws when a probe has wrong expected value', async () => {
    // Create a modified copy with a wrong expected value for navigator.vendor
    const badPreset = {
      ...getPreset('chrome-149-linux-x86_64'),
      jsProbes: {
        ...getPreset('chrome-149-linux-x86_64').jsProbes,
        'navigator.vendor': 'Wrong Inc.',
      },
    };

    await expect(validateAndStart(badPreset, page)).rejects.toThrowError(
      /Fingerprint coherence failed/,
    );
    await expect(validateAndStart(badPreset, page)).rejects.toThrowError(/navigator\.vendor/);
  }, 30_000);
});
