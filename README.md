![](./pics/intro.png)

> ### Try it online: [https://safenova.dosx.su/](https://safenova.dosx.su/)

## ❔ What it is

SafeNova is a single-page web app that lets you create encrypted **containers** — isolated vaults where you can organize files in a folder structure, much like a regular desktop file manager. Everything is encrypted client-side before being written to storage. Nothing ever leaves your device.

![](./pics/screenshot.png)

Key properties:

-   **Zero-knowledge** — the app never sees your password or plaintext data
-   **Offline-first** — works entirely without network access
-   **No installation** — start the local server and you're running (or use online)

---

## ⚙️ Features

-   **Multiple containers** — each with its own password and independent storage limit (8 GB per container)
-   **Virtual filesystem** — nested folders, drag-to-reorder icons, customizable folder colors
-   **File operations** — upload (drag & drop or browse), download, copy, cut, paste, rename, delete
-   **Built-in viewers** — text editor, image viewer, audio/video player, PDF viewer
-   **Hardware key support** — optionally use a WebAuthn passkey to strengthen the container salt
-   **Session memory** — optionally remember your session per tab or per browser
-   **Container import / export** — portable `.safenova` container files
-   **Sort & arrange** — sort icons by name, date, size, or type; drag to custom positions
-   **Keyboard shortcuts** — `Delete`, `F2`, `Ctrl+A`, `Ctrl+C/X/V`, `Ctrl+S` (save in editor), `Escape`
-   **Mobile-friendly** — touch drag, rubber-band selection, single/double-tap gestures

---

## 🔐 Encryption

| Layer           | Algorithm                                       |
| --------------- | ----------------------------------------------- |
| Key derivation  | Argon2id (19 MB memory, 2 iterations, 1 thread) |
| File encryption | AES-256-GCM (random 12-byte IV per file)        |
| VFS encryption  | AES-256-GCM (same key as files)                 |
| Integrity check | AES-256-GCM verification blob on unlock         |

Every file is encrypted individually. The virtual filesystem structure is also encrypted as a separate blob. The plaintext password is never stored — only the derived key is held in memory during an active session.

---

## 📋 Requirements

-   A modern browser: **Chrome 90+**, **Firefox 90+**, **Safari 15+**, or **Edge 90+**
-   Web Crypto API must be available — this requires either **HTTPS** or **`localhost`**
-   No plugins, no extensions, no backend

---

## 🚀 Getting started

### Option A — Use online version

SafeNova is hosted on: [https://safenova.dosx.su/](https://safenova.dosx.su/)

### Option B — Local server

A zero-dependency PowerShell server is included:

```powershell
.\\.server.ps1
```

Or right-click the file → **Run with PowerShell**. It starts an HTTP server on port `7777` (or the next free port) and opens the app in your default browser.

No external installs needed — it uses the Windows built-in `HttpListener`.

---

## 📁 Project structure

```
SafeNova/
│
├── index.html          # Single-page app entry point
├── favicon.png         # Application icon
├── .server.ps1         # Local PowerShell dev server (Windows)
│
├── css/
│   └── app.css         # All application styles
│
└── js/
    ├── constants.js    # Shared constants, utilities, icon SVGs
    ├── state.js        # App state singleton (key, container, session)
    ├── crypto.js       # AES-256-GCM + Argon2id encryption layer
    ├── db.js           # IndexedDB abstraction (containers / files / vfs)
    ├── vfs.js          # In-memory virtual filesystem
    ├── fileops.js      # Upload, download, copy/paste, rename, delete
    ├── home.js         # Container management (create, unlock, import, export)
    ├── main.js         # Event binding and app boot
    └── desktop.js      # Desktop UI — icons, folder windows, drag & drop
```

---

## 🔒 How containers work

1. **Create** a container with a name and password
2. **Unlock** the container — Argon2id derives the key from your password
3. Files you upload are encrypted with AES-256-GCM before being saved to IndexedDB
4. The virtual filesystem (folder tree + icon positions) is also encrypted and saved separately
5. **Lock** the container — the key is wiped from memory

All container data is scoped to the current browser and device. Use **Export Container** to back up or transfer to another device.

---

## 💬 Community

Have questions, ideas, or just want to chat? Here's where to find us:

-   **GitHub Issues**: Report bugs or request features via [Issues](https://github.com/DosX-dev/SafeNova/issues)

---

## 🤝 Thanks to all contributors

<a href="https://github.com/DosX-dev/SafeNova/graphs/contributors">
<img src="https://readme-contribs.as93.net/contributors/DosX-dev/SafeNova?textColor=737373&perRow=9&shape=squircle&isResponsive=true" />
</a>