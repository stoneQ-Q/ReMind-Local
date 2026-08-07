import { rotateApiCredentials } from './ai-settings.js';
import { credentialCipherFromEnvironment } from './credential-cipher.js';
import { closeDatabase, database } from './database.js';

try {
  const cipher = credentialCipherFromEnvironment();
  const rotated = await rotateApiCredentials(database, cipher);
  console.log(`Rotated ${rotated} API credentials to ${cipher.activeKeyVersion}`);
} finally {
  await closeDatabase();
}
