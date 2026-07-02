import path from "node:path";
import { defaultCodexHome, defaultIndexPath, expandHome } from "./paths.js";
import { scanCodexStorage } from "./scanner.js";
import type {
  Diagnostic,
  RestorePlan,
  RestorePlanActionability,
  RestorePlanBackupPreview,
  RestorePlanClassification,
  RestorePlanEvidence,
  RestorePlanImpactPreview,
  RestorePlanItem,
  ThreadRecord,
} from "./types.js";

export interface RestorePlanOptions {
  codexHome?: string;
  indexPath?: string;
  selectedThreadIds: string[];
}

const STATE_DB = "state_5.sqlite";
const SESSION_INDEX = "session_index.jsonl";

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
  });
}

export function createRestorePlanFromThreads(input: {
  codexHome: string;
  indexPath: string;
  diagnostics?: Diagnostic[];
  threads: ThreadRecord[];
  selectedThreadIds: string[];
}): RestorePlan {
  const codexHome = path.resolve(input.codexHome);
  const indexPath = path.resolve(input.indexPath);
  const selectedThreadIds = normalizeSelectedThreadIds(input.selectedThreadIds);
  const byId = new Map(input.threads.map((thread) => [thread.id, thread]));
  const items = selectedThreadIds.map((threadId) =>
    planThread({ codexHome, indexPath, threadId, thread: byId.get(threadId) }),
  );
  const backupPreview = buildBackupPreview(indexPath, items);

  return {
    codexHome,
    indexPath,
    generatedAt: new Date().toISOString(),
    selectedThreadIds,
    readOnly: true,
    mutationAllowed: false,
    diagnostics: input.diagnostics ?? [],
    impactPreview: buildImpactPreview(items),
    backupPreview,
    items,
  };
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
    };
  }

  const evidence = buildEvidence(codexHome, thread);
  const stateDbPath = path.join(codexHome, STATE_DB);
  const sessionIndexPath = path.join(codexHome, SESSION_INDEX);
  const sourceBackups = thread.sourcePaths.length > 0 ? thread.sourcePaths : compact([thread.rolloutPath]);
  const standardBackups = [stateDbPath, sessionIndexPath, ...sourceBackups, indexPath];

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
      backupPreview: standardBackups,
      mutationPreview: [stateDbPath, sessionIndexPath, indexPath],
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
      backupPreview: standardBackups,
      mutationPreview: [stateDbPath, sessionIndexPath, indexPath],
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

function buildBackupPreview(indexPath: string, items: RestorePlanItem[]): RestorePlanBackupPreview {
  return {
    requiredBeforeApply: items.some((item) => item.backupPreview.length > 0),
    createdByThisPlan: false,
    backupRootPattern: path.join(
      path.dirname(indexPath),
      "backups",
      "restore-YYYYMMDD-HHMMSS",
    ),
    targetsIfApplied: unique(items.flatMap((item) => item.backupPreview)),
    notes: [
      "This restore plan is a dry run and does not create backups.",
      "A future apply phase must create timestamped backups before mutating Codex state.",
      "The future apply phase must use a transaction-backed SQLite update plan and emit a machine-readable report.",
    ],
  };
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

function compact(values: Array<string | null>): string[] {
  return values.filter((value): value is string => typeof value === "string" && value.length > 0);
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}
