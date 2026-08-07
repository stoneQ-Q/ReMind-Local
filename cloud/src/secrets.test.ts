import { describe, expect, it } from 'vitest';

import {
  createOpaqueSecret,
  createRecoveryCode,
  hashSecret,
  normalizeRecoveryCode,
} from './secrets.js';

describe('anonymous account secrets', () => {
  it('creates a human-readable recovery code with strong random groups', () => {
    const code = createRecoveryCode();

    expect(code).toMatch(/^RM(?:-[A-HJ-NP-Z2-9]{4}){8}$/);
    expect(normalizeRecoveryCode(code)).toHaveLength(34);
  });

  it('accepts recovery codes regardless of spaces, dashes, or case', () => {
    expect(normalizeRecoveryCode('rm-abcd efgh-2345')).toBe('RMABCDEFGH2345');
  });

  it('creates different device and session secrets', () => {
    const deviceSecret = createOpaqueSecret('rmd');
    const sessionSecret = createOpaqueSecret('rms');

    expect(deviceSecret).toMatch(/^rmd_[A-Za-z0-9_-]{43}$/);
    expect(sessionSecret).toMatch(/^rms_[A-Za-z0-9_-]{43}$/);
    expect(hashSecret(deviceSecret)).not.toBe(hashSecret(sessionSecret));
  });
});
