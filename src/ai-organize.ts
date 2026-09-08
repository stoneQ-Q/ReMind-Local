import { requestAuthenticatedDeviceApi } from './wechat-sync';
import { createLocalId } from './note-utils';
import { getActiveReMindAppMode } from './service-contract';
import type { Note, NoteContentKind } from './types';

export type OrganizationSource = {
  id: string;
  title: string;
  content: string;
  createdAt: string;
};

export type OrganizationDraftPayload = {
  title: string;
  summary: string;
  content: string;
  contentKind: NoteContentKind;
  tags: string[];
  sourceIds: string[];
  citations: Array<{
    sourceId: string;
    quote: string;
    startOffset: number;
    endOffset: number;
  }>;
};

export type OrganizationResponse = {
  drafts: OrganizationDraftPayload[];
  ignoredSourceIds: string[];
  model: string;
};

export type ThemeMergeResponse = {
  themeId: string | null;
  themeTitle: string;
  rationale: string;
  patch: string;
  overview: string;
  conflicts: string[];
  model: string;
};

export type LinkOrganizationJob = {
  id: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  result: OrganizationResponse | null;
  errorCode: string | null;
  attemptCount: number;
  maxAttempts: number;
  createdAt: string;
  updatedAt: string;
};

async function organizationErrorMessage(
  response: Response,
  fallback: string,
): Promise<string> {
  const payload = (await response
    .json()
    .catch(() => null)) as { error?: unknown } | null;
  switch (payload?.error) {
    case 'ai_not_configured':
      return '笔记整理服务尚未配置，原始内容已经保留。';
    case 'ai_auth_failed':
      return '笔记整理服务认证失效，已有内容和视频转写已经保留，请修复服务后重试。';
    case 'ai_rate_limited':
      return '笔记整理服务当前繁忙，已有内容已经保留，请稍后重试。';
    case 'managed_service_unavailable':
      return 'ReMind 智能服务正在维护，原始内容已经保留，请稍后重试。';
    case 'insufficient_balance':
      return '本次所需忆粒不足，原始内容已经保留。你仍可继续记录和查看已有内容。';
    case 'ai_timeout':
      return '笔记整理等待超时，已有内容已经保留，请稍后重试。';
    case 'ai_invalid_response':
      return '这次整理结果没有通过内容校验，已有内容已经保留，可以重新生成。';
    case 'link_unavailable':
      return '暂时无法读取这个来源，链接和描述都已保留。';
    default:
      return fallback;
  }
}

export async function requestDailyOrganization(
  sources: OrganizationSource[],
): Promise<OrganizationResponse> {
  const response = await requestAuthenticatedDeviceApi(
    'organize',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sources }),
    },
    55_000,
  );
  if (!response.ok) {
    throw new Error(
      await organizationErrorMessage(response, '整理服务暂时不可用。'),
    );
  }
  const payload = (await response.json()) as Omit<
    OrganizationResponse,
    'drafts'
  > & {
    drafts: Omit<OrganizationDraftPayload, 'contentKind'>[];
  };
  return {
    ...payload,
    drafts: payload.drafts.map((draft) => ({
      ...draft,
      contentKind: 'text',
      citations: draft.citations ?? [],
    })),
  };
}

export async function requestLinkOrganization(
  note: Note,
  userContext: string,
): Promise<OrganizationResponse> {
  if (!note.sourceUrl) throw new Error('链接地址缺失');
  const response = await requestAuthenticatedDeviceApi(
    'link-organize',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sourceId: note.id,
        url: note.sourceUrl,
        userContext,
        page:
          note.sourcePageTitle &&
          note.sourcePageSite &&
          note.sourcePageText
            ? {
                title: note.sourcePageTitle,
                site: note.sourcePageSite,
                text: note.sourcePageText,
              }
            : undefined,
      }),
    },
    65_000,
  );
  if (!response.ok) {
    throw new Error(
      await organizationErrorMessage(response, '链接整理暂时没有完成。'),
    );
  }
  const payload = (await response.json()) as Omit<
    OrganizationResponse,
    'drafts'
  > & {
    drafts: Omit<OrganizationDraftPayload, 'contentKind'>[];
  };
  return {
    ...payload,
    drafts: payload.drafts.map((draft) => ({
      ...draft,
      contentKind: 'link',
      citations: draft.citations ?? [],
    })),
  };
}

export function supportsBackgroundLinkOrganization(): boolean {
  return getActiveReMindAppMode() === 'cloud';
}

