import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { scanCodexStorage } from "./scanner.js";

test("scanner classifies thread storage states and extracts transcript text only", async (t) => {
  if (!hasSqliteCli()) {
    t.skip("sqlite3 CLI is required for scanner integration tests");
    return;
  }

  const codexHome = await mkdtemp(path.join(os.tmpdir(), "codex-archiver-test-"));
  t.after(async () => {
    await rm(codexHome, { recursive: true, force: true });
  });

  await mkdir(path.join(codexHome, "sessions", "2026", "07", "01"), { recursive: true });
  await mkdir(path.join(codexHome, "archived_sessions"), { recursive: true });

  const activePath = path.join(
    codexHome,
    "sessions",
    "2026",
    "07",
    "01",
    "rollout-2026-07-01T10-00-00-active-thread.jsonl",
  );
  const archivedPath = path.join(
    codexHome,
    "archived_sessions",
    "rollout-2026-06-01T10-00-00-archived-thread.jsonl",
  );
  const restorablePath = path.join(
    codexHome,
    "archived_sessions",
    "rollout-2026-05-01T10-00-00-restorable-thread.jsonl",
  );
  const missingPath = path.join(
    codexHome,
    "sessions",
    "2026",
    "04",
    "01",
    "rollout-2026-04-01T10-00-00-missing-thread.jsonl",
  );

  await writeJsonl(activePath, [
    {
      timestamp: "2026-07-01T10:00:00.000Z",
      type: "session_meta",
      payload: {
        id: "active-thread",
        timestamp: "2026-07-01T10:00:00.000Z",
        cwd: "/tmp/project-a",
        base_instructions: "base instructions should not be searchable",
      },
    },
    {
      timestamp: "2026-07-01T10:00:01.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "developer",
        content: [{ type: "input_text", text: "developer text should not be searchable" }],
      },
    },
    {
      timestamp: "2026-07-01T10:00:02.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "# AGENTS.md instructions\nskip injected context" }],
      },
    },
    {
      timestamp: "2026-07-01T10:00:03.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "<environment_context>\nskip environment" }],
      },
    },
    {
      timestamp: "2026-07-01T10:00:04.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "find archived budget thread" }],
      },
    },
    {
      timestamp: "2026-07-01T10:00:05.000Z",
      type: "response_item",
      payload: {
        type: "function_call",
        name: "shell",
        arguments: "tool call should not be searchable",
      },
    },
    {
      timestamp: "2026-07-01T10:00:06.000Z",
      type: "event_msg",
      payload: {
        type: "agent_message",
        message: "event message should not be searchable",
      },
    },
    {
      timestamp: "2026-07-01T10:00:07.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "I found the archived budget thread." }],
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
        content: [{ type: "input_text", text: "archived question" }],
      },
    },
  ]);

  await writeJsonl(restorablePath, [
    {
      timestamp: "2026-05-01T10:00:00.000Z",
      type: "session_meta",
      payload: { id: "restorable-thread", cwd: "/tmp/project-c" },
    },
    {
      timestamp: "2026-05-01T10:00:01.000Z",
      type: "event_msg",
      payload: { type: "thread_name", thread_name: "Restorable from JSONL" },
    },
  ]);

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
      cwd: "/tmp/project-d",
      updated_at: 1775037601,
      created_at: 1775037600,
      archived: 0,
      rollout_path: missingPath,
    },
  ]);

  const result = await scanCodexStorage(codexHome);

  assert.equal(result.stats.totalThreads, 4);
  assert.equal(result.stats.totalProjects, 4);
  assert.equal(result.stats.activeThreads, 1);
  assert.equal(result.stats.archivedThreads, 1);
  assert.equal(result.stats.orphanedThreads, 1);

  const active = result.threads.find((thread) => thread.id === "active-thread");
  assert(active);
  assert.equal(active.restoreStatus, "active");
  assert.equal(active.messageCount, 2);
  assert.match(active.contentPreview, /find archived budget thread/);
  assert.match(active.contentPreview, /I found the archived budget thread/);
  assert.doesNotMatch(active.contentPreview, /base instructions/);
  assert.doesNotMatch(active.contentPreview, /developer text/);
  assert.doesNotMatch(active.contentPreview, /injected context/);
  assert.doesNotMatch(active.contentPreview, /environment/);
  assert.doesNotMatch(active.contentPreview, /tool call/);
  assert.doesNotMatch(active.contentPreview, /event message/);

  assert.equal(
    result.threads.find((thread) => thread.id === "archived-thread")?.restoreStatus,
    "archived",
  );
  assert.equal(
    result.threads.find((thread) => thread.id === "restorable-thread")?.restoreStatus,
    "restorable",
  );
  assert.equal(
    result.threads.find((thread) => thread.id === "missing-thread")?.restoreStatus,
    "orphaned",
  );
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
