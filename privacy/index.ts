import { randomUUID, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
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

// ─── AES-256-GCM encryption (NFR-44 / FR-44) ────────────────────────────────

export interface EncryptedData {
  iv: string;         // hex-encoded 12-byte IV
  ciphertext: string; // hex-encoded ciphertext
  authTag: string;    // hex-encoded 16-byte auth tag
}

/**
 * Encrypt plaintext with AES-256-GCM.
 * key must be a 32-byte Buffer.
 */
export function encryptData(plaintext: string, key: Buffer): EncryptedData {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return {
    iv: iv.toString('hex'),
    ciphertext: encrypted.toString('hex'),
    authTag: authTag.toString('hex'),
  };
}

/**
 * Decrypt AES-256-GCM encrypted data.
 * key must be a 32-byte Buffer.
 * Throws if authentication tag verification fails.
 */
export function decryptData(encrypted: EncryptedData, key: Buffer): string {
  const iv = Buffer.from(encrypted.iv, 'hex');
  const ciphertext = Buffer.from(encrypted.ciphertext, 'hex');
  const authTag = Buffer.from(encrypted.authTag, 'hex');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]).toString('utf8');
}

/**
 * Generate a random 32-byte AES-256 key.
 */
export function generateKey(): Buffer {
  return randomBytes(32);
}

// ─── Prompt injection sanitization (SR-2) ────────────────────────────────────

export interface SanitizeResult {
  sanitized: string;
  injectionDetected: boolean;
  patternsFound: string[];
}

// Patterns that indicate prompt injection attempts in page content
const INJECTION_PATTERNS: Array<[RegExp, string]> = [
  [/SYSTEM:/gi, 'SYSTEM: directive'],
  [/You are (?:now |a |an )/gi, 'role-override'],
  [/Ignore (?:all )?(?:previous|prior) instructions/gi, 'instruction-override'],
  [/\[INST\]/gi, 'llama-inst-tag'],
  [/<\|(?:im_start|im_end|system|user|assistant)\|>/gi, 'chat-template-token'],
  [/###\s*(?:System|Instruction)/gi, 'markdown-system-header'],
  [/Act as(?:\s+an?)?\s+/gi, 'act-as-override'],
];

/**
 * Sanitize text before sending to LLM. Strips content that resembles prompt injection.
 * Called on compact view content before it enters the LLM context.
 */
export function sanitizeForLLM(text: string): SanitizeResult {
  let sanitized = text;
  const patternsFound: string[] = [];

  for (const [pattern, label] of INJECTION_PATTERNS) {
    const before = sanitized;
    sanitized = sanitized.replace(pattern, (match) => {
      return '[' + match.replace(/./g, '*') + ']';
    });
    if (sanitized !== before) {
      patternsFound.push(label);
    }
  }

  return {
    sanitized,
    injectionDetected: patternsFound.length > 0,
    patternsFound,
  };
}
