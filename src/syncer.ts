import { App, Notice, TFile, TFolder, normalizePath } from "obsidian";
import { IDriveS3Service } from "./s3Client";
import type {
  LocalFileInfo,
  RemoteFileInfo,
  SaveJeSettings,
  SyncProgressUpdate,
  SyncResult,
  SyncStateData,
  SyncedFileRecord,
} from "./types";

/**
 * Concurrency helper to run async tasks with a maximum concurrency limit.
 */
async function runConcurrent<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>
): Promise<void> {
  const executing: Promise<void>[] = [];
  for (const item of items) {
    const p = Promise.resolve().then(() => fn(item));
    executing.push(p);

    if (limit <= items.length) {
      const e: Promise<any> = p.then(() => executing.splice(executing.indexOf(e), 1));
    }
    if (executing.length >= limit) {
      await Promise.race(executing);
    }
  }
  await Promise.all(executing);
}

/**
 * Recursively ensures that parent folders exist in the Obsidian vault before writing a file.
 */
async function ensureFolderExists(app: App, filePath: string): Promise<void> {
  const parts = filePath.split("/");
  parts.pop(); // remove file name
  if (parts.length === 0) return;

  let currentPath = "";
  for (const part of parts) {
    currentPath = currentPath ? `${currentPath}/${part}` : part;
    const normalized = normalizePath(currentPath);
    const existing = app.vault.getAbstractFileByPath(normalized);
    if (!existing) {
      try {
        await app.vault.createFolder(normalized);
      } catch (err: any) {
        // Folder might have been created concurrently, check again
        if (!app.vault.getAbstractFileByPath(normalized)) {
          throw err;
        }
      }
    }
  }
}

/**
 * Generates a non-colliding conflict copy filepath with a timestamp.
 * e.g. "notes/daily.md" -> "notes/daily.conflict-20260910-103500.md"
 */
function generateConflictPath(app: App, filePath: string): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const timestamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(
    now.getDate()
  )}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;

  const dotIndex = filePath.lastIndexOf(".");
  const ext = dotIndex !== -1 ? filePath.slice(dotIndex) : "";
  const base = dotIndex !== -1 ? filePath.slice(0, dotIndex) : filePath;

  let candidate = `${base}.conflict-${timestamp}${ext}`;
  let counter = 1;
  while (app.vault.getAbstractFileByPath(normalizePath(candidate))) {
    candidate = `${base}.conflict-${timestamp}-${counter}${ext}`;
    counter++;
  }
  return normalizePath(candidate);
}

/**
 * Checks if a local file matches the baseline recorded at the last sync.
 */
function isLocalEqual(prev: SyncedFileRecord, local: LocalFileInfo): boolean {
  if (prev.size !== local.size) return false;
  const prevLocalTime = prev.mtimeLocal ?? prev.mtime ?? 0;
  return Math.abs(local.mtime - prevLocalTime) <= 1000;
}

/**
 * Checks if a remote file on S3 matches the baseline recorded at the last sync.
 */
function isRemoteEqual(prev: SyncedFileRecord, remote: RemoteFileInfo): boolean {
  if (prev.size !== remote.size) return false;
  if (prev.etag && remote.etag) {
    return prev.etag === remote.etag;
  }
  const prevRemoteTime = prev.mtimeRemote ?? prev.mtime ?? 0;
  return Math.abs(remote.mtime - prevRemoteTime) <= 2000;
}

export class VaultSyncer {
  private app: App;
  private settings: SaveJeSettings;
  private s3Service: IDriveS3Service;
  private syncState: SyncStateData;
  private saveStateCallback: (state: SyncStateData) => Promise<void>;

  constructor(
    app: App,
    settings: SaveJeSettings,
    s3Service: IDriveS3Service,
    syncState: SyncStateData,
    saveStateCallback: (state: SyncStateData) => Promise<void>
  ) {
    this.app = app;
    this.settings = settings;
    this.s3Service = s3Service;
    this.syncState = syncState;
    this.saveStateCallback = saveStateCallback;
  }

