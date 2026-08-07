import { DatabaseSync, type StatementSync } from 'node:sqlite';

import { describe, expect, it } from 'vitest';

import {
  acceptOrganizationDraft,
  createNote,
  migrateDatabase,
  saveOrganizationResponse,
} from './database';

describe('organization regeneration', () => {
  it('shows the replacement draft and updates the accepted note in place', async () => {
    const database = new DatabaseSync(':memory:');
    const db = sqliteAdapter(database);
    await migrateDatabase(db);
    const capture = await createNote(db, '小宇宙播客', 'wechat', {
      sourceUrl: 'https://www.xiaoyuzhoufm.com/episode/example',
      userContext: '整理详细案例',
      sourcePageTitle: '示例播客',
      sourcePageSite: '小宇宙',
      sourcePageText: '音频转写\n[00:00:01] 案例内容',
    });

    const [firstDraft] = await saveOrganizationResponse(
      db,
      response(capture.id, '旧稿', '旧的简短内容'),
    );
    const accepted = await acceptOrganizationDraft(
      db,
      firstDraft.id,
      firstDraft.title,
      firstDraft.content,
    );

    const [replacementDraft] = await saveOrganizationResponse(
      db,
      response(capture.id, '新稿', '新的详细案例和操作步骤'),
      { regenerateSourceIds: [capture.id] },
    );
    expect(replacementDraft.title).toBe('新稿');
    expect(replacementDraft.content).toContain('详细案例');

    const replaced = await acceptOrganizationDraft(
      db,
      replacementDraft.id,
      replacementDraft.title,
      replacementDraft.content,
    );
    expect(replaced.id).toBe(accepted.id);
    expect(replaced.content).toContain('新的详细案例和操作步骤');
    expect(
      database
        .prepare("SELECT count(*) AS count FROM notes WHERE record_type = 'source'")
        .get(),
    ).toEqual({ count: 1 });
    database.close();
  });
});

function response(sourceId: string, title: string, content: string) {
  return {
    drafts: [
      {
        title,
        summary: content,
        content,
        contentKind: 'link' as const,
        tags: [],
        sourceIds: [sourceId],
        citations: [
          {
            sourceId,
            quote: '[00:00:01] 案例内容',
            startOffset: 0,
            endOffset: 20,
          },
        ],
      },
    ],
    ignoredSourceIds: [],
    model: 'test',
  };
}

function sqliteAdapter(database: DatabaseSync) {
  type TestAdapter = {
    execAsync: (sql: string) => Promise<void>;
    getFirstAsync: (sql: string, ...params: unknown[]) => Promise<unknown>;
    getAllAsync: (sql: string, ...params: unknown[]) => Promise<unknown>;
    runAsync: (sql: string, ...params: unknown[]) => Promise<unknown>;
    withExclusiveTransactionAsync: (
      callback: (transaction: TestAdapter) => Promise<void>,
    ) => Promise<void>;
  };
  const adapter: TestAdapter = {
    execAsync: async (sql: string) => database.exec(sql),
    getFirstAsync: async (sql: string, ...params: unknown[]) =>
      invokeStatement(database.prepare(sql), 'get', params),
    getAllAsync: async (sql: string, ...params: unknown[]) =>
      invokeStatement(database.prepare(sql), 'all', params),
    runAsync: async (sql: string, ...params: unknown[]) =>
      invokeStatement(database.prepare(sql), 'run', params),
    withExclusiveTransactionAsync: async (
      callback: (transaction: typeof adapter) => Promise<void>,
    ) => {
      database.exec('BEGIN EXCLUSIVE');
      try {
        await callback(adapter);
        database.exec('COMMIT');
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    },
  };
  return adapter as unknown as Parameters<typeof migrateDatabase>[0];
}

function invokeStatement(
  statement: StatementSync,
  method: 'get' | 'all' | 'run',
  params: unknown[],
): unknown {
  const values = params.length === 1 && Array.isArray(params[0])
    ? params[0]
    : params;
  const call = statement[method] as (...args: unknown[]) => unknown;
  return call.apply(statement, values);
}
