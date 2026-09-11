# Save-Je (IDrive e2 Sync)

A minimal, lightweight, and fast Obsidian plugin specifically tailored for **IDrive e2** (S3-compatible 10GB free tier or paid).

Instead of massive plugins supporting dozens of unused cloud storage providers and hundreds of confusing settings, **Save-Je** focuses on one thing: **seamless, 1-click synchronization between your Obsidian vault and IDrive e2.**

---

## ✨ Features

- **Designed for IDrive e2**: Direct S3-compatible integration without OAuth redirects or external cloud baggage.
- **Zero CORS Issues**: Uses Obsidian's native `requestUrl` HTTP transport, ensuring 100% compatibility across both **Obsidian Desktop** (Electron) and **Obsidian Mobile** (iOS & Android).
- **1-Click Sync**: Click the ribbon icon on the sidebar to sync your notes instantly.
- **Minimal Settings**: Just 4 core fields (Endpoint, Access Key, Secret Key, Bucket Name) and a handy **"Test Connection"** button.
- **Lightweight & Fast**: Bundled size is just ~400 KB (compared to >5 MB in bloated multi-cloud alternatives).
- **Safe & Bidirectional**: Intelligently syncs new and updated notes between your local vault and IDrive e2, with safeguards against accidental data deletion.
- **⚡ Visual Diff & Conflict Resolver**: Interactive side-by-side comparison modal with synchronized scrolling (and a mobile-friendly tabbed view) that lets you resolve editing conflicts in 1 click (**Smart Merge**, **Keep Local**, or **Keep Remote**) without manual copy-pasting.
- **🚀 Smart Chunked Transfers (Upload & Download)**: Automatically splits large files (videos, audio recordings, PDFs) into chunks (configurable: 5 MB, 10 MB, 20 MB, 50 MB) with parallel upload and streamed disk downloads via `appendBinary`. Prevents Out-Of-Memory (OOM) crashes on mobile devices while keeping RAM usage flat at $\le 5$ MB.
- **📊 Real-Time Visual Progress Bar**: Live progress card in the notification toast and status bar showing current file, animated track, percentage, and MB counter (`15.2 MB / 30.4 MB`).
- **🧹 Clean Folder Pruning**: Automatically prunes empty parent directories bottom-up when files are deleted and sweeps abandoned directories, preventing empty "ghost" folders from lingering on your devices.
- **Interactive Status & Notifications**: Status bar conflict counter (`⚠️ 1 Conflict [Resolve]`) and sync toast buttons to review and merge conflicts on demand.

---

## ⚡ Device-Aware Conflict Resolution & Visual Diff

When notes are edited on multiple devices before syncing, Save-Je prevents silent data overwrites with an intelligent, visual merge tool:

### 📱 Friendly Device Names (No "Local vs Remote" Confusion)
Save-Je automatically detects your devices (e.g. `Windows PC`, `Android Phone`, `iPhone`, `Mac`) or lets you set a custom device name in settings:
- Diff column headers and action buttons clearly state: **`[Keep Windows PC]`** vs **`[Keep Android Phone]`**.
- Conflict filenames tell you exactly where the edits came from: `notes/daily.conflict-20260911-091520-from-Android_Phone.md`.

### 🔍 How Conflict Detection Works (Line-by-Line)
Just like Git, text comparison works on a **line-by-line** basis:
- If both devices edit different sections of the same note, they merge seamlessly.
- If both devices edit the **exact same line** (even a single word or typo fix), Save-Je flags a conflict and highlights the differences side-by-side so you can choose what to keep.

### 🪄 1-Click Resolution Options
- **🪄 Smart Merge Both**: Combines additions from both devices. If the exact same line was changed on both sides, both versions are kept stacked together so zero data is lost.
- **💻 Keep [This Device]**: Retains your current device's version.
- **☁️ Keep [Other Device]**: Replaces the note with the other device's version.
- **⚪ Decide Later**: Leaves both versions in your vault so you can review later.

> [!TIP]
> Once you click to resolve, Save-Je **automatically syncs the clean note to IDrive e2** and cleans up the temporary conflict copy, so your other devices receive the update immediately with zero lingering conflicts.

---

## Installation

> [!NOTE]
> Currently, the plugin is distributed for beta testing and can be installed via **BRAT (Beta Reviewer's Auto-update Tool)** or manual installation.

### Method 1: Install via BRAT (Recommended)

BRAT automates downloading, installing, and updating beta plugins directly inside Obsidian.

#### Step 1: Install BRAT from Obsidian Community Plugins
1. In Obsidian, open **Settings** (`Ctrl+,` or `Cmd+,`).
2. Select **Community plugins** from the left sidebar.
3. Ensure **Restricted mode** is turned **OFF**.
4. Click **Browse** next to Community plugins.
5. Search for **BRAT** (*Obsidian42 - BRAT* by TfTHacker).
6. Click **Install**, then click **Enable**.

#### Step 2: Add save-je to BRAT
1. Open the Obsidian Command Palette (`Ctrl+P` on Windows/Linux or `Cmd+P` on macOS).
2. Type and select: **`BRAT: Add a beta plugin for testing`**.
3. In the repository URL prompt, enter:
   ```text
   https://github.com/keemzin/save-je
   ```
   *(or simply `/keemzin/save-je`)*
4. Click **Add Plugin**. BRAT will download the latest release files and register the plugin.

#### Step 3: Configure Save-Je(IDrive e2 Sync)
1. Go back to **Settings → Community plugins**.
2. Scroll down to **Save-Je(IDrive e2 Sync)**.

*(BRAT will automatically check for updates and keep your plugin up to date whenever new releases are published!)*

---

## 🚀 Setup & Configuration

1. In IDrive e2 console ([https://console.idrivee2.com](https://console.idrivee2.com)):
   - Create an Access Key (Access Key ID & Secret Access Key).
   - Create a Bucket (e.g. `my-obsidian-notes`).
   - Note your endpoint (e.g. `abcd.sg01.idrivee2-8.com`).
2. In Obsidian:
   - Open **Settings** -> **Save-Je (IDrive e2 Sync)**.
   - Enter your **Endpoint URL** (e.g. `abcd.sg01.idrivee2-8.com`).
   - Enter your **Access Key ID** and **Secret Access Key**.
   - Enter your **Bucket Name**.
   - Click **"Check Connection"** to verify access.
3. Click the sync icon (🔄) on the left sidebar to sync anytime!

---

## 🛠️ Development & Building

```bash
# Install dependencies
npm install

# Build production bundle (main.js)
npm run build

# Watch mode for development
npm run dev
```

To use in your Obsidian vault during development, copy `manifest.json`, `main.js`, and `styles.css` into your vault's `.obsidian/plugins/save-je/` folder.
