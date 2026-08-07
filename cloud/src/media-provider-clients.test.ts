import { describe, expect, it, vi } from 'vitest';

import {
  DeepSeekMediaClient,
  DEEPSEEK_MEDIA_MODEL,
  MediaProviderHttpError,
  ZhipuMediaClient,
  ZHIPU_ASR_MODEL,
  ZHIPU_VISION_MODEL,
} from './media-provider-clients.js';

const apiKey = 'test-provider-key-123456';
const signal = new AbortController().signal;

describe('media provider clients', () => {
  it('sends an in-memory image only to the fixed Zhipu endpoint', async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        model: string;
        messages: Array<{ content: Array<{ image_url?: { url: string } }> }>;
      };
      expect(body.model).toBe(ZHIPU_VISION_MODEL);
      expect(body.messages[0]?.content[0]?.image_url?.url).toMatch(
        /^data:image\/png;base64,/,
      );
      expect(String(init?.body)).not.toContain(apiKey);
      expect(init?.redirect).toBe('error');
      return jsonResponse({
        choices: [{ message: { content: '图片中清晰可见一张测试卡片。' } }],
      });
    });
    const client = new ZhipuMediaClient(fetcher);
    const result = await client.analyzeImage(
      apiKey,
      { content: Buffer.from('png'), contentType: 'image/png' },
      signal,
    );
    expect(result).toEqual({
      description: '图片中清晰可见一张测试卡片。',
      tags: [],
      model: ZHIPU_VISION_MODEL,
    });
    expect(fetcher).toHaveBeenCalledWith(
      'https://open.bigmodel.cn/api/paas/v4/chat/completions',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: `Bearer ${apiKey}`,
        }),
      }),
    );
  });

  it('uses multipart audio without putting the key in the body', async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.body).toBeInstanceOf(FormData);
      const form = init?.body as FormData;
      expect(form.get('model')).toBe(ZHIPU_ASR_MODEL);
      expect(String(form.get('file'))).not.toContain(apiKey);
      return jsonResponse({ text: '  一段安全的模拟转写。  ' });
    });
    const result = await new ZhipuMediaClient(fetcher).transcribeAudio(
      apiKey,
      {
        content: Buffer.from('audio'),
        contentType: 'audio/mpeg',
        fileName: '../../private.mp3',
      },
      signal,
    );
    expect(result).toEqual({
      transcript: '一段安全的模拟转写。',
      model: ZHIPU_ASR_MODEL,
    });
  });

  it('validates DeepSeek JSON output and preserves usage for settlement', async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        model: string;
        response_format: { type: string };
      };
      expect(body.model).toBe(DEEPSEEK_MEDIA_MODEL);
      expect(body.response_format).toEqual({ type: 'json_object' });
      return jsonResponse({
        choices: [
          {
            message: {
              content: JSON.stringify({
                summary: '视频总结',
                highlights: ['重点一', '重点二'],
              }),
            },
          },
        ],
        usage: { prompt_tokens: 1200, completion_tokens: 300 },
      });
    });
    await expect(
      new DeepSeekMediaClient(fetcher).summarizeVideoTranscript(
        apiKey,
        '[00:00] 视频内容',
        signal,
      ),
    ).resolves.toEqual({
      summary: '视频总结',
      highlights: ['重点一', '重点二'],
      model: DEEPSEEK_MEDIA_MODEL,
      usage: { promptTokens: 1200, completionTokens: 300 },
    });
  });

  it('performs a short real-generation test without placing the key in the body', async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        model: string;
        max_tokens: number;
      };
      expect(body.model).toBe(DEEPSEEK_MEDIA_MODEL);
      expect(body.max_tokens).toBe(80);
      expect(String(init?.body)).not.toContain(apiKey);
      return jsonResponse({
        choices: [{ message: { content: 'ReMind 已成功调用 DeepSeek。' } }],
        usage: { prompt_tokens: 24, completion_tokens: 10 },
      });
    });
    await expect(
      new DeepSeekMediaClient(fetcher).generateConnectivityTest(apiKey, signal),
    ).resolves.toEqual({
      content: 'ReMind 已成功调用 DeepSeek。',
      model: DEEPSEEK_MEDIA_MODEL,
      usage: { promptTokens: 24, completionTokens: 10 },
    });
  });

  it('never includes provider response bodies in HTTP errors', async () => {
    const fetcher = vi.fn(async () =>
      new Response(`upstream leaked ${apiKey}`, { status: 401 }),
    );
    const promise = new ZhipuMediaClient(fetcher).analyzeImage(
      apiKey,
      { content: Buffer.from('image'), contentType: 'image/jpeg' },
      signal,
    );
    await expect(promise).rejects.toEqual(
      new MediaProviderHttpError('zhipu', 401),
    );
    await expect(promise).rejects.not.toThrow(apiKey);
  });

  it('rejects oversized and malformed provider responses', async () => {
    const oversized = new ZhipuMediaClient(async () =>
      new Response('{}', {
        headers: { 'content-length': String(2 * 1024 * 1024 + 1) },
      }),
    );
    await expect(
      oversized.analyzeImage(
        apiKey,
        { content: Buffer.from('image'), contentType: 'image/webp' },
        signal,
      ),
    ).rejects.toThrow('provider_response_too_large');

    const malformed = new DeepSeekMediaClient(async () =>
      jsonResponse({
        choices: [{ message: { content: '{"summary":' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
    );
    await expect(
      malformed.summarizeVideoTranscript(apiKey, 'content', signal),
    ).rejects.toThrow('deepseek_invalid_media_json');
  });
});

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
