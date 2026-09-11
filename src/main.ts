import { Notice, Plugin, TFile, setIcon } from "obsidian";
import { ConflictModal } from "./conflictModal";
import { getEffectiveDeviceName } from "./deviceHelper";
import { IDriveS3Service } from "./s3Client";
import { SaveJeSettingTab } from "./settingsTab";
import { VaultSyncer, findVaultConflicts } from "./syncer";
import {
  DEFAULT_SETTINGS,
  type SaveJeSettings,
  type SyncProgressUpdate,
  type SyncStateData,
} from "./types";

export default class SaveJePlugin extends Plugin {
  settings: SaveJeSettings = DEFAULT_SETTINGS;
  syncState: SyncStateData = { lastSyncTime: 0, files: {} };
  isSyncing = false;
  ribbonIconEl: HTMLElement | null = null;
  statusBarItemEl: HTMLElement | null = null;
  private autoSyncIntervalTimer: number | null = null;

  async onload() {
    console.log("Loading Save-Je (IDrive e2 Sync) plugin...");

    await this.loadSettings();

    // 1. Add Sidebar Ribbon Icon (Click to Sync!)
    this.ribbonIconEl = this.addRibbonIcon(
      "refresh-cw",
      "Save-Je: Sync with IDrive e2",
      () => {
        this.triggerSync();
      }
    );

    // 2. Add Status Bar Item
    this.statusBarItemEl = this.addStatusBarItem();
    this.statusBarItemEl.addClass("save-je-status-bar");
    this.updateStatusBar("Idle");
    this.statusBarItemEl.onClickEvent(() => {
      const conflicts = findVaultConflicts(this.app);
      if (conflicts.length > 0) {
        this.openConflictResolver();
      } else {
        this.triggerSync();
      }
    });

    // 3. Register Commands
    this.addCommand({
      id: "save-je-sync",
      name: "Sync now with IDrive e2",
      callback: () => {
        this.triggerSync();
      },
    });

    this.addCommand({
      id: "save-je-resolve-conflicts",
      name: "Review and merge file conflicts",
      callback: () => {
        this.openConflictResolver();
      },
    });

    this.addCommand({
      id: "save-je-test-connection",
      name: "Test IDrive e2 connection",
      callback: async () => {
        new Notice("Testing IDrive e2 connection...");
        try {
          const service = new IDriveS3Service(this.settings);
          const res = await service.testConnection();
          if (res.ok) {
            new Notice(`Save-Je: ${res.message}`, 5000);
          } else {
            new Notice(`Save-Je: ${res.message}`, 8000);
          }
        } catch (err: any) {
          new Notice(`Save-Je: Connection failed: ${err.message}`, 8000);
        }
      },
    });

    // 4. Add Settings Tab
    this.addSettingTab(new SaveJeSettingTab(this.app, this));

    // 5. Setup Auto-sync if configured
    this.setupAutoSync();

    // 6. Layout ready checks
    this.app.workspace.onLayoutReady(() => {
      this.updateConflictStatus();

      if (this.settings.syncOnStartup) {
        window.setTimeout(() => {
          this.triggerSync();
        }, 3000);
      }
    });
  }

  onunload() {
    console.log("Unloading Save-Je plugin...");
    if (this.autoSyncIntervalTimer !== null) {
      window.clearInterval(this.autoSyncIntervalTimer);
      this.autoSyncIntervalTimer = null;
    }
  }

  async loadSettings() {
    const loadedData = await this.loadData();
    if (loadedData) {
      this.settings = Object.assign({}, DEFAULT_SETTINGS, loadedData.settings);
      this.syncState = Object.assign(
        { lastSyncTime: 0, files: {} },
        loadedData.syncState
      );
    }
  }

  async saveSettings() {
    await this.saveData({
      settings: this.settings,
      syncState: this.syncState,
    });
  }

  async saveSyncState(state: SyncStateData) {
    this.syncState = state;
    await this.saveSettings();
  }

