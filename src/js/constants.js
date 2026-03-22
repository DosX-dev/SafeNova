'use strict';

/* ============================================================
   CONSTANTS
   ============================================================ */
const DB_NAME = 'SafeNovaEFS',
    DB_VERSION = 2,
    CONTAINER_LIMIT = 8 * 1024 * 1024 * 1024,   // 8 GB per container
    DEVICE_LIMIT = 20 * 1024 * 1024 * 1024,     // 20 GB total device display limit

    ARGON2_MEM = 19456,                         // 19 MB memory cost (OWASP minimum)
    ARGON2_ITER = 2,                            // time cost (iterations)
    ARGON2_PAR = 1,                             // parallelism
    VERIFY_TEXT = 'SafeNovaEFS-VERIFY-OK';
// Degree of parallelism for AES-GCM operations: cap at 8 to avoid
// flooding the thread with microtasks on high-core-count machines.
const _CRYPTO_CONCURRENCY = Math.min(8, navigator.hardwareConcurrency || 4);
let ICON_W = 84,
    ICON_H = 90;
let GRID_X = 96,   // horizontal grid cell size
    GRID_Y = 96;   // vertical   grid cell size

/* ============================================================
   UTILITIES
   ============================================================ */
function uid() {
    return crypto.randomUUID
        ? crypto.randomUUID()
        : Date.now().toString(36) + Math.random().toString(36).slice(2);
}

/* ============================================================
   TAB IDENTITY
   Each browser tab gets a stable UUID so we can detect when
   the same container is being opened in two different tabs.
   Stored in sessionStorage so a page refresh keeps the same ID,
   while a brand-new tab always gets a fresh one.
   ============================================================ */
const _TAB_ID = (() => {
    let id = sessionStorage.getItem('snv-tab-id');
    if (!id) { id = uid(); sessionStorage.setItem('snv-tab-id', id); }
    return id;
})();

function fmtSize(b) {
    if (b === 0) return '0 B';
    const k = 1024, s = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.min(Math.floor(Math.log(b) / Math.log(k)), s.length - 1);
    return (b / Math.pow(k, i)).toFixed(i > 0 ? 1 : 0) + ' ' + s[i];
}

function fmtDate(ts) {
    const d = new Date(ts);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) + ' ' +
        d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
}

function getExt(name) {
    const p = name.lastIndexOf('.');
    return p > 0 ? name.slice(p + 1).toLowerCase() : '';
}

function getMime(name) {
    const e = getExt(name);
    return ({
        txt: 'text/plain', md: 'text/markdown', html: 'text/html', htm: 'text/html',
        css: 'text/css', js: 'text/javascript', ts: 'text/typescript', json: 'application/json',
        xml: 'application/xml', csv: 'text/csv', py: 'text/x-python', rs: 'text/x-rust',
        go: 'text/x-go', java: 'text/x-java', c: 'text/x-c', cpp: 'text/x-c++',
        sh: 'text/x-sh', bat: 'text/x-bat', yaml: 'text/yaml', yml: 'text/yaml',
        png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
        webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', ico: 'image/x-icon',
        avif: 'image/avif',
        pdf: 'application/pdf',
        mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', flac: 'audio/flac', m4a: 'audio/m4a',
        mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', avi: 'video/x-msvideo',
        zip: 'application/zip', rar: 'application/x-rar-compressed',
        gz: 'application/gzip', '7z': 'application/x-7z-compressed', tar: 'application/x-tar',
        doc: 'application/msword',
        docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        xls: 'application/vnd.ms-excel',
        xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        ppt: 'application/vnd.ms-powerpoint',
        pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
    })[e] || 'application/octet-stream';
}

function isText(mime, name) {
    return mime.startsWith('text/') ||
        ['application/json', 'application/xml', 'application/javascript'].includes(mime);
}
function isImage(mime) { return mime.startsWith('image/'); }
function isAudio(mime) { return mime.startsWith('audio/'); }
function isVideo(mime) { return mime.startsWith('video/'); }
function isPDF(mime) { return mime === 'application/pdf'; }

function buf2b64(buf) {
    const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    const CHUNK = 8192;
    let s = '';
    for (let i = 0; i < u8.length; i += CHUNK)
        s += String.fromCharCode.apply(null, u8.subarray(i, Math.min(i + CHUNK, u8.length)));
    return btoa(s);
}
function b642buf(s) {
    const b = atob(s), u = new Uint8Array(b.length);
    for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i);
    return u.buffer;
}

