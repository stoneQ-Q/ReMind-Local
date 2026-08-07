const ZHIPU_URL = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';
export const ZHIPU_VISION_MODEL = 'glm-4.6v';
export const ZHIPU_VISION_FALLBACK_MODEL = 'glm-4.6v-flash';
const MAX_IMAGES = 8;
const RETRY_DELAYS_MS = [1_200, 3_000];

type ZhipuResponse = {
  choices?: Array<{
    message?: {
      content?: string | null;
    };
  }>;
};

export async function analyzeImagesWithZhipu(
  apiKey: string,
  input: {
    title: string;
    caption: string;
    images: string[];
  },
): Promise<{ text: string; model: string }> {
  const images = input.images.slice(0, MAX_IMAGES);
  if (images.length === 0) return { text: '', model: ZHIPU_VISION_MODEL };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45_000);
  try {
    let lastError: unknown;
    for (const model of [
      ZHIPU_VISION_MODEL,
      ZHIPU_VISION_FALLBACK_MODEL,
    ]) {
      try {
        for (let attempt = 0; ; attempt += 1) {
          const response = await fetch(ZHIPU_URL, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${apiKey}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              model,
              thinking: { type: 'disabled' },
              temperature: 0.1,
              max_tokens: 1800,
              messages: [
                {
                  role: 'user',
                  content: [
                    ...images.map((url) => ({
                      type: 'image_url',
                      image_url: { url },
                    })),
                    {
                      type: 'text',
                      text: visionPrompt(
                        input.title,
                        input.caption,
                        images.length,
                      ),
                    },
                  ],
                },
              ],
            }),
            signal: controller.signal,
          });
          if (!response.ok) {
            const message = await readZhipuError(response);
            if (
              (response.status === 429 || response.status >= 500) &&
              attempt < RETRY_DELAYS_MS.length
            ) {
              await delay(RETRY_DELAYS_MS[attempt], controller.signal);
              continue;
            }
            throw new Error(`Zhipu returned ${response.status}: ${message}`);
          }
          const payload = (await response.json()) as ZhipuResponse;
          const content = payload.choices?.[0]?.message?.content?.trim() ?? '';
          if (content.length < 20) {
            throw new Error('Zhipu returned an empty visual analysis');
          }
          return { text: content.slice(0, 12_000), model };
        }
      } catch (error) {
        if (controller.signal.aborted) throw error;
        lastError = error;
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error('Zhipu visual analysis failed');
  } finally {
    clearTimeout(timer);
  }
}

async function readZhipuError(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as {
      error?: { code?: unknown; message?: unknown };
    };
    const code =
      typeof payload.error?.code === 'string' ? payload.error.code : '';
    const message =
      typeof payload.error?.message === 'string'
        ? payload.error.message
        : 'request failed';
    return code ? `${code} ${message}` : message;
  } catch {
    return 'request failed';
  }
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new DOMException('Aborted', 'AbortError'));
      },
      { once: true },
    );
  });
}

function visionPrompt(
  title: string,
  caption: string,
  imageCount: number,
): string {
  return `
你是 ReMind 的图片观察助手。请分析以上 ${imageCount} 张按顺序排列的
小红书配图。标题和作者文案只用于理解语境，不能替代你对图片的观察：

标题：${title}
作者文案：${caption}

要求：
1. 按“### 图片 1”到“### 图片 ${imageCount}”逐张输出。
2. 每张只记录有助于理解主题的可见事实，例如产品结构、实际玩法、步骤、
   示例、数据或画面中的关键信息。纯装饰性的颜色、构图、背景和摆拍方式，
   除非它们正是内容主题，否则不要记录。
3. 如果图片中有清晰可辨且有信息量的文字，增加“可见文字：……”；看不清
   就不要猜，不要抄录装饰性品牌字样。
4. 与前图信息重复时只写“无新增信息”，不要换一种说法重复描述。
5. 最后增加“### 跨图重点”，最多列出 5 条多张图片共同呈现的结构、流程、
   差异或结论，并注明由哪些图片支持。
6. 不评价营销效果，不复述作者文案，不补充图片中看不到的事实。
7. 使用简洁中文 Markdown，总长度不超过 1000 字。
`.trim();
}
