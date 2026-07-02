import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { rebuildSearchIndex } from "./indexer.js";
import { defaultCodexHome, defaultIndexPath, expandHome } from "./paths.js";
import { scanCodexStorage } from "./scanner.js";
import { runSql, sqlValue } from "./sqlite.js";
import type {
  Diagnostic,
  RestoreApplyBackupManifest,
  RestoreApplyItemReport,
  RestoreApplyMutation,
  RestoreApplyOptions,
  RestoreApplyReport,
  RestoreApplyResultStatus,
  RestoreUndoReport,
  RestoreUndoRestoredFile,
  RestoreUndoSafetyBackup,
  RestoreUndoTarget,
  RestorePlan,
  RestorePlanActionability,
  RestorePlanBackupPreview,
  RestorePlanBackupTarget,
  RestorePlanClassification,
  RestorePlanEvidence,
  RestorePlanImpactPreview,
  RestorePlanItem,
  RestorePlanPlannedPath,
  RestorePlanPreflight,
  RestorePlanPreflightCheck,
  RestorePlanReportPreview,
  RestorePlanValidation,
  RestorePreflightStatus,
  RestoreProcessCheckMode,
  ThreadRecord,
} from "./types.js";

export interface RestorePlanOptions {
  codexHome?: string;
  indexPath?: string;
  selectedThreadIds: string[];
  processCheckMode?: RestoreProcessCheckMode;
  processDetector?: CodexProcessDetector;
  now?: Date;
}

export interface RestoreApplyInternalOptions extends RestoreApplyOptions {
  processDetector?: CodexProcessDetector;
  now?: Date;
  sqlRunner?: (dbPath: string, sql: string) => Promise<void>;
}

export interface RestoreUndoInternalOptions {
  codexHome?: string;
  indexPath?: string;
  reportPath?: string;
  backupRoot?: string;
  confirmationToken?: string;
  confirmationPhrase?: string;
  processCheckMode?: RestoreProcessCheckMode;
  processDetector?: CodexProcessDetector;
  now?: Date;
}

export interface CodexProcessDetection {
  status: "checked" | "unavailable";
  processes: CodexProcessInfo[];
  evidence: string[];
  error?: string;
}

export interface CodexProcessInfo {
  pid: number | null;
  command: string;
  matchedBy: string;
}

export type CodexProcessDetector = () => Promise<CodexProcessDetection>;

const STATE_DB = "state_5.sqlite";
const SESSION_INDEX = "session_index.jsonl";
const HASH_MAX_BYTES = 8 * 1024 * 1024;
const execFileAsync = promisify(execFile);

export async function createRestorePlan(options: RestorePlanOptions): Promise<RestorePlan> {
  const codexHome = path.resolve(expandHome(options.codexHome ?? defaultCodexHome()));
  const indexPath = path.resolve(expandHome(options.indexPath ?? defaultIndexPath()));
  const selectedThreadIds = normalizeSelectedThreadIds(options.selectedThreadIds);
  const scan = await scanCodexStorage(codexHome);
  return createRestorePlanFromThreads({
    codexHome,
    indexPath,
    diagnostics: scan.diagnostics,
    threads: scan.threads,
    selectedThreadIds,
    processCheckMode: options.processCheckMode ?? "warn",
    processDetector: options.processDetector,
    now: options.now,
  });
}

export async function createRestorePlanFromThreads(input: {
  codexHome: string;
  indexPath: string;
  diagnostics?: Diagnostic[];
  threads: ThreadRecord[];
  selectedThreadIds: string[];
  processCheckMode?: RestoreProcessCheckMode;
  processDetector?: CodexProcessDetector;
  now?: Date;
}): Promise<RestorePlan> {
  const codexHome = path.resolve(input.codexHome);
  const indexPath = path.resolve(input.indexPath);
  const selectedThreadIds = normalizeSelectedThreadIds(input.selectedThreadIds);
  const generatedAt = (input.now ?? new Date()).toISOString();
  const byId = new Map(input.threads.map((thread) => [thread.id, thread]));
  const items = selectedThreadIds.map((threadId) =>
    planThread({ codexHome, indexPath, threadId, thread: byId.get(threadId) }),
  );
  const backupRoot = plannedBackupRoot(indexPath, generatedAt, selectedThreadIds);
  const backupPreview = buildBackupPreview(codexHome, indexPath, backupRoot, items);
  const preflight = await buildPreflight({
    items,
    processCheckMode: input.processCheckMode ?? "warn",
    processDetector: input.processDetector ?? detectCodexProcesses,
  });
  const planHash = stablePlanHash({ codexHome, indexPath, selectedThreadIds, items, backupPreview, preflight });
  const reportPreview = buildReportPreview(backupRoot, planHash);

  return {
    codexHome,
    indexPath,
    generatedAt,
    selectedThreadIds,
    readOnly: true,
    mutationAllowed: false,
    diagnostics: input.diagnostics ?? [],
    impactPreview: buildImpactPreview(items),
    preflight,
    backupPreview,
    reportPreview,
    items,
  };
}

export async function applyRestorePlan(options: RestoreApplyInternalOptions): Promise<RestoreApplyReport> {
  const codexHome = path.resolve(expandHome(options.codexHome ?? defaultCodexHome()));
  const indexPath = path.resolve(expandHome(options.indexPath ?? defaultIndexPath()));
  const selectedThreadIds = normalizeSelectedThreadIds(options.selectedThreadIds);
  const startedAt = (options.now ?? new Date()).toISOString();
  const operationId = `restore-apply-${startedAt.replaceAll(/[:.]/g, "-")}`;
  const plan = await createRestorePlan({
    codexHome,
    indexPath,
    selectedThreadIds,
    processCheckMode: options.processCheckMode ?? "warn",
    processDetector: options.processDetector,
    now: options.now,
  });
  const planHash = plan.reportPreview.planHash;
  const confirmationToken = plan.reportPreview.confirmationToken;
  const backupRoot = plan.backupPreview.plannedBackupRoot;
  const reportPath = path.join(backupRoot, "restore-report.json");
  const manifestPath = path.join(backupRoot, "backup-manifest.json");
  const mutations: RestoreApplyMutation[] = [];
  const cleanupActions: Array<() => Promise<void>> = [];
  let backupManifest: RestoreApplyBackupManifest = {
    backupRoot,
    manifestPath,
    createdAt: startedAt,
    targets: [],
  };

  const applyableItems = plan.items.filter((item) => item.classification === "archived-sqlite-thread");
  const itemReports = plan.items.map((item): RestoreApplyItemReport => ({
    threadId: item.threadId,
    classification: item.classification,
    actionability: item.actionability,
    selectedForApply: applyableItems.includes(item),
    sourcePaths: item.evidence.sourcePaths,
    plannedMutations: plannedMutationKinds(item),
    appliedMutations: [],
    warnings: item.classification === "archived-sqlite-thread"
      ? []
      : [`M4 apply skips ${item.classification}; it only mutates archived SQLite threads with archived JSONL evidence.`],
    errors: [],
  }));

  function itemReport(threadId: string): RestoreApplyItemReport | undefined {
    return itemReports.find((item) => item.threadId === threadId);
  }

  function recordMutation(mutation: RestoreApplyMutation): void {
    mutations.push(mutation);
    itemReport(mutation.threadId)?.appliedMutations.push(mutation);
  }

  async function writeReport(status: RestoreApplyResultStatus, message: string): Promise<RestoreApplyReport> {
    const verification = status === "succeeded" || status === "partial"
      ? await verifyApply({ codexHome, applyableItems, startedAt })
      : {
          status,
          checkedAt: new Date().toISOString(),
          restoredThreadIds: [],
          failedThreadIds: applyableItems.map((item) => item.threadId),
          diagnostics: [],
          evidence: [message],
        };
    const finalStatus = status === "succeeded" && verification.status !== "succeeded" ? verification.status : status;
    const resultMessage = finalStatus === "succeeded"
      ? "Restore apply completed and verification passed."
      : status === "succeeded"
        ? `Restore apply mutations completed, but verification finished with status ${verification.status}.`
        : message;
    const report: RestoreApplyReport = {
      schemaVersion: 1,
      reportType: "restore-apply-report",
      operationId,
      startedAt,
      completedAt: new Date().toISOString(),
      codexHome,
      indexPath,
      selectedThreadIds,
      planHash,
      confirmationToken,
      preflight: plan.preflight,
      backupManifest,
      items: itemReports,
      mutations,
      verification,
      result: {
        status: finalStatus,
        message: resultMessage,
        reportPath,
        backupRoot,
      },
      nextUserSteps: nextUserSteps(finalStatus, reportPath, backupRoot),
      limits: [
        "M4 apply only supports archived SQLite threads with existing archived JSONL evidence.",
        "JSONL-only archived threads and UI-hidden active threads remain diagnostic-only until later milestones.",
        "Undo/restore-from-backup is documented in the report but implemented in a later milestone.",
      ],
    };
    await mkdir(backupRoot, { recursive: true, mode: 0o700 });
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    return report;
  }

  if (selectedThreadIds.length === 0) {
    return writeReport("blocked", "restore apply requires at least one selected thread id.");
  }

  if (!confirmationMatches(options, confirmationToken, plan.reportPreview.confirmationPhrase)) {
    return writeReport(
      "blocked",
      `Confirmation did not match. Re-run restore plan and pass --confirm-token ${confirmationToken}.`,
    );
  }

  const blockingChecks = plan.preflight.checks.filter((check) => check.status !== "passed" || check.blocking);
  if (blockingChecks.length > 0) {
    return writeReport("blocked", "Preflight did not pass; no Codex state was mutated.");
  }

  if (applyableItems.length === 0) {
    return writeReport("blocked", "No selected threads are supported by M4 restore apply.");
  }

  try {
    backupManifest = await createBackups(plan, backupRoot, manifestPath);

    for (const item of applyableItems) {
      const sourcePath = archivedSourcePath(item);
      const activeTargetPath = activeTargetPathFor(item);
      if (!sourcePath || !activeTargetPath) {
        itemReport(item.threadId)?.errors.push("Missing archived source or active target path.");
        throw new Error(`Cannot derive active target path for ${item.threadId}.`);
      }

      await copyRolloutForApply(sourcePath, activeTargetPath, item.threadId, recordMutation, cleanupActions);
    }

    await updateSessionIndexForApply(codexHome, applyableItems, recordMutation, cleanupActions);
    await updateSqliteForApply(
      codexHome,
      applyableItems,
      options.sqlRunner ?? runSql,
      recordMutation,
    );
    await rebuildSearchIndex({ codexHome, indexPath });
    for (const item of applyableItems) {
      recordMutation({
        threadId: item.threadId,
        kind: "rebuild-search-index",
        targetPath: indexPath,
        status: "applied",
        message: "Rebuilt the derived codex-archiver search index after restore apply.",
      });
    }
  } catch (error) {
    await rollbackCleanup(cleanupActions, mutations);
    const message = `Restore apply failed before successful verification: ${errorMessage(error)}`;
    for (const item of applyableItems) {
      itemReport(item.threadId)?.errors.push(message);
    }
    return writeReport("failed", message);
  }

  return writeReport("succeeded", "Restore apply completed.");
}

