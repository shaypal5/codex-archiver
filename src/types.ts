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
}

export interface ThreadQuery {
  title?: string;
  content?: string;
  cwd?: string;
  status?: RestoreStatus | "all";
}
