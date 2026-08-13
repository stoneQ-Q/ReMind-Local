import type { SQLiteDatabase } from 'expo-sqlite';

import {
  createLocalId,
  deriveTitle,
  inferContentKind,
  inferLinkMetadata,
  mapNoteRow,
} from './note-utils';
import type {
  Note,
  NoteAttachment,
  MemoryAnswer,
  MemoryInsight,
  InsightPeriod,
  NoteRow,
  NoteSource,
  OrganizeDraft,
  ThemeMergeDraft,
} from './types';
import type {
  OrganizationResponse,
  ThemeMergeResponse,
} from './ai-organize';
import {
  LINK_AUTOMATION_MODE_SETTING,
  REMIND_DATABASE_SCHEMA_VERSION,
} from './persistence-contract';
import { SYSTEM_XIAOYUZHOU_INSIGHT_PROMPTS } from './xiaoyuzhou';
import {
  isXiaoyuzhouEpisodeUrl,
  xiaoyuzhouUserIntent,
} from './xiaoyuzhou';

// v16 is intentionally schema-neutral. It preserves migration monotonicity
// after the discarded local-media prototype without storing media in SQLite.
const DATABASE_VERSION = REMIND_DATABASE_SCHEMA_VERSION;

export type SourceThemeAssignment = {
  sourceNoteId: string;
  themeId: string;
  themeTitle: string;
  contributionAvailable: boolean;
};

export type ReclassifySourceResult = {
  previousTheme: Note;
  targetTheme: Note;
  removedFromPrevious: boolean;
};

export type ThemeSourceContribution = {
  source: Note;
  contribution: string;
  addedAt: string;
};

export type ThemeSourceSummary = {
  count: number;
  lastAddedAt: string;
};

export type RelatedMemory = {
  note: Note;
  reason: string;
  relation: 'same-theme' | 'shared-tags' | 'shared-keywords';
};

export type RecallSuggestion = {
  memory: Note;
  anchor: Note;
  reason: string;
};

export type LinkAutomationMode =
  | 'review'
  | 'auto_note'
  | 'auto_note_and_theme';

export async function getLinkAutomationMode(
  db: SQLiteDatabase,
): Promise<LinkAutomationMode> {
  const row = await db.getFirstAsync<{ value: string }>(
    'SELECT value FROM app_settings WHERE key = ?',
    LINK_AUTOMATION_MODE_SETTING,
  );
  return row?.value === 'auto_note' || row?.value === 'auto_note_and_theme'
    ? row.value
    : 'review';
}

export async function setLinkAutomationMode(
  db: SQLiteDatabase,
  mode: LinkAutomationMode,
): Promise<void> {
  await db.runAsync(
    `INSERT INTO app_settings (key, value, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET
       value = excluded.value,
       updated_at = excluded.updated_at`,
    LINK_AUTOMATION_MODE_SETTING,
    mode,
    new Date().toISOString(),
  );
}