export async function undoRestoreApply(options: RestoreUndoInternalOptions): Promise<RestoreUndoReport> {
  const codexHome = path.resolve(expandHome(options.codexHome ?? defaultCodexHome()));
  const indexPath = path.resolve(expandHome(options.indexPath ?? defaultIndexPath()));
  const startedAt = (options.now ?? new Date()).toISOString();
  const operationId = `restore-undo-${startedAt.replaceAll(/[:.]/g, "-")}`;
  const resolvedInput = resolveUndoInput(options);
  const reportPath = resolvedInput.reportPath;
  const backupRoot = resolvedInput.backupRoot;
  const safetyRoot = path.join(backupRoot, "rollback-safety", operationId);
  const undoReportPath = path.join(safetyRoot, "restore-undo-report.json");
  const restoredFiles: RestoreUndoRestoredFile[] = [];
  let safetyBackup: RestoreUndoSafetyBackup | null = null;

  let sourceReport: RestoreApplyReport | null = null;
  let backupManifest: RestoreApplyBackupManifest | null = null;
  let manifestPath = path.join(backupRoot, "backup-manifest.json");
  let targets: RestoreUndoTarget[] = [];

  const readErrors: string[] = [];
  try {
    sourceReport = readJsonFile<RestoreApplyReport>(reportPath);
    manifestPath = path.resolve(sourceReport.backupManifest.manifestPath);
    backupManifest = readJsonFile<RestoreApplyBackupManifest>(manifestPath);
    targets = buildUndoTargets({ codexHome, indexPath, backupRoot, manifest: backupManifest, sourceReport });
  } catch (error) {
    readErrors.push(errorMessage(error));
  }

  const confirmationToken = confirmationTokenForUndo({
    reportPath,
    backupRoot,
    operationId: sourceReport?.operationId ?? "unreadable",
    targets,
  });
  const confirmationPhrase = `undo restore ${confirmationToken}`;
  const preflight = await buildPreflight({
    items: [],
    processCheckMode: options.processCheckMode ?? "warn",
    processDetector: options.processDetector ?? detectCodexProcesses,
  });
  const validation = buildUndoValidation({
    codexHome,
    indexPath,
    reportPath,
    backupRoot,
    manifestPath,
    sourceReport,
    backupManifest,
    targets,
    readErrors,
  });

  function sourceApplyReportSummary(): RestoreUndoReport["sourceApplyReport"] {
    return {
      operationId: sourceReport?.operationId ?? "unreadable",
      reportPath,
      resultStatus: sourceReport?.result.status ?? "failed",
      selectedThreadIds: sourceReport?.selectedThreadIds ?? [],
    };
  }

  async function writeUndoReport(status: RestoreUndoReport["result"]["status"], message: string): Promise<RestoreUndoReport> {
    const verification = status === "succeeded"
      ? await verifyUndo({ codexHome, targets })
      : {
          status,
          checkedAt: new Date().toISOString(),
          restoredFiles: [],
          failedFiles: status === "preview" ? [] : targets.map((target) => target.sourcePath),
          diagnostics: [],
          evidence: [message],
        };
    const finalStatus = status === "succeeded" && verification.status !== "succeeded" ? verification.status : status;
    const report: RestoreUndoReport = {
      schemaVersion: 1,
      reportType: "restore-undo-report",
      operationId,
      startedAt,
      completedAt: new Date().toISOString(),
      codexHome,
      indexPath,
      input: {
        reportPath,
        backupRoot,
        manifestPath,
      },
      sourceApplyReport: sourceApplyReportSummary(),
      readOnly: finalStatus === "preview" || finalStatus === "blocked",
      mutationAllowed: finalStatus === "succeeded" || finalStatus === "failed",
      confirmationToken,
      confirmationPhrase,
      preflight,
      validation,
      targets,
      restoredFiles,
      safetyBackup,
      verification,
      result: {
        status: finalStatus,
        message,
        reportPath: finalStatus === "preview" || finalStatus === "blocked" ? undoReportPath : undoReportPath,
        backupRoot,
      },
      nextUserSteps: nextUndoUserSteps(finalStatus, undoReportPath, safetyRoot),
      limits: [
        "M4 undo restores files that PR #7 apply backed up in backup-manifest.json.",
        "Undo rejects backup/report path traversal, backup hash mismatches, and target paths outside the Codex home or configured search index.",
        "Undo rebuilds the derived search index after restore, but it does not inspect Codex Desktop UI state directly.",
      ],
    };
    if (finalStatus !== "preview" && safetyBackup !== null) {
      await mkdir(path.dirname(undoReportPath), { recursive: true, mode: 0o700 });
      await writeFile(undoReportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    }
    return report;
  }

  if (!options.reportPath && !options.backupRoot) {
    return writeUndoReport("blocked", "restore undo requires --report or --backup-root.");
  }

  if (hasBlockingChecks(validation)) {
    return writeUndoReport("blocked", "Restore undo validation blocked mutation.");
  }

  if (!confirmationMatchesUndo(options, confirmationToken, confirmationPhrase)) {
    return writeUndoReport(
      "preview",
      `Dry-run only. Re-run restore undo with --confirm-token ${confirmationToken} or --confirm-phrase "${confirmationPhrase}" to apply.`,
    );
  }

  if (hasBlockingChecks(preflight)) {
    return writeUndoReport("blocked", "Restore undo preflight blocked mutation.");
  }

  try {
    safetyBackup = await createUndoSafetyBackup({
      codexHome,
      indexPath,
      safetyRoot,
      targets,
      startedAt,
    });

    for (const target of targets) {
      if (target.action === "skip-missing-original") {
        restoredFiles.push({
          sourcePath: target.sourcePath,
          backupPath: target.backupPath,
          safetyBackupPath: null,
          status: "skipped",
          message: "Manifest target did not exist when apply ran, so undo leaves it absent.",
        });
        continue;
      }
      if (target.action === "remove-created-file") {
        await rm(target.sourcePath, { force: true });
        restoredFiles.push({
          sourcePath: target.sourcePath,
          backupPath: target.backupPath,
          safetyBackupPath: safetyBackup.targets.find((backup) => backup.sourcePath === target.sourcePath)?.backupPath ?? null,
          status: "restored",
          message: "Removed apply-created target after taking rollback safety backup.",
        });
        continue;
      }
      await restoreFromBackupTarget(target);
      restoredFiles.push({
        sourcePath: target.sourcePath,
        backupPath: target.backupPath,
        safetyBackupPath: safetyBackup.targets.find((backup) => backup.sourcePath === target.sourcePath)?.backupPath ?? null,
        status: "restored",
        message: "Restored backup file with temporary sibling copy and atomic rename.",
      });
    }

    await rebuildSearchIndex({ codexHome, indexPath });
  } catch (error) {
    restoredFiles.push({
      sourcePath: "restore-undo",
      backupPath: backupRoot,
      safetyBackupPath: safetyRoot,
      status: "failed",
      message: errorMessage(error),
    });
    return writeUndoReport("failed", `Restore undo failed after creating safety backup: ${errorMessage(error)}`);
  }

  return writeUndoReport("succeeded", "Restore undo completed, safety-backed rollback restored files, and verification passed.");
}

async function buildPreflight(input: {
  items: RestorePlanItem[];
  processCheckMode: RestoreProcessCheckMode;
  processDetector: CodexProcessDetector;
}): Promise<RestorePlanPreflight> {
  const checks = [
    selectedIdsCheck(input.items),
    rolloutSourceCheck(input.items),
    targetConflictCheck(input.items),
    await codexClosedCheck(input.processCheckMode, input.processDetector),
  ];

  return {
    processCheckMode: input.processCheckMode,
    checks,
    summary: {
      passed: countStatus(checks, "passed"),
      warning: countStatus(checks, "warning"),
      failed: countStatus(checks, "failed"),
      unknown: countStatus(checks, "unknown"),
      hasFailures: checks.some((check) => check.status === "failed"),
      hasWarnings: checks.some((check) => check.status === "warning"),
    },
  };
}

function resolveUndoInput(options: RestoreUndoInternalOptions): { reportPath: string; backupRoot: string } {
  const explicitReportPath = options.reportPath ? path.resolve(expandHome(options.reportPath)) : null;
  const explicitBackupRoot = options.backupRoot ? path.resolve(expandHome(options.backupRoot)) : null;
  if (explicitReportPath && explicitBackupRoot) {
    return { reportPath: explicitReportPath, backupRoot: explicitBackupRoot };
  }
  if (explicitReportPath) {
    return { reportPath: explicitReportPath, backupRoot: path.dirname(explicitReportPath) };
  }
  if (explicitBackupRoot) {
    return { reportPath: path.join(explicitBackupRoot, "restore-report.json"), backupRoot: explicitBackupRoot };
  }
  return {
    reportPath: path.resolve("restore-report.json"),
    backupRoot: path.resolve("."),
  };
}

function readJsonFile<T>(filePath: string): T {
  return JSON.parse(readFileSync(filePath, "utf8")) as T;
}

function buildUndoTargets(input: {
  codexHome: string;
  indexPath: string;
  backupRoot: string;
  manifest: RestoreApplyBackupManifest;
  sourceReport: RestoreApplyReport;
}): RestoreUndoTarget[] {
  const targets: RestoreUndoTarget[] = input.manifest.targets.map((target): RestoreUndoTarget => {
    const backupMetadata = fileMetadata(target.backupPath);
    const currentMetadata = fileMetadata(target.sourcePath);
    const warnings: string[] = [];
    const errors: string[] = [];
    if (target.exists && !backupMetadata.exists) {
      errors.push(`Backup file is missing: ${target.backupPath}`);
    }
    if (target.exists && target.sizeBytes !== null && backupMetadata.sizeBytes !== target.sizeBytes) {
      errors.push(`Backup size mismatch for ${target.backupPath}: expected ${target.sizeBytes}, found ${backupMetadata.sizeBytes}.`);
    }
    if (target.exists && target.hashStatus === "sha256" && target.sha256 !== backupMetadata.sha256) {
      errors.push(`Backup sha256 mismatch for ${target.backupPath}.`);
    }
    if (target.exists && currentMetadata.exists && currentMetadata.sha256 === backupMetadata.sha256) {
      warnings.push("Current target already matches the backup artifact.");
    }
    if (target.exists && currentMetadata.exists && currentMetadata.sha256 !== backupMetadata.sha256) {
      warnings.push("Current target differs from the backup artifact and will be overwritten if confirmed.");
    }
    return {
      sourcePath: path.resolve(target.sourcePath),
      backupPath: path.resolve(target.backupPath),
      kind: target.kind,
      existsInManifest: target.exists,
      backupExists: backupMetadata.exists,
      targetExists: currentMetadata.exists,
      backupSizeBytes: backupMetadata.sizeBytes,
      backupSha256: backupMetadata.sha256,
      currentSizeBytes: currentMetadata.sizeBytes,
      currentSha256: currentMetadata.sha256,
      hashStatus: target.hashStatus,
      action: target.exists ? "restore-file" : "skip-missing-original",
      warnings,
      errors,
    };
  });
  const bySource = new Set(targets.map((target) => target.sourcePath));
  for (const mutation of input.sourceReport.mutations) {
    if (
      mutation.kind !== "copy-rollout-to-active-session" ||
      mutation.status !== "applied" ||
      bySource.has(path.resolve(mutation.targetPath))
    ) {
      continue;
    }
    const metadata = fileMetadata(mutation.targetPath);
    targets.push({
      sourcePath: path.resolve(mutation.targetPath),
      backupPath: "",
      kind: "active-session-target",
      existsInManifest: false,
      backupExists: false,
      targetExists: metadata.exists,
      backupSizeBytes: null,
      backupSha256: null,
      currentSizeBytes: metadata.sizeBytes,
      currentSha256: metadata.sha256,
      hashStatus: "missing",
      action: "remove-created-file",
      warnings: metadata.exists
        ? ["Apply created this active-session target and undo will remove it after taking a safety backup."]
        : ["Apply-created active-session target is already absent."],
      errors: [],
    });
  }
  return targets;
}

function buildUndoValidation(input: {
  codexHome: string;
  indexPath: string;
  reportPath: string;
  backupRoot: string;
  manifestPath: string;
  sourceReport: RestoreApplyReport | null;
  backupManifest: RestoreApplyBackupManifest | null;
  targets: RestoreUndoTarget[];
  readErrors: string[];
}): RestorePlanPreflight {
  const checks: RestorePlanPreflightCheck[] = [
    undoReportSchemaCheck(input.sourceReport, input.readErrors),
    undoManifestSchemaCheck(input.backupRoot, input.manifestPath, input.backupManifest, input.readErrors),
    undoManifestPathCheck(input.backupRoot, input.backupManifest, input.targets),
    undoTargetPathCheck(input.codexHome, input.indexPath, input.targets),
    undoBackupIntegrityCheck(input.targets),
  ];
  return {
    processCheckMode: "warn",
    checks,
    summary: {
      passed: countStatus(checks, "passed"),
      warning: countStatus(checks, "warning"),
      failed: countStatus(checks, "failed"),
      unknown: countStatus(checks, "unknown"),
      hasFailures: checks.some((check) => check.status === "failed"),
      hasWarnings: checks.some((check) => check.status === "warning"),
    },
  };
}

function undoReportSchemaCheck(
  sourceReport: RestoreApplyReport | null,
  readErrors: string[],
): RestorePlanPreflightCheck {
  if (!sourceReport) {
    return failedUndoCheck(
      "undo-report-schema",
      "Apply report schema",
      readErrors.length > 0 ? readErrors : ["Restore apply report could not be read."],
      "Pass --report pointing at a PR #7 restore-report.json artifact.",
    );
  }
  if (sourceReport.schemaVersion !== 1 || sourceReport.reportType !== "restore-apply-report") {
    return failedUndoCheck(
      "undo-report-schema",
      "Apply report schema",
      [`Unsupported report schemaVersion/reportType: ${String(sourceReport.schemaVersion)} ${String(sourceReport.reportType)}.`],
      "Use a schemaVersion 1 restore-apply-report produced by restore apply.",
    );
  }
  return passedUndoCheck(
    "undo-report-schema",
    "Apply report schema",
    [`Report ${sourceReport.operationId} uses recognized schemaVersion 1 restore-apply-report.`],
  );
}

function undoManifestSchemaCheck(
  backupRoot: string,
  manifestPath: string,
  manifest: RestoreApplyBackupManifest | null,
  readErrors: string[],
): RestorePlanPreflightCheck {
  if (!manifest) {
    return failedUndoCheck(
      "undo-manifest-schema",
      "Backup manifest schema",
      readErrors.length > 0 ? readErrors : ["Backup manifest could not be read."],
      "Keep backup-manifest.json next to the restore report or pass the correct --backup-root.",
    );
  }
  if (path.resolve(manifest.backupRoot) !== path.resolve(backupRoot)) {
    return failedUndoCheck(
      "undo-manifest-schema",
      "Backup manifest schema",
      [`Manifest backupRoot ${manifest.backupRoot} does not match requested backup root ${backupRoot}.`],
      "Use the original backup root from the restore apply report.",
    );
  }
  if (path.resolve(manifest.manifestPath) !== path.resolve(manifestPath)) {
    return failedUndoCheck(
      "undo-manifest-schema",
      "Backup manifest schema",
      [`Manifest path ${manifest.manifestPath} does not match resolved manifest path ${manifestPath}.`],
      "Use the unmodified backup manifest from the restore apply artifact.",
    );
  }
  if (!Array.isArray(manifest.targets)) {
    return failedUndoCheck(
      "undo-manifest-schema",
      "Backup manifest schema",
      ["Manifest targets must be an array."],
      "Use an intact backup-manifest.json produced by restore apply.",
    );
  }
  return passedUndoCheck(
    "undo-manifest-schema",
    "Backup manifest schema",
    [`Manifest includes ${manifest.targets.length} target(s).`],
  );
}

function undoManifestPathCheck(
  backupRoot: string,
  manifest: RestoreApplyBackupManifest | null,
  targets: RestoreUndoTarget[],
): RestorePlanPreflightCheck {
  if (!manifest) {
    return failedUndoCheck("undo-manifest-paths", "Backup manifest paths", ["Manifest was unavailable."], "Use a valid backup manifest.");
  }
  const evidence: string[] = [];
  const errors: string[] = [];
  for (const target of targets) {
    if (target.action === "remove-created-file") {
      evidence.push(`${target.sourcePath}: apply-created file is tracked from restore report mutation.`);
      continue;
    }
    if (!pathInside(backupRoot, target.backupPath)) {
      errors.push(`${target.backupPath} escapes backup root ${backupRoot}.`);
    } else {
      evidence.push(`${target.backupPath}: inside backup root.`);
    }
  }
  if (!pathInside(backupRoot, manifest.manifestPath)) {
    errors.push(`${manifest.manifestPath} escapes backup root ${backupRoot}.`);
  }
  if (errors.length > 0) {
    return failedUndoCheck(
      "undo-manifest-paths",
      "Backup manifest paths",
      errors,
      "Reject modified manifests whose backup paths leave the selected backup root.",
    );
  }
  return passedUndoCheck("undo-manifest-paths", "Backup manifest paths", evidence.length > 0 ? evidence : ["No backup targets to restore."]);
}

function undoTargetPathCheck(codexHome: string, indexPath: string, targets: RestoreUndoTarget[]): RestorePlanPreflightCheck {
  const evidence: string[] = [];
  const errors: string[] = [];
  for (const target of targets) {
    const allowed = pathInside(codexHome, target.sourcePath) || path.resolve(target.sourcePath) === path.resolve(indexPath);
    if (!allowed) {
      errors.push(`${target.sourcePath} is outside Codex home ${codexHome} and is not the configured search index ${indexPath}.`);
      continue;
    }
    const safe = targetPathDoesNotEscape(codexHome, indexPath, target.sourcePath);
    if (!safe) {
      errors.push(`${target.sourcePath} resolves through a symlink or parent escape outside its allowed root.`);
      continue;
    }
    evidence.push(`${target.sourcePath}: target path is inside the allowed restore root.`);
  }
  if (errors.length > 0) {
    return failedUndoCheck(
      "undo-target-paths",
      "Target restore paths",
      errors,
      "Use only unmodified restore reports whose targets are under the intended Codex home or configured search index.",
    );
  }
  return passedUndoCheck("undo-target-paths", "Target restore paths", evidence.length > 0 ? evidence : ["No target paths to restore."]);
}

function undoBackupIntegrityCheck(targets: RestoreUndoTarget[]): RestorePlanPreflightCheck {
  const errors = targets.flatMap((target) => target.errors);
  const warnings = targets.flatMap((target) => target.warnings);
  if (errors.length > 0) {
    return failedUndoCheck("undo-backup-integrity", "Backup file integrity", errors, "Use an intact backup root with unchanged backup files.");
  }
  if (warnings.length > 0) {
    return {
      id: "undo-backup-integrity",
      label: "Backup file integrity",
      status: "passed",
      blocking: false,
      evidence: warnings,
      remediation: "Review target differences before confirming undo.",
    };
  }
  return passedUndoCheck("undo-backup-integrity", "Backup file integrity", ["All backup files exist and match recorded size/hash metadata."]);
}

function passedUndoCheck(id: string, label: string, evidence: string[]): RestorePlanPreflightCheck {
  return {
    id,
    label,
    status: "passed",
    blocking: false,
    evidence,
    remediation: "No action needed.",
  };
}

function failedUndoCheck(id: string, label: string, evidence: string[], remediation: string): RestorePlanPreflightCheck {
  return {
    id,
    label,
    status: "failed",
    blocking: true,
    evidence,
    remediation,
  };
}

function hasBlockingChecks(preflight: RestorePlanPreflight): boolean {
  return preflight.checks.some((check) => check.status !== "passed" || check.blocking);
}

function selectedIdsCheck(items: RestorePlanItem[]): RestorePlanPreflightCheck {
  const missing = items.filter((item) => !item.evidence.threadFound).map((item) => item.threadId);
  if (missing.length === 0) {
    return {
      id: "selected-ids-present",
      label: "Selected IDs still present",
      status: "passed",
      blocking: false,
      evidence: [`${items.length} selected id(s) matched current local scan evidence.`],
      remediation: "No action needed.",
    };
  }

  return {
    id: "selected-ids-present",
    label: "Selected IDs still present",
    status: "failed",
    blocking: true,
    evidence: missing.map((id) => `${id}: not found in current SQLite, sessions, or archived sessions scan.`),
    remediation: "Refresh the index, re-scan local Codex state, and select only thread IDs that still exist.",
  };
}

function rolloutSourceCheck(items: RestorePlanItem[]): RestorePlanPreflightCheck {
  const missing = items.filter((item) => item.evidence.threadFound && item.evidence.existsOnDisk === false);
  if (missing.length === 0) {
    return {
      id: "rollout-sources-exist",
      label: "Rollout/session sources exist",
      status: "passed",
      blocking: false,
      evidence: ["All selected threads that need source JSONL evidence still have files on disk."],
      remediation: "No action needed.",
    };
  }

  return {
    id: "rollout-sources-exist",
    label: "Rollout/session sources exist",
    status: "failed",
    blocking: true,
    evidence: missing.map((item) => `${item.threadId}: missing ${item.evidence.rolloutPath ?? "rollout path"}.`),
    remediation: "Recover the missing JSONL source files or exclude those thread IDs before any future apply.",
  };
}

function targetConflictCheck(items: RestorePlanItem[]): RestorePlanPreflightCheck {
  const conflicts = items.flatMap((item) =>
    item.validations.filter(
      (validation) =>
        validation.id === "target-path-conflict" &&
        (validation.status === "failed" || validation.status === "warning"),
    ),
  );
  const failed = conflicts.filter((validation) => validation.status === "failed");
  if (conflicts.length === 0) {
    return {
      id: "target-path-conflicts",
      label: "Target path conflicts",
      status: "passed",
      blocking: false,
      evidence: ["No unexpected active/archive target path conflicts were detected for future apply candidates."],
      remediation: "No action needed.",
    };
  }

  return {
    id: "target-path-conflicts",
    label: "Target path conflicts",
    status: failed.length > 0 ? "failed" : "warning",
    blocking: failed.length > 0,
    evidence: conflicts.flatMap((validation) => validation.evidence),
    remediation: failed.length > 0
      ? "Inspect the existing target files and remove conflicting selections before any future apply."
      : "Review the warnings before any future apply.",
  };
}

async function codexClosedCheck(
  mode: RestoreProcessCheckMode,
  detector: CodexProcessDetector,
): Promise<RestorePlanPreflightCheck> {
  if (mode === "skip") {
    return {
      id: "codex-processes-closed",
      label: "Codex processes closed",
      status: "unknown",
      blocking: false,
      evidence: ["Process detection was skipped by option."],
      remediation: "Before applying a future restore, close Codex Desktop, any local app-server, and related codex processes.",
    };
  }

  try {
    const detection = await detector();
    if (detection.status === "unavailable") {
      return {
        id: "codex-processes-closed",
        label: "Codex processes closed",
        status: "unknown",
        blocking: false,
        evidence: detection.evidence.length > 0
          ? detection.evidence
          : [detection.error ?? "The process list could not be inspected on this platform."],
        remediation: "Manually confirm Codex Desktop and related codex processes are closed before future apply.",
      };
    }
    if (detection.processes.length === 0) {
      return {
        id: "codex-processes-closed",
        label: "Codex processes closed",
        status: "passed",
        blocking: false,
        evidence: detection.evidence.length > 0 ? detection.evidence : ["No matching Codex processes were detected."],
        remediation: "No action needed.",
      };
    }

    return {
      id: "codex-processes-closed",
      label: "Codex processes closed",
      status: mode === "strict" ? "failed" : "warning",
      blocking: mode === "strict",
      evidence: detection.processes.map((process) =>
        `pid=${process.pid ?? "unknown"} match=${process.matchedBy} command=${process.command}`,
      ),
      remediation: "Close Codex Desktop, app-server, and codex CLI/server processes before any future apply.",
    };
  } catch (error) {
    return {
      id: "codex-processes-closed",
      label: "Codex processes closed",
      status: "unknown",
      blocking: false,
      evidence: [`Process detection failed: ${errorMessage(error)}`],
      remediation: "Manually confirm Codex Desktop and related codex processes are closed before future apply.",
    };
  }
}

function planThread(input: {
  codexHome: string;
  indexPath: string;
  threadId: string;
  thread: ThreadRecord | undefined;
}): RestorePlanItem {
  const { codexHome, indexPath, threadId, thread } = input;
  if (!thread) {
    return {
      threadId,
      title: null,
      cwd: null,
      classification: "not-found",
      actionability: "rejected",
      readOnly: true,
      reasons: ["The selected thread id was not found in SQLite, active sessions, or archived sessions."],
      evidence: emptyEvidence(),
      futureActions: [],
      backupPreview: [],
      mutationPreview: [],
      plannedPaths: [],
      validations: [],
    };
  }

  const evidence = buildEvidence(codexHome, thread);
  const stateDbPath = path.join(codexHome, STATE_DB);
  const sessionIndexPath = path.join(codexHome, SESSION_INDEX);
  const sourceBackups = thread.sourcePaths.length > 0 ? thread.sourcePaths : compact([thread.rolloutPath]);
  const standardBackups = [stateDbPath, sessionIndexPath, ...sourceBackups, indexPath];
  const targetPaths = plannedTargetPaths(codexHome, thread, evidence);

  if (!thread.existsOnDisk) {
    return itemForThread(thread, {
      classification: "missing-rollout-source",
      actionability: "blocked",
      reasons: [
        "The selected thread references a rollout/session path, but the source file was not found.",
        "Restore cannot be planned beyond diagnostics until source JSONL evidence exists.",
      ],
      evidence,
      futureActions: ["Locate or recover the missing rollout/session JSONL file, then run restore planning again."],
      backupPreview: [],
      mutationPreview: [],
      plannedPaths: plannedPaths(stateDbPath, sessionIndexPath, sourceBackups, targetPaths, indexPath, false),
      validations: sourceValidations(thread, targetPaths),
    });
  }

  if (thread.restoreStatus === "active") {
    return itemForThread(thread, {
      classification: "already-active",
      actionability: "no-op",
      reasons: [
        "The selected thread is already represented as active local Codex state.",
        "If it is still absent from Codex UI, use visibility diagnostics rather than archive restore.",
      ],
      evidence,
      futureActions: [],
      backupPreview: [],
      mutationPreview: [],
      plannedPaths: plannedPaths(stateDbPath, sessionIndexPath, sourceBackups, targetPaths, indexPath, false),
      validations: sourceValidations(thread, targetPaths),
    });
  }

  if (thread.restoreStatus === "archived" && evidence.hasArchivedRolloutPath && evidence.sqlitePresent) {
    return itemForThread(thread, {
      classification: "archived-sqlite-thread",
      actionability: "future-apply",
      reasons: [
        "The selected thread has a SQLite row marked archived and an existing archived rollout file.",
        "A future apply phase can conservatively unarchive/relink it after backups and a transaction plan.",
      ],
      evidence,
      futureActions: [
        "Back up Codex SQLite state, session index, affected rollout files, and derived index state.",
        "In a future apply phase, update the SQLite thread row from archived to active.",
        "Relink or refresh session_index.jsonl so Codex can discover the active thread.",
        "Rebuild the derived codex-archiver search index after Codex state changes.",
      ],
      backupPreview: unique([...standardBackups, ...existingTargetPaths(targetPaths)]),
      mutationPreview: [stateDbPath, sessionIndexPath, indexPath],
      plannedPaths: plannedPaths(stateDbPath, sessionIndexPath, sourceBackups, targetPaths, indexPath, true),
      validations: sourceValidations(thread, targetPaths),
    });
  }

  if (thread.restoreStatus === "restorable" && evidence.hasArchivedRolloutPath && !evidence.sqlitePresent) {
    return itemForThread(thread, {
      classification: "jsonl-only-archived-thread",
      actionability: "future-apply",
      reasons: [
        "The selected thread has archived JSONL evidence but no SQLite thread row.",
        "A future apply phase can propose inserting an active SQLite row and reindexing from the JSONL source.",
      ],
      evidence,
      futureActions: [
        "Back up Codex SQLite state, session index, affected rollout files, and derived index state.",
        "In a future apply phase, insert a SQLite thread row derived from the archived JSONL evidence.",
        "Add or refresh the session_index.jsonl entry for the selected thread.",
        "Rebuild the derived codex-archiver search index after Codex state changes.",
      ],
      backupPreview: unique([...standardBackups, ...existingTargetPaths(targetPaths)]),
      mutationPreview: [stateDbPath, sessionIndexPath, indexPath],
      plannedPaths: plannedPaths(stateDbPath, sessionIndexPath, sourceBackups, targetPaths, indexPath, true),
      validations: sourceValidations(thread, targetPaths),
    });
  }

  if (thread.restoreStatus === "hidden" || (evidence.hasActiveRolloutPath && !evidence.sqlitePresent)) {
    return itemForThread(thread, {
      classification: "ui-hidden-active-thread",
      actionability: "diagnostic-only",
      reasons: [
        "The selected thread has active-session JSONL evidence and does not need archive restore semantics.",
        "The next step is visibility-oriented recovery or diagnostics, not unarchiving.",
      ],
      evidence,
      futureActions: [
        "Run visibility diagnostics against session_index.jsonl, codex resume, and any local app-server surface.",
        "In a future apply phase, consider reindexing or relinking active visibility metadata only after backup.",
      ],
      backupPreview: [sessionIndexPath, ...sourceBackups, indexPath],
      mutationPreview: [sessionIndexPath, indexPath],
      plannedPaths: plannedPaths(stateDbPath, sessionIndexPath, sourceBackups, targetPaths, indexPath, true),
      validations: sourceValidations(thread, targetPaths),
    });
  }

  return itemForThread(thread, {
    classification: "unsupported",
    actionability: "blocked",
    reasons: [
      `The selected thread is in restore status '${thread.restoreStatus}', which does not have a safe restore plan yet.`,
    ],
    evidence,
    futureActions: ["Collect more source evidence or add an explicit planner case before any apply phase."],
    backupPreview: [],
    mutationPreview: [],
    plannedPaths: plannedPaths(stateDbPath, sessionIndexPath, sourceBackups, targetPaths, indexPath, false),
    validations: sourceValidations(thread, targetPaths),
  });
}

function itemForThread(
  thread: ThreadRecord,
  values: {
    classification: RestorePlanClassification;
    actionability: RestorePlanActionability;
    reasons: string[];
    evidence: RestorePlanEvidence;
    futureActions: string[];
    backupPreview: string[];
    mutationPreview: string[];
    plannedPaths: RestorePlanPlannedPath[];
    validations: RestorePlanValidation[];
  },
): RestorePlanItem {
  return {
    threadId: thread.id,
    title: thread.title,
    cwd: thread.cwd,
    readOnly: true,
    ...values,
  };
}

function buildEvidence(codexHome: string, thread: ThreadRecord): RestorePlanEvidence {
  const hasActiveRolloutPath = hasSourceUnder(codexHome, thread, "sessions");
  const hasArchivedRolloutPath = hasSourceUnder(codexHome, thread, "archived_sessions");
  return {
    threadFound: true,
    restoreStatus: thread.restoreStatus,
    storageKind: thread.storageKind,
    archived: thread.archived,
    rolloutPath: thread.rolloutPath,
    sourcePaths: thread.sourcePaths,
    existsOnDisk: thread.existsOnDisk,
    hasActiveRolloutPath,
    hasArchivedRolloutPath,
    sqlitePresent: thread.storageKind === "sqlite-only" || thread.storageKind === "mixed",
  };
}

function emptyEvidence(): RestorePlanEvidence {
  return {
    threadFound: false,
    restoreStatus: null,
    storageKind: null,
    archived: null,
    rolloutPath: null,
    sourcePaths: [],
    existsOnDisk: null,
    hasActiveRolloutPath: false,
    hasArchivedRolloutPath: false,
    sqlitePresent: false,
  };
}

function buildImpactPreview(items: RestorePlanItem[]): RestorePlanImpactPreview {
  return {
    selectedCount: items.length,
    futureApplyCount: count(items, "future-apply"),
    diagnosticOnlyCount: count(items, "diagnostic-only"),
    blockedCount: count(items, "blocked"),
    noopCount: count(items, "no-op"),
    rejectedCount: count(items, "rejected"),
    wouldMutateCodexHome: false,
    wouldCreateBackups: false,
    mutationTargetsIfApplied: unique(items.flatMap((item) => item.mutationPreview)),
  };
}

function buildBackupPreview(
  codexHome: string,
  indexPath: string,
  backupRoot: string,
  items: RestorePlanItem[],
): RestorePlanBackupPreview {
  const allPlanned = items.flatMap((item) => item.plannedPaths.filter((planned) => planned.requiredBeforeApply));
  const byPath = new Map<string, RestorePlanPlannedPath>();
  for (const planned of allPlanned) {
    const existing = byPath.get(planned.path);
    byPath.set(planned.path, {
      ...planned,
      requiredBeforeApply: planned.requiredBeforeApply || existing?.requiredBeforeApply === true,
    });
  }
  const targets = Array.from(byPath.values()).map((planned) => backupTarget(codexHome, indexPath, backupRoot, planned));

  return {
    requiredBeforeApply: items.some((item) => item.backupPreview.length > 0),
    createdByThisPlan: false,
    backupRootPattern: path.join(
      path.dirname(indexPath),
      "backups",
      "restore-YYYYMMDD-HHMMSS-selectionhash",
    ),
    plannedBackupRoot: backupRoot,
    targetsIfApplied: unique(items.flatMap((item) => item.backupPreview)),
    targets,
    notes: [
      "This restore plan is a dry run and does not create backups.",
      "A future apply phase must create timestamped backups before mutating Codex state.",
      "The future apply phase must use a transaction-backed SQLite update plan and emit a machine-readable report.",
    ],
  };
}

function backupTarget(
  codexHome: string,
  indexPath: string,
  backupRoot: string,
  planned: RestorePlanPlannedPath,
): RestorePlanBackupTarget {
  const metadata = fileMetadata(planned.path);
  return {
    sourcePath: planned.path,
    backupPath: path.join(backupRoot, backupRelativePath(codexHome, indexPath, planned.path)),
    kind: planned.kind,
    exists: metadata.exists,
    sizeBytes: metadata.sizeBytes,
    mtimeMs: metadata.mtimeMs,
    sha256: metadata.sha256,
    hashStatus: metadata.hashStatus,
    requiredBeforeApply: planned.requiredBeforeApply,
  };
}

function plannedPaths(
  stateDbPath: string,
  sessionIndexPath: string,
  sourcePaths: string[],
  targetPaths: RestorePlanPlannedPath[],
  indexPath: string,
  requiredBeforeApply: boolean,
): RestorePlanPlannedPath[] {
  return uniqueByPath([
    { kind: "state-db", path: stateDbPath, exists: pathExists(stateDbPath), requiredBeforeApply },
    { kind: "session-index", path: sessionIndexPath, exists: pathExists(sessionIndexPath), requiredBeforeApply },
    ...sourcePaths.map((sourcePath): RestorePlanPlannedPath => ({
      kind: sourcePath.includes(`${path.sep}archived_sessions${path.sep}`)
        ? "archived-source-rollout"
        : "source-rollout",
      path: sourcePath,
      exists: pathExists(sourcePath),
      requiredBeforeApply,
    })),
    ...targetPaths,
    { kind: "search-index", path: indexPath, exists: pathExists(indexPath), requiredBeforeApply },
  ]);
}

function sourceValidations(
  thread: ThreadRecord,
  targetPaths: RestorePlanPlannedPath[],
): RestorePlanValidation[] {
  const validations: RestorePlanValidation[] = [];
  if (thread.existsOnDisk) {
    validations.push({
      id: "source-file-present",
      status: "passed",
      message: "Source rollout/session JSONL is present.",
      evidence: allCandidatePaths(thread).map((sourcePath) => `${sourcePath}: ${pathExists(sourcePath) ? "exists" : "missing"}`),
      remediation: "No action needed.",
    });
  } else {
    validations.push({
      id: "source-file-present",
      status: "failed",
      message: "Source rollout/session JSONL is missing.",
      evidence: allCandidatePaths(thread).map((sourcePath) => `${sourcePath}: missing`),
      remediation: "Recover the missing JSONL source before planning a future apply.",
    });
  }

  for (const targetPath of targetPaths) {
    if (targetPath.exists === true && !allCandidatePaths(thread).includes(targetPath.path)) {
      validations.push({
        id: "target-path-conflict",
        status: "failed",
        message: "A planned future target path already exists outside the selected thread evidence.",
        evidence: [`${targetPath.kind}: ${targetPath.path}`],
        remediation: "Inspect the existing file and do not apply restoration until the target conflict is resolved.",
      });
    }
  }

  return validations;
}

function plannedTargetPaths(
  codexHome: string,
  thread: ThreadRecord,
  evidence: RestorePlanEvidence,
): RestorePlanPlannedPath[] {
  if (!evidence.hasArchivedRolloutPath) {
    return [];
  }

  const archiveRoot = path.resolve(codexHome, "archived_sessions");
  const activeRoot = path.resolve(codexHome, "sessions");
  const archivedSources = allCandidatePaths(thread)
    .map((sourcePath) => path.resolve(sourcePath))
    .filter((sourcePath) => sourcePath.startsWith(`${archiveRoot}${path.sep}`));

  return archivedSources.map((sourcePath): RestorePlanPlannedPath => {
    const activePath = path.join(activeRoot, path.relative(archiveRoot, sourcePath));
    return {
      kind: "active-session-target",
      path: activePath,
      exists: pathExists(activePath),
      requiredBeforeApply: pathExists(activePath),
    };
  });
}

function existingTargetPaths(targetPaths: RestorePlanPlannedPath[]): string[] {
  return targetPaths.filter((targetPath) => targetPath.exists === true).map((targetPath) => targetPath.path);
}

function hasSourceUnder(codexHome: string, thread: ThreadRecord, dirName: string): boolean {
  const prefix = `${path.resolve(codexHome, dirName)}${path.sep}`;
  return allCandidatePaths(thread).some((sourcePath) => path.resolve(sourcePath).startsWith(prefix));
}

function allCandidatePaths(thread: ThreadRecord): string[] {
  return unique(compact([thread.rolloutPath, ...thread.sourcePaths]));
}

function normalizeSelectedThreadIds(values: string[]): string[] {
  return unique(values.map((value) => value.trim()).filter(Boolean));
}

function count(items: RestorePlanItem[], actionability: RestorePlanActionability): number {
  return items.filter((item) => item.actionability === actionability).length;
}

function countStatus(items: Array<{ status: RestorePreflightStatus }>, status: RestorePreflightStatus): number {
  return items.filter((item) => item.status === status).length;
}

function compact(values: Array<string | null>): string[] {
  return values.filter((value): value is string => typeof value === "string" && value.length > 0);
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

function uniqueByPath(values: RestorePlanPlannedPath[]): RestorePlanPlannedPath[] {
  const byPath = new Map<string, RestorePlanPlannedPath>();
  for (const value of values) {
    const existing = byPath.get(value.path);
    byPath.set(value.path, {
      ...value,
      exists: value.exists ?? existing?.exists ?? null,
      requiredBeforeApply: value.requiredBeforeApply || existing?.requiredBeforeApply === true,
    });
  }
  return Array.from(byPath.values());
}

function pathExists(filePath: string): boolean {
  return existsSync(filePath);
}

function pathInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function targetPathDoesNotEscape(codexHome: string, indexPath: string, candidate: string): boolean {
  const absolute = path.resolve(candidate);
  const allowedRoot = absolute === path.resolve(indexPath) ? path.dirname(indexPath) : codexHome;
  if (!pathInside(allowedRoot, absolute)) {
    return false;
  }
  try {
    if (!existsSync(allowedRoot)) {
      const anchor = nearestExistingParent(allowedRoot);
      return pathInside(anchor, allowedRoot) &&
        pathInside(anchor, absolute) &&
        !pathHasSymlinkAncestor(anchor, absolute);
    }
    const realAllowedRoot = realpathSync(allowedRoot);
    if (existsSync(absolute)) {
      if (lstatSync(absolute).isSymbolicLink()) {
        return false;
      }
      return pathInside(realAllowedRoot, realpathSync(absolute));
    }
    const parent = nearestExistingParent(absolute);
    return pathInside(realAllowedRoot, realpathSync(parent)) && !pathHasSymlinkAncestor(allowedRoot, absolute);
  } catch {
    return false;
  }
}

function nearestExistingParent(filePath: string): string {
  let current = path.dirname(filePath);
  while (!existsSync(current)) {
    const next = path.dirname(current);
    if (next === current) {
      return current;
    }
    current = next;
  }
  return current;
}

function pathHasSymlinkAncestor(root: string, filePath: string): boolean {
  const resolvedRoot = path.resolve(root);
  let current = path.resolve(filePath);
  while (pathInside(resolvedRoot, current) && current !== resolvedRoot) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) {
      return true;
    }
    const next = path.dirname(current);
    if (next === current) {
      break;
    }
    current = next;
  }
  return false;
}

