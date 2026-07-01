import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { access, readdir } from "node:fs/promises";
import { createInterface } from "node:readline";
import path from "node:path";
import { promisify } from "node:util";
import { expandHome } from "./paths.js";
import type {
  Diagnostic,
  RestoreStatus,
  ScanResult,
  ScanStats,
  StorageKind,
  ThreadQuery,
  ThreadRecord,
} from "./types.js";

const execFileAsync = promisify(execFile);

interface SqliteThreadRow {
  id?: string | null;
  title?: string | null;
  cwd?: string | null;
  updated_at?: number | string | null;
  created_at?: number | string | null;
  archived?: number | string | boolean | null;
  rollout_path?: string | null;
}

interface JsonlThreadEvidence {
  id: string;
  title: string | null;
  cwd: string | null;
  updatedAt: number | null;
  createdAt: number | null;
  rolloutPath: string;
  storageKind: StorageKind;
  existsOnDisk: boolean;
  messageCount: number;
  contentPreview: string;
}

interface MutableThread {
  id: string;
  title: string | null;
  cwd: string | null;
  updatedAt: number | null;
  createdAt: number | null;
  archived: boolean | null;
  rolloutPath: string | null;
  storageKind: StorageKind;
  existsOnDisk: boolean;
  messageCount: number;
  contentPreview: string;
  sourcePaths: Set<string>;
}

const SQLITE_FIELDS = [
  "id",
  "title",
  "cwd",
  "updated_at",
  "created_at",
  "archived",
  "rollout_path",
] as const;

export async function scanCodexStorage(codexHomeInput: string): Promise<ScanResult> {
  const codexHome = path.resolve(expandHome(codexHomeInput));
  const diagnostics: Diagnostic[] = [];
  const byKey = new Map<string, MutableThread>();

  const homeExists = await exists(codexHome);
  if (!homeExists) {
    diagnostics.push({
      level: "error",
      message: `Codex home does not exist: ${codexHome}`,
    });
    return buildResult(codexHome, diagnostics, []);
  }

  const sqliteRows = await readSqliteThreads(codexHome, diagnostics);
  for (const row of sqliteRows) {
    mergeSqliteRow(byKey, codexHome, row);
  }

  const sessionFiles = [
    ...(await findJsonlFiles(path.join(codexHome, "sessions"), diagnostics)),
    ...(await findJsonlFiles(path.join(codexHome, "archived_sessions"), diagnostics)),
  ];

  for (const file of sessionFiles) {
    const evidence = await readJsonlThread(file, codexHome, diagnostics);
    if (evidence) {
      mergeJsonlEvidence(byKey, evidence);
    }
  }

  return buildResult(codexHome, diagnostics, Array.from(byKey.values()).map(finalizeThread));
}

export function filterThreads(threads: ThreadRecord[], query: ThreadQuery): ThreadRecord[] {
  const titleNeedle = query.title?.trim().toLowerCase();
  const contentNeedle = query.content?.trim().toLowerCase();
  const cwdNeedle = query.cwd?.trim().toLowerCase();
  const status = query.status && query.status !== "all" ? query.status : null;

  return threads.filter((thread) => {
    if (status && thread.restoreStatus !== status) {
      return false;
    }
    if (titleNeedle && !(thread.title ?? "").toLowerCase().includes(titleNeedle)) {
      return false;
    }
    if (contentNeedle && !thread.contentPreview.toLowerCase().includes(contentNeedle)) {
      return false;
    }
    if (cwdNeedle && !(thread.cwd ?? "").toLowerCase().includes(cwdNeedle)) {
      return false;
    }
    return true;
  });
}

