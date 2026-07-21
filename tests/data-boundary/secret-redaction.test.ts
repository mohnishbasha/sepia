import { describe, it, expect } from 'vitest';
import { redactSecrets } from '../../privacy/index.js';

describe('secret-redaction', () => {
  // JSON key patterns (existing behavior — keep working)
  it('redacts "password" JSON field', () => {
    const input = JSON.stringify({ password: 'super-secret-123' });
    const { redacted } = redactSecrets(input);
    expect(redacted).not.toContain('super-secret-123');
    expect(redacted).toContain('[REDACTED]');
  });

  it('leaves unrelated JSON fields intact', () => {
    const input = JSON.stringify({ username: 'alice', age: 30 });
    const { redacted } = redactSecrets(input);
    expect(redacted).toContain('alice');
    expect(redacted).toContain('30');
  });

  // New patterns
  it('redacts Bearer sk-... token in string', () => {
    const input = 'Authorization: Bearer sk-abc123XYZ456abc123';
    const { redacted } = redactSecrets(input);
    expect(redacted).not.toContain('sk-abc123XYZ456abc123');
    expect(redacted).toContain('[REDACTED]');
  });

  it('redacts Bearer eyJ... JWT token', () => {
    const input = 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9';
    const { redacted } = redactSecrets(input);
    expect(redacted).not.toContain('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9');
    expect(redacted).toContain('[REDACTED]');
  });

  it('redacts standalone sk- API key in JSON', () => {
    const input = JSON.stringify({ key: 'sk-proj-ABCDEF1234567890' });
    const { redacted } = redactSecrets(input);
    expect(redacted).not.toContain('sk-proj-ABCDEF1234567890');
  });

  it('redacts X-API-Key header value in JSON', () => {
    const input = JSON.stringify({ 'X-API-Key': 'my-secret-key-here' });
    const { redacted } = redactSecrets(input);
    expect(redacted).not.toContain('my-secret-key-here');
    expect(redacted).toContain('[REDACTED]');
  });

  it('redacts Authorization header value in JSON', () => {
    const input = JSON.stringify({ Authorization: 'Bearer sk-abc123' });
    const { redacted } = redactSecrets(input);
    expect(redacted).not.toContain('Bearer sk-abc123');
    expect(redacted).toContain('[REDACTED]');
  });

  it('count reflects number of replacements made', () => {
    const input = JSON.stringify({ password: 'abc', token: 'xyz' });
    const { count } = redactSecrets(input);
    expect(count).toBeGreaterThanOrEqual(2);
  });

  it('empty string returns count 0', () => {
    const { redacted, count } = redactSecrets('');
    expect(redacted).toBe('');
    expect(count).toBe(0);
  });
});
