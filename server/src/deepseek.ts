export type OrganizeSource = {
  id: string;
  content: string;
  createdAt: string;
};

export type OrganizedDraft = {
  id: string;
  title: string;
  summary: string;
  content: string;
  tags: string[];
  sourceIds: string[];
  citations: SourceCitation[];
};

export type SourceCitation = {
  sourceId: string;
  quote: string;
  startOffset: number;
  endOffset: number;
};

export type EvidenceCandidate = {
  id: string;
  quote: string;
  startOffset: number;
  endOffset: number;
};

export type LinkOrganizeInput = {
  sourceId: string;
  url: string;
  userContext: string;
  page: {
    title: string;
    description: string;
    site: string;
    text: string;
    images: string[];
    visualText: string | null;
    visualModel: string | null;
    mediaType: 'web' | 'image' | 'video';
    durationSeconds: number | null;
  };
};

export type ThemeMergeInput = {
  source: {
    id: string;
    title: string;
    summary: string;
    content: string;
    sourceUrl: string | null;
  };
  themes: Array<{
    id: string;
    title: string;
    summary: string;
    content: string;
    overview: string;
  }>;
};

export type ThemeMergeProposal = {
  themeId: string | null;
  themeTitle: string;
  rationale: string;
  patch: string;
  overview: string;
  conflicts: string[];
};

export type MemorySource = {
  id: string;
  title: string;
  content: string;
  createdAt: string;
};

type DeepSeekResponse = {
  choices?: Array<{
    finish_reason?: string;
    message?: { content?: string | null };
  }>;
};

const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions';
const MODEL = 'deepseek-v4-flash';

export class DeepSeekHttpError extends Error {
  constructor(
    public readonly status: number,
    detail: string,
  ) {
    super(`DeepSeek ${status}: ${detail}`);
    this.name = 'DeepSeekHttpError';
  }
}

function shouldRetryDeepSeek(error: unknown): boolean {
  return (
    !(error instanceof DeepSeekHttpError) ||
    error.status === 429 ||
    error.status >= 500
  );
}

export async function organizeWithDeepSeek(
  apiKey: string,
  sources: OrganizeSource[],
): Promise<{
  drafts: OrganizedDraft[];
  ignoredSourceIds: string[];
  model: string;
}> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const raw = await callDeepSeek(apiKey, sources);
      return { ...validateOrganizePayload(raw, sources), model: MODEL };
    } catch (error) {
      lastError = error;
      if (!shouldRetryDeepSeek(error)) break;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error('DeepSeek returned an invalid response');
}

export async function organizeLinkWithDeepSeek(
  apiKey: string,
  input: LinkOrganizeInput,
): Promise<{
  drafts: OrganizedDraft[];
  ignoredSourceIds: string[];
  model: string;
}> {
  const sources: OrganizeSource[] = [
    {
      id: input.sourceId,
      content: `${input.userContext}\n${input.url}`,
      createdAt: new Date().toISOString(),
    },
  ];
  let lastError: unknown;
  const evidenceCandidates = buildEvidenceCandidates(input.page.text);
  const citationCandidates = new Map([
    [
      input.sourceId,
      new Map(evidenceCandidates.map((candidate) => [candidate.id, candidate])),
    ],
  ]);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const raw = await callDeepSeekMessages(
        apiKey,
        linkSystemPrompt(),
        JSON.stringify({
          sourceId: input.sourceId,
          url: input.url,
          userContext: input.userContext,
          page: {
            title: input.page.title,
            description: input.page.description,
            site: input.page.site,
            imageCount: input.page.images.length,
            mediaType: input.page.mediaType,
            durationSeconds: input.page.durationSeconds,
            visualAnalysis: input.page.visualText
              ? {
                  model: input.page.visualModel,
                  content: input.page.visualText,
                }
              : null,
          },
          evidenceCandidates: evidenceCandidates.map((candidate) => ({
            id: candidate.id,
            text: candidate.quote,
          })),
        }),
      );
      const result = validateOrganizePayload(
        raw,
        sources,
        new Map([[input.sourceId, input.page.text]]),
        citationCandidates,
      );
      if (result.drafts.length !== 1) {
        throw new Error('DeepSeek did not return one link draft');
      }
      return { ...result, model: MODEL };
    } catch (error) {
      lastError = error;
      if (!shouldRetryDeepSeek(error)) break;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error('DeepSeek returned an invalid link response');
}

