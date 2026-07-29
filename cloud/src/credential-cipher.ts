import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from 'node:crypto';

const MAGIC = Buffer.from('RMK1', 'ascii');
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;

export type EncryptedCredential = {
  ciphertext: Buffer;
  keyVersion: string;
};

export type CredentialContext = {
  userId: string;
  provider: string;
};

export interface CredentialCipher {
  readonly activeKeyVersion: string;
  encrypt(plaintext: string, context: CredentialContext): EncryptedCredential;
  decrypt(
    encrypted: EncryptedCredential,
    context: CredentialContext,
  ): string;
}

export class LocalAesGcmCredentialCipher implements CredentialCipher {
  readonly activeKeyVersion: string;
  private readonly keys: ReadonlyMap<string, Buffer>;

  constructor(activeKeyVersion: string, keys: ReadonlyMap<string, Buffer>) {
    if (!/^[a-zA-Z0-9._-]{1,64}$/.test(activeKeyVersion)) {
      throw new Error('Invalid credential key version');
    }
    for (const [version, key] of keys) {
      if (!/^[a-zA-Z0-9._-]{1,64}$/.test(version) || key.byteLength !== 32) {
        throw new Error('Credential encryption keys must be 32 bytes');
      }
    }
    if (!keys.has(activeKeyVersion)) {
      throw new Error('Active credential encryption key is missing');
    }
    this.activeKeyVersion = activeKeyVersion;
    this.keys = new Map(keys);
  }

  encrypt(
    plaintext: string,
    context: CredentialContext,
  ): EncryptedCredential {
    const key = this.requiredKey(this.activeKeyVersion);
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', key, iv, {
      authTagLength: AUTH_TAG_BYTES,
    });
    cipher.setAAD(associatedData(context, this.activeKeyVersion));
    const encrypted = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    return {
      keyVersion: this.activeKeyVersion,
      ciphertext: Buffer.concat([MAGIC, iv, tag, encrypted]),
    };
  }

  decrypt(
    encrypted: EncryptedCredential,
    context: CredentialContext,
  ): string {
    if (
      encrypted.ciphertext.byteLength <
        MAGIC.byteLength + IV_BYTES + AUTH_TAG_BYTES ||
      !encrypted.ciphertext.subarray(0, MAGIC.byteLength).equals(MAGIC)
    ) {
      throw new Error('Invalid encrypted credential');
    }
    const key = this.requiredKey(encrypted.keyVersion);
    const ivStart = MAGIC.byteLength;
    const tagStart = ivStart + IV_BYTES;
    const contentStart = tagStart + AUTH_TAG_BYTES;
    const decipher = createDecipheriv(
      'aes-256-gcm',
      key,
      encrypted.ciphertext.subarray(ivStart, tagStart),
      { authTagLength: AUTH_TAG_BYTES },
    );
    decipher.setAAD(associatedData(context, encrypted.keyVersion));
    decipher.setAuthTag(
      encrypted.ciphertext.subarray(tagStart, contentStart),
    );
    return Buffer.concat([
      decipher.update(encrypted.ciphertext.subarray(contentStart)),
      decipher.final(),
    ]).toString('utf8');
  }

  private requiredKey(version: string): Buffer {
    const key = this.keys.get(version);
    if (!key) throw new Error(`Credential key version is unavailable: ${version}`);
    return key;
  }
}

export function credentialCipherFromEnvironment(): CredentialCipher {
  const version = process.env.REMIND_CREDENTIAL_KEY_VERSION?.trim();
  const encodedKey = process.env.REMIND_CREDENTIAL_KEY_BASE64?.trim();
  if (!version) {
    throw new Error('Credential encryption key is not configured');
  }

  const keys = new Map<string, Buffer>();
  const encodedRing = process.env.REMIND_CREDENTIAL_KEY_RING_JSON?.trim();
  if (encodedRing) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(encodedRing) as unknown;
    } catch {
      throw new Error('Credential key ring must be valid JSON');
    }
    if (!isStringRecord(parsed)) {
      throw new Error('Credential key ring must be a JSON object');
    }
    for (const [ringVersion, ringKey] of Object.entries(parsed)) {
      keys.set(ringVersion, decodeKey(ringKey));
    }
  }
  if (encodedKey) keys.set(version, decodeKey(encodedKey));
  return new LocalAesGcmCredentialCipher(version, keys);
}

function associatedData(
  context: CredentialContext,
  keyVersion: string,
): Buffer {
  return Buffer.from(
    `${context.userId}\u0000${context.provider}\u0000${keyVersion}`,
    'utf8',
  );
}

function decodeKey(value: string): Buffer {
  const key = Buffer.from(value, 'base64');
  if (key.byteLength !== 32) {
    throw new Error('Credential encryption key must decode to 32 bytes');
  }
  return key;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((item) => typeof item === 'string')
  );
}
