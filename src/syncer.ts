import { App, Notice, Platform, TFile, TFolder, normalizePath } from "obsidian";
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
  return Math.abs(local.mtime - prevLocalTime) <= 2000;
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

        // Local file on this device remains untouched as the local version!
        const localMtime = localFile.stat.mtime;
        const localSize = localFile.stat.size;

        // Generate conflict copy path and download the REMOTE file directly into it
        const conflictPath = generateConflictPath(this.app, path);
        const remoteInfo = remoteMap.get(path);
        const { size: downloadedConflictSize, mtimeLocal: conflictMtime } =
          await this.downloadFileToVault(conflictPath, remoteInfo);

        // Upload conflict copy to S3 so other devices also have access to the conflict file
        const conflictFile = this.app.vault.getAbstractFileByPath(conflictPath);
        let uploadConflictEtag: string | undefined;
        if (conflictFile instanceof TFile) {
          const conflictData = await this.app.vault.readBinary(conflictFile);
          const uploadConflictRes = await this.s3Service.uploadFile(
            conflictPath,
            conflictData,
            conflictMtime
          );
          uploadConflictEtag = uploadConflictRes?.etag;
        }

        // Update baseline sync records for both files:
        // 1) Original path stays local (mtimeLocal is current localFile, mtimeRemote is remote's current)
        prevSyncMap[path] = {
          mtimeLocal: localMtime,
          mtimeRemote: remoteInfo?.mtime || Date.now(),
          size: localSize,
          etag: remoteInfo?.etag,
        };

        // 2) Conflict copy record
        prevSyncMap[conflictPath] = {
          mtimeLocal: conflictMtime,
          mtimeRemote: Date.now(),
          size: downloadedConflictSize,
          etag: uploadConflictEtag,
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

    // 7. Perform Downloads (Concurrency limit: 1 on mobile to prevent memory/socket exhaustion, 2 on desktop)
    const downloadConcurrency = Platform.isMobile ? 1 : 2;
    await runConcurrent(toDownload, downloadConcurrency, async (path) => {
      try {
        const remoteInfo = remoteMap.get(path);
        const { size, mtimeLocal } = await this.downloadFileToVault(
          path,
          remoteInfo,
          (loaded, total) => {
            const filePercent =
              total > 0 ? Math.round((loaded / total) * 100) : 100;
            const opProgress = completedOps + (total > 0 ? loaded / total : 0);
            const totalPercent =
              totalOps > 0
                ? Math.min(100, Math.round((opProgress / totalOps) * 100))
                : 0;
            emitProgress({
              stage: "downloading",
              currentFile: path,
              completedOps,
              totalOps,
              fileLoadedBytes: loaded,
              fileTotalBytes: total,
              filePercent,
              totalPercent,
              message: `Downloading (${completedOps + 1}/${totalOps}): ${path}`,
            });
          }
        );

        completedOps++;
        prevSyncMap[path] = {
          mtimeLocal,
          mtimeRemote: remoteInfo?.mtime || Date.now(),
          size,
          etag: remoteInfo?.etag,
        };
        result.downloaded.push(path);
      } catch (err: any) {
        result.errors.push({ path, error: err.message || String(err) });
      }
    });

    // 8. Perform Uploads (Concurrency limit: 1 on mobile, 2 on desktop)
    const uploadConcurrency = Platform.isMobile ? 1 : 2;
    await runConcurrent(toUpload, uploadConcurrency, async (path) => {
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

  /**
   * Downloads a file into the vault with automatic chunking for large files (>= chunkSize).
   * Streamed chunking avoids loading giant files into RAM, preventing Out-Of-Memory crashes on mobile.
   */
  private async downloadFileToVault(
    path: string,
    remoteInfo?: RemoteFileInfo,
    onChunkProgress?: (loaded: number, total: number) => void
  ): Promise<{ size: number; mtimeLocal: number }> {
    const totalSize = remoteInfo?.size ?? 0;
    const isChunkingEnabled = this.settings.enableMultipartUpload ?? true;
    const chunkSize =
      Math.max(5, this.settings.multipartChunkSizeMb ?? 5) * 1024 * 1024;

    await ensureFolderExists(this.app, path);

    // If file is small (< chunkSize) or chunking disabled or size is unknown
    if (!isChunkingEnabled || totalSize < chunkSize || totalSize === 0) {
      const data = await this.s3Service.downloadFile(path);
      const existing = this.app.vault.getAbstractFileByPath(path);
      if (existing instanceof TFile) {
        await this.app.vault.modifyBinary(existing, data);
      } else {
        await this.app.vault.createBinary(path, data);
      }

      onChunkProgress?.(data.byteLength, data.byteLength);

      const stat = await this.app.vault.adapter.stat(path);
      return {
        size: data.byteLength,
        mtimeLocal: stat?.mtime || Date.now(),
      };
    }

    // For large files (>= chunkSize): Stream in chunks to prevent mobile OOM crash
    const totalChunks = Math.ceil(totalSize / chunkSize);
    let loadedBytes = 0;

    for (let i = 0; i < totalChunks; i++) {
      const start = i * chunkSize;
      const end = Math.min((i + 1) * chunkSize - 1, totalSize - 1);

      let chunkData: ArrayBuffer | null = null;
      let lastErr: any = null;

      // Retry up to 3 times per chunk for mobile network resilience
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          chunkData = await this.s3Service.downloadFileChunk(path, start, end);
          break;
        } catch (err: any) {
          lastErr = err;
          await new Promise((r) => setTimeout(r, 1000 * attempt));
        }
      }

      if (!chunkData) {
        throw new Error(
          `Failed to download chunk ${i + 1}/${totalChunks} of "${path}": ${
            lastErr?.message || String(lastErr)
          }`
        );
      }

      if (i === 0) {
        await this.app.vault.adapter.writeBinary(path, chunkData);
      } else {
        await this.app.vault.adapter.appendBinary(path, chunkData);
      }

      loadedBytes = end + 1;
      onChunkProgress?.(loadedBytes, totalSize);
    }

    const stat = await this.app.vault.adapter.stat(path);
    return {
      size: totalSize,
      mtimeLocal: stat?.mtime || Date.now(),
    };
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
  const conflictRegex = /^(.*)\.conflict-\d{8}-\d{6}(?:-\d+)?(?:\.([^/]+))?$/;

  for (const file of files) {
    const match = file.path.match(conflictRegex);
    if (match) {
      const ext = match[2] ? `.${match[2]}` : "";
      const originalPath = `${match[1]}${ext}`;
      const originalFile = app.vault.getAbstractFileByPath(originalPath);
      if (originalFile instanceof TFile) {
        results.push({ originalFile, conflictFile: file });
      }
    }
  }
  return results;
}
