'use strict';

/* ============================================================
   SAVE VFS
   ============================================================ */
async function saveVFS() {
    if (!App.key || !App.container) return;
    try {
        const jsonBuf = new TextEncoder().encode(JSON.stringify(VFS.toObj())),
            { iv, blob } = await Crypto.encryptBin(App.key, jsonBuf);
        await DB.saveVFS(App.container.id, iv, blob);
        App.container.totalSize = VFS.totalSize();
        // Strip raw log so only compressed _alogZ gets persisted
        const _tmpLog = App.container.activityLog;
        delete App.container.activityLog;
        await DB.saveContainer(App.container);
        if (_tmpLog) App.container.activityLog = _tmpLog;
        Desktop.updateTaskbar();
    } catch (e) { console.error('saveVFS error', e); }
}

/* ============================================================
   ACTIVITY LOGS
   ============================================================ */
const ALOG_MAX = 2048;
let _alogSaveTimer = null, _alogRafId = null, _alogFilters = null;
let _activityLog = []; // in-memory ring buffer; never stored raw on the container

// ── Compression (deflate, built-in, zero-dependency) ────────
async function _compressLog(arr) {
    const json = JSON.stringify(arr);
    const cs = new Blob([json]).stream().pipeThrough(new CompressionStream('deflate'));
    return new Uint8Array(await new Response(cs).arrayBuffer());
}
async function _decompressLog(bytes) {
    const ds = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
    return JSON.parse(await new Response(ds).text());
}
async function _loadActivityLog() {
    const pending = _activityLog.length ? _activityLog.slice() : [];
    _activityLog = [];
    if (!App.container) return;
    if (App.container._alogZ) {
        try {
            const z = App.container._alogZ;
            // New format: { iv, blob } — AES-256-GCM encrypted, then zlib-compressed
            const raw = (z && z.iv && z.blob)
                ? new Uint8Array(await Crypto.decrypt(App.key, z.iv, z.blob))
                : z; // legacy: plain compressed bytes (migrate on next flush)
            _activityLog = await _decompressLog(raw);
        } catch { }
    }
    // Migrate old uncompressed plaintext format
    if (Array.isArray(App.container.activityLog)) {
        _activityLog = _activityLog.concat(App.container.activityLog);
        delete App.container.activityLog;
    }
    // Merge any entries pushed during async decompress
    if (pending.length) _activityLog = _activityLog.concat(pending);
    if (_activityLog.length > ALOG_MAX) _activityLog.splice(0, _activityLog.length - ALOG_MAX);
}
async function _flushActivityLog() {
    _alogSaveTimer = null;
    if (!App.container || !App.key || !_activityLog.length) return;
    try {
        // Compress then encrypt — attacker must NOT read activity logs
        const compressed = await _compressLog(_activityLog);
        const { iv, blob } = await Crypto.encrypt(App.key, compressed);
        App.container._alogZ = { iv, blob };
        delete App.container.activityLog;
        await DB.saveContainer(App.container);
    } catch (e) { console.error('_flushActivityLog', e); }
}

/* ============================================================
   OPEN-FOLDER GUARD  — shared by drag handlers and file ops
   Returns the id of the first open-folder in ids, or null.
   ============================================================ */
function _getOpenFolderIds() {
    if (typeof WinManager === 'undefined') return new Set();
    const ids = new Set();
    WinManager._wins.forEach(w => {
        let cur = w.folderId;
        while (cur && cur !== 'root') { ids.add(cur); cur = (VFS.node(cur) || {}).parentId; }
    });
    return ids;
}
function _openFolderGuard(ids) {
    const open = _getOpenFolderIds();
    return [...ids].find(id => { const n = VFS.node(id); return n && n.type === 'folder' && open.has(id); }) ?? null;
}

// ── logActivity ─────────────────────────────────────────────
function logActivity(op, detail, count, itemPath) {
    if (!App.container) return;
    if (_getSettings().activityLogs === false) return;
    const entry = { t: Date.now(), o: op, d: detail };
    if (count > 1) entry.n = count;
    let p = itemPath ?? null;
    if (!p && App.folder && App.folder !== 'root') {
        p = VFS.fullPath(App.folder);
    }
    if (p && p !== '/') entry.p = p;
    _activityLog.push(entry);
    if (_activityLog.length > ALOG_MAX) _activityLog.splice(0, _activityLog.length - ALOG_MAX);
    if (_alogSaveTimer) clearTimeout(_alogSaveTimer);
    _alogSaveTimer = setTimeout(_flushActivityLog, 3000);
}

// ── Helpers ─────────────────────────────────────────────────
function _alogRelTime(ts) {
    const d = Date.now() - ts;
    if (d < 60000) return 'Just now';
    if (d < 3600000) return Math.floor(d / 60000) + 'm ago';
    if (d < 86400000) return Math.floor(d / 3600000) + 'h ago';
    if (d < 604800000) return Math.floor(d / 86400000) + 'd ago';
    return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}
// Show path compactly: /~/Container/…/parent/name for deep paths
function _alogPathDisplay(p) {
    if (!p) return '';
    const segs = p.split('/').filter(Boolean); // ['~', 'Container', 'a', 'b', 'file']
    if (p.length <= 58 || segs.length <= 4) return p;
    const prefix = '/~/' + segs[1] + '/\u2026/';
    const tail = segs.slice(-2).join('/') + (p.endsWith('/') ? '/' : '');
    const result = prefix + tail;
    // If still too long, keep only the last segment
    return result.length <= 62 ? result : prefix + segs[segs.length - 1] + (p.endsWith('/') ? '/' : '');
}
function _alogOpLabel(op) {
    const map = {
        upload: 'Uploaded', delete: 'Deleted', rename: 'Renamed', move: 'Moved',
        copy: 'Copied', cut: 'Cut', paste: 'Pasted', 'create-file': 'Created',
        'create-folder': 'New Folder', color: 'Color', edit: 'Saved',
        download: 'Exported', 'export-zip': 'ZIP Export', sort: 'Sorted',
        'export-container': 'Container Export'
    };
    return map[op] || op;
}
const _ALOG_COLORS = {
    upload: '#3a8a4f', delete: '#c44040', rename: '#b07a20', move: '#3a6ea0',
    copy: '#2a8a8a', cut: '#b06020', paste: '#7a309a', 'create-file': '#3a8a4f',
    'create-folder': '#3a8a4f', color: '#a03060', edit: '#8a7020',
    download: '#2a6aaa', 'export-zip': '#3a6ea0', sort: '#6a6a6a',
    'export-container': '#3a6ea0'
};
const _ALOG_ICONS = {
    upload: Icons.upload,
    delete: Icons.trash,
    rename: Icons.rename,
    move: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M3 8h10M9 4l4 4-4 4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    copy: Icons.copy,
    cut: Icons.cut,
    paste: Icons.paste,
    'create-file': Icons.newfile,
    'create-folder': Icons.newfolder,
    color: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="5.5" stroke="currentColor" stroke-width="1.4"/><circle cx="8" cy="8" r="2.5" fill="currentColor"/></svg>`,
    edit: Icons.save,
    download: Icons.download,
    'export-zip': `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M4 2h5l3 3v9H4z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M9 2v3h3" stroke="currentColor" stroke-width="1.3"/><path d="M7 7h2v2H7zM7 10h2v2H7z" fill="currentColor" opacity=".85"/></svg>`,
    sort: Icons.sort,
    'export-container': `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="2" y="2" width="12" height="12" rx="1.5" stroke="currentColor" stroke-width="1.3"/><path d="M8 5v5M5.5 8l2.5 2 2.5-2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>`
};

// ── Render: date-grouped list with badge layout ─────────────
function _renderActivityLogs() {
    const listEl = document.getElementById('alog-list'),
        offEl = document.getElementById('alog-off'),
        emptyEl = document.getElementById('alog-empty'),
        contentEl = document.getElementById('alog-content'),
        filtersEl = document.getElementById('alog-filters'),
        toolbarEl = document.getElementById('alog-toolbar'),
        s = _getSettings(),
        log = _activityLog;

    if (s.activityLogs === false) {
        offEl.style.display = 'flex';
        emptyEl.style.display = 'none';
        listEl.style.display = 'none';
        toolbarEl.style.display = 'none';
        return;
    }
    offEl.style.display = 'none';
    if (!log.length) {
        emptyEl.style.display = 'flex';
        listEl.style.display = 'none';
        toolbarEl.style.display = 'none';
        return;
    }

    toolbarEl.style.display = '';
    emptyEl.style.display = 'none';
    listEl.style.display = '';

    // Count ops for filter chips
    const opCounts = {};
    log.forEach(e => { opCounts[e.o] = (opCounts[e.o] || 0) + 1; });
    const ops = Object.keys(opCounts).sort((a, b) => opCounts[b] - opCounts[a]);
    let filterHtml = '';
    for (const op of ops) {
        const active = !_alogFilters || _alogFilters.has(op);
        filterHtml += `<button class="alog-filter${active ? ' active' : ''}" data-op="${op}">${escHtml(_alogOpLabel(op))}<span class="alog-filter-count">${opCounts[op]}</span></button>`;
    }
    filtersEl.innerHTML = filterHtml;
    filtersEl.querySelectorAll('.alog-filter').forEach(btn => {
        btn.onclick = () => {
            const op = btn.dataset.op;
            if (!_alogFilters) {
                _alogFilters = new Set(ops);
                _alogFilters.delete(op);
            } else if (_alogFilters.has(op)) {
                _alogFilters.delete(op);
                if (!_alogFilters.size) _alogFilters = null;
            } else {
                _alogFilters.add(op);
                if (_alogFilters.size === ops.length) _alogFilters = null;
            }
            _renderActivityLogs();
        };
    });

    // Build filtered list (newest first)
    const items = [];
    for (let i = log.length - 1; i >= 0; i--) {
        if (!_alogFilters || _alogFilters.has(log[i].o)) items.push(log[i]);
    }

    if (!items.length) {
        listEl.style.display = 'none';
        emptyEl.style.display = 'flex';
        return;
    }

    // Group by date
    const now = new Date(),
        todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime(),
        yesterdayStart = todayStart - 86400000,
        weekStart = todayStart - 6 * 86400000;
    let html = '', lastGroup = '';
    for (const it of items) {
        let group;
        if (it.t >= todayStart) group = 'Today';
        else if (it.t >= yesterdayStart) group = 'Yesterday';
        else if (it.t >= weekStart) group = 'This Week';
        else group = 'Earlier';
        if (group !== lastGroup) {
            html += `<div class="alog-group">${escHtml(group)}</div>`;
            lastGroup = group;
        }
        const color = _ALOG_COLORS[it.o] || '#666',
            label = _alogOpLabel(it.o),
            mainText = it.d || '',
            pathFull = it.p ? (it.n > 1 && !it.p.endsWith('/') ? it.p + '/' : it.p) : '',
            pathShort = _alogPathDisplay(pathFull),
            pathHtml = pathShort ? `<code class="alog-path-chip" title="${escHtml(pathFull)}">${escHtml(pathShort)}</code>` : '',
            time = _alogRelTime(it.t);
        html += `<div class="alog-item"><span class="alog-badge" style="--bc:${color}">${escHtml(label)}</span><span class="alog-detail"><span class="alog-detail-main" title="${escHtml(mainText)}">${escHtml(mainText)}</span>${pathHtml}</span><span class="alog-time">${escHtml(time)}</span></div>`;
    }
    contentEl.innerHTML = html;
    listEl.onscroll = null;
}

// ── Clear / export helpers ──────────────────────────────────
async function _clearActivityLog() {
    _activityLog = [];
    if (App.container) {
        delete App.container._alogZ;
        delete App.container.activityLog;
        await DB.saveContainer(App.container);
    }
    _alogFilters = null;
}



/* ============================================================
   CONTEXT MENU
   ============================================================ */
let _activeSubmenu = null;

function showCtxMenu(x, y, items) {
    hideSubmenu();
    const menu = document.getElementById('ctx-menu');
    menu.innerHTML = '';
    items.forEach(item => {
        if (item.sep) {
            const d = document.createElement('div'); d.className = 'ctx-sep'; menu.appendChild(d); return;
        }
        const li = document.createElement('div');
        li.className = 'ctx-item' + (item.danger ? ' danger' : '') + (item.disabled ? ' disabled' : '');
        if (item.submenu) {
            li.innerHTML = `<span class="ctx-item-icon">${item.icon || ''}</span><span>${escHtml(item.label)}</span><span class="ctx-item-arrow">›</span>`;
            li.addEventListener('mouseenter', () => showSubmenu(li, item.submenu));
            li.addEventListener('mouseleave', e => { if (!e.relatedTarget?.closest('#ctx-menu-sub')) hideSubmenu(); });
        } else if (item.disabled && item._tooltip) {
            li.innerHTML = `<span class="ctx-item-icon">${item.icon || ''}</span><span>${escHtml(item.label)}</span>${item._keyHint ? `<span class="ctx-item-key-hint">${item._keyHint}</span>` : ''}`;
            let _tip = null;
            li.addEventListener('mouseenter', () => {
                _tip = document.createElement('div');
                _tip.className = 'ctx-tooltip';
                _tip.textContent = item._tooltip;
                document.body.appendChild(_tip);
                const r = li.getBoundingClientRect();
                _tip.style.left = r.right + 6 + 'px'; _tip.style.top = r.top + 'px';
                const tr = _tip.getBoundingClientRect();
                if (tr.right > window.innerWidth) _tip.style.left = Math.max(0, r.left - tr.width - 6) + 'px';
            });
            li.addEventListener('mouseleave', () => { if (_tip) { _tip.remove(); _tip = null; } });
        } else {
            li.innerHTML = `<span class="ctx-item-icon">${item.icon || ''}</span><span>${escHtml(item.label)}</span>${item._keyHint ? `<span class="ctx-item-key-hint">${item._keyHint}</span>` : ''}`;
            li.addEventListener('click', () => { hideCtxMenu(); item.action?.(); });
            li.addEventListener('mouseenter', hideSubmenu);
        }
        menu.appendChild(li);
    });
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';
    menu.classList.add('show');
    const r = menu.getBoundingClientRect();
    // Account for taskbar at the bottom (36px + 1px border)
    const taskbarH = document.querySelector('.taskbar')?.offsetHeight || 37,
        maxBottom = window.innerHeight - taskbarH;
    if (r.right > window.innerWidth) menu.style.left = Math.max(0, x - r.width) + 'px';
    if (r.bottom > maxBottom) menu.style.top = Math.max(0, y - r.height) + 'px';
}

function showSubmenu(parentEl, items) {
    hideSubmenu();
    let sub = document.getElementById('ctx-menu-sub');
    if (!sub) {
        sub = document.createElement('div');
        sub.className = 'ctx-menu'; sub.id = 'ctx-menu-sub';
        document.body.appendChild(sub);
    }
    sub.innerHTML = '';
    let _activeSub2 = null;

    function hideSub2() {
        if (_activeSub2) { _activeSub2.remove(); _activeSub2 = null; }
    }

    items.forEach(item => {
        if (item.sep) { const d = document.createElement('div'); d.className = 'ctx-sep'; sub.appendChild(d); return; }
        const li = document.createElement('div');
        li.className = 'ctx-item' + (item.danger ? ' danger' : '') + (item.disabled ? ' disabled' : '');
        if (item.submenu) {
            li.innerHTML = `<span class="ctx-item-icon">${item.icon || ''}</span><span>${escHtml(item.label)}</span><span class="ctx-item-arrow">›</span>`;
            li.addEventListener('mouseenter', () => {
                hideSub2();
                const sub2 = document.createElement('div');
                sub2.className = 'ctx-menu show';
                item.submenu.forEach(si => {
                    if (si.sep) { const d = document.createElement('div'); d.className = 'ctx-sep'; sub2.appendChild(d); return; }
                    const li2 = document.createElement('div');
                    li2.className = 'ctx-item' + (si.danger ? ' danger' : '');
                    li2.innerHTML = `<span class="ctx-item-icon">${si.icon || ''}</span><span>${escHtml(si.label)}</span>`;
                    li2.addEventListener('click', () => { hideCtxMenu(); si.action?.(); });
                    sub2.appendChild(li2);
                });
                document.body.appendChild(sub2);
                const pr = li.getBoundingClientRect();
                sub2.style.position = 'fixed';
                sub2.style.left = pr.right + 'px'; sub2.style.top = pr.top + 'px';
                const sr = sub2.getBoundingClientRect();
                const _taskbarH2 = document.querySelector('.taskbar')?.offsetHeight || 37,
                    _maxB2 = window.innerHeight - _taskbarH2;
                if (window.innerWidth <= 640) {
                    sub2.style.left = Math.max(0, Math.min(pr.left, window.innerWidth - sr.width)) + 'px';
                    sub2.style.top = Math.min(pr.bottom, _maxB2 - sr.height) + 'px';
                } else {
                    if (sr.right > window.innerWidth) sub2.style.left = Math.max(0, pr.left - sr.width) + 'px';
                    if (sr.bottom > _maxB2) sub2.style.top = Math.max(0, pr.top - (sr.bottom - _maxB2)) + 'px';
                }
                _activeSub2 = sub2;
                sub2.addEventListener('mouseleave', e => {
                    if (e.relatedTarget && li.contains(e.relatedTarget)) return;
                    hideSub2();
                });
            });
            li.addEventListener('mouseleave', e => {
                if (_activeSub2 && _activeSub2.contains(e.relatedTarget)) return;
                hideSub2();
            });
        } else {
            li.innerHTML = `<span class="ctx-item-icon">${item.icon || ''}</span><span>${escHtml(item.label)}</span>`;
            li.addEventListener('click', () => { hideCtxMenu(); item.action?.(); });
            li.addEventListener('mouseenter', hideSub2);
        }
        sub.appendChild(li);
    });
    sub.classList.add('show');
    const pr = parentEl.getBoundingClientRect();
    sub.style.left = pr.right + 'px'; sub.style.top = pr.top + 'px';
    const sr = sub.getBoundingClientRect();
    const _taskbarH = document.querySelector('.taskbar')?.offsetHeight || 37,
        _maxB = window.innerHeight - _taskbarH;
    if (window.innerWidth <= 640) {
        // Mobile: open below parent item to prevent horizontal overflow
        sub.style.left = Math.max(0, Math.min(pr.left, window.innerWidth - sr.width)) + 'px';
        sub.style.top = Math.min(pr.bottom, _maxB - sr.height) + 'px';
    } else {
        if (sr.right > window.innerWidth) sub.style.left = Math.max(0, pr.left - sr.width) + 'px';
        if (sr.bottom > _maxB) sub.style.top = Math.max(0, pr.top - (sr.bottom - _maxB)) + 'px';
    }
    _activeSubmenu = sub;
}

