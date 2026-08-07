import { createHash, randomBytes, randomInt } from 'node:crypto';

const RECOVERY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function createRecoveryCode(): string {
  const characters = Array.from({ length: 32 }, () =>
    RECOVERY_ALPHABET[randomInt(RECOVERY_ALPHABET.length)],
  );
  const groups: string[] = [];
  for (let index = 0; index < characters.length; index += 4) {
    groups.push(characters.slice(index, index + 4).join(''));
  }
  return `RM-${groups.join('-')}`;
}

export function normalizeRecoveryCode(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function createOpaqueSecret(prefix: 'rmd' | 'rms'): string {
  return `${prefix}_${randomBytes(32).toString('base64url')}`;
}

export function hashSecret(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