function fileMetadata(filePath: string): {
  exists: boolean;
  sizeBytes: number | null;
  mtimeMs: number | null;
  sha256: string | null;
  hashStatus: RestorePlanBackupTarget["hashStatus"];
} {
  try {
    const stat = statSync(filePath);
    if (!stat.isFile()) {
      return { exists: false, sizeBytes: null, mtimeMs: null, sha256: null, hashStatus: "missing" };
    }
    if (stat.size > HASH_MAX_BYTES) {
      return {
        exists: true,
        sizeBytes: stat.size,
        mtimeMs: stat.mtimeMs,
        sha256: null,
        hashStatus: "skipped-large-file",
      };
    }
    return {
      exists: true,
      sizeBytes: stat.size,
      mtimeMs: stat.mtimeMs,
      sha256: createHash("sha256").update(readFileSync(filePath)).digest("hex"),
      hashStatus: "sha256",
    };
  } catch {
    return { exists: false, sizeBytes: null, mtimeMs: null, sha256: null, hashStatus: "missing" };
  }
}

function plannedBackupRoot(indexPath: string, generatedAt: string, selectedThreadIds: string[]): string {
  const timestamp = generatedAt.replaceAll(/[:.]/g, "-");
  const selectionHash = createHash("sha256")
    .update(selectedThreadIds.join("\n"))
    .digest("hex")
    .slice(0, 12);
  return path.join(path.dirname(indexPath), "backups", `restore-${timestamp}-${selectionHash}`);
}

