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
const APP_SERVER_RESPONSE_SEARCH_DEPTH = 6;
const THREAD_ARRAY_KEYS = new Set([
  "threads",
  "threadList",
  "thread_list",
  "items",
  "sessions",
  "conversations",
  "entries",
  "nodes",
]);
const APP_SERVER_NESTED_KEYS = [
  "result",
  "payload",
  "data",
  "response",
  "body",
  "page",
  "connection",
  "thread",
  "session",
];
const APP_SERVER_ENVELOPE_KEYS = ["result", "payload", "data", "response", "body"];
const APP_SERVER_PAGINATION_CONTAINER_KEYS = ["pagination", "pageInfo", "page_info", "meta"];

interface IndexedRow {
  id: string;
}

interface SessionIndexEvidence {
  available: boolean;
  ids: Set<string>;
  paths: Set<string>;
  report: VisibilityProbeReport;
}

interface ProbeUniverse {
  ids: Set<string>;
  searchableText: string;
  report: VisibilityProbeReport;
}

interface AppServerThreadListPage {
  threadObjects: unknown[];
  nextCursor: string | null;
  hasMore: boolean;
  warnings: string[];
}

export interface VisibilityOptions {
  codexHome?: string;
  indexPath?: string;
  timeoutMs?: number;
  includeCodexResume?: boolean;
  includeAppServer?: boolean;
  appServerUrl?: string;
  codexCommand?: string;
  includeThreads?: boolean;
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
      sessionIndexPaths: sessionIndex.available ? sessionIndex.paths : null,
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
    threads: options.includeThreads === false ? [] : threads,
  };
}

export function classifyThreadVisibility(
  thread: ThreadRecord,
  evidence: {
    sessionIndexIds: Set<string> | null;
    sessionIndexPaths: Set<string> | null;
    indexedIds: Set<string>;
    codexResume: ProbeUniverse;
    appServer: ProbeUniverse;
  },
): ThreadVisibilityRecord {
  const activeInLocalStorage = thread.existsOnDisk && hasSourceUnder(thread, "sessions");
  const archivedInLocalStorage = thread.existsOnDisk && hasSourceUnder(thread, "archived_sessions");
  const sqlitePresent = thread.storageKind === "sqlite-only" || thread.storageKind === "mixed";
  const sessionIndexPresent =
    evidence.sessionIndexIds === null || evidence.sessionIndexPaths === null
      ? null
      : evidence.sessionIndexIds.has(thread.id) ||
        thread.sourcePaths.some((sourcePath) => evidence.sessionIndexPaths?.has(sourcePath));
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
      paths: new Set(),
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
    const paths = new Set<string>();
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) {
        continue;
      }
      try {
        const value = JSON.parse(line) as unknown;
        for (const id of candidateIds(value)) {
          ids.add(id);
        }
        for (const candidatePath of candidatePaths(value)) {
          paths.add(resolveCodexPath(codexHome, candidatePath));
        }
      } catch {
        continue;
      }
    }
    return {
      available: true,
      ids,
      paths,
      report: {
        name: "session-index",
        status: "available",
        message: `Session index contains ${ids.size} candidate thread ids and ${paths.size} candidate paths.`,
        durationMs: Date.now() - startedAt,
        visibleCount: ids.size + paths.size,
      },
    };
  } catch (error) {
    return {
      available: false,
      ids: new Set(),
      paths: new Set(),
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
  const warnings: string[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | null = null;
  let offset = 0;
  let reachedPageLimit = true;

  try {
    for (let page = 0; page < APP_SERVER_MAX_PAGES; page += 1) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        throw new TimeoutError("app-server pagination exceeded the configured timeout");
      }
      const pageResult = await fetchThreadListPage(appServerUrl, cursor, offset, remainingMs);
      warnings.push(...pageResult.warnings.map((warning) => `page ${page + 1}: ${warning}`));
      collectVisibleCandidates(pageResult.threadObjects, ids, warnings, page + 1);
      if (!pageResult.nextCursor && !pageResult.hasMore) {
        reachedPageLimit = false;
        break;
      }
      if (pageResult.nextCursor && seenCursors.has(pageResult.nextCursor)) {
        warnings.push(
          `page ${page + 1}: repeated pagination cursor "${pageResult.nextCursor}"; stopped to avoid a loop.`,
        );
        reachedPageLimit = false;
        break;
      }
      if (pageResult.nextCursor) {
        seenCursors.add(pageResult.nextCursor);
      }
      cursor = pageResult.nextCursor;
      offset += pageResult.threadObjects.length;
      if (pageResult.threadObjects.length === 0) {
        warnings.push(
          `page ${page + 1}: pagination indicated more results but no thread objects were found.`,
        );
        reachedPageLimit = false;
        break;
      }
    }
    if (reachedPageLimit) {
      warnings.push(
        `stopped after ${APP_SERVER_MAX_PAGES} app-server pages; results may be incomplete.`,
      );
    }

    return {
      ids,
      searchableText: "",
      report: {
        name: "codex-app-server",
        status: "available",
        message: `Codex app-server thread/list probe returned ${ids.size} candidate thread ids${
          warnings.length > 0 ? ` with ${warnings.length} warning(s)` : ""
        }.`,
        durationMs: Date.now() - startedAt,
        visibleCount: ids.size,
        ...(warnings.length > 0 ? { warnings } : {}),
      },
    };
  } catch (error) {
    const status =
      isAbortError(error) || error instanceof TimeoutError
        ? "timeout"
        : isFetchUnavailable(error)
          ? "unavailable"
          : "failed";
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
): Promise<AppServerThreadListPage> {
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
    return parseAppServerThreadListPage(body);
  } finally {
    clearTimeout(timeout);
  }
}