function hideSubmenu() {
    // Remove any third-level submenus
    document.querySelectorAll('body > .ctx-menu:not(#ctx-menu):not(#ctx-menu-sub)').forEach(el => el.remove());
    if (_activeSubmenu) { _activeSubmenu.classList.remove('show'); _activeSubmenu = null; }
}

function hideCtxMenu() {
    document.getElementById('ctx-menu').classList.remove('show');
    document.querySelectorAll('body > .ctx-menu:not(#ctx-menu):not(#ctx-menu-sub)').forEach(el => el.remove());
    document.querySelectorAll('.ctx-tooltip').forEach(el => el.remove());
    hideSubmenu();
}

/* ============================================================
   HOVER TOOLTIP
   ============================================================ */
let _tooltipTimer = null,
    _tooltipEl = null,
    _isDragging = false,
    _touchDragActive = false, // true while touch-drag is active — suppresses contextmenu event
    _lastTouchTs = 0;     // timestamp of last touchstart — suppresses spurious mouseenter tooltips

function _startHoverTooltip(el, node) {
    if (_isDragging) return;
    if (Date.now() - _lastTouchTs < 1200) return; // suppress tooltip shortly after any touch
    _cancelHoverTooltip();
    _tooltipTimer = setTimeout(() => {
        _tooltipEl = document.createElement('div');
        _tooltipEl.className = 'file-tooltip';
        const mime = node.type === 'folder' ? 'Folder' : (node.mime || getMime(node.name)),
            childCount = node.type === 'folder' ? VFS.children(node.id).length : null,
            folderSize = node.type === 'folder' && typeof _folderSize === 'function' ? _folderSize(node.id) : null;
        _tooltipEl.innerHTML =
            `<div class="ft-name">${escHtml(node.name)}</div>` +
            `<div class="ft-row">Path: ${escHtml(VFS.fullPath(node.id))}</div>` +
            `<div class="ft-row">Type: ${escHtml(node.type === 'folder' ? 'Folder' : mime)}</div>` +
            (node.size != null ? `<div class="ft-row">Size: ${fmtSize(node.size)}</div>` : '') +
            (folderSize !== null ? `<div class="ft-row">Size: ${fmtSize(folderSize)}</div>` : '') +
            (childCount !== null ? `<div class="ft-row">Items: ${childCount}</div>` : '') +
            `<div class="ft-row">Modified: ${fmtDate(node.mtime)}</div>` +
            `<div class="ft-row">Created: ${fmtDate(node.ctime)}</div>`;
        _tooltipEl.style.cssText = 'position:fixed;left:0;top:0;visibility:hidden';
        document.body.appendChild(_tooltipEl);
        const rect = el.getBoundingClientRect();
        // If element was removed from DOM or has zero size, abort
        if (!document.contains(el) || (rect.width === 0 && rect.height === 0)) {
            _tooltipEl.remove(); _tooltipEl = null; return;
        }
        const tw = _tooltipEl.offsetWidth, th = _tooltipEl.offsetHeight;
        let left = rect.right + 10, top = rect.top;
        if (left + tw > window.innerWidth - 8) left = rect.left - tw - 10;
        if (top + th > window.innerHeight - 8) top = window.innerHeight - th - 8;
        left = Math.max(4, left);
        top = Math.max(4, top);
        _tooltipEl.style.cssText = `position:fixed;left:${left}px;top:${top}px`;
    }, 750);
}

function _cancelHoverTooltip() {
    if (_tooltipTimer) { clearTimeout(_tooltipTimer); _tooltipTimer = null; }
    if (_tooltipEl) { _tooltipEl.remove(); _tooltipEl = null; }
}

/* ============================================================
   SETTINGS
   ============================================================ */
const SETTINGS_DEFAULTS = { iconSize: 'normal', gridDots: true, autoLock: '60', disableAnimations: false, requireExportPassword: true, activityLogs: true, exportWithLogs: false, snapHighlight: true };

let _autoLockTimerId = null;

function _resetContainerSettings() {
    // Cancel any pending auto-lock timer
    if (_autoLockTimerId) { clearTimeout(_autoLockTimerId); _autoLockTimerId = null; }
    // Reset body icon-size and animation classes to defaults
    document.body.classList.remove('icons-small', 'icons-normal', 'icons-large', 'no-animations', 'no-snap-highlight');
    document.body.classList.add('icons-normal');
    // Reset grid constants
    GRID_X = 96;
    GRID_Y = 96;
    // Reset desktop grid dots to default (visible)
    const area = document.getElementById('desktop-area');
    if (area) area.classList.remove('no-grid-dots');
}

function _getSettings() {
    const s = App.container?.settings;
    return { ...SETTINGS_DEFAULTS, ...s };
}

function _applySettings(s, skipRemap = false) {
    // Icon Size — apply to body so it covers desktop + all folder windows
    document.body.classList.remove('icons-small', 'icons-normal', 'icons-large');
    document.body.classList.add('icons-' + (s.iconSize || 'normal'));
    // Update internal grid size depending on scale
    const oldGX = GRID_X, oldGY = GRID_Y;
    let scale = 1;
    if (s.iconSize === 'small') scale = 0.75;
    if (s.iconSize === 'large') scale = 1.25;
    GRID_X = Math.round(96 * scale);
    GRID_Y = Math.round(96 * scale);

    // Remap all saved positions to the new grid if grid changed.
    // skipRemap=true is passed on initial container load — positions are already
    // stored in the correct grid space and must NOT be converted again.
    if (!skipRemap && (oldGX !== GRID_X || oldGY !== GRID_Y)) {
        VFS.remapPositions(oldGX, oldGY, GRID_X, GRID_Y);
        saveVFS();
        Desktop._renderIcons();
        if (typeof WinManager !== 'undefined') WinManager.renderAll();
    }

    // Grid Dots
    const area = document.getElementById('desktop-area');
    area.classList.toggle('no-grid-dots', !s.gridDots);
    document.querySelectorAll('.fw-area').forEach(a => a.classList.toggle('no-grid-dots', !s.gridDots));
    // Animations
    document.body.classList.toggle('no-animations', !!s.disableAnimations);
    // Snap preview highlight
    document.body.classList.toggle('no-snap-highlight', s.snapHighlight === false);
}

async function _saveSettings(s) {
    if (!App.container) return;
    App.container.settings = s;
    await DB.saveContainer(App.container);
}

function _resetAutoLockTimer() {
    if (_autoLockTimerId) {
        clearTimeout(_autoLockTimerId);
        _autoLockTimerId = null;
    }
    const s = _getSettings();
    if (s.autoLock && s.autoLock !== '0') {
        const min = parseInt(s.autoLock, 10);
        if (!isNaN(min) && min > 0) {
            _autoLockTimerId = setTimeout(() => {
                App.lockContainer();
            }, min * 60 * 1000);
        }
    }
}