function backupRelativePath(codexHome: string, indexPath: string, filePath: string): string {
  const indexDir = path.dirname(indexPath);
  const absolute = path.resolve(filePath);
  if (absolute === path.resolve(indexPath)) {
    return path.join("cache", path.basename(indexPath));
  }
  const resolvedCodexHome = path.resolve(codexHome);
  if (absolute === resolvedCodexHome || absolute.startsWith(`${resolvedCodexHome}${path.sep}`)) {
    return path.join("codex-home", path.relative(resolvedCodexHome, absolute));
  }
  const relativeToIndex = path.relative(indexDir, absolute);
  if (!relativeToIndex.startsWith("..") && !path.isAbsolute(relativeToIndex)) {
    return path.join("cache-relative", relativeToIndex);
  }
  return path.join("absolute", absolute.replaceAll(path.sep, "__"));
}

function buildReportPreview(backupRoot: string, planHash: string): RestorePlanReportPreview {
  const confirmationToken = confirmationTokenForPlanHash(planHash);
  return {
    schemaVersion: 1,
    reportType: "restore-apply-report",
    readOnlyPreview: true,
    wouldWriteReport: false,
    plannedReportPath: path.join(backupRoot, "restore-report.json"),
    planHash,
    confirmationToken,
    confirmationPhrase: `apply restore ${confirmationToken}`,
    requiredFields: [
      "schemaVersion",
      "operationId",
      "startedAt",
      "completedAt",
      "codexHome",
      "selectedThreadIds",
      "preflight",
      "backupManifest",
      "items",
      "mutations",
      "verification",
      "result",
    ],
    itemFields: [
      "threadId",
      "classification",
      "actionability",
      "sourcePaths",
      "plannedMutations",
      "appliedMutations",
      "warnings",
      "errors",
    ],
    undoFields: [
      "backupRoot",
      "stateDbBackup",
      "sessionIndexBackup",
      "rolloutFileBackups",
      "searchIndexBackup",
      "restoreSteps",
    ],
    notes: [
      "Planning previews the report schema but does not write a report file.",
      "Apply must pass the confirmation token or phrase from this preview before mutating Codex state.",
      "Apply writes this report next to the backup manifest before reporting success.",
    ],
  };
}