export async function suggestThemeMergeWithDeepSeek(
  apiKey: string,
  input: ThemeMergeInput,
): Promise<ThemeMergeProposal & { model: string }> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const raw = await callDeepSeekMessages(
        apiKey,
        themeMergeSystemPrompt(),
        JSON.stringify(input),
      );
      return {
        ...validateThemeMergePayload(raw, input.themes),
        model: MODEL,
      };
    } catch (error) {
      lastError = error;
      if (!shouldRetryDeepSeek(error)) break;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error('DeepSeek returned an invalid theme merge response');
}

export async function answerMemoryQuestionWithDeepSeek(
  apiKey: string,
  question: string,
  sources: MemorySource[],
): Promise<Record<string, unknown> & { model: string }> {
  const evidence = memoryEvidence(sources);
  const value = await callDeepSeekMessages(
    apiKey,
    '你是 ReMind 的个人记忆问答助手。只能依据 evidenceCandidates 回答，不得补充用户没有记录的事实。找到依据时 citations 至少选择一个真实 sourceId 和 evidenceId；找不到时 insufficient=true 并明确说明。输出 JSON：{"answer":"","insufficient":false,"citations":[{"sourceId":"","evidenceId":"E1"}],"suggestedQuestions":[]}。',
    JSON.stringify({ question, sources: sources.map(({ id, title, createdAt }) => ({ id, title, createdAt })), evidenceCandidates: serializeMemoryEvidence(evidence) }),
  );
  if (!isRecord(value) || typeof value.insufficient !== 'boolean') throw new Error('Invalid memory answer');
  return {
    answer: cleanString(value.answer, 5_000),
    insufficient: value.insufficient,
    citations: validateMemoryCitations(value.citations, evidence, value.insufficient ? 0 : 1),
    suggestedQuestions: Array.isArray(value.suggestedQuestions)
      ? value.suggestedQuestions.filter((item): item is string => typeof item === 'string').map((item) => item.trim().slice(0, 120)).filter(Boolean).slice(0, 3)
      : [],
    model: MODEL,
  };
}

export async function generateMemoryInsightWithDeepSeek(
  apiKey: string,
  input: { period: 'week' | 'month'; periodStart: string; periodEnd: string; sources: MemorySource[] },
): Promise<Record<string, unknown> & { model: string }> {
  const evidence = memoryEvidence(input.sources);
  const value = await callDeepSeekMessages(
    apiKey,
    '你是 ReMind 的周期回望助手。只能依据输入记录寻找跨多条记录的重复线索和变化，不得诊断人格、疾病或他人动机。blindSpot 必须用“可能、也许、看起来”等不确定措辞。citations 至少选择两条真实证据。输出 JSON：{"title":"","summary":"","overview":"","patterns":"","changes":"","blindSpot":"","question":"","citations":[{"sourceId":"","evidenceId":"E1"}]}。',
    JSON.stringify({ ...input, sources: input.sources.map(({ id, title, createdAt }) => ({ id, title, createdAt })), evidenceCandidates: serializeMemoryEvidence(evidence) }),
  );
  if (!isRecord(value)) throw new Error('Invalid memory insight');
  return {
    title: cleanString(value.title, 100), summary: cleanString(value.summary, 500),
    overview: cleanString(value.overview, 2_000), patterns: cleanString(value.patterns, 2_000),
    changes: cleanString(value.changes, 2_000), blindSpot: cleanString(value.blindSpot, 2_000),
    question: cleanString(value.question, 500), citations: validateMemoryCitations(value.citations, evidence, 2), model: MODEL,
  };
}

