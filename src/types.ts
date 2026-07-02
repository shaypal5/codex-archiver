export type StorageKind =
  | "active-session"
  | "archived-session"
  | "sqlite-only"
  | "jsonl-only"
  | "mixed";

export type RestoreStatus =
  | "active"
  | "archived"
  | "hidden"
  | "orphaned"
  | "restorable"
  | "unknown";

export interface ThreadRecord {
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
  transcriptText?: string;
  restoreStatus: RestoreStatus;
  sourcePaths: string[];
}

export interface ScanStats {
  totalThreads: number;
  totalProjects: number;
  activeThreads: number;
  archivedThreads: number;
  hiddenThreads: number;
  orphanedThreads: number;
}

export interface Diagnostic {
  level: "info" | "warning" | "error";
  message: string;
}

export interface ScanResult {
  codexHome: string;
  scannedAt: string;
  stats: ScanStats;
  diagnostics: Diagnostic[];
  threads: ThreadRecord[];
  totalMatches?: number;
  limit?: number;
  offset?: number;
}

export interface ThreadQuery {
  title?: string;
  content?: string;
  cwd?: string;
  status?: RestoreStatus | "all";
  limit?: number;
  offset?: number;
}

export interface SearchIndexMeta {
  codexHome: string;
  indexPath: string;
  rebuiltAt: string | null;
  sourceFingerprint: string | null;
  stats: ScanStats;
  diagnostics: Diagnostic[];
}

export type VisibilityProbeName =
  | "session-index"
  | "search-index"
  | "codex-resume"
  | "codex-app-server";

export type VisibilityProbeStatus =
  | "available"
  | "unavailable"
  | "failed"
  | "timeout"
  | "skipped";

export interface VisibilityProbeReport {
  name: VisibilityProbeName;
  status: VisibilityProbeStatus;
  message: string;
  durationMs?: number;
  visibleCount?: number;
  warnings?: string[];
}

export interface ThreadVisibilityRecord {
  id: string;
  title: string | null;
  cwd: string | null;
  updatedAt: number | null;
  restoreStatus: RestoreStatus;
  activeInLocalStorage: boolean;
  archivedInLocalStorage: boolean;
  rolloutFileExists: boolean;
  rolloutFileMissing: boolean;
  sqlitePresent: boolean;
  sessionIndexPresent: boolean | null;
  indexedPresent: boolean;
  codexResumeVisible: boolean | null;
  appServerVisible: boolean | null;
  sourcePaths: string[];
}

export interface VisibilitySummary {
  totalThreads: number;
  activeInLocalStorage: number;
  archivedInLocalStorage: number;
  rolloutFileMissing: number;
  sqlitePresent: number;
  sessionIndexPresent: number | null;
  indexedPresent: number;
  codexResumeVisible: number | null;
  appServerVisible: number | null;
}

export interface VisibilityDiagnostics {
  codexHome: string;
  indexPath: string;
  generatedAt: string;
  probes: VisibilityProbeReport[];
  diagnostics: Diagnostic[];
  summary: VisibilitySummary;
  threads: ThreadVisibilityRecord[];
}

export type RestorePlanClassification =
  | "archived-sqlite-thread"
  | "jsonl-only-archived-thread"
  | "ui-hidden-active-thread"
  | "missing-rollout-source"
  | "already-active"
  | "not-found"
  | "unsupported";

export type RestorePlanActionability =
  | "future-apply"
  | "diagnostic-only"
  | "blocked"
  | "no-op"
  | "rejected";

export type RestorePreflightStatus =
  | "passed"
  | "warning"
  | "failed"
  | "unknown";

export type RestoreProcessCheckMode =
  | "warn"
  | "strict"
  | "skip";

export interface RestorePlanEvidence {
  threadFound: boolean;
  restoreStatus: RestoreStatus | null;
  storageKind: StorageKind | null;
  archived: boolean | null;
  rolloutPath: string | null;
  sourcePaths: string[];
  existsOnDisk: boolean | null;
  hasActiveRolloutPath: boolean;
  hasArchivedRolloutPath: boolean;
  sqlitePresent: boolean;
}

export interface RestorePlanItem {
  threadId: string;
  title: string | null;
  cwd: string | null;
  classification: RestorePlanClassification;
  actionability: RestorePlanActionability;
  readOnly: true;
  reasons: string[];
  evidence: RestorePlanEvidence;
  futureActions: string[];
  backupPreview: string[];
  mutationPreview: string[];
  plannedPaths: RestorePlanPlannedPath[];
  validations: RestorePlanValidation[];
}

export interface RestorePlanPlannedPath {
  kind:
    | "state-db"
    | "session-index"
    | "source-rollout"
    | "archived-source-rollout"
    | "active-session-target"
    | "archive-session-target"
    | "search-index";
  path: string;
  exists: boolean | null;
  requiredBeforeApply: boolean;
}

