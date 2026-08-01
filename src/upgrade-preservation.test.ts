import { readFile } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';

import { afterEach, describe, expect, it, vi } from 'vitest';

const secureValues = new Map<string, string>();

vi.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY',
  deleteItemAsync: vi.fn(async (key: string) => {
    secureValues.delete(key);
  }),
  getItemAsync: vi.fn(async (key: string) => secureValues.get(key) ?? null),
  setItemAsync: vi.fn(async (key: string, value: string) => {
    secureValues.set(key, value);
  }),
}));

import { getCloudAccessToken } from './cloud-auth';
import {
  getLinkAutomationMode,
  migrateDatabase,
  setLinkAutomationMode,
} from './database';
import {
  cloudSessionStorageKey,
  OBSIDIAN_DIRECTORY_NAME_SETTING,
  OBSIDIAN_DIRECTORY_URI_SETTING,
  REMIND_APPLICATION_ID,
  REMIND_DATABASE_NAME,
  REMIND_DATABASE_SCHEMA_VERSION,
  REMIND_SERVICE_MODE_STORAGE_KEY,
  wechatDeviceIdStorageKey,
  wechatDeviceSecretStorageKey,
} from './persistence-contract';
import {
  setActiveReMindAppMode,
} from './service-contract';
import { initializeReMindServiceMode } from './service-mode';
import { getWechatConnection } from './wechat-sync';

const ENV_KEYS = [
  'EXPO_PUBLIC_REMIND_API_URL',
  'EXPO_PUBLIC_REMIND_API_VERSION',
  'EXPO_PUBLIC_REMIND_SERVICE_MODE',
  'EXPO_PUBLIC_REMIND_LOCAL_API_URL',
  'EXPO_PUBLIC_REMIND_CLOUD_API_URL',
] as const;

afterEach(() => {
  secureValues.clear();
  for (const key of ENV_KEYS) delete process.env[key];
  setActiveReMindAppMode(null);
  vi.unstubAllGlobals();
});

