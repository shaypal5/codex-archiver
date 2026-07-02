import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { access, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { applyRestorePlan, createRestorePlan } from "./restore.js";
import { createRequestHandler } from "./server.js";

test("restore planner classifies explicit selections without mutating codex home", async (t) => {
  if (!hasSqliteCli()) {
    t.skip("sqlite3 CLI is required for restore planner tests");
    return;
  }

  const fixture = await createFixture(t);
  const before = await snapshotFiles(fixture.codexHome);
  const plan = await createRestorePlan({
    codexHome: fixture.codexHome,
    indexPath: fixture.indexPath,
    selectedThreadIds: [
      "archived-thread",
      "restorable-thread",
      "hidden-thread",
      "missing-thread",
      "active-thread",
      "unknown-thread",
    ],
    processDetector: async () => ({
      status: "checked",
      processes: [],
      evidence: ["mock process table checked"],
    }),
    now: new Date("2026-07-02T10:00:00.000Z"),
  });
  const after = await snapshotFiles(fixture.codexHome);

  assert.deepEqual(after, before);
  assert.equal(plan.readOnly, true);
  assert.equal(plan.mutationAllowed, false);
  assert.equal(plan.impactPreview.wouldMutateCodexHome, false);
  assert.equal(plan.impactPreview.wouldCreateBackups, false);
  assert.equal(plan.backupPreview.createdByThisPlan, false);
  assert.equal(plan.preflight.processCheckMode, "warn");
  assert.equal(plan.preflight.summary.failed, 2);
  assert.equal(plan.preflight.summary.passed, 2);
  assert.equal(plan.preflight.summary.warning, 0);
  assert.equal(plan.preflight.summary.unknown, 0);
  assert.equal(plan.impactPreview.selectedCount, 6);
  assert.equal(plan.impactPreview.futureApplyCount, 2);
  assert.equal(plan.impactPreview.diagnosticOnlyCount, 1);
  assert.equal(plan.impactPreview.blockedCount, 1);
  assert.equal(plan.impactPreview.noopCount, 1);
  assert.equal(plan.impactPreview.rejectedCount, 1);

  assertItem(plan, "archived-thread", "archived-sqlite-thread", "future-apply");
  assertItem(plan, "restorable-thread", "jsonl-only-archived-thread", "future-apply");
  assertItem(plan, "hidden-thread", "ui-hidden-active-thread", "diagnostic-only");
  assertItem(plan, "missing-thread", "missing-rollout-source", "blocked");
  assertItem(plan, "active-thread", "already-active", "no-op");
  assertItem(plan, "unknown-thread", "not-found", "rejected");

  const missing = plan.items.find((item) => item.threadId === "missing-thread");
  assert(missing);
  assert.deepEqual(missing.backupPreview, []);

  const active = plan.items.find((item) => item.threadId === "active-thread");
  assert(active);
  assert(active.reasons.some((reason) => reason.includes("visibility diagnostics")));

  const archived = plan.items.find((item) => item.threadId === "archived-thread");
  assert(archived);
  assert.equal(archived.evidence.sqlitePresent, true);
  assert.equal(archived.evidence.hasArchivedRolloutPath, true);
  assert(archived.backupPreview.some((target) => target.endsWith("state_5.sqlite")));
  assert(archived.mutationPreview.some((target) => target.endsWith("session_index.jsonl")));
  assert(archived.plannedPaths.some((target) => target.kind === "active-session-target"));

  const stateBackup = plan.backupPreview.targets.find((target) => target.sourcePath.endsWith("state_5.sqlite"));
  assert(stateBackup);
  assert.equal(stateBackup.exists, true);
  assert.equal(stateBackup.hashStatus, "sha256");
  assert.match(stateBackup.sha256 ?? "", /^[a-f0-9]{64}$/);
  assert(!plan.backupPreview.targets.some((target) => target.sourcePath.endsWith("active.jsonl")));
  assert(plan.backupPreview.plannedBackupRoot.includes("restore-2026-07-02T10-00-00-000Z-"));
  assert.equal(plan.reportPreview.readOnlyPreview, true);
  assert.equal(plan.reportPreview.wouldWriteReport, false);
  assert.match(plan.reportPreview.planHash, /^[a-f0-9]{64}$/);
  assert.match(plan.reportPreview.confirmationToken, /^restore-[a-f0-9]{16}$/);
  assert(plan.reportPreview.requiredFields.includes("backupManifest"));
});

test("restore planner reports process preflight warnings and strict failures without mutation", async (t) => {
  if (!hasSqliteCli()) {
    t.skip("sqlite3 CLI is required for restore planner tests");
    return;
  }

  const fixture = await createFixture(t);
  const detector = async () => ({
    status: "checked" as const,
    processes: [{ pid: 123, command: "/Applications/Codex.app/Contents/MacOS/Codex", matchedBy: "Codex Desktop" }],
    evidence: ["mock process table checked"],
  });

  const warningPlan = await createRestorePlan({
    codexHome: fixture.codexHome,
    indexPath: fixture.indexPath,
    selectedThreadIds: ["archived-thread"],
    processDetector: detector,
  });
  assert.equal(
    warningPlan.preflight.checks.find((check) => check.id === "codex-processes-closed")?.status,
    "warning",
  );

  const strictPlan = await createRestorePlan({
    codexHome: fixture.codexHome,
    indexPath: fixture.indexPath,
    selectedThreadIds: ["archived-thread"],
    processCheckMode: "strict",
    processDetector: detector,
  });
  const check = strictPlan.preflight.checks.find((candidate) => candidate.id === "codex-processes-closed");
  assert.equal(check?.status, "failed");
  assert.equal(check?.blocking, true);
});

test("restore planner flags active target conflicts for future apply candidates", async (t) => {
  if (!hasSqliteCli()) {
    t.skip("sqlite3 CLI is required for restore planner tests");
    return;
  }

  const fixture = await createFixture(t, { withTargetConflict: true });
  const plan = await createRestorePlan({
    codexHome: fixture.codexHome,
    indexPath: fixture.indexPath,
    selectedThreadIds: ["archived-thread"],
    processDetector: async () => ({
      status: "checked",
      processes: [],
      evidence: ["mock process table checked"],
    }),
  });

  const conflictCheck = plan.preflight.checks.find((check) => check.id === "target-path-conflicts");
  assert.equal(conflictCheck?.status, "failed");
  assert.equal(conflictCheck?.blocking, true);
  const archived = plan.items.find((item) => item.threadId === "archived-thread");
  assert(archived?.validations.some((validation) => validation.id === "target-path-conflict"));
  assert(plan.backupPreview.targets.some((target) => target.kind === "active-session-target" && target.exists));
});

test("restore plan CLI returns dry-run JSON for selected ids", async (t) => {
  if (!hasSqliteCli()) {
    t.skip("sqlite3 CLI is required for restore CLI tests");
    return;
  }

  const fixture = await createFixture(t);
  const stdout = execFileSync(
    process.execPath,
    [
      path.resolve("dist/cli.js"),
      "restore",
      "plan",
      "archived-thread",
      "--ids",
      "hidden-thread,unknown-thread",
      "--codex-home",
      fixture.codexHome,
      "--index-path",
      fixture.indexPath,
      "--json",
      "--skip-process-check",
    ],
    { encoding: "utf8" },
  );
  const parsed = JSON.parse(stdout) as {
    readOnly?: boolean;
    mutationAllowed?: boolean;
    selectedThreadIds?: string[];
    items?: Array<{ threadId: string; classification: string }>;
    preflight?: { processCheckMode: string; checks: Array<{ id: string; status: string }> };
  };
  assert.equal(parsed.readOnly, true);
  assert.equal(parsed.mutationAllowed, false);
  assert.deepEqual(parsed.selectedThreadIds, ["archived-thread", "hidden-thread", "unknown-thread"]);
  assert.equal(parsed.items?.find((item) => item.threadId === "hidden-thread")?.classification, "ui-hidden-active-thread");
  assert.equal(parsed.preflight?.processCheckMode, "skip");
  assert.equal(parsed.preflight?.checks.find((check) => check.id === "codex-processes-closed")?.status, "unknown");
});

test("restore plan API requires local intent guard for POST and returns dry-run plan", async (t) => {
  if (!hasSqliteCli()) {
    t.skip("sqlite3 CLI is required for restore API tests");
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
  const url = `http://127.0.0.1:${address.port}/api/restore/plan`;
  const body = JSON.stringify({ selectedThreadIds: ["archived-thread"], processCheck: "skip" });

  const missingIntent = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  assert.equal(missingIntent.status, 403);

  const externalOrigin = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Codex-Archiver-Intent": "local-api",
      Origin: "https://example.com",
    },
    body,
  });
  assert.equal(externalOrigin.status, 403);

  const invalidJson = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Codex-Archiver-Intent": "local-api",
    },
    body: "{",
  });
  assert.equal(invalidJson.status, 400);

  const invalidProcessCheck = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Codex-Archiver-Intent": "local-api",
    },
    body: JSON.stringify({ selectedThreadIds: ["archived-thread"], processCheck: "enforce" }),
  });
  assert.equal(invalidProcessCheck.status, 400);

  const accepted = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Codex-Archiver-Intent": "local-api",
      Origin: "http://127.0.0.1",
    },
    body,
  });
  assert.equal(accepted.status, 200);
  const plan = (await accepted.json()) as {
    readOnly?: boolean;
    mutationAllowed?: boolean;
    items?: Array<{ threadId: string; actionability: string }>;
    preflight?: { processCheckMode: string };
    backupPreview?: { targets: Array<{ sourcePath: string; exists: boolean }> };
    reportPreview?: { requiredFields: string[] };
  };
  assert.equal(plan.readOnly, true);
  assert.equal(plan.mutationAllowed, false);
  assert.equal(plan.items?.[0]?.threadId, "archived-thread");
  assert.equal(plan.items?.[0]?.actionability, "future-apply");
  assert.equal(plan.preflight?.processCheckMode, "skip");
  assert(plan.backupPreview?.targets.some((target) => target.sourcePath.endsWith("state_5.sqlite") && target.exists));
  assert(plan.reportPreview?.requiredFields.includes("mutations"));
});