  /**
   * Main sync orchestration method with 3-way baseline synchronization.
   */
  async sync(
    onProgress?: (update: SyncProgressUpdate | string) => void
  ): Promise<SyncResult> {
    const startTime = Date.now();
    const result: SyncResult = {
      uploaded: [],
      downloaded: [],
      deleted: [],
      skipped: [],
      conflicts: [],
      conflictPairs: [],
      errors: [],
      durationMs: 0,
    };

    const emitProgress = (update: SyncProgressUpdate | string) => {
      onProgress?.(update);
    };

    emitProgress({
      stage: "listing",
      completedOps: 0,
      totalOps: 0,
      totalPercent: 5,
      message: "Listing remote files on IDrive e2...",
    });
    const remoteList = await this.s3Service.listAllObjects();
    const remoteMap = new Map<string, RemoteFileInfo>();
    for (const item of remoteList) {
      remoteMap.set(normalizePath(item.key), item);
    }

    emitProgress({
      stage: "listing",
      completedOps: 0,
      totalOps: 0,
      totalPercent: 12,
      message: "Scanning local vault files...",
    });
    const localFiles = this.app.vault.getFiles();
    const localMap = new Map<string, LocalFileInfo>();
    for (const f of localFiles) {
      const norm = normalizePath(f.path);
      localMap.set(norm, {
        path: norm,
        size: f.stat.size,
        mtime: f.stat.mtime,
      });
    }

    const prevSyncMap = this.syncState.files || {};
    const toUpload: string[] = [];
    const toDownload: string[] = [];
    let toConflict: string[] = [];
    const toDeleteRemote: string[] = [];
    const toDeleteLocal: string[] = [];

    // 1. Process all local files against remote files and last-sync baseline
    for (const [path, localInfo] of localMap.entries()) {
      const remoteInfo = remoteMap.get(path);
      const prevRecord = prevSyncMap[path];

      if (remoteInfo) {
        if (!prevRecord) {
          // No baseline recorded yet
          const sizeDiff = localInfo.size !== remoteInfo.size;
          const timeDiff = Math.abs(localInfo.mtime - remoteInfo.mtime);
          if (!sizeDiff && timeDiff <= 2000) {
            // Already identical
            result.skipped.push(path);
            prevSyncMap[path] = {
              mtimeLocal: localInfo.mtime,
              mtimeRemote: remoteInfo.mtime,
              size: localInfo.size,
              etag: remoteInfo.etag,
            };
          } else {
            // Both exist with differing attributes and no shared history -> Conflict
            toConflict.push(path);
          }
        } else {
          // Backward-compatibility healing for records from older versions lacking mtimeRemote
          if (prevRecord.mtimeRemote === undefined && prevRecord.mtimeLocal === undefined) {
            if (localInfo.size === remoteInfo.size && localInfo.size === prevRecord.size) {
              prevRecord.mtimeLocal = localInfo.mtime;
              prevRecord.mtimeRemote = remoteInfo.mtime;
              prevRecord.etag = remoteInfo.etag;
            }
          }

          const localEqual = isLocalEqual(prevRecord, localInfo);
          const remoteEqual = isRemoteEqual(prevRecord, remoteInfo);

          if (localEqual && remoteEqual) {
            // Neither changed since last sync -> Skip
            result.skipped.push(path);
            // Refresh baseline
            prevRecord.mtimeLocal = localInfo.mtime;
            prevRecord.mtimeRemote = remoteInfo.mtime;
            prevRecord.size = localInfo.size;
            if (remoteInfo.etag) prevRecord.etag = remoteInfo.etag;
          } else if (!localEqual && remoteEqual) {
            // Only local was modified -> Safe to upload
            toUpload.push(path);
          } else if (localEqual && !remoteEqual) {
            // Only remote was modified -> Safe to download
            toDownload.push(path);
          } else {
            // Both changed independently -> CONFLICT!
            toConflict.push(path);
          }
        }
      } else {
        // Local exists, remote does not
        if (prevRecord && remoteMap.size > 0) {
          const localEqual = isLocalEqual(prevRecord, localInfo);
          if (localEqual) {
            // Local was not touched -> Deleted on remote
            if (this.settings.deleteRemoteWhenDeletedLocally) {
              toDeleteLocal.push(path);
            }
          } else {
            // Local was modified after remote deletion -> Keep local by re-uploading
            toUpload.push(path);
          }
        } else {
          // Newly created locally -> Upload
          toUpload.push(path);
        }
      }
    }

    // 2. Process remote files that do not exist locally
    for (const [path, remoteInfo] of remoteMap.entries()) {
      if (!localMap.has(path)) {
        const prevRecord = prevSyncMap[path];
        if (prevRecord) {
          const remoteEqual = isRemoteEqual(prevRecord, remoteInfo);
          if (remoteEqual) {
            // Remote was not touched -> Deleted locally
            if (this.settings.deleteRemoteWhenDeletedLocally) {
              toDeleteRemote.push(path);
            }
          } else {
            // Remote was modified after local deletion -> Re-download
            toDownload.push(path);
          }
        } else {
          // Newly created on remote -> Download
          toDownload.push(path);
        }
      }
    }

    // 3. Resolve conflicts according to user preference
    const conflictAction = this.settings.conflictAction || "keep_newer";

    if (conflictAction === "keep_newer" || conflictAction === "keep_larger") {
      for (const path of toConflict) {
        result.conflicts.push(path);
        const localInfo = localMap.get(path);
        const remoteInfo = remoteMap.get(path);
        if (!localInfo || !remoteInfo) continue;

        const preferLocal =
          conflictAction === "keep_newer"
            ? localInfo.mtime >= remoteInfo.mtime
            : localInfo.size >= remoteInfo.size;

        if (preferLocal) {
          toUpload.push(path);
        } else {
          toDownload.push(path);
        }
      }
      toConflict = []; // Routed to upload or download queues
    }

    const totalOps =
      toConflict.length +
      toDeleteRemote.length +
      toDeleteLocal.length +
      toDownload.length +
      toUpload.length;

    let completedOps = 0;
    const reportProgress = (stage: SyncProgressUpdate["stage"], path: string) => {
      completedOps++;
      const totalPercent =
        totalOps > 0 ? Math.round((completedOps / totalOps) * 100) : 100;
      emitProgress({
        stage,
        currentFile: path,
        completedOps,
        totalOps,
        totalPercent,
        message: `${stage.charAt(0).toUpperCase() + stage.slice(1)} (${completedOps}/${totalOps}): ${path}`,
      });
    };

    // 4. Perform Remote Deletions
    for (const path of toDeleteRemote) {
      try {
        reportProgress("deleting", path);
        await this.s3Service.deleteFile(path);
        delete prevSyncMap[path];
        result.deleted.push(path);
      } catch (err: any) {
        result.errors.push({ path, error: err.message || String(err) });
      }
    }

    // 5. Perform Local Deletions
    for (const path of toDeleteLocal) {
      try {
        reportProgress("deleting", path);
        const f = this.app.vault.getAbstractFileByPath(path);
        if (f instanceof TFile) {
          await this.app.vault.trash(f, false);
        }
        delete prevSyncMap[path];
        result.deleted.push(path);
      } catch (err: any) {
        result.errors.push({ path, error: err.message || String(err) });
      }
    }

    // 6. Perform Conflict Copy Resolutions (If conflictAction === "conflict_copy")
    for (const path of toConflict) {
      try {
        reportProgress("conflict", path);
        result.conflicts.push(path);

        const localFile = this.app.vault.getAbstractFileByPath(path);
        if (!(localFile instanceof TFile)) {
          continue;
        }

        // Read current local file content
        const localData = await this.app.vault.readBinary(localFile);

        // Download remote file content
        const remoteData = await this.s3Service.downloadFile(path);
        const remoteInfo = remoteMap.get(path);

        // Create conflict copy with local data
        const conflictPath = generateConflictPath(this.app, path);
        await ensureFolderExists(this.app, conflictPath);
        await this.app.vault.createBinary(conflictPath, localData);

        // Overwrite original path with remote data
        await this.app.vault.modifyBinary(localFile, remoteData);

        // Upload conflict copy to S3 so other devices also have access
        const conflictFile = this.app.vault.getAbstractFileByPath(conflictPath);
        const conflictMtime =
          conflictFile instanceof TFile ? conflictFile.stat.mtime : Date.now();
        const uploadConflictRes = await this.s3Service.uploadFile(
          conflictPath,
          localData,
          conflictMtime
        );

        // Update baseline sync records for both files
        const updatedOriginal = this.app.vault.getAbstractFileByPath(path);
        const originalMtime =
          updatedOriginal instanceof TFile
            ? updatedOriginal.stat.mtime
            : Date.now();

        prevSyncMap[path] = {
          mtimeLocal: originalMtime,
          mtimeRemote: remoteInfo?.mtime || Date.now(),
          size: remoteData.byteLength,
          etag: remoteInfo?.etag,
        };

        prevSyncMap[conflictPath] = {
          mtimeLocal: conflictMtime,
          mtimeRemote: Date.now(),
          size: localData.byteLength,
          etag: uploadConflictRes?.etag,
        };

        result.downloaded.push(path);
        result.uploaded.push(conflictPath);
        result.conflictPairs.push({ originalPath: path, conflictPath });

        new Notice(
          `Save-Je: Conflict in "${path}". Created conflict copy "${conflictPath}".`,
          8000
        );
      } catch (err: any) {
        result.errors.push({
          path,
          error: `Conflict resolution failed: ${err.message || String(err)}`,
        });
      }
    }

    // 7. Perform Downloads (Concurrency limit: 4)
    await runConcurrent(toDownload, 4, async (path) => {
      try {
        reportProgress("downloading", path);
        const data = await this.s3Service.downloadFile(path);
        const remoteInfo = remoteMap.get(path);

        await ensureFolderExists(this.app, path);

        const existing = this.app.vault.getAbstractFileByPath(path);
        if (existing instanceof TFile) {
          await this.app.vault.modifyBinary(existing, data);
        } else {
          await this.app.vault.createBinary(path, data);
        }

        // Update record
        const updatedFile = this.app.vault.getAbstractFileByPath(path);
        const mtimeLocal =
          updatedFile instanceof TFile
            ? updatedFile.stat.mtime
            : Date.now();

        prevSyncMap[path] = {
          mtimeLocal,
          mtimeRemote: remoteInfo?.mtime || Date.now(),
          size: data.byteLength,
          etag: remoteInfo?.etag,
        };
        result.downloaded.push(path);
      } catch (err: any) {
        result.errors.push({ path, error: err.message || String(err) });
      }
    });

    // 8. Perform Uploads (Concurrency limit: 4)
    await runConcurrent(toUpload, 4, async (path) => {
      try {
        const file = this.app.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile)) {
          return;
        }

        const data = await this.app.vault.readBinary(file);
        const uploadRes = await this.s3Service.uploadFile(
          path,
          data,
          file.stat.mtime,
          (loaded, total) => {
            const filePercent =
              total > 0 ? Math.round((loaded / total) * 100) : 100;
            const opProgress = completedOps + (total > 0 ? loaded / total : 0);
            const totalPercent =
              totalOps > 0
                ? Math.min(100, Math.round((opProgress / totalOps) * 100))
                : 0;
            emitProgress({
              stage: "uploading",
              currentFile: path,
              completedOps,
              totalOps,
              fileLoadedBytes: loaded,
              fileTotalBytes: total,
              filePercent,
              totalPercent,
              message: `Uploading (${completedOps + 1}/${totalOps}): ${path}`,
            });
          }
        );

        completedOps++;
        prevSyncMap[path] = {
          mtimeLocal: file.stat.mtime,
          mtimeRemote: Date.now(),
          size: data.byteLength,
          etag: uploadRes?.etag,
        };
        result.uploaded.push(path);
      } catch (err: any) {
        result.errors.push({ path, error: err.message || String(err) });
      }
    });

    // Save updated state
    this.syncState.lastSyncTime = Date.now();
    this.syncState.files = prevSyncMap;
    await this.saveStateCallback(this.syncState);

    result.durationMs = Date.now() - startTime;
    return result;
  }
}

/**
 * Scans the vault for any conflict copy files (*.conflict-YYYYMMDD-HHmmss.ext)
 * and pairs them with their original files.
 */
export function findVaultConflicts(app: App): {
  originalFile: TFile;
  conflictFile: TFile;
}[] {
  const files = app.vault.getFiles();
  const results: { originalFile: TFile; conflictFile: TFile }[] = [];
  const conflictRegex = /^(.*)\.conflict-\d{8}-\d{6}(?:-\d+)?(\.[^.]+)$/;

  for (const file of files) {
    const match = file.path.match(conflictRegex);
    if (match) {
      const originalPath = `${match[1]}${match[2]}`;
      const originalFile = app.vault.getAbstractFileByPath(originalPath);
      if (originalFile instanceof TFile) {
        results.push({ originalFile, conflictFile: file });
      }
    }
  }
  return results;
}