function pwStrength(pw) {
    let s = 0;
    if (pw.length >= 8) s++;
    if (pw.length >= 12) s++;
    if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) s++;
    if (/\d/.test(pw)) s++;
    if (/[^a-zA-Z0-9]/.test(pw)) s++;
    return s; // 0–5
}

function escHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/* Shared error/cooldown SVG fragments reused across all password forms */
const _ERR_SVG  = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M8 1.5a6.5 6.5 0 100 13 6.5 6.5 0 000-13zM7.25 5h1.5v4h-1.5V5zm0 5h1.5v1.5h-1.5V10z" fill="currentColor"/></svg>';
const _WAIT_SVG = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><circle cx="7" cy="7" r="6" stroke="currentColor" stroke-width="1.3"/><path d="M7 4v3.5l2.5 1.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>';

/* Shared brute-force cooldown — disables btn and shows 3-second countdown in errEl */
function _startAttemptCooldown(errEl, btn, onClear) {
    let remaining = 3;
    const upd = s => { errEl.innerHTML = `${_WAIT_SVG} Too many attempts — wait ${s}s`; errEl.style.color = 'var(--orange)'; };
    upd(remaining);
    btn.disabled = true;
    const _t = setInterval(() => {
        if (--remaining <= 0) {
            clearInterval(_t);
            errEl.innerHTML = ''; errEl.style.color = '';
            btn.disabled = false;
            onClear?.();
        } else {
            upd(remaining);
        }
    }, 1000);
}

/* ============================================================
   FOLDER COLOR PALETTE
   ============================================================ */
const FOLDER_COLORS = [
    { label: 'Default (Blue)', color: '#0078d4' },
    { label: 'Teal', color: '#4ec9b0' },
    { label: 'Purple', color: '#9b59d0' },
    { label: 'Orange', color: '#f18800' },
    { label: 'Red', color: '#e84040' },
    { label: 'Green', color: '#3cb371' },
    { label: 'Pink', color: '#e879a0' },
    { label: 'Yellow', color: '#d4b030' },
    { label: 'Grey', color: '#7a7a7a' },
];

/* ============================================================
   SVG ICON LIBRARY  — 16×16 UI icons
   ============================================================ */
