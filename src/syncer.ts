import { App, Notice, TFile, TFolder, normalizePath } from "obsidian";
import { IDriveS3Service } from "./s3Client";
import type {
  LocalFileInfo,
  RemoteFileInfo,
  SaveJeSettings,
  SyncResult,
  SyncStateData,
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
   * Main sync orchestration method with 3-way conflict detection.
   */
  async sync(onProgress?: (message: string) => void): Promise<SyncResult> {
    const startTime = Date.now();
    const result: SyncResult = {
      uploaded: [],
      downloaded: [],
      deleted: [],
      skipped: [],
      conflicts: [],
      errors: [],
      durationMs: 0,
    };

    onProgress?.("Listing remote files on IDrive e2...");
    const remoteList = await this.s3Service.listAllObjects();
    const remoteMap = new Map<string, RemoteFileInfo>();
    for (const item of remoteList) {
      remoteMap.set(normalizePath(item.key), item);
    }

    onProgress?.("Scanning local vault files...");
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

    // 1. Process all local files against remote and previous sync baseline
    for (const [path, localInfo] of localMap.entries()) {
      const remoteInfo = remoteMap.get(path);
      const prevRecord = prevSyncMap[path];

      if (remoteInfo) {
        if (!prevRecord) {
          // Both exist, but we have no recorded sync baseline
          const timeDiff = Math.abs(localInfo.mtime - remoteInfo.mtime);
          const sizeDiff = localInfo.size !== remoteInfo.size;
          if (timeDiff <= 1000 && !sizeDiff) {
            // Identical
            result.skipped.push(path);
            prevSyncMap[path] = {
              mtime: localInfo.mtime,
              size: localInfo.size,
              etag: remoteInfo.etag,
            };
          } else {
            // Both exist with differing attributes and no baseline -> Conflict!
            toConflict.push(path);
          }
        } else {
          // 3-way check against baseline
          const localMtimeDiff = Math.abs(localInfo.mtime - prevRecord.mtime);
          const localSizeDiff = localInfo.size !== prevRecord.size;
          const localChanged = localMtimeDiff > 1000 || localSizeDiff;

          const remoteEtagChanged =
            remoteInfo.etag && prevRecord.etag
              ? remoteInfo.etag !== prevRecord.etag
              : false;
          const remoteMtimeDiff = Math.abs(remoteInfo.mtime - prevRecord.mtime);
          const remoteSizeDiff = remoteInfo.size !== prevRecord.size;
          const remoteChanged =
            remoteEtagChanged || remoteMtimeDiff > 1000 || remoteSizeDiff;

          if (!localChanged && !remoteChanged) {
            // Neither changed since last sync
            result.skipped.push(path);
          } else if (localChanged && !remoteChanged) {
            // Only local changed -> safe to upload
            toUpload.push(path);
          } else if (!localChanged && remoteChanged) {
            // Only remote changed -> safe to download
            toDownload.push(path);
          } else {
            // Both changed independently since last sync -> CONFLICT!
            toConflict.push(path);
          }
        }
      } else {
        // Local exists, remote does not
        if (
          prevRecord &&
          remoteMap.size > 0 &&
          this.settings.deleteRemoteWhenDeletedLocally
        ) {
          const localMtimeDiff = Math.abs(localInfo.mtime - prevRecord.mtime);
          const localSizeDiff = localInfo.size !== prevRecord.size;
          const localChanged = localMtimeDiff > 1000 || localSizeDiff;

          if (localChanged) {
            // Conflict: Remote deleted it, but local was modified! Keep local by re-uploading
            toUpload.push(path);
          } else {
            // Deleted on remote -> delete locally
            toDeleteLocal.push(path);
          }
        } else {
          // Newly created locally -> upload
          toUpload.push(path);
        }
      }
    }

    // 2. Process remote files that do not exist locally
    for (const [path, remoteInfo] of remoteMap.entries()) {
      if (!localMap.has(path)) {
        const prevRecord = prevSyncMap[path];
        if (prevRecord) {
          const remoteEtagChanged =
            remoteInfo.etag && prevRecord.etag
              ? remoteInfo.etag !== prevRecord.etag
              : false;
          const remoteMtimeDiff = Math.abs(remoteInfo.mtime - prevRecord.mtime);
          const remoteSizeDiff = remoteInfo.size !== prevRecord.size;
          const remoteChanged =
            remoteEtagChanged || remoteMtimeDiff > 1000 || remoteSizeDiff;

          if (remoteChanged) {
            // Conflict: Local deleted it, but remote was updated! Safe to re-download
            toDownload.push(path);
          } else if (this.settings.deleteRemoteWhenDeletedLocally) {
            // Deleted locally -> delete remote
            toDeleteRemote.push(path);
          } else {
            toDownload.push(path);
          }
        } else {
          // Newly created on remote -> download
          toDownload.push(path);
        }
      }
    }

    // 3. Resolve conflicts according to user preference
    const conflictAction = this.settings.conflictAction || "conflict_copy";

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
      toConflict = []; // Routed to upload/download queues
    }

    const totalOps =
      toConflict.length +
      toDeleteRemote.length +
      toDeleteLocal.length +
      toDownload.length +
      toUpload.length;

    let completedOps = 0;
    const reportProgress = (action: string, path: string) => {
      completedOps++;
      onProgress?.(
        `${action} (${completedOps}/${totalOps}): ${path}`
      );
    };

    // 4. Perform Remote Deletions
    for (const path of toDeleteRemote) {
      try {
        reportProgress("Deleting remote", path);
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
        reportProgress("Deleting local", path);
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

    // 6. Perform Conflict Copy Resolutions (Default & Safest)
    for (const path of toConflict) {
      try {
        reportProgress("Resolving conflict", path);
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
            : remoteInfo?.mtime || Date.now();

        prevSyncMap[path] = {
          mtime: originalMtime,
          size: remoteData.byteLength,
          etag: remoteInfo?.etag,
        };

        prevSyncMap[conflictPath] = {
          mtime: conflictMtime,
          size: localData.byteLength,
          etag: uploadConflictRes?.etag,
        };

        result.downloaded.push(path);
        result.uploaded.push(conflictPath);

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
        reportProgress("Downloading", path);
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
        const mtime =
          updatedFile instanceof TFile
            ? updatedFile.stat.mtime
            : remoteInfo?.mtime || Date.now();
        prevSyncMap[path] = {
          mtime,
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
        reportProgress("Uploading", path);
        const file = this.app.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile)) {
          return;
        }

        const data = await this.app.vault.readBinary(file);
        const uploadRes = await this.s3Service.uploadFile(path, data, file.stat.mtime);

        prevSyncMap[path] = {
          mtime: file.stat.mtime,
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
