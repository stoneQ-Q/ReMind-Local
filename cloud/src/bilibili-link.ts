import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  extractVideoAudioSegments,
  type ExtractedAudioSegment,
} from './video-audio-segments.js';

const API_ORIGIN = 'https://api.bilibili.com';
const MAX_JSON_BYTES = 6_000_000;
const MAX_AUDIO_BYTES = 250_000_000;
const MAX_DURATION_SECONDS = 6 * 60 * 60;
const USER_AGENT =
  'Mozilla/5.0 (Linux; Android 13; Mobile) AppleWebKit/537.36 ' +
  'Chrome/138.0.0.0 Mobile Safari/537.36';

type FetchLike = typeof fetch;

export type BilibiliTranscript = {
  transcript: string;
  segments: Array<{
    startSeconds: number;
    endSeconds: number;
    text: string;
    speakerId: null;
  }>;
  billableDurationSeconds: null;
};

export type BilibiliSnapshot = {
  url: string;
  title: string;
  description: string;
  site: 'bilibili.com';
  text: string;
  images: [];
  platform: 'bilibili';
  mediaType: 'video';
  durationSeconds: number;
  transientAudioUrl?: string;
  embeddedTranscript?: BilibiliTranscript;
};

export function isBilibiliHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return (
    normalized === 'bilibili.com' ||
    normalized.endsWith('.bilibili.com') ||
    normalized === 'b23.tv' ||
    normalized.endsWith('.b23.tv')
  );
}

export function extractBilibiliVideoId(urlValue: string, html = ''): string | null {
  const candidates = [urlValue, html];
  for (const candidate of candidates) {
    const match = candidate.match(/\b(BV[0-9A-Za-z]{10,16})\b/i);
    if (match?.[1]) return `BV${match[1].slice(2)}`;
  }
  return null;
}

export async function fetchBilibiliSnapshot(
  finalUrl: URL,
  html: string,
  signal: AbortSignal,
  fetcher: FetchLike = fetch,
): Promise<BilibiliSnapshot | null> {
  const bvid = extractBilibiliVideoId(finalUrl.toString(), html);
  if (!bvid) return null;
  const referer = `https://www.bilibili.com/video/${encodeURIComponent(bvid)}`;
  const view = await requestApi(
    `/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`,
    referer,
    signal,
    fetcher,
  );
  const viewData = apiData(view, 'link_bilibili_view');
  const cid = positiveInteger(viewData.cid);
  const durationSeconds = positiveInteger(viewData.duration);
  const title = stringValue(viewData.title).trim().slice(0, 300);
  if (!cid || !durationSeconds || durationSeconds > MAX_DURATION_SECONDS || !title) {
    throw new Error('link_bilibili_metadata_invalid');
  }
  const description = stringValue(viewData.desc).trim();
  const ownerName = stringValue(recordValue(viewData.owner).name).trim();
  const page = await requestApi(
    `/x/player/v2?bvid=${encodeURIComponent(bvid)}&cid=${cid}`,
    referer,
    signal,
    fetcher,
  ).catch(() => null);
  const subtitleUrl = page ? preferredSubtitleUrl(page) : null;
  const embeddedTranscript = subtitleUrl
    ? await fetchSubtitle(subtitleUrl, referer, signal, fetcher).catch(() => null)
    : null;
  let transientAudioUrl: string | undefined;
  if (!embeddedTranscript) {
    const play = await requestApi(
      `/x/player/playurl?bvid=${encodeURIComponent(bvid)}&cid=${cid}&fnval=16&qn=64`,
      referer,
      signal,
      fetcher,
    );
    transientAudioUrl = selectBilibiliAudioUrl(play) ?? undefined;
    if (!transientAudioUrl) throw new Error('link_bilibili_audio_unavailable');
  }
  const text = [
    ownerName ? `UP主：${ownerName}` : '',
    `时长：${formatDuration(durationSeconds)}`,
    description ? `视频简介：\n${description}` : '',
  ]
    .filter(Boolean)
    .join('\n\n')
    .slice(0, 24_000);
  return {
    url: referer,
    title,
    description: description.slice(0, 600),
    site: 'bilibili.com',
    text,
    images: [],
    platform: 'bilibili',
    mediaType: 'video',
    durationSeconds,
    transientAudioUrl,
    embeddedTranscript: embeddedTranscript ?? undefined,
  };
}

