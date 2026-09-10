import { App, Modal, Notice, Platform, TFile, setIcon } from "obsidian";
import {
  buildSideBySideRows,
  computeLineDiff,
  smartMerge,
} from "./diffHelper";

export class ConflictModal extends Modal {
  private originalFile: TFile;
  private conflictFile: TFile;
  private onResolved?: () => void;
  private activeTab: "split" | "local" | "remote" | "merged" = "split";

  constructor(
    app: App,
    originalFile: TFile,
    conflictFile: TFile,
    onResolved?: () => void
  ) {
    super(app);
    this.originalFile = originalFile;
    this.conflictFile = conflictFile;
    this.onResolved = onResolved;
  }

  async onOpen() {
    const { contentEl, modalEl } = this;
    modalEl.addClass("save-je-conflict-modal");

    // Check if on mobile phone
    const isMobile = Platform.isMobile;
    if (isMobile) {
      modalEl.addClass("save-je-mobile");
      this.activeTab = "merged";
    }

    contentEl.empty();

    // Loading indicator while reading contents
    contentEl.createEl("div", {
      cls: "save-je-diff-loading",
      text: "Loading file differences...",
    });

    let originalText = "";
    let conflictText = "";

    try {
      originalText = await this.app.vault.read(this.originalFile);
      conflictText = await this.app.vault.read(this.conflictFile);
    } catch (err: any) {
      contentEl.empty();
      contentEl.createEl("h3", { text: "Error loading conflicting files" });
      contentEl.createEl("p", { text: err.message || String(err) });
      return;
    }

    const diff = computeLineDiff(originalText, conflictText);
    const sideBySide = buildSideBySideRows(diff);
    const mergedText = smartMerge(originalText, conflictText);

    contentEl.empty();

    // --- Header ---
    const headerEl = contentEl.createDiv({ cls: "save-je-modal-header" });
    const titleRow = headerEl.createDiv({ cls: "save-je-modal-title-row" });
    const iconEl = titleRow.createSpan({ cls: "save-je-modal-icon" });
    setIcon(iconEl, "git-pull-request");
    titleRow.createEl("h2", { text: `Conflict: ${this.originalFile.name}` });

    const metaRow = headerEl.createDiv({ cls: "save-je-modal-meta" });
    const localTime = new Date(this.originalFile.stat.mtime).toLocaleTimeString();
    const remoteTime = new Date(this.conflictFile.stat.mtime).toLocaleTimeString();
    metaRow.createSpan({
      text: `💻 This Device: ${localTime} | 📱 Conflict Copy: ${remoteTime}`,
    });

    // --- Tab Switcher (Visible on mobile & desktop) ---
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
    createTabBtn("local", "Local Version", "file-text");
    createTabBtn("remote", "Conflict Copy", "copy");
    createTabBtn("merged", "Smart Merged Preview", "sparkles");

    // --- Main View Container ---
    const viewContainer = contentEl.createDiv({
      cls: "save-je-diff-view-container",
    });

    const renderActiveView = () => {
      viewContainer.empty();

      if (this.activeTab === "split" && !isMobile) {
        renderSplitDiff(viewContainer, sideBySide);
      } else if (this.activeTab === "local") {
        renderSingleView(viewContainer, originalText, "Local Version");
      } else if (this.activeTab === "remote") {
        renderSingleView(viewContainer, conflictText, "Remote Conflict Copy");
      } else {
        renderSingleView(viewContainer, mergedText, "Smart Merged Result", true);
      }
    };

    renderActiveView();

    // --- Action Bar ---
    const actionsBar = contentEl.createDiv({ cls: "save-je-actions-bar" });

    // Button 1: Smart Merge
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

    // Button 2: Keep Local
    const keepLocalBtn = actionsBar.createEl("button", {
      cls: "save-je-action-btn save-je-local-btn",
    });
    const localIcon = keepLocalBtn.createSpan({ cls: "save-je-btn-icon" });
    setIcon(localIcon, "laptop");
    keepLocalBtn.createSpan({ text: "Keep Local" });
    keepLocalBtn.onclick = async () => {
      keepLocalBtn.disabled = true;
      try {
        await this.app.vault.trash(this.conflictFile, false);
        new Notice(
          `Save-Je: Kept local version of "${this.originalFile.name}".`,
          6000
        );
        this.close();
        this.onResolved?.();
      } catch (err: any) {
        new Notice(`Failed to resolve: ${err.message || String(err)}`);
        keepLocalBtn.disabled = false;
      }
    };

    // Button 3: Keep Remote
    const keepRemoteBtn = actionsBar.createEl("button", {
      cls: "save-je-action-btn save-je-remote-btn",
    });
    const remoteIcon = keepRemoteBtn.createSpan({ cls: "save-je-btn-icon" });
    setIcon(remoteIcon, "cloud");
    keepRemoteBtn.createSpan({ text: "Keep Remote" });
    keepRemoteBtn.onclick = async () => {
      keepRemoteBtn.disabled = true;
      try {
        await this.app.vault.modify(this.originalFile, conflictText);
        await this.app.vault.trash(this.conflictFile, false);
        new Notice(
          `Save-Je: Replaced "${this.originalFile.name}" with remote version.`,
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
  rows: ReturnType<typeof buildSideBySideRows>
) {
  const splitContainer = container.createDiv({
    cls: "save-je-split-diff-container",
  });

  const leftColumn = splitContainer.createDiv({
    cls: "save-je-diff-column left",
  });
  leftColumn.createDiv({
    cls: "save-je-column-header",
    text: "💻 This Device (Local)",
  });
  const leftScroll = leftColumn.createDiv({ cls: "save-je-scroll-pane" });

  const rightColumn = splitContainer.createDiv({
    cls: "save-je-diff-column right",
  });
  rightColumn.createDiv({
    cls: "save-je-column-header",
    text: "📱 Conflict Copy (Remote)",
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
