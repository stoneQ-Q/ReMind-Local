const ZHIPU_ASR_URL =
  'https://open.bigmodel.cn/api/paas/v4/audio/transcriptions';
const MODEL = 'glm-asr-2512';

type ZhipuAsrResponse = {
  text?: unknown;
};

export async function transcribeAudioWithZhipu(
  apiKey: string,
  audio: Uint8Array,
): Promise<{ text: string; model: string }> {
  if (audio.byteLength === 0) throw new Error('Empty audio chunk');

  const form = new FormData();
  form.append('model', MODEL);
  form.append('stream', 'false');
  form.append(
    'file',
    new Blob([Uint8Array.from(audio).buffer], { type: 'audio/mpeg' }),
    'chunk.mp3',
  );

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);
  try {
    const response = await fetch(ZHIPU_ASR_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: controller.signal,
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 500);
      throw new Error(`Zhipu ASR ${response.status}: ${detail}`);
    }
    const payload = (await response.json()) as ZhipuAsrResponse;
    const text =
      typeof payload.text === 'string' ? payload.text.trim() : '';
    if (!text) throw new Error('Zhipu ASR returned empty text');
    return { text, model: MODEL };
  } finally {
    clearTimeout(timer);
  }
}