function stablePlanHash(input: {
  codexHome: string;
  indexPath: string;
  selectedThreadIds: string[];
  items: RestorePlanItem[];
  backupPreview: RestorePlanBackupPreview;
  preflight: RestorePlanPreflight;
}): string {
  const stable = {
    codexHome: input.codexHome,
    indexPath: input.indexPath,
    selectedThreadIds: input.selectedThreadIds,
    items: input.items.map((item) => ({
      threadId: item.threadId,
      classification: item.classification,
      actionability: item.actionability,
      evidence: {
        restoreStatus: item.evidence.restoreStatus,
        storageKind: item.evidence.storageKind,
        archived: item.evidence.archived,
        rolloutPath: item.evidence.rolloutPath,
        sourcePaths: item.evidence.sourcePaths,
        existsOnDisk: item.evidence.existsOnDisk,
        hasActiveRolloutPath: item.evidence.hasActiveRolloutPath,
        hasArchivedRolloutPath: item.evidence.hasArchivedRolloutPath,
        sqlitePresent: item.evidence.sqlitePresent,
      },
      plannedPaths: item.plannedPaths.map((planned) => ({
        kind: planned.kind,
        path: planned.path,
        exists: planned.exists,
        requiredBeforeApply: planned.requiredBeforeApply,
      })),
      validations: item.validations.map((validation) => ({
        id: validation.id,
        status: validation.status,
      })),
    })),
    backupTargets: input.backupPreview.targets.map((target) => ({
      sourcePath: target.sourcePath,
      kind: target.kind,
      exists: target.exists,
      sizeBytes: target.sizeBytes,
      sha256: target.sha256,
      hashStatus: target.hashStatus,
    })),
    preflight: input.preflight.checks.map((check) => ({
      id: check.id,
      status: check.status,
      blocking: check.blocking,
    })),
  };
  return createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}

