import { DatabaseSync, type StatementSync } from 'node:sqlite';

import { describe, expect, it } from 'vitest';

import {
  createImportedNote,
  getImportedSourceVersions,
  listNotes,
  migrateDatabase,
} from './database';
import { XIAOYUZHOU_INSIGHT_PROMPT } from './xiaoyuzhou';

describe('imported note synchronization', () => {
  it('skips an unchanged large cloud capture', async () => {
    const database = new DatabaseSync(':memory:');
    const db = sqliteAdapter(database);
    await migrateDatabase(db);
    const pageText = `音频转写\n${'逐字稿内容'.repeat(25_000)}`;
    const metadata = {
      sourceUrl: 'https://www.xiaoyuzhoufm.com/episode/example',
      userContext: null,
      sourcePageTitle: '示例单集',
      sourcePageSite: 'xiaoyuzhoufm.com',
      sourcePageText: pageText,
      createdAt: '2026-08-13T09:51:59.000Z',
      sourceUpdatedAt: '2026-08-13T09:52:59.000Z',
    };

    const created = await createImportedNote(
      db,
      '小宇宙链接',
      'cloud-wechat:episode-1',
      metadata,
    );
    expect(created).not.toBeNull();
    const noteId = created?.id ?? '';
    const before = database
      .prepare('SELECT updated_at FROM notes WHERE id = ?')
      .get(noteId);

    const repeated = await createImportedNote(
      db,
      '小宇宙链接',
      'cloud-wechat:episode-1',
      metadata,
    );

    expect(repeated).toBeNull();
    expect(
      database.prepare('SELECT updated_at FROM notes WHERE id = ?').get(noteId),
    ).toEqual(before);
    await expect(
      getImportedSourceVersions(db, ['cloud-wechat:episode-1']),
    ).resolves.toEqual(
      new Map([
        ['cloud-wechat:episode-1', '2026-08-13T09:52:59.000Z'],
      ]),
    );
    database.close();
  });

  it('clears only a known system prompt when cloud intent is empty', async () => {
    const database = new DatabaseSync(':memory:');
    const db = sqliteAdapter(database);
    await migrateDatabase(db);
    const metadata = {
      sourceUrl: 'https://www.xiaoyuzhoufm.com/episode/example',
      userContext: XIAOYUZHOU_INSIGHT_PROMPT,
      sourcePageTitle: '示例单集',
      sourcePageSite: 'xiaoyuzhoufm.com',
      sourcePageText: '音频转写已安全保存在云端，可用于 AI 整理。',
      createdAt: '2026-08-13T09:51:59.000Z',
      sourceUpdatedAt: '2026-08-13T09:52:59.000Z',
    };
    await createImportedNote(
      db,
      '小宇宙链接',
      'cloud-wechat:episode-2',
      metadata,
    );

    await createImportedNote(db, '小宇宙链接', 'cloud-wechat:episode-2', {
      ...metadata,
      userContext: null,
      sourceUpdatedAt: '2026-08-13T09:53:59.000Z',
    });

    const [note] = await listNotes(db);
    expect(note?.userContext).toBeNull();
    expect(
      database.prepare('SELECT user_context FROM notes').get(),
    ).toEqual({ user_context: null });
    database.close();
  });
});

function sqliteAdapter(database: DatabaseSync) {
  return {
    execAsync: async (sql: string) => database.exec(sql),
    withExclusiveTransactionAsync: async (
      task: (transaction: unknown) => Promise<void>,
    ) => {
      database.exec('BEGIN IMMEDIATE');
      try {
        await task(sqliteAdapter(database));
        database.exec('COMMIT');
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
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
    params.length === 1 && Array.isArray(params[0]) ? params[0] : params;
  const call = statement[method] as (...args: unknown[]) => unknown;
  return call.apply(statement, values);
}