async function readSqliteThreads(
  codexHome: string,
  diagnostics: Diagnostic[],
): Promise<SqliteThreadRow[]> {
  const dbPath = path.join(codexHome, "state_5.sqlite");
  if (!(await exists(dbPath))) {
    diagnostics.push({
      level: "warning",
      message: `SQLite state database was not found at ${dbPath}`,
    });
    return [];
  }

  try {
    const { stdout: tableInfoStdout } = await execFileAsync("sqlite3", [
      "-json",
      dbPath,
      "PRAGMA table_info(threads);",
    ]);
    const tableInfo = JSON.parse(tableInfoStdout || "[]") as Array<{ name?: string }>;
    const available = new Set(tableInfo.map((field) => field.name).filter(Boolean));
    const selected = SQLITE_FIELDS.filter((field) => available.has(field));

    if (selected.length === 0) {
      diagnostics.push({
        level: "warning",
        message: "SQLite threads table exists but none of the expected columns were found.",
      });
      return [];
    }

    const sql = `SELECT ${selected.map((field) => quoteIdentifier(field)).join(", ")} FROM threads;`;
    const { stdout } = await execFileAsync("sqlite3", ["-json", dbPath, sql], {
      maxBuffer: 1024 * 1024 * 64,
    });
    return JSON.parse(stdout || "[]") as SqliteThreadRow[];
  } catch (error) {
    diagnostics.push({
      level: "warning",
      message: `Could not read SQLite threads via sqlite3: ${errorMessage(error)}`,
    });
    return [];
  }
}

async function findJsonlFiles(root: string, diagnostics: Diagnostic[]): Promise<string[]> {
  if (!(await exists(root))) {
    diagnostics.push({
      level: "info",
      message: `Session directory was not found: ${root}`,
    });
    return [];
  }

  const found: string[] = [];
  await walk(root, found);
  return found.filter((file) => file.endsWith(".jsonl"));
}

async function walk(root: string, found: string[]): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      await walk(fullPath, found);
    } else if (entry.isFile()) {
      found.push(fullPath);
    }
  }
}

