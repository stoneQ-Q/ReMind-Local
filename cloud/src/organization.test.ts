import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  organizeDaily,
  organizeLink,
  OrganizationError,
} from './organization.js';

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

  it('retries a link draft once when the provider returns invalid structure', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('FROM users')) {
        return { rows: [{ ai_mode: 'bring_your_own_key', status: 'active' }] };
      }
      if (sql.includes('FROM api_credentials')) {
        return {
          rows: [
            {
              encrypted_key: Buffer.from('encrypted'),
              encryption_key_version: 'test-v1',
            },
          ],
        };
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
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: '{"drafts":[]}' } }],
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    drafts: [
                      {
                        title: '视频整理',
                        summary: '一次有效重试。',
                        content: '## 内容概括\n\n这是经过校验的整理稿。',
                        tags: ['视频'],
                        sourceIds: ['note-video'],
                        citations: [
                          { sourceId: 'note-video', evidenceId: 'E1' },
                        ],
                      },
                    ],
                    ignoredSourceIds: [],
                  }),
                },
              },
            ],
          }),
          { status: 200 },
        ),
      );
    vi.stubGlobal('fetch', fetchMock);

    const result = await organizeLink(
      pool as never,
      cipher as never,
      'user-1',
      {
        sourceId: 'note-video',
        url: 'https://example.com/video',
        userContext: '保存这个视频用于产品研究',
        page: {
          title: '视频页面',
          site: 'example.com',
          text: '这是一段足够长的页面证据，用来验证链接整理能够在模型首次返回无效结构后自动重试并成功。',
        },
      },
      new AbortController().signal,
    );

    expect(result.drafts[0]?.title).toBe('视频整理');
    expect(result.drafts[0]?.citations[0]?.quote).toContain('页面证据');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
