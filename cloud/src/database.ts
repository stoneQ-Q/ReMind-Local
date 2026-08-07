import { Pool } from 'pg';

import { loadCloudRuntimeConfig } from './config.js';

const { databaseUrl } = loadCloudRuntimeConfig();

export const database = new Pool({
  connectionString: databaseUrl,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

database.on('error', (error) => {
  console.error('Unexpected idle PostgreSQL connection error', error.message);
});

export async function closeDatabase(): Promise<void> {
  await database.end();
}
