import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface OutboundPayload {
  destination: string;
  byteCount: number;
  fields: string[];
  timestampMs: number;
}

export interface AuditResult {
  stepN: number;
  outbound: OutboundPayload[];
  violations: string[];
}

export interface RedactionResult {
  redacted: string;
  count: number;
}

export interface SessionProfile {
  profileDir: string;
  id: string;
}

export interface SessionPool {
  acquire(): Promise<void>;
  release(): void;
  destroy(): void;
}

// JSON key-based patterns: matches "keyName": "value" and replaces value with [REDACTED]
const JSON_KEY_PATTERNS = [
  /password/i,
  /secret/i,
  /token/i,
  /api[_-]?key/i,
  /apiKey/i,
  /credential/i,
  /auth/i,
];

// Header patterns for Authorization and X-API-Key
const HEADER_KEY_PATTERNS = [
  /authorization/i,
  /x-api-key/i,
];

export function redactSecrets(text: string): RedactionResult {
  if (text === '') return { redacted: '', count: 0 };

  let result = text;
  let count = 0;

  // 1. Redact JSON key patterns: "keyName": "value"
  for (const pattern of JSON_KEY_PATTERNS) {
    const regex = new RegExp(`("(?:${pattern.source})"\\s*:\\s*)"[^"]*"`, 'gi');
    let prev = result;
    result = result.replace(regex, '$1"[REDACTED]"');
    if (result !== prev) count++;
  }

  // 2. Redact Authorization and X-API-Key header values in JSON
  for (const pattern of HEADER_KEY_PATTERNS) {
    const regex = new RegExp(`("(?:${pattern.source})"\\s*:\\s*)"[^"]*"`, 'gi');
    let prev = result;
    result = result.replace(regex, '$1"[REDACTED]"');
    if (result !== prev) count++;
  }

  // 3. Redact Bearer tokens: "Bearer sk-..." or "Bearer eyJ..."
  const bearerRegex = /Bearer\s+(sk-[A-Za-z0-9\-_]+|eyJ[A-Za-z0-9\-_.+/=]+)/g;
  let prevBearer = result;
  result = result.replace(bearerRegex, 'Bearer [REDACTED]');
  if (result !== prevBearer) count++;

  // 4. Redact standalone sk- API keys (min 8 chars total including prefix)
  // Match sk- followed by at least 5 more chars (total >= 8), not already inside [REDACTED]
  const skKeyRegex = /\bsk-[A-Za-z0-9\-_]{5,}/g;
  let prevSk = result;
  result = result.replace(skKeyRegex, '[REDACTED]');
  if (result !== prevSk) count++;

  return { redacted: result, count };
}

// Data-boundary auditor — Phase 2 M3/M5
export function createAuditor(): {
  record: (payload: OutboundPayload) => void;
  report: (stepN: number) => AuditResult;
  reset: () => void;
} {
  const log: OutboundPayload[] = [];
  return {
    record: (payload) => log.push(payload),
    report: (stepN) => ({
      stepN,
      outbound: [...log],
      violations: [],
    }),
    reset: () => log.splice(0),
  };
}

export function createSessionProfile(): SessionProfile {
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sepia-session-'));
  return { profileDir, id: randomUUID() };
}

export function cleanupProfile(profile: SessionProfile): void {
  if (!fs.existsSync(profile.profileDir)) return;
  fs.rmSync(profile.profileDir, { recursive: true, force: true });
}

export function createSessionPool(maxConcurrent: number): SessionPool {
  let active = 0;
  const waiting: Array<() => void> = [];

  return {
    acquire(): Promise<void> {
      return new Promise<void>((resolve) => {
        if (active < maxConcurrent) {
          active++;
          resolve();
        } else {
          waiting.push(resolve);
        }
      });
    },
    release(): void {
      active = Math.max(0, active - 1);
      const next = waiting.shift();
      if (next !== undefined) {
        active++;
        next();
      }
    },
    destroy(): void {
      const pending = waiting.splice(0);
      for (const resolve of pending) {
        resolve();
      }
      active = 0;
    },
  };
}

export function wrapWithAuditor<T extends Record<string, unknown>>(
  client: T,
  auditor: ReturnType<typeof createAuditor>,
  destination: string,
): T {
  return new Proxy(client, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        const firstArg = args[0];
        const fields =
          firstArg !== null &&
          typeof firstArg === 'object' &&
          !Array.isArray(firstArg)
            ? Object.keys(firstArg as Record<string, unknown>)
            : [];
        auditor.record({
          destination,
          byteCount: JSON.stringify(args).length,
          fields,
          timestampMs: Date.now(),
        });
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}
