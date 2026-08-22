/**
 * Headed/headless resolution shared by the CLI subcommands (AC-I2..AC-I6).
 *
 * Precedence, strongest first:
 *   1. explicit `--headed` flag
 *   2. `SEPIA_HEADLESS` environment variable (real environment or `.env`)
 *   3. configured default (`browser.headless: true`)
 *
 * `SEPIA_HEADLESS` accepts `true`/`1` (headless) and `false`/`0` (headed).
 * Unset or empty means "no effect". Any other value throws: a typo such as
 * `SEPIA_HEADLESS=flase` must fail loudly rather than silently produce the
 * opposite of what was asked — fail closed on ambiguity.
 */

export const HEADLESS_ENV_VAR = 'SEPIA_HEADLESS';

/** Values meaning "run headless". Matching is exact and case-sensitive. */
const HEADLESS_VALUES: ReadonlySet<string> = new Set(['true', '1']);
/** Values meaning "show the window". */
const HEADED_VALUES: ReadonlySet<string> = new Set(['false', '0']);

/**
 * Map a raw `SEPIA_HEADLESS` value to its boolean, or `undefined` when the
 * variable should have no effect (unset or empty). Throws on anything else.
 */
export function parseHeadlessEnv(raw: string | undefined): boolean | undefined {
  if (raw === undefined || raw === '') return undefined;
  if (HEADLESS_VALUES.has(raw)) return true;
  if (HEADED_VALUES.has(raw)) return false;
  throw new Error(
    `invalid ${HEADLESS_ENV_VAR} value "${raw}" — accepted: "true", "1", "false", "0"; ` +
      'leave it unset or empty to use the configured default',
  );
}

/**
 * Resolve the effective `browser.headless` override.
 *
 * Returns `undefined` when nothing overrides the configured default, otherwise
 * the headless value to thread into the `browser` config block. Throws on an
 * unusable `SEPIA_HEADLESS` value.
 */
export function resolveHeadless(
  headedFlag: boolean,
  envValue: string | undefined,
): boolean | undefined {
  if (headedFlag) return false;
  return parseHeadlessEnv(envValue);
}
