const MAX_PAGE_BYTES = 2_000_000;
const MAX_EXTRACTED_TEXT = 24_000;
const MAX_REDIRECTS = 4;

export type LinkPage = {
  url: string;
  title: string;
  description: string;
  site: string;
  text: string;
};

export async function fetchLinkPage(inputUrl: string): Promise<LinkPage> {
  let current = validatePublicLinkUrl(inputUrl);

  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    let response: Response;
    try {
      response = await fetch(current, {
        headers: {
          Accept: 'text/html,application/xhtml+xml',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.7',
          'User-Agent':
            'Mozilla/5.0 (Linux; Android 13; Mobile) AppleWebKit/537.36 MicroMessenger/8.0.50',
        },
        redirect: 'manual',
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('Location');
      if (!location || redirects === MAX_REDIRECTS) {
        throw new Error('Too many or invalid redirects');
      }
      current = validatePublicLinkUrl(new URL(location, current).toString());
      continue;
    }
    if (!response.ok) throw new Error(`Page returned ${response.status}`);
    const contentType = response.headers.get('Content-Type')?.toLowerCase() ?? '';
    if (!contentType.includes('text/html')) {
      throw new Error('Link is not an HTML page');
    }
    const html = await readTextWithLimit(response, MAX_PAGE_BYTES);
    return extractPage(current, html);
  }

  throw new Error('Unable to fetch link');
}

export function validatePublicLinkUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Only HTTP links are supported');
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname === 'metadata.google.internal' ||
    isPrivateIp(hostname)
  ) {
    throw new Error('Private network links are not supported');
  }
  url.username = '';
  url.password = '';
  return url.toString();
}

function isPrivateIp(hostname: string): boolean {
  if (hostname.includes(':')) {
    return (
      hostname === '::1' ||
      hostname === '::' ||
      hostname.startsWith('fc') ||
      hostname.startsWith('fd') ||
      hostname.startsWith('fe8') ||
      hostname.startsWith('fe9') ||
      hostname.startsWith('fea') ||
      hostname.startsWith('feb')
    );
  }
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname)) return false;
  const parts = hostname.split('.').map(Number);
  if (parts.some((part) => part < 0 || part > 255)) return true;
  return (
    parts[0] === 0 ||
    parts[0] === 10 ||
    parts[0] === 127 ||
    (parts[0] === 169 && parts[1] === 254) ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168) ||
    parts[0] >= 224
  );
}

async function readTextWithLimit(
  response: Response,
  limit: number,
): Promise<string> {
  const length = Number(response.headers.get('Content-Length') ?? 0);
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
    if (length > limit || value.byteLength > remaining || bytes >= limit) {
      await reader.cancel();
      break;
    }
  }
  return text + decoder.decode();
}

function extractPage(url: string, html: string): LinkPage {
  const title = cleanText(
    matchFirst(html, /<title[^>]*>([\s\S]*?)<\/title>/i) ||
      matchFirst(html, /var\s+msg_title\s*=\s*['"]([^'"]+)['"]/i),
  ).slice(0, 300);
  const description = cleanText(
    matchFirst(
      html,
      /<meta[^>]+(?:name|property)=["'](?:description|og:description)["'][^>]+content=["']([^"']*)["'][^>]*>/i,
    ) ||
      matchFirst(
        html,
        /<meta[^>]+content=["']([^"']*)["'][^>]+(?:name|property)=["'](?:description|og:description)["'][^>]*>/i,
      ),
  ).slice(0, 600);
  const withoutNoise = html
    .replace(/<(script|style|noscript|svg|template)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
  const text = cleanText(withoutNoise.replace(/<[^>]+>/g, ' ')).slice(
    0,
    MAX_EXTRACTED_TEXT,
  );
  if (!title && !description && text.length < 80) {
    throw new Error(
      `Page has no readable content (html=${html.length}, text=${text.length})`,
    );
  }
  return {
    url,
    title: title || new URL(url).hostname,
    description,
    site: new URL(url).hostname.replace(/^www\./, ''),
    text,
  };
}

function matchFirst(value: string, pattern: RegExp): string {
  return value.match(pattern)?.[1] ?? '';
}

function cleanText(value: string): string {
  return decodeEntities(value).replace(/\s+/g, ' ').trim();
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