export class SecureBilibiliAudioFetcher {
  constructor(private readonly fetcher: FetchLike = fetch) {}

  async fetch(
    inputUrl: string,
    signal: AbortSignal,
    sourceUrl = 'https://www.bilibili.com/',
  ): Promise<{ segments: ExtractedAudioSegment[] }> {
    let current = validateBilibiliAudioUrl(inputUrl);
    const referer = validateBilibiliReferer(sourceUrl);
    for (let redirects = 0; redirects <= 2; redirects += 1) {
      const response = await this.fetcher(current, {
        redirect: 'manual',
        headers: {
          Accept: 'audio/mp4,video/mp4,application/octet-stream;q=0.9',
          Range: 'bytes=0-',
          Referer: referer,
          'User-Agent': USER_AGENT,
        },
        signal,
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location || redirects === 2) {
          throw new Error('link_bilibili_audio_redirect_invalid');
        }
        current = validateBilibiliAudioUrl(new URL(location, current).toString());
        continue;
      }
      if (!response.ok) throw new Error(`link_bilibili_audio_http_${response.status}`);
      const declaredLength = Number(response.headers.get('content-length') ?? 0);
      if (Number.isFinite(declaredLength) && declaredLength > MAX_AUDIO_BYTES) {
        throw new Error('link_bilibili_audio_too_large');
      }
      const content = Buffer.from(await response.arrayBuffer());
      if (!content.byteLength) throw new Error('link_bilibili_audio_empty');
      if (content.byteLength > MAX_AUDIO_BYTES) {
        throw new Error('link_bilibili_audio_too_large');
      }
      const directory = await mkdtemp(join(tmpdir(), 'remind-bilibili-audio-'));
      try {
        const sourcePath = join(directory, 'source.m4s');
        await writeFile(sourcePath, content, { mode: 0o600 });
        return { segments: await extractVideoAudioSegments(sourcePath, signal) };
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
    throw new Error('link_bilibili_audio_redirect_invalid');
  }
}

export function selectBilibiliAudioUrl(payload: unknown): string | null {
  const data = apiData(payload, 'link_bilibili_playurl');
  const dash = recordValue(data.dash);
  const audio = Array.isArray(dash.audio) ? dash.audio : [];
  const candidates: Array<{ url: string; preferred: number; bandwidth: number }> = [];
  for (const item of audio.map(recordValue)) {
    const values = [item.baseUrl, item.base_url];
    if (Array.isArray(item.backupUrl)) values.push(...item.backupUrl);
    if (Array.isArray(item.backup_url)) values.push(...item.backup_url);
    for (const value of values) {
      if (typeof value !== 'string') continue;
      try {
        const url = validateBilibiliAudioUrl(value);
        const parsed = new URL(url);
        candidates.push({
          url,
          preferred:
            parsed.port === '8082' || parsed.hostname.includes('.mcdn.') ? 0 : 1,
          bandwidth: numberValue(item.bandwidth),
        });
      } catch {
        // Try the next CDN candidate.
      }
    }
  }
  candidates.sort(
    (left, right) =>
      left.preferred - right.preferred || right.bandwidth - left.bandwidth,
  );
  return candidates[0]?.url ?? null;
}

async function requestApi(
  path: string,
  referer: string,
  signal: AbortSignal,
  fetcher: FetchLike,
): Promise<unknown> {
  const response = await fetcher(`${API_ORIGIN}${path}`, {
    redirect: 'error',
    headers: {
      Accept: 'application/json',
      Referer: referer,
      'User-Agent': USER_AGENT,
    },
    signal,
  });
  if (!response.ok) throw new Error(`link_bilibili_api_http_${response.status}`);
  return readLimitedJson(response);
}

async function fetchSubtitle(
  url: string,
  referer: string,
  signal: AbortSignal,
  fetcher: FetchLike,
): Promise<BilibiliTranscript> {
  const response = await fetcher(validateSubtitleUrl(url), {
    redirect: 'error',
    headers: { Accept: 'application/json', Referer: referer, 'User-Agent': USER_AGENT },
    signal,
  });
  if (!response.ok) throw new Error(`link_bilibili_subtitle_http_${response.status}`);
  const payload = recordValue(await readLimitedJson(response));
  const body = Array.isArray(payload.body) ? payload.body : [];
  const segments = body
    .map(recordValue)
    .map((item) => ({
      startSeconds: numberValue(item.from),
      endSeconds: numberValue(item.to),
      text: stringValue(item.content).trim(),
      speakerId: null as null,
    }))
    .filter(
      (item) =>
        Number.isFinite(item.startSeconds) &&
        Number.isFinite(item.endSeconds) &&
        item.endSeconds >= item.startSeconds &&
        Boolean(item.text),
    )
    .slice(0, 20_000);
  if (!segments.length) throw new Error('link_bilibili_subtitle_empty');
  return {
    transcript: segments.map((item) => item.text).join('\n').slice(0, 2_000_000),
    segments,
    billableDurationSeconds: null,
  };
}

function preferredSubtitleUrl(payload: unknown): string | null {
  const data = apiData(payload, 'link_bilibili_player');
  const subtitle = recordValue(data.subtitle);
  const values = Array.isArray(subtitle.subtitles)
    ? subtitle.subtitles.map(recordValue)
    : [];
  values.sort((left, right) => subtitleRank(left) - subtitleRank(right));
  for (const item of values) {
    const value = stringValue(item.subtitle_url);
    if (!value) continue;
    try {
      return validateSubtitleUrl(value);
    } catch {
      // Ignore subtitle URLs outside Bilibili's subtitle CDN.
    }
  }
  return null;
}

function subtitleRank(item: Record<string, unknown>): number {
  const language = `${stringValue(item.lan)} ${stringValue(item.lan_doc)}`.toLowerCase();
  if (language.includes('zh-cn') || language.includes('中文') || language.includes('汉语')) return 0;
  if (language.includes('zh') || language.includes('中文')) return 1;
  return 2;
}

function validateSubtitleUrl(value: string): string {
  const normalized = value.startsWith('//') ? `https:${value}` : value;
  const url = new URL(normalized);
  const host = url.hostname.toLowerCase();
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    (url.port && url.port !== '443') ||
    (host !== 'hdslb.com' && !host.endsWith('.hdslb.com'))
  ) {
    throw new Error('link_bilibili_subtitle_url_invalid');
  }
  url.hash = '';
  return url.toString();
}

function validateBilibiliAudioUrl(value: string): string {
  const url = new URL(value);
  const host = url.hostname.toLowerCase();
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    (url.port && url.port !== '443' && url.port !== '8082') ||
    !(
      host === 'bilivideo.com' ||
      host.endsWith('.bilivideo.com') ||
      host === 'bilivideo.cn' ||
      host.endsWith('.bilivideo.cn')
    )
  ) {
    throw new Error('link_bilibili_audio_url_invalid');
  }
  url.hash = '';
  return url.toString();
}

