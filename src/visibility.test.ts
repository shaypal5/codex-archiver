import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createRequestHandler } from "./server.js";
import type { ThreadRecord, VisibilityDiagnostics } from "./types.js";
import { classifyThreadVisibility, diagnoseVisibility } from "./visibility.js";

test("visibility classifier keeps local, index, and probe states separate", () => {
  const thread: ThreadRecord = {
    id: "active-thread",
    title: "Active Thread",
    cwd: "/tmp/project-a",
    updatedAt: 1782900005,
    createdAt: 1782900000,
    archived: false,
    rolloutPath: "/tmp/.codex/sessions/2026/07/01/active-thread.jsonl",
    storageKind: "mixed",
    existsOnDisk: true,
    messageCount: 1,
    contentPreview: "hello",
    restoreStatus: "active",
    sourcePaths: ["/tmp/.codex/sessions/2026/07/01/active-thread.jsonl"],
  };

  const classified = classifyThreadVisibility(thread, {
    sessionIndexIds: new Set(["active-thread"]),
    sessionIndexPaths: new Set(),
    indexedIds: new Set(["active-thread"]),
    codexResume: {
      ids: new Set(["active-thread"]),
      searchableText: "",
      report: { name: "codex-resume", status: "available", message: "ok" },
    },
    appServer: {
      ids: new Set(),
      searchableText: "",
      report: { name: "codex-app-server", status: "available", message: "ok" },
    },
  });

  assert.equal(classified.activeInLocalStorage, true);
  assert.equal(classified.archivedInLocalStorage, false);
  assert.equal(classified.rolloutFileExists, true);
  assert.equal(classified.rolloutFileMissing, false);
  assert.equal(classified.sqlitePresent, true);
  assert.equal(classified.sessionIndexPresent, true);
  assert.equal(classified.indexedPresent, true);
  assert.equal(classified.codexResumeVisible, true);
  assert.equal(classified.appServerVisible, false);
});

test("diagnoseVisibility reports fixture states with mocked visibility probes", async (t) => {
  if (!hasSqliteCli()) {
    t.skip("sqlite3 CLI is required for visibility integration tests");
    return;
  }

  const fixture = await createFixture(t);
  const result = await diagnoseVisibility({
    codexHome: fixture.codexHome,
    indexPath: fixture.indexPath,
    codexResumeProbe: async () => ({
      ids: new Set(["active-thread"]),
      searchableText: "",
      report: { name: "codex-resume", status: "available", message: "mocked" },
    }),
    appServerProbe: async () => ({
      ids: new Set(["archived-thread"]),
      searchableText: "",
      report: { name: "codex-app-server", status: "available", message: "mocked" },
    }),
  });

  assert.equal(result.summary.totalThreads, 3);
  assert.equal(result.summary.activeInLocalStorage, 1);
  assert.equal(result.summary.archivedInLocalStorage, 1);
  assert.equal(result.summary.rolloutFileMissing, 1);
  assert.equal(result.summary.sqlitePresent, 3);
  assert.equal(result.summary.sessionIndexPresent, 2);
  assert.equal(result.summary.indexedPresent, 3);
  assert.equal(result.summary.codexResumeVisible, 1);
  assert.equal(result.summary.appServerVisible, 1);

  const orphaned = result.threads.find((thread) => thread.id === "missing-thread");
  assert(orphaned);
  assert.equal(orphaned.rolloutFileMissing, true);
  assert.equal(orphaned.sqlitePresent, true);
  assert.equal(orphaned.sessionIndexPresent, false);

  const archived = result.threads.find((thread) => thread.id === "archived-thread");
  assert(archived);
  assert.equal(archived.sessionIndexPresent, true);
});

test("diagnose visibility CLI returns JSON diagnostics", async (t) => {
  if (!hasSqliteCli()) {
    t.skip("sqlite3 CLI is required for visibility CLI tests");
    return;
  }

  const fixture = await createFixture(t);
  const stdout = execFileSync(
    process.execPath,
    [
      path.resolve("dist/cli.js"),
      "diagnose",
      "visibility",
      "--codex-home",
      fixture.codexHome,
      "--index-path",
      fixture.indexPath,
      "--no-codex-resume",
      "--no-app-server",
    ],
    { encoding: "utf8" },
  );
  const parsed = JSON.parse(stdout) as { summary?: { totalThreads?: number }; probes?: unknown[] };
  assert.equal(parsed.summary?.totalThreads, 3);
  assert.equal(parsed.probes?.length, 4);
});