function confirmationTokenForPlanHash(planHash: string): string {
  return `restore-${planHash.slice(0, 16)}`;
}

function confirmationMatches(
  options: RestoreApplyInternalOptions,
  expectedToken: string,
  expectedPhrase: string,
): boolean {
  return options.confirmationToken === expectedToken || options.confirmationPhrase === expectedPhrase;
}

async function createBackups(
  plan: RestorePlan,
  backupRoot: string,
  manifestPath: string,
): Promise<RestoreApplyBackupManifest> {
  await mkdir(backupRoot, { recursive: true, mode: 0o700 });
  const targets: RestorePlanBackupTarget[] = [];
  for (const target of plan.backupPreview.targets) {
    if (target.exists) {
      await mkdir(path.dirname(target.backupPath), { recursive: true, mode: 0o700 });
      await cp(target.sourcePath, target.backupPath, { preserveTimestamps: true });
    }
    targets.push({
      ...target,
    });
  }

  const manifest: RestoreApplyBackupManifest = {
    backupRoot,
    manifestPath,
    createdAt: new Date().toISOString(),
    targets,
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  return manifest;
}

async function copyRolloutForApply(
  sourcePath: string,
  activeTargetPath: string,
  threadId: string,
  recordMutation: (mutation: RestoreApplyMutation) => void,
  cleanupActions: Array<() => Promise<void>>,
): Promise<void> {
  const tmpPath = tempSiblingPath(activeTargetPath);
  recordMutation({
    threadId,
    kind: "copy-rollout-to-active-session",
    targetPath: activeTargetPath,
    status: "attempted",
    message: `Copy archived rollout source ${sourcePath} to active session target.`,
  });
  await mkdir(path.dirname(activeTargetPath), { recursive: true, mode: 0o700 });
  await cp(sourcePath, tmpPath, { preserveTimestamps: true });
  await rename(tmpPath, activeTargetPath);
  cleanupActions.push(async () => {
    await rm(activeTargetPath, { force: true });
  });
  recordMutation({
    threadId,
    kind: "copy-rollout-to-active-session",
    targetPath: activeTargetPath,
    status: "applied",
    message: "Copied archived rollout JSONL to the active sessions tree with atomic rename.",
  });
}

async function updateSessionIndexForApply(
  codexHome: string,
  items: RestorePlanItem[],
  recordMutation: (mutation: RestoreApplyMutation) => void,
  cleanupActions: Array<() => Promise<void>>,
): Promise<void> {
  const sessionIndexPath = path.join(codexHome, SESSION_INDEX);
  const original = existsSync(sessionIndexPath) ? await readFile(sessionIndexPath, "utf8") : null;
  const lines = (original ?? "")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0);
  const updatedRows: string[] = [];
  const touched = new Set<string>();

  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      updatedRows.push(line);
      continue;
    }

    const matching = items.find((item) => sessionIndexRowMatches(codexHome, parsed, item));
    if (!matching) {
      updatedRows.push(line);
      continue;
    }
    updatedRows.push(JSON.stringify(sessionIndexRowForItem(matching, parsed)));
    touched.add(matching.threadId);
  }

  for (const item of items) {
    if (!touched.has(item.threadId)) {
      updatedRows.push(JSON.stringify(sessionIndexRowForItem(item)));
    }
  }

  const tmpPath = tempSiblingPath(sessionIndexPath);
  await mkdir(path.dirname(sessionIndexPath), { recursive: true, mode: 0o700 });
  await writeFile(tmpPath, `${updatedRows.join("\n")}\n`, { mode: 0o600 });
  await rename(tmpPath, sessionIndexPath);
  cleanupActions.push(async () => {
    if (original === null) {
      await rm(sessionIndexPath, { force: true });
      return;
    }
    const restoreTmp = tempSiblingPath(sessionIndexPath);
    await writeFile(restoreTmp, original, { mode: 0o600 });
    await rename(restoreTmp, sessionIndexPath);
  });

  for (const item of items) {
    recordMutation({
      threadId: item.threadId,
      kind: "update-session-index",
      targetPath: sessionIndexPath,
      status: "applied",
      message: "Updated session_index.jsonl with active-session rollout path evidence.",
    });
  }
}

