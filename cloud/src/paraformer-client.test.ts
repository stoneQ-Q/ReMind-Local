import { describe, expect, it, vi } from 'vitest';

import { ParaformerClient, ParaformerError } from './paraformer-client.js';

const apiKey = 'sk-ws-test-key-value-1234567890';
const apiHost = 'workspace.cn-beijing.maas.aliyuncs.com';
const audioUrl = 'https://media.xyzcdn.net/episode.m4a?token=short-lived';
const signal = new AbortController().signal;

describe('Paraformer client', () => {
  it('submits only a trusted Xiaoyuzhou CDN URL', async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        model: string;
        input: { file_urls: string[] };
        parameters: Record<string, unknown>;
      };
      expect(body).toMatchObject({
        model: 'paraformer-v2',
        input: { file_urls: [audioUrl] },
        parameters: {
          channel_id: [0],
          language_hints: ['zh', 'en'],
          disfluency_removal_enabled: false,
          timestamp_alignment_enabled: true,
          diarization_enabled: false,
        },
      });
      expect(String(init?.body)).not.toContain(apiKey);
      return jsonResponse({
        output: { task_status: 'PENDING', task_id: 'task-12345678' },
      });
    });

    await expect(
      new ParaformerClient(apiKey, apiHost, fetcher).submit(audioUrl, signal),
    ).resolves.toBe('task-12345678');
    expect(fetcher).toHaveBeenCalledWith(
      `https://${apiHost}/api/v1/services/audio/asr/transcription`,
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: `Bearer ${apiKey}`,
          'X-DashScope-Async': 'enable',
        }),
      }),
    );
  });

  it('polls the task and returns plain text plus timestamp evidence', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ output: { task_status: 'RUNNING' } }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          output: {
            task_status: 'SUCCEEDED',
            results: [
              {
                subtask_status: 'SUCCEEDED',
                transcription_url:
                  'https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/result.json?signature=test',
              },
            ],
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          transcripts: [
            {
              text: '第一句话。第二句话。',
              sentences: [
                {
                  begin_time: 1_200,
                  end_time: 3_400,
                  text: '第一句话。',
                },
                {
                  begin_time: 3_500,
                  end_time: 5_600,
                  text: '第二句话。',
                },
              ],
            },
          ],
        }),
      );
    const result = await new ParaformerClient(
      apiKey,
      apiHost,
      fetcher,
      0,
      1_000,
    ).waitForTranscript('task-12345678', signal);

    expect(result).toEqual({
      transcript: '第一句话。第二句话。',
      segments: [
        {
          startSeconds: 1,
          endSeconds: 3,
          text: '第一句话。',
          speakerId: null,
        },
        {
          startSeconds: 4,
          endSeconds: 6,
          text: '第二句话。',
          speakerId: null,
        },
      ],
    });
  });

  it('rejects untrusted audio, API host, and result URLs', async () => {
    expect(() => new ParaformerClient(apiKey, 'attacker.example')).toThrow(
      'invalid_dashscope_api_host',
    );
    const client = new ParaformerClient(apiKey, apiHost, vi.fn());
    await expect(
      client.submit('https://attacker.example/audio.mp3', signal),
    ).rejects.toEqual(
      new ParaformerError('paraformer_audio_url_invalid', true),
    );
  });

  it('does not include provider response bodies in errors', async () => {
    const fetcher = vi.fn(async () =>
      new Response(`leaked ${apiKey}`, { status: 401 }),
    );
    const promise = new ParaformerClient(apiKey, apiHost, fetcher).submit(
      audioUrl,
      signal,
    );

    await expect(promise).rejects.toEqual(
      new ParaformerError('paraformer_http_401', true),
    );
    await expect(promise).rejects.not.toThrow(apiKey);
  });
});

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { 'content-type': 'application/json' },
  });
}
