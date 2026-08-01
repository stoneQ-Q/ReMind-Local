import type { Pool } from 'pg';

import type { CredentialCipher } from './credential-cipher.js';
import { SecureLinkPageFetcher, validatePublicLinkUrl } from './link-page.js';
import { resolveMediaProviderCredential } from './media-provider-routing.js';

const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions';
const MODEL = 'deepseek-v4-flash';

type Source = { id: string; content: string; createdAt: string };
type Citation = {
  sourceId: string;
  quote: string;
  startOffset: number;
  endOffset: number;
};
type Draft = {
  title: string;
  summary: string;
  content: string;
  tags: string[];
  sourceIds: string[];
  citations: Citation[];
};

export class OrganizationError extends Error {
  constructor(readonly code: string, readonly status = 400) {
    super(code);
  }
}

export async function organizeDaily(
  pool: Pool,
  cipher: CredentialCipher,
  userId: string,
  body: unknown,
  signal: AbortSignal,
): Promise<{ drafts: Draft[]; ignoredSourceIds: string[]; model: string }> {
  const sources = parseSources(record(body)?.sources);
  if (!sources) throw new OrganizationError('invalid_request');
  const raw = await generateJson(
    await apiKey(pool, cipher, userId),
    DAILY_PROMPT,
    JSON.stringify({ sources }),
    signal,
  );
  return { ...validateDrafts(raw, sources), model: MODEL };
}

export async function organizeLink(
  pool: Pool,
  cipher: CredentialCipher,
  userId: string,
  body: unknown,
  signal: AbortSignal,
): Promise<{ drafts: Draft[]; ignoredSourceIds: string[]; model: string }> {
  const value = record(body);
  const sourceId = shortText(value?.sourceId, 128);
  const urlValue = shortText(value?.url, 2_048);
  const userContext = shortText(value?.userContext, 1_000);
  if (!sourceId || !urlValue || !userContext) {
    throw new OrganizationError('invalid_request');
  }
  const url = validatePublicLinkUrl(urlValue);
  let page = parsePage(value?.page);
  if (!page) {
    try {
      const snapshot = await new SecureLinkPageFetcher().fetch(url, signal);
      page = {
        title: snapshot.title,
        site: snapshot.site,
        text: snapshot.text,
      };
    } catch {
      throw new OrganizationError('link_unavailable', 422);
    }
  }
  const evidence = buildEvidence(page.text);
  if (!evidence.length) throw new OrganizationError('link_unavailable', 422);
  const sources: Source[] = [
    { id: sourceId, content: `${userContext}\n${url}`, createdAt: new Date().toISOString() },
  ];
  const key = await apiKey(pool, cipher, userId);
  const request = JSON.stringify({
    sourceId,
    url,
    userContext,
    page: { title: page.title, site: page.site },
    evidenceCandidates: evidence.map((item) => ({ id: item.id, text: item.quote })),
  });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const raw = await generateJson(
        key,
        attempt === 0 ? LINK_PROMPT : LINK_RETRY_PROMPT,
        request,
        signal,
      );
      const validated = validateDrafts(
        raw,
        sources,
        new Map([[sourceId, evidence]]),
      );
      if (validated.drafts.length !== 1) {
        throw new OrganizationError('ai_invalid_response', 502);
      }
      return {
        ...validated,
        model: MODEL,
      };
    } catch (error) {
      if (
        attempt === 0 &&
        error instanceof OrganizationError &&
        error.code === 'ai_invalid_response'
      ) {
        continue;
      }
      throw error;
    }
  }
  throw new OrganizationError('ai_invalid_response', 502);
}

export async function suggestThemeMerge(
  pool: Pool,
  cipher: CredentialCipher,
  userId: string,
  body: unknown,
  signal: AbortSignal,
): Promise<Record<string, unknown> & { model: string }> {
  const value = record(body);
  const source = parseThemeSource(value?.source);
  const themes = parseThemes(value?.themes);
  if (!source || !themes) throw new OrganizationError('invalid_request');
  const raw = record(
    await generateJson(
      await apiKey(pool, cipher, userId),
      THEME_PROMPT,
      JSON.stringify({ source, themes }),
      signal,
    ),
  );
  if (!raw) throw new OrganizationError('ai_invalid_response', 502);
  const allowed = new Map(themes.map((theme) => [theme.id, theme.title]));
  const requestedId = shortText(raw.themeId, 128, true);
  const themeId = requestedId && allowed.has(requestedId) ? requestedId : null;
  return {
    themeId,
    themeTitle: themeId ? allowed.get(themeId)! : requiredText(raw.themeTitle, 80),
    rationale: requiredText(raw.rationale, 300),
    patch: requiredText(raw.patch, 5_000),
    overview: requiredText(raw.overview, 5_000),
    conflicts: stringArray(raw.conflicts, 5, 300),
    model: MODEL,
  };
}