function memoryEvidence(sources: MemorySource[]) {
  return new Map(sources.map((source) => [source.id, buildEvidenceCandidates(source.content).slice(0, 5)]));
}

function serializeMemoryEvidence(evidence: Map<string, EvidenceCandidate[]>) {
  return [...evidence].map(([sourceId, items]) => ({ sourceId, items: items.map(({ id, quote }) => ({ id, text: quote })) }));
}

function validateMemoryCitations(value: unknown, evidence: Map<string, EvidenceCandidate[]>, minimum: number) {
  if (!Array.isArray(value)) throw new Error('Memory response is missing citations');
  const citations = value.slice(0, 10).map((raw) => {
    if (!isRecord(raw)) throw new Error('Invalid memory citation');
    const sourceId = cleanString(raw.sourceId, 128);
    const evidenceId = cleanString(raw.evidenceId, 16);
    const candidate = evidence.get(sourceId)?.find((item) => item.id === evidenceId);
    if (!candidate) throw new Error('Memory citation does not match source');
    return { sourceId, quote: candidate.quote };
  });
  if (citations.length < minimum) throw new Error('Memory response has too few citations');
  return citations;
}

async function callDeepSeek(
  apiKey: string,
  sources: OrganizeSource[],
): Promise<unknown> {
  return callDeepSeekMessages(
    apiKey,
    systemPrompt(),
    JSON.stringify({ sources }),
  );
}

async function callDeepSeekMessages(
  apiKey: string,
  system: string,
  user: string,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45_000);
  try {
    const response = await fetch(DEEPSEEK_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        thinking: { type: 'disabled' },
        temperature: 0.2,
        max_tokens: 3000,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: system,
          },
          {
            role: 'user',
            content: user,
          },
        ],
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 500);
      throw new DeepSeekHttpError(response.status, detail);
    }
    const payload = (await response.json()) as DeepSeekResponse;
    const choice = payload.choices?.[0];
    if (choice?.finish_reason === 'length') {
      throw new Error('DeepSeek output was truncated');
    }
    const content = choice?.message?.content?.trim();
    if (!content) throw new Error('DeepSeek returned empty content');
    return JSON.parse(content);
  } finally {
    clearTimeout(timer);
  }
}

function linkSystemPrompt(): string {
  return `
你是 ReMind 的链接整理助手。输入包含用户保存意图、原始网址、网页正文或视频转写，
以及可能存在的图片视觉分析。必须优先围绕用户保存意图整理，只能依据输入
内容，不得编造网页或图片中没有的信息。

生成且只生成 1 篇中文可审核笔记：
1. title 简洁说明主题。
2. summary 用一句话概括内容与用户意图的关系。
3. content 使用 Markdown，固定包含：
   - “## 内容概括”：准确概括网页或视频。
   - “## 值得留下的内容”：3 至 5 条，优先回答 userContext 真正关注的问题；
     内容不足时可以更少。来自作者文案或网页正文的观点，末尾用“〔证据 N〕”
     关联 citations 中同序号的原文证据。
   - visualAnalysis 只有在能补充正文没有表达的重要信息时，才增加
     “## 画面补充”。最多 3 条，不要逐图复述，不要描述无关的配色、构图、
     拍摄场景或营销氛围。每条只保留一个有用事实，并用“〔图片 N〕”指向
     支撑它的原始配图；多图共同支撑时可写“〔图片 1、3〕”。
   - “## 与我的关注点”：结合 userContext 说明为什么值得留下，不要泛泛写
     “有启发”“值得学习”，要落到用户关心的对象、问题或用途。
   - 只有确实存在行动建议时才增加“## 可行动项”。
   - “## 原始来源”：保留页面标题、站点和网址。
   - 不要输出“AI 分析”“模型认为”“视觉识别结果”等技术说明；整体应像用户
     自己整理的一篇自然笔记。
4. sourceIds 必须只包含输入的 sourceId。
5. evidenceCandidates 是已经由服务端从网页正文切出的原文证据块。
   citations 提供 1 至 6 条最能支撑关键观点的证据：
   - sourceId 必须是输入的 sourceId。
   - evidenceId 必须选择 evidenceCandidates 中真实存在的 id。
   - 不要复制、改写或拼接证据正文；服务端会根据 evidenceId 取回逐字原文。
   - visualAnalysis 不是作者逐字原文，绝不能为它生成 citations，也不能使用
     “〔证据 N〕”；视觉信息只允许用“〔图片 N〕”标记。
   - 作者文案和画面信息如果重复，只在“值得留下的内容”中保留一次，以作者
     文案证据为准，不要再写一条相同的“画面补充”。
   - mediaType 为 video 时，正文主要来自带时间戳的视频语音转写。优先保留
     说话者的实质观点，并在引用的逐字证据中保留时间戳；不要把转写当成完整
     的画面理解，也不要推断音频没有表达的视觉事实。
6. tags 最多 5 个。
7. 输出必须是 JSON object，不要代码围栏或额外解释。

JSON 结构：
{
  "drafts": [{
    "title": "...",
    "summary": "...",
    "content": "...",
    "tags": ["..."],
    "sourceIds": ["输入的 sourceId"],
    "citations": [
      {
        "sourceId": "输入的 sourceId",
        "evidenceId": "E1"
      }
    ]
  }],
  "ignoredSourceIds": []
}
`.trim();
}

