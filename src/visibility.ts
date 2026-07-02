import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { ensureSearchIndex } from "./indexer.js";
import { defaultCodexHome, defaultIndexPath, expandHome } from "./paths.js";
import { scanCodexStorage } from "./scanner.js";
import { queryJson } from "./sqlite.js";
import type {
  Diagnostic,
  ThreadRecord,
  ThreadVisibilityRecord,
  VisibilityDiagnostics,
  VisibilityProbeReport,
  VisibilitySummary,
} from "./types.js";

const execFileAsync = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 2500;
const APP_SERVER_PAGE_LIMIT = 100;
const APP_SERVER_MAX_PAGES = 50;

interface IndexedRow {
  id: string;
}

interface SessionIndexEvidence {
  available: boolean;
  ids: Set<string>;
  report: VisibilityProbeReport;
}

interface ProbeUniverse {
  ids: Set<string>;
  searchableText: string;
  report: VisibilityProbeReport;
}

export interface VisibilityOptions {
  codexHome?: string;
  indexPath?: string;
  timeoutMs?: number;
  includeCodexResume?: boolean;
  includeAppServer?: boolean;
  appServerUrl?: string;
  codexCommand?: string;
  codexResumeProbe?: () => Promise<ProbeUniverse>;
  appServerProbe?: () => Promise<ProbeUniverse>;
}

export async function diagnoseVisibility(
  options: VisibilityOptions = {},
): Promise<VisibilityDiagnostics> {
  const codexHome = path.resolve(expandHome(options.codexHome ?? defaultCodexHome()));
  const indexPath = path.resolve(expandHome(options.indexPath ?? defaultIndexPath()));
  const timeoutMs = normalizeTimeout(options.timeoutMs);
  const diagnostics: Diagnostic[] = [];

  const scan = await scanCodexStorage(codexHome);
  diagnostics.push(...scan.diagnostics);

  const [sessionIndex, indexed, codexResume, appServer] = await Promise.all([
    readSessionIndex(codexHome),
    readIndexedThreadIds(codexHome, indexPath),
    runCodexResumeProbe(options, timeoutMs),
    runAppServerProbe(options, timeoutMs),
  ]);

  const probes = [sessionIndex.report, indexed.report, codexResume.report, appServer.report];
  const threads = scan.threads.map((thread) =>
    classifyThreadVisibility(thread, {
      sessionIndexIds: sessionIndex.available ? sessionIndex.ids : null,
      indexedIds: indexed.ids,
      codexResume,
      appServer,
    }),
  );

  return {
    codexHome,
    indexPath,
    generatedAt: new Date().toISOString(),
    probes,
    diagnostics,
    summary: buildVisibilitySummary(threads),
    threads,
  };
}

export function classifyThreadVisibility(
  thread: ThreadRecord,
  evidence: {
    sessionIndexIds: Set<string> | null;
    indexedIds: Set<string>;
    codexResume: ProbeUniverse;
    appServer: ProbeUniverse;
  },
): ThreadVisibilityRecord {
  const activeInLocalStorage = thread.existsOnDisk && hasSourceUnder(thread, "sessions");
  const archivedInLocalStorage = thread.existsOnDisk && hasSourceUnder(thread, "archived_sessions");
  const sqlitePresent = thread.storageKind === "sqlite-only" || thread.storageKind === "mixed";
  const sessionIndexPresent =
    evidence.sessionIndexIds === null ? null : evidence.sessionIndexIds.has(thread.id);
  const codexResumeVisible = probeVisibility(thread, evidence.codexResume);
  const appServerVisible = probeVisibility(thread, evidence.appServer);

  return {
    id: thread.id,
    title: thread.title,
    cwd: thread.cwd,
    updatedAt: thread.updatedAt,
    restoreStatus: thread.restoreStatus,
    activeInLocalStorage,
    archivedInLocalStorage,
    rolloutFileExists: thread.existsOnDisk,
    rolloutFileMissing: !thread.existsOnDisk,
    sqlitePresent,
    sessionIndexPresent,
    indexedPresent: evidence.indexedIds.has(thread.id),
    codexResumeVisible,
    appServerVisible,
    sourcePaths: thread.sourcePaths,
  };
}

