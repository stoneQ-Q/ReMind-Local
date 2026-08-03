import { afterEach, describe, expect, it, vi } from 'vitest';

import { transcribeAudioWithZhipu } from '../src/zhipu-asr';

describe('transcribeAudioWithZhipu', () => {
  afterEach(() => vi.restoreAllMocks());

  it('sends a temporary MP3 to the official transcription endpoint', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ text: '这是识别结果。' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const result = await transcribeAudioWithZhipu(
      'secret',
      new Uint8Array([1, 2, 3]),
    );

    expect(result).toEqual({
      text: '这是识别结果。',
      model: 'glm-asr-2512',
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      'https://open.bigmodel.cn/api/paas/v4/audio/transcriptions',
    );
    expect(init?.headers).toEqual({ Authorization: 'Bearer secret' });
    const form = init?.body as FormData;
    expect(form.get('model')).toBe('glm-asr-2512');
    expect(form.get('stream')).toBe('false');
    expect(form.get('file')).toBeInstanceOf(Blob);
  });
});
