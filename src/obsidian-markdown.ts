import type { Note } from './types';

export function renderObsidianMarkdown(
  note: Note,
  archived = false,
  themeOverview = '',
): string {
  const frontmatter = [
    '---',
    `remind_id: "${escapeYaml(note.id)}"`,
    `created: "${escapeYaml(note.createdAt)}"`,
    `updated: "${escapeYaml(note.updatedAt)}"`,
    `source: "${note.source}"`,
    `record_type: "${note.recordType}"`,
    `content_kind: "${note.contentKind}"`,
    ...(note.sourceUrl
      ? [`source_url: "${escapeYaml(note.sourceUrl)}"`]
      : []),
    `status: "${archived ? 'archived' : 'inbox'}"`,
    'tags:',
    '  - remind/inbox',
    `  - remind/type/${note.recordType}`,
    `  - remind/kind/${note.contentKind}`,
    ...note.tags.map((tag) => `  - "${escapeYaml(tag)}"`),
    '---',
  ];
  const summary = note.summary?.trim()
    ? `\n\n## ReMind 摘要\n\n${note.summary.trim()}`
    : '';
  const context =
    note.recordType === 'capture' && note.userContext?.trim()
    ? `\n\n## 我的保存意图\n\n${note.userContext.trim()}`
    : '';
  const overview =
    note.recordType === 'theme' && themeOverview.trim()
      ? `\n\n## 当前理解\n\n${themeOverview.trim()}`
      : '';
  return `${frontmatter.join('\n')}\n\n# ${note.title.trim()}${overview}\n\n${
    note.content
  }${context}${summary}\n`;
}

export function obsidianFileName(note: Note): string {
  const date = new Date(note.createdAt);
  const stamp = Number.isNaN(date.getTime())
    ? 'unknown-date'
    : [
        date.getFullYear(),
        pad(date.getMonth() + 1),
        pad(date.getDate()),
        '-',
        pad(date.getHours()),
        pad(date.getMinutes()),
      ].join('');
  const title = note.title
    .normalize('NFKC')
    .replace(/[\\/:*?"<>|#^[\]]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 36) || '未命名';
  return `${stamp}-${title}--${note.id}.md`;
}

export function contentFingerprint(content: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < content.length; index += 1) {
    hash ^= content.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function escapeYaml(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}
