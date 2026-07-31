import { lookup } from 'node:dns/promises';
import { request as requestHttp } from 'node:http';
import { request as requestHttps } from 'node:https';
import { BlockList, isIP } from 'node:net';
import {
  brotliDecompressSync,
  gunzipSync,
  inflateSync,
} from 'node:zlib';

const MAX_PAGE_BYTES = 2_000_000;
const MAX_EXTRACTED_TEXT = 24_000;
const MAX_REDIRECTS = 4;
const MAX_XHS_IMAGES = 12;
const REQUEST_TIMEOUT_MS = 15_000;

export type LinkSnapshot = {
  url: string;
  title: string;
  description: string;
  site: string;
  text: string;
  images: string[];
  platform: 'web' | 'xiaohongshu';
  mediaType: 'web' | 'image' | 'video';
  durationSeconds: number | null;
  transientVideoUrl?: string;
};

export interface LinkPageFetcher {
  fetch(url: string, signal: AbortSignal): Promise<LinkSnapshot>;
}

export class SecureLinkPageFetcher implements LinkPageFetcher {
  async fetch(inputUrl: string, signal: AbortSignal): Promise<LinkSnapshot> {
    let current = validatePublicLinkUrl(inputUrl);
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
      const response = await requestPublicPage(current, signal);
      if (response.status >= 300 && response.status < 400) {
        if (!response.location || redirects === MAX_REDIRECTS) {
          throw new Error('link_redirect_invalid');
        }
        current = validatePublicLinkUrl(
          new URL(response.location, current).toString(),
        );
        continue;
      }
      if (response.status < 200 || response.status >= 300) {
        throw new Error(`link_http_${response.status}`);
      }
      if (!response.contentType.includes('text/html')) {
        throw new Error('link_not_html');
      }
      return extractLinkSnapshot(current, response.body);
    }
    throw new Error('link_redirect_invalid');
  }
}

export function validatePublicLinkUrl(value: string): string {
  if (value.length > 2_048) throw new Error('link_url_too_long');
  const url = new URL(value);
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username ||
    url.password
  ) {
    throw new Error('link_url_invalid');
  }
  const expectedPort = url.protocol === 'https:' ? '443' : '80';
  if (url.port && url.port !== expectedPort) {
    throw new Error('link_port_not_allowed');
  }
  const hostname = normalizedHostname(url.hostname);
  if (isBlockedHostname(hostname) || isBlockedAddress(hostname)) {
    throw new Error('link_private_network');
  }
  url.hash = '';
  return url.toString();
}