  setupAutoSync() {
    if (this.autoSyncIntervalTimer !== null) {
      window.clearInterval(this.autoSyncIntervalTimer);
      this.autoSyncIntervalTimer = null;
    }

    const intervalMinutes = this.settings.autoSyncIntervalMinutes;
    if (intervalMinutes > 0) {
      const ms = intervalMinutes * 60 * 1000;
      this.autoSyncIntervalTimer = window.setInterval(() => {
        this.triggerSync();
      }, ms);
      console.log(`Save-Je auto-sync scheduled every ${intervalMinutes} minutes.`);
    }
  }

  private updateStatusBar(status: string) {
    if (!this.statusBarItemEl) return;
    this.statusBarItemEl.setText(`Save-Je: ${status}`);
  }

  /**
   * Scans vault and updates status bar with conflict badges if any exist.
   */
  updateConflictStatus() {
    if (!this.statusBarItemEl) return;
    const conflicts = findVaultConflicts(this.app);
    if (conflicts.length > 0) {
      this.statusBarItemEl.addClass("save-je-status-conflict");
      this.statusBarItemEl.setText(
        `Save-Je: ⚠️ ${conflicts.length} Conflict${conflicts.length > 1 ? "s" : ""} [Resolve]`
      );
    } else {
      this.statusBarItemEl.removeClass("save-je-status-conflict");
      if (this.syncState.lastSyncTime > 0) {
        const lastDate = new Date(this.syncState.lastSyncTime);
        const timeStr = `${String(lastDate.getHours()).padStart(2, "0")}:${String(
          lastDate.getMinutes()
        ).padStart(2, "0")}`;
        this.updateStatusBar(`Synced ${timeStr}`);
      } else {
        this.updateStatusBar("Idle");
      }
    }
  }

  /**
   * Opens the interactive Diff & Merge modal for conflicting files.
   */
  openConflictResolver() {
    const conflicts = findVaultConflicts(this.app);
    if (conflicts.length === 0) {
      new Notice("Save-Je: No file conflicts found in your vault! 🎉", 4000);
      this.updateConflictStatus();
      return;
    }

    const first = conflicts[0];
    const localDeviceName = getEffectiveDeviceName(this.settings);
    new ConflictModal(
      this.app,
      first.originalFile,
      first.conflictFile,
      async () => {
        this.updateConflictStatus();
        const remaining = findVaultConflicts(this.app);
        if (remaining.length > 0) {
          new Notice(
            `Save-Je: ${remaining.length} more conflict(s) remaining.`,
            6000
          );
        } else {
          // All conflicts resolved! Auto-sync to upload the resolved files immediately to S3
          await this.triggerSync();
        }
      },
      localDeviceName,
      first.remoteDeviceName,
      this
    ).open();
  }

