import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  clearSearchIndex,
  readThreadDetail,
  readSearchIndexMeta,
  rebuildSearchIndex,
  searchCachedThreads,
  searchThreads,
} from "./indexer.js";

test("persistent index supports title, content, project, and status searches", async (t) => {
  if (!hasSqliteCli()) {
    t.skip("sqlite3 CLI is required for index integration tests");
    return;
  }

  const root = await mkdtemp(path.join(os.tmpdir(), "codex-archiver-index-test-"));
  const codexHome = path.join(root, ".codex");
  const indexPath = path.join(root, "cache", "index.sqlite");
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  await mkdir(path.join(codexHome, "sessions", "2026", "07", "01"), { recursive: true });
  await mkdir(path.join(codexHome, "archived_sessions"), { recursive: true });

  const activePath = path.join(
    codexHome,
    "sessions",
    "2026",
    "07",
    "01",
    "rollout-active-thread.jsonl",
  );
  const archivedPath = path.join(codexHome, "archived_sessions", "rollout-archived.jsonl");

  await writeJsonl(activePath, [
    {
      timestamp: "2026-07-01T10:00:00.000Z",
      type: "session_meta",
      payload: { id: "active-thread", cwd: "/tmp/project-a" },
    },
    {
      timestamp: "2026-07-01T10:00:01.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "developer",
        content: [{ type: "input_text", text: "developer-only needle" }],
      },
    },
    {
      timestamp: "2026-07-01T10:00:02.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "restore pineapple archive thread" }],
      },
    },
    {
      timestamp: "2026-07-01T10:00:03.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "pineapple response" }],
      },
    },
  ]);

  await writeJsonl(archivedPath, [
    {
      timestamp: "2026-06-01T10:00:00.000Z",
      type: "session_meta",
      payload: { id: "archived-thread", cwd: "/tmp/project-b" },
    },
    {
      timestamp: "2026-06-01T10:00:01.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "old grape conversation" }],
      },
    },
  ]);

  createSqliteState(codexHome, [
    {
      id: "active-thread",
      title: "Budget Planning",
      cwd: "/tmp/project-a",
      updated_at: 1782900005,
      created_at: 1782900000,
      archived: 0,
      rollout_path: activePath,
    },
    {
      id: "archived-thread",
      title: "Old Archive",
      cwd: "/tmp/project-b",
      updated_at: 1780317601,
      created_at: 1780317600,
      archived: 1,
      rollout_path: archivedPath,
    },
  ]);

  const meta = await rebuildSearchIndex({ codexHome, indexPath });
  assert.equal(meta.stats.totalThreads, 2);
  assert.equal(meta.stats.activeThreads, 1);
  assert.equal(meta.indexPath, indexPath);
  assert(meta.sourceFingerprint);

  const indexMode = (await stat(indexPath)).mode & 0o777;
  const indexDirMode = (await stat(path.dirname(indexPath))).mode & 0o777;
  assert.equal(indexMode, 0o600);
  assert.equal(indexDirMode, 0o700);

  const status = await readSearchIndexMeta({ codexHome, indexPath });
  assert.equal(status.rebuiltAt, meta.rebuiltAt);
  assert.equal(status.sourceFingerprint, meta.sourceFingerprint);
  assert.equal(status.stats.archivedThreads, 1);

  const reused = await searchThreads({ codexHome, indexPath }, { title: "budget" });
  assert.equal(reused.scannedAt, meta.rebuiltAt);

  const title = await searchThreads({ codexHome, indexPath }, { title: "budget" });
  assert.deepEqual(
    title.threads.map((thread) => thread.id),
    ["active-thread"],
  );

  const content = await searchThreads({ codexHome, indexPath }, { content: "pineapple" });
  assert.deepEqual(
    content.threads.map((thread) => thread.id),
    ["active-thread"],
  );

  const project = await searchThreads({ codexHome, indexPath }, { cwd: "project-b" });
  assert.deepEqual(
    project.threads.map((thread) => thread.id),
    ["archived-thread"],
  );

  const archived = await searchThreads({ codexHome, indexPath }, { status: "archived" });
  assert.deepEqual(
    archived.threads.map((thread) => thread.id),
    ["archived-thread"],
  );

  const developerNoise = await searchThreads(
    { codexHome, indexPath },
    { content: "developer-only" },
  );
  assert.equal(developerNoise.threads.length, 0);

  const paged = await searchThreads({ codexHome, indexPath }, { limit: 1, offset: 1 });
  assert.equal(paged.totalMatches, 2);
  assert.equal(paged.limit, 1);
  assert.equal(paged.offset, 1);
  assert.equal(paged.threads.length, 1);

  const projectDesc = await searchThreads(
    { codexHome, indexPath },
    { sort: "project", direction: "desc" },
  );
  assert.deepEqual(
    projectDesc.threads.map((thread) => thread.id),
    ["archived-thread", "active-thread"],
  );

  const statusDesc = await searchThreads(
    { codexHome, indexPath },
    { sort: "status", direction: "desc" },
  );
  assert.deepEqual(
    statusDesc.threads.map((thread) => thread.id),
    ["archived-thread", "active-thread"],
  );

  const messagesDesc = await searchThreads(
    { codexHome, indexPath },
    { sort: "messages", direction: "desc" },
  );
  assert.deepEqual(
    messagesDesc.threads.map((thread) => thread.id),
    ["active-thread", "archived-thread"],
  );

  const detail = await readThreadDetail({ codexHome, indexPath }, "active-thread");
  assert(detail);
  assert.equal(detail.thread.id, "active-thread");
  assert.deepEqual(
    detail.messages.map((message) => [message.role, message.text]),
    [
      ["user", "restore pineapple archive thread"],
      ["assistant", "pineapple response"],
    ],
  );
  assert.equal(await readThreadDetail({ codexHome, indexPath }, "does-not-exist"), null);

  await assert.rejects(
    searchThreads({ codexHome, indexPath }, { status: "archive" as never }),
    /Invalid status filter/,
  );

  await writeFile(activePath, "\n", { flag: "a" });
  const cached = await searchCachedThreads({ codexHome, indexPath }, { title: "budget" });
  assert.equal(cached.scannedAt, meta.rebuiltAt);

  const rebuilt = await searchThreads({ codexHome, indexPath }, { title: "budget" });
  assert.notEqual(rebuilt.scannedAt, meta.rebuiltAt);

  const cleared = await clearSearchIndex({ codexHome, indexPath });
  assert.equal(cleared.rebuiltAt, null);
  await assert.rejects(stat(indexPath));
});

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
