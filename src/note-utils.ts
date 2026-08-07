import type { Note, NoteContentKind, NoteRow } from './types';

export function createLocalId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function deriveTitle(content: string): string {
  const firstUsefulLine = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);

  if (!firstUsefulLine) return '未命名笔记';
  return firstUsefulLine.length > 32
    ? `${firstUsefulLine.slice(0, 32)}…`
    : firstUsefulLine;
}

export function notePreview(content: string): string {
  const compact = content
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/^\s*(?:[-+*]|\d+[.)])\s+/gm, '')
    .replace(/[*_~`]+/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!compact) return '空白笔记';
  return compact.length > 86 ? `${compact.slice(0, 86)}…` : compact;
}

export function inferContentKind(content: string): NoteContentKind {
  const urls = content.match(/https?:\/\/[^\s]+/gi) ?? [];
  if (urls.length === 0) return 'text';

  const remainder = content
    .replace(/https?:\/\/[^\s]+/gi, '')
    .replace(/[\s，。！？、,.!?:：；;（）()[\]{}"'“”‘’\-—]/g, '');
  return remainder ? 'mixed' : 'link';
}

export function inferLinkMetadata(content: string): {
  sourceUrl: string | null;
  userContext: string | null;
} {
  const match = content.match(/https?:\/\/[^\s<>"“”]+/i);
  if (!match) return { sourceUrl: null, userContext: null };
  const sourceUrl = match[0].replace(/[，。！？、,.!?:：；;）)\]】}>]+$/, '');
  const userContext =
    content
      .replace(match[0], ' ')
      .replace(
        /^\s*(链接|网址|说明|描述|保存理由|保存意图)\s*[：:]\s*/i,
        '',
      )
      .replace(/\s+/g, ' ')
      .trim() || null;
  return { sourceUrl, userContext };
}

export function mapNoteRow(row: NoteRow): Note {
  return {
    id: row.id,
    title: row.title,
    content: row.content,
    summary: row.summary,
    status: row.status,
    source: row.source,
    recordType: row.record_type,
    contentKind: row.content_kind,
    sourceUrl: row.source_url,
    userContext: row.user_context,
    sourcePageTitle: row.source_page_title,
    sourcePageSite: row.source_page_site,
    sourcePageText: row.source_page_text,
    tags: parseTags(row.tags_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseTags(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((tag): tag is string => typeof tag === 'string')
      : [];
  } catch {
    return [];
  }
}

export function formatNoteTime(value: string): string {
  const date = new Date(value);
  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();

  if (sameDay) {
    return new Intl.DateTimeFormat('zh-CN', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(date);
  }

  return new Intl.DateTimeFormat('zh-CN', {
    month: 'short',
    day: 'numeric',
  }).format(date);
}