test("visibility API route returns diagnostics", async (t) => {
  if (!hasSqliteCli()) {
    t.skip("sqlite3 CLI is required for visibility API tests");
    return;
  }

  const fixture = await createFixture(t);
  const server = createServer(
    createRequestHandler({ codexHome: fixture.codexHome, indexPath: fixture.indexPath }),
  );
  t.after(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address === "object");

  const response = await fetch(
    `http://127.0.0.1:${address.port}/api/visibility?codexResume=0&appServer=0&includeThreads=0`,
  );
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    summary?: { totalThreads?: number };
    threads?: unknown[];
  };
  assert.equal(body.summary?.totalThreads, 3);
  assert.deepEqual(body.threads, []);

  const rejected = await fetch(
    `http://127.0.0.1:${address.port}/api/visibility?appServerUrl=http://example.com`,
  );
  assert.equal(rejected.status, 400);
});

test("app-server probe parses nested response shapes and defensive id aliases", async (t) => {
  if (!hasSqliteCli()) {
    t.skip("sqlite3 CLI is required for app-server visibility tests");
    return;
  }

  const fixture = await createFixture(t);
  const appServer = await createMockThreadListServer(t, () => ({
    payload: {
      result: {
        data: [
          { id: "active-thread", title: "Active Thread" },
          { id: "metadata-row" },
          { payload: { threadId: "archived-thread" } },
          { conversation_id: "bad path/with/slash", title: "Invalid id" },
        ],
      },
    },
  }));

  const result = await diagnoseWithAppServer(fixture, appServer.url);
  const probe = appServerProbe(result);
  assert.equal(probe.status, "available");
  assert.equal(probe.visibleCount, 2);
  assert.match(probe.message, /2 candidate thread ids/);
  assert(probe.warnings?.some((warning) => warning.includes("ignored")));
  assert.equal(result.summary.appServerVisible, 2);
  assert.equal(result.threads.find((thread) => thread.id === "active-thread")?.appServerVisible, true);
  assert.equal(
    result.threads.find((thread) => thread.id === "archived-thread")?.appServerVisible,
    true,
  );
  assert.equal(result.threads.find((thread) => thread.id === "missing-thread")?.appServerVisible, false);
});

test("app-server probe follows cursor pagination and stops repeated cursors with a warning", async (t) => {
  if (!hasSqliteCli()) {
    t.skip("sqlite3 CLI is required for app-server pagination tests");
    return;
  }

  const fixture = await createFixture(t);
  const appServer = await createMockThreadListServer(t, (url) => {
    if (url.searchParams.get("cursor") === "repeat") {
      return {
        result: {
          threads: [{ thread_id: "archived-thread" }],
          next_cursor: "repeat",
          has_more: true,
        },
      };
    }
    return {
      result: {
        threads: [{ thread_id: "active-thread" }],
        next_cursor: "repeat",
        has_more: true,
      },
    };
  });

  const result = await diagnoseWithAppServer(fixture, appServer.url);
  const probe = appServerProbe(result);
  assert.equal(probe.status, "available");
  assert.equal(probe.visibleCount, 2);
  assert(probe.warnings?.some((warning) => warning.includes("repeated pagination cursor")));
  assert.equal(result.summary.appServerVisible, 2);
});

test("app-server probe stops at the page limit with a clear warning", async (t) => {
  if (!hasSqliteCli()) {
    t.skip("sqlite3 CLI is required for app-server pagination tests");
    return;
  }

  const fixture = await createFixture(t);
  const appServer = await createMockThreadListServer(t, (url) => ({
    threads: [{ thread_id: url.searchParams.get("offset") === "0" ? "active-thread" : "unknown-thread" }],
    hasMore: true,
  }));

  const result = await diagnoseWithAppServer(fixture, appServer.url);
  const probe = appServerProbe(result);
  assert.equal(probe.status, "available");
  assert(probe.warnings?.some((warning) => warning.includes("stopped after 50 app-server pages")));
  assert.equal(result.threads.find((thread) => thread.id === "active-thread")?.appServerVisible, true);
});