async function readJsonlThread(
  file: string,
  codexHome: string,
  diagnostics: Diagnostic[],
): Promise<JsonlThreadEvidence | null> {
  let lineCount = 0;
  let messageCount = 0;
  let id: string | null = null;
  let title: string | null = null;
  let cwd: string | null = null;
  let createdAt: number | null = null;
  let updatedAt: number | null = null;
  const textParts: string[] = [];
  let previewLength = 0;

  try {
    const rl = createInterface({
      input: createReadStream(file, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      lineCount += 1;
      if (!line.trim()) {
        continue;
      }

      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        continue;
      }

      id ??= firstStringAt(value, [
        ["id"],
        ["thread_id"],
        ["threadId"],
        ["payload", "id"],
        ["payload", "thread_id"],
        ["payload", "threadId"],
        ["session", "id"],
      ]);
      title ??= firstStringAt(value, [
        ["title"],
        ["payload", "title"],
        ["payload", "thread_name"],
        ["session", "title"],
      ]);
      cwd ??= firstStringAt(value, [
        ["cwd"],
        ["payload", "cwd"],
        ["session", "cwd"],
      ]);

      const timestamp = firstTimestamp(value);
      if (timestamp !== null) {
        createdAt = createdAt === null ? timestamp : Math.min(createdAt, timestamp);
        updatedAt = updatedAt === null ? timestamp : Math.max(updatedAt, timestamp);
      }

      const messageText = extractTranscriptMessage(value);
      if (messageText !== null) {
        messageCount += 1;
        if (previewLength < 4000 && messageText) {
          textParts.push(messageText);
          previewLength += messageText.length + 1;
        }
      }
    }
  } catch (error) {
    diagnostics.push({
      level: "warning",
      message: `Could not read ${file}: ${errorMessage(error)}`,
    });
    return null;
  }

  if (lineCount === 0) {
    return null;
  }

  const relative = path.relative(codexHome, file);
  const storageKind = relative.startsWith("archived_sessions")
    ? "archived-session"
    : "active-session";
  const fallbackId = id ?? stableFileId(relative);

  return {
    id: fallbackId,
    title,
    cwd,
    updatedAt,
    createdAt,
    rolloutPath: file,
    storageKind,
    existsOnDisk: true,
    messageCount,
    contentPreview: normalizeWhitespace(textParts.join(" ")).slice(0, 4000),
  };
}

function mergeSqliteRow(
  byKey: Map<string, MutableThread>,
  codexHome: string,
  row: SqliteThreadRow,
): void {
  const id = cleanString(row.id) ?? stableFileId(row.rollout_path ?? JSON.stringify(row));
  const rolloutPath = cleanString(row.rollout_path);
  const sourcePath = rolloutPath ? resolveCodexPath(codexHome, rolloutPath) : null;
  const key = id || sourcePath || stableFileId(JSON.stringify(row));
  const existing = byKey.get(key);
  const archived = parseArchived(row.archived);

  const thread: MutableThread =
    existing ??
    {
      id: key,
      title: null,
      cwd: null,
      updatedAt: null,
      createdAt: null,
      archived: null,
      rolloutPath: null,
      storageKind: "sqlite-only",
      existsOnDisk: false,
      messageCount: 0,
      contentPreview: "",
      sourcePaths: new Set<string>(),
    };

  thread.title = cleanString(row.title) ?? thread.title;
  thread.cwd = cleanString(row.cwd) ?? thread.cwd;
  thread.updatedAt = parseEpoch(row.updated_at) ?? thread.updatedAt;
  thread.createdAt = parseEpoch(row.created_at) ?? thread.createdAt;
  thread.archived = archived ?? thread.archived;
  thread.rolloutPath = sourcePath ?? thread.rolloutPath;
  if (sourcePath) {
    thread.sourcePaths.add(sourcePath);
  }
  byKey.set(key, thread);
}

function mergeJsonlEvidence(byKey: Map<string, MutableThread>, evidence: JsonlThreadEvidence): void {
  const existingKey = byKey.has(evidence.id)
    ? evidence.id
    : findByRolloutPath(byKey, evidence.rolloutPath) ?? evidence.id;
  const existing = byKey.get(existingKey);

  const thread: MutableThread =
    existing ??
    {
      id: evidence.id,
      title: null,
      cwd: null,
      updatedAt: null,
      createdAt: null,
      archived: null,
      rolloutPath: null,
      storageKind: "jsonl-only",
      existsOnDisk: false,
      messageCount: 0,
      contentPreview: "",
      sourcePaths: new Set<string>(),
    };

  thread.title = thread.title ?? evidence.title;
  thread.cwd = thread.cwd ?? evidence.cwd;
  thread.updatedAt = maxNullable(thread.updatedAt, evidence.updatedAt);
  thread.createdAt = minNullable(thread.createdAt, evidence.createdAt);
  thread.rolloutPath = thread.rolloutPath ?? evidence.rolloutPath;
  thread.existsOnDisk = true;
  thread.messageCount = Math.max(thread.messageCount, evidence.messageCount);
  thread.contentPreview = thread.contentPreview || evidence.contentPreview;
  thread.sourcePaths.add(evidence.rolloutPath);
  thread.storageKind =
    thread.storageKind === "jsonl-only" || thread.storageKind === evidence.storageKind
      ? evidence.storageKind
      : "mixed";

  byKey.delete(existingKey);
  byKey.set(thread.id, thread);
}

function finalizeThread(thread: MutableThread): ThreadRecord {
  const restoreStatus = determineRestoreStatus(thread);
  return {
    ...thread,
    restoreStatus,
    sourcePaths: Array.from(thread.sourcePaths).sort(),
  };
}

function determineRestoreStatus(thread: MutableThread): RestoreStatus {
  if (thread.archived === false && thread.existsOnDisk) {
    return "active";
  }
  if (thread.archived === true && thread.existsOnDisk) {
    return "archived";
  }
  if (thread.archived === false && !thread.existsOnDisk) {
    return "orphaned";
  }
  if (thread.archived === null && thread.existsOnDisk) {
    return thread.storageKind === "archived-session" ? "restorable" : "hidden";
  }
  return "unknown";
}

function buildResult(
  codexHome: string,
  diagnostics: Diagnostic[],
  threads: ThreadRecord[],
): ScanResult {
  const sorted = threads.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  return {
    codexHome,
    scannedAt: new Date().toISOString(),
    stats: buildStats(sorted),
    diagnostics,
    threads: sorted,
  };
}

function buildStats(threads: ThreadRecord[]): ScanStats {
  return {
    totalThreads: threads.length,
    totalProjects: new Set(threads.map((thread) => thread.cwd).filter(Boolean)).size,
    activeThreads: threads.filter((thread) => thread.restoreStatus === "active").length,
    archivedThreads: threads.filter((thread) => thread.restoreStatus === "archived").length,
    hiddenThreads: threads.filter((thread) => thread.restoreStatus === "hidden").length,
    orphanedThreads: threads.filter((thread) => thread.restoreStatus === "orphaned").length,
  };
}

function findByRolloutPath(byKey: Map<string, MutableThread>, rolloutPath: string): string | null {
  for (const [key, thread] of byKey) {
    if (thread.rolloutPath === rolloutPath || thread.sourcePaths.has(rolloutPath)) {
      return key;
    }
  }
  return null;
}

function quoteIdentifier(field: string): string {
  return `"${field.replaceAll('"', '""')}"`;
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

function resolveCodexPath(codexHome: string, rolloutPath: string): string {
  return path.isAbsolute(rolloutPath) ? rolloutPath : path.join(codexHome, rolloutPath);
}

function parseArchived(value: SqliteThreadRow["archived"]): boolean | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value !== 0;
  }
  if (value === "0" || value.toLowerCase() === "false") {
    return false;
  }
  if (value === "1" || value.toLowerCase() === "true") {
    return true;
  }
  return null;
}

