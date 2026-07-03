import { createHash } from "node:crypto";
import { chmod, mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { defaultCodexHome, defaultIndexPath, expandHome } from "./paths.js";
import { readThreadMessagesFromJsonl, scanCodexStorage } from "./scanner.js";
import { queryJson, runSqlStream, sqlLikePattern, sqlValue, type SqlWriter } from "./sqlite.js";
import type {
  Diagnostic,
  RestoreStatus,
  SortDirection,
  ScanResult,
  ScanStats,
  SearchIndexMeta,
  ThreadDetail,
  ThreadMessage,
  ThreadQuery,
  ThreadRecord,
  ThreadSortKey,
} from "./types.js";

interface RebuildOptions {
  codexHome?: string;
  indexPath?: string;
}

interface ThreadRow {
  id: string;
  title: string | null;
  cwd: string | null;
  updatedAt: number | null;
  createdAt: number | null;
  archived: number | null;
  rolloutPath: string | null;
  storageKind: string;
  existsOnDisk: number;
  messageCount: number;
  contentPreview: string;
  restoreStatus: RestoreStatus;
  sourcePathsJson: string;
}

interface CountRow {
  totalMatches: number;
}

interface StatsRow {
  totalThreads: number;
  totalProjects: number;
  activeThreads: number;
  archivedThreads: number;
  hiddenThreads: number;
  orphanedThreads: number;
}

interface MetaRow {
  key: string;
  value: string;
}

interface NormalizedThreadQuery {
  title?: string;
  content?: string;
  cwd?: string;
  status: RestoreStatus | null;
  sort: ThreadSortKey;
  direction: SortDirection;
  limit: number;
  offset: number;
}

const VALID_STATUSES = new Set<RestoreStatus>([
  "active",
  "archived",
  "hidden",
  "orphaned",
  "restorable",
  "unknown",
]);
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const DEFAULT_SORT: ThreadSortKey = "updated";
const DEFAULT_DIRECTION: SortDirection = "desc";

export async function rebuildSearchIndex(options: RebuildOptions = {}): Promise<SearchIndexMeta> {
  const codexHome = path.resolve(expandHome(options.codexHome ?? defaultCodexHome()));
  const indexPath = path.resolve(expandHome(options.indexPath ?? defaultIndexPath()));
  await ensurePrivateCacheDir(path.dirname(indexPath));

  const scan = await scanCodexStorage(codexHome, { includeTranscriptText: true });
  const rebuiltAt = new Date().toISOString();
  const sourceFingerprint = await computeSourceFingerprint(codexHome);
  await writeAtomicIndex(indexPath, scan, rebuiltAt, sourceFingerprint);
  return {
    codexHome,
    indexPath,
    rebuiltAt,
    sourceFingerprint,
    stats: scan.stats,
    diagnostics: scan.diagnostics,
  };
}

export async function ensureSearchIndex(options: RebuildOptions = {}): Promise<SearchIndexMeta> {
  const codexHome = path.resolve(expandHome(options.codexHome ?? defaultCodexHome()));
  const indexPath = path.resolve(expandHome(options.indexPath ?? defaultIndexPath()));
  const existing = await readSearchIndexMeta({ codexHome, indexPath });
  const sourceFingerprint = await computeSourceFingerprint(codexHome);
  if (
    existing.rebuiltAt !== null &&
    existing.codexHome === codexHome &&
    existing.sourceFingerprint === sourceFingerprint
  ) {
    return existing;
  }
  return rebuildSearchIndex({ codexHome, indexPath });
}

export async function clearSearchIndex(options: RebuildOptions = {}): Promise<SearchIndexMeta> {
  const codexHome = path.resolve(expandHome(options.codexHome ?? defaultCodexHome()));
  const indexPath = path.resolve(expandHome(options.indexPath ?? defaultIndexPath()));
  await removeIndexFiles(indexPath);
  return {
    codexHome,
    indexPath,
    rebuiltAt: null,
    sourceFingerprint: null,
    stats: emptyStats(),
    diagnostics: [],
  };
}

export async function readSearchIndexMeta(options: RebuildOptions = {}): Promise<SearchIndexMeta> {
  const codexHome = path.resolve(expandHome(options.codexHome ?? defaultCodexHome()));
  const indexPath = path.resolve(expandHome(options.indexPath ?? defaultIndexPath()));
  const diagnostics: Diagnostic[] = [];

  try {
    const metaRows = await queryJson<MetaRow>(indexPath, "SELECT key, value FROM metadata;");
    const stats = await readStats(indexPath);
    const metadata = new Map(metaRows.map((row) => [row.key, row.value]));
    return {
      codexHome: metadata.get("codex_home") ?? codexHome,
      indexPath,
      rebuiltAt: metadata.get("rebuilt_at") ?? null,
      sourceFingerprint: metadata.get("source_fingerprint") ?? null,
      stats,
      diagnostics,
    };
  } catch (error) {
    diagnostics.push({
      level: "warning",
      message: `Search index is not ready at ${indexPath}: ${errorMessage(error)}`,
    });
    return {
      codexHome,
      indexPath,
      rebuiltAt: null,
      sourceFingerprint: null,
      stats: emptyStats(),
      diagnostics,
    };
  }
}

export async function searchThreads(
  options: RebuildOptions,
  query: ThreadQuery,
): Promise<ScanResult> {
  const codexHome = path.resolve(expandHome(options.codexHome ?? defaultCodexHome()));
  const indexPath = path.resolve(expandHome(options.indexPath ?? defaultIndexPath()));
  await ensureSearchIndex({ codexHome, indexPath });
  return searchExistingIndex({ codexHome, indexPath }, query);
}

export async function searchCachedThreads(
  options: RebuildOptions,
  query: ThreadQuery,
): Promise<ScanResult> {
  const codexHome = path.resolve(expandHome(options.codexHome ?? defaultCodexHome()));
  const indexPath = path.resolve(expandHome(options.indexPath ?? defaultIndexPath()));
  const meta = await readSearchIndexMeta({ codexHome, indexPath });
  if (meta.rebuiltAt === null) {
    return searchThreads({ codexHome, indexPath }, query);
  }
  return searchExistingIndex({ codexHome, indexPath }, query);
}

export async function readThreadDetail(
  options: RebuildOptions,
  threadId: string,
): Promise<ThreadDetail | null> {
  const codexHome = path.resolve(expandHome(options.codexHome ?? defaultCodexHome()));
  const indexPath = path.resolve(expandHome(options.indexPath ?? defaultIndexPath()));
  await ensureSearchIndex({ codexHome, indexPath });
  const [row] = await queryJson<ThreadRow>(
    indexPath,
    `${baseThreadSelect()} WHERE id = ${sqlValue(threadId)} LIMIT 1;`,
  );
  if (!row) {
    return null;
  }
  const thread = rowToThread(row);
  const messages = await readMessagesForThread(thread);
  return { thread, messages };
}

async function searchExistingIndex(
  options: Required<RebuildOptions>,
  query: ThreadQuery,
): Promise<ScanResult> {
  const { codexHome, indexPath } = options;
  const meta = await readSearchIndexMeta({ codexHome, indexPath });
  const normalized = normalizeQuery(query);
  const threads = await queryJson<ThreadRow>(indexPath, buildSearchSql(normalized));
  const totalMatches = await countSearchMatches(indexPath, normalized);

  return {
    codexHome: meta.codexHome,
    scannedAt: meta.rebuiltAt ?? new Date().toISOString(),
    stats: meta.stats,
    diagnostics: meta.diagnostics,
    threads: threads.map(rowToThread),
    totalMatches,
    limit: normalized.limit,
    offset: normalized.offset,
  };
}

async function writeAtomicIndex(
  indexPath: string,
  scan: ScanResult,
  rebuiltAt: string,
  sourceFingerprint: string,
): Promise<void> {
  const tempPath = `${indexPath}.tmp-${process.pid}-${Date.now()}`;
  await removeIndexFiles(tempPath);
  try {
    await runSqlStream(tempPath, async (writer) => {
      await writeRebuildSql(writer, scan, rebuiltAt, sourceFingerprint);
    });
    await readStats(tempPath);
    await chmod(tempPath, 0o600);
    await removeIndexFiles(indexPath);
    await rename(tempPath, indexPath);
    await chmod(indexPath, 0o600);
  } catch (error) {
    await removeIndexFiles(tempPath);
    throw error;
  }
}

async function writeRebuildSql(
  writer: SqlWriter,
  scan: ScanResult,
  rebuiltAt: string,
  sourceFingerprint: string,
): Promise<void> {
  await writer.write("BEGIN;");
  await writer.write("CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);");
  await writer.write(`INSERT INTO metadata (key, value) VALUES ('codex_home', ${sqlValue(scan.codexHome)});`);
  await writer.write(`INSERT INTO metadata (key, value) VALUES ('rebuilt_at', ${sqlValue(rebuiltAt)});`);
  await writer.write(
    `INSERT INTO metadata (key, value) VALUES ('source_fingerprint', ${sqlValue(
      sourceFingerprint,
    )});`,
  );
  await writer.write(
    "CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT, cwd TEXT, updated_at INTEGER, created_at INTEGER, archived INTEGER, rollout_path TEXT, storage_kind TEXT NOT NULL, exists_on_disk INTEGER NOT NULL, message_count INTEGER NOT NULL, content_preview TEXT NOT NULL, restore_status TEXT NOT NULL, source_paths_json TEXT NOT NULL);",
  );
  await writer.write(
    "CREATE VIRTUAL TABLE thread_title_fts USING fts5(id UNINDEXED, title, tokenize='unicode61');",
  );
  await writer.write(
    "CREATE VIRTUAL TABLE thread_content_fts USING fts5(id UNINDEXED, content, tokenize='unicode61');",
  );

  for (const thread of scan.threads) {
    await writer.write(insertThreadSql(thread));
  }

  await writer.write("COMMIT;");
}

function insertThreadSql(thread: ThreadRecord): string {
  const content = thread.transcriptText ?? thread.contentPreview;
  const archived = thread.archived === null ? null : thread.archived ? 1 : 0;
  return [
    `INSERT INTO threads (id, title, cwd, updated_at, created_at, archived, rollout_path, storage_kind, exists_on_disk, message_count, content_preview, restore_status, source_paths_json) VALUES (${[
      sqlValue(thread.id),
      sqlValue(thread.title),
      sqlValue(thread.cwd),
      sqlValue(thread.updatedAt),
      sqlValue(thread.createdAt),
      sqlValue(archived),
      sqlValue(thread.rolloutPath),
      sqlValue(thread.storageKind),
      sqlValue(thread.existsOnDisk),
      sqlValue(thread.messageCount),
      sqlValue(thread.contentPreview),
      sqlValue(thread.restoreStatus),
      sqlValue(JSON.stringify(thread.sourcePaths)),
    ].join(", ")});`,
    `INSERT INTO thread_title_fts (id, title) VALUES (${sqlValue(thread.id)}, ${sqlValue(
      thread.title ?? "",
    )});`,
    `INSERT INTO thread_content_fts (id, content) VALUES (${sqlValue(thread.id)}, ${sqlValue(
      content,
    )});`,
  ].join("\n");
}

function buildSearchSql(query: NormalizedThreadQuery): string {
  const where = buildWhere(query);
  return `${baseThreadSelect()}${
    where.length > 0 ? ` WHERE ${where.join(" AND ")}` : ""
  } ${buildOrderBy(query)} LIMIT ${query.limit} OFFSET ${query.offset};`;
}

function baseThreadSelect(): string {
  return "SELECT id, title, cwd, updated_at AS updatedAt, created_at AS createdAt, archived, rollout_path AS rolloutPath, storage_kind AS storageKind, exists_on_disk AS existsOnDisk, message_count AS messageCount, content_preview AS contentPreview, restore_status AS restoreStatus, source_paths_json AS sourcePathsJson FROM threads";
}

function buildOrderBy(query: NormalizedThreadQuery): string {
  const direction = query.direction === "asc" ? "ASC" : "DESC";
  const reverseDirection = query.direction === "asc" ? "DESC" : "ASC";
  if (query.sort === "status") {
    return `ORDER BY restore_status ${direction}, COALESCE(updated_at, 0) DESC, id ASC`;
  }
  if (query.sort === "project") {
    return `ORDER BY COALESCE(cwd, '') ${direction}, COALESCE(updated_at, 0) DESC, id ASC`;
  }
  if (query.sort === "messages") {
    return `ORDER BY message_count ${direction}, COALESCE(updated_at, 0) DESC, id ASC`;
  }
  return `ORDER BY COALESCE(updated_at, 0) ${direction}, id ${reverseDirection}`;
}

async function countSearchMatches(
  indexPath: string,
  query: NormalizedThreadQuery,
): Promise<number> {
  const where = buildWhere(query);
  const [row] = await queryJson<CountRow>(
    indexPath,
    `SELECT COUNT(*) AS totalMatches FROM threads${
      where.length > 0 ? ` WHERE ${where.join(" AND ")}` : ""
    };`,
  );
  return row?.totalMatches ?? 0;
}

function buildWhere(query: NormalizedThreadQuery): string[] {
  const where: string[] = [];
  const titleFts = buildFtsQuery(query.title);
  const contentFts = buildFtsQuery(query.content);
  const cwd = query.cwd?.trim();

  if (query.status) {
    where.push(`restore_status = ${sqlValue(query.status)}`);
  }
  if (cwd) {
    where.push(`cwd LIKE ${sqlValue(sqlLikePattern(cwd))} ESCAPE '\\'`);
  }
  if (titleFts) {
    where.push(
      `id IN (SELECT id FROM thread_title_fts WHERE thread_title_fts MATCH ${sqlValue(
        titleFts,
      )})`,
    );
  }
  if (contentFts) {
    where.push(
      `id IN (SELECT id FROM thread_content_fts WHERE thread_content_fts MATCH ${sqlValue(
        contentFts,
      )})`,
    );
  }
  return where;
}

async function readStats(indexPath: string): Promise<ScanStats> {
  const [row] = await queryJson<StatsRow>(
    indexPath,
    "SELECT COUNT(*) AS totalThreads, COUNT(DISTINCT cwd) AS totalProjects, COALESCE(SUM(restore_status = 'active'), 0) AS activeThreads, COALESCE(SUM(restore_status = 'archived'), 0) AS archivedThreads, COALESCE(SUM(restore_status = 'hidden'), 0) AS hiddenThreads, COALESCE(SUM(restore_status = 'orphaned'), 0) AS orphanedThreads FROM threads;",
  );
  return row ?? emptyStats();
}

function rowToThread(row: ThreadRow): ThreadRecord {
  return {
    id: row.id,
    title: row.title,
    cwd: row.cwd,
    updatedAt: row.updatedAt,
    createdAt: row.createdAt,
    archived: row.archived === null ? null : row.archived !== 0,
    rolloutPath: row.rolloutPath,
    storageKind: row.storageKind as ThreadRecord["storageKind"],
    existsOnDisk: row.existsOnDisk !== 0,
    messageCount: row.messageCount,
    contentPreview: row.contentPreview,
    restoreStatus: row.restoreStatus,
    sourcePaths: parseSourcePaths(row.sourcePathsJson),
  };
}

function buildFtsQuery(value: string | undefined): string | null {
  const terms = value?.match(/[\p{L}\p{N}_]+/gu) ?? [];
  if (terms.length === 0) {
    return null;
  }
  return terms.map((term) => `${term.toLocaleLowerCase()}*`).join(" AND ");
}

function normalizeQuery(query: ThreadQuery): NormalizedThreadQuery {
  return {
    title: query.title,
    content: query.content,
    cwd: query.cwd,
    status: normalizeStatus(query.status),
    sort: normalizeSort(query.sort),
    direction: normalizeDirection(query.direction),
    limit: normalizeLimit(query.limit),
    offset: normalizeOffset(query.offset),
  };
}

function normalizeStatus(status: ThreadQuery["status"]): RestoreStatus | null {
  if (!status || status === "all") {
    return null;
  }
  if (!VALID_STATUSES.has(status)) {
    throw new Error(`Invalid status filter: ${status}`);
  }
  return status;
}

function normalizeSort(sort: ThreadQuery["sort"]): ThreadSortKey {
  if (sort === undefined) {
    return DEFAULT_SORT;
  }
  if (sort === "updated" || sort === "status" || sort === "project" || sort === "messages") {
    return sort;
  }
  throw new Error(`Invalid sort key: ${sort}`);
}

function normalizeDirection(direction: ThreadQuery["direction"]): SortDirection {
  if (direction === undefined) {
    return DEFAULT_DIRECTION;
  }
  if (direction === "asc" || direction === "desc") {
    return direction;
  }
  throw new Error(`Invalid sort direction: ${direction}`);
}

function normalizeLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return DEFAULT_LIMIT;
  }
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(value)));
}