test("app-server probe records malformed responses as non-fatal warnings", async (t) => {
  if (!hasSqliteCli()) {
    t.skip("sqlite3 CLI is required for app-server malformed response tests");
    return;
  }

  const fixture = await createFixture(t);
  const appServer = await createMockThreadListServer(t, () => ({
    payload: { data: { unrelated: [{ id: "not-a-thread" }] } },
  }));

  const result = await diagnoseWithAppServer(fixture, appServer.url);
  const probe = appServerProbe(result);
  assert.equal(probe.status, "available");
  assert.equal(probe.visibleCount, 0);
  assert(probe.warnings?.some((warning) => warning.includes("no recognizable thread object array")));
  assert.equal(result.summary.appServerVisible, 0);
});

test("app-server probe does not classify visibility by title or cwd text fallback", async (t) => {
  if (!hasSqliteCli()) {
    t.skip("sqlite3 CLI is required for app-server classification tests");
    return;
  }

  const fixture = await createFixture(t);
  const appServer = await createMockThreadListServer(t, () => ({
    threads: [{ thread_id: "unrelated-thread", title: "Missing Thread", cwd: "/tmp/project-c" }],
  }));

  const result = await diagnoseWithAppServer(fixture, appServer.url);
  const probe = appServerProbe(result);
  assert.equal(probe.status, "available");
  assert.equal(probe.visibleCount, 1);
  assert.equal(result.summary.appServerVisible, 0);
  assert.equal(result.threads.find((thread) => thread.id === "missing-thread")?.appServerVisible, false);
});

test("app-server probe reports timeout, failure, and unavailable states without throwing", async (t) => {
  if (!hasSqliteCli()) {
    t.skip("sqlite3 CLI is required for app-server failure tests");
    return;
  }

  const fixture = await createFixture(t);
  const timeoutServer = await createMockThreadListServer(t, async () => {
    await delay(1000);
    return { threads: [{ thread_id: "active-thread" }] };
  });
  const timeoutResult = await diagnoseWithAppServer(fixture, timeoutServer.url, { timeoutMs: 250 });
  assert.equal(appServerProbe(timeoutResult).status, "timeout");
  assert.equal(timeoutResult.summary.appServerVisible, null);

  const failedServer = await createMockThreadListServer(t, () => ({
    status: 500,
    body: { error: "boom" },
  }));
  const failedResult = await diagnoseWithAppServer(fixture, failedServer.url);
  assert.equal(appServerProbe(failedResult).status, "failed");
  assert.equal(failedResult.summary.appServerVisible, null);

  const unavailableUrl = await reserveAndCloseLocalUrl();
  const unavailableResult = await diagnoseWithAppServer(fixture, unavailableUrl);
  assert.equal(appServerProbe(unavailableResult).status, "unavailable");
  assert.equal(unavailableResult.summary.appServerVisible, null);
});

