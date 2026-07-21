export interface ProfilePreset {
  id: string;
  chromeVersion: string;
  os: string;
  arch: string;
  userAgent: string;
  acceptLanguage: string;
  platform: string;
  vendor: string;
  screenWidth: number;
  screenHeight: number;
  deviceScaleFactor: number;
  timezone: string;
  locale: string;
  jsProbes: Record<string, string>; // JS expression → expected value
  expectedJA3?: string; // JA3 hash (only available with patched binary)
  expectedJA4?: string; // JA4 hash (only available with patched binary)
}

export interface CoherenceCheckResult {
  passed: boolean;
  checks: CoherenceCheck[];
}

export interface CoherenceCheck {
  name: string;
  passed: boolean;
  details?: string;
}

// Chrome 130 JA3: 8a2e744cd10f7327e9f8571a15614ebe (approximate — varies by cipher negotiation)
// Chrome 130 JA4: t13d1516h2_8daaf6152771_b0da82dd1658 (approximate)
// JA3/JA4 values require a patched Chromium binary (make chromium-build). Not set in PRESETS.

// Built-in profile presets — Phase 2 M4
export const PRESETS: Record<string, ProfilePreset> = {
  'chrome-130-linux-x86_64': {
    id: 'chrome-130-linux-x86_64',
    chromeVersion: '130.0.6723.91',
    os: 'linux',
    arch: 'x86_64',
    userAgent:
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    acceptLanguage: 'en-US,en;q=0.9',
    platform: 'Linux x86_64',
    vendor: 'Google Inc.',
    screenWidth: 1920,
    screenHeight: 1080,
    deviceScaleFactor: 1,
    timezone: 'America/New_York',
    locale: 'en-US',
    jsProbes: {
      'typeof navigator.webdriver': 'undefined',
      'navigator.vendor': 'Google Inc.',
      'window.chrome !== undefined': 'true',
    },
    // expectedJA3 and expectedJA4 are intentionally omitted — requires patched Chromium
  },

  // Matches the Playwright 1.61.x headless shell (Chrome 149, build 1228)
  'chrome-149-linux-x86_64': {
    id: 'chrome-149-linux-x86_64',
    chromeVersion: '149.0.7827.55',
    os: 'linux',
    arch: 'x86_64',
    userAgent:
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
    acceptLanguage: 'en-US,en;q=0.9',
    platform: 'Linux x86_64',
    vendor: 'Google Inc.',
    screenWidth: 1920,
    screenHeight: 1080,
    deviceScaleFactor: 1,
    timezone: 'America/New_York',
    locale: 'en-US',
    jsProbes: {
      'typeof navigator.webdriver': 'undefined',
      'navigator.vendor': 'Google Inc.',
      'window.chrome !== undefined': 'true',
    },
    // expectedJA3 and expectedJA4 are intentionally omitted — requires patched Chromium
  },
};

export function getPreset(id: string): ProfilePreset {
  const preset = PRESETS[id];
  if (!preset) {
    throw new Error(
      `Unknown fingerprint preset: ${id}. Available: ${Object.keys(PRESETS).join(', ')}`,
    );
  }
  return preset;
}

// Minimal Playwright Page interface — typed as unknown at call sites to avoid upward dep
interface MinimalPage {
  evaluate: (fn: string) => Promise<unknown>;
}

// Coherence validation harness — Phase 2 M4
// page is typed as unknown to avoid importing Playwright in this module.
export async function validateCoherence(
  preset: ProfilePreset,
  page: unknown,
): Promise<CoherenceCheckResult> {
  const p = page as MinimalPage;
  const checks: CoherenceCheck[] = [];

  // Run each JS probe from the preset
  for (const [expr, expected] of Object.entries(preset.jsProbes)) {
    const actual = String(await p.evaluate(`String(${expr})`));
    const probePassed = actual === expected;
    checks.push(
      probePassed
        ? { name: expr, passed: true }
        : { name: expr, passed: false, details: `got "${actual}"` },
    );
  }

  // UA probe: verify the user agent includes the expected Chrome major version
  const chromeMajor = preset.chromeVersion.split('.')[0];
  const uaExpr = `navigator.userAgent.includes("Chrome/${chromeMajor}")`;
  const uaActual = String(await p.evaluate(`String(${uaExpr})`));
  const uaPassed = uaActual === 'true';
  checks.push(
    uaPassed
      ? { name: uaExpr, passed: true }
      : { name: uaExpr, passed: false, details: `got "${uaActual}"` },
  );

  // JA3 check — informational only, requires patched Chromium
  checks.push({
    name: 'JA3 fingerprint',
    passed: false,
    details: 'Requires patched Chromium binary (make chromium-build)',
  });

  // JA4 check — informational only, requires patched Chromium
  checks.push({
    name: 'JA4 fingerprint',
    passed: false,
    details: 'Requires patched Chromium binary (make chromium-build)',
  });

  // passed = true only when ALL non-JA3/JA4 checks pass
  const nonTlsChecks = checks.filter((c) => !c.name.includes('JA3') && !c.name.includes('JA4'));
  const passed = nonTlsChecks.every((c) => c.passed);

  return { passed, checks };
}

// validateAndStart: throws if any non-JA3/JA4 coherence check fails
export async function validateAndStart(preset: ProfilePreset, page: unknown): Promise<void> {
  const result = await validateCoherence(preset, page);
  const fatalFailures = result.checks.filter((c) => !c.passed && !c.name.includes('JA'));
  if (fatalFailures.length > 0) {
    throw new Error(
      `Fingerprint coherence failed: ${fatalFailures
        .map((c) => `${c.name}: ${c.details ?? 'failed'}`)
        .join('; ')}`,
    );
  }
}
