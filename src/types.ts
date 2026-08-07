export type NoteStatus = 'saved' | 'processing' | 'ready' | 'failed';
export type NoteSource = 'app' | 'wechat' | 'share' | 'ai';
export type NoteRecordType = 'capture' | 'source' | 'synthesis' | 'theme';
export type NoteContentKind =
  | 'text'
  | 'link'
  | 'image'
  | 'audio'
  | 'file'
  | 'mixed';

export type Note = {
  id: string;
  title: string;
  content: string;
  summary: string | null;
  status: NoteStatus;
  source: NoteSource;
  recordType: NoteRecordType;
  contentKind: NoteContentKind;
  sourceUrl: string | null;
  userContext: string | null;
  sourcePageTitle: string | null;
  sourcePageSite: string | null;
  sourcePageText: string | null;
  tags: string[];
  createdAt: string;
  updatedAt: string;
};

export type NoteRow = {
  id: string;
  title: string;
  content: string;
  summary: string | null;
  status: NoteStatus;
  source: NoteSource;
  record_type: NoteRecordType;
  content_kind: NoteContentKind;
  source_url: string | null;
  user_context: string | null;
  source_page_title: string | null;
  source_page_site: string | null;
  source_page_text: string | null;
  tags_json: string;
  created_at: string;
  updated_at: string;
};

export type OrganizeDraft = {
  id: string;
  title: string;
  summary: string;
  content: string;
  contentKind: NoteContentKind;
  tags: string[];
  sourceIds: string[];
  citations: SourceCitation[];
  sourceUrl: string | null;
  sourceTitle: string | null;
  sourceSite: string | null;
  userContext: string | null;
  createdAt: string;
};

export type SourceCitation = {
  id: string;
  sourceId: string;
  quote: string;
  startOffset: number;
  endOffset: number;
};

export type NoteAttachment = {
  id: string;
  noteId: string;
  uri: string;
  width: number;
  height: number;
  sortOrder: number;
  createdAt: string;
};

export type MemoryCitation = {
  sourceId: string;
  quote: string;
};

export type MemoryAnswer = {
  id: string;
  question: string;
  answer: string;
  insufficient: boolean;
  citations: MemoryCitation[];
  suggestedQuestions: string[];
  createdAt: string;
};

export type InsightPeriod = 'week' | 'month';

export type MemoryInsight = {
  id: string;
  period: InsightPeriod;
  periodStart: string;
  periodEnd: string;
  title: string;
  summary: string;
  overview: string;
  patterns: string;
  changes: string;
  blindSpot: string;
  question: string;
  citations: MemoryCitation[];
  feedback: 'accurate' | 'inaccurate' | null;
  createdAt: string;
};

export type ThemeMergeDraft = {
  id: string;
  sourceNoteId: string;
  sourceTitle: string;
  sourceUrl: string | null;
  themeNoteId: string | null;
  themeTitle: string;
  rationale: string;
  patch: string;
  overview: string;
  conflicts: string[];
  createdAt: string;
};
