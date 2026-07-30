import { Directory, File } from 'expo-file-system';
import type { SQLiteDatabase } from 'expo-sqlite';
import { Platform } from 'react-native';

import {
  contentFingerprint,
  obsidianFileName,
  renderObsidianMarkdown,
} from './obsidian-markdown';
import { mapNoteRow } from './note-utils';
import {
  OBSIDIAN_DIRECTORY_NAME_SETTING,
  OBSIDIAN_DIRECTORY_URI_SETTING,
} from './persistence-contract';
import type { NoteRow } from './types';

export type ObsidianSyncStatus = {
  configured: boolean;
  directoryName: string | null;
  exported: number;
  pending: number;
  failed: number;
  rawExports: number;
};

type ExportRow = NoteRow & {
  deleted_at: string | null;
  file_uri: string | null;
  exported_hash: string | null;
  export_status: 'pending' | 'exported' | 'failed' | null;
  sync_enabled: number;
  theme_overview: string | null;
};

export async function chooseObsidianVault(
  db: SQLiteDatabase,
): Promise<ObsidianSyncStatus> {
  if (Platform.OS !== 'android') {
    throw new Error('当前版本请在 Android 上选择 Obsidian Vault');
  }

  const previousUri = await getSetting(db, OBSIDIAN_DIRECTORY_URI_SETTING);
  const picked = await Directory.pickDirectoryAsync(previousUri ?? undefined);
  const selected = new Directory(picked.uri);
  const remindDirectory = findOrCreateDirectory(selected, 'ReMind');
  const inboxDirectory = findOrCreateDirectory(remindDirectory, 'Inbox');
  const now = new Date().toISOString();
  await setSetting(
    db,
    OBSIDIAN_DIRECTORY_URI_SETTING,
    inboxDirectory.uri,
    now,
  );
  await setSetting(
    db,
    OBSIDIAN_DIRECTORY_NAME_SETTING,
    `${selected.name}/ReMind/Inbox`,
    now,
  );
  await exportPendingNotes(db);
  return getObsidianSyncStatus(db);
}

export async function requestObsidianExport(
  db: SQLiteDatabase,
  noteId: string,
): Promise<ObsidianSyncStatus> {
  await db.runAsync(
    `INSERT INTO obsidian_exports (note_id, status, sync_enabled)
     VALUES (?, 'pending', 1)
     ON CONFLICT(note_id) DO UPDATE SET
       status = 'pending',
       sync_enabled = 1,
       last_error = NULL`,
    noteId,
  );
  return exportPendingNotes(db);
}

export async function isNoteSelectedForObsidian(
  db: SQLiteDatabase,
  noteId: string,
): Promise<boolean> {
  const row = await db.getFirstAsync<{ sync_enabled: number }>(
    `SELECT sync_enabled FROM obsidian_exports WHERE note_id = ?`,
    noteId,
  );
  return row?.sync_enabled === 1;
}

export async function exportPendingNotes(
  db: SQLiteDatabase,
): Promise<ObsidianSyncStatus> {
  const directoryUri = await getSetting(
    db,
    OBSIDIAN_DIRECTORY_URI_SETTING,
  );
  if (!directoryUri) return getObsidianSyncStatus(db);

  const directory = new Directory(directoryUri);
  if (!directory.exists) {
    await markAllExportsFailed(db, 'Obsidian 文件夹授权已失效，请重新选择');
    return getObsidianSyncStatus(db);
  }

  const rows = await db.getAllAsync<ExportRow>(
    `SELECT
       n.id, n.title, n.content, n.summary, n.status, n.source,
       n.record_type, n.content_kind, n.source_url, n.user_context,
       n.source_page_title, n.source_page_site, n.source_page_text, n.tags_json,
       n.created_at, n.updated_at, n.deleted_at,
       oe.file_uri, oe.exported_hash, oe.status AS export_status,
       oe.sync_enabled, theme_overview.content AS theme_overview
     FROM notes n
     INNER JOIN obsidian_exports oe ON oe.note_id = n.id
     LEFT JOIN theme_overviews theme_overview
       ON theme_overview.theme_note_id = n.id
     WHERE oe.sync_enabled = 1
     ORDER BY n.created_at ASC`,
  );

  for (const row of rows) {
    const note = mapNoteRow(row);
    const markdown = renderObsidianMarkdown(
      note,
      Boolean(row.deleted_at),
      row.theme_overview ?? '',
    );
    const fingerprint = contentFingerprint(markdown);
    if (
      row.export_status === 'exported' &&
      row.exported_hash === fingerprint
    ) {
      continue;
    }

    try {
      let file: File;
      if (row.file_uri) {
        file = new File(row.file_uri);
        if (!file.exists) {
          file = directory.createFile(
            obsidianFileName(note),
            'text/markdown',
          );
        }
      } else {
        file = directory.createFile(obsidianFileName(note), 'text/markdown');
      }
      file.write(markdown);
      await db.runAsync(
        `INSERT INTO obsidian_exports
          (note_id, file_uri, exported_hash, exported_at, status, last_error)
         VALUES ($noteId, $fileUri, $hash, $exportedAt, 'exported', NULL)
         ON CONFLICT(note_id) DO UPDATE SET
           file_uri = excluded.file_uri,
           exported_hash = excluded.exported_hash,
           exported_at = excluded.exported_at,
           status = 'exported',
           last_error = NULL`,
        {
          $noteId: note.id,
          $fileUri: file.uri,
          $hash: fingerprint,
          $exportedAt: new Date().toISOString(),
        },
      );
    } catch (error) {
      await db.runAsync(
        `INSERT INTO obsidian_exports (note_id, status, last_error)
         VALUES ($noteId, 'failed', $error)
         ON CONFLICT(note_id) DO UPDATE SET
           status = 'failed',
           last_error = excluded.last_error`,
        {
          $noteId: note.id,
          $error: readableError(error),
        },
      );
    }
  }

  return getObsidianSyncStatus(db);
}