async function updateSqliteForApply(
  codexHome: string,
  items: RestorePlanItem[],
  sqlRunner: (dbPath: string, sql: string) => Promise<void>,
  recordMutation: (mutation: RestoreApplyMutation) => void,
): Promise<void> {
  const dbPath = path.join(codexHome, STATE_DB);
  const updates = items.map((item) => {
    const activePath = activeTargetPathFor(item);
    if (!activePath) {
      throw new Error(`Cannot update SQLite row for ${item.threadId}; active target path is unavailable.`);
    }
    return `UPDATE threads SET archived = 0, rollout_path = ${sqlValue(activePath)} WHERE id = ${sqlValue(item.threadId)} AND archived != 0;`;
  });

  const sql = [
    ".bail on",
    "BEGIN IMMEDIATE;",
    ...updates,
    "COMMIT;",
  ].join("\n");

  for (const item of items) {
    recordMutation({
      threadId: item.threadId,
      kind: "sqlite-unarchive-thread",
      targetPath: dbPath,
      status: "attempted",
      message: "Attempting SQLite transaction to unarchive thread and point rollout_path at active session JSONL.",
    });
  }

  await sqlRunner(dbPath, sql);

  for (const item of items) {
    recordMutation({
      threadId: item.threadId,
      kind: "sqlite-unarchive-thread",
      targetPath: dbPath,
      status: "applied",
      message: "SQLite transaction completed for archived thread row.",
    });
  }
}

async function rollbackCleanup(
  cleanupActions: Array<() => Promise<void>>,
  mutations: RestoreApplyMutation[],
): Promise<void> {
  for (const cleanup of cleanupActions.reverse()) {
    try {
      await cleanup();
    } catch {
      // Best-effort cleanup is reflected by the failed apply report.
    }
  }
  for (const mutation of mutations) {
    if (mutation.status === "applied") {
      mutation.status = "rolled-back";
      mutation.message = `${mutation.message} Rolled back after apply failure.`;
    }
  }
}

async function verifyApply(input: {
  codexHome: string;
  applyableItems: RestorePlanItem[];
  startedAt: string;
}): Promise<RestoreApplyReport["verification"]> {
  const scan = await scanCodexStorage(input.codexHome);
  const restoredThreadIds: string[] = [];
  const failedThreadIds: string[] = [];
  const evidence: string[] = [];

  for (const item of input.applyableItems) {
    const scanned = scan.threads.find((thread) => thread.id === item.threadId);
    const activePath = activeTargetPathFor(item);
    if (
      scanned?.restoreStatus === "active" &&
      scanned.archived === false &&
      activePath &&
      scanned.sourcePaths.includes(activePath)
    ) {
      restoredThreadIds.push(item.threadId);
      evidence.push(`${item.threadId}: active with SQLite archived=false and source ${activePath}.`);
    } else {
      failedThreadIds.push(item.threadId);
      evidence.push(`${item.threadId}: verification did not find active restored state.`);
    }
  }

  return {
    status: failedThreadIds.length === 0 ? "succeeded" : restoredThreadIds.length > 0 ? "partial" : "failed",
    checkedAt: new Date().toISOString(),
    restoredThreadIds,
    failedThreadIds,
    diagnostics: scan.diagnostics,
    evidence,
  };
}