async function apiKey(pool: Pool, cipher: CredentialCipher, userId: string): Promise<string> {
  const credential = await resolveMediaProviderCredential(pool, cipher, {
    userId,
    provider: 'deepseek',
    reservedCostMicros: 0n,
  });
  return credential.apiKey;
}

async function generateJson(
  key: string,
  system: string,
  user: string,
  signal: AbortSignal,
): Promise<unknown> {
  const response = await fetch(DEEPSEEK_URL, {
    method: 'POST',
    redirect: 'error',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      thinking: { type: 'disabled' },
      temperature: 0.2,
      max_tokens: 3_000,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
    signal,
  });
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new OrganizationError('ai_auth_failed', 400);
    }
    if (response.status === 429) throw new OrganizationError('ai_rate_limited', 429);
    throw new OrganizationError('ai_provider_failed', 502);
  }
  const payload = record(await response.json());
  const choices = Array.isArray(payload?.choices) ? payload.choices : [];
  const message = record(record(choices[0])?.message);
  const content = shortText(message?.content, 30_000);
  if (!content) throw new OrganizationError('ai_invalid_response', 502);
  try {
    return JSON.parse(content) as unknown;
  } catch {
    throw new OrganizationError('ai_invalid_response', 502);
  }
}

function validateDrafts(
  value: unknown,
  sources: Source[],
  evidenceBySource = new Map<string, ReturnType<typeof buildEvidence>>(),
): { drafts: Draft[]; ignoredSourceIds: string[] } {
  const payload = record(value);
  if (!payload || !Array.isArray(payload.drafts)) {
    throw new OrganizationError('ai_invalid_response', 502);
  }
  const allowed = new Set(sources.map((source) => source.id));
  const drafts = payload.drafts.slice(0, 3).map((raw) => {
    const item = record(raw);
    if (!item) throw new OrganizationError('ai_invalid_response', 502);
    const sourceIds = stringArray(item.sourceIds, sources.length, 128).filter((id) => allowed.has(id));
    if (!sourceIds.length) throw new OrganizationError('ai_invalid_response', 502);
    const citations = evidenceBySource.size
      ? validateCitations(item.citations, sourceIds, evidenceBySource)
      : [];
    return {
      title: requiredText(item.title, 80),
      summary: shortText(item.summary, 300, true) ?? '',
      content: requiredText(item.content, 6_000),
      tags: stringArray(item.tags, 5, 30).map((tag) => tag.replace(/^#/, '')),
      sourceIds: [...new Set(sourceIds)],
      citations,
    };
  });
  const used = new Set(drafts.flatMap((draft) => draft.sourceIds));
  return { drafts, ignoredSourceIds: sources.map((source) => source.id).filter((id) => !used.has(id)) };
}

function validateCitations(
  value: unknown,
  sourceIds: string[],
  evidenceBySource: Map<string, ReturnType<typeof buildEvidence>>,
): Citation[] {
  if (!Array.isArray(value)) throw new OrganizationError('ai_invalid_response', 502);
  const allowed = new Set(sourceIds);
  const citations = value.slice(0, 6).map((raw) => {
    const item = record(raw);
    const sourceId = shortText(item?.sourceId, 128);
    const evidenceId = shortText(item?.evidenceId, 16);
    const evidence = sourceId && evidenceId
      ? evidenceBySource.get(sourceId)?.find((candidate) => candidate.id === evidenceId)
      : null;
    if (!sourceId || !allowed.has(sourceId) || !evidence) {
      throw new OrganizationError('ai_invalid_response', 502);
    }
    return { sourceId, quote: evidence.quote, startOffset: evidence.startOffset, endOffset: evidence.endOffset };
  });
  if (!citations.length) throw new OrganizationError('ai_invalid_response', 502);
  return citations;
}

function buildEvidence(text: string): Array<{ id: string; quote: string; startOffset: number; endOffset: number }> {
  const result = [];
  let start = 0;
  while (start < text.length && result.length < 60) {
    while (/\s/.test(text[start] ?? '')) start += 1;
    if (start >= text.length) break;
    let end = Math.min(start + 420, text.length);
    for (let index = end - 1; index >= Math.min(start + 120, end); index -= 1) {
      if (/[\n。！？；.!?;]/.test(text[index] ?? '')) { end = index + 1; break; }
    }
    const quote = text.slice(start, end).trimEnd();
    if (quote.replace(/\s/g, '').length >= 20) {
      result.push({ id: `E${result.length + 1}`, quote, startOffset: start, endOffset: start + quote.length });
    }
    start = Math.max(end, start + 1);
  }
  return result;
}

function parseSources(value: unknown): Source[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > 60) return null;
  const parsed: Source[] = [];
  for (const raw of value) {
    const item = record(raw);
    const id = shortText(item?.id, 128);
    const content = shortText(item?.content, 12_000);
    const createdAt = shortText(item?.createdAt, 64);
    if (!id || !content || !createdAt) return null;
    parsed.push({ id, content, createdAt });
  }
  return parsed;
}

function parsePage(value: unknown): { title: string; site: string; text: string } | null {
  const item = record(value);
  const title = shortText(item?.title, 300);
  const site = shortText(item?.site, 255);
  const text = shortText(item?.text, 24_000);
  return title && site && text ? { title, site, text } : null;
}

function parseThemeSource(value: unknown): Record<string, string | null> | null {
  const item = record(value);
  const id = shortText(item?.id, 128);
  const title = shortText(item?.title, 120);
  const content = shortText(item?.content, 12_000);
  if (!id || !title || !content) return null;
  return { id, title, summary: shortText(item?.summary, 500, true) ?? '', content, sourceUrl: shortText(item?.sourceUrl, 2_048, true) ?? null };
}

function parseThemes(value: unknown): Array<{ id: string; title: string; summary: string; content: string; overview: string }> | null {
  if (!Array.isArray(value) || value.length > 12) return null;
  const parsed = [];
  for (const raw of value) {
    const item = record(raw);
    const id = shortText(item?.id, 128);
    const title = shortText(item?.title, 120);
    if (!id || !title) return null;
    parsed.push({ id, title, summary: shortText(item?.summary, 500, true) ?? '', content: shortText(item?.content, 6_000, true) ?? '', overview: shortText(item?.overview, 5_000, true) ?? '' });
  }
  return parsed;
}

function requiredText(value: unknown, limit: number): string {
  const result = shortText(value, limit);
  if (!result) throw new OrganizationError('ai_invalid_response', 502);
  return result;
}
function shortText(value: unknown, limit: number, allowEmpty = false): string | null {
  if (typeof value !== 'string') return null;
  const result = value.trim().slice(0, limit);
  return result || (allowEmpty ? '' : null);
}
function stringArray(value: unknown, count: number, limit: number): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string').map((item) => item.trim().slice(0, limit)).filter(Boolean).slice(0, count)
    : [];
}
function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