export async function migrateDatabase(db: SQLiteDatabase) {
  await db.execAsync('PRAGMA journal_mode = WAL');
  await db.execAsync('PRAGMA foreign_keys = ON');

  const version = await db.getFirstAsync<{ user_version: number }>(
    'PRAGMA user_version',
  );
  const currentVersion = version?.user_version ?? 0;

  if (currentVersion >= DATABASE_VERSION) {
    await ensureImportedSourceVersionColumn(db);
    return;
  }

  if (currentVersion === 0) {
    await db.execAsync(`
      CREATE TABLE IF NOT EXISTS notes (
        id TEXT PRIMARY KEY NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        summary TEXT,
        status TEXT NOT NULL DEFAULT 'saved',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      );
    `);
    await db.execAsync(`
      CREATE INDEX IF NOT EXISTS notes_updated_at_idx
      ON notes(updated_at DESC);
    `);
  }

  if (currentVersion < 2) {
    await db.execAsync(`
      CREATE TABLE IF NOT EXISTS note_imports (
        source_key TEXT PRIMARY KEY NOT NULL,
        payload TEXT NOT NULL,
        note_id TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (note_id) REFERENCES notes(id)
      );
    `);
  }

  if (currentVersion < 3) {
    await db.execAsync(`
      ALTER TABLE notes
      ADD COLUMN source TEXT NOT NULL DEFAULT 'app';
    `);
    await db.execAsync(`
      UPDATE notes
      SET source = CASE
        WHEN EXISTS (
          SELECT 1 FROM note_imports ni
          WHERE ni.note_id = notes.id AND ni.source_key LIKE 'wechat:%'
        ) THEN 'wechat'
        ELSE 'share'
      END
      WHERE EXISTS (
        SELECT 1 FROM note_imports ni WHERE ni.note_id = notes.id
      );
    `);
    await db.execAsync(`
      CREATE TABLE IF NOT EXISTS obsidian_exports (
        note_id TEXT PRIMARY KEY NOT NULL,
        file_uri TEXT,
        exported_hash TEXT,
        exported_at TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        last_error TEXT,
        FOREIGN KEY (note_id) REFERENCES notes(id)
      );
    `);
    await db.execAsync(`
      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }

  if (currentVersion < 4) {
    await db.execAsync(`
      ALTER TABLE obsidian_exports
      ADD COLUMN sync_enabled INTEGER NOT NULL DEFAULT 0;
    `);
  }

  if (currentVersion < 5) {
    await db.execAsync(`
      CREATE TABLE IF NOT EXISTS organize_drafts (
        id TEXT PRIMARY KEY NOT NULL,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        content TEXT NOT NULL,
        tags_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    await db.execAsync(`
      CREATE TABLE IF NOT EXISTS organize_draft_sources (
        draft_id TEXT NOT NULL,
        note_id TEXT NOT NULL,
        PRIMARY KEY (draft_id, note_id),
        FOREIGN KEY (draft_id) REFERENCES organize_drafts(id) ON DELETE CASCADE,
        FOREIGN KEY (note_id) REFERENCES notes(id)
      );
    `);
    await db.execAsync(`
      CREATE TABLE IF NOT EXISTS organize_ignored_sources (
        note_id TEXT PRIMARY KEY NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (note_id) REFERENCES notes(id)
      );
    `);
  }

  if (currentVersion < 6) {
    await db.execAsync(`
      ALTER TABLE notes
      ADD COLUMN tags_json TEXT NOT NULL DEFAULT '[]';
    `);
  }

  if (currentVersion < 7) {
    await db.execAsync(`
      ALTER TABLE notes
      ADD COLUMN record_type TEXT NOT NULL DEFAULT 'capture';
    `);
    await db.execAsync(`
      ALTER TABLE notes
      ADD COLUMN content_kind TEXT NOT NULL DEFAULT 'text';
    `);
    await db.execAsync(`
      UPDATE notes
      SET record_type = 'synthesis'
      WHERE source = 'ai';
    `);
    await db.execAsync(`
      UPDATE notes
      SET content_kind = CASE
        WHEN content LIKE '%http://%' OR content LIKE '%https://%'
          THEN 'link'
        ELSE 'text'
      END;
    `);
  }

  if (currentVersion < 8) {
    await db.execAsync(`
      ALTER TABLE notes
      ADD COLUMN source_url TEXT;
    `);
    await db.execAsync(`
      ALTER TABLE notes
      ADD COLUMN user_context TEXT;
    `);
    await db.execAsync(`
      ALTER TABLE organize_drafts
      ADD COLUMN content_kind TEXT NOT NULL DEFAULT 'text';
    `);
    const legacyLinks = await db.getAllAsync<{
      id: string;
      content: string;
    }>(
      `SELECT id, content
       FROM notes
       WHERE content_kind IN ('link', 'mixed') AND source_url IS NULL`,
    );
    for (const note of legacyLinks) {
      const metadata = inferLinkMetadata(note.content);
      if (!metadata.sourceUrl) continue;
      await db.runAsync(
        `UPDATE notes
         SET source_url = ?, user_context = ?
         WHERE id = ?`,
        metadata.sourceUrl,
        metadata.userContext,
        note.id,
      );
    }
  }

  if (currentVersion < 9) {
    await db.execAsync(`
      ALTER TABLE notes
      ADD COLUMN source_page_title TEXT;
    `);
    await db.execAsync(`
      ALTER TABLE notes
      ADD COLUMN source_page_site TEXT;
    `);
    await db.execAsync(`
      ALTER TABLE notes
      ADD COLUMN source_page_text TEXT;
    `);
  }

  if (currentVersion < 10) {
    await db.execAsync(`
      CREATE TABLE IF NOT EXISTS source_citations (
        id TEXT PRIMARY KEY NOT NULL,
        draft_id TEXT NOT NULL,
        note_id TEXT,
        source_note_id TEXT NOT NULL,
        quote TEXT NOT NULL,
        start_offset INTEGER NOT NULL,
        end_offset INTEGER NOT NULL,
        position INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (draft_id) REFERENCES organize_drafts(id) ON DELETE CASCADE,
        FOREIGN KEY (note_id) REFERENCES notes(id),
        FOREIGN KEY (source_note_id) REFERENCES notes(id)
      );
    `);
    await db.execAsync(`
      CREATE INDEX IF NOT EXISTS source_citations_note_id_idx
      ON source_citations(note_id, position);
    `);
    await db.execAsync(`
      UPDATE notes
      SET record_type = 'source'
      WHERE source = 'ai'
        AND source_url IS NOT NULL
        AND content_kind IN ('link', 'mixed');
    `);
  }

  if (currentVersion < 11) {
    await db.execAsync(`
      CREATE TABLE IF NOT EXISTS theme_merge_drafts (
        id TEXT PRIMARY KEY NOT NULL,
        source_note_id TEXT NOT NULL UNIQUE,
        theme_note_id TEXT,
        theme_title TEXT NOT NULL,
        rationale TEXT NOT NULL,
        patch TEXT NOT NULL,
        conflicts_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (source_note_id) REFERENCES notes(id),
        FOREIGN KEY (theme_note_id) REFERENCES notes(id)
      );
    `);
    await db.execAsync(`
      CREATE TABLE IF NOT EXISTS theme_sources (
        theme_note_id TEXT NOT NULL,
        source_note_id TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        PRIMARY KEY (theme_note_id, source_note_id),
        FOREIGN KEY (theme_note_id) REFERENCES notes(id),
        FOREIGN KEY (source_note_id) REFERENCES notes(id)
      );
    `);
  }

  if (currentVersion < 12) {
    const themeSourceColumns = await db.getAllAsync<{ name: string }>(
      'PRAGMA table_info(theme_sources)',
    );
    if (!themeSourceColumns.some((column) => column.name === 'contribution')) {
      await db.execAsync(`
        ALTER TABLE theme_sources
        ADD COLUMN contribution TEXT;
      `);
    }
    if (!themeSourceColumns.some((column) => column.name === 'updated_at')) {
      await db.execAsync(`
        ALTER TABLE theme_sources
        ADD COLUMN updated_at TEXT;
      `);
    }
    const legacyAssignments = await db.getAllAsync<{
      source_note_id: string;
      source_title: string;
      source_url: string | null;
      patch: string | null;
      conflicts_json: string | null;
      created_at: string;
    }>(
      `SELECT ts.source_note_id, source.title AS source_title,
              source.source_url, tmd.patch, tmd.conflicts_json, ts.created_at
       FROM theme_sources ts
       INNER JOIN notes source ON source.id = ts.source_note_id
       LEFT JOIN theme_merge_drafts tmd
         ON tmd.source_note_id = ts.source_note_id
        AND tmd.status = 'accepted'
       WHERE ts.contribution IS NULL`,
    );
    for (const assignment of legacyAssignments) {
      const contribution = assignment.patch
        ? renderThemeAddition(
            assignment.patch,
            assignment.source_title,
            assignment.source_url,
            parseStringArray(assignment.conflicts_json ?? '[]'),
          )
        : null;
      await db.runAsync(
        `UPDATE theme_sources
         SET contribution = ?, updated_at = ?
         WHERE source_note_id = ?`,
        contribution,
        assignment.created_at,
        assignment.source_note_id,
      );
    }
  }

  if (currentVersion < 13) {
    await db.runAsync(
      `UPDATE notes
       SET summary = NULL
       WHERE record_type = 'theme'
         AND summary = '由重新归类来源创建'
         AND deleted_at IS NULL`,
    );
  }

  if (currentVersion < 14) {
    const themeDraftColumns = await db.getAllAsync<{ name: string }>(
      'PRAGMA table_info(theme_merge_drafts)',
    );
    if (!themeDraftColumns.some((column) => column.name === 'overview')) {
      await db.execAsync(`
        ALTER TABLE theme_merge_drafts
        ADD COLUMN overview TEXT NOT NULL DEFAULT '';
      `);
    }
    await db.execAsync(`
      CREATE TABLE IF NOT EXISTS theme_overviews (
        theme_note_id TEXT PRIMARY KEY NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (theme_note_id) REFERENCES notes(id) ON DELETE CASCADE
      );
    `);
  }

  if (currentVersion < 15) {
    await db.execAsync(`
      CREATE TABLE IF NOT EXISTS recall_states (
        memory_note_id TEXT PRIMARY KEY NOT NULL,
        anchor_note_id TEXT NOT NULL,
        reason TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'shown',
        shown_at TEXT NOT NULL,
        snoozed_until TEXT,
        opened_at TEXT,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (memory_note_id) REFERENCES notes(id) ON DELETE CASCADE,
        FOREIGN KEY (anchor_note_id) REFERENCES notes(id) ON DELETE CASCADE
      );
    `);
    await db.execAsync(`
      CREATE INDEX IF NOT EXISTS recall_states_status_idx
      ON recall_states(status, shown_at DESC);
    `);
  }

  if (currentVersion < 17) {
    await db.execAsync(`
      CREATE TABLE IF NOT EXISTS note_attachments (
        id TEXT PRIMARY KEY NOT NULL,
        note_id TEXT NOT NULL,
        uri TEXT NOT NULL,
        width INTEGER NOT NULL,
        height INTEGER NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS note_attachments_note_idx
      ON note_attachments(note_id, sort_order);

      CREATE TABLE IF NOT EXISTS memory_questions (
        id TEXT PRIMARY KEY NOT NULL,
        question TEXT NOT NULL,
        answer TEXT NOT NULL,
        insufficient INTEGER NOT NULL DEFAULT 0,
        citations_json TEXT NOT NULL DEFAULT '[]',
        suggested_questions_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS memory_questions_created_idx
      ON memory_questions(created_at DESC);

      CREATE TABLE IF NOT EXISTS memory_insights (
        id TEXT PRIMARY KEY NOT NULL,
        period TEXT NOT NULL,
        period_start TEXT NOT NULL,
        period_end TEXT NOT NULL,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        overview TEXT NOT NULL,
        patterns TEXT NOT NULL,
        changes TEXT NOT NULL,
        blind_spot TEXT NOT NULL,
        question TEXT NOT NULL,
        citations_json TEXT NOT NULL DEFAULT '[]',
        feedback TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS memory_insights_period_idx
      ON memory_insights(period, period_start DESC);
    `);
  }

  if (currentVersion < 18) {
    for (const prompt of SYSTEM_XIAOYUZHOU_INSIGHT_PROMPTS) {
      await db.runAsync(
        `UPDATE notes
         SET user_context = NULL
         WHERE source_url LIKE '%xiaoyuzhoufm.com%'
           AND trim(COALESCE(user_context, '')) = ?`,
        prompt,
      );
    }
  }

  if (currentVersion < 19) {
    await ensureImportedSourceVersionColumn(db);
  }

  await db.execAsync(`PRAGMA user_version = ${DATABASE_VERSION}`);
}

async function ensureImportedSourceVersionColumn(
  db: SQLiteDatabase,
): Promise<void> {
  const importColumns = await db.getAllAsync<{ name: string }>(
    'PRAGMA table_info(note_imports)',
  );
  if (
    importColumns.length > 0 &&
    !importColumns.some((column) => column.name === 'source_updated_at')
  ) {
    await db.execAsync(`
      ALTER TABLE note_imports
      ADD COLUMN source_updated_at TEXT;
    `);
  }
}

export async function listNotes(
  db: SQLiteDatabase,
  query = '',
): Promise<Note[]> {
  const normalized = query.trim();
  const rows = normalized
    ? await db.getAllAsync<NoteRow>(
        `SELECT id, title, content, summary, status, source, record_type, content_kind,
                source_url, user_context, source_page_title, source_page_site,
                source_page_text, tags_json, created_at, updated_at
         FROM notes
         WHERE deleted_at IS NULL
           AND NOT (
             record_type = 'capture'
             AND source_url IS NOT NULL
             AND EXISTS (
               SELECT 1
               FROM source_citations citation
               INNER JOIN notes generated ON generated.id = citation.note_id
               WHERE citation.source_note_id = notes.id
                 AND generated.deleted_at IS NULL
                 AND generated.record_type IN ('source', 'synthesis')
             )
           )
           AND (title LIKE $query ESCAPE '\\' OR content LIKE $query ESCAPE '\\')
         ORDER BY updated_at DESC`,
        { $query: `%${escapeLike(normalized)}%` },
      )
    : await db.getAllAsync<NoteRow>(
        `SELECT id, title, content, summary, status, source, record_type, content_kind,
                source_url, user_context, source_page_title, source_page_site,
                source_page_text, tags_json, created_at, updated_at
         FROM notes
         WHERE deleted_at IS NULL
           AND NOT (
             record_type = 'capture'
             AND source_url IS NOT NULL
             AND EXISTS (
               SELECT 1
               FROM source_citations citation
               INNER JOIN notes generated ON generated.id = citation.note_id
               WHERE citation.source_note_id = notes.id
                 AND generated.deleted_at IS NULL
                 AND generated.record_type IN ('source', 'synthesis')
             )
           )
         ORDER BY updated_at DESC`,
      );

  return rows.map(mapNoteRow);
}

export async function listNotesForActivity(
  db: SQLiteDatabase,
  since: string,
): Promise<Note[]> {
  const rows = await db.getAllAsync<NoteRow>(
    `SELECT id, title, content, summary, status, source, record_type, content_kind,
            source_url, user_context, source_page_title, source_page_site,
            source_page_text, tags_json, created_at, updated_at
     FROM notes
     WHERE deleted_at IS NULL
       AND created_at >= ?
     ORDER BY created_at DESC`,
    since,
  );
  return rows.map(mapNoteRow);
}

export async function createNote(
  db: SQLiteDatabase,
  content: string,
  source: NoteSource = 'app',
  metadata: {
    sourceUrl?: string | null;
    userContext?: string | null;
    sourcePageTitle?: string | null;
    sourcePageSite?: string | null;
    sourcePageText?: string | null;
    createdAt?: string | null;
  } = {},
): Promise<Note> {
  const now = new Date().toISOString();
  const createdAt = normalizeImportedTimestamp(metadata.createdAt) ?? now;
  const inferred = inferLinkMetadata(content);
  const note: Note = {
    id: createLocalId(),
    title: deriveTitle(content),
    content: content.trim(),
    summary: null,
    status: 'saved',
    source,
    recordType: 'capture',
    contentKind: inferContentKind(content),
    sourceUrl: metadata.sourceUrl ?? inferred.sourceUrl,
    userContext: metadata.userContext ?? inferred.userContext,
    sourcePageTitle: metadata.sourcePageTitle ?? null,
    sourcePageSite: metadata.sourcePageSite ?? null,
    sourcePageText: metadata.sourcePageText ?? null,
    tags: [],
    createdAt,
    updatedAt: createdAt,
  };

  await db.runAsync(
    `INSERT INTO notes
      (id, title, content, summary, status, source, record_type, content_kind,
       source_url, user_context, source_page_title, source_page_site,
       source_page_text, tags_json, created_at, updated_at)
     VALUES ($id, $title, $content, NULL, $status, $source, $recordType,
             $contentKind, $sourceUrl, $userContext, $sourcePageTitle,
             $sourcePageSite, $sourcePageText, '[]', $createdAt, $updatedAt)`,
    {
      $id: note.id,
      $title: note.title,
      $content: note.content,
      $status: note.status,
      $source: note.source,
      $recordType: note.recordType,
      $contentKind: note.contentKind,
      $sourceUrl: note.sourceUrl,
      $userContext: note.userContext,
      $sourcePageTitle: note.sourcePageTitle,
      $sourcePageSite: note.sourcePageSite,
      $sourcePageText: note.sourcePageText,
      $createdAt: note.createdAt,
      $updatedAt: note.updatedAt,
    },
  );

  return note;
}

export async function setNoteContentKind(
  db: SQLiteDatabase,
  noteId: string,
  contentKind: Note['contentKind'],
): Promise<void> {
  await db.runAsync(
    'UPDATE notes SET content_kind = ?, updated_at = ? WHERE id = ?',
    contentKind,
    new Date().toISOString(),
    noteId,
  );
}

export async function addNoteAttachments(
  db: SQLiteDatabase,
  noteId: string,
  attachments: Array<Omit<NoteAttachment, 'noteId' | 'createdAt'>>,
): Promise<void> {
  const now = new Date().toISOString();
  await db.withTransactionAsync(async () => {
    for (const attachment of attachments) {
      await db.runAsync(
        `INSERT INTO note_attachments
          (id, note_id, uri, width, height, sort_order, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        attachment.id,
        noteId,
        attachment.uri,
        attachment.width,
        attachment.height,
        attachment.sortOrder,
        now,
      );
    }
  });
}

export async function listNoteAttachments(
  db: SQLiteDatabase,
  noteIds?: string[],
): Promise<NoteAttachment[]> {
  if (noteIds && noteIds.length === 0) return [];
  const rows = noteIds
    ? await db.getAllAsync<{
        id: string; note_id: string; uri: string; width: number;
        height: number; sort_order: number; created_at: string;
      }>(
        `SELECT id, note_id, uri, width, height, sort_order, created_at
         FROM note_attachments
         WHERE note_id IN (${noteIds.map(() => '?').join(', ')})
         ORDER BY note_id, sort_order`,
        ...noteIds,
      )
    : await db.getAllAsync<{
        id: string; note_id: string; uri: string; width: number;
        height: number; sort_order: number; created_at: string;
      }>(
        `SELECT id, note_id, uri, width, height, sort_order, created_at
         FROM note_attachments ORDER BY note_id, sort_order`,
      );
  return rows.map((row) => ({
    id: row.id,
    noteId: row.note_id,
    uri: row.uri,
    width: row.width,
    height: row.height,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
  }));
}

export async function deleteNoteAttachments(
  db: SQLiteDatabase,
  noteId: string,
): Promise<void> {
  await db.runAsync('DELETE FROM note_attachments WHERE note_id = ?', noteId);
}

export async function saveMemoryAnswer(
  db: SQLiteDatabase,
  answer: MemoryAnswer,
): Promise<void> {
  await db.runAsync(
    `INSERT INTO memory_questions
      (id, question, answer, insufficient, citations_json,
       suggested_questions_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    answer.id,
    answer.question,
    answer.answer,
    answer.insufficient ? 1 : 0,
    JSON.stringify(answer.citations),
    JSON.stringify(answer.suggestedQuestions),
    answer.createdAt,
  );
  await db.runAsync(
    `DELETE FROM memory_questions WHERE id NOT IN
      (SELECT id FROM memory_questions ORDER BY created_at DESC LIMIT 10)`,
  );
}

export async function listMemoryAnswers(
  db: SQLiteDatabase,
): Promise<MemoryAnswer[]> {
  const rows = await db.getAllAsync<{
    id: string; question: string; answer: string; insufficient: number;
    citations_json: string; suggested_questions_json: string; created_at: string;
  }>('SELECT * FROM memory_questions ORDER BY created_at DESC LIMIT 10');
  return rows.map((row) => ({
    id: row.id,
    question: row.question,
    answer: row.answer,
    insufficient: row.insufficient === 1,
    citations: JSON.parse(row.citations_json),
    suggestedQuestions: JSON.parse(row.suggested_questions_json),
    createdAt: row.created_at,
  }));
}

export async function saveMemoryInsight(
  db: SQLiteDatabase,
  insight: MemoryInsight,
): Promise<void> {
  await db.runAsync(
    `INSERT OR REPLACE INTO memory_insights
      (id, period, period_start, period_end, title, summary, overview,
       patterns, changes, blind_spot, question, citations_json, feedback,
       created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    insight.id,
    insight.period,
    insight.periodStart,
    insight.periodEnd,
    insight.title,
    insight.summary,
    insight.overview,
    insight.patterns,
    insight.changes,
    insight.blindSpot,
    insight.question,
    JSON.stringify(insight.citations),
    insight.feedback,
    insight.createdAt,
  );
}

export async function listMemoryInsights(
  db: SQLiteDatabase,
): Promise<MemoryInsight[]> {
  const rows = await db.getAllAsync<{
    id: string; period: InsightPeriod; period_start: string; period_end: string;
    title: string; summary: string; overview: string; patterns: string;
    changes: string; blind_spot: string; question: string;
    citations_json: string; feedback: MemoryInsight['feedback']; created_at: string;
  }>('SELECT * FROM memory_insights ORDER BY created_at DESC');
  return rows.map((row) => ({
    id: row.id,
    period: row.period,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    title: row.title,
    summary: row.summary,
    overview: row.overview,
    patterns: row.patterns,
    changes: row.changes,
    blindSpot: row.blind_spot,
    question: row.question,
    citations: JSON.parse(row.citations_json),
    feedback: row.feedback,
    createdAt: row.created_at,
  }));
}

export async function setMemoryInsightFeedback(
  db: SQLiteDatabase,
  insightId: string,
  feedback: NonNullable<MemoryInsight['feedback']>,
): Promise<void> {
  await db.runAsync(
    'UPDATE memory_insights SET feedback = ? WHERE id = ?',
    feedback,
    insightId,
  );
}

export async function createImportedNote(
  db: SQLiteDatabase,
  content: string,
  sourceKey: string,
  metadata: {
    sourceUrl?: string | null;
    userContext?: string | null;
    sourcePageTitle?: string | null;
    sourcePageSite?: string | null;
    sourcePageText?: string | null;
    createdAt?: string | null;
    sourceUpdatedAt?: string | null;
  } = {},
): Promise<Note | null> {
  let createdNote: Note | null = null;

  await db.withExclusiveTransactionAsync(async (transaction) => {
    const claimed = await transaction.runAsync(
      `INSERT INTO note_imports (source_key, payload, created_at, source_updated_at)
       VALUES ($sourceKey, $payload, $createdAt, $sourceUpdatedAt)
       ON CONFLICT(source_key) DO NOTHING`,
      {
        $sourceKey: sourceKey,
        $payload: content,
        $createdAt: new Date().toISOString(),
        $sourceUpdatedAt: normalizeImportedTimestamp(metadata.sourceUpdatedAt),
      },
    );

    if (claimed.changes === 0) {
      const existing = await transaction.getFirstAsync<{
        note_id: string | null;
        payload: string;
      }>(
        `SELECT note_id, payload FROM note_imports WHERE source_key = ?`,
        sourceKey,
      );
      if (existing?.note_id) {
        const current = await transaction.getFirstAsync<{
          source_url: string | null;
          user_context: string | null;
          source_page_title: string | null;
          source_page_site: string | null;
          source_page_text: string | null;
          created_at: string;
        }>(
          `SELECT source_url, user_context, source_page_title,
                  source_page_site, source_page_text, created_at
           FROM notes
           WHERE id = ?`,
          existing.note_id,
        );
        const importedCreatedAt = normalizeImportedTimestamp(metadata.createdAt);
        const incomingUserContext = isXiaoyuzhouEpisodeUrl(metadata.sourceUrl)
          ? xiaoyuzhouUserIntent(metadata.userContext)
          : metadata.userContext ?? null;
        const shouldClearSystemContext = Boolean(
          isXiaoyuzhouEpisodeUrl(metadata.sourceUrl) &&
            !incomingUserContext &&
            current?.user_context &&
            SYSTEM_XIAOYUZHOU_INSIGHT_PROMPTS.has(current.user_context.trim()),
        );
        if (
          current &&
          existing.payload === content &&
          nullableTextEqual(current.source_url, metadata.sourceUrl) &&
          nullableTextEqual(
            current.user_context,
            shouldClearSystemContext ? null : incomingUserContext,
          ) &&
          nullableTextEqual(current.source_page_title, metadata.sourcePageTitle) &&
          nullableTextEqual(current.source_page_site, metadata.sourcePageSite) &&
          nullableTextEqual(current.source_page_text, metadata.sourcePageText) &&
          (!importedCreatedAt || current.created_at === importedCreatedAt)
        ) {
          return;
        }
        await transaction.runAsync(
          `UPDATE notes
           SET source_url = COALESCE($sourceUrl, source_url),
               user_context = CASE
                 WHEN $clearUserContext = 1 THEN NULL
                 ELSE COALESCE($userContext, user_context)
               END,
               source_page_title = COALESCE($sourcePageTitle, source_page_title),
               source_page_site = COALESCE($sourcePageSite, source_page_site),
               source_page_text = COALESCE($sourcePageText, source_page_text),
               created_at = COALESCE($createdAt, created_at),
               updated_at = COALESCE($createdAt, updated_at)
           WHERE id = $noteId`,
          {
            $sourceUrl: metadata.sourceUrl ?? null,
            $userContext: incomingUserContext,
            $clearUserContext: shouldClearSystemContext ? 1 : 0,
            $sourcePageTitle: metadata.sourcePageTitle ?? null,
            $sourcePageSite: metadata.sourcePageSite ?? null,
            $sourcePageText: metadata.sourcePageText ?? null,
            $createdAt: normalizeImportedTimestamp(metadata.createdAt),
            $noteId: existing.note_id,
          },
        );
        if (existing.payload !== content) {
          await transaction.runAsync(
            `UPDATE note_imports SET payload = ? WHERE source_key = ?`,
            content,
            sourceKey,
          );
        }
        await transaction.runAsync(
          `UPDATE note_imports
           SET source_updated_at = COALESCE(?, source_updated_at)
           WHERE source_key = ?`,
          normalizeImportedTimestamp(metadata.sourceUpdatedAt),
          sourceKey,
        );
      }
      return;
    }

    createdNote = await createNote(
      transaction,
      content,
      noteSourceFromKey(sourceKey),
      metadata,
    );
    await transaction.runAsync(
      `UPDATE note_imports SET note_id = $noteId WHERE source_key = $sourceKey`,
      { $noteId: createdNote.id, $sourceKey: sourceKey },
    );
  });

  return createdNote;
}

export async function getImportedSourceVersions(
  db: SQLiteDatabase,
  sourceKeys: string[],
): Promise<Map<string, string | null>> {
  await ensureImportedSourceVersionColumn(db);
  if (!sourceKeys.length) return new Map();
  const rows = await db.getAllAsync<{
    source_key: string;
    source_updated_at: string | null;
  }>(
    `SELECT source_key, source_updated_at
     FROM note_imports
     WHERE source_key IN (${sourceKeys.map(() => '?').join(', ')})`,
    ...sourceKeys,
  );
  return new Map(rows.map((row) => [row.source_key, row.source_updated_at]));
}

function normalizeImportedTimestamp(value: string | null | undefined): string | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function nullableTextEqual(
  stored: string | null,
  incoming: string | null | undefined,
): boolean {
  return stored === (incoming ?? null);
}

export async function updateNote(
  db: SQLiteDatabase,
  id: string,
  title: string,
  content: string,
  userContext?: string | null,
): Promise<void> {
  const inferred = inferLinkMetadata(content);
  await db.runAsync(
    `UPDATE notes
     SET title = $title,
         content = $content,
         source_url = COALESCE(source_url, $sourceUrl),
         user_context = $userContext,
         content_kind = $contentKind,
         updated_at = $updatedAt
     WHERE id = $id AND deleted_at IS NULL`,
    {
      $id: id,
      $title: title.trim() || deriveTitle(content),
      $content: content.trim(),
      $sourceUrl: inferred.sourceUrl,
      $userContext: userContext ?? inferred.userContext,
      $contentKind: inferContentKind(content),
      $updatedAt: new Date().toISOString(),
    },
  );
}

export async function deleteNote(
  db: SQLiteDatabase,
  id: string,
): Promise<void> {
  const now = new Date().toISOString();
  await db.runAsync(
    `UPDATE notes
     SET deleted_at = $deletedAt, updated_at = $updatedAt
     WHERE id = $id`,
    { $id: id, $deletedAt: now, $updatedAt: now },
  );
}

export async function listRecentlyDeletedThemes(
  db: SQLiteDatabase,
  limit = 5,
): Promise<Note[]> {
  const rows = await db.getAllAsync<NoteRow>(
    `SELECT id, title, content, summary, status, source, record_type, content_kind,
            source_url, user_context, source_page_title, source_page_site,
            source_page_text, tags_json, created_at, updated_at
     FROM notes
     WHERE deleted_at IS NOT NULL
       AND record_type = 'theme'
     ORDER BY deleted_at DESC
     LIMIT ?`,
    limit,
  );
  return rows.map(mapNoteRow);
}

export async function restoreNote(
  db: SQLiteDatabase,
  id: string,
): Promise<void> {
  await db.runAsync(
    `UPDATE notes
     SET deleted_at = NULL, updated_at = ?
     WHERE id = ? AND deleted_at IS NOT NULL`,
    new Date().toISOString(),
    id,
  );
}

export async function listNotesForOrganization(
  db: SQLiteDatabase,
  sinceIso: string,
): Promise<Note[]> {
  const rows = await db.getAllAsync<NoteRow>(
    `SELECT id, title, content, summary, status, source, record_type, content_kind,
            source_url, user_context, source_page_title, source_page_site,
            source_page_text, tags_json, created_at, updated_at
     FROM notes n
     WHERE n.deleted_at IS NULL
       AND n.source != 'ai'
       AND n.source_url IS NULL
       AND n.created_at >= ?
       AND NOT EXISTS (
         SELECT 1 FROM organize_draft_sources ods
         WHERE ods.note_id = n.id
       )
       AND NOT EXISTS (
         SELECT 1 FROM organize_ignored_sources ois
         WHERE ois.note_id = n.id
       )
     ORDER BY n.created_at ASC
     LIMIT 20`,
    sinceIso,
  );
  return rows.map(mapNoteRow);
}

export async function listLinksReadyForOrganization(
  db: SQLiteDatabase,
): Promise<Note[]> {
  const rows = await db.getAllAsync<NoteRow>(
    `SELECT id, title, content, summary, status, source, record_type, content_kind,
            source_url, user_context, source_page_title, source_page_site,
            source_page_text, tags_json, created_at, updated_at
     FROM notes n
     WHERE n.deleted_at IS NULL
       AND n.record_type = 'capture'
       AND n.status IN ('saved', 'failed')
       AND n.source_url IS NOT NULL
       AND length(trim(COALESCE(n.source_page_text, ''))) >= 20
       AND length(trim(COALESCE(n.user_context, ''))) >= 4
       AND NOT EXISTS (
         SELECT 1 FROM organize_draft_sources ods
         WHERE ods.note_id = n.id
       )
     ORDER BY n.created_at ASC
     LIMIT 5`,
  );
  return rows.map(mapNoteRow);
}

export async function updateNoteStatus(
  db: SQLiteDatabase,
  noteId: string,
  status: Note['status'],
): Promise<void> {
  await db.runAsync(
    `UPDATE notes SET status = ?, updated_at = ? WHERE id = ?`,
    status,
    new Date().toISOString(),
    noteId,
  );
}

export async function saveOrganizationResponse(
  db: SQLiteDatabase,
  response: OrganizationResponse,
  options: { regenerateSourceIds?: string[] } = {},
): Promise<OrganizeDraft[]> {
  const now = new Date().toISOString();
  const regenerateSourceIds = new Set(options.regenerateSourceIds ?? []);
  await db.withExclusiveTransactionAsync(async (transaction) => {
    for (const payload of response.drafts) {
      const sourceIds = [...new Set(payload.sourceIds)];
      if (sourceIds.length === 0) continue;
      const placeholders = sourceIds.map(() => '?').join(', ');
      const regenerating = sourceIds.some((id) => regenerateSourceIds.has(id));
      if (regenerating) {
        await transaction.runAsync(
          `UPDATE organize_drafts
           SET status = 'dismissed', updated_at = ?
           WHERE status = 'pending'
             AND EXISTS (
               SELECT 1 FROM organize_draft_sources source
               WHERE source.draft_id = organize_drafts.id
                 AND source.note_id IN (${placeholders})
             )`,
          now,
          ...sourceIds,
        );
      }
      const existing = await transaction.getFirstAsync<{ id: string }>(
        `SELECT od.id
         FROM organize_drafts od
         INNER JOIN organize_draft_sources ods ON ods.draft_id = od.id
         WHERE ods.note_id IN (${placeholders})
           AND od.status IN (${regenerating ? "'pending'" : "'pending', 'accepted'"})
         LIMIT 1`,
        ...sourceIds,
      );
      if (existing) continue;

      const draftId = createLocalId();
      await transaction.runAsync(
        `INSERT INTO organize_drafts
          (id, title, summary, content, content_kind, tags_json, status,
           created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
        draftId,
        payload.title,
        payload.summary,
        payload.content,
        payload.contentKind ?? 'text',
        JSON.stringify(payload.tags),
        now,
        now,
      );
      for (const sourceId of sourceIds) {
        await transaction.runAsync(
          `INSERT OR IGNORE INTO organize_draft_sources (draft_id, note_id)
           SELECT ?, id FROM notes WHERE id = ?`,
          draftId,
          sourceId,
        );
      }
      for (const [position, citation] of payload.citations.entries()) {
        await transaction.runAsync(
          `INSERT INTO source_citations
            (id, draft_id, source_note_id, quote, start_offset, end_offset,
             position, created_at)
           SELECT ?, ?, id, ?, ?, ?, ?, ?
           FROM notes
           WHERE id = ?`,
          createLocalId(),
          draftId,
          citation.quote,
          citation.startOffset,
          citation.endOffset,
          position,
          now,
          citation.sourceId,
        );
      }
    }
    for (const sourceId of response.ignoredSourceIds) {
      await transaction.runAsync(
        `INSERT OR IGNORE INTO organize_ignored_sources (note_id, created_at)
         SELECT id, ? FROM notes WHERE id = ?`,
        now,
        sourceId,
      );
    }
  });
  return listPendingOrganizationDrafts(db);
}

export async function listPendingOrganizationDrafts(
  db: SQLiteDatabase,
): Promise<OrganizeDraft[]> {
  const rows = await db.getAllAsync<{
    id: string;
    title: string;
    summary: string;
    content: string;
    content_kind: Note['contentKind'];
    tags_json: string;
    created_at: string;
    source_ids: string | null;
    source_url: string | null;
    source_title: string | null;
    source_site: string | null;
    user_context: string | null;
  }>(
    `SELECT
       od.id, od.title, od.summary, od.content, od.content_kind,
       od.tags_json, od.created_at,
       GROUP_CONCAT(ods.note_id) AS source_ids,
       MAX(n.source_url) AS source_url,
       MAX(n.source_page_title) AS source_title,
       MAX(n.source_page_site) AS source_site,
       MAX(n.user_context) AS user_context
     FROM organize_drafts od
     LEFT JOIN organize_draft_sources ods ON ods.draft_id = od.id
     LEFT JOIN notes n ON n.id = ods.note_id
     WHERE od.status = 'pending'
     GROUP BY od.id
     ORDER BY od.created_at ASC`,
  );
  return Promise.all(
    rows.map(async (row) => {
      const citations = await db.getAllAsync<{
        id: string;
        source_note_id: string;
        quote: string;
        start_offset: number;
        end_offset: number;
      }>(
        `SELECT id, source_note_id, quote, start_offset, end_offset
         FROM source_citations
         WHERE draft_id = ?
         ORDER BY position ASC`,
        row.id,
      );
      return {
        id: row.id,
        title: row.title,
        summary: row.summary,
        content: row.content,
        contentKind: row.content_kind,
        tags: parseStringArray(row.tags_json),
        sourceIds: row.source_ids ? row.source_ids.split(',') : [],
        citations: citations.map((citation) => ({
          id: citation.id,
          sourceId: citation.source_note_id,
          quote: citation.quote,
          startOffset: citation.start_offset,
          endOffset: citation.end_offset,
        })),
        sourceUrl: row.source_url,
        sourceTitle: row.source_title,
        sourceSite: row.source_site,
        userContext: isXiaoyuzhouEpisodeUrl(row.source_url)
          ? xiaoyuzhouUserIntent(row.user_context)
          : row.user_context,
        createdAt: row.created_at,
      };
    }),
  );
}

export async function acceptOrganizationDraft(
  db: SQLiteDatabase,
  draftId: string,
  title: string,
  content: string,
): Promise<Note> {
  let created: Note | null = null;
  await db.withExclusiveTransactionAsync(async (transaction) => {
    const draft = await transaction.getFirstAsync<{
      summary: string;
      status: string;
      tags_json: string;
      content_kind: Note['contentKind'];
    }>(
      `SELECT summary, status, tags_json, content_kind
       FROM organize_drafts WHERE id = ?`,
      draftId,
    );
    if (!draft || draft.status !== 'pending') {
      throw new Error('Draft is no longer pending');
    }
    const now = new Date().toISOString();
    const linkSource = await transaction.getFirstAsync<{
      source_url: string | null;
      user_context: string | null;
      source_page_title: string | null;
      source_page_site: string | null;
    }>(
      `SELECT n.source_url, n.user_context, n.source_page_title,
              n.source_page_site
       FROM organize_draft_sources ods
       INNER JOIN notes n ON n.id = ods.note_id
       WHERE ods.draft_id = ? AND n.source_url IS NOT NULL
       ORDER BY n.created_at ASC
       LIMIT 1`,
      draftId,
    );
    const citations = await transaction.getAllAsync<{
      quote: string;
    }>(
      `SELECT quote
       FROM source_citations
       WHERE draft_id = ?
       ORDER BY position ASC`,
      draftId,
    );
    const finalContent = buildAcceptedContent(
      content,
      draft.content_kind,
      isXiaoyuzhouEpisodeUrl(linkSource?.source_url)
        ? xiaoyuzhouUserIntent(linkSource?.user_context)
        : linkSource?.user_context ?? null,
      linkSource?.source_url ?? null,
      linkSource?.source_page_title ?? null,
      citations.map((citation) => citation.quote),
    );
    const previous = await transaction.getFirstAsync<{
      id: string;
      created_at: string;
    }>(
      `SELECT generated.id, generated.created_at
       FROM organize_draft_sources current_source
       INNER JOIN organize_draft_sources previous_source
         ON previous_source.note_id = current_source.note_id
        AND previous_source.draft_id != current_source.draft_id
       INNER JOIN organize_drafts previous_draft
         ON previous_draft.id = previous_source.draft_id
        AND previous_draft.status = 'accepted'
       INNER JOIN source_citations previous_citation
         ON previous_citation.draft_id = previous_draft.id
        AND previous_citation.note_id IS NOT NULL
       INNER JOIN notes generated
         ON generated.id = previous_citation.note_id
        AND generated.deleted_at IS NULL
        AND generated.record_type = 'source'
       WHERE current_source.draft_id = ?
       ORDER BY previous_draft.updated_at DESC
       LIMIT 1`,
      draftId,
    );
    created = {
      id: previous?.id ?? createLocalId(),
      title: title.trim() || deriveTitle(content),
      content: finalContent,
      summary: draft.summary,
      status: 'ready',
      source: 'ai',
      recordType: draft.content_kind === 'link' ? 'source' : 'synthesis',
      contentKind: draft.content_kind,
      sourceUrl: linkSource?.source_url ?? null,
      userContext: isXiaoyuzhouEpisodeUrl(linkSource?.source_url)
        ? xiaoyuzhouUserIntent(linkSource?.user_context)
        : linkSource?.user_context ?? null,
      sourcePageTitle: linkSource?.source_page_title ?? null,
      sourcePageSite: linkSource?.source_page_site ?? null,
      sourcePageText: null,
      tags: parseStringArray(draft.tags_json),
      createdAt: previous?.created_at ?? now,
      updatedAt: now,
    };
    if (previous) {
      await transaction.runAsync(
        `UPDATE notes
         SET title = ?, content = ?, summary = ?, status = 'ready',
             source = 'ai', record_type = ?, content_kind = ?,
             source_url = ?, user_context = ?, source_page_title = ?,
             source_page_site = ?, source_page_text = NULL, tags_json = ?,
             updated_at = ?
         WHERE id = ?`,
        created.title,
        created.content,
        created.summary,
        created.recordType,
        created.contentKind,
        created.sourceUrl,
        created.userContext,
        created.sourcePageTitle,
        created.sourcePageSite,
        draft.tags_json,
        now,
        created.id,
      );
      await transaction.runAsync(
        'UPDATE source_citations SET note_id = NULL WHERE note_id = ?',
        created.id,
      );
    } else {
      await transaction.runAsync(
        `INSERT INTO notes
          (id, title, content, summary, status, source, record_type, content_kind,
           source_url, user_context, source_page_title, source_page_site,
           source_page_text, tags_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'ready', 'ai', ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
        created.id,
        created.title,
        created.content,
        created.summary,
        created.recordType,
        created.contentKind,
        created.sourceUrl,
        created.userContext,
        created.sourcePageTitle,
        created.sourcePageSite,
        draft.tags_json,
        now,
        now,
      );
    }
    await transaction.runAsync(
      `UPDATE organize_drafts
       SET status = 'accepted', title = ?, content = ?, updated_at = ?
       WHERE id = ?`,
      created.title,
      created.content,
      now,
      draftId,
    );
    await transaction.runAsync(
      `UPDATE source_citations SET note_id = ? WHERE draft_id = ?`,
      created.id,
      draftId,
    );
    await transaction.runAsync(
      `UPDATE organize_drafts
       SET status = 'dismissed', updated_at = ?
       WHERE id != ?
         AND status = 'pending'
         AND EXISTS (
           SELECT 1
           FROM organize_draft_sources accepted_source
           INNER JOIN organize_draft_sources duplicate_source
             ON duplicate_source.note_id = accepted_source.note_id
           WHERE accepted_source.draft_id = ?
             AND duplicate_source.draft_id = organize_drafts.id
         )`,
      now,
      draftId,
      draftId,
    );
  });
  if (!created) throw new Error('Unable to create organized note');
  return created;
}

function buildAcceptedContent(
  content: string,
  contentKind: Note['contentKind'],
  userContext: string | null,
  sourceUrl: string | null,
  sourceTitle: string | null,
  citations: string[],
): string {
  const sections: string[] = [];
  if (contentKind === 'link' && userContext?.trim()) {
    sections.push(`## 我的保存意图\n\n${userContext.trim()}`);
  }
  sections.push(content.trim());
  if (citations.length > 0) {
    const evidence = citations
      .map((quote, index) => {
        const lines = quote
          .split('\n')
          .map((line) => `> ${line}`)
          .join('\n');
        return `### 证据 ${index + 1}\n\n${lines}`;
      })
      .join('\n\n');
    const source = sourceUrl
      ? `\n\n[打开原文：${sourceTitle?.trim() || sourceUrl}](${sourceUrl})`
      : '';
    sections.push(
      `${contentKind === 'link' ? '## 原始证据' : '## 来源记录'}\n\n${evidence}${source}`,
    );
  }
  return sections.filter(Boolean).join('\n\n');
}

export async function dismissOrganizationDraft(
  db: SQLiteDatabase,
  draftId: string,
): Promise<void> {
  await db.runAsync(
    `UPDATE organize_drafts
     SET status = 'dismissed', updated_at = ?
     WHERE id = ? AND status = 'pending'`,
    new Date().toISOString(),
    draftId,
  );
}

export async function listThemeNotes(db: SQLiteDatabase): Promise<Note[]> {
  const rows = await db.getAllAsync<NoteRow>(
    `SELECT id, title, content, summary, status, source, record_type, content_kind,
            source_url, user_context, source_page_title, source_page_site,
            source_page_text, tags_json, created_at, updated_at
     FROM notes
     WHERE deleted_at IS NULL AND record_type = 'theme'
     ORDER BY updated_at DESC
     LIMIT 50`,
  );
  return rows.map(mapNoteRow);
}

export async function getThemeOverview(
  db: SQLiteDatabase,
  themeNoteId: string,
): Promise<string> {
  const row = await db.getFirstAsync<{ content: string }>(
    `SELECT content FROM theme_overviews WHERE theme_note_id = ?`,
    themeNoteId,
  );
  return row?.content ?? '';
}

export async function listThemeOverviewMap(
  db: SQLiteDatabase,
): Promise<Record<string, string>> {
  const rows = await db.getAllAsync<{
    theme_note_id: string;
    content: string;
  }>('SELECT theme_note_id, content FROM theme_overviews');
  return Object.fromEntries(
    rows.map((row) => [row.theme_note_id, row.content]),
  );
}

export async function updateThemeOverview(
  db: SQLiteDatabase,
  themeNoteId: string,
  content: string,
): Promise<void> {
  const normalized = content.trim();
  if (!normalized) throw new Error('Theme overview cannot be empty');
  const now = new Date().toISOString();
  await db.runAsync(
    `INSERT INTO theme_overviews
      (theme_note_id, content, created_at, updated_at)
     SELECT id, ?, ?, ?
     FROM notes
     WHERE id = ? AND record_type = 'theme' AND deleted_at IS NULL
     ON CONFLICT(theme_note_id) DO UPDATE SET
       content = excluded.content,
       updated_at = excluded.updated_at`,
    normalized,
    now,
    now,
    themeNoteId,
  );
}

export async function listThemeSourceContributions(
  db: SQLiteDatabase,
  themeNoteId: string,
): Promise<ThemeSourceContribution[]> {
  const rows = await db.getAllAsync<
    NoteRow & {
      contribution: string | null;
      linked_at: string;
    }
  >(
    `SELECT source.id, source.title, source.content, source.summary,
            source.status, source.source, source.record_type,
            source.content_kind, source.source_url, source.user_context,
            source.source_page_title, source.source_page_site,
            source.source_page_text, source.tags_json, source.created_at,
            source.updated_at, ts.contribution, ts.created_at AS linked_at
     FROM theme_sources ts
     INNER JOIN notes source ON source.id = ts.source_note_id
     WHERE ts.theme_note_id = ?
       AND source.deleted_at IS NULL
     ORDER BY ts.created_at DESC`,
    themeNoteId,
  );
  return rows
    .filter(
      (
        row,
      ): row is NoteRow & { contribution: string; linked_at: string } =>
        Boolean(row.contribution?.trim()),
    )
    .map((row) => ({
      source: mapNoteRow(row),
      contribution: row.contribution,
      addedAt: row.linked_at,
    }));
}

export async function listThemeSourceSummaries(
  db: SQLiteDatabase,
): Promise<Record<string, ThemeSourceSummary>> {
  const rows = await db.getAllAsync<{
    theme_note_id: string;
    source_count: number;
    last_added_at: string;
  }>(
    `SELECT theme_note_id, COUNT(*) AS source_count,
            MAX(created_at) AS last_added_at
     FROM theme_sources
     WHERE contribution IS NOT NULL
       AND length(trim(contribution)) > 0
     GROUP BY theme_note_id`,
  );
  return Object.fromEntries(
    rows.map((row) => [
      row.theme_note_id,
      {
        count: row.source_count,
        lastAddedAt: row.last_added_at,
      },
    ]),
  );
}

export async function getSourceThemeAssignment(
  db: SQLiteDatabase,
  sourceNoteId: string,
): Promise<SourceThemeAssignment | null> {
  const row = await db.getFirstAsync<{
    source_note_id: string;
    theme_id: string;
    theme_title: string;
    contribution: string | null;
  }>(
    `SELECT ts.source_note_id, theme.id AS theme_id,
            theme.title AS theme_title, ts.contribution
     FROM theme_sources ts
     INNER JOIN notes theme ON theme.id = ts.theme_note_id
     WHERE (
         ts.source_note_id = $noteId
         OR EXISTS (
           SELECT 1
           FROM source_citations citation
           WHERE citation.note_id = ts.source_note_id
             AND citation.source_note_id = $noteId
         )
       )
       AND theme.record_type = 'theme'
       AND theme.deleted_at IS NULL
     ORDER BY CASE WHEN ts.source_note_id = $noteId THEN 0 ELSE 1 END
     LIMIT 1`,
    { $noteId: sourceNoteId },
  );
  return row
    ? {
        sourceNoteId: row.source_note_id,
        themeId: row.theme_id,
        themeTitle: row.theme_title,
        contributionAvailable: Boolean(row.contribution),
      }
    : null;
}

export async function getOriginalCaptureForNote(
  db: SQLiteDatabase,
  noteId: string,
): Promise<Note | null> {
  const row = await db.getFirstAsync<NoteRow>(
    `SELECT DISTINCT
            original.id, original.title, original.content, original.summary,
            original.status, original.source, original.record_type,
            original.content_kind, original.source_url, original.user_context,
            original.source_page_title, original.source_page_site,
            original.source_page_text, original.tags_json, original.created_at,
            original.updated_at
     FROM source_citations citation
     INNER JOIN notes original ON original.id = citation.source_note_id
     WHERE citation.note_id = ?
       AND original.record_type = 'capture'
       AND original.deleted_at IS NULL
     ORDER BY original.created_at ASC
     LIMIT 1`,
    noteId,
  );
  return row ? mapNoteRow(row) : null;
}

export async function listRelatedMemories(
  db: SQLiteDatabase,
  noteId: string,
  limit = 3,
): Promise<RelatedMemory[]> {
  const requested = await getNoteById(db, noteId);
  if (!requested || requested.recordType === 'theme') return [];

  const canonicalSourceId = await resolveCanonicalSourceNoteId(db, noteId);
  const current =
    canonicalSourceId === noteId
      ? requested
      : (await getNoteById(db, canonicalSourceId)) ?? requested;
  const assignment = await getSourceThemeAssignment(db, canonicalSourceId);
  const memories: RelatedMemory[] = [];
  const includedIds = new Set([noteId, canonicalSourceId]);

  if (assignment) {
    const sameThemeRows = await db.getAllAsync<NoteRow>(
      `SELECT source.id, source.title, source.content, source.summary,
              source.status, source.source, source.record_type,
              source.content_kind, source.source_url, source.user_context,
              source.source_page_title, source.source_page_site,
              source.source_page_text, source.tags_json, source.created_at,
              source.updated_at
       FROM theme_sources ts
       INNER JOIN notes source ON source.id = ts.source_note_id
       WHERE ts.theme_note_id = ?
         AND ts.source_note_id != ?
         AND source.deleted_at IS NULL
       ORDER BY ts.created_at DESC
       LIMIT ?`,
      assignment.themeId,
      canonicalSourceId,
      limit,
    );
    for (const row of sameThemeRows) {
      const note = mapNoteRow(row);
      memories.push({
        note,
        reason: `同属「${assignment.themeTitle}」主题`,
        relation: 'same-theme',
      });
      includedIds.add(note.id);
    }
  }

  if (memories.length >= limit) return memories.slice(0, limit);

  const candidates = await db.getAllAsync<NoteRow>(
    `SELECT id, title, content, summary, status, source, record_type, content_kind,
            source_url, user_context, source_page_title, source_page_site,
            source_page_text, tags_json, created_at, updated_at
     FROM notes
     WHERE deleted_at IS NULL
       AND record_type IN ('source', 'synthesis')
       AND id != ?
     ORDER BY updated_at DESC
     LIMIT 120`,
    canonicalSourceId,
  );
  type RankedRecall = {
    note: Note;
    reason: string;
    relation: 'shared-tags' | 'shared-keywords';
    score: number;
  };
  const ranked = candidates
    .map(mapNoteRow)
    .filter((candidate) => !includedIds.has(candidate.id))
    .map((candidate) => {
      const relation = compareNotesForRecall(current, candidate);
      return relation ? { note: candidate, ...relation } : null;
    })
    .filter((item): item is RankedRecall => item !== null)
    .sort(
      (left, right) =>
        right.score - left.score ||
        right.note.updatedAt.localeCompare(left.note.updatedAt),
    );

  for (const item of ranked) {
    memories.push({
      note: item.note,
      reason: item.reason,
      relation: item.relation,
    });
    if (memories.length >= limit) break;
  }
  return memories;
}

export async function getRecallSuggestion(
  db: SQLiteDatabase,
): Promise<RecallSuggestion | null> {
  const now = new Date();
  const today = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  ).toISOString();
  const active = await db.getFirstAsync<{
    memory_note_id: string;
    anchor_note_id: string;
    reason: string;
  }>(
    `SELECT memory_note_id, anchor_note_id, reason
     FROM recall_states
     WHERE status = 'shown' AND shown_at >= ?
     ORDER BY shown_at DESC
     LIMIT 1`,
    today,
  );
  if (active) {
    const [memory, anchor] = await Promise.all([
      getNoteById(db, active.memory_note_id),
      getNoteById(db, active.anchor_note_id),
    ]);
    if (memory && anchor) {
      const relation = await recallRelation(db, anchor, memory);
      if (relation) {
        return {
          memory,
          anchor,
          reason: `因为你最近记下「${shortRecallTitle(anchor.title)}」，${relation.reason}`,
        };
      }
    }
    await db.runAsync(
      `UPDATE recall_states
       SET status = 'dismissed', updated_at = ?
       WHERE memory_note_id = ? AND status = 'shown'`,
      now.toISOString(),
      active.memory_note_id,
    );
  }

  const sevenDaysAgo = new Date(
    now.getTime() - 7 * 24 * 60 * 60 * 1000,
  ).toISOString();
  const twoDaysAgo = new Date(
    now.getTime() - 2 * 24 * 60 * 60 * 1000,
  ).toISOString();
  const blockedRows = await db.getAllAsync<{ memory_note_id: string }>(
    `SELECT memory_note_id
     FROM recall_states
     WHERE shown_at >= ?
        OR (snoozed_until IS NOT NULL AND snoozed_until > ?)
        OR (opened_at IS NOT NULL AND opened_at >= ?)`,
    sevenDaysAgo,
    now.toISOString(),
    sevenDaysAgo,
  );
  const blocked = new Set(blockedRows.map((row) => row.memory_note_id));
  const anchorRows = await db.getAllAsync<NoteRow>(
    `SELECT id, title, content, summary, status, source, record_type, content_kind,
            source_url, user_context, source_page_title, source_page_site,
            source_page_text, tags_json, created_at, updated_at
     FROM notes
     WHERE deleted_at IS NULL
       AND record_type IN ('source', 'synthesis')
       AND updated_at >= ?
     ORDER BY updated_at DESC
     LIMIT 6`,
    sevenDaysAgo,
  );

  for (const anchor of anchorRows.map(mapNoteRow)) {
    const related = await listRelatedMemories(db, anchor.id, 8);
    const match = related.find(
      (item) =>
        item.note.createdAt < twoDaysAgo &&
        item.note.createdAt < anchor.createdAt &&
        !blocked.has(item.note.id) &&
        compareNotesForRecall(anchor, item.note) !== null,
    );
    if (!match) continue;

    const reason = `因为你最近记下「${shortRecallTitle(anchor.title)}」，${match.reason}`;
    const shownAt = now.toISOString();
    await db.runAsync(
      `INSERT INTO recall_states
        (memory_note_id, anchor_note_id, reason, status, shown_at,
         snoozed_until, opened_at, updated_at)
       VALUES (?, ?, ?, 'shown', ?, NULL, NULL, ?)
       ON CONFLICT(memory_note_id) DO UPDATE SET
         anchor_note_id = excluded.anchor_note_id,
         reason = excluded.reason,
         status = 'shown',
         shown_at = excluded.shown_at,
         snoozed_until = NULL,
         updated_at = excluded.updated_at`,
      match.note.id,
      anchor.id,
      reason,
      shownAt,
      shownAt,
    );
    return { memory: match.note, anchor, reason };
  }
  return null;
}

export async function recordRecallAction(
  db: SQLiteDatabase,
  memoryNoteId: string,
  action: 'opened' | 'snoozed',
): Promise<void> {
  const now = new Date();
  if (action === 'opened') {
    await db.runAsync(
      `UPDATE recall_states
       SET status = 'opened', opened_at = ?, updated_at = ?
       WHERE memory_note_id = ?`,
      now.toISOString(),
      now.toISOString(),
      memoryNoteId,
    );
    return;
  }
  const snoozedUntil = new Date(
    now.getTime() + 30 * 24 * 60 * 60 * 1000,
  ).toISOString();
  await db.runAsync(
    `UPDATE recall_states
     SET status = 'snoozed', snoozed_until = ?, updated_at = ?
     WHERE memory_note_id = ?`,
    snoozedUntil,
    now.toISOString(),
    memoryNoteId,
  );
}

function shortRecallTitle(title: string): string {
  const normalized = title.trim();
  return normalized.length > 18 ? `${normalized.slice(0, 18)}…` : normalized;
}

async function getNoteById(
  db: SQLiteDatabase,
  noteId: string,
): Promise<Note | null> {
  const row = await db.getFirstAsync<NoteRow>(
    `SELECT id, title, content, summary, status, source, record_type, content_kind,
            source_url, user_context, source_page_title, source_page_site,
            source_page_text, tags_json, created_at, updated_at
     FROM notes
     WHERE id = ? AND deleted_at IS NULL`,
    noteId,
  );
  return row ? mapNoteRow(row) : null;
}

async function resolveCanonicalSourceNoteId(
  db: SQLiteDatabase,
  noteId: string,
): Promise<string> {
  const row = await db.getFirstAsync<{ source_note_id: string }>(
    `SELECT source_note_id
     FROM (
       SELECT ts.source_note_id, 0 AS priority
       FROM theme_sources ts
       WHERE ts.source_note_id = $noteId
       UNION ALL
       SELECT citation.note_id AS source_note_id, 1 AS priority
       FROM source_citations citation
       WHERE citation.source_note_id = $noteId
         AND citation.note_id IS NOT NULL
     )
     ORDER BY priority ASC
     LIMIT 1`,
    { $noteId: noteId },
  );
  return row?.source_note_id ?? noteId;
}

const RECALL_STOPWORDS = new Set([
  '一个',
  '一种',
  '一些',
  '以及',
  '关于',
  '可以',
  '如何',
  '我们',
  '这个',
  '这些',
  '文章',
  '内容',
  '理解',
  '重点',
  '来源',
  '笔记',
  '整理',
  '通过',
  '进行',
  '问题',
  '观点',
  '用户',
  '与用户',
  '方法',
  '方式',
  '主题',
  '事情',
  '自己',
  '觉得',
  'ai',
  '视频',
  '阅读',
  '工作',
  '知识',
]);

async function recallRelation(
  db: SQLiteDatabase,
  current: Note,
  candidate: Note,
): Promise<{
  reason: string;
  relation: RelatedMemory['relation'];
  score: number;
} | null> {
  const [currentId, candidateId] = await Promise.all([
    resolveCanonicalSourceNoteId(db, current.id),
    resolveCanonicalSourceNoteId(db, candidate.id),
  ]);
  const [currentTheme, candidateTheme] = await Promise.all([
    getSourceThemeAssignment(db, currentId),
    getSourceThemeAssignment(db, candidateId),
  ]);
  if (
    currentTheme &&
    candidateTheme &&
    currentTheme.themeId === candidateTheme.themeId
  ) {
    const semanticRelation = compareNotesForRecall(current, candidate);
    if (!semanticRelation) return null;
    return {
      reason: `同属「${currentTheme.themeTitle}」主题`,
      relation: 'same-theme',
      score: 100,
    };
  }
  return compareNotesForRecall(current, candidate);
}

export function compareNotesForRecall(
  current: Note,
  candidate: Note,
): {
  reason: string;
  relation: 'shared-tags' | 'shared-keywords';
  score: number;
} | null {
  const currentTags = new Set(
    current.tags.map(normalizeRecallTerm).filter(Boolean),
  );
  const sharedTags = candidate.tags
    .map(normalizeRecallTerm)
    .filter(
      (tag, index, tags) =>
        Boolean(tag) && currentTags.has(tag) && tags.indexOf(tag) === index,
    );
  if (sharedTags.length > 0) {
    return {
      reason: `都涉及「${sharedTags.slice(0, 2).join('、')}」`,
      relation: 'shared-tags',
      score: 70 + Math.min(sharedTags.length, 3) * 8,
    };
  }

  const currentKeywords = extractRecallKeywords(current);
  const candidateKeywords = new Set(extractRecallKeywords(candidate));
  const sharedKeywords = currentKeywords
    .filter((keyword) => candidateKeywords.has(keyword))
    .sort((left, right) => right.length - left.length)
    .filter(
      (keyword, index, keywords) =>
        !keywords.slice(0, index).some((other) => other.includes(keyword)),
    );
  const meaningfulKeywords = sharedKeywords.filter(
    (keyword) => keyword.length >= 3,
  );
  const strongest = meaningfulKeywords[0];
  if (
    !strongest ||
    (strongest.length < 4 && meaningfulKeywords.length < 2)
  ) {
    return null;
  }
  return {
    reason: `都提到了「${meaningfulKeywords.slice(0, 2).join('、')}」`,
    relation: 'shared-keywords',
    score:
      35 +
      Math.min(
        meaningfulKeywords.reduce(
          (total, keyword) => total + keyword.length,
          0,
        ),
        24,
      ),
  };
}

function extractRecallKeywords(note: Note): string[] {
  const text = [note.title, note.summary ?? '', note.userContext ?? '']
    .join(' ')
    .toLowerCase();
  const terms = new Set<string>();
  for (const match of text.matchAll(/[a-z0-9][a-z0-9+.-]{2,}|[\u3400-\u9fff]{2,12}/g)) {
    const value = match[0];
    if (/^[a-z0-9]/.test(value)) {
      terms.add(value);
      continue;
    }
    for (const length of [4, 3, 2]) {
      if (value.length < length) continue;
      for (let index = 0; index <= value.length - length; index += 1) {
        const term = value.slice(index, index + length);
        if (!RECALL_STOPWORDS.has(term)) terms.add(term);
      }
    }
  }
  return [...terms];
}

function normalizeRecallTerm(value: string): string {
  const normalized = value.trim().toLowerCase();
  return RECALL_STOPWORDS.has(normalized) ? '' : normalized;
}

export async function reclassifySourceTheme(
  db: SQLiteDatabase,
  sourceNoteId: string,
  targetThemeId: string | null,
  newThemeTitle: string,
): Promise<ReclassifySourceResult> {
  let result: ReclassifySourceResult | null = null;
  await db.withExclusiveTransactionAsync(async (transaction) => {
    const assignment = await transaction.getFirstAsync<{
      theme_note_id: string;
      contribution: string | null;
      source_title: string;
      source_url: string | null;
      patch: string | null;
      conflicts_json: string | null;
    }>(
      `SELECT ts.theme_note_id, ts.contribution,
              source.title AS source_title, source.source_url,
              tmd.patch, tmd.conflicts_json
       FROM theme_sources ts
       INNER JOIN notes source ON source.id = ts.source_note_id
       LEFT JOIN theme_merge_drafts tmd
         ON tmd.source_note_id = ts.source_note_id
        AND tmd.status = 'accepted'
       WHERE ts.source_note_id = ?`,
      sourceNoteId,
    );
    if (!assignment) throw new Error('Source note has no theme assignment');

    const previousRow = await getThemeNoteRow(
      transaction,
      assignment.theme_note_id,
    );
    if (!previousRow) throw new Error('Current theme does not exist');

    let resolvedTargetId = targetThemeId;
    const now = new Date().toISOString();
    if (!resolvedTargetId) {
      const title = newThemeTitle.trim();
      if (!title) throw new Error('New theme title is required');
      resolvedTargetId = createLocalId();
      await transaction.runAsync(
        `INSERT INTO notes
          (id, title, content, summary, status, source, record_type, content_kind,
           source_url, user_context, source_page_title, source_page_site,
           source_page_text, tags_json, created_at, updated_at)
         VALUES (?, ?, '', NULL, 'ready', 'ai', 'theme', 'text',
                 NULL, NULL, NULL, NULL, NULL, ?, ?, ?)`,
        resolvedTargetId,
        title,
        JSON.stringify(['主题']),
        now,
        now,
      );
    }

    const targetRow = await getThemeNoteRow(transaction, resolvedTargetId);
    if (!targetRow) throw new Error('Selected theme does not exist');
    if (resolvedTargetId === assignment.theme_note_id) {
      result = {
        previousTheme: mapNoteRow(previousRow),
        targetTheme: mapNoteRow(targetRow),
        removedFromPrevious: true,
      };
      return;
    }

    const contribution =
      assignment.contribution ??
      (assignment.patch
        ? renderThemeAddition(
            assignment.patch,
            assignment.source_title,
            assignment.source_url,
            parseStringArray(assignment.conflicts_json ?? '[]'),
          )
        : null);
    if (!contribution) {
      throw new Error('Source contribution cannot be reconstructed');
    }

    const previousContent = removeThemeContribution(
      previousRow.content,
      contribution,
    );
    const removedFromPrevious = previousContent !== null;
    if (removedFromPrevious) {
      await transaction.runAsync(
        `UPDATE notes SET content = ?, updated_at = ? WHERE id = ?`,
        previousContent,
        now,
        assignment.theme_note_id,
      );
    }
    await transaction.runAsync(
      `UPDATE notes
       SET content = CASE
             WHEN length(trim(content)) = 0 THEN ?
             ELSE trim(content) || char(10) || char(10) || ?
           END,
           updated_at = ?
       WHERE id = ?`,
      contribution,
      contribution,
      now,
      resolvedTargetId,
    );
    await transaction.runAsync(
      `UPDATE theme_sources
       SET theme_note_id = ?, contribution = ?, updated_at = ?
       WHERE source_note_id = ?`,
      resolvedTargetId,
      contribution,
      now,
      sourceNoteId,
    );
    await transaction.runAsync(
      `UPDATE theme_merge_drafts
       SET theme_note_id = ?, updated_at = ?
       WHERE source_note_id = ? AND status = 'accepted'`,
      resolvedTargetId,
      now,
      sourceNoteId,
    );

    const refreshedPrevious = await getThemeNoteRow(
      transaction,
      assignment.theme_note_id,
    );
    const refreshedTarget = await getThemeNoteRow(
      transaction,
      resolvedTargetId,
    );
    if (!refreshedPrevious || !refreshedTarget) {
      throw new Error('Unable to refresh themes after reclassification');
    }
    result = {
      previousTheme: mapNoteRow(refreshedPrevious),
      targetTheme: mapNoteRow(refreshedTarget),
      removedFromPrevious,
    };
  });
  if (!result) throw new Error('Unable to reclassify source note');
  return result;
}

export async function saveThemeMergeDraft(
  db: SQLiteDatabase,
  sourceNoteId: string,
  response: ThemeMergeResponse,
): Promise<ThemeMergeDraft[]> {
  const now = new Date().toISOString();
  await db.runAsync(
    `INSERT INTO theme_merge_drafts
      (id, source_note_id, theme_note_id, theme_title, rationale, patch,
       overview, conflicts_json, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
     ON CONFLICT(source_note_id) DO UPDATE SET
       theme_note_id = excluded.theme_note_id,
       theme_title = excluded.theme_title,
       rationale = excluded.rationale,
       patch = excluded.patch,
       overview = excluded.overview,
       conflicts_json = excluded.conflicts_json,
       status = 'pending',
       updated_at = excluded.updated_at`,
    createLocalId(),
    sourceNoteId,
    response.themeId,
    response.themeTitle,
    response.rationale,
    response.patch,
    response.overview,
    JSON.stringify(response.conflicts),
    now,
    now,
  );
  return listPendingThemeMergeDrafts(db);
}

export async function listPendingThemeMergeDrafts(
  db: SQLiteDatabase,
): Promise<ThemeMergeDraft[]> {
  const rows = await db.getAllAsync<{
    id: string;
    source_note_id: string;
    source_title: string;
    source_url: string | null;
    theme_note_id: string | null;
    theme_title: string;
    rationale: string;
    patch: string;
    overview: string;
    conflicts_json: string;
    created_at: string;
  }>(
    `SELECT tmd.id, tmd.source_note_id, source.title AS source_title,
            source.source_url, tmd.theme_note_id, tmd.theme_title,
            tmd.rationale, tmd.patch, tmd.overview, tmd.conflicts_json,
            tmd.created_at
     FROM theme_merge_drafts tmd
     INNER JOIN notes source ON source.id = tmd.source_note_id
     WHERE tmd.status = 'pending'
     ORDER BY tmd.created_at ASC`,
  );
  return rows.map((row) => ({
    id: row.id,
    sourceNoteId: row.source_note_id,
    sourceTitle: row.source_title,
    sourceUrl: row.source_url,
    themeNoteId: row.theme_note_id,
    themeTitle: row.theme_title,
    rationale: row.rationale,
    patch: row.patch,
    overview: row.overview,
    conflicts: parseStringArray(row.conflicts_json),
    createdAt: row.created_at,
  }));
}

export async function acceptThemeMergeDraft(
  db: SQLiteDatabase,
  draftId: string,
  patch: string,
  overview: string,
  selectedThemeId: string | null,
  selectedThemeTitle: string,
): Promise<Note> {
  let themeNote: Note | null = null;
  await db.withExclusiveTransactionAsync(async (transaction) => {
    const draft = await transaction.getFirstAsync<{
      source_note_id: string;
      theme_note_id: string | null;
      theme_title: string;
      rationale: string;
      overview: string;
      conflicts_json: string;
      status: string;
      source_title: string;
      source_url: string | null;
    }>(
      `SELECT tmd.source_note_id, tmd.theme_note_id, tmd.theme_title,
              tmd.rationale, tmd.overview, tmd.conflicts_json, tmd.status,
              source.title AS source_title, source.source_url
       FROM theme_merge_drafts tmd
       INNER JOIN notes source ON source.id = tmd.source_note_id
       WHERE tmd.id = ?`,
      draftId,
    );
    if (!draft || draft.status !== 'pending') {
      throw new Error('Theme merge draft is no longer pending');
    }

    const now = new Date().toISOString();
    const existingLink = await transaction.getFirstAsync<{
      theme_note_id: string;
    }>(
      `SELECT theme_note_id
       FROM theme_sources
       WHERE source_note_id = ?`,
      draft.source_note_id,
    );
    let themeNoteId = existingLink?.theme_note_id ?? selectedThemeId;
    if (themeNoteId) {
      const selectedTheme = await transaction.getFirstAsync<{ id: string }>(
        `SELECT id
         FROM notes
         WHERE id = ? AND record_type = 'theme' AND deleted_at IS NULL`,
        themeNoteId,
      );
      if (!selectedTheme) throw new Error('Selected theme does not exist');
    }
    if (!themeNoteId) {
      themeNoteId = createLocalId();
      await transaction.runAsync(
        `INSERT INTO notes
          (id, title, content, summary, status, source, record_type, content_kind,
           source_url, user_context, source_page_title, source_page_site,
           source_page_text, tags_json, created_at, updated_at)
         VALUES (?, ?, '', ?, 'ready', 'ai', 'theme', 'text',
                 NULL, NULL, NULL, NULL, NULL, ?, ?, ?)`,
        themeNoteId,
        selectedThemeTitle.trim() || draft.theme_title,
        draft.rationale,
        JSON.stringify(['主题']),
        now,
        now,
      );
    }

    const addition = renderThemeAddition(
      patch,
      draft.source_title,
      draft.source_url,
      parseStringArray(draft.conflicts_json),
    );
    const linked = await transaction.runAsync(
      `INSERT OR IGNORE INTO theme_sources
        (theme_note_id, source_note_id, contribution, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
      themeNoteId,
      draft.source_note_id,
      addition,
      now,
      now,
    );
    if (linked.changes > 0) {
      await transaction.runAsync(
        `UPDATE notes
         SET content = CASE
               WHEN length(trim(content)) = 0 THEN ?
               ELSE trim(content) || char(10) || char(10) || ?
             END,
             updated_at = ?
         WHERE id = ? AND record_type = 'theme' AND deleted_at IS NULL`,
        addition,
        addition,
        now,
        themeNoteId,
      );
    }
    if (overview.trim()) {
      await transaction.runAsync(
        `INSERT INTO theme_overviews
          (theme_note_id, content, created_at, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(theme_note_id) DO UPDATE SET
           content = excluded.content,
           updated_at = excluded.updated_at`,
        themeNoteId,
        overview.trim(),
        now,
        now,
      );
    }
    await transaction.runAsync(
      `UPDATE theme_merge_drafts
       SET status = 'accepted', patch = ?, overview = ?,
           theme_note_id = ?, updated_at = ?
       WHERE id = ?`,
      patch.trim(),
      overview.trim(),
      themeNoteId,
      now,
      draftId,
    );
    const row = await transaction.getFirstAsync<NoteRow>(
      `SELECT id, title, content, summary, status, source, record_type, content_kind,
              source_url, user_context, source_page_title, source_page_site,
              source_page_text, tags_json, created_at, updated_at
       FROM notes WHERE id = ?`,
      themeNoteId,
    );
    if (row) themeNote = mapNoteRow(row);
  });
  if (!themeNote) throw new Error('Unable to update theme note');
  return themeNote;
}

export async function dismissThemeMergeDraft(
  db: SQLiteDatabase,
  draftId: string,
): Promise<void> {
  await db.runAsync(
    `UPDATE theme_merge_drafts
     SET status = 'dismissed', updated_at = ?
     WHERE id = ? AND status = 'pending'`,
    new Date().toISOString(),
    draftId,
  );
}

function renderThemeAddition(
  patch: string,
  sourceTitle: string,
  sourceUrl: string | null,
  conflicts: string[],
): string {
  const source = sourceUrl
    ? `[${sourceTitle}](${sourceUrl})`
    : sourceTitle;
  const conflictSection =
    conflicts.length > 0
      ? `\n\n### 待核对的冲突\n\n${conflicts
          .map((conflict) => `- ${conflict}`)
          .join('\n')}`
      : '';
  return `${patch.trim()}${conflictSection}\n\n> 本次来源：${source}`;
}

async function getThemeNoteRow(
  db: SQLiteDatabase,
  themeNoteId: string,
): Promise<NoteRow | null> {
  return db.getFirstAsync<NoteRow>(
    `SELECT id, title, content, summary, status, source, record_type, content_kind,
            source_url, user_context, source_page_title, source_page_site,
            source_page_text, tags_json, created_at, updated_at
     FROM notes
     WHERE id = ? AND record_type = 'theme' AND deleted_at IS NULL`,
    themeNoteId,
  );
}

function removeThemeContribution(
  themeContent: string,
  contribution: string,
): string | null {
  const index = themeContent.indexOf(contribution);
  if (index < 0) return null;
  const before = themeContent.slice(0, index).trimEnd();
  const after = themeContent.slice(index + contribution.length).trimStart();
  return [before, after].filter(Boolean).join('\n\n').trim();
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}

function noteSourceFromKey(sourceKey: string): NoteSource {
  if (sourceKey.startsWith('wechat:')) return 'wechat';
  return 'share';
}

function parseStringArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
}