test("restore apply requires confirmation and does not mutate codex home without it", async (t) => {
  if (!hasSqliteCli()) {
    t.skip("sqlite3 CLI is required for restore apply tests");
    return;
  }

  const fixture = await createFixture(t);
  const before = await snapshotFiles(fixture.codexHome);
  const report = await applyRestorePlan({
    codexHome: fixture.codexHome,
    indexPath: fixture.indexPath,
    selectedThreadIds: ["archived-thread"],
    processDetector: async () => ({
      status: "checked",
      processes: [],
      evidence: ["mock process table checked"],
    }),
    now: new Date("2026-07-02T12:00:00.000Z"),
  });
  const after = await snapshotFiles(fixture.codexHome);

  assert.deepEqual(after, before);
  assert.equal(report.result.status, "blocked");
  assert.match(report.result.message, /Confirmation did not match/);
  assert.equal(report.backupManifest.targets.length, 0);
});

test("restore apply backs up, mutates archived SQLite thread, reports, and verifies", async (t) => {
  if (!hasSqliteCli()) {
    t.skip("sqlite3 CLI is required for restore apply tests");
    return;
  }

  const fixture = await createFixture(t);
  const plan = await createRestorePlan({
    codexHome: fixture.codexHome,
    indexPath: fixture.indexPath,
    selectedThreadIds: ["archived-thread", "hidden-thread", "restorable-thread"],
    processDetector: async () => ({
      status: "checked",
      processes: [],
      evidence: ["mock process table checked"],
    }),
    now: new Date("2026-07-02T12:10:00.000Z"),
  });
  const report = await applyRestorePlan({
    codexHome: fixture.codexHome,
    indexPath: fixture.indexPath,
    selectedThreadIds: ["archived-thread", "hidden-thread", "restorable-thread"],
    confirmationToken: plan.reportPreview.confirmationToken,
    processDetector: async () => ({
      status: "checked",
      processes: [],
      evidence: ["mock process table checked"],
    }),
    now: new Date("2026-07-02T12:10:00.000Z"),
  });

  assert.equal(report.result.status, "succeeded");
  assert.equal(report.verification.status, "succeeded");
  assert.deepEqual(report.verification.restoredThreadIds, ["archived-thread"]);
  assert(report.items.find((item) => item.threadId === "hidden-thread")?.warnings.length);
  assert(report.items.find((item) => item.threadId === "restorable-thread")?.warnings.length);
  assert(report.backupManifest.targets.some((target) => target.sourcePath.endsWith("state_5.sqlite") && target.exists));
  assert(report.backupManifest.targets.some((target) => target.sourcePath.endsWith("session_index.jsonl") && target.exists));
  assert(report.backupManifest.targets.some((target) => target.sourcePath.endsWith("archived.jsonl") && target.exists));
  assert(await exists(report.backupManifest.manifestPath));
  assert(await exists(report.result.reportPath));

  const activeTarget = path.join(fixture.codexHome, "sessions", "archived.jsonl");
  const archivedSourceBackup = report.backupManifest.targets.find((target) => target.sourcePath.endsWith("archived.jsonl"));
  assert(archivedSourceBackup);
  assert(await exists(archivedSourceBackup.backupPath));
  await assertMtimeClose(archivedSourceBackup.sourcePath, archivedSourceBackup.backupPath);
  await assertMtimeClose(archivedSourceBackup.sourcePath, activeTarget);
  assert.equal((await readFile(activeTarget, "utf8")).includes("archived-thread"), true);
  const rows = readSqliteRows(fixture.codexHome, "archived-thread");
  assert.equal(rows[0]?.archived, 0);
  assert.equal(rows[0]?.rollout_path, activeTarget);
  const sessionIndex = await readFile(path.join(fixture.codexHome, "session_index.jsonl"), "utf8");
  assert.match(sessionIndex, /archived-thread/);
  assert.match(sessionIndex, /sessions\/archived\.jsonl/);
});

