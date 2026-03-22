'use strict';

/* ============================================================
   SESSION ENCRYPTION  —  AES-256-GCM encrypted session storage

   Two distinct encryption keys are used, one per scope:

   Tab-scope  (snv-s-{cid}  in sessionStorage):
   • Encrypted with snv-sk — a per-tab AES key in sessionStorage.
   • Survives page refresh within the same tab; dies when the tab
     is closed (sessionStorage is wiped).

   Persistent  (snv-sb-{cid}  in localStorage)  ["Stay signed in"]:
   • Encrypted with snv-bsk — a shared AES-256-GCM key in localStorage.
   • snv-bsk itself is AES-GCM-encrypted before being stored — the
     wrapping key is derived on-the-fly via HKDF from a browser
     fingerprint (origin, language, hardwareConcurrency, colorDepth)
     and NEVER written to any storage.  Copying localStorage to a
     different machine/browser usually produces a different fingerprint
     → wrap-key differs → snv-bsk undecryptable → blobs opaque.
     NOTE: navigator.userAgent is intentionally excluded from the
     fingerprint because Chrome auto-updates silently and would
     invalidate the session on every update.
   • Survives browser restarts until the 7-day TTL expires or the
     user explicitly signs out.

   Separation guarantees:
   • Tab-scope blobs → only the originating tab can decrypt them
     (key in sessionStorage, not shared).
   • Persistent blobs → any tab of the SAME browser can decrypt
     them (shared snv-bsk, same fingerprint → same wrap-key).
   • A copied localStorage is useless without the matching browser.
   ============================================================ */

/* ── Tab-scope session key (sessionStorage, per-tab) ── */
let _sessionKey = null;

async function _getOrCreateSessionKey() {
    if (_sessionKey) return _sessionKey;
    const stored = sessionStorage.getItem('snv-sk');
    if (stored) {
        try {
            const raw = Uint8Array.from(atob(stored), ch => ch.charCodeAt(0));
            _sessionKey = await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
            return _sessionKey;
        } catch { /* corrupted — regenerate below */ }
    }
    const raw = crypto.getRandomValues(new Uint8Array(32));
    const exp = await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, true, ['encrypt', 'decrypt']);
    const exported = await crypto.subtle.exportKey('raw', exp);
    sessionStorage.setItem('snv-sk', btoa(String.fromCharCode(...new Uint8Array(exported))));
    _sessionKey = await crypto.subtle.importKey('raw', exported, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
    return _sessionKey;
}

/* ── Browser fingerprint → HKDF wrap-key (never stored) ──
   Derived deterministically from STABLE browser properties.
   Intentionally excludes navigator.userAgent (changes on every
   Chrome silent auto-update) and navigator.platform (deprecated).
   Properties used are stable across browser version updates. */
let _browserWrapKey = null;

function _getBrowserFingerprint() {
    const n = navigator, s = screen;
    return [
        window.location.origin,              // deployment-bound (stable)
        n.language            || '',          // system language (rarely changes)
        String(n.hardwareConcurrency || 0),   // CPU core count (stable)
        String(s.colorDepth        || 0),     // display bit depth (stable)
        String(s.pixelDepth        || 0),
    ].join('\x00');
}

async function _getOrCreateBrowserWrapKey() {
    if (_browserWrapKey) return _browserWrapKey;
    const fpBytes = new TextEncoder().encode(_getBrowserFingerprint());
    const hkdf = await crypto.subtle.importKey('raw', fpBytes, 'HKDF', false, ['deriveKey']);
    const salt = new Uint8Array(32); // all-zero deterministic salt
    const info = new TextEncoder().encode('snv-browser-wrap-v1');
    _browserWrapKey = await crypto.subtle.deriveKey(
        { name: 'HKDF', hash: 'SHA-256', salt, info },
        hkdf,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt']
    );
    return _browserWrapKey;
}

/* ── Browser-scope session key (localStorage, shared across all tabs, wrap-encrypted) ── */
let _browserScopeKey = null;