export async function submitLinkOrganizationJob(
  note: Note,
  userContext: string,
): Promise<LinkOrganizationJob> {
  if (!note.sourceUrl) throw new Error('链接地址缺失');
  const response = await requestAuthenticatedDeviceApi(
    'link-jobs',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requestId: `${note.id}:${createLocalId()}`,
        input: linkOrganizationInput(note, userContext),
      }),
    },
    15_000,
  );
  if (!response.ok) {
    throw new Error(
      await organizationErrorMessage(response, '后台整理任务暂时没有提交成功。'),
    );
  }
  return parseLinkOrganizationJob(await response.json());
}

export async function getLinkOrganizationJob(
  jobId: string,
): Promise<LinkOrganizationJob> {
  const response = await requestAuthenticatedDeviceApi(
    `link-jobs/${encodeURIComponent(jobId)}`,
    {},
    15_000,
  );
  if (!response.ok) {
    throw new Error(
      await organizationErrorMessage(response, '暂时无法读取后台整理进度。'),
    );
  }
  return parseLinkOrganizationJob(await response.json());
}

function linkOrganizationInput(note: Note, userContext: string) {
  return {
    sourceId: note.id,
    url: note.sourceUrl,
    userContext,
    page:
      note.sourcePageTitle && note.sourcePageSite && note.sourcePageText
        ? {
            title: note.sourcePageTitle,
            site: note.sourcePageSite,
            text: note.sourcePageText,
          }
        : undefined,
  };
}

function parseLinkOrganizationJob(value: unknown): LinkOrganizationJob {
  if (!isRecord(value) || typeof value.id !== 'string') {
    throw new Error('后台整理任务返回异常。');
  }
  const status = value.status;
  if (
    status !== 'queued' &&
    status !== 'running' &&
    status !== 'succeeded' &&
    status !== 'failed' &&
    status !== 'cancelled'
  ) {
    throw new Error('后台整理任务状态异常。');
  }
  const result =
    status === 'succeeded' && isRecord(value.result)
      ? normalizeOrganizationResponse(value.result)
      : null;
  return {
    id: value.id,
    status,
    result,
    errorCode: typeof value.errorCode === 'string' ? value.errorCode : null,
    attemptCount: typeof value.attemptCount === 'number' ? value.attemptCount : 0,
    maxAttempts: typeof value.maxAttempts === 'number' ? value.maxAttempts : 0,
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : '',
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : '',
  };
}

function normalizeOrganizationResponse(
  value: Record<string, unknown>,
): OrganizationResponse {
  const drafts = Array.isArray(value.drafts) ? value.drafts : [];
  return {
    drafts: drafts
      .filter(isRecord)
      .map((draft) => ({
        title: typeof draft.title === 'string' ? draft.title : '',
        summary: typeof draft.summary === 'string' ? draft.summary : '',
        content: typeof draft.content === 'string' ? draft.content : '',
        contentKind: 'link' as const,
        tags: stringArray(draft.tags),
        sourceIds: stringArray(draft.sourceIds),
        citations: Array.isArray(draft.citations)
          ? draft.citations.filter(isRecord).map((citation) => ({
              sourceId:
                typeof citation.sourceId === 'string' ? citation.sourceId : '',
              quote: typeof citation.quote === 'string' ? citation.quote : '',
              startOffset:
                typeof citation.startOffset === 'number' ? citation.startOffset : 0,
              endOffset:
                typeof citation.endOffset === 'number' ? citation.endOffset : 0,
            }))
          : [],
      })),
    ignoredSourceIds: stringArray(value.ignoredSourceIds),
    model: typeof value.model === 'string' ? value.model : '',
  };
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function requestThemeMerge(
  source: Note,
  themes: Note[],
  overviews: Record<string, string>,
): Promise<ThemeMergeResponse> {
  const response = await requestAuthenticatedDeviceApi(
    'theme-merge',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source: {
          id: source.id,
          title: source.title,
          summary: source.summary ?? '',
          content: source.content.slice(0, 12_000),
          sourceUrl: source.sourceUrl,
        },
        themes: themes.slice(0, 12).map((theme) => ({
          id: theme.id,
          title: theme.title,
          summary: theme.summary ?? '',
          content: theme.content.slice(0, 6_000),
          overview: (overviews[theme.id] ?? '').slice(0, 5_000),
        })),
      }),
    },
    65_000,
  );
  if (!response.ok) {
    throw new Error(
      await organizationErrorMessage(response, '主题建议暂时不可用。'),
    );
  }
  return (await response.json()) as ThemeMergeResponse;
}
