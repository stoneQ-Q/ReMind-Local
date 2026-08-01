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

  it('creates one cited synthesis across related daily records', async () => {
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
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const request = JSON.parse(String(init.body)) as {
        messages: Array<{ role: string; content: string }>;
      };
      expect(request.messages[0]?.content).toContain('不是逐条改写记录');
      expect(request.messages[1]?.content).toContain('产品验证记录');
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  drafts: [
                    {
                      title: '今天的产品验证脉络',
                      summary: '两条记录共同指向可靠的自动化边界。',
                      content:
                        '## 今日脉络\n\n两条记录共同讨论自动化的验证和成本。\n\n## 已记录的事实\n\n均完成了真实验证。\n\n## 基于记录的联系\n\n这是基于两条记录的共同方向。\n\n## 仍待回答的问题\n\n长期成本是否稳定？',
                      tags: ['产品验证'],
                      sourceIds: ['note-1', 'note-2'],
                      citations: [
                        { sourceId: 'note-1', evidenceId: 'E1' },
                        { sourceId: 'note-2', evidenceId: 'E1' },
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
            title: '产品验证记录',
            content:
              '今天验证了自动整理必须保留原始证据，并且在模型输出异常时停止写入正式笔记。',
            createdAt: '2026-08-01T01:00:00.000Z',
          },
          {
            id: 'note-2',
            title: '自动化成本记录',
            content:
              '今天测得视频处理需要限制并发，同时应当把推断、事实和开放问题清楚区分。',
            createdAt: '2026-08-01T02:00:00.000Z',
          },
        ],
      },
      new AbortController().signal,
    );

    expect(result.drafts).toHaveLength(1);
    expect(result.drafts[0]?.sourceIds).toEqual(['note-1', 'note-2']);
    expect(result.drafts[0]?.citations).toHaveLength(2);
    expect(result.drafts[0]?.citations[0]?.quote).toContain('原始证据');
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
