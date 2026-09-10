import { App, PluginSettingTab, Setting } from "obsidian";
import type SaveJePlugin from "./main";
import { IDriveS3Service } from "./s3Client";

export class SaveJeSettingTab extends PluginSettingTab {
  plugin: SaveJePlugin;

  constructor(app: App, plugin: SaveJePlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Save-Je (IDrive e2 Sync) Settings" });
    containerEl.createEl("p", {
      text: "Minimal, fast S3 sync plugin tailored specifically for IDrive e2 (Free 10GB tier or standard). Simply enter your credentials, test connection, and click the ribbon icon in the sidebar to sync.",
      cls: "setting-item-description",
    });

    // --- IDrive e2 Credentials Section ---
    new Setting(containerEl).setName("IDrive e2 Credentials").setHeading();

    new Setting(containerEl)
      .setName("Endpoint URL")
      .setDesc("Your IDrive e2 endpoint (e.g. abcd.sg01.idrivee2-8.com). https:// is added automatically if omitted.")
      .addText((text) =>
        text
          .setPlaceholder("e.g. abcd.sg01.idrivee2-8.com")
          .setValue(this.plugin.settings.endpoint)
          .onChange(async (value) => {
            this.plugin.settings.endpoint = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Region (Optional)")
      .setDesc("Auto-detected from endpoint (e.g. sg01). Leave blank unless you have a custom region.")
      .addText((text) =>
        text
          .setPlaceholder("Auto-detect (e.g. sg01)")
          .setValue(this.plugin.settings.region)
          .onChange(async (value) => {
            this.plugin.settings.region = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Access Key ID")
      .setDesc("Your IDrive e2 S3 Access Key ID.")
      .addText((text) =>
        text
          .setPlaceholder("Enter Access Key ID")
          .setValue(this.plugin.settings.accessKeyId)
          .onChange(async (value) => {
            this.plugin.settings.accessKeyId = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Secret Access Key")
      .setDesc("Your IDrive e2 S3 Secret Access Key.")
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setPlaceholder("Enter Secret Access Key")
          .setValue(this.plugin.settings.secretAccessKey)
          .onChange(async (value) => {
            this.plugin.settings.secretAccessKey = value.trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Bucket Name")
      .setDesc("The IDrive e2 bucket name where your vault files will be stored.")
      .addText((text) =>
        text
          .setPlaceholder("my-obsidian-vault")
          .setValue(this.plugin.settings.bucketName)
          .onChange(async (value) => {
            this.plugin.settings.bucketName = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Remote Folder Prefix (Optional)")
      .setDesc("Subfolder inside the bucket (e.g. 'vault/' or leave blank to store at bucket root).")
      .addText((text) =>
        text
          .setPlaceholder("e.g. notes/ (leave empty for root)")
          .setValue(this.plugin.settings.remotePrefix)
          .onChange(async (value) => {
            this.plugin.settings.remotePrefix = value.trim();
            await this.plugin.saveSettings();
          })
      );

    // --- Test Connection Button & Result Box ---
    const testResultEl = containerEl.createDiv({ cls: "save-je-test-result" });

    new Setting(containerEl)
      .setName("Test IDrive e2 Connection")
      .setDesc("Verify that your credentials and bucket are accessible.")
      .addButton((btn) =>
        btn
          .setButtonText("Check Connection")
          .setCta()
          .onClick(async () => {
            btn.setDisabled(true);
            testResultEl.className = "save-je-test-result loading";
            testResultEl.setText("Connecting to IDrive e2...");

            try {
              const service = new IDriveS3Service(this.plugin.settings);
              const result = await service.testConnection();

              if (result.ok) {
                testResultEl.className = "save-je-test-result success";
                testResultEl.setText(`✓ ${result.message}`);
              } else {
                testResultEl.className = "save-je-test-result error";
                testResultEl.setText(`✗ ${result.message}`);
              }
            } catch (err: any) {
              testResultEl.className = "save-je-test-result error";
              testResultEl.setText(`✗ Error: ${err.message || String(err)}`);
            } finally {
              btn.setDisabled(false);
            }
          })
      );

    // --- Sync Preferences Section ---
    new Setting(containerEl).setName("Sync Preferences").setHeading();

    new Setting(containerEl)
      .setName("Auto-Sync Interval")
      .setDesc("Automatically sync in the background at regular intervals.")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("0", "Manual Only (Sidebar Icon / Command)")
          .addOption("5", "Every 5 minutes")
          .addOption("10", "Every 10 minutes")
          .addOption("15", "Every 15 minutes")
          .addOption("30", "Every 30 minutes")
          .addOption("60", "Every 1 hour")
          .setValue(String(this.plugin.settings.autoSyncIntervalMinutes))
          .onChange(async (value) => {
            this.plugin.settings.autoSyncIntervalMinutes = Number(value);
            await this.plugin.saveSettings();
            this.plugin.setupAutoSync();
          })
      );

    new Setting(containerEl)
      .setName("Sync on Startup")
      .setDesc("Automatically run a sync when Obsidian is opened.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.syncOnStartup)
          .onChange(async (value) => {
            this.plugin.settings.syncOnStartup = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Sync Deletions")
      .setDesc("When a file is deleted locally, delete it from IDrive e2 (and vice versa).")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.deleteRemoteWhenDeletedLocally)
          .onChange(async (value) => {
            this.plugin.settings.deleteRemoteWhenDeletedLocally = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Conflict Resolution")
      .setDesc("How to handle files that were modified independently on both this device and remote storage since last sync.")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("conflict_copy", "Create conflict copy (Recommended - no data loss)")
          .addOption("keep_newer", "Keep newer version (Overwrite older)")
          .addOption("keep_larger", "Keep larger file (Overwrite smaller)")
          .setValue(this.plugin.settings.conflictAction || "conflict_copy")
          .onChange(async (value) => {
            this.plugin.settings.conflictAction = value as any;
            await this.plugin.saveSettings();
          })
      );
  }
}