const Icons = {
    open: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M1 4.5h5l1.5 2H15v8H1z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>`,
    file: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M3 1h7l3 3v10H3z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="M10 1v3h3" stroke="currentColor" stroke-width="1.4"/></svg>`,
    folder: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M1 4.5h5l1.5 2H15v8H1z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>`,
    download: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M8 2v8M4 7l4 4 4-4M2 14h12" stroke="currentColor" stroke-width="1.5" stroke-linecap="square" stroke-linejoin="miter"/></svg>`,
    upload: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M8 10V2M4 5l4-4 4 4M2 14h12" stroke="currentColor" stroke-width="1.5" stroke-linecap="square" stroke-linejoin="miter"/></svg>`,
    rename: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M11 2l3 3-8 8H3v-3z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="M9 4l3 3" stroke="currentColor" stroke-width="1.4"/></svg>`,
    trash: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M2 4h12" stroke="currentColor" stroke-width="1.4" stroke-linecap="square"/><path d="M5 4V2h6v2" stroke="currentColor" stroke-width="1.4" stroke-linecap="square"/><path d="M3 4l1 10h8l1-10" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="M6 7v4M10 7v4" stroke="currentColor" stroke-width="1.4" stroke-linecap="square"/></svg>`,
    info: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="8" cy="8" r="6.5" stroke="currentColor" stroke-width="1.4"/><path d="M8 7v4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><circle cx="8" cy="5.2" r="0.8" fill="currentColor"/></svg>`,
    paste: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="5" y="4" width="9" height="10" rx="1" stroke="currentColor" stroke-width="1.4"/><path d="M5 7H2V15h8v-1" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="M6 2h4v3H6z" stroke="currentColor" stroke-width="1.4"/></svg>`,
    sort: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M2 4h8M2 8h6M2 12h4M12 2v10" stroke="currentColor" stroke-width="1.4" stroke-linecap="square"/><path d="M9 9l3 4 3-4" stroke="currentColor" stroke-width="1.4" stroke-linecap="square" stroke-linejoin="miter"/></svg>`,
    unlock: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="2" y="7" width="12" height="8" rx="1" stroke="currentColor" stroke-width="1.4"/><path d="M5 7V5a3 3 0 015.8-1" stroke="currentColor" stroke-width="1.4" stroke-linecap="square"/></svg>`,
    copy: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="5" y="5" width="9" height="9" rx="1" stroke="currentColor" stroke-width="1.4"/><path d="M4 11H2V2h9v2" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>`,
    cut: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="4.5" cy="12.5" r="2" stroke="currentColor" stroke-width="1.4"/><circle cx="11.5" cy="12.5" r="2" stroke="currentColor" stroke-width="1.4"/><path d="M4.5 10.5L11 2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><path d="M11.5 10.5L5 2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>`,
    newfile: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M3 1h7l3 3v10H3z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="M10 1v3h3" stroke="currentColor" stroke-width="1.4"/><path d="M8 7v5M5.5 9.5h5" stroke="currentColor" stroke-width="1.4" stroke-linecap="square"/></svg>`,
    newfolder: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M1 4.5h5l1.5 2H15v8H1z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="M8 8.5v4M6 10.5h4" stroke="currentColor" stroke-width="1.4" stroke-linecap="square"/></svg>`,
    warning: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M8 2L1 14h14z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="M8 6v4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><circle cx="8" cy="12" r="0.8" fill="currentColor"/></svg>`,
    lock: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="2" y="7" width="12" height="8" rx="1" stroke="currentColor" stroke-width="1.4"/><path d="M5 7V5a3 3 0 016 0v2" stroke="currentColor" stroke-width="1.4" stroke-linecap="square"/></svg>`,
    key: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="5" cy="11" r="3" stroke="currentColor" stroke-width="1.4"/><path d="M7.2 8.8L14 2M12 2l2 2M10 4l2 2" stroke="currentColor" stroke-width="1.4" stroke-linecap="square"/></svg>`,
    navup: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M8 12V4M4 8l4-4 4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="square"/></svg>`,
    fileup: `<svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M7 9V1M3 5l4-4 4 4M2 11h10v2H2z" stroke="currentColor" stroke-width="1.5" stroke-linecap="square"/></svg>`,
    filedoc: `<svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M2 1h7l3 3v9H2z" stroke="currentColor" stroke-width="1.5" stroke-linecap="square"/><path d="M9 1v3h3" stroke="currentColor" stroke-width="1.5" stroke-linecap="square"/></svg>`,
    filedir: `<svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M1 3h5l1.5 2H13v7H1z" stroke="currentColor" stroke-width="1.5" stroke-linecap="square"/></svg>`,
    plus: `<svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M7 1v12M1 7h12" stroke="currentColor" stroke-width="2" stroke-linecap="square"/></svg>`,
    close: `<svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M2 2l10 10M12 2L2 12" stroke="currentColor" stroke-width="1.5" stroke-linecap="square"/></svg>`,
    eye: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M1 8s2.5-5 7-5 7 5 7 5-2.5 5-7 5-7-5-7-5z" stroke="currentColor" stroke-width="1.5"/><circle cx="8" cy="8" r="2.5" stroke="currentColor" stroke-width="1.5"/></svg>`,
    eyeoff: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M1 8s2.5-5 7-5 7 5 7 5-2.5 5-7 5-7-5-7-5z" stroke="currentColor" stroke-width="1.5"/><circle cx="8" cy="8" r="2.5" stroke="currentColor" stroke-width="1.5"/><path d="M3 3l10 10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`, save: `<svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="1" y="1" width="12" height="12" rx="1" stroke="currentColor" stroke-width="1.5"/><rect x="3" y="1" width="8" height="5" stroke="currentColor" stroke-width="1.5"/><rect x="4" y="7" width="6" height="5" stroke="currentColor" stroke-width="1.4"/></svg>`,
    dlbtn: `<svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M7 9V1M3 6l4 4 4-4M2 12h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="square"/></svg>`,
    sortAsc: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M4 12V4M2 6l2-2 2 2" stroke="currentColor" stroke-width="1.4" stroke-linecap="square"/><path d="M8 5h6M8 8h4.5M8 11h3" stroke="currentColor" stroke-width="1.4" stroke-linecap="square"/></svg>`,
    sortDesc: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M4 4v8M2 10l2 2 2-2" stroke="currentColor" stroke-width="1.4" stroke-linecap="square"/><path d="M8 5h3M8 8h4.5M8 11h6" stroke="currentColor" stroke-width="1.4" stroke-linecap="square"/></svg>`,
    sortName: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M3 3h10M5 7h6M7 11h2" stroke="currentColor" stroke-width="1.5" stroke-linecap="square"/></svg>`,
    sortDate: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="2" y="3" width="12" height="11" rx="1" stroke="currentColor" stroke-width="1.4"/><path d="M2 6h12M5 1v3M11 1v3" stroke="currentColor" stroke-width="1.4" stroke-linecap="square"/></svg>`,
    sortSize: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="2" y="10" width="4" height="4" stroke="currentColor" stroke-width="1.3"/><rect x="6" y="6" width="4" height="8" stroke="currentColor" stroke-width="1.3"/><rect x="10" y="2" width="4" height="12" stroke="currentColor" stroke-width="1.3"/></svg>`,
    sortType: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M2 2h5l2 2v6H2z" stroke="currentColor" stroke-width="1.3"/><path d="M7 2v2h2" stroke="currentColor" stroke-width="1.3"/><path d="M7 8h5l2 2v4H7z" stroke="currentColor" stroke-width="1.3"/><path d="M12 8v2h2" stroke="currentColor" stroke-width="1.3"/></svg>`,
    refresh: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M13.5 8a5.5 5.5 0 01-9.8 3.4" stroke="currentColor" stroke-width="1.5" stroke-linecap="square"/><path d="M2.5 8a5.5 5.5 0 019.8-3.4" stroke="currentColor" stroke-width="1.5" stroke-linecap="square"/><path d="M12.3 2v3h-3" stroke="currentColor" stroke-width="1.5" stroke-linecap="square" stroke-linejoin="miter"/><path d="M3.7 14v-3h3" stroke="currentColor" stroke-width="1.5" stroke-linecap="square" stroke-linejoin="miter"/></svg>`,
};