function themeMergeSystemPrompt(): string {
  return `
你是 ReMind 的主题笔记编辑助手。输入包含一篇已经审核过的来源笔记，
以及用户已有的主题笔记。你的任务不是再次总结来源，而是建议它应该如何
让一篇长期主题笔记变得更完整。

规则：
1. 优先复用能够容纳本来源的已有主题。来源可以比主题更窄：例如单本书的
   深入解读可以补充“某类文学阅读”主题，不应因为标题不同就新建主题。
2. 只有现有主题在研究对象、长期目标和知识用途上都无法容纳本来源时，
   themeId 才为 null，并提出一个可长期生长的新主题标题。
3. 不要只按关键词判断，也不要把仅有表面词语重合的内容强行合并。
4. 必须在 candidateScores 中逐个评估输入里的每一篇已有主题：
   - subjectScore：主要研究对象是否一致，0 到 100。单本拉美文学作品与
     “拉美文学”对象一致；与泛化的“深度阅读方法”对象不一致。
   - purposeScore：用户长期使用这篇主题的目的是否一致，0 到 100。
   - contributionScore：本来源是否能为该主题增加不重复的实质内容，0 到 100。
   - 研究对象相同但粒度不同可以给高分；仅方法、动作或关键词重合应给低分。
   - “深度阅读、学习方法、知识管理”等宽泛方法主题，不能仅因为来源涉及
     阅读或学习就吸收具体的文学、技术、健康等内容主题。
   - reason 用一句话说明这个已有主题能否容纳本来源。
5. themeId 应选择最高分且确实能容纳来源的主题；所有主题都不合适时才为 null。
6. patch 只写本次值得加入的 Markdown 内容，不重写整篇主题笔记，不复制“我的保存意图”“原始证据”等来源笔记结构。
7. patch 应简洁，可包含新的小节、观点、书目、方法或结论；不要重复主题笔记已有内容。
8. overview 是合并后的完整“当前理解”，不是差异 patch：
   - 如果选择已有主题，要综合该主题已有 overview、已有内容和本次来源。
   - 如果新建主题，只依据本次来源生成第一版 overview。
   - 使用简洁中文 Markdown，按内容自然组织 2 至 4 个小节；不要机械套固定模板。
   - 优先保留核心理解、推荐或方法、不同来源的补充与冲突、值得继续追问的问题。
   - 总长度控制在 1200 字以内，不复制长段原文，不写空泛开场白。
   - 来自特定来源的重要判断可在句末标注“〔来源：来源笔记标题〕”。
9. 如果来源与已有主题存在实质冲突，在 conflicts 中逐条说明；没有冲突时返回空数组。
10. rationale 用一句中文解释为什么建议加入这个主题。
11. 只能依据输入内容，不得编造。
12. 输出 JSON object，不要代码围栏或额外解释。

JSON 结构：
{
  "themeId": "已有主题 id 或 null",
  "themeTitle": "主题标题",
  "rationale": "为什么适合这个主题",
  "patch": "## 新增小节\\n\\n...",
  "overview": "## 当前理解的小节\\n\\n...",
  "conflicts": ["与已有内容的冲突"],
  "candidateScores": [
    {
      "themeId": "已有主题 id",
      "subjectScore": 90,
      "purposeScore": 80,
      "contributionScore": 85,
      "reason": "为什么该主题能或不能容纳本来源"
    }
  ]
}
`.trim();
}

