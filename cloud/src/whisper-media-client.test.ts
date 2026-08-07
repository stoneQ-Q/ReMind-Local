import { describe, expect, it, vi } from 'vitest';

import { WhisperMediaClient } from './whisper-media-client.js';

const signal = new AbortController().signal;

describe('Whisper media client', () => {
  it('sends audio only to the configured internal inference endpoint', async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.body).toBeInstanceOf(FormData);
      const form = init?.body as FormData;
      expect(form.get('response_format')).toBe('json');
      expect(form.get('file')).toBeInstanceOf(Blob);
      expect((form.get('file') as File).name).toBe('audio.m4a');
      return new Response(JSON.stringify({ text: '  本地转写成功。  ' }), {
        headers: { 'content-type': 'application/json' },
      });
    });
    await expect(
      new WhisperMediaClient('http://whisper:8080', fetcher).transcribeAudio(
        { content: Buffer.from('audio'), contentType: 'audio/mp4' },
        signal,
      ),
    ).resolves.toEqual({
      transcript: '本地转写成功。',
      model: 'whisper-small-q5_1',
    });
    expect(fetcher).toHaveBeenCalledWith(
      'http://whisper:8080/inference',
      expect.objectContaining({ method: 'POST', redirect: 'error' }),
    );
  });

  it('rejects credentialed URLs and oversized responses', async () => {
    expect(
      () => new WhisperMediaClient('http://user:secret@whisper:8080'),
    ).toThrow('invalid_whisper_service_url');
    const client = new WhisperMediaClient(
      'http://whisper:8080',
      async () =>
        new Response('{}', {
          headers: { 'content-length': String(2 * 1024 * 1024 + 1) },
        }),
    );
    await expect(
      client.transcribeAudio(
        { content: Buffer.from('audio'), contentType: 'audio/mpeg' },
        signal,
      ),
    ).rejects.toThrow('whisper_response_too_large');
  });
});