function parseAppServerThreadListPage(value: unknown): AppServerThreadListPage {
  const warnings: string[] = [];
  const threadObjects = findThreadObjects(value, warnings);
  if (threadObjects.length === 0) {
    warnings.push("no recognizable thread object array was found in the response.");
  }
  return {
    threadObjects,
    nextCursor: firstStringAt(value, paginationCandidatePaths([
      "nextCursor",
      "next_cursor",
      "nextPageCursor",
      "next_page_cursor",
      "after",
      "cursor",
      "next",
      "continuationToken",
      "continuation_token",
      "endCursor",
      "end_cursor",
    ])),
    hasMore: firstBooleanAt(value, paginationCandidatePaths([
      "hasMore",
      "has_more",
      "more",
      "hasNextPage",
      "has_next_page",
      "nextPage",
      "next_page",
    ])),
    warnings,
  };
}

function collectVisibleCandidates(
  threadObjects: unknown[],
  ids: Set<string>,
  warnings: string[],
  pageNumber: number,
): void {
  let malformedCount = 0;
  for (const thread of threadObjects) {
    const threadIds = threadIdsFromObject(thread);
    if (threadIds.length === 0) {
      malformedCount += 1;
      continue;
    }
    for (const id of threadIds) {
      ids.add(id);
    }
  }
  if (malformedCount > 0) {
    warnings.push(
      `page ${pageNumber}: ignored ${malformedCount} thread-like item(s) without a plausible thread id.`,
    );
  }
}

function findThreadObjects(value: unknown, warnings: string[]): unknown[] {
  const visited = new Set<unknown>();
  const arrays: unknown[][] = [];

  function visit(current: unknown, depth: number, viaThreadKey: boolean): void {
    if (depth > APP_SERVER_RESPONSE_SEARCH_DEPTH || current === null) {
      return;
    }
    if (typeof current === "object") {
      if (visited.has(current)) {
        return;
      }
      visited.add(current);
    }

    if (Array.isArray(current)) {
      const threadLikeItems = current.filter((item) => isThreadLikeObject(item, !viaThreadKey));
      if (viaThreadKey || threadLikeItems.length > 0) {
        const rejected = current.length - threadLikeItems.length;
        if (rejected > 0) {
          warnings.push(
            `ignored ${rejected} item(s) in a thread list because they did not look like thread objects.`,
          );
        }
        arrays.push(threadLikeItems);
      }
      return;
    }

    if (!isRecord(current)) {
      return;
    }

    for (const [key, child] of Object.entries(current)) {
      if (THREAD_ARRAY_KEYS.has(key)) {
        visit(child, depth + 1, true);
      }
    }
    for (const key of APP_SERVER_NESTED_KEYS) {
      if (key in current && !THREAD_ARRAY_KEYS.has(key)) {
        visit(current[key], depth + 1, false);
      }
    }
  }

  visit(value, 0, false);
  return arrays.flat();
}