export function validateThemeMergePayload(
  value: unknown,
  themes: ThemeMergeInput['themes'],
): ThemeMergeProposal {
  if (!isRecord(value)) throw new Error('Invalid theme merge response');
  const allowedThemes = new Map(themes.map((theme) => [theme.id, theme]));
  const requestedThemeId =
    typeof value.themeId === 'string' ? value.themeId.trim() : null;
  if (requestedThemeId && !allowedThemes.has(requestedThemeId)) {
    throw new Error('Theme merge selected an invalid theme');
  }
  const candidateScores = Array.isArray(value.candidateScores)
    ? value.candidateScores
        .filter(isRecord)
        .map((item) => {
          const themeId =
            typeof item.themeId === 'string' ? item.themeId.trim() : '';
          const subjectScore = normalizeThemeScore(item.subjectScore);
          const purposeScore = normalizeThemeScore(item.purposeScore);
          const contributionScore = normalizeThemeScore(
            item.contributionScore,
          );
          const score = Math.round(
            subjectScore * 0.55 +
              purposeScore * 0.2 +
              contributionScore * 0.25,
          );
          const reason =
            typeof item.reason === 'string'
              ? item.reason.trim().slice(0, 300)
              : '';
          return allowedThemes.has(themeId)
            ? {
                themeId,
                score,
                subjectScore,
                contributionScore,
                reason,
              }
            : null;
        })
        .filter(
          (
            item,
          ): item is {
            themeId: string;
            score: number;
            subjectScore: number;
            contributionScore: number;
            reason: string;
          } =>
            item !== null,
        )
    : [];
  const bestMatch = candidateScores.sort((a, b) => b.score - a.score)[0];
  const themeId =
    candidateScores.length > 0
      ? bestMatch &&
        bestMatch.score >= 65 &&
        bestMatch.subjectScore >= 58 &&
        bestMatch.contributionScore >= 50
        ? bestMatch.themeId
        : null
      : requestedThemeId || null;
  const themeTitle = themeId
    ? allowedThemes.get(themeId)!.title
    : cleanString(value.themeTitle, 80);
  const rationale =
    themeId === bestMatch?.themeId && bestMatch.reason
      ? bestMatch.reason
      : cleanString(value.rationale, 300);
  const patch = cleanString(value.patch, 5000);
  const overview = cleanString(value.overview, 5000);
  const conflicts = Array.isArray(value.conflicts)
    ? value.conflicts
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim().slice(0, 300))
        .filter(Boolean)
        .slice(0, 5)
    : [];
  return { themeId, themeTitle, rationale, patch, overview, conflicts };
}