async function _getOrCreateBrowserScopeKey() {
    if (_browserScopeKey) return _browserScopeKey;
    const wrapKey = await _getOrCreateBrowserWrapKey();
    const stored = localStorage.getItem('snv-bsk');
    if (stored) {
        const blobBytes = Uint8Array.from(atob(stored), ch => ch.charCodeAt(0));
        // Legacy format (pre-fingerprint-wrap): exactly 32 raw bytes, no IV prefix.
        // Migrate on-the-fly: import the raw key, re-wrap it, overwrite localStorage.
        if (blobBytes.length === 32) {
            try {
                const legacyKey = await crypto.subtle.importKey('raw', blobBytes, { name: 'AES-GCM' }, true, ['encrypt', 'decrypt']);
                const rawExported = await crypto.subtle.exportKey('raw', legacyKey);
                const wrapIV = crypto.getRandomValues(new Uint8Array(12));
                const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: wrapIV }, wrapKey, rawExported);
                const newBlob = new Uint8Array(12 + ct.byteLength);
                newBlob.set(wrapIV);
                newBlob.set(new Uint8Array(ct), 12);
                localStorage.setItem('snv-bsk', btoa(String.fromCharCode(...newBlob)));
                _browserScopeKey = await crypto.subtle.importKey('raw', rawExported, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
                return _browserScopeKey;
            } catch { /* corrupted legacy key — regenerate below */ }
        } else {
            // Current format: IV(12) + AES-GCM(CT) wrapping the 32-byte raw key
            try {
                const iv = blobBytes.slice(0, 12), ct = blobBytes.slice(12);
                const raw = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, wrapKey, ct);
                _browserScopeKey = await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
                return _browserScopeKey;
            } catch { /* fingerprint changed or corrupted — regenerate below */ }
        }
    }
    // Generate fresh snv-bsk and wrap it with the browser-specific key before storing
    const raw = crypto.getRandomValues(new Uint8Array(32));
    const wrapIV = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: wrapIV }, wrapKey, raw);
    const blob = new Uint8Array(12 + ct.byteLength);
    blob.set(wrapIV);
    blob.set(new Uint8Array(ct), 12);
    localStorage.setItem('snv-bsk', btoa(String.fromCharCode(...blob)));
    _browserScopeKey = await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
    return _browserScopeKey;
}

// Browser-scope sessions expire after 7 days; tab-scope persist until tab closes
const SESSION_TTL_BROWSER = 7 * 24 * 60 * 60 * 1000;

async function _encryptSessionPayload(key, cid, rawKeyBytes, expiryMs) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const payload = new Uint8Array(8 + rawKeyBytes.length);
    new DataView(payload.buffer).setBigUint64(0, BigInt(expiryMs), true);
    payload.set(rawKeyBytes, 8);
    const aad = new TextEncoder().encode('snv-session:' + cid);
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, key, payload);
    const blob = new Uint8Array(12 + ct.byteLength);
    blob.set(iv);
    blob.set(new Uint8Array(ct), 12);
    return btoa(String.fromCharCode(...blob));
}

async function _decryptSessionPayload(key, cid, b64) {
    const blob = Uint8Array.from(atob(b64), ch => ch.charCodeAt(0));
    const iv = blob.slice(0, 12), ct = blob.slice(12);
    const aad = new TextEncoder().encode('snv-session:' + cid);
    const dec = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: aad }, key, ct);
    const payload = new Uint8Array(dec);
    const expiry = Number(new DataView(payload.buffer).getBigUint64(0, true));
    if (Date.now() > expiry) return null; // expired
    return payload.slice(8); // 32-byte raw key material
}

// rawKeyBytes — Uint8Array(32) from Crypto.deriveRaw(), never the plaintext password
async function saveSession(cid, rawKeyBytes, scope) {
    if (scope === 'browser') {
        // Use the shared browser-scope key so ALL tabs can resume this session
        const key = await _getOrCreateBrowserScopeKey();
        const b64 = await _encryptSessionPayload(key, cid, rawKeyBytes, Date.now() + SESSION_TTL_BROWSER);
        localStorage.setItem('snv-sb-' + cid, b64);
        sessionStorage.removeItem('snv-s-' + cid);
    } else {
        // Use the per-tab key; only this tab can decrypt it
        const key = await _getOrCreateSessionKey();
        const b64 = await _encryptSessionPayload(key, cid, rawKeyBytes, Number.MAX_SAFE_INTEGER);
        sessionStorage.setItem('snv-s-' + cid, b64);
        localStorage.removeItem('snv-sb-' + cid);
    }
}