export interface RestorePlanValidation {
  id: string;
  status: RestorePreflightStatus;
  message: string;
  evidence: string[];
  remediation: string;
}

export interface RestorePlanImpactPreview {
  selectedCount: number;
  futureApplyCount: number;
  diagnosticOnlyCount: number;
  blockedCount: number;
  noopCount: number;
  rejectedCount: number;
  wouldMutateCodexHome: boolean;
  wouldCreateBackups: boolean;
  mutationTargetsIfApplied: string[];
}

export interface RestorePlanBackupPreview {
  requiredBeforeApply: boolean;
  createdByThisPlan: false;
  backupRootPattern: string;
  plannedBackupRoot: string;
  targetsIfApplied: string[];
  targets: RestorePlanBackupTarget[];
  notes: string[];
}

export interface RestorePlanBackupTarget {
  sourcePath: string;
  backupPath: string;
  kind: RestorePlanPlannedPath["kind"];
  exists: boolean;
  sizeBytes: number | null;
  mtimeMs: number | null;
  sha256: string | null;
  hashStatus: "sha256" | "skipped-large-file" | "missing" | "unavailable";
  requiredBeforeApply: boolean;
}

export interface RestorePlanPreflightSummary {
  passed: number;
  warning: number;
  failed: number;
  unknown: number;
  hasFailures: boolean;
  hasWarnings: boolean;
}

export interface RestorePlanPreflight {
  processCheckMode: RestoreProcessCheckMode;
  checks: RestorePlanPreflightCheck[];
  summary: RestorePlanPreflightSummary;
}

export interface RestorePlanPreflightCheck {
  id: string;
  label: string;
  status: RestorePreflightStatus;
  blocking: boolean;
  evidence: string[];
  remediation: string;
}

export interface RestorePlanReportPreview {
  schemaVersion: 1;
  reportType: "restore-apply-report";
  readOnlyPreview: true;
  wouldWriteReport: false;
  plannedReportPath: string;
  planHash: string;
  confirmationToken: string;
  confirmationPhrase: string;
  requiredFields: string[];
  itemFields: string[];
  undoFields: string[];
  notes: string[];
}

export interface RestorePlan {
  codexHome: string;
  indexPath: string;
  generatedAt: string;
  selectedThreadIds: string[];
  readOnly: true;
  mutationAllowed: false;
  diagnostics: Diagnostic[];
  impactPreview: RestorePlanImpactPreview;
  preflight: RestorePlanPreflight;
  backupPreview: RestorePlanBackupPreview;
  reportPreview: RestorePlanReportPreview;
  items: RestorePlanItem[];
}

export type RestoreApplyResultStatus =
  | "succeeded"
  | "blocked"
  | "failed"
  | "partial";

export interface RestoreApplyOptions {
  codexHome?: string;
  indexPath?: string;
  selectedThreadIds: string[];
  confirmationToken?: string;
  confirmationPhrase?: string;
  processCheckMode?: RestoreProcessCheckMode;
}

export interface RestoreApplyBackupManifest {
  backupRoot: string;
  manifestPath: string;
  createdAt: string;
  targets: RestorePlanBackupTarget[];
}

export interface RestoreApplyMutation {
  threadId: string;
  kind:
    | "copy-rollout-to-active-session"
    | "update-session-index"
    | "sqlite-unarchive-thread"
    | "rebuild-search-index";
  targetPath: string;
  status: "attempted" | "applied" | "skipped" | "rolled-back" | "failed";
  message: string;
}

export interface RestoreApplyItemReport {
  threadId: string;
  classification: RestorePlanClassification;
  actionability: RestorePlanActionability;
  selectedForApply: boolean;
  sourcePaths: string[];
  plannedMutations: string[];
  appliedMutations: RestoreApplyMutation[];
  warnings: string[];
  errors: string[];
}

export interface RestoreApplyVerification {
  status: RestoreApplyResultStatus;
  checkedAt: string;
  restoredThreadIds: string[];
  failedThreadIds: string[];
  diagnostics: Diagnostic[];
  evidence: string[];
}

export interface RestoreApplyReport {
  schemaVersion: 1;
  reportType: "restore-apply-report";
  operationId: string;
  startedAt: string;
  completedAt: string;
  codexHome: string;
  indexPath: string;
  selectedThreadIds: string[];
  planHash: string;
  confirmationToken: string;
  preflight: RestorePlanPreflight;
  backupManifest: RestoreApplyBackupManifest;
  items: RestoreApplyItemReport[];
  mutations: RestoreApplyMutation[];
  verification: RestoreApplyVerification;
  result: {
    status: RestoreApplyResultStatus;
    message: string;
    reportPath: string;
    backupRoot: string;
  };
  nextUserSteps: string[];
  limits: string[];
}
