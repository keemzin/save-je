export type ConflictActionType = "conflict_copy" | "keep_newer" | "keep_larger";

export interface SaveJeSettings {
  /**
   * IDrive e2 S3 endpoint, e.g. "abcd.sg01.idrivee2-8.com" or "https://abcd.sg01.idrivee2-8.com"
   */
  endpoint: string;
  /**
   * S3 region, e.g. "sg01", "us-east-1". Defaults to extracting from endpoint or "us-east-1"
   */
  region: string;
  /**
   * S3 Access Key ID
   */
  accessKeyId: string;
  /**
   * S3 Secret Access Key
   */
  secretAccessKey: string;
  /**
   * Bucket name on IDrive e2
   */
  bucketName: string;
  /**
   * Optional prefix folder within bucket (e.g. "notes/" or empty for root)
   */
  remotePrefix: string;
  /**
   * Auto-sync interval in minutes (0 = manual only)
   */
  autoSyncIntervalMinutes: number;
  /**
   * Automatically trigger a sync when Obsidian starts up
   */
  syncOnStartup: boolean;
  /**
   * If true, files deleted locally will be deleted on IDrive e2
   */
  deleteRemoteWhenDeletedLocally: boolean;
  /**
   * Strategy to resolve conflicts when both local and remote files were modified independently
   * - "conflict_copy": Creates a dated conflict copy of the local version and downloads remote version (safest)
   * - "keep_newer": Newer modification timestamp wins and overwrites older
   * - "keep_larger": Larger file size wins and overwrites smaller
   */
  conflictAction: ConflictActionType;
}

export const DEFAULT_SETTINGS: SaveJeSettings = {
  endpoint: "",
  region: "",
  accessKeyId: "",
  secretAccessKey: "",
  bucketName: "",
  remotePrefix: "",
  autoSyncIntervalMinutes: 0,
  syncOnStartup: false,
  deleteRemoteWhenDeletedLocally: true,
  conflictAction: "conflict_copy",
};

export interface RemoteFileInfo {
  key: string;        // Relative path in vault (without prefix)
  rawKey: string;     // Full key in S3 bucket (with prefix)
  size: number;
  mtime: number;      // Unix epoch milliseconds
  etag?: string;
}

export interface LocalFileInfo {
  path: string;
  size: number;
  mtime: number;      // Unix epoch milliseconds
}

export interface SyncedFileRecord {
  mtime: number;
  size: number;
  etag?: string;
}

export interface SyncStateData {
  lastSyncTime: number;
  files: Record<string, SyncedFileRecord>;
}

export interface SyncResult {
  uploaded: string[];
  downloaded: string[];
  deleted: string[];
  skipped: string[];
  conflicts: string[];
  errors: { path: string; error: string }[];
  durationMs: number;
}