function isThreadLikeObject(value: unknown, requireThreadSignal: boolean): boolean {
  if (!isRecord(value)) {
    return false;
  }
  if (!requireThreadSignal && threadIdsFromObject(value).length > 0) {
    return true;
  }
  const explicitThreadId = firstStringAt(value, [
    ["thread_id"],
    ["threadId"],
    ["session_id"],
    ["sessionId"],
    ["conversation_id"],
    ["conversationId"],
    ["payload", "thread_id"],
    ["payload", "threadId"],
    ["thread", "id"],
    ["session", "id"],
    ["conversation", "id"],
  ]);
  const descriptiveSignal = firstStringAt(value, [
      ["title"],
      ["cwd"],
      ["workingDirectory"],
      ["working_directory"],
      ["projectPath"],
      ["project_path"],
      ["rolloutPath"],
      ["rollout_path"],
      ["updatedAt"],
      ["updated_at"],
  ]);
  return Boolean(explicitThreadId || (firstStringAt(value, [["id"]]) && descriptiveSignal));
}

function threadIdsFromObject(value: unknown): string[] {
  if (!isRecord(value)) {
    return [];
  }
  const ids = [
    firstStringAt(value, [
      ["id"],
      ["thread_id"],
      ["threadId"],
      ["session_id"],
      ["sessionId"],
      ["conversation_id"],
      ["conversationId"],
    ]),
    firstStringAt(value, [["payload", "id"], ["payload", "thread_id"], ["payload", "threadId"]]),
    firstStringAt(value, [["session", "id"], ["thread", "id"], ["conversation", "id"]]),
  ].filter((item): item is string => typeof item === "string" && isPlausibleThreadId(item));
  return [...new Set(ids)];
}

function paginationCandidatePaths(keys: string[]): string[][] {
  const prefixes = envelopePrefixes(3);
  const containers = [[], ...APP_SERVER_PAGINATION_CONTAINER_KEYS.map((key) => [key])];
  return prefixes.flatMap((prefix) =>
    containers.flatMap((container) => keys.map((key) => [...prefix, ...container, key])),
  );
}

function envelopePrefixes(maxDepth: number): string[][] {
  const prefixes: string[][] = [[]];

  function append(prefix: string[], depth: number): void {
    if (depth >= maxDepth) {
      return;
    }
    for (const key of APP_SERVER_ENVELOPE_KEYS) {
      const next = [...prefix, key];
      prefixes.push(next);
      append(next, depth + 1);
    }
  }

  append([], 0);
  return prefixes;
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

function candidatePaths(value: unknown): string[] {
  return [
    firstStringAt(value, [["rollout_path"], ["rolloutPath"], ["path"], ["file"]]),
    firstStringAt(value, [["payload", "rollout_path"], ["payload", "rolloutPath"]]),
    firstStringAt(value, [["session", "rollout_path"], ["session", "rolloutPath"]]),
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

function isPlausibleThreadId(value: string): boolean {
  const trimmed = value.trim();
  return (
    trimmed.length >= 4 &&
    trimmed.length <= 160 &&
    !/\s/.test(trimmed) &&
    !/[/?#{}[\]\\]/.test(trimmed) &&
    !/^https?:/i.test(trimmed)
  );
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

function resolveCodexPath(codexHome: string, candidatePath: string): string {
  return path.isAbsolute(candidatePath) ? candidatePath : path.join(codexHome, candidatePath);
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
  return (
    isRecord(error) &&
    (error.signal === "SIGTERM" ||
      error.killed === true ||
      error.code === "ETIMEDOUT" ||
      error.message === "Command failed: timeout")
  );
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function isFetchUnavailable(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  if (error.name !== "TypeError" && !/fetch failed/i.test(error.message)) {
    return false;
  }
  const cause = isRecord(error) ? error.cause : null;
  return (
    isRecord(cause) &&
    ["ECONNREFUSED", "ENOTFOUND", "EHOSTUNREACH", "ENETUNREACH", "ECONNRESET"].includes(
      String(cause.code),
    )
  );
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
