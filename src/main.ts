import { Notice, Plugin, setIcon } from "obsidian";
import { IDriveS3Service } from "./s3Client";
import { SaveJeSettingTab } from "./settingsTab";
import { VaultSyncer } from "./syncer";
import {
  DEFAULT_SETTINGS,
  type SaveJeSettings,
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
      this.triggerSync();
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

    // 6. Sync on startup if enabled
    if (this.settings.syncOnStartup) {
      this.app.workspace.onLayoutReady(() => {
        // Wait a few seconds for vault indexing to finish before initial sync
        window.setTimeout(() => {
          this.triggerSync();
        }, 3000);
      });
    }
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

    const notice = new Notice("Save-Je: Starting sync...", 0);

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

      const result = await syncer.sync((progressMsg) => {
        notice.setMessage(`Save-Je: ${progressMsg}`);
      });

      notice.hide();

      const timeSec = (result.durationMs / 1000).toFixed(1);
      const conflictMsg =
        result.conflicts.length > 0
          ? `, ⚠️${result.conflicts.length} conflict(s)`
          : "";
      const msg = `Save-Je: Synced in ${timeSec}s (↑${result.uploaded.length} uploaded, ↓${result.downloaded.length} downloaded, ✗${result.deleted.length} deleted${conflictMsg})`;
      new Notice(msg, 6000);

      const now = new Date();
      const timeStr = `${String(now.getHours()).padStart(2, "0")}:${String(
        now.getMinutes()
      ).padStart(2, "0")}`;
      this.updateStatusBar(`Synced ${timeStr}`);

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
