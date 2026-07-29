import { describe, expect, it } from 'vitest';

import { LocalAesGcmCredentialCipher } from './credential-cipher.js';

const context = { userId: 'user-1', provider: 'deepseek' };
const cipher = new LocalAesGcmCredentialCipher(
  'test-v1',
  new Map([['test-v1', Buffer.alloc(32, 7)]]),
);

describe('API credential encryption', () => {
  it('round-trips an API key without storing plaintext', () => {
    const encrypted = cipher.encrypt('sk-private-test-key', context);

    expect(encrypted.ciphertext.includes('sk-private-test-key')).toBe(false);
    expect(cipher.decrypt(encrypted, context)).toBe('sk-private-test-key');
  });

  it('uses a unique nonce for every encryption', () => {
    const first = cipher.encrypt('same-secret', context);
    const second = cipher.encrypt('same-secret', context);

    expect(first.ciphertext.equals(second.ciphertext)).toBe(false);
  });

  it('rejects ciphertext moved to another user or provider', () => {
    const encrypted = cipher.encrypt('sk-private-test-key', context);

    expect(() =>
      cipher.decrypt(encrypted, { ...context, userId: 'user-2' }),
    ).toThrow();
    expect(() =>
      cipher.decrypt(encrypted, { ...context, provider: 'zhipu' }),
    ).toThrow();
  });

  it('rejects tampered ciphertext', () => {
    const encrypted = cipher.encrypt('sk-private-test-key', context);
    const tampered = Buffer.from(encrypted.ciphertext);
    const lastIndex = tampered.length - 1;
    tampered[lastIndex] = (tampered[lastIndex] ?? 0) ^ 1;

    expect(() =>
      cipher.decrypt({ ...encrypted, ciphertext: tampered }, context),
    ).toThrow();
  });

  it('decrypts an old version while encrypting with the active version', () => {
    const oldCipher = new LocalAesGcmCredentialCipher(
      'old-v1',
      new Map([['old-v1', Buffer.alloc(32, 1)]]),
    );
    const encryptedWithOldKey = oldCipher.encrypt('secret-to-rotate', context);
    const rotatingCipher = new LocalAesGcmCredentialCipher(
      'new-v2',
      new Map([
        ['old-v1', Buffer.alloc(32, 1)],
        ['new-v2', Buffer.alloc(32, 2)],
      ]),
    );

    expect(rotatingCipher.decrypt(encryptedWithOldKey, context)).toBe(
      'secret-to-rotate',
    );
    expect(
      rotatingCipher.encrypt('secret-to-rotate', context).keyVersion,
    ).toBe('new-v2');
  });
});
