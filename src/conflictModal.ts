import { App, Modal, Notice, Platform, TFile, setIcon } from "obsidian";
import {
  getDefaultDeviceName,
  humanizeSanitizedDeviceName,
} from "./deviceHelper";
import {
  buildSideBySideRows,
  computeLineDiff,
  smartMerge,
} from "./diffHelper";

const TEXT_EXTENSIONS = new Set([
  "md",
  "txt",
  "canvas",
  "json",
  "css",
  "js",
  "ts",
  "html",
  "xml",
  "csv",
]);

function isTextFile(file: TFile): boolean {
  return TEXT_EXTENSIONS.has((file.extension || "").toLowerCase());
}

export class ConflictModal extends Modal {
  private originalFile: TFile;
  private conflictFile: TFile;
  private onResolved?: () => void;
  private activeTab: "split" | "local" | "remote" | "merged" = "split";
  private localDeviceName: string;
  private remoteDeviceName: string;

  constructor(
    app: App,
    originalFile: TFile,
    conflictFile: TFile,
    onResolved?: () => void,
    localDeviceName?: string,
    remoteDeviceName?: string
  ) {
    super(app);
    this.originalFile = originalFile;
    this.conflictFile = conflictFile;
    this.onResolved = onResolved;

    this.localDeviceName = localDeviceName?.trim() || getDefaultDeviceName();

    if (remoteDeviceName && remoteDeviceName !== "Remote Device") {
      this.remoteDeviceName = remoteDeviceName.trim();
    } else {
      // Auto-extract from filename if format is notes/daily.conflict-20260911-091520-from-iPhone_15.md
      const match = conflictFile.path.match(
        /\.conflict-\d{8}-\d{6}(?:-from-([^.]+?))?(?:-\d+)?(?:\.[^/]+)?$/
      );
      if (match && match[1]) {
        this.remoteDeviceName = humanizeSanitizedDeviceName(match[1]);
      } else {
        this.remoteDeviceName = "Remote Device";
      }
    }
  }