async function readIndexedThreadIds(
  codexHome: string,
  indexPath: string,
): Promise<{ ids: Set<string>; report: VisibilityProbeReport }> {
  const startedAt = Date.now();
  try {
    await ensureSearchIndex({ codexHome, indexPath });
    const rows = await queryJson<IndexedRow>(indexPath, "SELECT id FROM threads;");
    const ids = new Set(rows.map((row) => row.id).filter(Boolean));
    return {
      ids,
      report: {
        name: "search-index",
        status: "available",
        message: `Search index contains ${ids.size} thread ids.`,
        durationMs: Date.now() - startedAt,
        visibleCount: ids.size,
      },
    };
  } catch (error) {
    return {
      ids: new Set(),
      report: {
        name: "search-index",
        status: "failed",
        message: `Could not read search index: ${errorMessage(error)}`,
        durationMs: Date.now() - startedAt,
      },
    };
  }
}

async function readSessionIndex(codexHome: string): Promise<SessionIndexEvidence> {
  const startedAt = Date.now();
  const sessionIndexPath = path.join(codexHome, "session_index.jsonl");
  if (!(await exists(sessionIndexPath))) {
    return {
      available: false,
      ids: new Set(),
      report: {
        name: "session-index",
        status: "unavailable",
        message: `Session index was not found at ${sessionIndexPath}.`,
        durationMs: Date.now() - startedAt,
      },
    };
  }

  try {
    const text = await readFile(sessionIndexPath, "utf8");
    const ids = new Set<string>();
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) {
        continue;
      }
      try {
        const value = JSON.parse(line) as unknown;
        for (const id of candidateIds(value)) {
          ids.add(id);
        }
      } catch {
        continue;
      }
    }
    return {
      available: true,
      ids,
      report: {
        name: "session-index",
        status: "available",
        message: `Session index contains ${ids.size} candidate thread ids.`,
        durationMs: Date.now() - startedAt,
        visibleCount: ids.size,
      },
    };
  } catch (error) {
    return {
      available: false,
      ids: new Set(),
      report: {
        name: "session-index",
        status: "failed",
        message: `Could not read session index: ${errorMessage(error)}`,
        durationMs: Date.now() - startedAt,
      },
    };
  }
}

async function runCodexResumeProbe(
  options: VisibilityOptions,
  timeoutMs: number,
): Promise<ProbeUniverse> {
  if (options.includeCodexResume === false) {
    return skippedProbe("codex-resume", "Codex resume probe was disabled.");
  }
  if (options.codexResumeProbe) {
    return options.codexResumeProbe();
  }

  const startedAt = Date.now();
  const command = options.codexCommand ?? "codex";
  try {
    const { stdout, stderr } = await execFileAsync(
      command,
      ["resume", "--all", "--include-non-interactive"],
      {
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024 * 8,
        env: { ...process.env, NO_COLOR: "1", TERM: "dumb" },
      },
    );
    const text = `${stdout}\n${stderr}`;
    return {
      ids: idsFromText(text),
      searchableText: normalizeProbeText(text),
      report: {
        name: "codex-resume",
        status: "available",
        message: "codex resume --all --include-non-interactive completed.",
        durationMs: Date.now() - startedAt,
      },
    };
  } catch (error) {
    const status = isTimeoutError(error) ? "timeout" : isMissingCommand(error) ? "unavailable" : "failed";
    return {
      ids: new Set(),
      searchableText: "",
      report: {
        name: "codex-resume",
        status,
        message: `codex resume visibility probe did not complete: ${errorMessage(error)}`,
        durationMs: Date.now() - startedAt,
      },
    };
  }
}