async function createFixture(t: TestContext): Promise<{ codexHome: string; indexPath: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-archiver-visibility-test-"));
  const codexHome = path.join(root, ".codex");
  const indexPath = path.join(root, "cache", "index.sqlite");
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  await mkdir(path.join(codexHome, "sessions", "2026", "07", "01"), { recursive: true });
  await mkdir(path.join(codexHome, "archived_sessions"), { recursive: true });

  const activePath = path.join(codexHome, "sessions", "2026", "07", "01", "active.jsonl");
  const archivedPath = path.join(codexHome, "archived_sessions", "archived.jsonl");
  const missingPath = path.join(codexHome, "sessions", "missing.jsonl");

  await writeJsonl(activePath, [
    {
      timestamp: "2026-07-01T10:00:00.000Z",
      type: "session_meta",
      payload: { id: "active-thread", cwd: "/tmp/project-a" },
    },
  ]);
  await writeJsonl(archivedPath, [
    {
      timestamp: "2026-06-01T10:00:00.000Z",
      type: "session_meta",
      payload: { id: "archived-thread", cwd: "/tmp/project-b" },
    },
  ]);
  await writeFile(
    path.join(codexHome, "session_index.jsonl"),
    [
      JSON.stringify({ payload: { id: "active-thread" } }),
      JSON.stringify({ payload: { rollout_path: archivedPath } }),
    ].join("\n"),
  );
  createSqliteState(codexHome, [
    {
      id: "active-thread",
      title: "Active Thread",
      cwd: "/tmp/project-a",
      updated_at: 1782900005,
      created_at: 1782900000,
      archived: 0,
      rollout_path: activePath,
    },
    {
      id: "archived-thread",
      title: "Archived Thread",
      cwd: "/tmp/project-b",
      updated_at: 1780317601,
      created_at: 1780317600,
      archived: 1,
      rollout_path: archivedPath,
    },
    {
      id: "missing-thread",
      title: "Missing Thread",
      cwd: "/tmp/project-c",
      updated_at: 1775037601,
      created_at: 1775037600,
      archived: 0,
      rollout_path: missingPath,
    },
  ]);

  return { codexHome, indexPath };
}

async function writeJsonl(filePath: string, rows: unknown[]): Promise<void> {
  await writeFile(filePath, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
}

function createSqliteState(codexHome: string, rows: Array<Record<string, string | number>>): void {
  const dbPath = path.join(codexHome, "state_5.sqlite");
  execSql(dbPath, [
    "CREATE TABLE threads (id TEXT, title TEXT, cwd TEXT, updated_at INTEGER, created_at INTEGER, archived INTEGER, rollout_path TEXT);",
  ]);

  for (const row of rows) {
    execSql(dbPath, [
      `INSERT INTO threads VALUES (${sqlValue(row.id)}, ${sqlValue(row.title)}, ${sqlValue(
        row.cwd,
      )}, ${sqlValue(row.updated_at)}, ${sqlValue(row.created_at)}, ${sqlValue(
        row.archived,
      )}, ${sqlValue(row.rollout_path)});`,
    ]);
  }
}

function execSql(dbPath: string, statements: string[]): void {
  execFileSync("sqlite3", [dbPath, statements.join("\n")]);
}

function sqlValue(value: string | number): string {
  if (typeof value === "number") {
    return String(value);
  }
  return `'${value.replaceAll("'", "''")}'`;
}

function hasSqliteCli(): boolean {
  try {
    execFileSync("sqlite3", ["--version"]);
    return true;
  } catch {
    return false;
  }
}

async function diagnoseWithAppServer(
  fixture: { codexHome: string; indexPath: string },
  appServerUrl: string,
  options: { timeoutMs?: number } = {},
): Promise<VisibilityDiagnostics> {
  return diagnoseVisibility({
    codexHome: fixture.codexHome,
    indexPath: fixture.indexPath,
    includeCodexResume: false,
    appServerUrl,
    timeoutMs: options.timeoutMs,
  });
}

function appServerProbe(result: VisibilityDiagnostics) {
  const probe = result.probes.find((item) => item.name === "codex-app-server");
  assert(probe);
  return probe;
}

async function createMockThreadListServer(
  t: TestContext,
  handler: (
    url: URL,
    request: { method?: string },
  ) =>
    | unknown
    | Promise<unknown>
    | {
        status: number;
        body: unknown;
      },
): Promise<{ url: string }> {
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== "/thread/list") {
        response.writeHead(404);
        response.end("not found");
        return;
      }
      const result = await handler(url, { method: request.method });
      const status =
        isMockHttpResponse(result) && typeof result.status === "number" ? result.status : 200;
      const body = isMockHttpResponse(result) ? result.body : result;
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(body));
    } catch (error) {
      response.writeHead(500, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
  });
  t.after(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address === "object");
  return { url: `http://127.0.0.1:${address.port}` };
}

function isMockHttpResponse(value: unknown): value is { status: number; body: unknown } {
  return typeof value === "object" && value !== null && "status" in value && "body" in value;
}

async function reserveAndCloseLocalUrl(): Promise<string> {
  const server = createServer();
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}`;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return url;
}