/* ============================================================
   LARGE (48×48) FILE TYPE ICONS — for desktop thumbnails
   ============================================================ */
function getFolderSVG(color) {
    // Validate: only allow CSS hex colors to prevent SVG attribute injection
    const c = /^#[0-9a-fA-F]{3,8}$/.test(color) ? color : '#0078d4';
    return `<svg width="48" height="48" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M4 14h17l5 7h18v21H4z" fill="${c}" opacity=".22" stroke="${c}" stroke-width="1.5" stroke-linejoin="round"/>
    <path d="M4 21h40v21H4z" fill="${c}" opacity=".35" stroke="${c}" stroke-width="1.5" stroke-linejoin="round"/>
  </svg>`;
}

function getFileIconSVG(mime, name) {
    const ext = getExt(name || '');
    if (isImage(mime)) return _bigIcon('#9cdcfe', _imgPath());
    if (isAudio(mime)) return _bigIcon('#c678dd', _audioPath());
    if (isVideo(mime)) return _bigIcon('#c678dd', _videoPath());
    if (isPDF(mime)) return _bigIcon('#f44747', _pdfPath());
    if (isText(mime, name)) {
        if (['js', 'ts', 'py', 'rs', 'go', 'java', 'c', 'cpp', 'cs', 'php', 'rb', 'sh', 'bat'].includes(ext))
            return _bigIcon('#dcdcaa', _codePath());
        if (['json', 'yaml', 'yml', 'xml', 'csv'].includes(ext))
            return _bigIcon('#4ec9b0', _dataPath());
        return _bigIcon('#d4d4d4', _textPath());
    }
    if (['zip', 'rar', 'gz', '7z', 'tar'].includes(ext)) return _bigIcon('#ce9178', _archivePath());
    if (['doc', 'docx'].includes(ext)) return _bigIcon('#569cd6', _docPath());
    if (['xls', 'xlsx'].includes(ext)) return _bigIcon('#4ec9b0', _dataPath());
    if (['ppt', 'pptx'].includes(ext)) return _bigIcon('#ce9178', _slidePath());
    // Unknown type — show extension label inside icon (≤ 4 chars only)
    if (ext && ext.length <= 4) return _bigIconExt('#858585', ext.toUpperCase());
    return _bigIcon('#858585', _filePath());
}