// Returns Uint8Array(32) raw key bytes on success, or null on failure/expiry
async function loadSession(cid) {
    // Tab-scope first — per-tab key, lives in sessionStorage
    const tabBlob = sessionStorage.getItem('snv-s-' + cid);
    if (tabBlob) {
        try {
            const key = await _getOrCreateSessionKey();
            const raw = await _decryptSessionPayload(key, cid, tabBlob);
            if (raw) return raw;
            // null means expired
            sessionStorage.removeItem('snv-s-' + cid);
        } catch {
            // Corrupted tab blob — belongs to this tab, safe to clear
            sessionStorage.removeItem('snv-s-' + cid);
        }
    }

    // Browser-scope — shared key, any tab can decrypt
    const browserBlob = localStorage.getItem('snv-sb-' + cid);
    if (browserBlob) {
        try {
            const key = await _getOrCreateBrowserScopeKey();
            const raw = await _decryptSessionPayload(key, cid, browserBlob);
            if (raw) return raw;
            // null means expired
            localStorage.removeItem('snv-sb-' + cid);
        } catch {
            // Corrupted blob — remove it
            localStorage.removeItem('snv-sb-' + cid);
        }
    }

    return null;
}

function clearSession(cid) {
    sessionStorage.removeItem('snv-s-' + cid);
    localStorage.removeItem('snv-sb-' + cid);
}

function hasSession(cid) {
    return !!(sessionStorage.getItem('snv-s-' + cid) || localStorage.getItem('snv-sb-' + cid));
}

/* ============================================================
   TAB SESSION GUARD
   Prevents the same container from being opened in two tabs
   simultaneously. Uses localStorage for cross-tab visibility
   and a heartbeat to detect stale (dead tab) claims.
   ============================================================ */
const _OPEN_TTL = 30000; // consider stale after 6 missed heartbeats (heartbeat = 5 s)
let _sessionHeartbeat = null;

function _openKey(cid) { return 'snv-open-' + cid; }

/** Returns true if another live tab currently has this container open. */
function _checkContainerSession(cid) {
    try {
        const raw = localStorage.getItem(_openKey(cid));
        if (!raw) return false;
        const d = JSON.parse(raw);
        return !!(d && d.tab !== _TAB_ID && (Date.now() - d.ts) < _OPEN_TTL);
    } catch { return false; }
}

/** Claim the container session for this tab and start heartbeat. */
function _startContainerSession(cid) {
    const write = () => localStorage.setItem(_openKey(cid), JSON.stringify({ tab: _TAB_ID, ts: Date.now() }));
    write();
    if (_sessionHeartbeat) clearInterval(_sessionHeartbeat);
    _sessionHeartbeat = setInterval(() => {
        if (App.container?.id === cid) write(); else _stopContainerSession(cid);
    }, 5000);
}

/** Release the container session claim for this tab. */
function _stopContainerSession(cid) {
    if (_sessionHeartbeat) { clearInterval(_sessionHeartbeat); _sessionHeartbeat = null; }
    if (!cid) return;
    try {
        const raw = localStorage.getItem(_openKey(cid));
        if (raw) {
            const d = JSON.parse(raw);
            if (d.tab === _TAB_ID) localStorage.removeItem(_openKey(cid));
        }
    } catch { localStorage.removeItem(_openKey(cid)); }
}

/** Force-claim: writes kick flag → causes the other tab to lock itself via storage event. */
function _forceClaimSession(cid) {
    localStorage.setItem(_openKey(cid), JSON.stringify({ tab: _TAB_ID, ts: Date.now(), kick: true }));
}

/* ============================================================
   APP STATE
   ============================================================ */