test("restore apply blocks on preflight failures before mutation", async (t) => {
  if (!hasSqliteCli()) {
    t.skip("sqlite3 CLI is required for restore apply tests");
    return;
  }

  const fixture = await createFixture(t, { withTargetConflict: true });
  const plan = await createRestorePlan({
    codexHome: fixture.codexHome,
    indexPath: fixture.indexPath,
    selectedThreadIds: ["archived-thread"],
    processDetector: async () => ({
      status: "checked",
      processes: [],
      evidence: ["mock process table checked"],
    }),
  });
  const before = await snapshotFiles(fixture.codexHome);
  const report = await applyRestorePlan({
    codexHome: fixture.codexHome,
    indexPath: fixture.indexPath,
    selectedThreadIds: ["archived-thread"],
    confirmationToken: plan.reportPreview.confirmationToken,
    processDetector: async () => ({
      status: "checked",
      processes: [],
      evidence: ["mock process table checked"],
    }),
  });
  const after = await snapshotFiles(fixture.codexHome);

  assert.deepEqual(after, before);
  assert.equal(report.result.status, "blocked");
  assert.match(report.result.message, /Preflight did not pass/);
  assert.equal(report.backupManifest.targets.length, 0);
});

test("restore apply rolls back file changes when SQLite transaction fails", async (t) => {
  if (!hasSqliteCli()) {
    t.skip("sqlite3 CLI is required for restore apply tests");
    return;
  }

  const fixture = await createFixture(t);
  const plan = await createRestorePlan({
    codexHome: fixture.codexHome,
    indexPath: fixture.indexPath,
    selectedThreadIds: ["archived-thread"],
    processDetector: async () => ({
      status: "checked",
      processes: [],
      evidence: ["mock process table checked"],
    }),
  });
  const before = await snapshotFiles(fixture.codexHome);
  const report = await applyRestorePlan({
    codexHome: fixture.codexHome,
    indexPath: fixture.indexPath,
    selectedThreadIds: ["archived-thread"],
    confirmationToken: plan.reportPreview.confirmationToken,
    processDetector: async () => ({
      status: "checked",
      processes: [],
      evidence: ["mock process table checked"],
    }),
    sqlRunner: async () => {
      throw new Error("simulated sqlite failure");
    },
  });
  const after = await snapshotFiles(fixture.codexHome);

  assert.deepEqual(after, before);
  assert.equal(report.result.status, "failed");
  assert.match(report.result.message, /simulated sqlite failure/);
  assert(report.mutations.some((mutation) => mutation.status === "rolled-back"));
  assert.equal(readSqliteRows(fixture.codexHome, "archived-thread")[0]?.archived, 1);
});