function validateBilibiliReferer(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !isBilibiliHost(url.hostname)) {
    throw new Error('link_bilibili_referer_invalid');
  }
  url.hash = '';
  return url.toString();
}

async function readLimitedJson(response: Response): Promise<unknown> {
  const declaredLength = Number(response.headers.get('content-length') ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_JSON_BYTES) {
    throw new Error('link_bilibili_response_too_large');
  }
  const content = Buffer.from(await response.arrayBuffer());
  if (content.byteLength > MAX_JSON_BYTES) {
    throw new Error('link_bilibili_response_too_large');
  }
  try {
    return JSON.parse(content.toString('utf8')) as unknown;
  } catch {
    throw new Error('link_bilibili_response_invalid');
  }
}

function apiData(payload: unknown, prefix: string): Record<string, unknown> {
  const root = recordValue(payload);
  const code = numberValue(root.code);
  if (code !== 0) throw new Error(`${prefix}_${Number.isFinite(code) ? code : 'invalid'}`);
  return recordValue(root.data);
}

function recordValue(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : Number.NaN;
}

function positiveInteger(value: unknown): number | null {
  const number = numberValue(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.ceil((seconds % 3_600) / 60);
  return hours > 0 ? `${hours} 小时 ${minutes} 分钟` : `${minutes} 分钟`;
}