  async onOpen() {
    const { contentEl, modalEl } = this;
    modalEl.addClass("save-je-conflict-modal");

    const isMobile = Platform.isMobile;
    const isText = isTextFile(this.originalFile);

    if (isMobile) {
      modalEl.addClass("save-je-mobile");
      this.activeTab = isText ? "merged" : "local";
    }

    contentEl.empty();

    const formatBytes = (bytes?: number) => {
      if (!bytes || bytes <= 0) return "0 B";
      if (bytes < 1024) return `${bytes} B`;
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
      return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
    };

    let originalText = "";
    let conflictText = "";
    let diff: any[] = [];
    let sideBySide: any[] = [];
    let mergedText = "";

    if (isText) {
      contentEl.createEl("div", {
        cls: "save-je-diff-loading",
        text: "Loading file differences...",
      });

      try {
        originalText = await this.app.vault.read(this.originalFile);
        conflictText = await this.app.vault.read(this.conflictFile);
        diff = computeLineDiff(originalText, conflictText);
        sideBySide = buildSideBySideRows(diff);
        mergedText = smartMerge(originalText, conflictText);
      } catch (err: any) {
        contentEl.empty();
        contentEl.createEl("h3", { text: "Error loading conflicting files" });
        contentEl.createEl("p", { text: err.message || String(err) });
        return;
      }
    }

    contentEl.empty();

    // --- Header ---
    const headerEl = contentEl.createDiv({ cls: "save-je-modal-header" });
    const titleRow = headerEl.createDiv({ cls: "save-je-modal-title-row" });
    const iconEl = titleRow.createSpan({ cls: "save-je-modal-icon" });
    setIcon(iconEl, isText ? "git-pull-request" : "file-diff");
    titleRow.createEl("h2", { text: `Conflict: ${this.originalFile.name}` });

    const metaRow = headerEl.createDiv({ cls: "save-je-modal-meta" });
    const localTime = new Date(this.originalFile.stat.mtime).toLocaleTimeString();
    const remoteTime = new Date(this.conflictFile.stat.mtime).toLocaleTimeString();
    const localSizeStr = formatBytes(this.originalFile.stat.size);
    const remoteSizeStr = formatBytes(this.conflictFile.stat.size);
    metaRow.createSpan({
      text: `💻 ${this.localDeviceName} (This Device): ${localTime} (${localSizeStr}) | ☁️ ${this.remoteDeviceName}: ${remoteTime} (${remoteSizeStr})`,
    });

    // --- Tab Switcher (Only for text files) ---
    if (isText) {
      const tabsContainer = contentEl.createDiv({ cls: "save-je-tabs-bar" });

      const createTabBtn = (
        id: "split" | "local" | "remote" | "merged",
        label: string,
        iconName?: string
      ) => {
        const btn = tabsContainer.createEl("button", {
          cls: `save-je-tab-btn ${this.activeTab === id ? "active" : ""}`,
        });
        if (iconName) {
          const iconSpan = btn.createSpan({ cls: "save-je-tab-icon" });
          setIcon(iconSpan, iconName);
        }
        btn.createSpan({ text: label });

        btn.onclick = () => {
          this.activeTab = id;
          tabsContainer
            .querySelectorAll(".save-je-tab-btn")
            .forEach((el) => el.removeClass("active"));
          btn.addClass("active");
          renderActiveView();
        };
        return btn;
      };

      if (!isMobile) {
        createTabBtn("split", "Side-by-Side Diff", "columns");
      }
      createTabBtn("local", `${this.localDeviceName} Version`, "file-text");
      createTabBtn("remote", `${this.remoteDeviceName} Version`, "copy");
      createTabBtn("merged", "Smart Merged Preview", "sparkles");
    }

    // --- Main View Container ---
    const viewContainer = contentEl.createDiv({
      cls: "save-je-diff-view-container",
    });

    const renderActiveView = () => {
      viewContainer.empty();

      if (!isText) {
        renderBinaryView(
          viewContainer,
          this.originalFile,
          this.conflictFile,
          formatBytes,
          this.localDeviceName,
          this.remoteDeviceName
        );
        return;
      }

      if (this.activeTab === "split" && !isMobile) {
        renderSplitDiff(
          viewContainer,
          sideBySide,
          this.localDeviceName,
          this.remoteDeviceName
        );
      } else if (this.activeTab === "local") {
        renderSingleView(
          viewContainer,
          originalText,
          `${this.localDeviceName} Version`
        );
      } else if (this.activeTab === "remote") {
        renderSingleView(
          viewContainer,
          conflictText,
          `${this.remoteDeviceName} Version`
        );
      } else {
        renderSingleView(viewContainer, mergedText, "Smart Merged Result", true);
      }
    };

    renderActiveView();

    // --- Action Bar ---
    const actionsBar = contentEl.createDiv({ cls: "save-je-actions-bar" });

    // Button 1: Smart Merge (Only for text files)
    if (isText) {
      const mergeBtn = actionsBar.createEl("button", {
        cls: "mod-cta save-je-action-btn save-je-merge-btn",
      });
      const mergeIcon = mergeBtn.createSpan({ cls: "save-je-btn-icon" });
      setIcon(mergeIcon, "sparkles");
      mergeBtn.createSpan({ text: "Smart Merge Both" });
      mergeBtn.onclick = async () => {
        mergeBtn.disabled = true;
        try {
          await this.app.vault.modify(this.originalFile, mergedText);
          await this.app.vault.trash(this.conflictFile, false);
          new Notice(
            `Save-Je: Successfully merged both versions into "${this.originalFile.name}".`,
            6000
          );
          this.close();
          this.onResolved?.();
        } catch (err: any) {
          new Notice(`Failed to merge: ${err.message || String(err)}`);
          mergeBtn.disabled = false;
        }
      };
    }

    // Button 2: Keep Local Device Version
    const keepLocalBtn = actionsBar.createEl("button", {
      cls: "save-je-action-btn save-je-local-btn",
    });
    const localIcon = keepLocalBtn.createSpan({ cls: "save-je-btn-icon" });
    setIcon(localIcon, "laptop");
    keepLocalBtn.createSpan({ text: `Keep ${this.localDeviceName}` });
    keepLocalBtn.onclick = async () => {
      keepLocalBtn.disabled = true;
      try {
        await this.app.vault.trash(this.conflictFile, false);
        new Notice(
          `Save-Je: Kept ${this.localDeviceName} version of "${this.originalFile.name}".`,
          6000
        );
        this.close();
        this.onResolved?.();
      } catch (err: any) {
        new Notice(`Failed to resolve: ${err.message || String(err)}`);
        keepLocalBtn.disabled = false;
      }
    };

    // Button 3: Keep Remote Device Version
    const keepRemoteBtn = actionsBar.createEl("button", {
      cls: "save-je-action-btn save-je-remote-btn",
    });
    const remoteIcon = keepRemoteBtn.createSpan({ cls: "save-je-btn-icon" });
    setIcon(remoteIcon, "cloud");
    keepRemoteBtn.createSpan({ text: `Keep ${this.remoteDeviceName}` });
    keepRemoteBtn.onclick = async () => {
      keepRemoteBtn.disabled = true;
      try {
        if (isText) {
          await this.app.vault.modify(this.originalFile, conflictText);
        } else {
          const remoteBytes = await this.app.vault.readBinary(this.conflictFile);
          await this.app.vault.modifyBinary(this.originalFile, remoteBytes);
        }
        await this.app.vault.trash(this.conflictFile, false);
        new Notice(
          `Save-Je: Replaced "${this.originalFile.name}" with ${this.remoteDeviceName} version.`,
          6000
        );
        this.close();
        this.onResolved?.();
      } catch (err: any) {
        new Notice(`Failed to resolve: ${err.message || String(err)}`);
        keepRemoteBtn.disabled = false;
      }
    };

    // Button 4: Cancel / Decide Later
    const cancelBtn = actionsBar.createEl("button", {
      cls: "save-je-action-btn save-je-cancel-btn",
      text: "Decide Later",
    });
    cancelBtn.onclick = () => {
      this.close();
    };
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
}

/**
 * Renders side-by-side split view with synchronized scrolling.
 */
function renderSplitDiff(
  container: HTMLElement,
  rows: ReturnType<typeof buildSideBySideRows>,
  localDeviceName = "This Device",
  remoteDeviceName = "Remote Device"
) {
  const splitContainer = container.createDiv({
    cls: "save-je-split-diff-container",
  });

  const leftColumn = splitContainer.createDiv({
    cls: "save-je-diff-column left",
  });
  leftColumn.createDiv({
    cls: "save-je-column-header",
    text: `💻 ${localDeviceName} (This Device)`,
  });
  const leftScroll = leftColumn.createDiv({ cls: "save-je-scroll-pane" });

  const rightColumn = splitContainer.createDiv({
    cls: "save-je-diff-column right",
  });
  rightColumn.createDiv({
    cls: "save-je-column-header",
    text: `☁️ ${remoteDeviceName}`,
  });
  const rightScroll = rightColumn.createDiv({ cls: "save-je-scroll-pane" });

  // Render rows
  for (const row of rows) {
    // Left row
    const leftRowEl = leftScroll.createDiv({
      cls: `save-je-diff-row ${row.leftType}`,
    });
    leftRowEl.createSpan({
      cls: "save-je-line-num",
      text: row.leftLineNum ? String(row.leftLineNum) : "",
    });
    leftRowEl.createSpan({
      cls: "save-je-line-content",
      text: row.leftText || " ",
    });

    // Right row
    const rightRowEl = rightScroll.createDiv({
      cls: `save-je-diff-row ${row.rightType}`,
    });
    rightRowEl.createSpan({
      cls: "save-je-line-num",
      text: row.rightLineNum ? String(row.rightLineNum) : "",
    });
    rightRowEl.createSpan({
      cls: "save-je-line-content",
      text: row.rightText || " ",
    });
  }

  // Synchronized scrolling
  let isSyncingLeft = false;
  let isSyncingRight = false;

  leftScroll.onscroll = () => {
    if (!isSyncingLeft) {
      isSyncingRight = true;
      rightScroll.scrollTop = leftScroll.scrollTop;
      rightScroll.scrollLeft = leftScroll.scrollLeft;
    }
    isSyncingLeft = false;
  };

  rightScroll.onscroll = () => {
    if (!isSyncingRight) {
      isSyncingLeft = true;
      leftScroll.scrollTop = rightScroll.scrollTop;
      leftScroll.scrollLeft = rightScroll.scrollLeft;
    }
    isSyncingRight = false;
  };
}

/**
 * Renders a single scrollable text view with line numbers.
 */
function renderSingleView(
  container: HTMLElement,
  text: string,
  label: string,
  isMerged = false
) {
  const singleContainer = container.createDiv({
    cls: "save-je-single-view-container",
  });

  const header = singleContainer.createDiv({
    cls: `save-je-column-header ${isMerged ? "merged" : ""}`,
    text: isMerged ? `✨ ${label} (Preview)` : label,
  });

  const scrollPane = singleContainer.createDiv({
    cls: "save-je-scroll-pane single",
  });

  const lines = text.split(/\r?\n/);
  for (let idx = 0; idx < lines.length; idx++) {
    const rowEl = scrollPane.createDiv({ cls: "save-je-diff-row equal" });
    rowEl.createSpan({ cls: "save-je-line-num", text: String(idx + 1) });
    rowEl.createSpan({
      cls: "save-je-line-content",
      text: lines[idx] || " ",
    });
  }
}

/**
 * Renders a side-by-side comparison for binary files (images, audio, video, PDFs).
 */
function renderBinaryView(
  container: HTMLElement,
  originalFile: TFile,
  conflictFile: TFile,
  formatBytes: (bytes?: number) => string,
  localDeviceName = "This Device",
  remoteDeviceName = "Remote Device"
) {
  const binaryContainer = container.createDiv({
    cls: "save-je-binary-diff-container",
  });

  const cardsWrapper = binaryContainer.createDiv({
    cls: "save-je-split-diff-container",
  });

  // Left card: Local
  const leftCol = cardsWrapper.createDiv({
    cls: "save-je-diff-column left",
  });
  leftCol.createDiv({
    cls: "save-je-column-header",
    text: `💻 ${localDeviceName} (This Device)`,
  });
  const leftBody = leftCol.createDiv({ cls: "save-je-binary-card-body" });
  leftBody.createEl("div", {
    cls: "save-je-binary-filename",
    text: originalFile.name,
  });
  leftBody.createEl("div", {
    cls: "save-je-binary-meta",
    text: `Size: ${formatBytes(originalFile.stat.size)}`,
  });
  leftBody.createEl("div", {
    cls: "save-je-binary-meta",
    text: `Modified: ${new Date(originalFile.stat.mtime).toLocaleString()}`,
  });

  // Right card: Remote
  const rightCol = cardsWrapper.createDiv({
    cls: "save-je-diff-column right",
  });
  rightCol.createDiv({
    cls: "save-je-column-header",
    text: `☁️ ${remoteDeviceName}`,
  });
  const rightBody = rightCol.createDiv({ cls: "save-je-binary-card-body" });
  rightBody.createEl("div", {
    cls: "save-je-binary-filename",
    text: conflictFile.name,
  });
  rightBody.createEl("div", {
    cls: "save-je-binary-meta",
    text: `Size: ${formatBytes(conflictFile.stat.size)}`,
  });
  rightBody.createEl("div", {
    cls: "save-je-binary-meta",
    text: `Modified: ${new Date(conflictFile.stat.mtime).toLocaleString()}`,
  });

  const tip = binaryContainer.createDiv({ cls: "save-je-binary-tip" });
  tip.setText(
    `ℹ️ Binary files (images, audio, video, PDFs) cannot be merged with line diffing. Choose 'Keep ${localDeviceName}' to retain this device's version, or 'Keep ${remoteDeviceName}' to replace it with the conflict copy.`
  );
}
