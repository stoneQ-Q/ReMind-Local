import * as DocumentPicker from 'expo-document-picker';
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import type { SQLiteBindValue, SQLiteDatabase } from 'expo-sqlite';

const BACKUP_FORMAT = 'remind-data-backup';
const BACKUP_VERSION = 1;
const MAX_BACKUP_BYTES = 25 * 1024 * 1024;
const MAX_BACKUP_ROWS = 100_000;

const BACKUP_TABLES = [
  'notes',
  'note_imports',
  'organize_drafts',
  'organize_draft_sources',
  'organize_ignored_sources',
  'source_citations',
  'theme_merge_drafts',
  'theme_sources',
  'theme_overviews',
  'recall_states',
] as const;

type BackupTable = (typeof BACKUP_TABLES)[number];
type BackupRow = Record<string, SQLiteBindValue>;

type ReMindBackup = {
  format: typeof BACKUP_FORMAT;
  version: typeof BACKUP_VERSION;
  databaseVersion: number;
  createdAt: string;
  tables: Record<BackupTable, BackupRow[]>;
};

export type DataBackupSummary = {
  notes: number;
  rows: number;
};

export type DataImportSummary = {
  notesAdded: number;
  rowsAdded: number;
  backupCreatedAt: string;
};

export async function exportReMindBackup(
  db: SQLiteDatabase,
): Promise<DataBackupSummary> {
  const backup = await createBackup(db);
  const date = new Date().toISOString().replaceAll(':', '-').replace(/\.\d{3}Z$/, 'Z');
  const file = new File(Paths.cache, `ReMind-backup-${date}.json`);
  file.create({ overwrite: true });
  file.write(JSON.stringify(backup));

  if (!(await Sharing.isAvailableAsync())) {
    throw new Error('这台设备暂时不能分享备份文件');
  }
  await Sharing.shareAsync(file.uri, {
    dialogTitle: '保存 ReMind 数据备份',
    mimeType: 'application/json',
    UTI: 'public.json',
  });

  return summarizeBackup(backup);
}

export async function importReMindBackup(
  db: SQLiteDatabase,
): Promise<DataImportSummary | null> {
  const result = await DocumentPicker.getDocumentAsync({
    type: 'application/json',
    copyToCacheDirectory: true,
    multiple: false,
  });
  if (result.canceled) return null;

  const asset = result.assets[0];
  if (!asset) throw new Error('没有读取到备份文件');
  if (asset.size != null && asset.size > MAX_BACKUP_BYTES) {
    throw new Error('备份文件超过 25 MB，已停止导入');
  }

  const file = new File(asset.uri);
  const text = await file.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BACKUP_BYTES) {
    throw new Error('备份文件超过 25 MB，已停止导入');
  }
  const backup = parseBackup(text);
  return mergeBackup(db, backup);
}

async function createBackup(db: SQLiteDatabase): Promise<ReMindBackup> {
  const version = await db.getFirstAsync<{ user_version: number }>(
    'PRAGMA user_version',
  );
  const tables = {} as Record<BackupTable, BackupRow[]>;
  for (const table of BACKUP_TABLES) {
    tables[table] = await db.getAllAsync<BackupRow>(
      `SELECT * FROM "${table}"`,
    );
  }
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    databaseVersion: version?.user_version ?? 0,
    createdAt: new Date().toISOString(),
    tables,
  };
}

function parseBackup(text: string): ReMindBackup {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('这不是有效的 ReMind 备份文件');
  }
  if (!isObject(value)) throw new Error('这不是有效的 ReMind 备份文件');
  if (value.format !== BACKUP_FORMAT || value.version !== BACKUP_VERSION) {
    throw new Error('备份格式不受支持，请使用 ReMind 导出的 JSON 文件');
  }
  if (
    typeof value.createdAt !== 'string' ||
    typeof value.databaseVersion !== 'number' ||
    !isObject(value.tables)
  ) {
    throw new Error('备份文件缺少必要信息');
  }

  let rowCount = 0;
  const tables = {} as Record<BackupTable, BackupRow[]>;
  for (const table of BACKUP_TABLES) {
    const rows = value.tables[table];
    if (!Array.isArray(rows)) throw new Error(`备份缺少 ${table} 数据`);
    if (!rows.every(isBackupRow)) throw new Error(`备份中的 ${table} 数据无效`);
    rowCount += rows.length;
    tables[table] = rows;
  }
  if (rowCount > MAX_BACKUP_ROWS) {
    throw new Error('备份数据量异常，已停止导入');
  }

  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    databaseVersion: value.databaseVersion,
    createdAt: value.createdAt,
    tables,
  };
}

async function mergeBackup(
  db: SQLiteDatabase,
  backup: ReMindBackup,
): Promise<DataImportSummary> {
  let rowsAdded = 0;
  let notesAdded = 0;

  await db.withTransactionAsync(async () => {
    for (const table of BACKUP_TABLES) {
      const allowedColumns = new Set(
        (
          await db.getAllAsync<{ name: string }>(
            `PRAGMA table_info("${table}")`,
          )
        ).map((column) => column.name),
      );
      for (const row of backup.tables[table]) {
        const columns = Object.keys(row).filter((column) =>
          allowedColumns.has(column),
        );
        if (columns.length === 0) continue;
        const placeholders = columns.map(() => '?').join(', ');
        const quotedColumns = columns
          .map((column) => `"${column}"`)
          .join(', ');
        const result = await db.runAsync(
          `INSERT OR IGNORE INTO "${table}" (${quotedColumns})
           VALUES (${placeholders})`,
          columns.map((column) => row[column]),
        );
        rowsAdded += result.changes;
        if (table === 'notes') notesAdded += result.changes;
      }
    }
  });

  return {
    notesAdded,
    rowsAdded,
    backupCreatedAt: backup.createdAt,
  };
}

function summarizeBackup(backup: ReMindBackup): DataBackupSummary {
  return {
    notes: backup.tables.notes.length,
    rows: BACKUP_TABLES.reduce(
      (total, table) => total + backup.tables[table].length,
      0,
    ),
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isBackupRow(value: unknown): value is BackupRow {
  if (!isObject(value)) return false;
  return Object.values(value).every(
    (item) =>
      item === null ||
      typeof item === 'string' ||
      typeof item === 'number' ||
      typeof item === 'boolean',
  );
}
