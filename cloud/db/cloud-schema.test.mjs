import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const schema = readFileSync(
  new URL('./migrations/0001_cloud_core.sql', import.meta.url),
  'utf8',
);

const tenantTables = [
  'user_identities',
  'user_sessions',
  'devices',
  'wechat_connections',
  'notes',
  'files',
  'api_credentials',
  'billing_accounts',
  'jobs',
  'ledger_entries',
];

function tableDefinition(table) {
  return schema.match(
    new RegExp(`CREATE TABLE ${table} \\(([\\s\\S]*?)\\n\\);`),
  )?.[1];
}

describe('cloud PostgreSQL schema', () => {
  it.each(tenantTables)('%s has an explicit user owner', (table) => {
    expect(tableDefinition(table)).toMatch(/\buser_id UUID NOT NULL\b/);
  });

  it('stores credentials as encrypted values rather than plaintext keys', () => {
    const credentialTable = tableDefinition('api_credentials');

    expect(credentialTable).toContain('encrypted_key BYTEA NOT NULL');
    expect(credentialTable).not.toMatch(/\bapi_key\s+(?:TEXT|VARCHAR)\b/i);
  });

  it('prevents historical ledger entries from being changed or deleted', () => {
    expect(schema).toContain('BEFORE UPDATE OR DELETE ON ledger_entries');
    expect(schema).toContain("RAISE EXCEPTION 'ledger entries are append-only'");
  });

  it('prevents balances and reservations from becoming negative', () => {
    const accountTable = tableDefinition('billing_accounts');

    expect(accountTable).toContain('CHECK (balance_micros >= 0)');
    expect(accountTable).toContain(
      'CHECK (reserved_micros >= 0 AND reserved_micros <= balance_micros)',
    );
  });
});
