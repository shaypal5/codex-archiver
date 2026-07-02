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