const App = {
    view: 'home',
    container: null,   // container metadata object
    key: null,   // CryptoKey (in-memory only, never persisted)
    folder: 'root',
    selection: new Set(),
    clipboard: null,   // { op: 'copy'|'cut', ids: [...] }
    thumbCache: {},    // nodeId → dataURL
    _winCtx: null,   // active FolderWindow context (set by FolderWindow ops)
    _ctxScreenPos: null, // screen {x,y} of last context-menu click (used to position new files/folders)

    async init() {
        if (!window.isSecureContext || !window.crypto?.subtle) {
            const ol = document.getElementById('loading-overlay');
            if (ol) {
                const reason = !window.isSecureContext
                    ? 'Open this page over <strong style="color:var(--text)">HTTPS</strong> or <code style="color:var(--accent);font-family:monospace">localhost</code>.'
                    : 'This browser does not support the Web Crypto API.';
                ol.innerHTML = `
          <div style="text-align:center;max-width:380px;padding:0 24px">
            <svg width="44" height="44" viewBox="0 0 24 24" fill="none" style="color:#f44747;margin-bottom:16px" xmlns="http://www.w3.org/2000/svg">
              <path d="M12 2L2 20h20z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>
              <path d="M12 9v5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
              <circle cx="12" cy="16.5" r="0.8" fill="currentColor"/>
            </svg>
            <div style="color:var(--text);font-size:16px;font-weight:600;margin-bottom:8px">Web Crypto API unavailable</div>
            <div style="color:var(--text-dim);font-size:13px;line-height:1.7">${reason}<br>Use Chrome, Firefox, or Edge.</div>
          </div>`;
                ol.style.cssText += 'display:flex;opacity:1;pointer-events:all;';
            }
            return;
        }
        await DB.init();
        this.showView('home');
        await Home.render();
        await updateStorageInfo();
    },

    showView(name) {
        document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
        document.getElementById('view-' + name).classList.add('active');
        this.view = name;
    },

    // Return to home WITHOUT killing the session (password stays remembered)
    async backToMenu() {
        document.title = 'SafeNova';
        if (this.container?.id) _stopContainerSession(this.container.id);
        this.key = null;
        this.container = null;
        this.folder = 'root';
        this.selection = new Set();
        this.clipboard = null;
        this.thumbCache = {};
        this._winCtx = null;
        if (typeof WinManager !== 'undefined') WinManager.closeAll();
        if (typeof _resetContainerSettings === 'function') _resetContainerSettings();
        if (typeof Desktop !== 'undefined') {
            Desktop._desktopFolder = 'root';
            Desktop._sel = this.selection;
        }
        VFS.init();
        this.showView('home');
        await Home.render();
        await updateStorageInfo();
    },

    async lockContainer() {
        document.title = 'SafeNova';
        const cid = this.container?.id;
        if (cid) { _stopContainerSession(cid); clearSession(cid); }
        this.key = null;
        this.container = null;
        this.folder = 'root';
        this.selection = new Set();
        this.clipboard = null;
        this.thumbCache = {};
        this._winCtx = null;
        // Close all open folder windows
        if (typeof WinManager !== 'undefined') WinManager.closeAll();
        if (typeof _resetContainerSettings === 'function') _resetContainerSettings();
        // Keep remembered sessions intact — "Back to menu" should not kill stored passwords
        // Reset desktop folder tracking
        if (typeof Desktop !== 'undefined') {
            Desktop._desktopFolder = 'root';
            Desktop._sel = this.selection;
        }
        VFS.init();
        this.showView('home');
        await Home.render();
        await updateStorageInfo();
    }
};

/* ============================================================
   LOADING OVERLAY
   ============================================================ */
function showLoading(msg = 'Processing...') {
    document.getElementById('loading-msg').textContent = msg;
    document.getElementById('loading-overlay').classList.add('show');
}
function hideLoading() {
    document.getElementById('loading-overlay').classList.remove('show');
}

/* ============================================================
   TOAST NOTIFICATIONS
   ============================================================ */
function toast(msg, type = 'info') {
    const t = document.createElement('div');
    t.className = 'toast ' + type;
    const iconMap = {
        success: Icons.info,
        error: Icons.warning,
        warn: Icons.warning,
        info: Icons.info,
    };
    t.innerHTML = `<span style="color:var(--text-dim)">${iconMap[type] || ''}</span><span>${escHtml(msg)}</span>`;
    document.getElementById('toast-container').appendChild(t);
    setTimeout(() => t.remove(), 3200);
}

/* ============================================================
   MODAL OVERLAY HELPER
   ============================================================ */
