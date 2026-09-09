import { App, TFile, TFolder, normalizePath } from "obsidian";
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
   * Main sync orchestration method.
   */
  async sync(onProgress?: (message: string) => void): Promise<SyncResult> {
    const startTime = Date.now();
    const result: SyncResult = {
      uploaded: [],
      downloaded: [],
      deleted: [],
      skipped: [],
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
    const toDeleteRemote: string[] = [];
    const toDeleteLocal: string[] = [];

    // 1. Process all local files
    for (const [path, localInfo] of localMap.entries()) {
      const remoteInfo = remoteMap.get(path);
      const prevRecord = prevSyncMap[path];

      if (remoteInfo) {
        // Both exist: check modification
        const timeDiff = Math.abs(localInfo.mtime - remoteInfo.mtime);
        const sizeDiff = localInfo.size !== remoteInfo.size;

        if (timeDiff > 1000 || sizeDiff) {
          // One of them is newer
          if (localInfo.mtime > remoteInfo.mtime) {
            toUpload.push(path);
          } else {
            toDownload.push(path);
          }
        } else {
          result.skipped.push(path);
        }
      } else {
        // Local exists, remote does not
        if (
          prevRecord &&
          remoteMap.size > 0 &&
          this.settings.deleteRemoteWhenDeletedLocally
        ) {
          // File was synced previously, but is now gone on remote -> deleted remotely
          toDeleteLocal.push(path);
        } else {
          // Newly created locally (or new bucket) -> upload
          toUpload.push(path);
        }
      }
    }

    // 2. Process remote files that do not exist locally
    for (const [path, remoteInfo] of remoteMap.entries()) {
      if (!localMap.has(path)) {
        const prevRecord = prevSyncMap[path];
        if (prevRecord) {
          // Was synced previously, now missing locally -> deleted locally
          if (this.settings.deleteRemoteWhenDeletedLocally) {
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

    const totalOps =
      toUpload.length +
      toDownload.length +
      toDeleteRemote.length +
      toDeleteLocal.length;

    let completedOps = 0;
    const reportProgress = (action: string, path: string) => {
      completedOps++;
      onProgress?.(
        `${action} (${completedOps}/${totalOps}): ${path}`
      );
    };

    // 3. Perform Remote Deletions
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

    // 4. Perform Local Deletions
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

    // 5. Perform Downloads (Concurrency limit: 4)
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

    // 6. Perform Uploads (Concurrency limit: 4)
    await runConcurrent(toUpload, 4, async (path) => {
      try {
        reportProgress("Uploading", path);
        const file = this.app.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile)) {
          return;
        }

        const data = await this.app.vault.readBinary(file);
        await this.s3Service.uploadFile(path, data, file.stat.mtime);

        prevSyncMap[path] = {
          mtime: file.stat.mtime,
          size: data.byteLength,
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