function _bigIcon(color, inner) {
    return `<svg width="48" height="48" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M10 4h18l10 10v30H10z" fill="${color}" opacity=".1" stroke="${color}" stroke-width="1.5" stroke-linejoin="round"/>
    <path d="M28 4v10h10" stroke="${color}" stroke-width="1.5" stroke-linecap="square"/>
    ${inner.replace(/COLOR/g, color)}
  </svg>`;
}

function _filePath() { return `<path d="M16 26h16M16 31h12" stroke="COLOR" stroke-width="1.8" stroke-linecap="square" opacity=".7"/>`; }
function _textPath() { return `<path d="M16 23h16M16 28h16M16 33h11" stroke="COLOR" stroke-width="1.8" stroke-linecap="square" opacity=".7"/>`; }
function _codePath() { return `<path d="M19 22l-5 5 5 5M29 22l5 5-5 5M25 19l-4 14" stroke="COLOR" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" opacity=".8"/>`; }
function _dataPath() { return `<path d="M15 25h18M21 20v14M27 20v14" stroke="COLOR" stroke-width="1.8" stroke-linecap="square" opacity=".7"/>`; }
function _imgPath() { return `<rect x="15" y="20" width="18" height="14" rx="1" stroke="COLOR" stroke-width="1.5" opacity=".7"/><circle cx="20" cy="25" r="2" fill="COLOR" opacity=".6"/><path d="M15 31l7-5 4 4 3-2 4 3" stroke="COLOR" stroke-width="1.5" stroke-linejoin="round" opacity=".7"/>`; }
function _audioPath() { return `<circle cx="24" cy="27" r="6" stroke="COLOR" stroke-width="1.5" opacity=".7"/><circle cx="24" cy="27" r="2" fill="COLOR" opacity=".6"/><path d="M20 21v6" stroke="COLOR" stroke-width="1.8" stroke-linecap="round" opacity=".6"/>`; }
function _videoPath() { return `<rect x="13" y="21" width="15" height="12" rx="1" stroke="COLOR" stroke-width="1.5" opacity=".7"/><path d="M28 24l7-3v10l-7-3z" fill="COLOR" opacity=".5" stroke="COLOR" stroke-width="1.5" stroke-linejoin="round"/>`; }
function _pdfPath() { return `<path d="M15 23h8M15 28h10M15 33h13" stroke="COLOR" stroke-width="1.8" stroke-linecap="square" opacity=".7"/><path d="M30 21v6h5" stroke="COLOR" stroke-width="1.5" stroke-linecap="square" opacity=".5"/>`; }
function _archivePath() { return `<path d="M22 4v40M18 12h8M18 18h8M18 24h8M18 30h8" stroke="COLOR" stroke-width="1.8" stroke-linecap="square" opacity=".7"/>`; }
function _docPath() { return `<path d="M16 23h16M16 28h16M16 33h10" stroke="COLOR" stroke-width="1.8" stroke-linecap="square" opacity=".7"/><path d="M32 21l2 2-2 2" stroke="COLOR" stroke-width="1.5" stroke-linecap="round" opacity=".6"/>`; }
function _slidePath() { return `<rect x="14" y="20" width="20" height="14" rx="1" stroke="COLOR" stroke-width="1.5" opacity=".7"/><path d="M24 27l-4-4v8z" fill="COLOR" opacity=".6"/>`; }

function _bigIconExt(color, extText) {
    const fs = extText.length <= 2 ? 14 : extText.length === 3 ? 12 : 10;
    // HTML-escape the extension before inserting into SVG text content
    const safe = extText.replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
    return `<svg width="48" height="48" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M10 4h18l10 10v30H10z" fill="${color}" opacity=".1" stroke="${color}" stroke-width="1.5" stroke-linejoin="round"/>
    <path d="M28 4v10h10" stroke="${color}" stroke-width="1.5" stroke-linecap="square"/>
    <text x="24" y="35" text-anchor="middle" font-size="${fs}" font-weight="700" font-family="Cascadia Code,Consolas,monospace" fill="${color}" opacity=".9">${safe}</text>
  </svg>`;
}
