import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { createRequestHandler } from "./server.js";
import type { ThreadRecord } from "./types.js";
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