const DAILY_PROMPT = `你是 ReMind 的每日整理助手。只依据输入碎片，最多生成 3 篇中文 Markdown 整理稿；测试词和无上下文短句放入 ignoredSourceIds。输出 JSON：{"drafts":[{"title":"","summary":"","content":"","tags":[],"sourceIds":[]}],"ignoredSourceIds":[]}。不要额外解释。`;
const LINK_PROMPT = `你是 ReMind 的链接整理助手。只依据 userContext、页面信息和 evidenceCandidates，围绕用户保存意图生成且只生成 1 篇中文 Markdown 笔记，包含内容概括、值得留下的内容、与我的关注点、原始来源。sourceIds 只能含 sourceId；citations 必须选择真实 evidenceId，1 到 6 条，不得改写证据。输出 JSON：{"drafts":[{"title":"","summary":"","content":"","tags":[],"sourceIds":[""],"citations":[{"sourceId":"","evidenceId":"E1"}]}],"ignoredSourceIds":[]}。不要额外解释。`;
const LINK_RETRY_PROMPT = `${LINK_PROMPT}\n上一次输出未通过结构校验。请严格逐字段遵循示例：只输出一个 drafts 元素；sourceIds 和每条 citation.sourceId 必须逐字复制输入 sourceId；citation.evidenceId 只能从输入 evidenceCandidates 的 id 中选择；title、content 均不得为空。`;
const THEME_PROMPT = `你是 ReMind 的主题笔记编辑助手。只依据输入，判断来源应加入哪个已有主题，或 themeId 为 null 新建长期主题。patch 只写增量，overview 写合并后的理解，冲突单列。输出 JSON：{"themeId":null,"themeTitle":"","rationale":"","patch":"","overview":"","conflicts":[]}。不要额外解释。`;