  async triggerSync() {
    if (this.isSyncing) {
      new Notice("Save-Je: Sync is already in progress...");
      return;
    }

    if (
      !this.settings.endpoint.trim() ||
      !this.settings.accessKeyId.trim() ||
      !this.settings.secretAccessKey.trim() ||
      !this.settings.bucketName.trim()
    ) {
      new Notice(
        "Save-Je: Please configure your IDrive e2 credentials in plugin settings first.",
        6000
      );
      return;
    }

    this.isSyncing = true;
    if (this.ribbonIconEl) {
      this.ribbonIconEl.addClass("save-je-spinning");
    }
    this.updateStatusBar("Syncing...");

    const notice = new Notice("", 0);
    const noticeEl = notice.noticeEl;
    noticeEl.addClass("save-je-progress-notice");
    noticeEl.empty();

    const titleEl = noticeEl.createDiv({
      cls: "save-je-progress-title",
      text: "Save-Je: Connecting...",
    });
    const fileEl = noticeEl.createDiv({
      cls: "save-je-progress-file",
      text: "",
    });
    fileEl.style.display = "none";

    const trackEl = noticeEl.createDiv({ cls: "save-je-progress-track" });
    const fillEl = trackEl.createDiv({ cls: "save-je-progress-fill" });
    fillEl.style.width = "4%";

    const metaEl = noticeEl.createDiv({
      cls: "save-je-progress-meta",
      text: "Starting sync...",
    });

    const formatBytes = (bytes?: number) => {
      if (!bytes || bytes <= 0) return "0 KB";
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
      return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    };

    try {
      const s3Service = new IDriveS3Service(this.settings);
      const syncer = new VaultSyncer(
        this.app,
        this.settings,
        s3Service,
        this.syncState,
        async (state) => {
          await this.saveSyncState(state);
        }
      );

      const result = await syncer.sync((update) => {
        if (typeof update === "string") {
          titleEl.setText(`Save-Je: ${update}`);
          return;
        }

        const pct = Math.max(4, Math.min(100, update.totalPercent));
        fillEl.style.width = `${pct}%`;

        if (update.stage === "uploading" || update.stage === "downloading") {
          const action =
            update.stage === "uploading" ? "Uploading" : "Downloading";
          titleEl.setText(
            `Save-Je: ${action} (${update.completedOps + 1}/${update.totalOps})`
          );
        } else if (update.stage === "deleting") {
          titleEl.setText(
            `Save-Je: Deleting (${update.completedOps}/${update.totalOps})`
          );
        } else {
          titleEl.setText(`Save-Je: ${update.message}`);
        }

        if (update.currentFile) {
          fileEl.style.display = "block";
          fileEl.setText(update.currentFile);
        } else {
          fileEl.style.display = "none";
        }

        if (
          update.fileLoadedBytes !== undefined &&
          update.fileTotalBytes !== undefined &&
          update.fileTotalBytes > 0
        ) {
          const loadedStr = formatBytes(update.fileLoadedBytes);
          const totalStr = formatBytes(update.fileTotalBytes);
          metaEl.setText(
            `${loadedStr} / ${totalStr} (${update.filePercent}%) • Total: ${update.totalPercent}%`
          );
        } else if (update.totalOps > 0) {
          metaEl.setText(
            `${update.completedOps} / ${update.totalOps} items (${update.totalPercent}%)`
          );
        } else {
          metaEl.setText(update.message);
        }

        if (update.currentFile) {
          const shortName =
            update.currentFile.split("/").pop() || update.currentFile;
          this.updateStatusBar(`${update.totalPercent}% (${shortName})`);
        } else {
          this.updateStatusBar(`${update.totalPercent}%`);
        }
      });

      notice.hide();

      const timeSec = (result.durationMs / 1000).toFixed(1);
      const conflictMsg =
        result.conflicts.length > 0
          ? `, ⚠️${result.conflicts.length} conflict(s)`
          : "";
      const msg = `Save-Je: Synced in ${timeSec}s (↑${result.uploaded.length} uploaded, ↓${result.downloaded.length} downloaded, ✗${result.deleted.length} deleted${conflictMsg})`;
      new Notice(msg, 6000);

      this.updateConflictStatus();

      // If conflict copies were created, show interactive notification with a Review & Merge button
      if (result.conflictPairs && result.conflictPairs.length > 0) {
        const interactiveNotice = new Notice("", 12000);
        const noticeEl = interactiveNotice.noticeEl;
        noticeEl.empty();
        noticeEl.addClass("save-je-interactive-notice");

        const textSpan = noticeEl.createSpan({
          text: `Save-Je: ⚠️ ${result.conflictPairs.length} conflict(s) saved. `,
        });

        const reviewBtn = noticeEl.createEl("button", {
          text: "Review & Merge",
          cls: "mod-cta save-je-notice-btn",
        });
        reviewBtn.onclick = () => {
          interactiveNotice.hide();
          this.openConflictResolver();
        };
      }

      if (result.errors.length > 0) {
        console.error("Save-Je sync errors:", result.errors);
        new Notice(
          `Save-Je: Encountered ${result.errors.length} errors during sync. Check developer console for details.`,
          8000
        );
      }
    } catch (err: any) {
      notice.hide();
      const errMsg = err.message || String(err);
      console.error("Save-Je sync failed:", err);
      new Notice(`Save-Je: Sync failed - ${errMsg}`, 8000);
      this.updateStatusBar("Sync Error");
    } finally {
      this.isSyncing = false;
      if (this.ribbonIconEl) {
        this.ribbonIconEl.removeClass("save-je-spinning");
      }
    }
  }
}
