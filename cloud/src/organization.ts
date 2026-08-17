import type { Pool } from 'pg';

import type { CredentialCipher } from './credential-cipher.js';
import { SecureLinkPageFetcher, validatePublicLinkUrl } from './link-page.js';
import {
  resolveMediaProviderCredential,
  type ManagedProviderCredentials,
} from './media-provider-routing.js';

const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions';
const MODEL = 'deepseek-v4-flash';

type Source = { id: string; title: string; content: string; createdAt: string };
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

export type OrganizationExecution = {
  managedCredentials?: ManagedProviderCredentials;
  reservedCostMicros?: bigint;
  onUsage?: (usage: {
    promptTokens: number;
    completionTokens: number;
  }) => void;
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
  execution: OrganizationExecution = {},
): Promise<{ drafts: Draft[]; ignoredSourceIds: string[]; model: string }> {
  const sources = parseSources(record(body)?.sources);
  if (!sources) throw new OrganizationError('invalid_request');
  const evidenceBySource = new Map(
    sources
      .map(
        (source) =>
          [source.id, buildEvidence(source.content).slice(0, 4)] as const,
      )
      .filter(([, evidence]) => evidence.length > 0),
  );
  const request = JSON.stringify({
    sources,
    evidenceCandidates: sources.map((source) => ({
      sourceId: source.id,
      items: (evidenceBySource.get(source.id) ?? []).map((item) => ({
          id: item.id,
          text: item.quote,
        })),
    })),
  });
  const key = await apiKey(pool, cipher, userId, execution);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const raw = await generateJson(
        key,
        attempt === 0 ? DAILY_PROMPT : DAILY_RETRY_PROMPT,
        request,
        signal,
        3_000,
        execution.onUsage,
      );
      const validated = validateDrafts(raw, sources, evidenceBySource);
      if (validated.drafts.length > 1) {
        throw new OrganizationError('ai_invalid_response', 502);
      }
      return { ...validated, model: MODEL };
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

export async function organizeLink(
  pool: Pool,
  cipher: CredentialCipher,
  userId: string,
  body: unknown,
  signal: AbortSignal,
  execution: OrganizationExecution = {},
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
  if (new URL(url).hostname.endsWith('xiaoyuzhoufm.com')) {
    page = await storedLinkPage(pool, userId, url);
  }
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
  const evidence = buildEvidence(page.text, 120);
  if (!evidence.length) throw new OrganizationError('link_unavailable', 422);
  const sources: Source[] = [
    {
      id: sourceId,
      title: page.title,
      content: `${userContext}\n${url}`,
      createdAt: new Date().toISOString(),
    },
  ];
  const key = await apiKey(pool, cipher, userId, execution);
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
        5_000,
        execution.onUsage,
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

async function storedLinkPage(
  pool: Pool,
  userId: string,
  url: string,
): Promise<{ title: string; site: string; text: string } | null> {
  const result = await pool.query<{
    source_page_title: string | null;
    source_page_site: string | null;
    source_page_text: string | null;
  }>(
    `SELECT source_page_title, source_page_site, source_page_text
     FROM notes
     WHERE user_id = $1 AND source_url = $2 AND deleted_at IS NULL
       AND source_page_text LIKE '%音频转写%'
     ORDER BY updated_at DESC
     LIMIT 1`,
    [userId, url],
  );
  const row = result.rows[0];
  if (!row?.source_page_title || !row.source_page_site || !row.source_page_text) {
    return null;
  }
  return {
    title: row.source_page_title,
    site: row.source_page_site,
    text: row.source_page_text,
  };
}

export async function suggestThemeMerge(
  pool: Pool,
  cipher: CredentialCipher,
  userId: string,
  body: unknown,
  signal: AbortSignal,
  execution: OrganizationExecution = {},
): Promise<Record<string, unknown> & { model: string }> {
  const value = record(body);
  const source = parseThemeSource(value?.source);
  const themes = parseThemes(value?.themes);
  if (!source || !themes) throw new OrganizationError('invalid_request');
  const raw = record(
    await generateJson(
      await apiKey(pool, cipher, userId, execution),
      THEME_PROMPT,
      JSON.stringify({ source, themes }),
      signal,
      3_000,
      execution.onUsage,
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

export async function answerMemoryQuestion(
  pool: Pool,
  cipher: CredentialCipher,
  userId: string,
  body: unknown,
  signal: AbortSignal,
  execution: OrganizationExecution = {},
): Promise<{
  answer: string;
  insufficient: boolean;
  citations: Array<{ sourceId: string; quote: string }>;
  suggestedQuestions: string[];
  model: string;
}> {
  const value = record(body);
  const question = shortText(value?.question, 500);
  const sources = parseSources(value?.sources);
  if (!question || !sources) throw new OrganizationError('invalid_request');
  const evidenceBySource = evidenceMap(sources);
  const raw = record(
    await generateJson(
      await apiKey(pool, cipher, userId, execution),
      MEMORY_QUESTION_PROMPT,
      JSON.stringify({
        question,
        sources: sources.map(({ id, title, createdAt }) => ({ id, title, createdAt })),
        evidenceCandidates: serializeEvidence(evidenceBySource),
      }),
      signal,
      3_000,
      execution.onUsage,
    ),
  );
  if (!raw || typeof raw.insufficient !== 'boolean') {
    throw new OrganizationError('ai_invalid_response', 502);
  }
  const citations = validateMemoryCitations(
    raw.citations,
    sources,
    evidenceBySource,
    raw.insufficient ? 0 : 1,
  );
  return {
    answer: requiredText(raw.answer, 5_000),
    insufficient: raw.insufficient,
    citations,
    suggestedQuestions: stringArray(raw.suggestedQuestions, 3, 120),
    model: MODEL,
  };
}

export async function generateMemoryInsight(
  pool: Pool,
  cipher: CredentialCipher,
  userId: string,
  body: unknown,
  signal: AbortSignal,
  execution: OrganizationExecution = {},
): Promise<Record<string, unknown> & { model: string }> {
  const value = record(body);
  const period = value?.period === 'week' || value?.period === 'month' ? value.period : null;
  const periodStart = shortText(value?.periodStart, 64);
  const periodEnd = shortText(value?.periodEnd, 64);
  const sources = parseSources(value?.sources);
  if (!period || !periodStart || !periodEnd || !sources) {
    throw new OrganizationError('invalid_request');
  }
  const evidenceBySource = evidenceMap(sources);
  const raw = record(
    await generateJson(
      await apiKey(pool, cipher, userId, execution),
      MEMORY_INSIGHT_PROMPT,
      JSON.stringify({
        period,
        periodStart,
        periodEnd,
        sources: sources.map(({ id, title, createdAt }) => ({ id, title, createdAt })),
        evidenceCandidates: serializeEvidence(evidenceBySource),
      }),
      signal,
      3_000,
      execution.onUsage,
    ),
  );
  if (!raw) throw new OrganizationError('ai_invalid_response', 502);
  return {
    title: requiredText(raw.title, 100),
    summary: requiredText(raw.summary, 500),
    overview: requiredText(raw.overview, 2_000),
    patterns: requiredText(raw.patterns, 2_000),
    changes: requiredText(raw.changes, 2_000),
    blindSpot: requiredText(raw.blindSpot, 2_000),
    question: requiredText(raw.question, 500),
    citations: validateMemoryCitations(raw.citations, sources, evidenceBySource, 2),
    model: MODEL,
  };
}

function evidenceMap(sources: Source[]) {
  return new Map(
    sources
      .map((source) => [source.id, buildEvidence(source.content).slice(0, 5)] as const)
      .filter(([, evidence]) => evidence.length > 0),
  );
}

function serializeEvidence(evidenceBySource: Map<string, ReturnType<typeof buildEvidence>>) {
  return [...evidenceBySource].map(([sourceId, items]) => ({
    sourceId,
    items: items.map(({ id, quote }) => ({ id, text: quote })),
  }));
}

function validateMemoryCitations(
  value: unknown,
  sources: Source[],
  evidenceBySource: Map<string, ReturnType<typeof buildEvidence>>,
  minimum: number,
): Array<{ sourceId: string; quote: string }> {
  if (!Array.isArray(value)) throw new OrganizationError('ai_invalid_response', 502);
  const allowed = new Set(sources.map(({ id }) => id));
  const citations = value.slice(0, 10).map((raw) => {
    const item = record(raw);
    const sourceId = shortText(item?.sourceId, 128);
    const evidenceId = shortText(item?.evidenceId, 16);
    const evidence = sourceId && evidenceId
      ? evidenceBySource.get(sourceId)?.find((candidate) => candidate.id === evidenceId)
      : null;
    if (!sourceId || !allowed.has(sourceId) || !evidence) {
      throw new OrganizationError('ai_invalid_response', 502);
    }
    return { sourceId, quote: evidence.quote };
  });
  if (citations.length < minimum) {
    throw new OrganizationError('ai_invalid_response', 502);
  }
  return citations;
}

async function apiKey(
  pool: Pool,
  cipher: CredentialCipher,
  userId: string,
  execution: OrganizationExecution,
): Promise<string> {
  const credential = await resolveMediaProviderCredential(pool, cipher, {
    userId,
    provider: 'deepseek',
    reservedCostMicros: execution.reservedCostMicros ?? 0n,
    managedCredentials: execution.managedCredentials,
  });
  return credential.apiKey;
}

async function generateJson(
  key: string,
  system: string,
  user: string,
  signal: AbortSignal,
  maxTokens = 3_000,
  onUsage?: OrganizationExecution['onUsage'],
): Promise<unknown> {
  const response = await fetch(DEEPSEEK_URL, {
    method: 'POST',
    redirect: 'error',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      thinking: { type: 'disabled' },
      temperature: 0.2,
      max_tokens: maxTokens,
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
  const usage = record(payload?.usage);
  const promptTokens = tokenCount(usage?.prompt_tokens);
  const completionTokens = tokenCount(usage?.completion_tokens);
  if (promptTokens !== null && completionTokens !== null) {
    onUsage?.({ promptTokens, completionTokens });
  }
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

function tokenCount(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0
    ? Number(value)
    : null;
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
    const selectedEvidence = new Map(
      sourceIds
        .map((sourceId) => [sourceId, evidenceBySource.get(sourceId)] as const)
        .filter(
          (entry): entry is readonly [string, ReturnType<typeof buildEvidence>] =>
            Boolean(entry[1]?.length),
        ),
    );
    const citations = selectedEvidence.size
      ? validateCitations(item.citations, sourceIds, selectedEvidence)
      : [];
    return {
      title: requiredText(item.title, 80),
      summary: shortText(item.summary, 300, true) ?? '',
      content: cleanGeneratedContent(requiredText(item.content, 6_000)),
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

function buildEvidence(text: string, maximum = 60): Array<{ id: string; quote: string; startOffset: number; endOffset: number }> {
  const result = [];
  let start = 0;
  while (start < text.length && result.length < maximum) {
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

function cleanGeneratedContent(content: string): string {
  return content
    .replace(
      /[（(\[]\s*E\d+(?:\s*[·,，:：/\-]\s*(?:(?:\d{1,2}:)?\d{1,2}:\d{2}|\d+))?\s*[）)\]]/gi,
      '',
    )
    .replace(
      /\bE\d+(?:\s*[·,，:：/\-]\s*(?:(?:\d{1,2}:)?\d{1,2}:\d{2}|\d+))?\b/gi,
      '',
    )
    .replace(/[（(\[]\s*(?:\d{1,2}:)?\d{1,2}:\d{2}\s*[）)\]]/g, '')
    .replace(/[ \t]+([，。！？；：,.!?;:])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+$/gm, '')
    .trim();
}

function parseSources(value: unknown): Source[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > 30) return null;
  const parsed: Source[] = [];
  for (const raw of value) {
    const item = record(raw);
    const id = shortText(item?.id, 128);
    const title = shortText(item?.title, 300, true) ?? '';
    const content = shortText(item?.content, 3_000);
    const createdAt = shortText(item?.createdAt, 64);
    if (!id || !content || !createdAt) return null;
    parsed.push({ id, title, content, createdAt });
  }
  return parsed;
}

function parsePage(value: unknown): { title: string; site: string; text: string } | null {
  const item = record(value);
  const title = shortText(item?.title, 300);
  const site = shortText(item?.site, 255);
  const text = shortText(item?.text, 80_000);
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

const DAILY_PROMPT = `你是 ReMind 的每日综合整理助手。你的任务不是逐条改写记录，而是比较同一天的多条记录，找出共同主题、相互支持、补充、冲突或时间上的联系。只依据输入 sources 和 evidenceCandidates：有两条以上值得联系的记录时，只生成 1 篇跨记录中文 Markdown 综合稿；纯测试词、无上下文短句和无法形成理解的碎片放入 ignoredSourceIds。content 使用“今日脉络、已记录的事实、基于记录的联系、仍待回答的问题”四类小节；事实必须能回到来源，推断必须明确写成基于记录的推断，开放问题不得写成既定结论，不得为了显得有探索而扩写。sourceIds 列出实际使用的全部来源；citations 从对应 sourceId 的真实 evidenceId 中选择，不得改写证据。输出 JSON：{"drafts":[{"title":"","summary":"","content":"","tags":[],"sourceIds":[""],"citations":[{"sourceId":"","evidenceId":"E1"}]}],"ignoredSourceIds":[]}。没有足够内容时 drafts 可为空。不要额外解释。`;
const DAILY_RETRY_PROMPT = `${DAILY_PROMPT}\n上一次输出未通过结构校验。请严格只输出零篇或一篇 draft；sourceIds 和 citation.sourceId 必须逐字复制输入 ID；citation.evidenceId 只能从该来源的 evidenceCandidates 中选择；不要把每条来源分别写成独立文档。`;
const LINK_PROMPT = `你是 ReMind 的链接整理助手。只依据 userContext、页面信息和 evidenceCandidates，围绕用户保存意图生成且只生成 1 篇详细、可复用的中文 Markdown 笔记，不能只给简短摘要。对于播客、访谈或包含案例的内容，正文应尽量包括：一句话总结、内容地图、核心观点、案例与具体做法、值得关注的启发、原始来源。每个重要案例要在证据允许的范围内说明背景与目标、当事人的具体动作、先后步骤、方法或工具、数字与限制条件、结果，以及为什么值得注意；不要把案例压缩成一句抽象结论。核心观点要解释论据、因果关系和适用边界。原文没有提供的操作细节必须明确写“原文未说明”，不得用常识补全。content 正文中禁止出现 E1 等 evidenceId、证据编号或任何时间戳；证据关联只通过 citations 字段返回。sourceIds 只能含 sourceId；citations 必须选择真实 evidenceId，1 到 6 条，不得改写证据。输出 JSON：{"drafts":[{"title":"","summary":"","content":"","tags":[],"sourceIds":[""],"citations":[{"sourceId":"","evidenceId":"E1"}]}],"ignoredSourceIds":[]}。不要额外解释。`;
const LINK_RETRY_PROMPT = `${LINK_PROMPT}\n上一次输出未通过结构校验。请严格逐字段遵循示例：只输出一个 drafts 元素；sourceIds 和每条 citation.sourceId 必须逐字复制输入 sourceId；citation.evidenceId 只能从输入 evidenceCandidates 的 id 中选择；title、content 均不得为空。`;
const THEME_PROMPT = `你是 ReMind 的主题笔记编辑助手。只依据输入，判断来源应加入哪个已有主题，或 themeId 为 null 新建长期主题。patch 只写增量，overview 写合并后的理解，冲突单列。输出 JSON：{"themeId":null,"themeTitle":"","rationale":"","patch":"","overview":"","conflicts":[]}。不要额外解释。`;
const MEMORY_QUESTION_PROMPT = `你是 ReMind 的个人记忆问答助手。只能使用输入的 evidenceCandidates 回答 question，不能用常识补全用户没记过的事实，也不能把推测写成用户的经历。找到依据时给出简洁中文回答，citations 至少选择 1 条真实 evidenceId；材料不足时 insufficient=true，明确说没有找到足够记录，citations 可以为空。suggestedQuestions 最多 3 条。输出 JSON：{"answer":"","insufficient":false,"citations":[{"sourceId":"","evidenceId":"E1"}],"suggestedQuestions":[]}。不要额外解释。`;
const MEMORY_INSIGHT_PROMPT = `你是 ReMind 的周期回望助手。只依据输入记录，寻找跨多条记录反复出现的具体线索、变化或张力。不得诊断心理疾病、人格或他人动机，不得用空泛鸡汤填充；blindSpot 必须使用“可能、也许、看起来”等不确定措辞。overview 是客观概览，patterns 说明重复线索，changes 说明态度或关注点变化，没有变化时如实说明，question 留下一个值得用户继续思考的问题。citations 至少选择 2 条且来自真实 evidenceId。输出 JSON：{"title":"","summary":"","overview":"","patterns":"","changes":"","blindSpot":"","question":"","citations":[{"sourceId":"","evidenceId":"E1"}]}。不要额外解释。`;