function openSettings() {
    const s = _getSettings();
    // Populate UI
    document.querySelectorAll('#settings-icon-size .settings-toggle-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.value === s.iconSize);
    });
    document.querySelector('#settings-grid-dots input').checked = s.gridDots;
    document.querySelector('#settings-animations input').checked = !!s.disableAnimations;

    // Setup custom dropdown for auto-lock
    const dd = document.getElementById('settings-autolock-dd'),
        currentAl = s.autoLock || '60';

    const updateDdUI = (val) => {
        dd.querySelectorAll('.custom-dd-opt').forEach(opt => {
            const isSel = opt.dataset.value === val;
            opt.classList.toggle('selected', isSel);
            if (isSel) dd.querySelector('.custom-dd-val').textContent = opt.textContent;
        });
    };

    // Remove old listeners to prevent duplicates (clone head and menu)
    const ddHead = dd.querySelector('.custom-dd-head'),
        newDdHead = ddHead.cloneNode(true);
    ddHead.parentNode.replaceChild(newDdHead, ddHead);

    // Set initial value AFTER cloning so we update the live DOM element
    updateDdUI(currentAl);

    newDdHead.onclick = (e) => {
        e.stopPropagation();
        document.querySelectorAll('.custom-dd').forEach(d => { if (d !== dd) d.classList.remove('open'); });
        dd.classList.toggle('open');
    };

    const ddMenu = dd.querySelector('.custom-dd-menu'),
        newDdMenu = ddMenu.cloneNode(true);
    ddMenu.parentNode.replaceChild(newDdMenu, ddMenu);

    newDdMenu.querySelectorAll('.custom-dd-opt').forEach(opt => {
        opt.onclick = async (e) => {
            e.stopPropagation();
            const val = opt.dataset.value;
            updateDdUI(val);
            dd.classList.remove('open');
            const ns = { ..._getSettings(), autoLock: val };
            _applySettings(ns);
            await _saveSettings(ns);
            _resetAutoLockTimer();
        };
    });

    // Close dropdowns on outside click
    document.addEventListener('click', () => {
        document.querySelectorAll('.custom-dd').forEach(d => d.classList.remove('open'));
    }, { once: true }); // This might attach multiple times, let's just make it persistent on body in main if needed, but it's fine here for now since modal blocks. Actually better:

    document.addEventListener('click', (e) => {
        if (!e.target.closest('.custom-dd')) {
            document.querySelectorAll('.custom-dd').forEach(d => d.classList.remove('open'));
        }
    });

    // Tab state
    document.querySelectorAll('.settings-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === 'personalization'));
    document.getElementById('settings-personalization').style.display = '';
    document.getElementById('settings-statistics').style.display = 'none';
    document.getElementById('settings-activity-logs').style.display = 'none';
    // Bind tabs
    document.querySelectorAll('.settings-tab').forEach(t => {
        t.onclick = () => {
            document.querySelectorAll('.settings-tab').forEach(t2 => t2.classList.remove('active'));
            t.classList.add('active');
            document.getElementById('settings-personalization').style.display = t.dataset.tab === 'personalization' ? '' : 'none';
            document.getElementById('settings-statistics').style.display = t.dataset.tab === 'statistics' ? '' : 'none';
            document.getElementById('settings-activity-logs').style.display = t.dataset.tab === 'activity-logs' ? '' : 'none';
            if (t.dataset.tab === 'statistics') _renderStats();
            if (t.dataset.tab === 'activity-logs') _renderActivityLogs();
        };
    });
    // Bind icon size buttons
    document.querySelectorAll('#settings-icon-size .settings-toggle-btn').forEach(btn => {
        btn.onclick = async () => {
            document.querySelectorAll('#settings-icon-size .settings-toggle-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            const ns = { ..._getSettings(), iconSize: btn.dataset.value };
            _applySettings(ns);
            await _saveSettings(ns);
        };
    });
    // Bind grid dots
    document.querySelector('#settings-grid-dots input').onchange = async function () {
        const ns = { ..._getSettings(), gridDots: this.checked };
        _applySettings(ns);
        await _saveSettings(ns);
    };
    // Bind disabled animations
    document.querySelector('#settings-animations input').onchange = async function () {
        const ns = { ..._getSettings(), disableAnimations: this.checked };
        _applySettings(ns);
        await _saveSettings(ns);
    };
    // Bind snap highlight
    document.querySelector('#settings-snap-highlight input').checked = s.snapHighlight !== false;
    document.querySelector('#settings-snap-highlight input').onchange = async function () {
        const ns = { ..._getSettings(), snapHighlight: this.checked };
        _applySettings(ns);
        await _saveSettings(ns);
    };
    // Bind require export password
    document.querySelector('#settings-export-pw input').checked = s.requireExportPassword !== false;
    document.querySelector('#settings-export-pw input').onchange = async function () {
        const ns = { ..._getSettings(), requireExportPassword: this.checked };
        await _saveSettings(ns);
    };
    // Bind activity logs toggle
    const alogToggle = document.querySelector('#settings-activity-logs-toggle input'),
        expLogsToggle = document.querySelector('#settings-export-logs input'),
        expLogsRow = document.getElementById('settings-export-logs-row');
    alogToggle.checked = s.activityLogs !== false;
    expLogsToggle.checked = !!s.exportWithLogs;
    expLogsRow.classList.toggle('disabled', s.activityLogs === false);
    expLogsToggle.disabled = s.activityLogs === false;
    alogToggle.onchange = async function () {
        if (!this.checked) {
            // Show confirmation before disabling
            this.checked = true; // revert, let modal decide
            Overlay.show('modal-alog-disable');
            document.getElementById('alog-disable-ok').onclick = async () => {
                Overlay.hide();
                alogToggle.checked = false;
                const ns = { ..._getSettings(), activityLogs: false };
                await _saveSettings(ns);
                await _clearActivityLog();
                expLogsRow.classList.add('disabled');
                expLogsToggle.disabled = true;
                Overlay.show('modal-settings');
            };
            document.getElementById('alog-disable-cancel').onclick = () => {
                Overlay.hide();
                Overlay.show('modal-settings');
            };
            return;
        }
        const ns = { ..._getSettings(), activityLogs: true };
        await _saveSettings(ns);
        expLogsRow.classList.remove('disabled');
        expLogsToggle.disabled = false;
    };
    expLogsToggle.onchange = async function () {
        const ns = { ..._getSettings(), exportWithLogs: this.checked };
        await _saveSettings(ns);
    };
    document.getElementById('alog-enable-btn').onclick = async () => {
        const ns = { ..._getSettings(), activityLogs: true };
        await _saveSettings(ns);
        alogToggle.checked = true;
        expLogsRow.classList.remove('disabled');
        expLogsToggle.disabled = false;
        _renderActivityLogs();
    };
    // Bind clear logs button (with confirmation)
    document.getElementById('alog-clear-btn').onclick = () => {
        Overlay.show('modal-alog-clear');
        document.getElementById('alog-clear-ok').onclick = async () => {
            Overlay.hide();
            await _clearActivityLog();
            Overlay.show('modal-settings');
            document.querySelectorAll('.settings-tab').forEach(t2 => t2.classList.toggle('active', t2.dataset.tab === 'activity-logs'));
            document.getElementById('settings-personalization').style.display = 'none';
            document.getElementById('settings-statistics').style.display = 'none';
            document.getElementById('settings-activity-logs').style.display = '';
            _renderActivityLogs();
        };
        document.getElementById('alog-clear-cancel').onclick = () => {
            Overlay.hide();
            Overlay.show('modal-settings');
        };
    };
    // ── File System check — opens scanner modal ────────────────
    document.getElementById('fs-check-open').onclick = () => {
        Overlay.hide();
        _openScannerModal();
    };
    Overlay.show('modal-settings');
}

/* ============================================================
   CONTAINER INTEGRITY SCANNER MODAL
   ============================================================ */
const _SCAN_ICONS = {
    pass: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M4 8l3 3 5-6" stroke="currentColor" stroke-width="1.6" stroke-linecap="square" stroke-linejoin="round"/></svg>',
    fail: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="square"/></svg>',
    warn: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M8 3v6M8 11.5v1" stroke="currentColor" stroke-width="1.5" stroke-linecap="square"/></svg>',
    spin: '<div class="spinner"></div>',
};

function _delay(ms) { return new Promise(r => setTimeout(r, ms)); }

function _addScanRow(log, name) {
    const row = document.createElement('div');
    row.className = 'scanner-step';
    row.innerHTML = `<span class="scanner-step-icon">${_SCAN_ICONS.spin}</span><span class="scanner-step-label">${escHtml(name)}</span><span class="scanner-step-result">…</span>`;
    log.appendChild(row);
    log.scrollTop = log.scrollHeight;
    return row;
}

function _resolveScanRow(row, status, detail) {
    row.classList.add(status);
    row.querySelector('.scanner-step-icon').innerHTML = _SCAN_ICONS[status] || _SCAN_ICONS.pass;
    row.querySelector('.scanner-step-result').textContent = detail;
}

/* --- Async DB-level checks (file data, IVs, orphan records, size consistency) --- */
async function _runDbChecks(repair, isAborted) {
    const steps = [];
    function mkStep(name, iss, fxd) {
        const hasCrit = iss.some(i => i.sev === 'critical');
        const status = iss.length === 0 ? 'pass' : hasCrit ? 'fail' : 'warn';
        const detail = iss.length === 0 ? 'OK' : `${iss.length} issue${iss.length !== 1 ? 's' : ''}${repair && fxd.length ? `, ${fxd.length} fixed` : ''}`;
        steps.push({ name, status, detail, issues: iss, fixed: fxd });
    }

    // Build the DB file map once (expensive IndexedDB call)
    const allDbFiles = await DB.getFilesByCid(App.container.id);
    const dbFileMap = new Map(allDbFiles.map(f => [f.id, f]));

    // Snapshot VFS file IDs — refresh after each destructive step
    let vfsFileIds = new Set(VFS.fileIds());
    const _abort = () => isAborted?.();

    // 1. File data existence — VFS file nodes whose encrypted data is missing from IndexedDB
    {
        const issues = [], fixed = [];
        for (const id of vfsFileIds) {
            if (_abort()) break;
            const node = VFS.node(id);
            if (!dbFileMap.has(id)) {
                issues.push({ sev: 'critical', msg: `"${node?.name || id}": encrypted data not found in storage` });
                if (repair) {
                    VFS.remove(id);
                    fixed.push(`Removed broken file node "${node?.name || id}"`);
                }
            }
        }
        mkStep('File data existence', issues, fixed);
        if (repair && fixed.length) vfsFileIds = new Set(VFS.fileIds());
    }

    // 2. Encryption IV integrity
    // Files are stored with iv = Array.from(Uint8Array(12)) — plain Array is the canonical format.
    // Uint8Array / ArrayBuffer / ArrayBufferView are also accepted.
    // Only flag if iv is missing, wrong length, or an unrecognized type.
    {
        if (_abort()) return steps;
        const issues = [], fixed = [];

        function ivValid(iv) {
            if (!iv) return false;
            if (Array.isArray(iv)) return iv.length >= 12;
            if (iv instanceof Uint8Array || ArrayBuffer.isView(iv)) return iv.byteLength >= 12;
            if (iv instanceof ArrayBuffer) return iv.byteLength >= 12;
            return false;
        }

        for (const [id, rec] of dbFileMap) {
            if (_abort()) break;
            if (!vfsFileIds.has(id)) continue;
            const node = VFS.node(id);

            if (!rec.iv) {
                issues.push({ sev: 'critical', msg: `"${node?.name || id}": missing encryption IV` });
                if (repair) {
                    VFS.remove(id);
                    await DB.deleteFile(id);
                    fixed.push(`Purged file missing IV: "${node?.name || id}"`);
                }
                continue;
            }

            let ok = ivValid(rec.iv);

            // Try to salvage IVs stored as unusual types (e.g. base64 string in very old data)
            if (!ok && repair) {
                let coerced = null;
                const origType = typeof rec.iv;
                if (typeof rec.iv === 'string') {
                    try { coerced = new Uint8Array(atob(rec.iv).split('').map(c => c.charCodeAt(0))); } catch { }
                }
                if (coerced && coerced.length >= 12) {
                    rec.iv = Array.from(coerced); // store as canonical Array format
                    await DB.saveFile(rec);
                    fixed.push(`Coerced IV for "${node?.name || id}" (${origType} → array)`);
                    ok = true;
                }
            }

            if (!ok) {
                const ivDesc = Array.isArray(rec.iv) ? `array[${rec.iv.length}]` : typeof rec.iv;
                issues.push({ sev: 'critical', msg: `"${node?.name || id}": invalid IV (${ivDesc})` });
                if (repair) {
                    VFS.remove(id);
                    await DB.deleteFile(id);
                    fixed.push(`Purged file with invalid IV: "${node?.name || id}"`);
                }
            }
        }
        mkStep('Encryption IV integrity', issues, fixed);
        if (repair && fixed.length) vfsFileIds = new Set(VFS.fileIds());
    }

    // 3. File blob integrity — sized files must have non-empty blob
    {
        if (_abort()) return steps;
        const issues = [], fixed = [];
        for (const [id, rec] of dbFileMap) {
            if (!vfsFileIds.has(id)) continue;
            const node = VFS.node(id);
            if (!node) continue;
            const blobLen = rec.blob ? (rec.blob.byteLength ?? rec.blob.length ?? 0) : 0;
            if (node.size > 0 && blobLen === 0) {
                issues.push({ sev: 'warn', msg: `"${node.name || id}": expected ${node.size} bytes but blob is empty` });
                if (repair) {
                    // Zero the declared size instead of deleting the file — preserves metadata
                    node.size = 0;
                    fixed.push(`Reset size to 0 for "${node.name || id}"`);
                }
            }
        }
        mkStep('File blob integrity', issues, fixed);
    }

    // 4. Orphaned DB records — DB files not referenced by any VFS node
    {
        if (_abort()) return steps;
        const issues = [], fixed = [];
        const liveIds = new Set(VFS.fileIds());
        for (const [id] of dbFileMap) {
            if (_abort()) break;
            if (!liveIds.has(id)) {
                issues.push({ sev: 'warn', msg: `Orphaned DB record "${id}"` });
                if (repair) {
                    await DB.deleteFile(id);
                    fixed.push(`Deleted orphaned DB record "${id}"`);
                }
            }
        }
        mkStep('Orphaned storage records', issues, fixed);
    }

    // 5. Record container binding — verify DB records belong to current container
    {
        if (_abort()) return steps;
        const issues = [], fixed = [];
        for (const [id, rec] of dbFileMap) {
            if (rec.cid && rec.cid !== App.container.id) {
                issues.push({ sev: 'warn', msg: `Record "${id}": bound to different container` });
                if (repair) {
                    rec.cid = App.container.id;
                    await DB.saveFile(rec);
                    fixed.push(`Rebound record "${id}" to current container`);
                }
            }
        }
        mkStep('Record container binding', issues, fixed);
    }

    // 6. Container size consistency
    {
        const issues = [], fixed = [];
        const vfsTotal = VFS.totalSize();
        const containerTotal = App.container.totalSize || 0;
        if (Math.abs(vfsTotal - containerTotal) > 1024) {
            issues.push({ sev: 'warn', msg: `Container reports ${containerTotal} bytes but VFS sums to ${vfsTotal} bytes` });
            if (repair) {
                App.container.totalSize = vfsTotal;
                await DB.saveContainer(App.container);
                fixed.push(`Corrected container totalSize to ${vfsTotal}`);
            }
        }
        mkStep('Container size consistency', issues, fixed);
    }

    return steps;
}

function _openScannerModal() {
    const log = document.getElementById('scanner-log'),
        summary = document.getElementById('scanner-summary'),
        repairBtn = document.getElementById('scanner-repair'),
        deepCleanBtn = document.getElementById('scanner-deep-clean'),
        startBtn = document.getElementById('scanner-start'),
        closeBtn = document.getElementById('scanner-close');

    log.innerHTML = '';
    summary.style.display = 'none';
    repairBtn.style.display = 'none';
    deepCleanBtn.style.display = 'none';
    startBtn.style.display = '';
    startBtn.disabled = false;
    startBtn.textContent = 'Start Scan';
    let _hasIssues = false, _aborted = false;

    startBtn.onclick = () => {
        if (_hasIssues || startBtn.textContent === 'Done') {
            Overlay.hide();
            return;
        }
        startBtn.disabled = true;
        startBtn.textContent = 'Scanning…';
        repairBtn.style.display = 'none';
        deepCleanBtn.style.display = 'none';
        _runScanAnimated(false);
    };

    repairBtn.onclick = () => {
        // Show confirmation dialog over scanner
        _showRepairConfirm().then(proceed => {
            if (!proceed) return;
            repairBtn.style.display = 'none';
            deepCleanBtn.style.display = 'none';
            startBtn.style.display = 'none';
            log.innerHTML = '';
            summary.style.display = 'none';
            _runScanAnimated(true);
        });
    };

    deepCleanBtn.onclick = () => {
        _showRepairConfirm().then(proceed => {
            if (!proceed) return;
            repairBtn.style.display = 'none';
            deepCleanBtn.style.display = 'none';
            startBtn.style.display = 'none';
            log.innerHTML = '';
            summary.style.display = 'none';
            _runDeepCleanAnimated();
        });
    };

    closeBtn.onclick = () => { _aborted = true; Overlay.hide(); };

    async function _runDeepCleanAnimated() {
        log.innerHTML = '';
        summary.style.display = 'none';
        _aborted = false;

        // Show 5 progress rows updated via onProgress callback
        const rowStorage = _addScanRow(log, 'Scanning storage records…');
        const rowPurge = _addScanRow(log, 'Purging dead nodes…');
        const rowFlatten = _addScanRow(log, 'Flattening deep folder chains…');
        const rowMeta = _addScanRow(log, 'Repairing metadata…');
        const rowClean = _addScanRow(log, 'Cleaning storage records…');
        log.scrollTop = log.scrollHeight;
        await _delay(20);

        let phase = 0;
        const result = await _runDeepClean(() => _aborted, (msg) => {
            if (phase === 0) { _resolveScanRow(rowStorage, 'pass', 'OK'); phase = 1; }
            else if (phase === 1) { _resolveScanRow(rowPurge, 'pass', 'OK'); phase = 2; }
            else if (phase === 2) { _resolveScanRow(rowFlatten, 'pass', 'OK'); phase = 3; }
            else if (phase === 3) { _resolveScanRow(rowMeta, 'pass', 'OK'); phase = 4; }
        });
        if (_aborted) return;

        // Resolve any rows not yet resolved
        if (phase === 0) _resolveScanRow(rowStorage, 'pass', 'OK');
        if (phase <= 1) _resolveScanRow(rowPurge, 'pass', 'Clean');
        _resolveScanRow(rowFlatten, 'pass',
            result.flattened > 0 ? `${result.flattened} folder${result.flattened !== 1 ? 's' : ''} collapsed` : 'Clean');
        _resolveScanRow(rowMeta, 'pass',
            result.metadataFixed > 0 ? `${result.metadataFixed} node${result.metadataFixed !== 1 ? 's' : ''} patched` : 'Clean');
        _resolveScanRow(rowClean, 'pass', 'OK');
        log.scrollTop = log.scrollHeight;

        const totalRemoved = (result.removed || 0) + (result.flattened || 0) + (result.metadataFixed || 0);
        if (totalRemoved > 0) {
            await saveVFS();
            Desktop.render();
            await _delay(600);
            if (!_aborted) await _runScanAnimated(false);
        } else {
            summary.style.display = '';
            summary.className = 'scanner-summary critical';
            summary.innerHTML = `<svg width="20" height="20" viewBox="0 0 20 20" fill="none"><circle cx="10" cy="10" r="8.5" stroke="currentColor" stroke-width="1.4"/><path d="M10 5.5v5.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><circle cx="10" cy="14" r="0.9" fill="currentColor"/></svg>
                <span class="scanner-summary-text"><strong>Deep Clean found nothing to remove.</strong> All nodes are structurally valid. The remaining warnings are informational and require no action.</span>`;
            startBtn.style.display = '';
            startBtn.disabled = false;
            startBtn.textContent = 'Done';
        }
    }

    async function _runScanAnimated(repair) {
        log.innerHTML = '';
        summary.style.display = 'none';
        _hasIssues = false;
        _aborted = false;

        // Phase 1: VFS structural checks — run synchronously, display per step
        const vfsSteps = VFS.check(repair);
        for (const s of vfsSteps) {
            if (_aborted) return;
            const row = _addScanRow(log, s.name);
            await _delay(15);
            _resolveScanRow(row, s.status, s.detail);
            log.scrollTop = log.scrollHeight;
        }

        // Phase 2: DB async checks
        const dbCheckNames = [
            'File data existence',
            'Encryption IV integrity',
            'File blob integrity',
            'Orphaned storage records',
            'Record container binding',
            'Container size consistency',
        ];
        const dbRows = dbCheckNames.map(name => _addScanRow(log, name));
        log.scrollTop = log.scrollHeight;

        if (_aborted) return;
        const dbSteps = await _runDbChecks(repair, () => _aborted);
        if (_aborted) return;
        for (let i = 0; i < dbSteps.length; i++) {
            if (_aborted) return;
            await _delay(30);
            _resolveScanRow(dbRows[i], dbSteps[i].status, dbSteps[i].detail);
            log.scrollTop = log.scrollHeight;
        }

        // Combine all steps for summary
        const allSteps = [...vfsSteps, ...dbSteps];
        const actionableIssues = allSteps.filter(s => !s.informational).reduce((s, st) => s + st.issues.length, 0),
            infoIssues = allSteps.filter(s => s.informational).reduce((s, st) => s + st.issues.length, 0),
            totalIssues = actionableIssues + infoIssues,
            totalFixed = allSteps.reduce((s, st) => s + st.fixed.length, 0),
            allPass = allSteps.every(s => s.status === 'pass');

        summary.style.display = '';
        if (repair && totalFixed > 0) {
            await saveVFS();
            Desktop.render();
            // Auto-re-scan to verify the repair result
            summary.className = 'scanner-summary repaired';
            summary.innerHTML = `<svg width="20" height="20" viewBox="0 0 16 16" fill="none"><path d="M4 8l3 3 5-6" stroke="currentColor" stroke-width="1.6" stroke-linecap="square" stroke-linejoin="round"/></svg>
                <span class="scanner-summary-text"><strong>${totalFixed} issue${totalFixed !== 1 ? 's' : ''} repaired.</strong> Running verification scan…</span>`;
            summary.style.display = '';
            await _delay(900);
            if (!_aborted) { await _runScanAnimated(false); }
            return;
        } else if (repair && totalFixed === 0 && actionableIssues > 0) {
            // Repair ran but couldn't fix actionable issues — offer Deep Clean
            summary.className = 'scanner-summary critical';
            summary.innerHTML = `<svg width="20" height="20" viewBox="0 0 20 20" fill="none"><circle cx="10" cy="10" r="8.5" stroke="currentColor" stroke-width="1.4"/><path d="M10 5.5v5.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><circle cx="10" cy="14" r="0.9" fill="currentColor"/></svg>
                <span class="scanner-summary-text"><strong>${actionableIssues} issue${actionableIssues !== 1 ? 's' : ''} could not be auto-repaired.</strong> Click <em>Deep Clean</em> for aggressive recovery (flattens deep trees, repairs all metadata). A backup will be offered first — no need to exit.</span>`;
            deepCleanBtn.style.display = '';
        } else if (repair && totalFixed === 0 && actionableIssues === 0 && infoIssues > 0) {
            // All remaining issues are informational warnings only — no action needed
            summary.className = 'scanner-summary healthy';
            summary.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 26" fill="none"><path d="M12 3L3.5 7.5v4.5c0 5.2 3.6 10 8.5 11.5 4.9-1.5 8.5-6.3 8.5-11.5V7.5L12 3z" stroke="currentColor" stroke-width="1.5" fill="none"/><path d="M9 13l2.5 2.5 4-4.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="square" stroke-linejoin="round"/></svg>
                <span class="scanner-summary-text"><strong>All structural issues are resolved.</strong> ${infoIssues} informational warning${infoIssues !== 1 ? 's' : ''} (e.g., folder depth) are noted but require no action.</span>`;
        } else if (allPass) {
            summary.className = 'scanner-summary healthy';
            summary.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 26" fill="none"><path d="M12 3L3.5 7.5v4.5c0 5.2 3.6 10 8.5 11.5 4.9-1.5 8.5-6.3 8.5-11.5V7.5L12 3z" stroke="currentColor" stroke-width="1.5" fill="none"/><path d="M9 13l2.5 2.5 4-4.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="square" stroke-linejoin="round"/></svg>
                <span class="scanner-summary-text"><strong>All checks passed.</strong> Your container's virtual disk image and workspace environment are in perfect condition.</span>`;
        } else if (actionableIssues === 0 && infoIssues > 0) {
            // Only informational warnings on first scan — no repair needed
            summary.className = 'scanner-summary warnings';
            summary.innerHTML = `<svg width="20" height="20" viewBox="0 0 20 20" fill="none"><circle cx="10" cy="10" r="8.5" stroke="currentColor" stroke-width="1.4"/><path d="M10 5.5v5.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><circle cx="10" cy="14" r="0.9" fill="currentColor"/></svg>
                <span class="scanner-summary-text"><strong>${infoIssues} informational warning${infoIssues !== 1 ? 's' : ''} noted.</strong> Advisory only (e.g., folder nesting depth) — no data loss, no action required.</span>`;
        } else {
            summary.className = 'scanner-summary issues';
            summary.innerHTML = `<svg width="20" height="20" viewBox="0 0 20 20" fill="none"><circle cx="10" cy="10" r="8.5" stroke="currentColor" stroke-width="1.4"/><path d="M10 5.5v5.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><circle cx="10" cy="14" r="0.9" fill="currentColor"/></svg>
                <span class="scanner-summary-text"><strong>${actionableIssues} issue${actionableIssues !== 1 ? 's' : ''} detected.</strong> Click <em>Auto-Repair</em> — you'll be offered a backup option first, no need to exit the scanner.</span>`;
            _hasIssues = true;
            repairBtn.style.display = '';
        }

        startBtn.style.display = '';
        startBtn.disabled = false;
        startBtn.textContent = 'Done';
    }

    Overlay.show('modal-scanner');
}

/* ── Deep Clean — purge all phantom/empty nodes that normal repair can't fix ── */
// O(n) rebuild: marks ancestors of real files as "keep", deletes everything else.
async function _runDeepClean(isAborted, onProgress) {
    const _abort = () => isAborted?.();

    // 1. Load DB records (real data)
    onProgress?.('Scanning storage records…');
    const allDbFiles = await DB.getFilesByCid(App.container.id);
    if (_abort()) return { removed: 0 };
    const dbIds = new Set(allDbFiles.map(f => f.id));

    // 2. Determine truly live file IDs: exist in VFS AND have a DB record
    const allVfsFileIds = VFS.fileIds();
    const liveFileIds = allVfsFileIds.filter(id => dbIds.has(id));
    if (_abort()) return { removed: 0 };

    // 3. Single-pass bulk purge via VFS.purgeDeadBranches (O(n))
    onProgress?.(`Purging dead nodes…`);
    const removed = VFS.purgeDeadBranches(liveFileIds);
    if (_abort()) return { removed: 0, flattened: 0 };

    // 4. Flatten folders nested deeper than 50 levels — reparents all files to
    //    their closest depth-≤50 ancestor, then deletes the now-empty deep folders.
    //    All file data is preserved; only folder hierarchy is truncated.
    onProgress?.('Flattening deep folder chains…');
    const flattened = VFS.flattenDeepContent(50);
    if (_abort()) return { removed, flattened: 0 };

    // 5. Repair all corrupted/missing metadata (timestamps → today's date)
    onProgress?.('Repairing metadata…');
    const metadataFixed = VFS.repairMetadata();
    if (_abort()) return { removed, flattened, metadataFixed: 0 };

    // 6. Remove orphaned DB records in a single IndexedDB transaction
    onProgress?.('Cleaning storage records…');
    const liveNow = new Set(VFS.fileIds());
    const orphanIds = allDbFiles.filter(f => !liveNow.has(f.id)).map(f => f.id);
    if (orphanIds.length) await DB.deleteFiles(orphanIds);

    return { removed, flattened, metadataFixed };
}

/* ── Repair confirmation dialog (shown above scanner overlay) ─────── */
function _showRepairConfirm() {
    return new Promise(resolve => {
        const ov = document.getElementById('repair-confirm-overlay'),
            exportBtn = document.getElementById('repair-confirm-export'),
            proceedBtn = document.getElementById('repair-confirm-proceed'),
            cancelBtn = document.getElementById('repair-confirm-cancel');

        function close(val) {
            ov.classList.remove('show');
            exportBtn.onclick = proceedBtn.onclick = cancelBtn.onclick = null;
            resolve(val);
        }

        cancelBtn.onclick = () => close(false);
        proceedBtn.onclick = () => close(true);
        exportBtn.onclick = async () => {
            // Export container via existing exportContainerFile
            if (typeof exportContainerFile === 'function') {
                await exportContainerFile(App.container, false);
            }
        };

        ov.classList.add('show');
    });
}


const STATS_COLORS = ['#0078d4', '#e74856', '#16c60c', '#f9f1a5', '#b4009e', '#00b7c3', '#ff8c00', '#e3008c'];

function _renderStats() {
    const deskFid = Desktop._desktopFolder;
    // Gather all nodes recursively
    let totalFiles = 0, totalFolders = 0, totalSize = 0;
    const typeCounts = {};
    function walk(pid) {
        VFS.children(pid).forEach(n => {
            if (n.type === 'folder') {
                totalFolders++;
                walk(n.id);
            } else {
                totalFiles++;
                totalSize += n.size || 0;
                const ext = n.name.includes('.') ? n.name.split('.').pop().toLowerCase() : 'other';
                typeCounts[ext] = (typeCounts[ext] || 0) + 1;
            }
        });
    }
    walk('root');
    // Stats cards
    const grid = document.getElementById('stats-grid');
    grid.innerHTML = '';
    const cards = [
        { value: totalFiles, label: 'Files' },
        { value: totalFolders, label: 'Folders' },
        { value: fmtSize(totalSize), label: 'Total Size' },
        { value: fmtDate(App.container?.createdAt), label: 'Created' },
    ];
    cards.forEach(c => {
        const card = document.createElement('div'); card.className = 'stats-card';
        card.innerHTML = `<span class="stats-card-value">${escHtml(String(c.value))}</span><span class="stats-card-label">${escHtml(c.label)}</span>`;
        grid.appendChild(card);
    });
    // File type bar chart (top 6)
    const chart = document.getElementById('stats-bar-chart');
    chart.innerHTML = '';
    const sorted = Object.entries(typeCounts).sort((a, b) => b[1] - a[1]).slice(0, 6),
        maxCount = sorted.length ? sorted[0][1] : 1;
    sorted.forEach(([ext, count], i) => {
        const pct = Math.round(count / totalFiles * 100);
        const row = document.createElement('div'); row.className = 'stats-bar-row';
        row.innerHTML =
            `<span class="stats-bar-row-label">.${escHtml(ext)}</span>` +
            `<div class="stats-bar-row-track"><div class="stats-bar-row-fill" style="width:${Math.round(count / maxCount * 100)}%;background:${STATS_COLORS[i % STATS_COLORS.length]}"></div></div>` +
            `<span class="stats-bar-row-pct">${pct}%</span>`;
        chart.appendChild(row);
    });
    if (!sorted.length) chart.innerHTML = '<span style="font-size:12px;color:var(--text-dim)">No files yet</span>';
    // Storage bar
    const storBar = document.getElementById('stats-storage-bar'),
        used = App.container?.totalSize || 0,
        limit = 500 * 1024 * 1024, // 500MB display cap
        pctUsed = Math.min(100, Math.round(used / limit * 100));
    storBar.innerHTML =
        `<div class="stats-storage-fill" style="width:${pctUsed}%"></div>` +
        `<span class="stats-storage-text">${fmtSize(used)} used</span>`;
}

/* ============================================================
   SNAP TO FREE GRID CELL
   occupied = Map<"cx_cy", id>  (cells already taken)
   ============================================================ */
function _snapFreeCell(rawX, rawY, occupied) {
    const cx0 = Math.max(0, Math.round((rawX - 8) / GRID_X)),
        cy0 = Math.max(0, Math.round((rawY - 8) / GRID_Y));
    for (let r = 0; r <= 80; r++) {
        for (let dy = -r; dy <= r; dy++) {
            for (let dx = -r; dx <= r; dx++) {
                if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
                const cx = cx0 + dx, cy = cy0 + dy;
                if (cx < 0 || cy < 0) continue;
                if (!occupied.has(`${cx}_${cy}`)) return { x: 8 + cx * GRID_X, y: 8 + cy * GRID_Y };
            }
        }
    }
    return { x: 8 + cx0 * GRID_X, y: 8 + cy0 * GRID_Y };
}

/* ============================================================
   THUMBNAIL QUEUE  —  limits concurrent generateThumb calls to avoid memory spikes
   ============================================================ */
const _thumbQueue = [];
let _thumbActive = 0;
const THUMB_MAX_CONCURRENT = 8;

function _enqueueThumb(node) {
    _thumbQueue.push(node);
    _drainThumbQueue();
}
function _drainThumbQueue() {
    while (_thumbActive < THUMB_MAX_CONCURRENT && _thumbQueue.length > 0) {
        const n = _thumbQueue.shift();
        _thumbActive++;
        generateThumb(n).then(url => {
            _thumbActive--;
            _drainThumbQueue();
            if (!url) return;
            App.thumbCache[n.id] = url;
            const el = document.querySelector(`.file-item[data-id="${n.id}"] .file-thumb`);
            if (el) { const i = document.createElement('img'); i.src = url; i.draggable = false; el.innerHTML = ''; el.appendChild(i); }
        });
    }
}

/* ============================================================
   SHARED ICON ELEMENT BUILDER
   ============================================================ */
function _buildIconEl(node, pos) {
    const div = document.createElement('div');
    div.className = 'file-item';
    div.dataset.id = node.id;
    div.style.left = pos.x + 'px';
    div.style.top = pos.y + 'px';

    const thumb = document.createElement('div');
    if (node.type === 'folder') {
        thumb.className = 'file-thumb folder-icon';
        thumb.innerHTML = getFolderSVG(node.color);
    } else {
        thumb.className = 'file-thumb';
        const mime = node.mime || getMime(node.name);
        if (App.thumbCache[node.id]) {
            const img = document.createElement('img');
            img.src = App.thumbCache[node.id];
            img.draggable = false;
            thumb.appendChild(img);
        } else {
            thumb.innerHTML = getFileIconSVG(mime, node.name);
            if (isImage(mime)) _enqueueThumb(node);
        }
    }

    const name = document.createElement('div');
    name.className = 'file-name';
    name.textContent = node.name;
    div.appendChild(thumb);
    div.appendChild(name);
    return div;
}

/* ============================================================
   AREA-LEVEL EVENT DELEGATION FOR ICONS
   Replaces per-element listeners — one set of listeners per container,
   covering all .file-item[data-id] children regardless of count.
   owner must implement: _onIconMousedown(e,el,node), _openNode(node), _contextIcon(e,node)
   ============================================================ */
function _setupAreaDelegation(area, owner) {
    // Prevent native drag ghost on icons
    area.addEventListener('dragstart', e => {
        if (e.target.closest('.file-item[data-id]')) e.preventDefault();
    });
    // Hover tooltips via mouseover/mouseout (simulate mouseenter/mouseleave per icon)
    area.addEventListener('mouseover', e => {
        const el = e.target.closest('.file-item[data-id]');
        if (!el) return;
        if (e.relatedTarget?.closest('.file-item[data-id]') !== el) {
            const node = VFS.node(el.dataset.id);
            if (node) _startHoverTooltip(el, node);
        }
    });
    area.addEventListener('mouseout', e => {
        const el = e.target.closest('.file-item[data-id]');
        if (!el) return;
        if (e.relatedTarget?.closest('.file-item[data-id]') !== el) _cancelHoverTooltip();
    });
    // Mousedown on icons
    area.addEventListener('mousedown', e => {
        const el = e.target.closest('.file-item[data-id]');
        if (!el) return;
        const node = VFS.node(el.dataset.id);
        if (node) owner._onIconMousedown(e, el, node);
    });
    // Double-click → open
    area.addEventListener('dblclick', e => {
        const el = e.target.closest('.file-item[data-id]');
        if (!el) return;
        e.stopPropagation();
        const node = VFS.node(el.dataset.id);
        if (node) owner._openNode(node);
    });
    // Context menu on icons
    area.addEventListener('contextmenu', e => {
        const el = e.target.closest('.file-item[data-id]');
        if (!el) return;
        e.preventDefault();
        if (_touchDragActive || el._tsIsTouch) return;
        e.stopPropagation();
        const node = VFS.node(el.dataset.id);
        if (node) owner._contextIcon(e, node);
    });
    // Touch: state stored on element to avoid per-icon closure overhead
    area.addEventListener('touchstart', e => {
        const el = e.target.closest('.file-item[data-id]');
        if (!el) return;
        e.stopPropagation(); // prevent FW icon touch bubbling to parent Desktop handlers
        el._tsTime = Date.now(); el._tsMoved = false; el._tsIsTouch = true;
        _cancelHoverTooltip();
    }, { passive: true });
    area.addEventListener('touchmove', e => {
        const el = e.target.closest('.file-item[data-id]');
        if (!el) return;
        el._tsMoved = true;
        e.stopPropagation();
    }, { passive: true });
    area.addEventListener('touchend', e => {
        const el = e.target.closest('.file-item[data-id]');
        if (!el) return;
        e.stopPropagation(); // prevent FW icon touch bubbling to parent Desktop handlers
        setTimeout(() => { el._tsIsTouch = false; }, 500);
        if (el._tsMoved || Date.now() - (el._tsTime || 0) > 350) return;
        e.preventDefault();
        const now = Date.now(), t = e.changedTouches[0],
            node = VFS.node(el.dataset.id);
        if (!node) return;
        if (now - (el._tsLastTap || 0) < 300) {
            el._tsLastTap = 0;
            owner._openNode(node);
        } else {
            el._tsLastTap = now;
            owner._contextIcon({ clientX: t.clientX, clientY: t.clientY, ctrlKey: false, metaKey: false, preventDefault() { }, stopPropagation() { } }, node);
        }
    });
    area.addEventListener('touchcancel', e => {
        const el = e.target.closest('.file-item[data-id]');
        if (el) el._tsIsTouch = false;
    }, { passive: true });
}

/* ---- Shared touch rubber-band selection on empty area + long-press context menu ----
   owner implements: selection (Set), _updateStatus(), _contextDesktop(e) */
function _initAreaTouchRubberBand(area, owner) {
    let _lpTimer = null,
        _rbBand = null, _rbSX = 0, _rbSY = 0, _rbActive = false, _rbMoved = false, _rbOnEmpty = false;

    area.addEventListener('touchstart', e => {
        if (e.touches.length !== 1) return;
        const t = e.touches[0];
        // BUGFIX: when this handler is on #desktop-area, a touch inside a FolderWindow bubbles up
        // here too — ignore it so we don't open the Desktop context menu over the FW's own menu.
        if (!area.closest('.folder-window') && t.target?.closest('.folder-window')) return;
        if (_lpTimer) { clearTimeout(_lpTimer); _lpTimer = null; }
        if (_rbBand) { _rbBand.remove(); _rbBand = null; }
        _rbActive = false; _rbMoved = false;
        _rbSX = t.clientX; _rbSY = t.clientY;
        const iconEl = t.target?.closest('.file-item[data-id]');
        _rbOnEmpty = !iconEl || !area.contains(iconEl);
        if (_rbOnEmpty) {
            _lpTimer = setTimeout(() => {
                if (_rbMoved) return;
                owner._contextDesktop({ clientX: t.clientX, clientY: t.clientY, preventDefault() { }, stopPropagation() { } });
            }, 600);
        }
    }, { passive: true });

    area.addEventListener('touchmove', e => {
        if (e.touches.length !== 1) return;
        const t = e.touches[0],
            dx = t.clientX - _rbSX, dy = t.clientY - _rbSY;
        if (!_rbMoved && (Math.abs(dx) > 8 || Math.abs(dy) > 8)) {
            _rbMoved = true;
            if (_lpTimer) { clearTimeout(_lpTimer); _lpTimer = null; }
        }
        if (!_rbOnEmpty) return;
        if (!_rbActive && _rbMoved) {
            _rbActive = true;
            owner.selection.clear();
            area.querySelectorAll(':scope > .file-item.selected').forEach(i => i.classList.remove('selected'));
            owner._updateStatus();
            const aR = area.getBoundingClientRect();
            _rbBand = document.createElement('div');
            _rbBand.className = 'rubberband';
            _rbBand.style.cssText = `left:${_rbSX - aR.left + area.scrollLeft}px;top:${_rbSY - aR.top + area.scrollTop}px;width:0;height:0`;
            area.appendChild(_rbBand);
        }
        if (_rbActive && _rbBand) {
            if (e.cancelable) e.preventDefault();
            const aR = area.getBoundingClientRect(),
                sx = _rbSX - aR.left + area.scrollLeft, sy = _rbSY - aR.top + area.scrollTop,
                cx = t.clientX - aR.left + area.scrollLeft, cy = t.clientY - aR.top + area.scrollTop,
                x = Math.min(sx, cx), y = Math.min(sy, cy),
                w = Math.abs(cx - sx), h = Math.abs(cy - sy);
            _rbBand.style.cssText = `left:${x}px;top:${y}px;width:${w}px;height:${h}px`;
            const bx2 = x + w, by2 = y + h;
            for (const item of (area._iconMap?.values() ?? area.querySelectorAll(':scope > .file-item'))) {
                const ix = parseInt(item.style.left), iy = parseInt(item.style.top),
                    hit = ix < bx2 && (ix + ICON_W) > x && iy < by2 && (iy + ICON_H) > y;
                if (hit) { owner.selection.add(item.dataset.id); item.classList.add('selected'); }
                else { owner.selection.delete(item.dataset.id); item.classList.remove('selected'); }
            }
            owner._updateStatus();
        }
    }, { passive: false });

    area.addEventListener('touchend', () => {
        if (_lpTimer) { clearTimeout(_lpTimer); _lpTimer = null; }
        if (_rbBand) { _rbBand.remove(); _rbBand = null; }
        _rbActive = false; _rbMoved = false; _rbOnEmpty = false;
    }, { passive: true });
}

/* ---- Compute max icon extent and set canvas size for both scrollbars ---- */
function _syncAreaWidth(area) {
    const canvas = area._canvas ?? (area._canvas = area.querySelector(':scope > .fw-canvas'));
    if (!canvas) return; // Desktop has no fw-canvas — skip
    let maxRight = 0, maxBottom = 0;
    for (const el of (area._iconMap?.values() ?? area.querySelectorAll(':scope > .file-item'))) {
        const r = parseInt(el.style.left) + (el.offsetWidth || 96);
        const b = parseInt(el.style.top) + (el.offsetHeight || 96);
        if (r > maxRight) maxRight = r;
        if (b > maxBottom) maxBottom = b;
    }
    canvas.style.width  = maxRight  > 0 ? (maxRight  + 24) + 'px' : '';
    canvas.style.height = maxBottom > 0 ? (maxBottom + 24) + 'px' : '';
}

/* ---- Shared touch-drag for icons (Desktop + FolderWindow) ----
   owner implements: selection (Set-like), folderId, _updateStatus().
   opts.showSnap: boolean — true for Desktop (show snap preview dot)
   opts.afterDrop: () => void — extra callback after drop (e.g. updateTaskbar) */
function _initTouchDragCommon(area, owner, opts = {}) {
    if (typeof window.ontouchstart === 'undefined' && !navigator.maxTouchPoints) return;

    let _tdNode = null, _tdEl = null,
        _tdSX = 0, _tdSY = 0, _tdOffX = 0, _tdOffY = 0,
        _tdMoved = false, _tdTimer = null, _tdActive = false,
        _tdStartPos = {}, _tdHover = null, _tdSnapPrev = null;

    area.addEventListener('touchstart', e => {
        if (e.touches.length !== 1) return;
        const t = e.touches[0],
            iconEl = t.target?.closest('.file-item[data-id]');
        if (!iconEl || !area.contains(iconEl)) return;

        const nodeId = iconEl.dataset.id,
            node = VFS.node(nodeId);
        if (!node) return;

        _tdMoved = false; _tdActive = false;
        _tdSX = t.clientX; _tdSY = t.clientY;
        const r = iconEl.getBoundingClientRect();
        _tdOffX = t.clientX - r.left;
        _tdOffY = t.clientY - r.top;

        _tdTimer = setTimeout(() => {
            if (_tdMoved) return;
            _tdActive = true;
            _touchDragActive = true;
            _tdNode = node;
            _tdEl = iconEl;

            if (!owner.selection.has(nodeId)) {
                owner.selection.clear();
                area.querySelectorAll('.file-item.selected').forEach(i => i.classList.remove('selected'));
                owner.selection.add(nodeId);
                iconEl.classList.add('selected');
                owner._updateStatus();
            }
            _tdStartPos = {};
            owner.selection.forEach(id => {
                const el = area.querySelector(`.file-item[data-id="${id}"]`);
                if (el) _tdStartPos[id] = { x: parseInt(el.style.left), y: parseInt(el.style.top) };
            });
            iconEl.classList.add('dragging');
            _cancelHoverTooltip();
        }, 400);
    }, { passive: true });

    area.addEventListener('touchmove', e => {
        if (e.touches.length !== 1) return;
        const t = e.touches[0];
        if (Math.abs(t.clientX - _tdSX) + Math.abs(t.clientY - _tdSY) > 5) _tdMoved = true;
        if ((_tdTimer && !_tdMoved) || _tdActive) { if (e.cancelable) e.preventDefault(); }
        if (!_tdActive || !_tdNode) return;

        const aR = area.getBoundingClientRect(),
            mainSp = _tdStartPos[_tdNode.id],
            rawX = t.clientX - aR.left + area.scrollLeft - _tdOffX,
            rawY = t.clientY - aR.top + area.scrollTop - _tdOffY,
            ddx = rawX - mainSp.x, ddy = rawY - mainSp.y;

        owner.selection.forEach(id => {
            const el = area.querySelector(`.file-item[data-id="${id}"]`),
                sp = _tdStartPos[id];
            if (el && sp) { el.style.left = (sp.x + ddx) + 'px'; el.style.top = (sp.y + ddy) + 'px'; }
        });

        // Highlight folder under finger
        owner.selection.forEach(id => {
            const el = area.querySelector(`.file-item[data-id="${id}"]`);
            if (el) el.style.pointerEvents = 'none';
        });
        const hit = document.elementFromPoint(t.clientX, t.clientY);
        owner.selection.forEach(id => {
            const el = area.querySelector(`.file-item[data-id="${id}"]`);
            if (el) el.style.pointerEvents = '';
        });
        const folderEl = hit?.closest('.file-item[data-id]');
        const newHover = folderEl && area.contains(folderEl) &&
            !owner.selection.has(folderEl.dataset.id) &&
            VFS.node(folderEl.dataset.id)?.type === 'folder' ? folderEl.dataset.id : null;
        if (newHover !== _tdHover) {
            if (_tdHover) area.querySelector(`.file-item[data-id="${_tdHover}"]`)?.classList.remove('drag-target');
            _tdHover = newHover;
            if (_tdHover && folderEl) folderEl.classList.add('drag-target');
        }

        // Snap preview (optional — Desktop only by default)
        if (opts.showSnap) {
            if (_tdHover || document.body.classList.contains('no-snap-highlight')) {
                if (_tdSnapPrev) _tdSnapPrev.style.display = 'none';
            } else {
                const occ = new Map();
                VFS.children(owner.folderId).forEach(n => {
                    if (owner.selection.has(n.id)) return;
                    const p = VFS.getPos(owner.folderId, n.id);
                    if (p) occ.set(`${Math.round((p.x - 8) / GRID_X)}_${Math.round((p.y - 8) / GRID_Y)}`, n.id);
                });
                const sn = _snapFreeCell(rawX, rawY, occ);
                if (!_tdSnapPrev) {
                    _tdSnapPrev = document.createElement('div');
                    _tdSnapPrev.className = 'snap-preview';
                    area.appendChild(_tdSnapPrev);
                }
                _tdSnapPrev.style.left = sn.x + 'px';
                _tdSnapPrev.style.top = sn.y + 'px';
                _tdSnapPrev.style.display = '';
            }
        }
    }, { passive: false });

    area.addEventListener('touchend', async () => {
        if (_tdTimer) { clearTimeout(_tdTimer); _tdTimer = null; }
        if (!_tdActive || !_tdNode) { _tdActive = false; _touchDragActive = false; _tdNode = null; return; }
        _tdActive = false; _touchDragActive = false;

        const node = _tdNode; _tdNode = null;
        _tdEl?.classList.remove('dragging');
        if (_tdHover) area.querySelector(`.file-item[data-id="${_tdHover}"]`)?.classList.remove('drag-target');
        if (_tdSnapPrev) { _tdSnapPrev.remove(); _tdSnapPrev = null; }

        if (_tdHover) {
            // open-folder guard
            const blocked = _openFolderGuard(owner.selection);
            if (blocked) {
                _snapBack(_tdStartPos);
                toast(`\u201C${VFS.node(blocked)?.name}\u201D is open in Explorer \u2014 close the window first`, 'error');
                _tdHover = null;
                return;
            }
            const cycled = [...owner.selection].filter(id => VFS.wouldCycle(id, _tdHover));
            if (cycled.length) {
                _snapBack(_tdStartPos);
                toast(`Cannot move "${VFS.node(cycled[0])?.name}" into itself`, 'error');
                _tdHover = null;
                return;
            }
            const tgtChildren = VFS.children(_tdHover),
                existing = new Set(tgtChildren.map(n => n.name.toLowerCase())),
                dupe = [...owner.selection].find(id => id !== _tdHover && existing.has(VFS.node(id)?.name?.toLowerCase()));
            if (dupe) {
                _snapBack(_tdStartPos);
                toast(`"${VFS.node(dupe)?.name}" already exists in target folder`, 'error');
                _tdHover = null;
                return;
            }
            const moved = [];
            owner.selection.forEach(id => {
                if (id === _tdHover) return;
                if (VFS.move(id, _tdHover) === 'ok') {
                    moved.push(id);
                    area.querySelector(`.file-item[data-id="${id}"]`)?.remove();
                    area._iconMap?.delete(id);
                }
            });
            if (moved.length) logActivity('move', `${moved.length} item${moved.length > 1 ? 's' : ''} \u2192 ${VFS.node(_tdHover)?.name || 'folder'}`, moved.length);
            moved.forEach(id => owner.selection.delete(id));
            _tdHover = null;
        } else {
            // Snap to grid in place
            const occupied = new Map();
            VFS.children(owner.folderId).forEach(n => {
                if (owner.selection.has(n.id)) return;
                const p = VFS.getPos(owner.folderId, n.id);
                if (p) occupied.set(`${Math.round((p.x - 8) / GRID_X)}_${Math.round((p.y - 8) / GRID_Y)}`, n.id);
            });
            owner.selection.forEach(id => {
                const el = area.querySelector(`.file-item[data-id="${id}"]`);
                if (!el) return;
                const snapped = _snapFreeCell(parseInt(el.style.left), parseInt(el.style.top), occupied),
                    cx = Math.round((snapped.x - 8) / GRID_X), cy = Math.round((snapped.y - 8) / GRID_Y);
                occupied.set(`${cx}_${cy}`, id);
                el.style.transition = 'left .12s ease,top .12s ease';
                el.style.left = snapped.x + 'px'; el.style.top = snapped.y + 'px';
                setTimeout(() => { if (el.parentNode) el.style.transition = ''; }, 150);
                VFS.setPos(owner.folderId, id, snapped.x, snapped.y);
            });
        }
        owner._updateStatus(); await saveVFS();
        if (opts.afterDrop) opts.afterDrop();
        if (typeof WinManager !== 'undefined') WinManager.renderAll();

        function _snapBack(startPos) {
            Object.entries(startPos).forEach(([id, sp]) => {
                const el = area.querySelector(`.file-item[data-id="${id}"]`);
                if (el && sp) {
                    el.style.transition = 'left .12s ease,top .12s ease';
                    el.style.left = sp.x + 'px'; el.style.top = sp.y + 'px';
                    setTimeout(() => { if (el.parentNode) el.style.transition = ''; }, 150);
                }
            });
        }
    });

    area.addEventListener('touchcancel', () => {
        _touchDragActive = false; _tdActive = false;
        if (_tdTimer) { clearTimeout(_tdTimer); _tdTimer = null; }
        if (_tdEl) { _tdEl.classList.remove('dragging'); _tdEl = null; }
        if (_tdHover) { area.querySelector(`.file-item[data-id="${_tdHover}"]`)?.classList.remove('drag-target'); _tdHover = null; }
        if (_tdSnapPrev) { _tdSnapPrev.remove(); _tdSnapPrev = null; }
        _tdNode = null;
    }, { passive: true });
}

/* ---- Shared rubber-band mouse selection ----
   sel = Set, onUpdate = () => void */
function _rubberBandSelect(e, area, sel, onUpdate) {
    const rect = area.getBoundingClientRect(),
        sx = e.clientX - rect.left + area.scrollLeft,
        sy = e.clientY - rect.top + area.scrollTop,
        band = document.createElement('div');
    band.className = 'rubberband';
    band.style.cssText = `left:${sx}px;top:${sy}px;width:0;height:0`;
    area.appendChild(band);
    const onMove = mv => {
        const cx = mv.clientX - rect.left + area.scrollLeft,
            cy = mv.clientY - rect.top + area.scrollTop,
            x = Math.min(sx, cx), y = Math.min(sy, cy),
            w = Math.abs(cx - sx), h = Math.abs(cy - sy);
        band.style.cssText = `left:${x}px;top:${y}px;width:${w}px;height:${h}px`;
        const bx1 = x, by1 = y, bx2 = x + w, by2 = y + h;
        for (const item of (area._iconMap?.values() ?? area.querySelectorAll(':scope > .file-item'))) {
            const ix = parseInt(item.style.left), iy = parseInt(item.style.top),
                hit = ix < bx2 && (ix + ICON_W) > bx1 && iy < by2 && (iy + ICON_H) > by1;
            if (hit) { sel.add(item.dataset.id); item.classList.add('selected'); }
            else if (!e.ctrlKey && !e.metaKey) { sel.delete(item.dataset.id); item.classList.remove('selected'); }
        }
        onUpdate();
    };
    const onUp = () => { band.remove(); document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
}

/* ============================================================
   UNIFIED ICON DRAG — shared by Desktop and FolderWindow
   srcCtx = { area, folderId, selection, winEl, updateUI, clearAll }
   winEl = null  →  source is the desktop
   winEl = elem  →  source is a folder window
   ============================================================ */
function _startIconDrag(e, node, el, srcCtx) {
    e.stopPropagation(); e.preventDefault();
    _cancelHoverTooltip();

    const wasSelected = srcCtx.selection.has(node.id);
    if (!e.ctrlKey && !e.metaKey && !wasSelected) srcCtx.clearAll();
    srcCtx.selection.add(node.id);
    el.classList.add('selected');
    srcCtx.updateUI();

    const isDesktop = srcCtx.winEl === null,
        srcArea = srcCtx.area;

    // Build O(1) element lookup for hot-path drag operations (uses iconMap when available)
    const selEls = new Map();
    srcCtx.selection.forEach(id => {
        const it = srcArea._iconMap?.get(id) ?? srcArea.querySelector(`.file-item[data-id="${id}"]`);
        if (it) selEls.set(id, it);
    });

    // Elevate z-index for desktop items during drag
    if (isDesktop) {
        selEls.forEach(it => { it.style.zIndex = '7900'; });
    }

    const areaRect = srcArea.getBoundingClientRect(),
        elRect = el.getBoundingClientRect(),
        clickOffX = e.clientX - elRect.left,
        clickOffY = e.clientY - elRect.top,
        startX = e.clientX,
        startY = e.clientY;

    // Snapshot start positions of all selected icons (reuse selEls — no extra querySelector)
    const startPosMap = {};
    selEls.forEach((it, id) => { startPosMap[id] = { x: parseInt(it.style.left), y: parseInt(it.style.top) }; });

    // Build occupied map for snap preview excluding dragged items
    const srcOccupied = new Map();
    VFS.children(srcCtx.folderId).forEach(n => {
        if (srcCtx.selection.has(n.id)) return;
        const p = VFS.getPos(srcCtx.folderId, n.id);
        if (p) srcOccupied.set(`${Math.round((p.x - 8) / GRID_X)}_${Math.round((p.y - 8) / GRID_Y)}`, n.id);
    });

    let snapPreviewEls = [],      // previews inside the source area
        deskSnapPreviewEls = [],  // previews on desktop (when FW item escapes to desktop)
        winSnapPreviewEls = [],  // previews inside a hovered FW
        ghostEls = [],  // ghost clones on desktop when FW item escapes
        moved = false,
        escaped = false,         // FW item currently outside its window
        hoverFolder = null,
        hoverWin = null,
        lastX = e.clientX,
        lastY = e.clientY;

    // ---- helpers ----------------------------------------------------------

    function _showPreviews(previewArr, selIds, dropX, dropY, occMap, targetArea) {
        while (previewArr.length < selIds.length) {
            const p = document.createElement('div'); p.className = 'snap-preview';
            targetArea.appendChild(p); previewArr.push(p);
        }
        while (previewArr.length > selIds.length) previewArr.pop().remove();
        const snapOcc = new Map(occMap),
            mainSp = startPosMap[node.id];
        selIds.forEach((id, i) => {
            const sp = startPosMap[id],
                offX = sp && mainSp ? sp.x - mainSp.x : 0,
                offY = sp && mainSp ? sp.y - mainSp.y : 0,
                snapped = _snapFreeCell(dropX + offX, dropY + offY, snapOcc),
                cx = Math.round((snapped.x - 8) / GRID_X), cy = Math.round((snapped.y - 8) / GRID_Y);
            snapOcc.set(`${cx}_${cy}`, id);
            previewArr[i].style.left = snapped.x + 'px';
            previewArr[i].style.top = snapped.y + 'px';
            previewArr[i].style.display = '';
        });
    }

    function _snapBackSrc() {
        srcCtx.selection.forEach(id => {
            const item = selEls.get(id),
                sp = startPosMap[id];
            if (item && sp) {
                item.style.transition = 'left 0.12s ease, top 0.12s ease';
                item.style.left = sp.x + 'px'; item.style.top = sp.y + 'px';
                setTimeout(() => { if (item.parentNode) item.style.transition = ''; }, 150);
            }
        });
    }

    async function _dropIntoFolder(destFid, dropX, dropY) {
        // pre-check: cycles (includes self-move: wouldCycle(A,A) → true)
        const cycled = [];
        srcCtx.selection.forEach(id => {
            if (VFS.wouldCycle(id, destFid)) cycled.push(VFS.node(id)?.name || id);
        });
        if (cycled.length) {
            _snapBackSrc();
            toast(`Cannot move "${cycled[0]}" into itself or a subfolder`, 'error');
            return false;
        }
        // pre-check: duplicates
        const existing = new Set(VFS.children(destFid).map(n => n.name.toLowerCase())),
            conflicts = [];
        srcCtx.selection.forEach(id => {
            const n = VFS.node(id); if (!n) return;
            if (n.parentId !== destFid && existing.has(n.name.toLowerCase())) conflicts.push(n.name);
        });
        if (conflicts.length) {
            _snapBackSrc();
            toast(`Cannot move: "${conflicts[0]}" already exists in target folder`, 'error');
            return false;
        }
        // perform move
        const movedIds = [],
            occupied = new Map();
        VFS.children(destFid).forEach(n => {
            const p = VFS.getPos(destFid, n.id);
            if (p) occupied.set(`${Math.round((p.x - 8) / GRID_X)}_${Math.round((p.y - 8) / GRID_Y)}`, n.id);
        });
        const mainSp = startPosMap[node.id];
        for (const id of srcCtx.selection) {
            if (id === destFid) continue;
            const n = VFS.node(id); if (!n) continue;
            const result = VFS.move(id, destFid);
            if (result === 'duplicate') { toast(`"${n.name}" already exists in target folder`, 'error'); continue; }
            if (result === 'cycle') { toast(`Cannot move "${n.name}" into itself or a subfolder`, 'error'); continue; }
            if (result !== 'ok') { continue; }
            if (dropX !== null) {
                const sp = startPosMap[id],
                    offX = sp && mainSp ? sp.x - mainSp.x : 0,
                    offY = sp && mainSp ? sp.y - mainSp.y : 0,
                    sn = _snapFreeCell(dropX + offX, dropY + offY, occupied);
                VFS.setPos(destFid, id, sn.x, sn.y);
                occupied.set(`${Math.round((sn.x - 8) / GRID_X)}_${Math.round((sn.y - 8) / GRID_Y)}`, id);
            }
            movedIds.push(id);
        }
        if (movedIds.length) {
            const _mvDest = VFS.node(destFid)?.name || 'folder';
            logActivity('move',
                movedIds.length === 1 ? `${VFS.node(movedIds[0])?.name} → ${_mvDest}` : `${movedIds.length} items → ${_mvDest}`,
                movedIds.length,
                movedIds.length === 1 ? VFS.fullPath(movedIds[0]) : VFS.fullPath(destFid));
        }
        return movedIds;
    }

    // ---- onMove -----------------------------------------------------------

    const onMove = mv => {
        lastX = mv.clientX; lastY = mv.clientY;
        if (!moved && (Math.abs(mv.clientX - startX) + Math.abs(mv.clientY - startY)) > 4) {
            moved = true; _isDragging = true; _cancelHoverTooltip();
        }
        if (!moved) return;

        const mainSp = startPosMap[node.id],
            curAreaRect = srcArea.getBoundingClientRect(),
            targetMainX = mv.clientX - curAreaRect.left + srcArea.scrollLeft - clickOffX,
            targetMainY = mv.clientY - curAreaRect.top + srcArea.scrollTop - clickOffY,
            dx = targetMainX - mainSp.x,
            dy = targetMainY - mainSp.y;

        // ---- FW-specific: escape / re-enter --------------------------------
        if (!isDesktop) {
            const winRect = srcCtx.winEl.getBoundingClientRect();
            const outsideWindow = mv.clientX < winRect.left || mv.clientX > winRect.right ||
                mv.clientY < winRect.top || mv.clientY > winRect.bottom;

            if (!outsideWindow && escaped) {
                // Re-entered source window — cancel escape
                escaped = false;
                ghostEls.forEach(g => g.remove()); ghostEls = [];
                deskSnapPreviewEls.forEach(p => p.remove()); deskSnapPreviewEls = [];
                winSnapPreviewEls.forEach(p => p.remove()); winSnapPreviewEls = [];
                selEls.forEach(orig => { orig.style.visibility = ''; });
            }
            if (outsideWindow && !escaped) {
                // Escaping — hide originals, spawn ghosts on desktop
                escaped = true;
                selEls.forEach(orig => { orig.style.visibility = 'hidden'; });
                const deskArea = document.getElementById('desktop-area'),
                    selIds = [...srcCtx.selection].sort((a, b) => a === node.id ? -1 : b === node.id ? 1 : 0);
                selIds.forEach(id => {
                    const n = VFS.node(id); if (!n) return;
                    const g = _buildIconEl(n, { x: 0, y: 0 });
                    g.classList.add('selected');
                    g.style.cssText += ';position:absolute;z-index:7900;opacity:0.7;pointer-events:none;will-change:left,top';
                    g.dataset.ghostFor = id;
                    deskArea.appendChild(g);
                    ghostEls.push(g);
                });
            }
        }

        // ---- position items / ghosts ---------------------------------------
        if (!escaped) {
            srcCtx.selection.forEach(id => {
                const it = selEls.get(id),
                    sp = startPosMap[id];
                if (it && sp) { it.style.left = (sp.x + dx) + 'px'; it.style.top = (sp.y + dy) + 'px'; }
            });
        } else {
            const deskArea = document.getElementById('desktop-area'),
                deskRect = deskArea.getBoundingClientRect(),
                baseX = mv.clientX - deskRect.left + deskArea.scrollLeft - clickOffX,
                baseY = mv.clientY - deskRect.top + deskArea.scrollTop - clickOffY;
            ghostEls.forEach(g => {
                const sp = startPosMap[g.dataset.ghostFor],
                    offX = sp && mainSp ? sp.x - mainSp.x : 0,
                    offY = sp && mainSp ? sp.y - mainSp.y : 0;
                g.style.left = (baseX + offX) + 'px';
                g.style.top = (baseY + offY) + 'px';
            });
        }

        // ---- hover-folder highlight ----------------------------------------
        if (!escaped) {
            selEls.forEach(it => { it.style.pointerEvents = 'none'; });
        }
        const target = document.elementFromPoint(mv.clientX, mv.clientY);
        if (!escaped) {
            selEls.forEach(it => { it.style.pointerEvents = ''; });
        }
        const folderEl = target?.closest('.file-item[data-id]');
        const newHover = folderEl && !srcCtx.selection.has(folderEl.dataset.id) &&
            VFS.node(folderEl.dataset.id)?.type === 'folder' ? folderEl.dataset.id : null;
        if (newHover !== hoverFolder) {
            if (hoverFolder) document.querySelectorAll(`.file-item[data-id="${hoverFolder}"]`).forEach(i => i.classList.remove('drag-target'));
            hoverFolder = newHover;
            if (hoverFolder) document.querySelectorAll(`.file-item[data-id="${hoverFolder}"]`).forEach(i => i.classList.add('drag-target'));
        }

        // ---- hovered FW (excluding source window) -------------------------
        const fwElt = !hoverFolder ? target?.closest('.folder-window') : null,
            curWin = fwElt ? (typeof WinManager !== 'undefined' ? WinManager._wins.find(w => w.el === fwElt) : null) : null,
            effectiveHoverWin = (curWin && curWin.el !== srcCtx.winEl) ? curWin : null;
        if (effectiveHoverWin !== hoverWin) {
            winSnapPreviewEls.forEach(p => p.remove()); winSnapPreviewEls = [];
            hoverWin = effectiveHoverWin;
        }

        // ---- snap previews ------------------------------------------------
        if (!moved) return;

        if (hoverFolder) {
            snapPreviewEls.forEach(p => p.style.display = 'none');
            deskSnapPreviewEls.forEach(p => p.style.display = 'none');
            winSnapPreviewEls.forEach(p => p.style.display = 'none');
        } else if (hoverWin) {
            snapPreviewEls.forEach(p => p.style.display = 'none');
            deskSnapPreviewEls.forEach(p => p.style.display = 'none');
            const winArea = hoverWin.el.querySelector('.fw-area'),
                wRect = winArea.getBoundingClientRect(),
                dropX = mv.clientX - wRect.left + winArea.scrollLeft - clickOffX,
                dropY = mv.clientY - wRect.top + winArea.scrollTop - clickOffY,
                winOcc = new Map();
            VFS.children(hoverWin.folderId).forEach(n => {
                const p = VFS.getPos(hoverWin.folderId, n.id);
                if (p) winOcc.set(`${Math.round((p.x - 8) / GRID_X)}_${Math.round((p.y - 8) / GRID_Y)}`, n.id);
            });
            _showPreviews(winSnapPreviewEls, [...srcCtx.selection], dropX, dropY, winOcc, winArea);
        } else if (escaped) {
            // on desktop (FW items that escaped)
            snapPreviewEls.forEach(p => p.style.display = 'none');
            winSnapPreviewEls.forEach(p => p.style.display = 'none');
            const deskArea = document.getElementById('desktop-area'),
                dRect = deskArea.getBoundingClientRect(),
                dropX = mv.clientX - dRect.left + deskArea.scrollLeft - clickOffX,
                dropY = mv.clientY - dRect.top + deskArea.scrollTop - clickOffY,
                deskOcc = new Map();
            VFS.children(Desktop._desktopFolder).forEach(n => {
                const p = VFS.getPos(Desktop._desktopFolder, n.id);
                if (p) deskOcc.set(`${Math.round((p.x - 8) / GRID_X)}_${Math.round((p.y - 8) / GRID_Y)}`, n.id);
            });
            _showPreviews(deskSnapPreviewEls, [...srcCtx.selection], dropX, dropY, deskOcc, deskArea);
        } else {
            // within source area (desktop or FW)
            deskSnapPreviewEls.forEach(p => p.style.display = 'none');
            winSnapPreviewEls.forEach(p => p.style.display = 'none');
            _showPreviews(snapPreviewEls, [...srcCtx.selection], mainSp.x + dx, mainSp.y + dy, srcOccupied, srcArea);
        }
    };

    // ---- onUp -------------------------------------------------------------

    const onUp = async () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        _isDragging = false;
        snapPreviewEls.forEach(p => p.remove()); snapPreviewEls = [];
        deskSnapPreviewEls.forEach(p => p.remove()); deskSnapPreviewEls = [];
        winSnapPreviewEls.forEach(p => p.remove()); winSnapPreviewEls = [];
        if (hoverFolder) document.querySelectorAll(`.file-item[data-id="${hoverFolder}"]`).forEach(i => i.classList.remove('drag-target'));
        ghostEls.forEach(g => g.remove()); ghostEls = [];

        // Restore desktop z-index
        if (isDesktop) {
            selEls.forEach(it => { it.style.zIndex = ''; });
        }

        if (!moved) {
            // Ctrl+click on already-selected item → deselect it
            if ((e.ctrlKey || e.metaKey) && wasSelected) {
                srcCtx.selection.delete(node.id);
                el.classList.remove('selected');
                srcCtx.updateUI();
            }
            // Click without drag — restore visibility for FW items
            if (!isDesktop) {
                selEls.forEach(orig => { orig.style.visibility = ''; });
            }
            return;
        }

        // ---- pre-check: open-folder guard (only when changing folder) ------
        // Note: for desktop items, `escaped` is never true; desktop→FW drops are caught
        // by the extra elementFromPoint check below.
        if (escaped || hoverFolder || document.elementFromPoint(lastX, lastY)?.closest('.folder-window')) {
            const blocked = _openFolderGuard(srcCtx.selection);
            if (blocked) {
                _snapBackSrc();
                if (!isDesktop) selEls.forEach(orig => { orig.style.visibility = ''; });
                toast(`\u201C${VFS.node(blocked)?.name}\u201D is open in Explorer \u2014 close the window first`, 'error');
                return;
            }
        }

        // ---- Case 1: FW item escaped → dropped back in same window (race) --
        if (!isDesktop && escaped) {
            const srcR = srcCtx.winEl.getBoundingClientRect();
            if (lastX >= srcR.left && lastX <= srcR.right && lastY >= srcR.top && lastY <= srcR.bottom) {
                selEls.forEach(orig => { orig.style.visibility = ''; });
                return;
            }
        }

        // Determine actual drop zone
        const dropTarget = document.elementFromPoint(lastX, lastY),
            tFwEl = dropTarget?.closest('.folder-window'),
            tWin = tFwEl ? (typeof WinManager !== 'undefined' ? WinManager._wins.find(w => w.el === tFwEl) : null) : null,
            actualHoverWin = (tWin && tWin.el !== srcCtx.winEl) ? tWin : null;

        // ---- Case 2: dropped onto a folder icon ----------------------------
        if (hoverFolder) {
            const movedIds = await _dropIntoFolder(hoverFolder, null, null);
            if (movedIds === false) {
                if (!isDesktop) selEls.forEach(orig => { orig.style.visibility = ''; });
                return;
            }
            const targetWinForFolder = typeof WinManager !== 'undefined' ? WinManager._wins.find(w => w.folderId === hoverFolder) : null;
            if (targetWinForFolder) targetWinForFolder._clearSelection();
            movedIds.forEach(id => {
                srcCtx.selection.delete(id);
                if (targetWinForFolder) targetWinForFolder.selection.add(id);
                selEls.get(id)?.remove();
                srcArea._iconMap?.delete(id);
            });
            // snap back failures
            if (!isDesktop) srcCtx.selection.forEach(id => {
                const orig = selEls.get(id);
                if (orig) orig.style.visibility = '';
            });
            srcCtx.updateUI();
            await saveVFS();
            if (typeof WinManager !== 'undefined') WinManager.renderAll();
            return;
        }

        // ---- Case 3: dropped onto a folder window -------------------------
        if (actualHoverWin || (!isDesktop && escaped && !hoverFolder)) {
            const targetWin = actualHoverWin;
            if (targetWin) {
                const tArea = targetWin.el.querySelector('.fw-area'),
                    tRect = tArea.getBoundingClientRect(),
                    dropPosX = lastX - tRect.left + tArea.scrollLeft - clickOffX,
                    dropPosY = lastY - tRect.top + tArea.scrollTop - clickOffY,
                    movedIds = await _dropIntoFolder(targetWin.folderId, dropPosX, dropPosY);
                if (movedIds === false) {
                    if (!isDesktop) selEls.forEach(orig => { orig.style.visibility = ''; });
                    return;
                }
                const srcWin = !isDesktop ? (typeof WinManager !== 'undefined' ? WinManager._wins.find(w => w.el === srcCtx.winEl) : null) : null;
                targetWin._clearSelection();
                movedIds.forEach(id => {
                    srcCtx.selection.delete(id);
                    targetWin.selection.add(id);
                    selEls.get(id)?.remove();
                    srcArea._iconMap?.delete(id);
                });
                // snap back failures
                if (!isDesktop) srcCtx.selection.forEach(id => {
                    const orig = selEls.get(id);
                    if (orig) orig.style.visibility = '';
                });
                srcCtx.updateUI();
                await saveVFS();
                targetWin.render();
                return;
            }
        }

        // ---- Case 4a: FW item dropped onto desktop ------------------------
        if (!isDesktop && escaped) {
            const deskArea = document.getElementById('desktop-area'),
                dRect = deskArea.getBoundingClientRect(),
                dropPosX = lastX - dRect.left + deskArea.scrollLeft - clickOffX,
                dropPosY = lastY - dRect.top + deskArea.scrollTop - clickOffY,
                deskFid = Desktop._desktopFolder,
                occupied = new Map();
            VFS.children(deskFid).forEach(n => {
                const p = VFS.getPos(deskFid, n.id);
                if (p) occupied.set(`${Math.round((p.x - 8) / GRID_X)}_${Math.round((p.y - 8) / GRID_Y)}`, n.id);
            });
            const mainSp = startPosMap[node.id],
                movedIds = [];
            for (const id of srcCtx.selection) {
                const n = VFS.node(id); if (!n) continue;
                const result = VFS.move(id, deskFid);
                if (result === 'duplicate') { toast(`"${n.name}" already exists on desktop`, 'error'); continue; }
                if (result === 'cycle') { toast(`Cannot move "${n.name}" into itself`, 'error'); continue; }
                const sp = startPosMap[id],
                    offX = sp && mainSp ? sp.x - mainSp.x : 0,
                    offY = sp && mainSp ? sp.y - mainSp.y : 0,
                    sn = _snapFreeCell(dropPosX + offX, dropPosY + offY, occupied);
                VFS.setPos(deskFid, id, sn.x, sn.y);
                occupied.set(`${Math.round((sn.x - 8) / GRID_X)}_${Math.round((sn.y - 8) / GRID_Y)}`, id);
                movedIds.push(id);
            }
            Desktop._sel.clear();
            document.querySelectorAll('#desktop-area > .file-item.selected').forEach(i => i.classList.remove('selected'));
            movedIds.forEach(id => {
                srcCtx.selection.delete(id);
                Desktop._sel.add(id);
                selEls.get(id)?.remove();
                srcArea._iconMap?.delete(id);
            });
            // snap back failures
            srcCtx.selection.forEach(id => {
                const orig = selEls.get(id);
                if (orig) {
                    orig.style.visibility = '';
                    const sp = startPosMap[id];
                    if (sp) {
                        orig.style.transition = 'left 0.15s ease, top 0.15s ease';
                        orig.style.left = sp.x + 'px'; orig.style.top = sp.y + 'px';
                        setTimeout(() => { if (orig.parentNode) orig.style.transition = ''; }, 160);
                    }
                }
            });
            if (movedIds.length) logActivity('move',
                movedIds.length === 1 ? `${VFS.node(movedIds[0])?.name} → Desktop` : `${movedIds.length} items → Desktop`,
                movedIds.length,
                movedIds.length === 1 ? VFS.fullPath(movedIds[0]) : null);
            srcCtx.updateUI();
            await saveVFS();
            Desktop._patchIcons();
            return;
        }

        // ---- Case 4b: within-source snap ----------------------------------
        if (!isDesktop) {
            // restore visibility first
            selEls.forEach(orig => { orig.style.visibility = ''; });
        }
        // Grid snap within source area
        const occupied = new Map();
        VFS.children(srcCtx.folderId).forEach(n => {
            if (srcCtx.selection.has(n.id)) return;
            const p = VFS.getPos(srcCtx.folderId, n.id);
            if (p) occupied.set(`${Math.round((p.x - 8) / GRID_X)}_${Math.round((p.y - 8) / GRID_Y)}`, n.id);
        });
        srcCtx.selection.forEach(id => {
            const item = selEls.get(id);
            if (!item) return;
            const rawX = parseInt(item.style.left), rawY = parseInt(item.style.top),
                snapped = _snapFreeCell(rawX, rawY, occupied),
                cx = Math.round((snapped.x - 8) / GRID_X), cy = Math.round((snapped.y - 8) / GRID_Y);
            occupied.set(`${cx}_${cy}`, id);
            item.style.transition = 'left 0.12s ease, top 0.12s ease';
            item.style.left = snapped.x + 'px'; item.style.top = snapped.y + 'px';
            setTimeout(() => { if (item.parentNode) item.style.transition = ''; }, 150);
            VFS.setPos(srcCtx.folderId, id, snapped.x, snapped.y);
        });
        await saveVFS();
        if (isDesktop) {
            srcCtx.updateUI();
        } else {
            _syncAreaWidth(srcArea);
        }
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
}

/* ============================================================
   SHARED KEYBOARD HANDLER — Desktop & FolderWindow
   syncCtx: fn to set App.folder/selection/winCtx before an operation
   withSync: fn(op) to set context → run op → restore context (sync only)
   opts.area: icon container element
   opts.refresh: fn() called on F5
   opts.extraKeys: fn(e) → true if handled (for FW-specific keys like Backspace=navup)
   ============================================================ */
function _handleKey(e, owner, syncCtx, withSync, opts = {}) {
    if ((e.key === 'Delete' || e.key === 'Backspace') && owner.selection.size > 0) {
        syncCtx(); deleteSelected();
    } else if ((e.ctrlKey || e.metaKey) && e.code === 'KeyC' && owner.selection.size > 0) {
        withSync(() => copyItems());
    } else if ((e.ctrlKey || e.metaKey) && e.code === 'KeyX' && owner.selection.size > 0) {
        withSync(() => cutItems());
    } else if ((e.ctrlKey || e.metaKey) && e.code === 'KeyV') {
        syncCtx(); pasteItems();
    } else if ((e.ctrlKey || e.metaKey) && e.code === 'KeyA') {
        syncCtx(); selectAll();
    } else if (e.key === 'Escape') {
        if (App.clipboard?.op === 'cut') cancelClipboard();
        owner.selection.clear();
        (opts.area || document).querySelectorAll('.file-item.selected').forEach(i => i.classList.remove('selected'));
        owner._updateStatus();
    } else if (e.key === 'F2' && owner.selection.size === 1) {
        renameNode(VFS.node([...owner.selection][0]));
    } else if (e.key === 'F5') {
        e.preventDefault();
        if (opts.refresh) opts.refresh();
    } else if (opts.extraKeys) {
        opts.extraKeys(e);
    }
}

/* ============================================================
   SHARED CONTEXT MENU BUILDERS — Desktop & FolderWindow
   ============================================================ */
function _buildSortSubmenu(sortTarget) {
    return [
        {
            label: 'By Name', icon: Icons.sortName, submenu: [
                { label: 'A → Z', icon: Icons.sortAsc, action: () => sortIcons('name', 'asc', sortTarget) },
                { label: 'Z → A', icon: Icons.sortDesc, action: () => sortIcons('name', 'desc', sortTarget) },
            ]
        },
        {
            label: 'By Date Modified', icon: Icons.sortDate, submenu: [
                { label: 'Newest first', icon: Icons.sortDesc, action: () => sortIcons('mtime', 'desc', sortTarget) },
                { label: 'Oldest first', icon: Icons.sortAsc, action: () => sortIcons('mtime', 'asc', sortTarget) },
            ]
        },
        {
            label: 'By Date Created', icon: Icons.sortDate, submenu: [
                { label: 'Newest first', icon: Icons.sortDesc, action: () => sortIcons('ctime', 'desc', sortTarget) },
                { label: 'Oldest first', icon: Icons.sortAsc, action: () => sortIcons('ctime', 'asc', sortTarget) },
            ]
        },
        { sep: true },
        {
            label: 'By Size', icon: Icons.sortSize, submenu: [
                { label: 'Largest first', icon: Icons.sortDesc, action: () => sortIcons('size', 'desc', sortTarget) },
                { label: 'Smallest first', icon: Icons.sortAsc, action: () => sortIcons('size', 'asc', sortTarget) },
            ]
        },
        { sep: true },
        { label: 'By Type', icon: Icons.sortType, action: () => sortIcons('type', 'asc', sortTarget) },
    ];
}

function _buildAreaMenuItems(e, syncFn, sortTarget, refreshFn) {
    const items = [
        { label: 'New Text File', icon: Icons.newfile, action: () => { syncFn(); App._ctxScreenPos = { x: e.clientX, y: e.clientY }; newTextFile(); } },
        { label: 'New Folder', icon: Icons.newfolder, action: () => { syncFn(); App._ctxScreenPos = { x: e.clientX, y: e.clientY }; newFolder(); } },
        { sep: true },
        { label: 'Import Files...', icon: Icons.upload, action: () => { syncFn(); document.getElementById('file-input').click(); } },
    ];
    if (App.clipboard) {
        items.push({ sep: true });
        items.push({ label: 'Paste', icon: Icons.paste, action: () => { syncFn(); pasteItems(); } });
    }
    items.push({ sep: true });
    items.push({ label: 'Sort', icon: Icons.sort, submenu: _buildSortSubmenu(sortTarget) });
    items.push({ sep: true });
    items.push({ label: 'Refresh', icon: Icons.refresh, action: refreshFn });
    return items;
}

function _buildIconMenuItems(node, sel, opts) {
    const items = [];
    if (node.type === 'folder') {
        items.push({ label: 'Open', icon: Icons.open, action: () => opts.openFn(node) });
        items.push({ label: 'Open in New Window', icon: Icons.newfolder, action: () => WinManager.open(node.id) });
        items.push({
            label: 'Folder Color', icon: Icons.folder, submenu: FOLDER_COLORS.map(fc => ({
                label: fc.label,
                icon: `<span style="display:inline-block;width:12px;height:12px;border-radius:2px;background:${fc.color}"></span>`,
                action: async () => { node.color = fc.color === '#0078d4' ? undefined : fc.color; await saveVFS(); opts.colorCb(); logActivity('color', `${node.name} → ${fc.label}`, 1, VFS.fullPath(node.id)); }
            }))
        });
    } else {
        items.push({ label: 'Open', icon: Icons.file, action: () => opts.openFn(node) });
        items.push({ label: 'Edit as plain text', icon: Icons.rename, action: () => openFileAsText(node) });
        items.push({ label: 'Export', icon: Icons.download, action: () => downloadFile(node) });
    }
    items.push({ label: 'Export as ZIP', icon: Icons.download, action: opts.exportZipFn });
    items.push({ sep: true });
    if (opts.hasCopy) items.push({ label: 'Copy', icon: Icons.copy, action: opts.copyFn });
    items.push({ label: 'Cut', icon: Icons.cut, action: opts.cutFn });
    items.push({ sep: true });
    items.push({ label: 'Rename', icon: Icons.rename, action: () => renameNode(node) });
    items.push({ sep: true });
    items.push({
        label: sel.size > 1 ? `Delete ${sel.size} items` : 'Delete', icon: Icons.trash, danger: true,
        action: opts.deleteFn,
    });
    items.push({ sep: true });
    items.push({ label: 'Properties', icon: Icons.info, action: () => showProps(node) });
    return items;
}

/* ---- Shared icon-area render (Desktop + FolderWindow): full rebuild or incremental ---- */
function _renderIconArea(area, folderId, selection, updateStatusFn, forceRebuild) {
    const items = VFS.children(folderId);
    items.sort((a, b) => a.type !== b.type ? (a.type === 'folder' ? -1 : 1) : a.name.localeCompare(b.name));
    area.classList.toggle('no-grid-dots', !_getSettings().gridDots);
    const iconMap = area._iconMap || (area._iconMap = new Map());
    const afterRender = () => {
        updateStatusFn();
        if (typeof _applyCutStyles !== 'undefined') _applyCutStyles();
        _syncAreaWidth(area);
    };
    if (forceRebuild) {
        iconMap.forEach(el => el.remove());
        iconMap.clear();
        if (!items.length) { afterRender(); return; }
        const needPos = items.filter(n => !VFS.getPos(folderId, n.id));
        if (needPos.length) VFS.autoPosBatch(folderId, needPos, area);
        const useAnim = items.length <= 200;
        const token = (area._renderToken = (area._renderToken || 0) + 1);
        const renderChunk = (start) => {
            if (area._renderToken !== token) return;
            const frag = document.createDocumentFragment(),
                end = Math.min(start + 300, items.length);
            for (let i = start; i < end; i++) {
                const n = items[i], pos = VFS.getPos(folderId, n.id) || { x: 8, y: 8 },
                    div = _buildIconEl(n, pos);
                if (selection.has(n.id)) div.classList.add('selected');
                if (useAnim) div.style.animation = `iconPop 0.12s ease ${Math.min(i * 15, 200)}ms both`;
                iconMap.set(n.id, div);
                frag.appendChild(div);
            }
            area.appendChild(frag);
            if (end < items.length) requestAnimationFrame(() => renderChunk(end));
            else afterRender();
        };
        renderChunk(0);
        // Immediate status/cut-styles refresh (visible before async chunks complete)
        updateStatusFn();
        if (typeof _applyCutStyles !== 'undefined') _applyCutStyles();
    } else {
        // Incremental: animate-out removed items, add new ones
        const nodeMap = new Map(items.map(n => [n.id, n]));
        iconMap.forEach((el, id) => {
            if (!nodeMap.has(id)) {
                if (!el.isConnected) { iconMap.delete(id); }
                else {
                    el.style.transition = 'opacity .1s, transform .1s';
                    el.style.opacity = '0'; el.style.transform = 'scale(.85)';
                    setTimeout(() => { el.remove(); iconMap.delete(id); }, 110);
                }
            }
        });
        const needPos = items.filter(n => !VFS.getPos(folderId, n.id));
        if (needPos.length) VFS.autoPosBatch(folderId, needPos, area);
        for (const [idx, n] of items.entries()) {
            let existing = iconMap.get(n.id);
            if (existing && !existing.isConnected) { iconMap.delete(n.id); existing = null; }
            if (existing) {
                const nameEl = existing.querySelector('.file-name');
                if (nameEl && nameEl.textContent !== n.name) nameEl.textContent = n.name;
                if (n.type === 'folder') {
                    const thumbEl = existing.querySelector('.file-thumb.folder-icon');
                    if (thumbEl) thumbEl.innerHTML = getFolderSVG(n.color);
                }
            } else {
                const pos = VFS.getPos(folderId, n.id) || { x: 8, y: 8 },
                    div = _buildIconEl(n, pos);
                if (selection.has(n.id)) div.classList.add('selected');
                div.style.animation = `iconPop 0.12s ease ${Math.min(idx * 15, 200)}ms both`;
                iconMap.set(n.id, div);
                area.appendChild(div);
            }
        }
        afterRender();
    }
}

/* ============================================================
   DESKTOP
   ============================================================ */
const Desktop = {
    _desktopFolder: 'root',
    _sel: App.selection,   // main desktop's own selection (same reference as App.selection initially)
    // Unified interface aliases used by shared helpers (_setupAreaDelegation, _initAreaTouchRubberBand, _rubberBandSelect)
    get selection() { return this._sel; },
    get folderId() { return this._desktopFolder; },
    _updateStatus() { this._updateSelectionBar(); },

    render() {
        // Restore main desktop's folder + selection as the active App context
        App._winCtx = null;
        App.folder = this._desktopFolder;
        App.selection = this._sel;

        this._renderBreadcrumb();
        this._renderIcons();
        this.updateTaskbar();
        document.title = 'SafeNova — ' + (App.container?.name || 'Container');
        // Re-render all open folder windows
        if (typeof WinManager !== 'undefined') WinManager.renderAll();
        // Load activity log from compressed storage (async)
        _loadActivityLog();
    },

    _renderBreadcrumb() {
        const bc = document.getElementById('breadcrumb'),
            crumbs = VFS.breadcrumb(this._desktopFolder);
        bc.innerHTML = '';
        crumbs.forEach((n, i) => {
            const span = document.createElement('span');
            span.className = 'breadcrumb-item' + (i === crumbs.length - 1 ? ' current' : '');
            span.textContent = n.id === 'root' ? ('/~/' + App.container.name) : n.name;
            if (i < crumbs.length - 1) {
                span.addEventListener('click', () => {
                    this._desktopFolder = n.id;
                    this._sel.clear();
                    this.render();
                });
            }
            bc.appendChild(span);
            if (i < crumbs.length - 1) {
                const sep = document.createElement('span');
                sep.className = 'breadcrumb-sep';
                sep.textContent = ' › ';
                bc.appendChild(sep);
            }
        });
    },

    _renderIcons() {
        _renderIconArea(
            document.getElementById('desktop-area'),
            this._desktopFolder, this._sel,
            () => this._updateSelectionBar(), true
        );
    },

    // Incremental update: add new icons, remove gone ones, sync names — NO re-animation for existing
    _patchIcons() {
        App._winCtx = null;
        App.folder = this._desktopFolder;
        App.selection = this._sel;
        _renderIconArea(
            document.getElementById('desktop-area'),
            this._desktopFolder, this._sel,
            () => { this._updateSelectionBar(); this.updateTaskbar(); }, false
        );
        if (typeof WinManager !== 'undefined') WinManager.renderAll();
    },

    _onIconMousedown(e, el, node) {
        if (e.button !== 0) return;
        hideCtxMenu();
        _startIconDrag(e, node, el, {
            area: document.getElementById('desktop-area'),
            folderId: this._desktopFolder,
            selection: this._sel,
            winEl: null,
            updateUI: () => { this._updateSelectionBar(); this.updateTaskbar(); },
            clearAll: () => {
                this._sel.clear();
                document.querySelectorAll('#desktop-area > .file-item.selected').forEach(i => i.classList.remove('selected'));
            },
        });
    },


    /* ---- Touch-drag for mobile: long-press (400ms) + drag icons ---- */
    _initTouchDrag(area) {
        _initTouchDragCommon(area, this, { showSnap: true, afterDrop: () => this.updateTaskbar() });
    },

    _openNode(node) {
        hideCtxMenu();
        if (node.type === 'folder') {
            // Folders always open in a new floating window
            WinManager.open(node.id);
        } else {
            openFile(node);
        }
    },

    _contextIcon(e, node) {
        if (!e.ctrlKey && !e.metaKey && !this._sel.has(node.id)) {
            this._sel.clear();
            document.querySelectorAll('#desktop-area > .file-item.selected').forEach(i => i.classList.remove('selected'));
        }
        this._sel.add(node.id);
        document.querySelector(`#desktop-area > .file-item[data-id="${node.id}"]`)?.classList.add('selected');
        this._updateSelectionBar();
        const _sync = () => { App.folder = this._desktopFolder; App.selection = this._sel; App._winCtx = null; };
        showCtxMenu(e.clientX, e.clientY, _buildIconMenuItems(node, this._sel, {
            openFn: n => n.type === 'folder' ? WinManager.open(n.id) : this._openNode(n),
            colorCb: () => Desktop._patchIcons(),
            hasCopy: true,
            copyFn: () => { _sync(); copyItems(); },
            cutFn: () => { _sync(); cutItems(); },
            exportZipFn: () => { _sync(); exportAsZip([...this._sel]); },
            deleteFn: () => { _sync(); deleteSelected(); },
        }));
    },

    _contextDesktop(e) {
        this._sel.clear();
        document.querySelectorAll('#desktop-area > .file-item.selected').forEach(i => i.classList.remove('selected'));
        this._updateSelectionBar();
        const _sync = () => { App.folder = this._desktopFolder; App.selection = this._sel; App._winCtx = null; };
        showCtxMenu(e.clientX, e.clientY, _buildAreaMenuItems(e, _sync, undefined,
            () => { Desktop._renderIcons(); if (typeof WinManager !== 'undefined') WinManager.renderAll(); }));
    },

    // Clear selection: empties both the Set AND removes .selected CSS classes from DOM
    _clearSelection() {
        this._sel.clear();
        document.querySelectorAll('#desktop-area > .file-item.selected').forEach(i => i.classList.remove('selected'));
        this._updateSelectionBar();
    },

    _updateSelectionBar() {
        const bar = document.getElementById('selection-bar');
        if (this._sel.size > 0) {
            const totalSz = [...this._sel].reduce((s, id) => {
                const n = VFS.node(id); return s + (n && n.size ? n.size : 0);
            }, 0);
            bar.textContent = `${this._sel.size} item${this._sel.size !== 1 ? 's' : ''} selected${totalSz > 0 ? ' · ' + fmtSize(totalSz) : ''}`;
            bar.classList.add('show');
        } else {
            bar.classList.remove('show');
        }
    },

    updateTaskbar() {
        if (!App.container) return;
        const tot = App.container.totalSize || 0,
            pct = Math.min(tot / CONTAINER_LIMIT * 100, 100),
            cls = pct > 90 ? 'danger' : pct > 70 ? 'warn' : '';
        document.getElementById('taskbar-name').textContent = App.container.name;
        document.getElementById('taskbar-size-text').textContent = `${fmtSize(tot)} / ${fmtSize(CONTAINER_LIMIT)}`;
        document.getElementById('taskbar-size-pct').textContent = pct.toFixed(1) + '%';
        const bar = document.getElementById('taskbar-bar-fill');
        bar.style.width = pct + '%';
        bar.className = 'taskbar-bar-fill ' + cls;
    },

    initEvents() {
        const area = document.getElementById('desktop-area');
        // Delegated icon events: mousedown, dblclick, contextmenu, touch tap
        _setupAreaDelegation(area, this);
        // Mobile touch-drag for icons
        this._initTouchDrag(area);

        area.addEventListener('contextmenu', e => {
            if (e.target === area || e.target.classList.contains('drop-overlay') ||
                e.target.classList.contains('selection-bar')) {
                e.preventDefault();
                this._contextDesktop(e);
            }
        });

        area.addEventListener('mousedown', e => {
            if (e.target !== area) return;
            if (!e.ctrlKey && !e.metaKey) {
                this._sel.clear();
                document.querySelectorAll('#desktop-area > .file-item.selected').forEach(i => i.classList.remove('selected'));
                this._updateSelectionBar();
            }
            this._startRubberBand(e);
        });

        area.addEventListener('keydown', e => this._onKey(e));

        let _deskDndHoverFolder = null;
        area.addEventListener('dragover', e => {
            e.preventDefault();
            const overFW = !!e.target.closest('.folder-window');
            if (!overFW) {
                const folderEl = e.target?.closest?.('#desktop-area > .file-item[data-id]'),
                    newHover = folderEl && VFS.node(folderEl.dataset.id)?.type === 'folder' ? folderEl.dataset.id : null;
                if (newHover !== _deskDndHoverFolder) {
                    if (_deskDndHoverFolder) document.querySelector(`#desktop-area > .file-item[data-id="${_deskDndHoverFolder}"]`)?.classList.remove('drag-target');
                    _deskDndHoverFolder = newHover;
                    if (_deskDndHoverFolder) document.querySelector(`#desktop-area > .file-item[data-id="${_deskDndHoverFolder}"]`)?.classList.add('drag-target');
                }
            }
            document.getElementById('drop-overlay').classList.toggle('show', !overFW && !_deskDndHoverFolder);
        });
        area.addEventListener('dragleave', e => {
            if (!area.contains(e.relatedTarget)) {
                if (_deskDndHoverFolder) document.querySelector(`#desktop-area > .file-item[data-id="${_deskDndHoverFolder}"]`)?.classList.remove('drag-target');
                _deskDndHoverFolder = null;
                document.getElementById('drop-overlay').classList.remove('show');
            }
        });
        area.addEventListener('drop', e => {
            e.preventDefault();
            if (_deskDndHoverFolder) document.querySelector(`#desktop-area > .file-item[data-id="${_deskDndHoverFolder}"]`)?.classList.remove('drag-target');
            const targetFolderId = _deskDndHoverFolder || this._desktopFolder;
            _deskDndHoverFolder = null;
            document.getElementById('drop-overlay').classList.remove('show');
            App._winCtx = null;
            App.folder = targetFolderId;
            App.selection = this._sel;
            uploadEntries(e.dataTransfer.items, targetFolderId);
        });

        /* ---- Touch: rubber-band select on empty area + long-press context menu ---- */
        _initAreaTouchRubberBand(area, this);

        // Global: dismiss context menu on any LMB click outside the menu
        document.addEventListener('mousedown', e => {
            if (e.button !== 0) return;
            if (e.target.closest('#ctx-menu, #ctx-menu-sub, body > .ctx-menu')) return;
            hideCtxMenu();
        });
        // Track last touch to suppress spurious mouseenter tooltips fired by the browser after touchend
        document.addEventListener('touchstart', () => { _lastTouchTs = Date.now(); }, { passive: true, capture: true });
    },

    _startRubberBand(e) {
        _rubberBandSelect(e, document.getElementById('desktop-area'), this._sel, () => this._updateSelectionBar());
    },

    _onKey(e) {
        const sync = () => { App.folder = this._desktopFolder; App.selection = this._sel; App._winCtx = null; };
        _handleKey(e, this, sync, fn => { sync(); fn(); }, {
            area: document.getElementById('desktop-area'),
            refresh: () => { Desktop._renderIcons(); if (typeof WinManager !== 'undefined') WinManager.renderAll(); },
        });
    }
};

/* ============================================================
   FOLDER WINDOW MANAGER
   ============================================================ */
const WinManager = {
    _wins: [],
    _z: 300,

    open(folderId) {
        hideCtxMenu();
        // Auto-cancel cut if the opened folder (or its ancestor) is in the clipboard
        if (App.clipboard?.op === 'cut') {
            const cutIds = new Set(App.clipboard.ids);
            let cur = folderId;
            while (cur && cur !== 'root') {
                if (cutIds.has(cur)) { cancelClipboard(); break; }
                cur = (VFS.node(cur) || {}).parentId;
            }
        }
        // Bring existing window to front if already open
        const existing = this._wins.find(w => w.folderId === folderId && !w._navStack.length);
        if (existing) { existing.bringToFront(); return existing; }
        const win = new FolderWindow(folderId);
        this._wins.push(win);
        return win;
    },

    close(win) {
        this._wins = this._wins.filter(w => w !== win);
        win.el.remove();
    },

    closeAll() {
        this._wins.forEach(w => w.el.remove());
        this._wins = [];
    },

    renderAll() {
        this._wins.forEach(w => w.render());
    },

    nextZ() { return ++this._z; }
};

/* ============================================================
   FOLDER WINDOW  (floating explorer)
   ============================================================ */
class FolderWindow {
    constructor(folderId) {
        this.folderId = folderId;
        this.selection = new Set();
        this._navStack = [];  // for back navigation (not used in default: navigate in window)
        this.el = null;
        this._build();
    }

    /* ---- DOM BUILD ---- */
    _build() {
        const node = VFS.node(this.folderId),
            el = document.createElement('div');
        el.className = 'folder-window';
        el.style.zIndex = WinManager.nextZ();

        // Cascade position
        const area = document.getElementById('desktop-area'),
            count = WinManager._wins.length,
            defW = 680, defH = 440,
            cx = Math.max(20, Math.min((area.clientWidth - defW) / 2 + count * 28, area.clientWidth - defW - 10)),
            cy = Math.max(20, Math.min((area.clientHeight - defH) / 2 + count * 28, area.clientHeight - defH - 10));
        el.style.left = cx + 'px';
        el.style.top = cy + 'px';
        el.style.width = defW + 'px';
        el.style.height = defH + 'px';

        el.innerHTML = `
      <div class="fw-titlebar">
        <div class="fw-drag-area">
          <span class="fw-folder-icon">${getFolderSVG(node.color)}</span>
          <span class="fw-title">${escHtml(node.name)}</span>
        </div>
        <div class="fw-controls">
          <button class="fw-btn fw-btn-navup" title="Go up">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path d="M7 11V3M3 7l4-4 4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="square"/>
            </svg>
          </button>
          <button class="fw-btn fw-btn-close close" title="Close">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <path d="M2 2l8 8M10 2L2 10" stroke="currentColor" stroke-width="1.5" stroke-linecap="square"/>
            </svg>
          </button>
        </div>
      </div>
      <div class="fw-toolbar">
        <button class="btn btn-ghost btn-sm fw-btn-upload">
          <svg width="13" height="13" viewBox="0 0 13 13" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M6.5 8V1M3 4.5l3.5-3.5 3.5 3.5M1 10h11v2H1z" stroke="currentColor" stroke-width="1.4" stroke-linecap="square"/>
          </svg>
          Import
        </button>
        <button class="btn btn-ghost btn-sm fw-btn-newfile">
          <svg width="13" height="13" viewBox="0 0 13 13" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M2 1h6l3 3v8H2z" stroke="currentColor" stroke-width="1.4" stroke-linecap="square"/>
            <path d="M8 1v3h3" stroke="currentColor" stroke-width="1.4" stroke-linecap="square"/>
            <path d="M6.5 6v3M5 7.5h3" stroke="currentColor" stroke-width="1.4" stroke-linecap="square"/>
          </svg>
          New File
        </button>
        <button class="btn btn-ghost btn-sm fw-btn-newfolder">
          <svg width="13" height="13" viewBox="0 0 13 13" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M1 3h4l1.5 2H12v7H1z" stroke="currentColor" stroke-width="1.4" stroke-linecap="square"/>
            <path d="M6.5 6.5v2.5M5.2 7.8h2.6" stroke="currentColor" stroke-width="1.4" stroke-linecap="square"/>
          </svg>
          New Folder
        </button>
        <div class="fw-breadcrumb" id="fw-bc-${this.folderId}"></div>
      </div>
      <div class="fw-area" tabindex="0">
        <div class="fw-canvas"></div>
        <div class="fw-drop-overlay">
          <svg width="36" height="36" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M24 8v24M12 20l12-12 12 12M8 36h32v4H8z" stroke="currentColor" stroke-width="2.5" stroke-linecap="square"/></svg>
          Drop files to import
        </div>
      </div>
      <div class="fw-statusbar">
        <span class="fw-status-text">0 items</span>
      </div>
      <div class="fw-resize-handle"></div>
    `;

        this.el = el;
        area.appendChild(el);
        this._bindEvents();
        this.render();
    }

    /* ---- EVENTS ---- */
    _bindEvents() {
        const el = this.el;
        el.addEventListener('mousedown', () => this.bringToFront(), true);

        // Title bar drag (move window)
        this._makeDraggable(el.querySelector('.fw-drag-area'));

        // Buttons
        el.querySelector('.fw-btn-close').addEventListener('click', e => {
            e.stopPropagation(); WinManager.close(this);
        });
        el.querySelector('.fw-btn-navup').addEventListener('click', e => {
            e.stopPropagation();
            const n = VFS.node(this.folderId);
            if (n && n.parentId && n.parentId !== 'root') { this.folderId = n.parentId; this.selection.clear(); this.render(); }
        });
        el.querySelector('.fw-btn-upload').addEventListener('click', e => {
            e.stopPropagation();
            this._setCtx();
            document.getElementById('file-input').click();
        });
        el.querySelector('.fw-btn-newfile').addEventListener('click', e => {
            e.stopPropagation(); App._ctxScreenPos = null; this._setCtx(); newTextFile();
        });
        el.querySelector('.fw-btn-newfolder').addEventListener('click', e => {
            e.stopPropagation(); App._ctxScreenPos = null; this._setCtx(); newFolder();
        });

        // Content area events
        const area = el.querySelector('.fw-area');
        // Delegated icon events: mousedown, dblclick, contextmenu, touch tap
        _setupAreaDelegation(area, this);
        area.addEventListener('contextmenu', e => {
            if (e.target === area) { e.preventDefault(); e.stopPropagation(); this._contextDesktop(e); }
        });
        area.addEventListener('mousedown', e => {
            if (e.target !== area) return;
            hideCtxMenu();
            area.focus();
            if (!e.ctrlKey && !e.metaKey) {
                this.selection.clear();
                area.querySelectorAll('.file-item.selected').forEach(i => i.classList.remove('selected'));
                this._updateStatus();
            }
            this._startRubberBand(e);
        });
        area.addEventListener('keydown', e => this._onKey(e));
        const fwDropOv = area.querySelector('.fw-drop-overlay');
        let _fwDndHoverFolder = null;
        area.addEventListener('dragover', e => {
            e.preventDefault();
            const folderEl = e.target?.closest?.('.file-item[data-id]'),
                newHover = folderEl && VFS.node(folderEl.dataset.id)?.type === 'folder' ? folderEl.dataset.id : null;
            if (newHover !== _fwDndHoverFolder) {
                if (_fwDndHoverFolder) area.querySelector(`.file-item[data-id="${_fwDndHoverFolder}"]`)?.classList.remove('drag-target');
                _fwDndHoverFolder = newHover;
                if (_fwDndHoverFolder) area.querySelector(`.file-item[data-id="${_fwDndHoverFolder}"]`)?.classList.add('drag-target');
            }
            if (fwDropOv) fwDropOv.classList.toggle('show', !_fwDndHoverFolder);
        });
        area.addEventListener('dragleave', e => {
            if (!area.contains(e.relatedTarget)) {
                if (_fwDndHoverFolder) area.querySelector(`.file-item[data-id="${_fwDndHoverFolder}"]`)?.classList.remove('drag-target');
                _fwDndHoverFolder = null;
                if (fwDropOv) fwDropOv.classList.remove('show');
            }
        });
        area.addEventListener('drop', e => {
            e.preventDefault();
            e.stopPropagation(); // prevent desktop from also receiving this drop
            if (_fwDndHoverFolder) area.querySelector(`.file-item[data-id="${_fwDndHoverFolder}"]`)?.classList.remove('drag-target');
            const targetFolderId = _fwDndHoverFolder || this.folderId;
            _fwDndHoverFolder = null;
            if (fwDropOv) fwDropOv.classList.remove('show');
            App._winCtx = this;
            App.folder = targetFolderId;
            App.selection = this.selection;
            uploadEntries(e.dataTransfer.items, targetFolderId);
        });

        /* ---- Touch: rubber-band select on empty area + long-press context menu ---- */
        _initAreaTouchRubberBand(area, this);

        this._initFwTouchDrag(area);
        this._addResizeHandle();
    }

    /* ---- SET CONTEXT for modal-based and async ops ---- */
    // Clear selection: empties both the Set AND removes .selected CSS classes from DOM
    _clearSelection() {
        this.selection.clear();
        this.el.querySelectorAll('.file-item.selected').forEach(i => i.classList.remove('selected'));
        this._updateStatus();
    }

    _setCtx() {
        App._winCtx = this;
        App.folder = this.folderId;
        App.selection = this.selection;
    }

    /* ---- SET CONTEXT for sync ops (save+restore immediately) ---- */
    _withCtxSync(fn) {
        const pF = App.folder, pS = App.selection, pW = App._winCtx;
        App.folder = this.folderId; App.selection = this.selection; App._winCtx = this;
        try { fn(); } finally { App.folder = pF; App.selection = pS; App._winCtx = pW; }
    }

    /* ---- WINDOW DRAG ---- */
    _makeDraggable(handle) {
        handle.addEventListener('mousedown', e => {
            if (e.button !== 0) return;
            e.preventDefault();
            const startMouseX = e.clientX, startMouseY = e.clientY,
                startLeft = parseInt(this.el.style.left) || 0,
                startTop = parseInt(this.el.style.top) || 0;
            const onMove = mv => {
                const area = document.getElementById('desktop-area'),
                    maxL = area.clientWidth - this.el.offsetWidth,
                    maxT = area.clientHeight - this.el.offsetHeight;
                this.el.style.left = Math.max(0, Math.min(maxL, startLeft + mv.clientX - startMouseX)) + 'px';
                this.el.style.top = Math.max(0, Math.min(maxT, startTop + mv.clientY - startMouseY)) + 'px';
            };
            const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        });
    }

    bringToFront() { this.el.style.zIndex = WinManager.nextZ(); }

    /* ---- RENDER ---- */
    render() {
        const node = VFS.node(this.folderId);
        if (!node) { WinManager.close(this); return; }

        // Update title — full path
        this.el.querySelector('.fw-title').textContent = VFS.fullPath(this.folderId);
        // Hide navup button when at top-level folder (parent is root)
        const _navB = this.el.querySelector('.fw-btn-navup');
        if (_navB) _navB.style.display = (node.parentId && node.parentId !== 'root') ? '' : 'none';
        // Update title bar folder icon (reflects current color)
        const _folderIconEl = this.el.querySelector('.fw-folder-icon');
        if (_folderIconEl) _folderIconEl.innerHTML = getFolderSVG(node.color);

        // Update breadcrumb inside toolbar
        const bcId = `fw-bc-${this.el.querySelector('.fw-breadcrumb').id.replace('fw-bc-', '')}`,
            bc = this.el.querySelector('.fw-breadcrumb');
        bc.innerHTML = '';
        VFS.breadcrumb(this.folderId).forEach((n, i, arr) => {
            if (i === 0) return; // skip root
            const sp = document.createElement('span');
            sp.className = 'fw-bc-item' + (i === arr.length - 1 ? ' current' : '');
            sp.textContent = n.name;
            if (i < arr.length - 1) sp.addEventListener('click', () => { this.folderId = n.id; this.selection.clear(); this.render(); });
            bc.appendChild(sp);
            if (i < arr.length - 1) { const s = document.createElement('span'); s.className = 'fw-bc-sep'; s.textContent = ' › '; bc.appendChild(s); }
        });

        // Render icons — incremental when same folder to avoid flash, full rebuild on navigation
        const area = this.el.querySelector('.fw-area'),
            folderChanged = this._renderedFolderId !== this.folderId;
        this._renderedFolderId = this.folderId;
        _renderIconArea(area, this.folderId, this.selection, () => this._updateStatus(), folderChanged);
    }

    /* ---- ICON DRAG (within window + escape to desktop/other windows) ---- */
    _onIconMousedown(e, el, node) {
        if (e.button !== 0) return;
        hideCtxMenu();
        _startIconDrag(e, node, el, {
            area: this.el.querySelector('.fw-area'),
            folderId: this.folderId,
            selection: this.selection,
            winEl: this.el,
            updateUI: () => this._updateStatus(),
            clearAll: () => {
                this.selection.clear();
                this.el.querySelectorAll('.fw-area > .file-item.selected').forEach(i => i.classList.remove('selected'));
            },
        });
    }

    /* ---- OPEN NODE: default = navigate within window ---- */
    _openNode(node) {
        hideCtxMenu();
        if (node.type === 'folder') {
            // Auto-cancel cut if navigating into a cut folder
            if (App.clipboard?.op === 'cut') {
                const cutIds = new Set(App.clipboard.ids);
                let cur = node.id;
                while (cur && cur !== 'root') {
                    if (cutIds.has(cur)) { cancelClipboard(); break; }
                    cur = (VFS.node(cur) || {}).parentId;
                }
            }
            this.folderId = node.id; this.selection.clear(); this.render();
        } else {
            openFile(node);
        }
    }

    /* ---- TOUCH DRAG for mobile (inside folder window) ---- */
    _initFwTouchDrag(area) {
        _initTouchDragCommon(area, this, { showSnap: true });
    }

    /* ---- RUBBER BAND selection ---- */
    _startRubberBand(e) {
        _rubberBandSelect(e, this.el.querySelector('.fw-area'), this.selection, () => this._updateStatus());
    }

    /* ---- CONTEXT MENUS ---- */
    _contextDesktop(e) {
        this.selection.clear();
        this.el.querySelectorAll('.file-item.selected').forEach(i => i.classList.remove('selected'));
        this._updateStatus();
        const syncFn = () => this._setCtx();
        showCtxMenu(e.clientX, e.clientY, _buildAreaMenuItems(e, syncFn, this,
            () => { this._renderedFolderId = null; this.render(); }));
    }

    _contextIcon(e, node) {
        if (!e.ctrlKey && !e.metaKey && !this.selection.has(node.id)) {
            this.selection.clear();
            this.el.querySelectorAll('.file-item.selected').forEach(i => i.classList.remove('selected'));
        }
        this.selection.add(node.id);
        this.el.querySelector(`.file-item[data-id="${node.id}"]`)?.classList.add('selected');
        this._updateStatus();
        showCtxMenu(e.clientX, e.clientY, _buildIconMenuItems(node, this.selection, {
            openFn: n => n.type === 'folder' ? this._openNode(n) : openFile(n),
            colorCb: () => this.render(),
            hasCopy: false,
            copyFn: null,
            cutFn: () => this._withCtxSync(() => cutItems()),
            exportZipFn: () => this._withCtxSync(() => exportAsZip([...this.selection])),
            deleteFn: () => { this._setCtx(); deleteSelected(); },
        }));
    }

    /* ---- RESIZE HANDLE ---- */
    _addResizeHandle() {
        const handle = this.el.querySelector('.fw-resize-handle');
        if (!handle) return;
        handle.addEventListener('mousedown', e => {
            if (e.button !== 0) return;
            e.preventDefault(); e.stopPropagation();
            const startX = e.clientX, startY = e.clientY,
                startW = this.el.offsetWidth, startH = this.el.offsetHeight;
            const onMove = mv => {
                this.el.style.width = Math.max(420, Math.min(1400, startW + mv.clientX - startX)) + 'px';
                this.el.style.height = Math.max(260, Math.min(900, startH + mv.clientY - startY)) + 'px';
            };
            const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        });
    }

    /* ---- STATUS BAR & KEYBOARD ---- */
    _updateStatus() {
        const count = VFS.children(this.folderId).length,
            sel = this.selection.size;
        this.el.querySelector('.fw-status-text').textContent =
            sel > 0 ? `${sel} of ${count} selected` : `${count} item${count !== 1 ? 's' : ''}`;
    }

    _onKey(e) {
        _handleKey(e, this, () => this._setCtx(), fn => this._withCtxSync(fn), {
            area: this.el,
            refresh: () => { this.render(); this.el.querySelector('.fw-area')?.focus(); },
            extraKeys: ev => {
                if (ev.key === 'Backspace' && !ev.ctrlKey && !ev.metaKey) {
                    const n = VFS.node(this.folderId);
                    if (n && n.parentId && n.parentId !== 'root') { this.folderId = n.parentId; this.selection.clear(); this.render(); }
                    return true;
                }
            },
        });
    }
}