const Overlay = {
    current: null,
    _hideTimer: null,

    show(modalId) {
        // Cancel any pending hide so the modal doesn't get wiped by a deferred setTimeout
        if (this._hideTimer) { clearTimeout(this._hideTimer); this._hideTimer = null; }
        const ov = document.getElementById('modal-overlay');
        ov.querySelectorAll('.modal').forEach(m => m.style.display = 'none');
        const m = document.getElementById(modalId);
        if (m) m.style.display = 'flex';
        ov.classList.add('show');
        this.current = modalId;
    },

    hide() {
        document.getElementById('modal-overlay').classList.remove('show');
        this._hideTimer = setTimeout(() => {
            this._hideTimer = null;
            document.getElementById('modal-overlay')
                .querySelectorAll('.modal').forEach(m => m.style.display = 'none');
        }, 200);
        this.current = null;
        // If cancelled from a FolderWindow context — restore main desktop state
        if (App._winCtx !== null) {
            App._winCtx = null;
            if (typeof Desktop !== 'undefined') {
                App.folder = Desktop._desktopFolder;
                App.selection = Desktop._sel;
            }
        }
    }
};

/* ============================================================
   STORAGE INFO  —  20 GB device limit + low-space warnings
   ============================================================ */
let _storageWarnShown = false;

async function updateStorageInfo() {
    try {
        if (!navigator.storage?.estimate) return;
        const est = await navigator.storage.estimate();
        const used = est.usage || 0,
            quota = est.quota || 0,
            available = quota - used;

        // Cap the visual scale at DEVICE_LIMIT (20 GB)
        const displayMax = Math.min(quota > 0 ? quota : DEVICE_LIMIT, DEVICE_LIMIT),
            pct = displayMax > 0 ? Math.min((used / displayMax) * 100, 100) : 0;

        const fill = document.getElementById('storage-bar-fill');
        const txt = document.getElementById('storage-text');
        if (fill) {
            fill.style.width = pct + '%';
            fill.className = 'storage-bar-fill' + (pct > 90 ? ' danger' : pct > 70 ? ' warn' : '');
        }
        if (txt) txt.textContent = `${fmtSize(used)} / ${fmtSize(displayMax)}  ·  ${fmtSize(available)} free`;

        // Storage warning banner
        const banner = document.getElementById('storage-warning-banner');
        if (banner) {
            if (available < 200 * 1024 * 1024) {        // < 200 MB
                banner.querySelector('span').textContent =
                    `Critical: only ${fmtSize(available)} of storage remaining on this device. Data may not be saved.`;
                banner.classList.add('show');
            } else if (available < 1 * 1024 * 1024 * 1024) { // < 1 GB
                banner.querySelector('span').textContent =
                    `Low storage: ${fmtSize(available)} remaining on this device.`;
                banner.classList.add('show');
            } else {
                banner.classList.remove('show');
            }
        }

        // One-time toast for low storage
        if (!_storageWarnShown && available < 500 * 1024 * 1024) {
            _storageWarnShown = true;
            if (available < 100 * 1024 * 1024) {
                toast(`Critical: only ${fmtSize(available)} free on this device!`, 'error');
            } else {
                toast(`Low storage: ${fmtSize(available)} remaining.`, 'warn');
            }
        }

        // TrueWebCrypt containers usage
        const containers = await DB.getContainers();
        const twcUsed = containers.reduce((s, c) => s + (c.totalSize || 0), 0);
        const twcPct = displayMax > 0 ? Math.min((twcUsed / displayMax) * 100, 100) : 0;
        const twcFill = document.getElementById('twc-bar-fill');
        const twcTxt = document.getElementById('twc-text');
        if (twcFill) twcFill.style.width = twcPct + '%';
        if (twcTxt) twcTxt.textContent = `${fmtSize(twcUsed)} in ${containers.length} container${containers.length !== 1 ? 's' : ''}`;
    } catch (e) { /* silently ignore — storage API may be restricted */ }
}

/* ============================================================
   CHECK DEVICE STORAGE BEFORE WRITE
   Returns { ok: bool, available: number }
   ============================================================ */
async function checkStorageSpace(needed) {
    try {
        if (!navigator.storage?.estimate) return { ok: true, available: Infinity };
        const est = await navigator.storage.estimate(),
            available = (est.quota || 0) - (est.usage || 0);
        // Keep 50 MB safety margin
        if (available - needed < 50 * 1024 * 1024) {
            return { ok: false, available };
        }
        return { ok: true, available };
    } catch { return { ok: true, available: Infinity }; }
}
