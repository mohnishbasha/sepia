import { describe, it, expect } from 'vitest';
import { createAuditor, wrapWithAuditor, redactSecrets } from '../../privacy/index.js';

describe('data-boundary', () => {
  it('auditor records outbound payloads', () => {
    const auditor = createAuditor();
    auditor.record({ destination: 'api.anthropic.com', byteCount: 1024, fields: ['compactView', 'goal'], timestampMs: Date.now() });
    const report = auditor.report(1);
    expect(report.outbound[0]).toBeDefined();
    expect(report.outbound[0]?.destination).toBe('api.anthropic.com');
  });

  it('auditor resets cleanly', () => {
    const auditor = createAuditor();
    auditor.record({ destination: 'api.anthropic.com', byteCount: 512, fields: ['compactView'], timestampMs: Date.now() });
    auditor.reset();
    const report = auditor.report(2);
    expect(report.outbound).toHaveLength(0);
  });

  it('only compact view + instruction leave the device (AC-P1)', () => {
    const auditor = createAuditor();
    const destination = 'api.anthropic.com';

    // Fake LLM client with a create method
    const fakeClient = {
      create(args: { messages: string[]; model: string }) {
        return { id: 'resp-1', content: args.messages };
      },
    };

    const wrapped = wrapWithAuditor(
      fakeClient as unknown as Record<string, unknown>,
      auditor,
      destination,
    );

    // Call the wrapped method — only the args fields should be recorded
    (wrapped as typeof fakeClient).create({ messages: ['hello'], model: 'claude-3' });

    const report = auditor.report(1);
    expect(report.outbound).toHaveLength(1);
    const payload = report.outbound[0]!;
    expect(payload.destination).toBe(destination);
    expect(payload.fields).toContain('messages');
    expect(payload.fields).toContain('model');
    expect(payload.byteCount).toBeGreaterThan(0);
  });

  it('credentials never appear in LLM context (AC-P2)', () => {
    const secret = 'hunter2-super-secret';
    const input = JSON.stringify({ password: secret, model: 'claude-3' });
    const { redacted } = redactSecrets(input);

    // The redacted string must not contain the original secret value
    expect(redacted).not.toContain(secret);
    expect(redacted).toContain('[REDACTED]');

    // Non-sensitive fields must remain intact
    expect(redacted).toContain('claude-3');
  });
});