function parseEpoch(value: SqliteThreadRow["updated_at"]): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    const parsed = Date.parse(String(value));
    return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null;
  }
  return numeric > 9999999999 ? Math.floor(numeric / 1000) : Math.floor(numeric);
}

function firstTimestamp(value: unknown): number | null {
  const direct = firstStringAt(value, [
    ["timestamp"],
    ["time"],
    ["created_at"],
    ["updated_at"],
    ["payload", "timestamp"],
    ["payload", "created_at"],
    ["payload", "updated_at"],
  ]);
  return parseEpoch(direct);
}

function firstStringAt(value: unknown, paths: string[][]): string | null {
  for (const segments of paths) {
    const found = getAtPath(value, segments);
    const cleaned = cleanString(found);
    if (cleaned) {
      return cleaned;
    }
  }
  return null;
}

function getAtPath(value: unknown, segments: string[]): unknown {
  let current = value;
  for (const segment of segments) {
    if (!isRecord(current)) {
      return null;
    }
    current = current[segment];
  }
  return current;
}

function cleanString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function extractTranscriptMessage(value: unknown): string | null {
  if (!isRecord(value) || value.type !== "response_item" || !isRecord(value.payload)) {
    return null;
  }

  const payload = value.payload;
  if (payload.type !== "message") {
    return null;
  }
  if (payload.role !== "user" && payload.role !== "assistant") {
    return null;
  }
  if (!Array.isArray(payload.content)) {
    return "";
  }

  const text = payload.content
    .map((item) => {
      if (!isRecord(item)) {
        return "";
      }
      if (item.type !== "input_text" && item.type !== "output_text") {
        return "";
      }
      return typeof item.text === "string" ? item.text : "";
    })
    .filter(Boolean)
    .join(" ");

  const normalized = normalizeWhitespace(text);
  if (payload.role === "user" && isSyntheticUserContext(normalized)) {
    return null;
  }

  return normalized;
}

function isSyntheticUserContext(text: string): boolean {
  return (
    text.startsWith("# AGENTS.md instructions") ||
    text.startsWith("<environment_context>") ||
    text.startsWith("<INSTRUCTIONS>") ||
    text.startsWith("<permissions instructions>")
  );
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function stableFileId(value: string): string {
  return `file:${Buffer.from(value).toString("base64url")}`;
}

function maxNullable(left: number | null, right: number | null): number | null {
  if (left === null) {
    return right;
  }
  if (right === null) {
    return left;
  }
  return Math.max(left, right);
}

function minNullable(left: number | null, right: number | null): number | null {
  if (left === null) {
    return right;
  }
  if (right === null) {
    return left;
  }
  return Math.min(left, right);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