export async function getObsidianSyncStatus(
  db: SQLiteDatabase,
): Promise<ObsidianSyncStatus> {
  const [directoryUri, directoryName, counts] = await Promise.all([
    getSetting(db, OBSIDIAN_DIRECTORY_URI_SETTING),
    getSetting(db, OBSIDIAN_DIRECTORY_NAME_SETTING),
    db.getFirstAsync<{
      exported: number;
      failed: number;
      pending: number;
      raw_exports: number;
    }>(
      `SELECT
         SUM(CASE WHEN sync_enabled = 1 AND status = 'exported' THEN 1 ELSE 0 END) AS exported,
         SUM(CASE WHEN sync_enabled = 1 AND status = 'failed' THEN 1 ELSE 0 END) AS failed,
         SUM(CASE WHEN sync_enabled = 1 AND status = 'pending' THEN 1 ELSE 0 END) AS pending,
         SUM(CASE WHEN sync_enabled = 0 AND file_uri IS NOT NULL THEN 1 ELSE 0 END) AS raw_exports
       FROM obsidian_exports`,
    ),
  ]);
  return {
    configured: Boolean(directoryUri),
    directoryName,
    exported: counts?.exported ?? 0,
    pending: counts?.pending ?? 0,
    failed: counts?.failed ?? 0,
    rawExports: counts?.raw_exports ?? 0,
  };
}

export async function cleanupRawObsidianExports(
  db: SQLiteDatabase,
): Promise<ObsidianSyncStatus> {
  const rows = await db.getAllAsync<{ note_id: string; file_uri: string }>(
    `SELECT note_id, file_uri
     FROM obsidian_exports
     WHERE sync_enabled = 0 AND file_uri IS NOT NULL`,
  );
  for (const row of rows) {
    try {
      const file = new File(row.file_uri);
      if (file.exists) file.delete();
      await db.runAsync(
        `DELETE FROM obsidian_exports
         WHERE note_id = ? AND sync_enabled = 0`,
        row.note_id,
      );
    } catch (error) {
      await db.runAsync(
        `UPDATE obsidian_exports
         SET status = 'failed', last_error = ?
         WHERE note_id = ? AND sync_enabled = 0`,
        readableError(error),
        row.note_id,
      );
    }
  }
  return getObsidianSyncStatus(db);
}

function findOrCreateDirectory(
  parent: Directory,
  name: string,
): Directory {
  const existing = parent
    .list()
    .find((item): item is Directory =>
      item instanceof Directory && item.name === name
    );
  return existing ?? parent.createDirectory(name);
}

async function getSetting(
  db: SQLiteDatabase,
  key: string,
): Promise<string | null> {
  const row = await db.getFirstAsync<{ value: string }>(
    'SELECT value FROM app_settings WHERE key = ?',
    key,
  );
  return row?.value ?? null;
}

async function setSetting(
  db: SQLiteDatabase,
  key: string,
  value: string,
  updatedAt: string,
): Promise<void> {
  await db.runAsync(
    `INSERT INTO app_settings (key, value, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET
       value = excluded.value,
       updated_at = excluded.updated_at`,
    key,
    value,
    updatedAt,
  );
}

async function markAllExportsFailed(
  db: SQLiteDatabase,
  message: string,
): Promise<void> {
  await db.runAsync(
    `UPDATE obsidian_exports
     SET status = 'failed', last_error = ?
     WHERE sync_enabled = 1`,
    message,
  );
}

function readableError(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 500) : String(error);
}
