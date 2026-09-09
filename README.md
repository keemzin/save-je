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
