const MAX_PAGE_BYTES = 2_000_000;
const MAX_TEXT_LENGTH = 24_000;
const MAX_XHS_IMAGES = 12;

export type LinkSnapshot = {
  title: string;
  site: string;
  text: string;
  images: string[];
  platform: 'web' | 'xiaohongshu';
  mediaType: 'web' | 'image' | 'video';
  durationSeconds: number | null;
  transientVideoUrl?: string;
};

const DESKTOP_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/138.0.0.0 Safari/537.36';

export async function readLinkSnapshot(urlValue: string): Promise<LinkSnapshot> {
  const url = new URL(urlValue);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('只支持 HTTP 链接');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(url, {
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.7',
        'User-Agent': DESKTOP_USER_AGENT,
      },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`网页返回 ${response.status}`);
    const html = await readLimitedText(response, MAX_PAGE_BYTES);
    return extractLinkSnapshot(response.url || url.toString(), html);
  } finally {
    clearTimeout(timer);
  }
}

export function extractLinkSnapshot(
  finalUrlValue: string,
  html: string,
): LinkSnapshot {
  const finalUrl = new URL(finalUrlValue);
  if (isXiaohongshuHost(finalUrl.hostname)) {
    return extractXiaohongshuSnapshot(finalUrl, html);
  }
  if (
    finalUrl.hostname === 'open.weixin.qq.com' ||
    finalUrl.pathname.startsWith('/404/')
  ) {
    throw new Error('网页进入了登录或安全验证页面');
  }

  const title = cleanText(
    matchFirst(html, /<title[^>]*>([\s\S]*?)<\/title>/i) ||
      matchFirst(
        html,
        /<h1[^>]+id=["']activity-name["'][^>]*>([\s\S]*?)<\/h1>/i,
      ) ||
      matchFirst(html, /var\s+msg_title\s*=\s*['"]([^'"]+)['"]/i),
  ).slice(0, 300);
  const withoutNoise = html
    .replace(
      /<(script|style|noscript|svg|template)[^>]*>[\s\S]*?<\/\1>/gi,
      ' ',
    )
    .replace(/<!--[\s\S]*?-->/g, ' ');
  const text = cleanText(withoutNoise.replace(/<[^>]+>/g, ' ')).slice(
    0,
    MAX_TEXT_LENGTH,
  );
  if (text.length < 80) throw new Error('网页没有可读取正文');
  return {
    title: title || finalUrl.hostname,
    site: finalUrl.hostname.replace(/^www\./, ''),
    text,
    images: [],
    platform: 'web',
    mediaType: 'web',
    durationSeconds: null,
  };
}

function extractXiaohongshuSnapshot(
  finalUrl: URL,
  html: string,
): LinkSnapshot {
  if (finalUrl.pathname.startsWith('/404/')) {
    throw new Error('小红书链接进入了安全验证页面');
  }
  const title =
    metaValues(html, 'og:title').map(cleanText).find(Boolean) ??
    cleanText(matchFirst(html, /<title[^>]*>([\s\S]*?)<\/title>/i));
  const descriptions = metaValues(html, 'og:description')
    .map(cleanText)
    .filter(
      (value) =>
        value.length >= 20 && !value.includes('亿人的生活经验，都在小红书'),
    )
    .sort((left, right) => right.length - left.length);
  const text = descriptions[0]?.slice(0, MAX_TEXT_LENGTH) ?? '';
  const videoUrl = extractXiaohongshuVideoUrl(html);
  const images = videoUrl
    ? []
    : [
        ...new Set(
          metaValues(html, 'og:image')
            .map((value) => normalizeMediaUrl(value, finalUrl))
            .filter((value): value is string => value !== null)
            .filter((value) =>
              new URL(value).hostname.toLowerCase().endsWith('.xhscdn.com'),
            ),
        ),
      ].slice(0, MAX_XHS_IMAGES);

  if (!title || text.length < 20) {
    throw new Error('小红书页面没有返回可读取的笔记正文');
  }
  return {
    title: title.replace(/\s*-\s*小红书\s*$/, '').slice(0, 300),
    site: 'xiaohongshu.com',
    text,
    images,
    platform: 'xiaohongshu',
    mediaType: videoUrl ? 'video' : 'image',
    durationSeconds: videoUrl
      ? extractXiaohongshuDurationSeconds(html)
      : null,
    transientVideoUrl: videoUrl ?? undefined,
  };
}

function extractXiaohongshuVideoUrl(html: string): string | null {
  const raw = matchFirst(html, /"masterUrl"\s*:\s*"([^"]+)"/i);
  if (!raw) return null;
  try {
    const decoded = raw
      .replace(/\\u002F/gi, '/')
      .replace(/\\u0026/gi, '&')
      .replace(/\\\//g, '/');
    const url = new URL(decoded);
    const hostname = url.hostname.toLowerCase();
    if (
      (url.protocol !== 'http:' && url.protocol !== 'https:') ||
      (hostname !== 'xhscdn.com' && !hostname.endsWith('.xhscdn.com'))
    ) {
      return null;
    }
    url.protocol = 'https:';
    return url.toString();
  } catch {
    return null;
  }
}

function extractXiaohongshuDurationSeconds(html: string): number | null {
  const masterIndex = html.search(/"masterUrl"\s*:/i);
  if (masterIndex < 0) return null;
  const nearby = html.slice(
    Math.max(0, masterIndex - 1_500),
    Math.min(html.length, masterIndex + 1_500),
  );
  const candidates = [
    ...nearby.matchAll(/"(?:duration|videoDuration)"\s*:\s*(\d+)/gi),
  ]
    .map((match) => Number(match[1]))
    .filter(Number.isFinite)
    .map((value) => (value > 10_000 ? value / 1_000 : value))
    .filter((value) => value >= 1 && value <= 6 * 60 * 60);
  if (candidates.length === 0) return null;
  return Math.round(Math.max(...candidates));
}

function metaValues(html: string, key: string): string[] {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const values: string[] = [];
  const nameFirst = new RegExp(
    `<meta[^>]+(?:name|property)=["']${escaped}["'][^>]+content=["']([^"']*)["'][^>]*>`,
    'gi',
  );
  const contentFirst = new RegExp(
    `<meta[^>]+content=["']([^"']*)["'][^>]+(?:name|property)=["']${escaped}["'][^>]*>`,
    'gi',
  );
  for (const match of html.matchAll(nameFirst)) values.push(match[1]);
  for (const match of html.matchAll(contentFirst)) values.push(match[1]);
  return values;
}

function normalizeMediaUrl(value: string, base: URL): string | null {
  try {
    const resolved = new URL(decodeEntities(value), base);
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') {
      return null;
    }
    resolved.protocol = 'https:';
    return resolved.toString();
  } catch {
    return null;
  }
}

function isXiaohongshuHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return (
    normalized === 'xiaohongshu.com' ||
    normalized.endsWith('.xiaohongshu.com')
  );
}

async function readLimitedText(
  response: Response,
  limit: number,
): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const remaining = limit - bytes;
    if (remaining <= 0) {
      await reader.cancel();
      break;
    }
    const chunk =
      value.byteLength > remaining ? value.subarray(0, remaining) : value;
    bytes += chunk.byteLength;
    text += decoder.decode(chunk, { stream: true });
    if (value.byteLength > remaining || bytes >= limit) {
      await reader.cancel();
      break;
    }
  }
  return text + decoder.decode();
}

function matchFirst(value: string, pattern: RegExp): string {
  return value.match(pattern)?.[1] ?? '';
}

function cleanText(value: string): string {
  return decodeEntities(value)
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'");
}
