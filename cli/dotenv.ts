import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Parse the subset of `.env` syntax worth supporting: `KEY=value`, optional
 * `export` prefix, `#` comments, and matched surrounding quotes.
 *
 * Deliberately small — this exists so the installed binary can find its
 * configuration, not to reimplement a shell.
 */
export function parseDotEnv(content: string): Record<string, string> {
  const out: Record<string, string> = {};

  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;

    const eq = line.indexOf('=');
    if (eq === -1) continue;

    const key = line
      .slice(0, eq)
      .replace(/^export\s+/, '')
      .trim();
    if (key === '') continue;

    let value = line.slice(eq + 1).trim();
    const quoted =
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")));
    if (quoted) value = value.slice(1, -1);

    out[key] = value;
  }

  return out;
}

/**
 * Apply the nearest `.env` to process.env, walking up from `startDir`.
 *
 * Variables already present in the environment win — an explicit `export` or a
 * value passed by a supervisor should never be silently overridden by a file
 * that happens to be in the working directory.
 *
 * Returns the path applied, or null if no `.env` was found.
 */
export function loadDotEnv(startDir: string = process.cwd(), maxDepth = 5): string | null {
  let dir = resolve(startDir);

  for (let depth = 0; depth <= maxDepth; depth++) {
    const candidate = join(dir, '.env');
    if (existsSync(candidate)) {
      const parsed = parseDotEnv(readFileSync(candidate, 'utf-8'));
      for (const [key, value] of Object.entries(parsed)) {
        if (process.env[key] === undefined) process.env[key] = value;
      }
      return candidate;
    }
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }

  return null;
}