export function validateOrganizePayload(
  value: unknown,
  sources: OrganizeSource[],
  citationTexts = new Map<string, string>(),
  citationCandidates = new Map<string, Map<string, EvidenceCandidate>>(),
): {
  drafts: OrganizedDraft[];
  ignoredSourceIds: string[];
} {
  if (!isRecord(value) || !Array.isArray(value.drafts)) {
    throw new Error('DeepSeek response is missing drafts');
  }
  const allowedIds = new Set(sources.map((source) => source.id));
  const drafts = value.drafts.slice(0, 3).map((item, index) => {
    if (!isRecord(item)) throw new Error('Invalid draft');
    const title = cleanString(item.title, 80);
    const summary = cleanString(item.summary, 300, true);
    const content = normalizeEvidenceMarkers(
      cleanString(item.content, 6000),
      item.citations,
    );
    const tags = Array.isArray(item.tags)
      ? item.tags
          .filter((tag): tag is string => typeof tag === 'string')
          .map((tag) => tag.trim().replace(/^#/, '').slice(0, 30))
          .filter(Boolean)
          .slice(0, 5)
      : [];
    const sourceIds = Array.isArray(item.sourceIds)
      ? item.sourceIds.filter(
          (id): id is string =>
            typeof id === 'string' && allowedIds.has(id),
        )
      : [];
    if (!title || !content || sourceIds.length === 0) {
      throw new Error('Draft is missing required fields');
    }
    const citations = validateCitations(
      item.citations,
      sourceIds,
      citationTexts,
      citationCandidates,
    );
    return {
      id: `draft-${index + 1}`,
      title,
      summary,
      content,
      tags,
      sourceIds: [...new Set(sourceIds)],
      citations,
    };
  });
  const usedIds = new Set(drafts.flatMap((draft) => draft.sourceIds));
  const explicitIgnored = Array.isArray(value.ignoredSourceIds)
    ? value.ignoredSourceIds.filter(
        (id): id is string =>
          typeof id === 'string' && allowedIds.has(id) && !usedIds.has(id),
      )
    : [];
  const ignoredSourceIds = sources
    .map((source) => source.id)
    .filter((id) => explicitIgnored.includes(id) || !usedIds.has(id));
  return { drafts, ignoredSourceIds };
}

function normalizeEvidenceMarkers(content: string, value: unknown): string {
  if (!Array.isArray(value)) return content;
  const positions = new Map<string, number>();
  for (const [index, item] of value.slice(0, 6).entries()) {
    if (!isRecord(item) || typeof item.evidenceId !== 'string') continue;
    const evidenceId = item.evidenceId.trim().toUpperCase();
    if (evidenceId && !positions.has(evidenceId)) {
      positions.set(evidenceId, index + 1);
    }
  }
  return content.replace(/〔证据\s*([^〕]+)〕/g, (marker, body: string) => {
    let replaced = false;
    const normalized = body.replace(/[A-Za-z]\d+/g, (evidenceId) => {
      const position = positions.get(evidenceId.toUpperCase());
      if (!position) return evidenceId;
      replaced = true;
      return String(position);
    });
    return replaced ? `〔证据 ${normalized.trim()}〕` : marker;
  });
}

function validateCitations(
  value: unknown,
  sourceIds: string[],
  citationTexts: Map<string, string>,
  citationCandidates: Map<string, Map<string, EvidenceCandidate>>,
): SourceCitation[] {
  if (citationTexts.size === 0) return [];
  if (!Array.isArray(value)) {
    throw new Error('Link draft is missing citations');
  }
  const allowedIds = new Set(sourceIds);
  const citations = value.slice(0, 6).map((item) => {
    if (!isRecord(item)) throw new Error('Invalid citation');
    const sourceId = cleanString(item.sourceId, 128);
    const sourceText = citationTexts.get(sourceId);
    if (!allowedIds.has(sourceId) || !sourceText) {
      throw new Error('Citation has an invalid source');
    }
    const evidenceId =
      typeof item.evidenceId === 'string' ? item.evidenceId.trim() : '';
    const candidate = citationCandidates.get(sourceId)?.get(evidenceId);
    if (candidate) {
      return {
        sourceId,
        quote: candidate.quote,
        startOffset: candidate.startOffset,
        endOffset: candidate.endOffset,
      };
    }
    const requestedQuote = cleanString(item.quote, 600);
    const match = findNormalizedQuote(sourceText, requestedQuote);
    if (!match) throw new Error('Citation does not match source text');
    return {
      sourceId,
      quote: sourceText.slice(match.startOffset, match.endOffset),
      startOffset: match.startOffset,
      endOffset: match.endOffset,
    };
  });
  if (citations.length === 0) {
    throw new Error('Link draft is missing citations');
  }
  return citations;
}

export function buildEvidenceCandidates(
  sourceText: string,
): EvidenceCandidate[] {
  const candidates: EvidenceCandidate[] = [];
  let start = 0;
  while (start < sourceText.length && candidates.length < 80) {
    while (start < sourceText.length && /\s/.test(sourceText[start])) start += 1;
    if (start >= sourceText.length) break;

    const targetEnd = Math.min(start + 420, sourceText.length);
    const minimumEnd = Math.min(start + 120, targetEnd);
    let end = targetEnd;
    for (let index = targetEnd - 1; index >= minimumEnd; index -= 1) {
      if (/[\n。！？；.!?;]/.test(sourceText[index])) {
        end = index + 1;
        break;
      }
    }
    while (end > start && /\s/.test(sourceText[end - 1])) end -= 1;
    if (end <= start) break;
    const quote = sourceText.slice(start, end);
    if (quote.replace(/\s+/g, '').length >= 20) {
      candidates.push({
        id: `E${candidates.length + 1}`,
        quote,
        startOffset: start,
        endOffset: end,
      });
    }
    start = Math.max(end, start + 1);
  }
  return candidates;
}

function findNormalizedQuote(
  sourceText: string,
  requestedQuote: string,
): { startOffset: number; endOffset: number } | null {
  const source = normalizeWithOffsets(sourceText);
  const quote = requestedQuote.replace(/\s+/g, ' ').trim();
  const index = source.text.indexOf(quote);
  if (index < 0 || quote.length === 0) return null;
  return {
    startOffset: source.offsets[index],
    endOffset: source.offsets[index + quote.length - 1] + 1,
  };
}

function normalizeWithOffsets(value: string): {
  text: string;
  offsets: number[];
} {
  let text = '';
  const offsets: number[] = [];
  let pendingSpaceOffset: number | null = null;
  for (let index = 0; index < value.length; index += 1) {
    if (/\s/.test(value[index])) {
      if (text.length > 0 && pendingSpaceOffset === null) {
        pendingSpaceOffset = index;
      }
      continue;
    }
    if (pendingSpaceOffset !== null) {
      text += ' ';
      offsets.push(pendingSpaceOffset);
      pendingSpaceOffset = null;
    }
    text += value[index];
    offsets.push(index);
  }
  return { text, offsets };
}

function systemPrompt(): string {
  return `
你是 ReMind 的每日整理助手。用户会提供当天的原始碎片记录。
请只依据输入内容整理，不要补充输入中没有的事实。

目标：
1. 合并主题相关的碎片，最多生成 3 篇值得长期保留的中文整理稿。
2. 临时测试、确认词、无上下文短句等低价值内容不要生成笔记，放入 ignoredSourceIds。
3. 每篇整理稿必须保留准确的 sourceIds，便于用户回看原文。
4. content 使用清晰的 Markdown，可包含“核心内容”“下一步”“待办”等小节；没有待办时不要硬造。
5. 输出必须是 JSON object，不要使用代码围栏或额外解释。

JSON 示例：
{
  "drafts": [
    {
      "title": "ReMind 下一阶段：每日整理",
      "summary": "把当天碎片整理为可审核的正式笔记。",
      "content": "## 核心内容\\n\\n...\\n\\n## 下一步\\n\\n- ...",
      "tags": ["ReMind", "产品"],
      "sourceIds": ["note-1", "note-2"]
    }
  ],
  "ignoredSourceIds": ["note-3"]
}
`.trim();
}

function normalizeThemeScore(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.min(100, Math.round(value)))
    : 0;
}

function cleanString(
  value: unknown,
  maxLength: number,
  allowEmpty = false,
): string {
  if (typeof value !== 'string') {
    if (allowEmpty) return '';
    throw new Error('Expected string');
  }
  const cleaned = value.trim().slice(0, maxLength);
  if (!cleaned && !allowEmpty) throw new Error('Expected non-empty string');
  return cleaned;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