async function runAppServerProbe(
  options: VisibilityOptions,
  timeoutMs: number,
): Promise<ProbeUniverse> {
  const appServerUrl = options.appServerUrl ?? process.env.CODEX_ARCHIVER_CODEX_APP_SERVER_URL;
  if (options.includeAppServer === false) {
    return skippedProbe("codex-app-server", "Codex app-server probe was disabled.");
  }
  if (options.appServerProbe) {
    return options.appServerProbe();
  }
  if (!appServerUrl) {
    return skippedProbe(
      "codex-app-server",
      "Codex app-server URL was not configured; pass --app-server-url or set CODEX_ARCHIVER_CODEX_APP_SERVER_URL.",
    );
  }

  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  const ids = new Set<string>();
  const textParts: string[] = [];
  let cursor: string | null = null;
  let offset = 0;

  try {
    for (let page = 0; page < APP_SERVER_MAX_PAGES; page += 1) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        throw new TimeoutError("app-server pagination exceeded the configured timeout");
      }
      const pageResult = await fetchThreadListPage(appServerUrl, cursor, offset, remainingMs);
      collectVisibleCandidates(pageResult.body, ids, textParts);
      if (!pageResult.nextCursor && !pageResult.hasMore) {
        break;
      }
      cursor = pageResult.nextCursor;
      offset += pageResult.count;
      if (pageResult.count === 0) {
        break;
      }
    }

    return {
      ids,
      searchableText: normalizeProbeText(textParts.join("\n")),
      report: {
        name: "codex-app-server",
        status: "available",
        message: `Codex app-server thread/list probe returned ${ids.size} candidate thread ids.`,
        durationMs: Date.now() - startedAt,
        visibleCount: ids.size,
      },
    };
  } catch (error) {
    const status = isAbortError(error) || error instanceof TimeoutError ? "timeout" : "failed";
    return {
      ids: new Set(),
      searchableText: "",
      report: {
        name: "codex-app-server",
        status,
        message: `Codex app-server visibility probe did not complete: ${errorMessage(error)}`,
        durationMs: Date.now() - startedAt,
      },
    };
  }
}

async function fetchThreadListPage(
  appServerUrl: string,
  cursor: string | null,
  offset: number,
  timeoutMs: number,
): Promise<{ body: unknown; nextCursor: string | null; hasMore: boolean; count: number }> {
  const endpoint = new URL("/thread/list", normalizeBaseUrl(appServerUrl));
  endpoint.searchParams.set("limit", String(APP_SERVER_PAGE_LIMIT));
  endpoint.searchParams.set("offset", String(offset));
  if (cursor) {
    endpoint.searchParams.set("cursor", cursor);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response = await fetch(endpoint, { signal: controller.signal });
    if (response.status === 404 || response.status === 405) {
      response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ limit: APP_SERVER_PAGE_LIMIT, offset, cursor }),
        signal: controller.signal,
      });
    }
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    const body = (await response.json()) as unknown;
    return {
      body,
      nextCursor: firstStringAt(body, [
        ["nextCursor"],
        ["next_cursor"],
        ["next"],
        ["result", "nextCursor"],
        ["result", "next_cursor"],
      ]),
      hasMore: firstBooleanAt(body, [
        ["hasMore"],
        ["has_more"],
        ["result", "hasMore"],
        ["result", "has_more"],
      ]),
      count: findThreadObjects(body).length,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function collectVisibleCandidates(value: unknown, ids: Set<string>, textParts: string[]): void {
  for (const thread of findThreadObjects(value)) {
    for (const id of candidateIds(thread)) {
      ids.add(id);
    }
    textParts.push(JSON.stringify(thread));
  }
}

function findThreadObjects(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }
  if (!isRecord(value)) {
    return [];
  }
  for (const key of ["threads", "items", "data", "sessions"]) {
    const child = value[key];
    if (Array.isArray(child)) {
      return child;
    }
  }
  for (const key of ["result", "payload"]) {
    const nested = findThreadObjects(value[key]);
    if (nested.length > 0) {
      return nested;
    }
  }
  return [];
}