describe('ReMind in-place upgrade preservation', () => {
  it('pins the application, database, WeChat, cloud, and Obsidian identities', async () => {
    const appConfig = JSON.parse(
      await readFile(join(process.cwd(), 'app.json'), 'utf8'),
    ) as {
      expo: {
        android: { package: string };
        ios: { bundleIdentifier: string };
        newArchEnabled?: boolean;
        plugins: unknown[];
      };
    };

    expect(REMIND_APPLICATION_ID).toBe('app.remind.notes');
    expect(appConfig.expo.android.package).toBe(REMIND_APPLICATION_ID);
    expect(appConfig.expo.ios.bundleIdentifier).toBe(REMIND_APPLICATION_ID);
    expect(appConfig.expo.plugins).toContain('expo-sqlite');
    expect(appConfig.expo.plugins).toContain('expo-secure-store');
    expect(appConfig.expo.newArchEnabled).not.toBe(false);
    expect(REMIND_DATABASE_NAME).toBe('remind.db');
    expect(REMIND_DATABASE_SCHEMA_VERSION).toBe(16);
    expect(REMIND_SERVICE_MODE_STORAGE_KEY).toBe('remind.service.mode.v1');
    expect(OBSIDIAN_DIRECTORY_URI_SETTING).toBe('obsidian.directory_uri');
    expect(OBSIDIAN_DIRECTORY_NAME_SETTING).toBe('obsidian.directory_name');
    expect(
      wechatDeviceIdStorageKey('http://192.168.31.122:8787'),
    ).toBe('remind.wechat.device-id.cd522cc5');
    expect(
      wechatDeviceSecretStorageKey('http://192.168.31.122:8787'),
    ).toBe('remind.wechat.device-secret.cd522cc5');
    expect(
      cloudSessionStorageKey(
        'hosted:https://cloud.remind.example:v1',
      ),
    ).toBe('remind.cloud.session.e3fe3d32');
  });

  it('reopens and migrates an existing on-disk v16 database without replacing its data', async () => {
    const fixtureDirectory = await mkdtemp(
      join(tmpdir(), 'remind-upgrade-fixture-'),
    );
    const databasePath = join(fixtureDirectory, REMIND_DATABASE_NAME);
    try {
      const before = new DatabaseSync(databasePath);
      await migrateDatabase(sqliteAdapter(before));
      seedUpgradeFixture(before);
      const beforeSnapshot = preservationSnapshot(before);
      before.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      before.close();

      const after = new DatabaseSync(databasePath);
      await migrateDatabase(sqliteAdapter(after));

      expect(preservationSnapshot(after)).toEqual(beforeSnapshot);
      expect(
        after.prepare('PRAGMA user_version').get(),
      ).toEqual({ user_version: REMIND_DATABASE_SCHEMA_VERSION });
      expect(
        after.prepare('PRAGMA integrity_check').get(),
      ).toEqual({ integrity_check: 'ok' });
      expect(after.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      after.close();
    } finally {
      await rm(fixtureDirectory, { recursive: true, force: true });
    }
  });

  it('stores link automation as an explicit device preference', async () => {
    const database = new DatabaseSync(':memory:');
    const adapter = sqliteAdapter(database);
    await migrateDatabase(adapter);

    await expect(getLinkAutomationMode(adapter)).resolves.toBe('review');
    await setLinkAutomationMode(adapter, 'auto_note_and_theme');
    await expect(getLinkAutomationMode(adapter)).resolves.toBe(
      'auto_note_and_theme',
    );
    database.close();
  });

  it('reads existing SecureStore values after the code upgrade', async () => {
    process.env.EXPO_PUBLIC_REMIND_LOCAL_API_URL =
      'http://192.168.31.122:8787';
    process.env.EXPO_PUBLIC_REMIND_CLOUD_API_URL =
      'https://cloud.remind.example';

    secureValues.set(
      'remind.wechat.device-id.cd522cc5',
      'existing-device-id',
    );
    secureValues.set(
      'remind.wechat.device-secret.cd522cc5',
      'existing-device-secret',
    );
    secureValues.set('remind.service.mode.v1', 'cloud');
    secureValues.set(
      'remind.cloud.session.e3fe3d32',
      JSON.stringify({
        userId: 'existing-cloud-user',
        deviceId: 'existing-cloud-device',
        deviceSecret: 'existing-cloud-secret',
        accessToken: 'existing-cloud-token',
        accessTokenExpiresAt: '2035-07-30T00:00:00.000Z',
      }),
    );

    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          bound: true,
          bindingCode: '',
          expiresAt: '2035-07-30T00:00:00.000Z',
          replyMode: 'first',
          gatewayOnline: true,
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    setActiveReMindAppMode('local');
    await expect(getWechatConnection(false)).resolves.toMatchObject({
      bound: true,
      gatewayOnline: true,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://192.168.31.122:8787/api/devices/existing-device-id/status',
      expect.objectContaining({
        headers: {
          Authorization: 'Bearer existing-device-secret',
        },
      }),
    );

    await expect(initializeReMindServiceMode()).resolves.toMatchObject({
      active: 'cloud',
    });
    await expect(getCloudAccessToken()).resolves.toBe(
      'existing-cloud-token',
    );
  });
});

function sqliteAdapter(database: DatabaseSync) {
  return {
    execAsync: async (sql: string) => {
      database.exec(sql);
    },
    getFirstAsync: async (sql: string, ...params: unknown[]) =>
      invokeStatement(database.prepare(sql), 'get', params),
    getAllAsync: async (sql: string, ...params: unknown[]) =>
      invokeStatement(database.prepare(sql), 'all', params),
    runAsync: async (sql: string, ...params: unknown[]) =>
      invokeStatement(database.prepare(sql), 'run', params),
  } as unknown as Parameters<typeof migrateDatabase>[0];
}

function invokeStatement(
  statement: StatementSync,
  method: 'get' | 'all' | 'run',
  params: unknown[],
): unknown {
  const values =
    params.length === 1 && Array.isArray(params[0])
      ? params[0]
      : params;
  const call = statement[method] as (...args: unknown[]) => unknown;
  return call.apply(statement, values);
}

function seedUpgradeFixture(database: DatabaseSync): void {
  const now = '2026-07-28T02:00:00.000Z';
  database
    .prepare(
      `INSERT INTO notes (
         id, title, content, summary, status, created_at, updated_at,
         source, tags_json, record_type, content_kind, source_url,
         user_context
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      'existing-note',
      '升级前笔记',
      '这条内容必须在覆盖安装后保持不变。',
      '升级保护样本',
      'saved',
      now,
      now,
      'wechat',
      '["升级","保留"]',
      'capture',
      'link',
      'https://example.com/existing',
      '保留我的原始意图',
    );
  database
    .prepare(
      `INSERT INTO note_imports (
         source_key, payload, note_id, created_at
       ) VALUES (?, ?, ?, ?)`,
    )
    .run(
      'wechat:existing-message',
      '{"source":"upgrade-fixture"}',
      'existing-note',
      now,
    );
  database
    .prepare(
      `INSERT INTO obsidian_exports (
         note_id, file_uri, exported_hash, exported_at, status,
         last_error, sync_enabled
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      'existing-note',
      'content://obsidian/ReMind/Inbox/existing.md',
      'existing-export-hash',
      now,
      'exported',
      null,
      1,
    );
  const setting = database.prepare(
    `INSERT INTO app_settings (key, value, updated_at)
     VALUES (?, ?, ?)`,
  );
  setting.run(
    OBSIDIAN_DIRECTORY_URI_SETTING,
    'content://obsidian/ReMind/Inbox',
    now,
  );
  setting.run(
    OBSIDIAN_DIRECTORY_NAME_SETTING,
    'Personal/ReMind/Inbox',
    now,
  );
}

function preservationSnapshot(database: DatabaseSync): unknown {
  return {
    notes: database
      .prepare(
        `SELECT id, title, content, summary, status, source, tags_json,
                record_type, content_kind, source_url, user_context,
                created_at, updated_at
         FROM notes
         ORDER BY id`,
      )
      .all(),
    imports: database
      .prepare(
        `SELECT source_key, payload, note_id, created_at
         FROM note_imports
         ORDER BY source_key`,
      )
      .all(),
    obsidianExports: database
      .prepare(
        `SELECT note_id, file_uri, exported_hash, exported_at, status,
                last_error, sync_enabled
         FROM obsidian_exports
         ORDER BY note_id`,
      )
      .all(),
    settings: database
      .prepare(
        `SELECT key, value, updated_at
         FROM app_settings
         ORDER BY key`,
      )
      .all(),
  };
}
