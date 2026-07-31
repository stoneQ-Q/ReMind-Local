import { afterEach, describe, expect, it, vi } from 'vitest';

import { organizeDaily, OrganizationError } from './organization.js';

afterEach(() => vi.unstubAllGlobals());

describe('cloud organization', () => {
  it('uses the stored BYOK credential and validates daily drafts', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('FROM users')) {
        return { rows: [{ ai_mode: 'bring_your_own_key', status: 'active' }] };
      }
      if (sql.includes('FROM api_credentials')) {
        return { rows: [{ encrypted_key: Buffer.from('encrypted'), encryption_key_version: 'test-v1' }] };
      }
      throw new Error(`unexpected query: ${sql}`);
    });
    const providerClient = {
      query: vi.fn(async () => ({ rows: [{ status: 'active' }] })),
      release: vi.fn(),
    };
    const pool = { query, connect: vi.fn(async () => providerClient) };
    const cipher = {
      activeKeyVersion: 'test-v1',
      encrypt: vi.fn(),
      decrypt: vi.fn(() => 'sk-test-private'),
    };
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      expect(new Headers(init.headers).get('Authorization')).toBe(
        'Bearer sk-test-private',
      );
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  drafts: [
                    {
                      title: '今天的记录',
                      summary: '保留一件小事。',
                      content: '## 核心内容\n\n完成了一次云端验证。',
                      tags: ['验证'],
                      sourceIds: ['note-1'],
                    },
                  ],
                  ignoredSourceIds: [],
                }),
              },
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await organizeDaily(
      pool as never,
      cipher as never,
      'user-1',
      {
        sources: [
          {
            id: 'note-1',
            content: '完成了一次云端验证。',
            createdAt: '2026-07-31T10:00:00.000Z',
          },
        ],
      },
      new AbortController().signal,
    );

    expect(result.model).toBe('deepseek-v4-flash');
    expect(result.drafts[0]?.sourceIds).toEqual(['note-1']);
    expect(result.drafts[0]?.citations).toEqual([]);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('rejects malformed source payloads before calling a provider', async () => {
    await expect(
      organizeDaily(
        {} as never,
        {} as never,
        'user-1',
        { sources: [] },
        new AbortController().signal,
      ),
    ).rejects.toEqual(new OrganizationError('invalid_request'));
  });
});
