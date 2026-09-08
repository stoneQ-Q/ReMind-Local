import { requestAuthenticatedDeviceApi } from './wechat-sync';
import { createLocalId } from './note-utils';
import { getActiveReMindAppMode } from './service-contract';
import { isConsumerReMindApp } from './app-variant';
import type {
  InsightPeriod,
  MemoryAnswer,
  MemoryInsight,
  Note,
} from './types';

export type MemorySource = {
  id: string;
  title: string;
  content: string;
  createdAt: string;
  tags: string[];
  recordType: Note['recordType'];
};

const STOP_WORDS = new Set([
  '之前', '以前', '好像', '记过', '什么', '东西', '关于', '一下',
  '可以', '能不能', '帮我', '我的', '记录', '笔记', '最近', '用户',
]);

export function questionTerms(question: string): string[] {
  const normalized = question.toLowerCase();
  const terms = normalized.match(/[a-z0-9][a-z0-9._+-]{1,}|[\u3400-\u9fff]{2,}/g) ?? [];
  const expanded = terms.flatMap((term) => {
    if (!/[\u3400-\u9fff]/.test(term) || term.length <= 4) return [term];
    return [term, ...Array.from({ length: term.length - 1 }, (_, index) => term.slice(index, index + 2))];
  });
  return [...new Set(expanded.filter((term) => !STOP_WORDS.has(term)))];
}

export function selectQuestionSources(
  notes: Note[],
  question: string,
  limit = 18,
): MemorySource[] {
  const terms = questionTerms(question);
  const candidates = notes
    .filter((note) => note.status !== 'failed' && note.content.trim())
    .map((note) => {
      const title = note.title.toLowerCase();
      const content = `${note.summary ?? ''}\n${note.content}\n${note.userContext ?? ''}`.toLowerCase();
      const tags = note.tags.join(' ').toLowerCase();
      const score = terms.reduce(
        (sum, term) =>
          sum +
          (title.includes(term) ? 6 : 0) +
          (tags.includes(term) ? 5 : 0) +
          (content.includes(term) ? 2 : 0),
        0,
      );
      return { note, score };
    })
    .sort(
      (left, right) =>
        right.score - left.score ||
        Date.parse(right.note.updatedAt) - Date.parse(left.note.updatedAt),
    );
  const matched = candidates.filter(({ score }) => score > 0);
  const selected = (matched.length ? matched : candidates).slice(0, limit);
  return selected.map(({ note }) => toMemorySource(note));
}

export function selectInsightSources(
  notes: Note[],
  start: Date,
  end: Date,
  limit = 30,
): MemorySource[] {
  return notes
    .filter((note) => {
      const created = Date.parse(note.createdAt);
      return (
        note.status !== 'failed' &&
        note.recordType !== 'theme' &&
        note.content.replace(/\s/g, '').length >= 20 &&
        created >= start.getTime() &&
        created < end.getTime()
      );
    })
    .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt))
    .slice(-limit)
    .map(toMemorySource);
}

export function insightPeriodRange(
  period: InsightPeriod,
  now = new Date(),
): { start: Date; end: Date } {
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  if (period === 'week') {
    const start = new Date(end);
    start.setDate(start.getDate() - 7);
    return { start, end };
  }
  return { start: new Date(now.getFullYear(), now.getMonth(), 1), end };
}

export function insightEligibility(
  period: InsightPeriod,
  sources: MemorySource[],
): { eligible: boolean; message: string } {
  const dayCount = new Set(sources.map((source) => source.createdAt.slice(0, 10))).size;
  const neededNotes = period === 'week' ? 5 : 15;
  const neededDays = period === 'week' ? 3 : 8;
  if (sources.length < neededNotes || dayCount < neededDays) {
    return {
      eligible: false,
      message: `${period === 'week' ? '周回望' : '月回望'}至少需要跨 ${neededDays} 天的 ${neededNotes} 条记录，积累够了再生成会更真实。`,
    };
  }
  return { eligible: true, message: '' };
}

export async function askMemory(
  question: string,
  sources: MemorySource[],
): Promise<MemoryAnswer> {
  const response = await requestAuthenticatedDeviceApi(
    'memory-question',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question, sources }),
    },
    65_000,
  );
  if (!response.ok) throw new Error(await memoryAiError(response));
  const payload = (await response.json()) as Omit<MemoryAnswer, 'id' | 'question' | 'createdAt'>;
  return {
    id: createLocalId(),
    question,
    answer: payload.answer,
    insufficient: payload.insufficient,
    citations: payload.citations ?? [],
    suggestedQuestions: payload.suggestedQuestions ?? [],
    createdAt: new Date().toISOString(),
  };
}

export async function generateInsight(
  period: InsightPeriod,
  start: Date,
  end: Date,
  sources: MemorySource[],
): Promise<MemoryInsight> {
  const response = await requestAuthenticatedDeviceApi(
    'memory-insight',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ period, periodStart: start.toISOString(), periodEnd: end.toISOString(), sources }),
    },
    65_000,
  );
  if (!response.ok) throw new Error(await memoryAiError(response));
  const payload = (await response.json()) as Omit<MemoryInsight, 'id' | 'period' | 'periodStart' | 'periodEnd' | 'feedback' | 'createdAt'>;
  return {
    ...payload,
    id: createLocalId(),
    period,
    periodStart: start.toISOString(),
    periodEnd: end.toISOString(),
    feedback: null,
    createdAt: new Date().toISOString(),
  };
}

function toMemorySource(note: Note): MemorySource {
  return {
    id: note.id,
    title: note.title.slice(0, 160),
    content: [note.userContext, note.summary, note.content]
      .filter(Boolean)
      .join('\n')
      .slice(0, 3_000),
    createdAt: note.createdAt,
    tags: note.tags.slice(0, 8),
    recordType: note.recordType,
  };
}

async function memoryAiError(response: Response): Promise<string> {
  const payload = (await response.json().catch(() => null)) as { error?: string } | null;
  if (payload?.error === 'ai_not_configured') {
    return getActiveReMindAppMode() === 'local'
      ? '本地服务尚未配置 DeepSeek Key，请先完成本地 AI 配置。'
      : isConsumerReMindApp()
        ? 'ReMind 智能服务暂时不可用，请稍后重试。'
        : '请先在“AI 与 API Key”中保存自己的 Key。';
  }
  if (payload?.error === 'managed_service_unavailable') {
    return 'ReMind 智能服务正在维护，请稍后重试。';
  }
  if (payload?.error === 'insufficient_balance') {
    return '本次所需忆粒不足，已有记录不会受到影响。';
  }
  if (payload?.error === 'ai_auth_failed') return 'API Key 已失效，请更新后重试。';
  if (payload?.error === 'ai_rate_limited') return 'AI 服务现在比较忙，请稍后再试。';
  if (payload?.error === 'ai_invalid_response') return '这次回答没有通过来源校验，请重新生成。';
  return '暂时无法读取这些记忆，请稍后重试。';
}