function buildVisibilitySummary(threads: ThreadVisibilityRecord[]): VisibilitySummary {
  return {
    totalThreads: threads.length,
    activeInLocalStorage: countWhere(threads, (thread) => thread.activeInLocalStorage),
    archivedInLocalStorage: countWhere(threads, (thread) => thread.archivedInLocalStorage),
    rolloutFileMissing: countWhere(threads, (thread) => thread.rolloutFileMissing),
    sqlitePresent: countWhere(threads, (thread) => thread.sqlitePresent),
    sessionIndexPresent: countNullable(threads, (thread) => thread.sessionIndexPresent),
    indexedPresent: countWhere(threads, (thread) => thread.indexedPresent),
    codexResumeVisible: countNullable(threads, (thread) => thread.codexResumeVisible),
    appServerVisible: countNullable(threads, (thread) => thread.appServerVisible),
  };
}

function probeVisibility(thread: ThreadRecord, probe: ProbeUniverse): boolean | null {
  if (probe.report.status !== "available") {
    return null;
  }
  if (probe.ids.has(thread.id)) {
    return true;
  }
  const text = probe.searchableText;
  if (!text) {
    return false;
  }
  const candidates = [thread.id, thread.title, thread.cwd].filter(
    (value): value is string => typeof value === "string" && value.trim().length >= 4,
  );
  return candidates.some((candidate) => text.includes(candidate.toLowerCase()));
}

function hasSourceUnder(thread: ThreadRecord, firstSegment: string): boolean {
  return thread.sourcePaths.some((sourcePath) => {
    const normalized = sourcePath.split(path.sep).join("/");
    return normalized.includes(`/${firstSegment}/`) || normalized.includes(`/${firstSegment}`);
  });
}

function candidateIds(value: unknown): string[] {
  return [
    firstStringAt(value, [["id"], ["thread_id"], ["threadId"], ["session_id"], ["sessionId"]]),
    firstStringAt(value, [["payload", "id"], ["payload", "thread_id"], ["payload", "threadId"]]),
    firstStringAt(value, [["session", "id"], ["thread", "id"]]),
  ].filter((item): item is string => Boolean(item));
}

function firstStringAt(value: unknown, paths: string[][]): string | null {
  for (const parts of paths) {
    let current = value;
    for (const part of parts) {
      if (!isRecord(current)) {
        current = undefined;
        break;
      }
      current = current[part];
    }
    if (typeof current === "string" && current.trim()) {
      return current.trim();
    }
  }
  return null;
}

function firstBooleanAt(value: unknown, paths: string[][]): boolean {
  for (const parts of paths) {
    let current = value;
    for (const part of parts) {
      if (!isRecord(current)) {
        current = undefined;
        break;
      }
      current = current[part];
    }
    if (typeof current === "boolean") {
      return current;
    }
  }
  return false;
}

function idsFromText(text: string): Set<string> {
  const ids = new Set<string>();
  for (const match of text.matchAll(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32}/gi)) {
    ids.add(match[0]);
  }
  return ids;
}

function normalizeProbeText(text: string): string {
  return text.toLowerCase();
}

function skippedProbe(name: ProbeUniverse["report"]["name"], message: string): ProbeUniverse {
  return {
    ids: new Set(),
    searchableText: "",
    report: { name, status: "skipped", message },
  };
}

function normalizeTimeout(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return DEFAULT_TIMEOUT_MS;
  }
  return Math.max(250, Math.floor(value));
}

function normalizeBaseUrl(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function countWhere<T>(items: T[], predicate: (item: T) => boolean): number {
  return items.filter(predicate).length;
}

function countNullable<T>(items: T[], getValue: (item: T) => boolean | null): number | null {
  const values = items.map(getValue);
  if (values.every((value) => value === null)) {
    return null;
  }
  return values.filter(Boolean).length;
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isTimeoutError(error: unknown): boolean {
  return isRecord(error) && (error.signal === "SIGTERM" || error.killed === true);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function isMissingCommand(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimeoutError";
  }
}
