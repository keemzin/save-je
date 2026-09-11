# Future Roadmap & Feature Ideas

This document tracks planned architectural enhancements, UX experiments, and feature concepts for **Save-Je**.

---

## 1. Floating Draggable Sync Bubble & Proactive Conflict Prevention

### 💡 Overview
A floating, edge-snapping action button (similar to iOS AssistiveTouch / chat heads) designed for quick 1-tap syncing on mobile and proactive conflict prevention.

---

### 🎯 Key Motivations

1. **Mobile Ergonomics (1-Tap Syncing)**:
   - On Obsidian Mobile, opening the left ribbon to trigger sync requires swiping from the edge, which is cumbersome while typing or viewing notes.
   - A floating bubble provides immediate 1-tap sync access anywhere in the vault.

2. **Proactive Conflict Prevention ("Check Before You Edit")**:
   - Traditional sync plugins only detect conflicts *after* edits are made and sync is triggered.
   - If you edit an outdated note for 15 minutes without realizing another device updated it, you are forced to resolve a merge conflict.
   - **Proactive Check**: When opening a note, Save-Je checks if a newer version exists on S3. If yes, it alerts you *before* you start typing, allowing a 1-click update with zero merge conflicts created!

3. **Glanceable Live Status**:
   - Provides ambient, real-time vault health status without needing to check the status bar or settings.

---

### 🛠️ Detailed Specifications

#### A. Draggable & Snappable Physics
- **Pointer Events**: Supports both touch (`touchstart`, `touchmove`, `touchend`) on mobile and mouse events on desktop.
- **Magnetic Edge Snap**: When released after dragging, the bubble smoothly animates and snaps to the nearest edge (left or right).
- **Vertical Freedom**: Users can slide the bubble up or down along the screen edge to avoid blocking text, headers, or keyboard areas.
- **Position Persistence**: Saves the normalized position (`edge: "left" | "right"`, `yPercent: number`) in plugin settings so it stays where you left it across restarts.
- **Auto-Dimming**: Fades to low opacity (e.g. 25–30%) after 3 seconds of inactivity to avoid visual distraction; lights up to 100% on hover, touch, or active sync.

#### B. Visual State Indicators
- 🟢 **Green / Solid**: All files synchronized and clean.
- 🟠 **Amber Glow**: Local modifications pending sync.
- 🔵 **Blue Spinning Ring**: Background sync or chunked transfer in progress.
- 🔴 **Red Alert (`!`) Badge**:
  - Remote version of current note is newer than local version.
  - Or pending file conflicts need review.

#### C. Proactive Remote Check Engine
- **Trigger**: Listen to Obsidian's `file-open` event when the active note changes.
- **Lightweight S3 Check**: Dispatches a single `HeadObjectCommand` (~50ms, negligible network/cost) comparing remote `LastModified` with local baseline record.
- **Banner / Toast Warning**:
  - *"⚠️ Remote note was updated on another device (e.g. 5 mins ago). Sync now to avoid editing conflicts!"*
  - Button: **[Sync Current Note]** or **[Dismiss]**.
- **Battery & Quota Protection**: Avoids checking on every keystroke; debounced and strictly event-driven.

#### D. Tap & Long-Press Actions
- **Single Tap**: Initiates instant vault sync.
- **Long Press / Right-Click / Hover**: Expands a sleek glassmorphic mini-card:
  - Last synced: *"2 minutes ago"*
  - Pending local edits: *"3 notes"*
  - Remote update status: *"Up to date"*
  - Buttons: **[Sync Now]** | **[Resolve Conflicts]** | **[Settings]**

---

### ⚙️ Planned Settings

In **Settings → Save-Je (IDrive e2 Sync)**:
- **Enable Floating Sync Bubble**: `[Toggle: ON / OFF]` (Default: `OFF` or `ON for mobile only`)
- **Proactive Remote Check on Open**: `[Toggle: ON / OFF]` (Checks active note against S3)
- **Idle Opacity**: `[Slider: 10% - 100%]` (Default: `25%`)
- **Reset Bubble Position**: `[Button: Reset to Default]`

---

### 📝 Implementation Notes
- **Container**: Append bubble to `document.body` or `activeDocument.body` to support multi-window popouts in Obsidian.
- **Safe Area Insets**: Respect `env(safe-area-inset-top)` and `env(safe-area-inset-bottom)` on mobile to stay clear of iOS home indicators and Android navigation bars.
- **CSS Transitions**: Use `transform: translate3d(...)` with hardware-accelerated transitions for 60fps snapping.
