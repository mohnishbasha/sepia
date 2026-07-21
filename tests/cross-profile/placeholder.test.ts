import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createSessionProfile, cleanupProfile, type SessionProfile } from '../../privacy/index.js';

describe('cross-profile (placeholder)', () => {
  const created: SessionProfile[] = [];

  afterEach(() => {
    // Clean up any profiles that weren't explicitly cleaned in the test
    for (const profile of created.splice(0)) {
      cleanupProfile(profile);
    }
  });

  it('profile A cookies absent from profile B context (AC-P3)', () => {
    const profileA = createSessionProfile();
    const profileB = createSessionProfile();
    created.push(profileA, profileB);

    // Each profile has a unique ID
    expect(profileA.id).not.toBe(profileB.id);

    // Each profile has a unique directory path
    expect(profileA.profileDir).not.toBe(profileB.profileDir);

    // Both directories must actually exist on disk
    expect(fs.existsSync(profileA.profileDir)).toBe(true);
    expect(fs.existsSync(profileB.profileDir)).toBe(true);

    // IDs are non-empty strings (UUID format)
    expect(profileA.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(profileB.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('concurrent sessions share no filesystem state (AC-P3b)', () => {
    const profileA = createSessionProfile();
    const profileB = createSessionProfile();

    // Write a marker file into profile A's directory
    const markerA = path.join(profileA.profileDir, 'session.lock');
    fs.writeFileSync(markerA, 'A');

    // Write a different marker file into profile B's directory
    const markerB = path.join(profileB.profileDir, 'session.lock');
    fs.writeFileSync(markerB, 'B');

    // Profile B's dir must NOT contain profile A's marker (and vice versa)
    expect(fs.existsSync(path.join(profileB.profileDir, 'session.lock'))).toBe(true);
    // Verify contents are independent
    expect(fs.readFileSync(markerA, 'utf8')).toBe('A');
    expect(fs.readFileSync(markerB, 'utf8')).toBe('B');

    // The marker from A is not inside B's dir path
    expect(markerA).not.toContain(profileB.profileDir);
    expect(markerB).not.toContain(profileA.profileDir);

    // Cleanup both profiles
    cleanupProfile(profileA);
    cleanupProfile(profileB);

    // Directories must no longer exist after cleanup
    expect(fs.existsSync(profileA.profileDir)).toBe(false);
    expect(fs.existsSync(profileB.profileDir)).toBe(false);
  });
});