export function extractLinkSnapshot(
  finalUrlValue: string,
  html: string,
): LinkSnapshot {
  const finalUrl = new URL(validatePublicLinkUrl(finalUrlValue));
  if (isXiaohongshuHost(finalUrl.hostname)) {
    return extractXiaohongshuSnapshot(finalUrl, html);
  }
  if (
    finalUrl.hostname === 'open.weixin.qq.com' ||
    finalUrl.pathname.startsWith('/404/')
  ) {
    throw new Error('link_verification_page');
  }

  const title = cleanText(
    matchFirst(html, /<title[^>]*>([\s\S]*?)<\/title>/i) ||
      matchFirst(
        html,
        /<h1[^>]+id=["']activity-name["'][^>]*>([\s\S]*?)<\/h1>/i,
      ) ||
      matchFirst(html, /var\s+msg_title\s*=\s*['"]([^'"]+)['"]/i),
  ).slice(0, 300);
  const description = cleanText(
    metaValues(html, 'description')[0] ??
      metaValues(html, 'og:description')[0] ??
      '',
  ).slice(0, 600);
  const withoutNoise = html
    .replace(
      /<(script|style|noscript|svg|template)[^>]*>[\s\S]*?<\/\1>/gi,
      ' ',
    )
    .replace(/<!--[\s\S]*?-->/g, ' ');
  const text = cleanText(withoutNoise.replace(/<[^>]+>/g, ' ')).slice(
    0,
    MAX_EXTRACTED_TEXT,
  );
  if (!title && !description && text.length < 80) {
    throw new Error('link_no_readable_content');
  }
  return {
    url: finalUrl.toString(),
    title: title || finalUrl.hostname,
    description,
    site: finalUrl.hostname.replace(/^www\./, '').slice(0, 255),
    text,
    images: [],
    platform: 'web',
    mediaType: 'web',
    durationSeconds: null,
  };
}

async function requestPublicPage(
  urlValue: string,
  signal: AbortSignal,
): Promise<{
  status: number;
  location: string | null;
  contentType: string;
  body: string;
}> {
  const url = new URL(validatePublicLinkUrl(urlValue));
  const addresses = await lookup(url.hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some((item) => isBlockedAddress(item.address))) {
    throw new Error('link_private_network');
  }
  const address = addresses[0];
  if (!address) throw new Error('link_dns_failed');

  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? requestHttps : requestHttp;
    const request = transport(
      {
        protocol: url.protocol,
        hostname: address.address,
        family: address.family,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        servername: url.hostname,
        headers: {
          Accept: 'text/html,application/xhtml+xml',
          'Accept-Encoding': 'gzip, deflate, br',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.7',
          Host: url.host,
          'User-Agent':
            'Mozilla/5.0 (Linux; Android 13; Mobile) AppleWebKit/537.36 ' +
            'Chrome/138.0.0.0 Mobile Safari/537.36',
        },
      },
      (response) => {
        const status = response.statusCode ?? 0;
        const location =
          typeof response.headers.location === 'string'
            ? response.headers.location
            : null;
        const contentType = String(response.headers['content-type'] ?? '')
          .toLowerCase();
        if (status >= 300 && status < 400) {
          response.resume();
          resolve({ status, location, contentType, body: '' });
          return;
        }
        const declaredLength = Number(response.headers['content-length'] ?? 0);
        if (
          Number.isFinite(declaredLength) &&
          declaredLength > MAX_PAGE_BYTES
        ) {
          response.destroy(new Error('link_page_too_large'));
          return;
        }
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on('data', (chunk: Buffer) => {
          bytes += chunk.byteLength;
          if (bytes > MAX_PAGE_BYTES) {
            response.destroy(new Error('link_page_too_large'));
            return;
          }
          chunks.push(chunk);
        });
        response.once('error', reject);
        response.once('end', () => {
          try {
            const body = decodeResponseBody(
              Buffer.concat(chunks),
              String(response.headers['content-encoding'] ?? ''),
            );
            resolve({ status, location, contentType, body });
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    const abort = () => request.destroy(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    request.setTimeout(REQUEST_TIMEOUT_MS, () => {
      request.destroy(new Error('link_request_timeout'));
    });
    request.once('error', reject);
    request.once('close', () => {
      signal.removeEventListener('abort', abort);
    });
    request.end();
  });
}

function decodeResponseBody(buffer: Buffer, encoding: string): string {
  const normalized = encoding.trim().toLowerCase();
  let decoded: Buffer;
  if (!normalized || normalized === 'identity') {
    decoded = buffer;
  } else if (normalized === 'gzip') {
    decoded = gunzipSync(buffer, { maxOutputLength: MAX_PAGE_BYTES });
  } else if (normalized === 'deflate') {
    decoded = inflateSync(buffer, { maxOutputLength: MAX_PAGE_BYTES });
  } else if (normalized === 'br') {
    decoded = brotliDecompressSync(buffer, {
      maxOutputLength: MAX_PAGE_BYTES,
    });
  } else {
    throw new Error('link_content_encoding_unsupported');
  }
  if (decoded.byteLength > MAX_PAGE_BYTES) {
    throw new Error('link_page_too_large');
  }
  return decoded.toString('utf8');
}

function extractXiaohongshuSnapshot(finalUrl: URL, html: string): LinkSnapshot {
  if (finalUrl.pathname.startsWith('/404/')) {
    throw new Error('link_verification_page');
  }
  const primaryNote = xiaohongshuPrimaryNoteFragment(html);
  const title =
    metaValues(html, 'og:title').map(cleanText).find(Boolean) ||
    cleanText(jsonStringField(primaryNote, 'title')) ||
    cleanText(matchFirst(html, /<title[^>]*>([\s\S]*?)<\/title>/i));
  const descriptions = metaValues(html, 'og:description')
    .map(cleanText)
    .filter(
      (value) =>
        value.length >= 20 && !value.includes('亿人的生活经验，都在小红书'),
    )
    .sort((left, right) => right.length - left.length);
  const embeddedDescription = cleanText(jsonStringField(primaryNote, 'desc'));
  if (embeddedDescription.length >= 20) descriptions.unshift(embeddedDescription);
  const text = descriptions[0]?.slice(0, MAX_EXTRACTED_TEXT) ?? '';
  const transientVideoUrl = extractXiaohongshuVideoUrl(primaryNote);
  const images = transientVideoUrl
    ? []
    : [
        ...new Set(
          metaValues(html, 'og:image')
            .map((value) => normalizeXiaohongshuMediaUrl(value, finalUrl))
            .filter((value): value is string => value !== null),
        ),
      ].slice(0, MAX_XHS_IMAGES);
  if (!title || text.length < 20) {
    throw new Error('link_no_readable_content');
  }
  return {
    url: finalUrl.toString(),
    title: title.replace(/\s*-\s*小红书\s*$/, '').slice(0, 300),
    description: '',
    site: 'xiaohongshu.com',
    text,
    images,
    platform: 'xiaohongshu',
    mediaType: transientVideoUrl ? 'video' : 'image',
    durationSeconds: transientVideoUrl
      ? extractXiaohongshuDurationSeconds(primaryNote)
      : null,
    transientVideoUrl: transientVideoUrl ?? undefined,
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
    if (
      (url.protocol !== 'http:' && url.protocol !== 'https:') ||
      !isXiaohongshuCdnHost(url.hostname)
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
  return candidates.length ? Math.round(Math.max(...candidates)) : null;
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
  for (const match of html.matchAll(nameFirst)) {
    if (match[1]) values.push(match[1]);
  }
  for (const match of html.matchAll(contentFirst)) {
    if (match[1]) values.push(match[1]);
  }
  return values;
}

function normalizeXiaohongshuMediaUrl(
  value: string,
  base: URL,
): string | null {
  try {
    const resolved = new URL(decodeEntities(value), base);
    if (
      (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') ||
      !isXiaohongshuCdnHost(resolved.hostname)
    ) {
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
    normalized.endsWith('.xiaohongshu.com') ||
    normalized === 'xhslink.cn' ||
    normalized.endsWith('.xhslink.cn')
  );
}

function xiaohongshuPrimaryNoteFragment(html: string): string {
  for (const marker of [
    '"data":{"noteData":',
    '"LAUNCHER_SSR_STORE_PAGE_DATA":{"noteData":',
  ]) {
    const start = html.indexOf(marker);
    if (start >= 0) return html.slice(start, start + 500_000);
  }
  return html;
}

function jsonStringField(value: string, field: string): string {
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = value.match(
    new RegExp(`"${escaped}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`, 'i'),
  );
  if (!match?.[1]) return '';
  try {
    return JSON.parse(`"${match[1]}"`) as string;
  } catch {
    return match[1]
      .replace(/\\u002F/gi, '/')
      .replace(/\\u0026/gi, '&')
      .replace(/\\\//g, '/');
  }
}

function isXiaohongshuCdnHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === 'xhscdn.com' || normalized.endsWith('.xhscdn.com');
}

function normalizedHostname(value: string): string {
  return value.toLowerCase().replace(/^\[|\]$/g, '');
}

function isBlockedHostname(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal') ||
    hostname.endsWith('.home.arpa') ||
    hostname === 'metadata.google.internal'
  );
}

const blockedV4 = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
] as const) {
  blockedV4.addSubnet(network, prefix, 'ipv4');
}

const blockedV6 = new BlockList();
for (const [network, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['::ffff:0:0', 96],
  ['100::', 64],
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  blockedV6.addSubnet(network, prefix, 'ipv6');
}

function isBlockedAddress(value: string): boolean {
  const address = normalizedHostname(value);
  const family = isIP(address);
  if (family === 4) return blockedV4.check(address, 'ipv4');
  if (family === 6) {
    const firstHextet = Number.parseInt(address.split(':', 1)[0] ?? '', 16);
    const globallyRoutable =
      Number.isFinite(firstHextet) &&
      firstHextet >= 0x2000 &&
      firstHextet <= 0x3fff;
    return !globallyRoutable || blockedV6.check(address, 'ipv6');
  }
  return false;
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