async function createUndoSafetyBackup(input: {
  codexHome: string;
  indexPath: string;
  safetyRoot: string;
  targets: RestoreUndoTarget[];
  startedAt: string;
}): Promise<RestoreUndoSafetyBackup> {
  await mkdir(input.safetyRoot, { recursive: true, mode: 0o700 });
  const targets: RestorePlanBackupTarget[] = [];
  for (const target of input.targets) {
    const safetyPath = path.join(
      input.safetyRoot,
      backupRelativePath(input.codexHome, input.indexPath, target.sourcePath),
    );
    const metadata = fileMetadata(target.sourcePath);
    if (metadata.exists) {
      await mkdir(path.dirname(safetyPath), { recursive: true, mode: 0o700 });
      await cp(target.sourcePath, safetyPath, { preserveTimestamps: true });
    }
    targets.push({
      sourcePath: target.sourcePath,
      backupPath: safetyPath,
      kind: target.kind,
      exists: metadata.exists,
      sizeBytes: metadata.sizeBytes,
      mtimeMs: metadata.mtimeMs,
      sha256: metadata.sha256,
      hashStatus: metadata.hashStatus,
      requiredBeforeApply: true,
    });
  }

  const manifest: RestoreUndoSafetyBackup = {
    backupRoot: input.safetyRoot,
    manifestPath: path.join(input.safetyRoot, "rollback-safety-manifest.json"),
    createdAt: input.startedAt,
    targets,
  };
  await writeFile(manifest.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  return manifest;
}

async function restoreFromBackupTarget(target: RestoreUndoTarget): Promise<void> {
  const tmpPath = tempSiblingPath(target.sourcePath);
  await mkdir(path.dirname(target.sourcePath), { recursive: true, mode: 0o700 });
  await cp(target.backupPath, tmpPath, { preserveTimestamps: true });
  await rename(tmpPath, target.sourcePath);
}

async function verifyUndo(input: {
  codexHome: string;
  targets: RestoreUndoTarget[];
}): Promise<RestoreUndoReport["verification"]> {
  const restoredFiles: string[] = [];
  const failedFiles: string[] = [];
  const evidence: string[] = [];
  for (const target of input.targets) {
    if (target.action === "skip-missing-original") {
      restoredFiles.push(target.sourcePath);
      evidence.push(`${target.sourcePath}: skipped because original manifest entry was missing.`);
      continue;
    }
    if (target.action === "remove-created-file") {
      if (!existsSync(target.sourcePath)) {
        restoredFiles.push(target.sourcePath);
        evidence.push(`${target.sourcePath}: apply-created file was removed.`);
      } else {
        failedFiles.push(target.sourcePath);
        evidence.push(`${target.sourcePath}: apply-created file still exists after undo.`);
      }
      continue;
    }
    const restoredMetadata = fileMetadata(target.sourcePath);
    const backupMetadata = fileMetadata(target.backupPath);
    if (
      restoredMetadata.exists &&
      restoredMetadata.sizeBytes === backupMetadata.sizeBytes &&
      (target.hashStatus !== "sha256" || restoredMetadata.sha256 === backupMetadata.sha256)
    ) {
      restoredFiles.push(target.sourcePath);
      evidence.push(`${target.sourcePath}: restored file matches backup artifact.`);
    } else {
      failedFiles.push(target.sourcePath);
      evidence.push(`${target.sourcePath}: restored file does not match backup artifact.`);
    }
  }
  const scan = await scanCodexStorage(input.codexHome);
  return {
    status: failedFiles.length === 0 ? "succeeded" : "failed",
    checkedAt: new Date().toISOString(),
    restoredFiles,
    failedFiles,
    diagnostics: scan.diagnostics,
    evidence,
  };
}

function nextUndoUserSteps(status: RestoreUndoReport["result"]["status"], reportPath: string, safetyRoot: string): string[] {
  if (status === "preview") {
    return [
      "Review the undo targets, conflicts, blockers, and confirmation phrase before applying rollback.",
      "Run restore undo again with the shown confirmation token or phrase only if these targets are correct.",
    ];
  }
  if (status === "succeeded") {
    return [
      `Review the undo report at ${reportPath}.`,
      `Keep rollback safety backup ${safetyRoot} until Codex state is confirmed healthy.`,
      "Reopen Codex Desktop only after confirming undo verification succeeded.",
    ];
  }
  return [
    `Inspect the undo report or preview at ${reportPath}.`,
    `If a safety backup exists, keep ${safetyRoot} for manual recovery.`,
    "Do not reopen Codex Desktop as if undo succeeded until verification is clean.",
  ];
}

function confirmationTokenForUndo(input: {
  reportPath: string;
  backupRoot: string;
  operationId: string;
  targets: RestoreUndoTarget[];
}): string {
  const stable = {
    reportPath: input.reportPath,
    backupRoot: input.backupRoot,
    operationId: input.operationId,
    targets: input.targets.map((target) => ({
      sourcePath: target.sourcePath,
      backupPath: target.backupPath,
      backupSha256: target.backupSha256,
      backupSizeBytes: target.backupSizeBytes,
      action: target.action,
    })),
  };
  return `undo-${createHash("sha256").update(JSON.stringify(stable)).digest("hex").slice(0, 16)}`;
}

function confirmationMatchesUndo(
  options: RestoreUndoInternalOptions,
  expectedToken: string,
  expectedPhrase: string,
): boolean {
  return options.confirmationToken === expectedToken || options.confirmationPhrase === expectedPhrase;
}

function nextUserSteps(status: RestoreApplyResultStatus, reportPath: string, backupRoot: string): string[] {
  if (status === "succeeded") {
    return [
      "Review the restore report and backup manifest before reopening Codex Desktop.",
      "Reopen Codex Desktop only after confirming the report status is succeeded.",
      `Keep backup root ${backupRoot} until PR #8 undo/restore-from-backup support is available.`,
    ];
  }
  return [
    `Inspect the machine-readable report at ${reportPath}.`,
    `Keep backup root ${backupRoot}; it contains the pre-mutation state for manual recovery.`,
    "Do not reopen Codex Desktop as if restore succeeded until verification is clean.",
  ];
}

function plannedMutationKinds(item: RestorePlanItem): string[] {
  if (item.classification !== "archived-sqlite-thread") {
    return [];
  }
  return [
    "copy-rollout-to-active-session",
    "update-session-index",
    "sqlite-unarchive-thread",
    "rebuild-search-index",
  ];
}

function archivedSourcePath(item: RestorePlanItem): string | null {
  return item.plannedPaths.find((planned) => planned.kind === "archived-source-rollout" && planned.exists)?.path ?? null;
}

function activeTargetPathFor(item: RestorePlanItem): string | null {
  return item.plannedPaths.find((planned) => planned.kind === "active-session-target")?.path ?? null;
}

function sessionIndexRowForItem(item: RestorePlanItem, existing?: unknown): unknown {
  const activePath = activeTargetPathFor(item);
  const base = existing && typeof existing === "object" && !Array.isArray(existing)
    ? { ...(existing as Record<string, unknown>) }
    : {};
  const payload = base.payload && typeof base.payload === "object" && !Array.isArray(base.payload)
    ? { ...(base.payload as Record<string, unknown>) }
    : {};
  payload.id = item.threadId;
  payload.rollout_path = activePath;
  base.payload = payload;
  return base;
}

function sessionIndexRowMatches(codexHome: string, value: unknown, item: RestorePlanItem): boolean {
  const ids = candidateIds(value);
  if (ids.includes(item.threadId)) {
    return true;
  }
  const paths = candidatePaths(value).map((candidate) => resolveCodexPath(codexHome, candidate));
  return item.evidence.sourcePaths.some((sourcePath) => paths.includes(sourcePath));
}

function candidateIds(value: unknown): string[] {
  return compact([
    stringAt(value, ["id"]),
    stringAt(value, ["thread_id"]),
    stringAt(value, ["threadId"]),
    stringAt(value, ["payload", "id"]),
    stringAt(value, ["payload", "thread_id"]),
    stringAt(value, ["payload", "threadId"]),
  ]);
}

function candidatePaths(value: unknown): string[] {
  return compact([
    stringAt(value, ["rollout_path"]),
    stringAt(value, ["rolloutPath"]),
    stringAt(value, ["path"]),
    stringAt(value, ["file"]),
    stringAt(value, ["payload", "rollout_path"]),
    stringAt(value, ["payload", "rolloutPath"]),
    stringAt(value, ["session", "rollout_path"]),
    stringAt(value, ["session", "rolloutPath"]),
  ]);
}

function stringAt(value: unknown, keys: string[]): string | null {
  let current = value;
  for (const key of keys) {
    if (!current || typeof current !== "object" || Array.isArray(current) || !(key in current)) {
      return null;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === "string" && current.trim().length > 0 ? current : null;
}

function resolveCodexPath(codexHome: string, rolloutPath: string): string {
  return path.isAbsolute(rolloutPath) ? rolloutPath : path.join(codexHome, rolloutPath);
}

function tempSiblingPath(filePath: string): string {
  return path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  );
}

export async function detectCodexProcesses(): Promise<CodexProcessDetection> {
  if (process.platform === "win32") {
    return detectWindowsProcesses();
  }
  return detectPosixProcesses();
}

async function detectPosixProcesses(): Promise<CodexProcessDetection> {
  try {
    const { stdout } = await execFileAsync("ps", ["-axo", "pid=,comm=,args="], {
      timeout: 2500,
      maxBuffer: 1024 * 1024,
    });
    const processes = stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map(parsePosixProcessLine)
      .filter((processInfo): processInfo is CodexProcessInfo => processInfo !== null)
      .filter((processInfo) => processInfo.pid !== process.pid);

    return {
      status: "checked",
      processes,
      evidence: processes.length === 0
        ? ["Inspected local process table with ps; no Codex Desktop/app-server/codex processes matched."]
        : [`Inspected local process table with ps; ${processes.length} matching process(es) found.`],
    };
  } catch (error) {
    return {
      status: "unavailable",
      processes: [],
      evidence: [],
      error: errorMessage(error),
    };
  }
}

async function detectWindowsProcesses(): Promise<CodexProcessDetection> {
  try {
    const { stdout } = await execFileAsync("tasklist", ["/FO", "CSV", "/V"], {
      timeout: 2500,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    });
    const processes = stdout
      .split("\n")
      .slice(1)
      .map((line) => line.trim())
      .filter(Boolean)
      .map(parseWindowsTaskLine)
      .filter((processInfo): processInfo is CodexProcessInfo => processInfo !== null)
      .filter((processInfo) => processInfo.pid !== process.pid);

    return {
      status: "checked",
      processes,
      evidence: processes.length === 0
        ? ["Inspected local process table with tasklist; no Codex Desktop/app-server/codex processes matched."]
        : [`Inspected local process table with tasklist; ${processes.length} matching process(es) found.`],
    };
  } catch (error) {
    return {
      status: "unavailable",
      processes: [],
      evidence: [],
      error: errorMessage(error),
    };
  }
}

function parsePosixProcessLine(line: string): CodexProcessInfo | null {
  const match = line.match(/^(\d+)\s+(\S+)\s+(.*)$/);
  if (!match) {
    return null;
  }
  const [, pid, commandName, args] = match;
  return processMatch(Number(pid), `${commandName} ${args}`.trim());
}

function parseWindowsTaskLine(line: string): CodexProcessInfo | null {
  const columns = csvColumns(line);
  if (columns.length < 2) {
    return null;
  }
  return processMatch(Number(columns[1]), columns.join(" "));
}

function processMatch(pid: number, command: string): CodexProcessInfo | null {
  const normalized = command.toLowerCase();
  const currentScript = process.argv.join(" ").toLowerCase();
  if (currentScript && normalized.includes(currentScript)) {
    return null;
  }

  const patterns = [
    { label: "Codex Desktop", pattern: /\bcodex desktop\b|\bcodex\.app\b|\/codex(?:\.app)?\/contents\//i },
    { label: "Codex app-server", pattern: /\bapp-server\b.*\bcodex\b|\bcodex\b.*\bapp-server\b/i },
    { label: "codex process", pattern: /(^|[\\/\s])codex(\.exe)?($|[\s-])/i },
  ];
  for (const pattern of patterns) {
    if (pattern.pattern.test(command) && !normalized.includes("codex-archiver")) {
      return {
        pid: Number.isFinite(pid) ? pid : null,
        command,
        matchedBy: pattern.label,
      };
    }
  }
  return null;
}

function csvColumns(line: string): string[] {
  const columns: string[] = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      quoted = !quoted;
      continue;
    }
    if (char === "," && !quoted) {
      columns.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  columns.push(current);
  return columns;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