function normalizeOffset(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.floor(value));
}

function parseSourcePaths(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string") : [];
  } catch {
    return [];
  }
}

async function readMessagesForThread(thread: ThreadRecord): Promise<ThreadMessage[]> {
  const messages: ThreadMessage[] = [];
  for (const sourcePath of thread.sourcePaths) {
    try {
      messages.push(...(await readThreadMessagesFromJsonl(sourcePath)));
    } catch {
      // Missing or unreadable source files are already represented by the thread status.
    }
  }
  return messages.sort((a, b) => {
    const left = parseMessageTime(a.timestamp);
    const right = parseMessageTime(b.timestamp);
    if (left !== right) {
      return left - right;
    }
    return a.sequence - b.sequence;
  });
}

function parseMessageTime(value: string | null): number {
  if (!value) {
    return 0;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function emptyStats(): ScanStats {
  return {
    totalThreads: 0,
    totalProjects: 0,
    activeThreads: 0,
    archivedThreads: 0,
    hiddenThreads: 0,
    orphanedThreads: 0,
  };
}

async function ensurePrivateCacheDir(dirPath: string): Promise<void> {
  await mkdir(dirPath, { recursive: true, mode: 0o700 });
  await chmod(dirPath, 0o700).catch(() => undefined);
}

async function removeIndexFiles(indexPath: string): Promise<void> {
  await Promise.all([
    rm(indexPath, { force: true }),
    rm(`${indexPath}-wal`, { force: true }),
    rm(`${indexPath}-shm`, { force: true }),
  ]);
}

async function computeSourceFingerprint(codexHome: string): Promise<string> {
  const entries: string[] = [];
  await addFileFingerprint(entries, codexHome, path.join(codexHome, "state_5.sqlite"));
  await addTreeFingerprint(entries, codexHome, path.join(codexHome, "sessions"));
  await addTreeFingerprint(entries, codexHome, path.join(codexHome, "archived_sessions"));
  entries.sort();
  return createHash("sha256").update(entries.join("\n")).digest("hex");
}

async function addTreeFingerprint(
  entries: string[],
  codexHome: string,
  root: string,
): Promise<void> {
  let children: string[];
  try {
    children = await readdir(root);
  } catch {
    return;
  }

  for (const child of children) {
    const childPath = path.join(root, child);
    const info = await stat(childPath);
    if (info.isDirectory()) {
      await addTreeFingerprint(entries, codexHome, childPath);
    } else if (info.isFile() && childPath.endsWith(".jsonl")) {
      addFingerprintEntry(entries, codexHome, childPath, info.size, info.mtimeMs);
    }
  }
}

async function addFileFingerprint(
  entries: string[],
  codexHome: string,
  filePath: string,
): Promise<void> {
  try {
    const info = await stat(filePath);
    if (info.isFile()) {
      addFingerprintEntry(entries, codexHome, filePath, info.size, info.mtimeMs);
    }
  } catch {
    return;
  }
}

function addFingerprintEntry(
  entries: string[],
  codexHome: string,
  filePath: string,
  size: number,
  mtimeMs: number,
): void {
  entries.push(`${path.relative(codexHome, filePath)}\t${size}\t${Math.floor(mtimeMs)}`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
