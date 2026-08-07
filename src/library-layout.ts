import type { Note } from './types';

export type LibraryTab = 'organized' | 'theme' | 'raw';
export type LibraryFilter = 'all' | 'manual' | 'wechat' | 'link' | 'failed';

export type MemoryTrailDay = {
  dateKey: string;
  dayLabel: string;
  isToday: boolean;
  captureCount: number;
  organizedCount: number;
  themeLabel: string | null;
};

export type MemoryTrail = {
  days: MemoryTrailDay[];
  captureCount: number;
  organizedCount: number;
};

export function filterLibraryNotes(
  notes: Note[],
  tab: LibraryTab,
  filter: LibraryFilter,
): Note[] {
  return notes.filter((note) => {
    const matchesTab =
      tab === 'organized'
        ? note.recordType === 'source' || note.recordType === 'synthesis'
        : tab === 'theme'
          ? note.recordType === 'theme'
          : note.recordType === 'capture';
    if (!matchesTab) return false;

    switch (filter) {
      case 'manual':
        return note.source === 'app' || note.source === 'share';
      case 'wechat':
        return note.source === 'wechat';
      case 'link':
        return note.contentKind === 'link' || note.contentKind === 'mixed';
      case 'failed':
        return note.status === 'failed';
      default:
        return true;
    }
  });
}

export function buildMemoryTrail(
  notes: Note[],
  now = new Date(),
): MemoryTrail {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const days: Array<MemoryTrailDay & { tagCounts: Map<string, number> }> =
    Array.from({ length: 7 }, (_, index) => {
    const date = new Date(today);
    date.setDate(today.getDate() - (6 - index));
    return {
      dateKey: localDateKey(date),
      dayLabel: index === 6 ? '今' : weekdayLabel(date),
      isToday: index === 6,
      captureCount: 0,
      organizedCount: 0,
      themeLabel: null,
      tagCounts: new Map<string, number>(),
      };
    });
  const daysByKey = new Map(days.map((day) => [day.dateKey, day]));

  for (const note of notes) {
    const day = daysByKey.get(localDateKey(new Date(note.createdAt)));
    if (!day) continue;
    if (note.recordType === 'capture') day.captureCount += 1;
    if (note.recordType === 'source' || note.recordType === 'synthesis') {
      day.organizedCount += 1;
    }
    for (const tag of note.tags) {
      const normalized = tag.trim();
      if (!normalized) continue;
      day.tagCounts.set(normalized, (day.tagCounts.get(normalized) ?? 0) + 1);
    }
  }

  for (const day of days) {
    day.themeLabel =
      Array.from(day.tagCounts.entries()).sort(
        ([leftTag, leftCount], [rightTag, rightCount]) =>
          rightCount - leftCount || leftTag.localeCompare(rightTag, 'zh-CN'),
      )[0]?.[0] ?? null;
  }

  return {
    days: days.map(({ tagCounts: _tagCounts, ...day }) => day),
    captureCount: days.reduce((sum, day) => sum + day.captureCount, 0),
    organizedCount: days.reduce((sum, day) => sum + day.organizedCount, 0),
  };
}

function localDateKey(date: Date): string {
  if (Number.isNaN(date.getTime())) return '';
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function weekdayLabel(date: Date): string {
  return ['日', '一', '二', '三', '四', '五', '六'][date.getDay()];
}