test("restore apply CLI is confirmation-gated", async (t) => {
  if (!hasSqliteCli()) {
    t.skip("sqlite3 CLI is required for restore CLI tests");
    return;
  }

  const fixture = await createFixture(t);
  const before = await snapshotFiles(fixture.codexHome);
  const stdout = execFileSync(
    process.execPath,
    [
      path.resolve("dist/cli.js"),
      "restore",
      "apply",
      "archived-thread",
      "--codex-home",
      fixture.codexHome,
      "--index-path",
      fixture.indexPath,
      "--confirm-token",
      "wrong-token",
      "--skip-process-check",
    ],
    { encoding: "utf8" },
  );
  const report = JSON.parse(stdout) as { result?: { status: string; message: string } };
  const after = await snapshotFiles(fixture.codexHome);

  assert.deepEqual(after, before);
  assert.equal(report.result?.status, "blocked");
  assert.match(report.result?.message ?? "", /Confirmation did not match/);
});

test("restore apply API requires local intent and confirmation before mutation", async (t) => {
  if (!hasSqliteCli()) {
    t.skip("sqlite3 CLI is required for restore API tests");
    return;
  }

  const fixture = await createFixture(t);
  const server = createServer(
    createRequestHandler({
      codexHome: fixture.codexHome,
      indexPath: fixture.indexPath,
      processDetector: async () => ({
        status: "checked",
        processes: [],
        evidence: ["mock process table checked"],
      }),
    }),
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
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const body = JSON.stringify({ selectedThreadIds: ["archived-thread"], processCheck: "warn" });

  const missingIntent = await fetch(`${baseUrl}/api/restore/apply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  assert.equal(missingIntent.status, 403);

  const noConfirmation = await fetch(`${baseUrl}/api/restore/apply`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Codex-Archiver-Intent": "local-api",
    },
    body,
  });
  assert.equal(noConfirmation.status, 200);
  const blocked = (await noConfirmation.json()) as { result?: { status: string } };
  assert.equal(blocked.result?.status, "blocked");

  const planResponse = await fetch(`${baseUrl}/api/restore/plan`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Codex-Archiver-Intent": "local-api",
    },
    body,
  });
  const plan = (await planResponse.json()) as { reportPreview?: { confirmationToken: string } };
  const accepted = await fetch(`${baseUrl}/api/restore/apply`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Codex-Archiver-Intent": "local-api",
      Origin: "http://127.0.0.1",
    },
    body: JSON.stringify({
      selectedThreadIds: ["archived-thread"],
      processCheck: "warn",
      confirmationToken: plan.reportPreview?.confirmationToken,
    }),
  });
  assert.equal(accepted.status, 200);
  const report = (await accepted.json()) as { result?: { status: string }; verification?: { status: string } };
  assert.equal(report.result?.status, "succeeded");
  assert.equal(report.verification?.status, "succeeded");
});

async function createFixture(
  t: TestContext,
  options: { withTargetConflict?: boolean } = {},
): Promise<{ root: string; codexHome: string; indexPath: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-archiver-restore-test-"));
  const codexHome = path.join(root, ".codex");
  const indexPath = path.join(root, "cache", "index.sqlite");
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  await mkdir(path.join(codexHome, "sessions", "2026", "07", "01"), { recursive: true });
  await mkdir(path.join(codexHome, "archived_sessions"), { recursive: true });

  const activePath = path.join(codexHome, "sessions", "2026", "07", "01", "active.jsonl");
  const hiddenPath = path.join(codexHome, "sessions", "2026", "07", "01", "hidden.jsonl");
  const archivedPath = path.join(codexHome, "archived_sessions", "archived.jsonl");
  const restorablePath = path.join(codexHome, "archived_sessions", "restorable.jsonl");
  const missingPath = path.join(codexHome, "sessions", "missing.jsonl");
  const conflictPath = path.join(codexHome, "sessions", "archived.jsonl");

  await writeJsonl(activePath, [
    {
      timestamp: "2026-07-01T10:00:00.000Z",
      type: "session_meta",
      payload: { id: "active-thread", cwd: "/tmp/project-a" },
    },
  ]);
  await writeJsonl(hiddenPath, [
    {
      timestamp: "2026-07-01T10:10:00.000Z",
      type: "session_meta",
      payload: { id: "hidden-thread", cwd: "/tmp/project-hidden" },
    },
  ]);
  await writeJsonl(archivedPath, [
    {
      timestamp: "2026-06-01T10:00:00.000Z",
      type: "session_meta",
      payload: { id: "archived-thread", cwd: "/tmp/project-b" },
    },
  ]);
  await writeJsonl(restorablePath, [
    {
      timestamp: "2026-05-01T10:00:00.000Z",
      type: "session_meta",
      payload: { id: "restorable-thread", cwd: "/tmp/project-c" },
    },
  ]);
  if (options.withTargetConflict) {
    await writeJsonl(conflictPath, [
      {
        timestamp: "2026-06-01T09:00:00.000Z",
        type: "session_meta",
        payload: { id: "conflict-thread", cwd: "/tmp/project-conflict" },
      },
    ]);
  }
  await writeFile(
    path.join(codexHome, "session_index.jsonl"),
    `${JSON.stringify({ payload: { id: "active-thread", rollout_path: activePath } })}\n`,
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
      cwd: "/tmp/project-missing",
      updated_at: 1775037601,
      created_at: 1775037600,
      archived: 0,
      rollout_path: missingPath,
    },
  ]);

  return { root, codexHome, indexPath };
}

function assertItem(
  plan: Awaited<ReturnType<typeof createRestorePlan>>,
  threadId: string,
  classification: string,
  actionability: string,
): void {
  const item = plan.items.find((candidate) => candidate.threadId === threadId);
  assert(item);
  assert.equal(item.classification, classification);
  assert.equal(item.actionability, actionability);
  assert.equal(item.readOnly, true);
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

function readSqliteRows(codexHome: string, threadId: string): Array<{ archived: number; rollout_path: string }> {
  const dbPath = path.join(codexHome, "state_5.sqlite");
  const stdout = execFileSync(
    "sqlite3",
    ["-json", dbPath, `SELECT archived, rollout_path FROM threads WHERE id = ${sqlValue(threadId)};`],
    { encoding: "utf8" },
  );
  return JSON.parse(stdout || "[]") as Array<{ archived: number; rollout_path: string }>;
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

async function snapshotFiles(root: string): Promise<Record<string, string>> {
  const snapshot: Record<string, string> = {};
  for (const filePath of await listFiles(root)) {
    const relative = path.relative(root, filePath);
    const body = await readFile(filePath);
    snapshot[relative] = body.toString("base64");
  }
  return snapshot;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function assertMtimeClose(sourcePath: string, copiedPath: string): Promise<void> {
  const source = await stat(sourcePath);
  const copied = await stat(copiedPath);
  assert(Math.abs(source.mtimeMs - copied.mtimeMs) < 1000);
}

async function listFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(fullPath)));
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }
  return files.sort();
}
