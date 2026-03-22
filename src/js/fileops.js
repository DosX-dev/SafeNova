'use strict';

/* ============================================================
   FILENAME SANITIZATION
   ============================================================ */
function sanitizeFilename(name) {
    // Strip null bytes, path separators, HTML/XML special chars, and prevent . / .. as names
    const s = (name || 'unnamed')
        .replace(/[\x00-\x1f\\/]/g, '_')
        .replace(/[<>&"']/g, '_')
        .trim();
    return /^\.{1,2}$/.test(s) || s === '' ? 'unnamed' : s;
}

/* ============================================================
   UPLOAD FILES  (from OS drag-drop or file picker — flat list)
   ============================================================ */
async function uploadFiles(files) {
    if (!App.key || !App.container) return;
    if (!files || !files.length) return;

    // Container size check
    const remaining = CONTAINER_LIMIT - VFS.totalSize();
    let totalNew = 0;
    for (const f of files) totalNew += f.size;
    if (totalNew > remaining) {
        toast(`Not enough space in container. Need ${fmtSize(totalNew)}, have ${fmtSize(remaining)}`, 'error');
        return;
    }

    // Device storage check
    const spCheck = await checkStorageSpace(totalNew * 1.1); // +10% for encryption overhead
    if (!spCheck.ok) {
        toast(
            `Not enough device storage. Need ~${fmtSize(totalNew)}, only ${fmtSize(spCheck.available)} free.`,
            'error'
        );
        return;
    }

    showLoading(`Encrypting ${files.length} file${files.length > 1 ? 's' : ''}...`);
    let ok = 0, _okIds = [];
    const fileArr = Array.from(files);
    const BATCH = _CRYPTO_CONCURRENCY;
    for (let i = 0; i < fileArr.length; i += BATCH) {
        const batch = fileArr.slice(i, i + BATCH);
        // Read all file buffers in this batch concurrently before encrypting
        const bufs = await Promise.all(batch.map(f => f.arrayBuffer()));
        const results = await Promise.allSettled(batch.map(async (f, bi) => {
            const name = sanitizeFilename(f.name),
                mime = f.type || getMime(name),
                { iv, blob } = await Crypto.encryptBin(App.key, bufs[bi]),
                nodeId = uid();
            VFS.add({
                id: nodeId, type: 'file', name, mime, size: f.size,
                parentId: App.folder, ctime: Date.now(), mtime: Date.now()
            });
            return { nodeId, rec: { id: nodeId, cid: App.container.id, iv: Array.from(iv), blob } };
        }));
        // Batch-save all encrypted records in a single IDB transaction
        const recs = [];
        for (let j = 0; j < results.length; j++) {
            if (results[j].status === 'fulfilled') {
                ok++;
                _okIds.push(results[j].value.nodeId);
                recs.push(results[j].value.rec);
            } else {
                console.error('upload error', batch[j].name, results[j].reason);
                toast('Failed to encrypt: ' + batch[j].name, 'error');
            }
        }
        if (recs.length) await DB.saveFiles(recs);
        showLoading(`Encrypting... ${Math.min(i + BATCH, fileArr.length)}/${fileArr.length}`);
    }
    await saveVFS();
    Desktop._patchIcons();
    hideLoading();
    if (ok > 0) {
        toast(`${ok} file${ok > 1 ? 's' : ''} imported`, 'success');
        logActivity('upload', ok === 1 ? files[0].name : `${ok} files`, ok, ok === 1 && _okIds[0] ? VFS.fullPath(_okIds[0]) : null);
    }
}

/* ============================================================
   UPLOAD ENTRIES  (from OS drag-drop — supports folders)
   Handles DataTransferItemList containing files AND directories.
   ============================================================ */

// Read all entries from a FileSystemDirectoryReader.
// The API only returns up to 100 entries per call — must batch until empty.
function _readAllEntries(reader) {
    return new Promise(resolve => {
        const results = [];
        function batch() {
            reader.readEntries(entries => {
                if (!entries.length) { resolve(results); return; }
                results.push(...entries);
                batch();
            }, () => resolve(results)); // on error, return what we have
        }
        batch();
    });
}

// Encrypt a single FileSystemFileEntry and add it to the VFS under targetFolderId.
async function _uploadFileEntry(fileEntry, targetFolderId) {
    const file = await new Promise((res, rej) => fileEntry.file(res, rej));
    const name = sanitizeFilename(file.name);
    if (VFS.hasChildNamed(targetFolderId, name)) {
        toast(`"${name}" already exists — skipped`, 'warn');
        return false;
    }
    const buf = await file.arrayBuffer(),
        mime = file.type || getMime(name),
        { iv, blob } = await Crypto.encryptBin(App.key, buf),
        nodeId = uid(), now = Date.now();
    VFS.add({
        id: nodeId, type: 'file', name, mime, size: file.size,
        parentId: targetFolderId, ctime: now, mtime: now
    });
    await DB.saveFile({ id: nodeId, cid: App.container.id, iv: Array.from(iv), blob });
    return true;
}

// Recursively upload a FileSystemDirectoryEntry into the VFS under targetFolderId.
async function _uploadDirEntry(dirEntry, targetFolderId, depth) {
    if (depth > 32) { toast('Folder nesting too deep — stopped at 32 levels', 'warn'); return false; }
    const name = sanitizeFilename(dirEntry.name);
    if (VFS.hasChildNamed(targetFolderId, name)) {
        toast(`Folder "${name}" already exists — skipped`, 'warn');
        return false;
    }
    const folderId = uid(), now = Date.now();
    VFS.add({ id: folderId, type: 'folder', name, parentId: targetFolderId, ctime: now, mtime: now });
    const entries = await _readAllEntries(dirEntry.createReader());
    const fileEntries = entries.filter(e => e.isFile);
    const subDirEntries = entries.filter(e => e.isDirectory);
    // Encrypt files in this directory in parallel batches
    const BATCH = _CRYPTO_CONCURRENCY;
    for (let i = 0; i < fileEntries.length; i += BATCH) {
        await Promise.allSettled(
            fileEntries.slice(i, i + BATCH).map(e => _uploadFileEntry(e, folderId))
        );
    }
    // Recurse into subdirectories sequentially
    for (const subDir of subDirEntries) {
        await _uploadDirEntry(subDir, folderId, depth + 1);
    }
    return true;
}

// Main drop entry point for desktop and folder-window drop events.
// Accepts DataTransferItemList (supports both files and folders).
async function uploadEntries(dataTransferItems, targetFolderId) {
    if (!App.key || !App.container) return;
    const itemArr = Array.from(dataTransferItems || []);
    if (!itemArr.length) return;

    const entries = itemArr.map(i => i.webkitGetAsEntry?.()).filter(Boolean);
    if (!entries.length) {
        // Fallback: no Entry API support — treat all as flat files
        const files = itemArr.map(i => i.getAsFile?.()).filter(Boolean);
        if (files.length) await uploadFiles(files);
        return;
    }

    const fileEntries = entries.filter(e => e.isFile),
        folderEntries = entries.filter(e => e.isDirectory);
    const label = [
        fileEntries.length && `${fileEntries.length} file${fileEntries.length !== 1 ? 's' : ''}`,
        folderEntries.length && `${folderEntries.length} folder${folderEntries.length !== 1 ? 's' : ''}`,
    ].filter(Boolean).join(' and ');

    showLoading(`Encrypting ${label}…`);
    let ok = 0;
    for (const entry of entries) {
        try {
            const added = entry.isDirectory
                ? await _uploadDirEntry(entry, targetFolderId, 0)
                : await _uploadFileEntry(entry, targetFolderId);
            if (added) ok++;
        } catch (err) {
            console.error('upload entry error', entry.name, err);
            toast(`Failed to import: ${entry.name}`, 'error');
        }
    }
    await saveVFS();
    Desktop._patchIcons();
    if (typeof WinManager !== 'undefined') WinManager.renderAll();
    hideLoading();
    if (ok > 0) {
        toast(`${ok} item${ok !== 1 ? 's' : ''} imported`, 'success');
        {
            const _sn = ok === 1 ? VFS.children(targetFolderId).find(n => n.name === sanitizeFilename(entries[0]?.name || '')) : null;
            logActivity('upload', ok === 1 ? (entries[0]?.name ?? '1 item') : `${ok} items`, ok, _sn ? VFS.fullPath(_sn.id) : null);
        }
    }
}

/* ============================================================
   OPEN / DOWNLOAD FILE
   ============================================================ */
async function openFile(node) {
    if (!App.key || !App.container) return;
    showLoading('Decrypting file...');
    try {
        const rec = await DB.getFile(node.id);
        if (!rec) { toast('File data not found', 'error'); hideLoading(); return; }
        const mime = node.mime || getMime(node.name);
        let buf;
        // Empty file: blob may be missing or decrypt may fail for 0-byte content
        if (!rec.blob || (rec.blob instanceof ArrayBuffer && rec.blob.byteLength === 0)) {
            buf = new ArrayBuffer(0);
        } else {
            buf = await Crypto.decryptBin(App.key, rec.iv, rec.blob);
        }
        hideLoading();

        if (isText(mime, node.name)) {
            openEditor(node, buf);
        } else if (isImage(mime) || isAudio(mime) || isVideo(mime) || isPDF(mime)) {
            openViewer(node, buf, mime);
        } else {
            _confirmExport(node, buf, mime);
        }
    } catch (e) { hideLoading(); toast('Decryption failed: ' + e.message, 'error'); console.error(e); }
}

async function downloadFile(node) {
    if (!App.key || !App.container) return;
    showLoading('Decrypting...');
    try {
        const rec = await DB.getFile(node.id);
        if (!rec) { toast('File data not found', 'error'); hideLoading(); return; }
        const buf = await Crypto.decryptBin(App.key, rec.iv, rec.blob);
        downloadBuf(buf, node.name, node.mime || getMime(node.name));
        toast('Exported: ' + node.name, 'success');
        logActivity('download', node.name, 1, VFS.fullPath(node.id));
    } catch (e) { toast('Decryption failed: ' + e.message, 'error'); }
    hideLoading();
}

function downloadBuf(buf, name, mime) {
    const blob = new Blob([buf], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function _confirmExport(node, buf, mime) {
    const fnEl = document.getElementById('ec-filename');
    if (fnEl) fnEl.textContent = node.name;
    Overlay.show('modal-export-confirm');
    document.getElementById('ec-ok').onclick = () => {
        Overlay.hide();
        downloadBuf(buf, node.name, mime);
        toast('Exported: ' + node.name, 'success');
        logActivity('download', node.name, 1, VFS.fullPath(node.id));
    };
}

/* ============================================================
   DELETE SELECTED
   ============================================================ */
async function deleteSelected() {
    if (!App.selection.size) return;
    const selRef = App.selection;           // capture the active selection Set at call time
    const ids = [...selRef];

    // Prevent deleting folders currently open in Explorer windows
    const blocked = _openFolderGuard(ids);
    if (blocked) {
        toast(`"${VFS.node(blocked)?.name}" is open in Explorer — close the window first`, 'error');
        return;
    }

    const names = ids.map(id => VFS.node(id)?.name || '').filter(Boolean);
    const msg = ids.length === 1
        ? `Delete "${names[0]}"? This action cannot be undone.`
        : `Delete ${ids.length} items? This action cannot be undone.`;

    document.getElementById('delete-msg').textContent = msg;
    Overlay.show('modal-delete');
    document.getElementById('delete-ok').onclick = async () => {
        Overlay.hide();
        showLoading('Deleting...');
        const allFileIds = [];
        for (const id of ids) {
            const n = VFS.node(id); if (!n) continue;
            if (n.type === 'file') {
                allFileIds.push(id);
            } else {
                const _walkSeen = new Set();
                const walk = fid => {
                    if (_walkSeen.has(fid)) return;
                    _walkSeen.add(fid);
                    VFS.children(fid).forEach(c => { if (c.type === 'file') allFileIds.push(c.id); else walk(c.id); });
                };
                walk(id);
            }
        }
        if (allFileIds.length) await DB.deleteFiles(allFileIds).catch(() => {});
        allFileIds.forEach(fid => { delete App.thumbCache[fid]; });
        const _delSinglePath = ids.length === 1 ? VFS.fullPath(ids[0]) : null;
        for (const id of ids) VFS.remove(id);
        selRef.clear();
        await saveVFS();
        Desktop._patchIcons();
        if (typeof WinManager !== 'undefined') WinManager.renderAll();
        hideLoading();
        toast('Deleted', 'info');
        logActivity('delete', ids.length === 1 ? names[0] : `${ids.length} items`, ids.length, _delSinglePath);
    };
}

/* ============================================================
   NEW TEXT FILE  —  BUG FIX: just creates the file, does NOT open editor
   ============================================================ */
function newTextFile() {
    const targetFolder = App.folder;
    let name = 'Document.txt';
    if (VFS.hasChildNamed(targetFolder, name)) {
        let i = 2;
        while (VFS.hasChildNamed(targetFolder, `Document (${i}).txt`)) i++;
        name = `Document (${i}).txt`;
    }
    document.getElementById('nf-name').value = name;
    Overlay.show('modal-new-text');
    setTimeout(() => {
        const inp = document.getElementById('nf-name');
        inp.focus();
        const dot = name.lastIndexOf('.');
        if (dot > 0) inp.setSelectionRange(0, dot); else inp.select();
    }, 100);
}

async function createTextFile() {
    const name = sanitizeFilename(document.getElementById('nf-name').value.trim());
    if (!name || name === 'unnamed') { toast('Enter a valid file name', 'error'); return; }
    // Capture context BEFORE Overlay.hide() clears it
    const targetFolder = App.folder,
        winCtx = App._winCtx;
    // Duplicate name check
    if (VFS.hasChildNamed(targetFolder, name)) {
        toast(`“${name}” already exists in this folder`, 'error'); return;
    }
    Overlay.hide();

    const nodeId = uid();
    const mime = getMime(name);
    const emptyBuf = new ArrayBuffer(0);
    const { iv, blob } = await Crypto.encryptBin(App.key, emptyBuf);
    VFS.add({
        id: nodeId, type: 'file', name, mime, size: 0,
        parentId: targetFolder, ctime: Date.now(), mtime: Date.now()
    });
    // Position at context menu cursor if available
    if (App._ctxScreenPos) {
        const area2 = winCtx ? winCtx.el.querySelector('.fw-area') : document.getElementById('desktop-area');
        const rect2 = area2.getBoundingClientRect();
        const rawX = App._ctxScreenPos.x - rect2.left + area2.scrollLeft;
        const rawY = App._ctxScreenPos.y - rect2.top + area2.scrollTop;
        const occ = new Map();
        VFS.children(targetFolder).forEach(n => {
            if (n.id === nodeId) return;
            const p = VFS.getPos(targetFolder, n.id);
            if (p) occ.set(`${Math.round((p.x - 8) / GRID_X)}_${Math.round((p.y - 8) / GRID_Y)}`, n.id);
        });
        const snapped = _snapFreeCell(rawX, rawY, occ);
        VFS.setPos(targetFolder, nodeId, snapped.x, snapped.y);
        App._ctxScreenPos = null;
    }
    await DB.saveFile({ id: nodeId, cid: App.container.id, iv: Array.from(iv), blob });
    await saveVFS();
    if (winCtx) winCtx.render(); else Desktop._patchIcons();
    toast(`File “${name}” created`, 'success');
    logActivity('create-file', name, 1, VFS.fullPath(nodeId));
}

/* ============================================================
   NEW FOLDER
   ============================================================ */
function newFolder() {
    const targetFolder = App.folder;
    let name = 'New Folder';
    if (VFS.hasChildNamed(targetFolder, name)) {
        let i = 2;
        while (VFS.hasChildNamed(targetFolder, `New Folder (${i})`)) i++;
        name = `New Folder (${i})`;
    }
    document.getElementById('nd-name').value = name;
    Overlay.show('modal-new-folder');
    setTimeout(() => {
        const inp = document.getElementById('nd-name');
        inp.focus(); inp.select();
    }, 100);
}

async function createFolder() {
    const name = sanitizeFilename(document.getElementById('nd-name').value.trim());
    if (!name || name === 'unnamed') { toast('Enter a valid folder name', 'error'); return; }
    // Capture context BEFORE Overlay.hide() clears it
    const targetFolder = App.folder,
        winCtx = App._winCtx;
    // Duplicate name check
    if (VFS.hasChildNamed(targetFolder, name)) {
        toast(`“${name}” already exists in this folder`, 'error'); return;
    }
    Overlay.hide();
    const nodeId = uid();
    VFS.add({ id: nodeId, type: 'folder', name, parentId: targetFolder, ctime: Date.now(), mtime: Date.now() });
    // Position at context menu cursor if available
    if (App._ctxScreenPos) {
        const area2 = winCtx ? winCtx.el.querySelector('.fw-area') : document.getElementById('desktop-area');
        const rect2 = area2.getBoundingClientRect();
        const rawX = App._ctxScreenPos.x - rect2.left + area2.scrollLeft;
        const rawY = App._ctxScreenPos.y - rect2.top + area2.scrollTop;
        const occ = new Map();
        VFS.children(targetFolder).forEach(n => {
            if (n.id === nodeId) return;
            const p = VFS.getPos(targetFolder, n.id);
            if (p) occ.set(`${Math.round((p.x - 8) / GRID_X)}_${Math.round((p.y - 8) / GRID_Y)}`, n.id);
        });
        const snapped = _snapFreeCell(rawX, rawY, occ);
        VFS.setPos(targetFolder, nodeId, snapped.x, snapped.y);
        App._ctxScreenPos = null;
    }
    await saveVFS();
    if (winCtx) winCtx.render(); else Desktop._patchIcons();
    toast(`Folder "${name}" created`, 'success');
    logActivity('create-folder', name, 1, VFS.fullPath(nodeId));
}

/* ============================================================
   RENAME
   ============================================================ */
function renameNode(node) {
    if (!node) return;

    // Prevent renaming folders currently open in Explorer windows
    if (node.type === 'folder') {
        const blocked = _openFolderGuard([node.id]);
        if (blocked) {
        toast(`“${node.name}” is open in Explorer — close the window first`, 'error');
            return;
        }
    }

    document.getElementById('rename-input').value = node.name;
    const capturedWinCtx = App._winCtx;
    Overlay.show('modal-rename');
    setTimeout(() => {
        const i = document.getElementById('rename-input');
        i.focus();
        const dot = i.value.lastIndexOf('.');
        if (dot > 0) i.setSelectionRange(0, dot); else i.select();
    }, 100);
    document.getElementById('rename-ok').onclick = async () => {
        const newName = sanitizeFilename(document.getElementById('rename-input').value.trim());
        if (!newName || newName === 'unnamed') { toast('Enter a valid name', 'error'); return; }
        // Duplicate check (ignore if same name, case-insensitive)
        const pid = VFS.node(node.id)?.parentId;
        if (pid && newName.toLowerCase() !== node.name.toLowerCase() && VFS.hasChildNamed(pid, newName)) {
            toast(`“${newName}” already exists in this folder`, 'error'); return;
        }
        Overlay.hide();
        const _oldName = node.name;
        VFS.rename(node.id, newName);
        await saveVFS();
        if (capturedWinCtx) capturedWinCtx.render(); else Desktop._patchIcons();
        logActivity('rename', `${_oldName} → ${newName}`, 1, VFS.fullPath(node.id));
    };
}

/* ============================================================
   COPY / CUT / PASTE
   ============================================================ */
function copyItems() {
    App.clipboard = { op: 'copy', ids: [...App.selection] };
    toast(`${App.clipboard.ids.length} item(s) copied`, 'info');
    logActivity('copy', App.clipboard.ids.length === 1 ? (VFS.node(App.clipboard.ids[0])?.name ?? '1 item') : `${App.clipboard.ids.length} items`, App.clipboard.ids.length, App.clipboard.ids.length === 1 ? VFS.fullPath(App.clipboard.ids[0]) : null);
}
function cutItems() {
    // Prevent cutting folders currently open in Explorer windows
    const blocked = _openFolderGuard(App.selection);
    if (blocked) {
        toast(`“${VFS.node(blocked)?.name}” is open in Explorer — close the window first`, 'error');
        return;
    }

    App.clipboard = { op: 'cut', ids: [...App.selection] };
    toast(`${App.clipboard.ids.length} item(s) cut`, 'info');
    logActivity('cut', App.clipboard.ids.length === 1 ? (VFS.node(App.clipboard.ids[0])?.name ?? '1 item') : `${App.clipboard.ids.length} items`, App.clipboard.ids.length, App.clipboard.ids.length === 1 ? VFS.fullPath(App.clipboard.ids[0]) : null);
    _applyCutStyles();
}

function _dedupName(folderId, name) {
    const dot = name.lastIndexOf('.');
    const hasExt = dot > 0;
    const base = hasExt ? name.slice(0, dot) : name;
    const ext = hasExt ? name.slice(dot) : '';
    let i = 2;
    while (VFS.hasChildNamed(folderId, `${base} (${i})${ext}`)) i++;
    return `${base} (${i})${ext}`;
}

async function pasteItems() {
    if (!App.clipboard) return;
    const { op, ids } = App.clipboard;

    // Prevent pasting a cut folder if it's currently open in Explorer windows
    if (op === 'cut') {
        const blocked = _openFolderGuard(ids);
        if (blocked) {
        toast(`“${VFS.node(blocked)?.name}” is open in Explorer — close the window first`, 'error');
            // Abort the entire paste operation to prevent partial moves
            return;
        }
    }

    let _pastedSn = null;
    for (const id of ids) {
        const n = VFS.node(id); if (!n) continue;
        if (op === 'cut') {
            if (n.parentId === App.folder) continue;
            const result = VFS.move(id, App.folder);
            if (result === 'duplicate') { toast(`"${n.name}" already exists in this folder`, 'error'); continue; }
            if (result === 'cycle') { toast(`Cannot paste "${n.name}" into itself or a subfolder`, 'error'); continue; }
            _pastedSn = n.name;
        } else {
            let name = n.name;
            if (VFS.hasChildNamed(App.folder, name)) name = _dedupName(App.folder, name);
            await deepCopy(id, App.folder, name !== n.name ? name : undefined);
            _pastedSn = name;
        }
    }
    if (op === 'cut') App.clipboard = null;
    _applyCutStyles();
    await saveVFS();
    // Refresh all open views so both source and target folders update
    Desktop._patchIcons();
    if (typeof WinManager !== 'undefined') WinManager.renderAll();
    const _destName = VFS.node(App.folder)?.name || 'Desktop';
    const _pastedFp = ids.length === 1 && _pastedSn ? VFS.fullPath(App.folder) : null;
    logActivity('paste', ids.length === 1 ? `${_pastedSn ?? VFS.node(ids[0])?.name ?? '1 item'} → ${_destName}` : `${ids.length} items → ${_destName}`, ids.length, _pastedFp && _pastedFp !== '/' ? _pastedFp + '/' + _pastedSn : null);
}

async function deepCopy(nodeId, newParent, newName, _depth = 0) {
    if (_depth > 64 || nodeId === 'root') return;
    const n = VFS.node(nodeId); if (!n) return;
    const newId = uid();
    const name = newName || n.name;
    if (n.type === 'file') {
        VFS.add({ ...n, id: newId, name, parentId: newParent, ctime: Date.now(), mtime: Date.now() });
        const rec = await DB.getFile(nodeId);
        if (rec) await DB.saveFile({ ...rec, id: newId, cid: App.container.id });
    } else {
        VFS.add({ ...n, id: newId, name, parentId: newParent, ctime: Date.now(), mtime: Date.now() });
        for (const child of VFS.children(nodeId)) await deepCopy(child.id, newId, undefined, _depth + 1);
    }
}

/* ============================================================
   SELECT ALL / SORT
   ============================================================ */
function selectAll() {
    VFS.children(App.folder).forEach(n => {
        App.selection.add(n.id);
        // Look in both main desktop and any folder windows
        const el = document.querySelector(`.file-item[data-id="${n.id}"]`);
        if (el) el.classList.add('selected');
    });
    if (App._winCtx) App._winCtx._updateStatus();
    else if (typeof Desktop !== 'undefined') Desktop._updateSelectionBar();
}

function sortIcons(by = 'name', dir = 'asc', winCtx = null) {
    const fid = winCtx ? winCtx.folderId : Desktop._desktopFolder;
    const area = winCtx ? winCtx.el.querySelector('.fw-area') : document.getElementById('desktop-area');
    const items = VFS.children(fid);
    items.sort((a, b) => {
        // Folders always come first
        if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
        let va, vb;
        switch (by) {
            case 'mtime': va = a.mtime || 0; vb = b.mtime || 0; break;
            case 'ctime': va = a.ctime || 0; vb = b.ctime || 0; break;
            case 'size': va = a.size || 0; vb = b.size || 0; break;
            case 'type': va = getExt(a.name) || ''; vb = getExt(b.name) || ''; break;
            default: va = a.name.toLowerCase(); vb = b.name.toLowerCase();
        }
        const cmp = va < vb ? -1 : va > vb ? 1 : 0;
        return dir === 'desc' ? -cmp : cmp;
    });
    // Compute sequential grid positions directly (don't use autoPos which sees old positions as occupied)
    const W = (area && area.clientWidth) || 800,
        cols = Math.max(1, Math.floor((W - 16) / GRID_X));
    items.forEach((n, i) => {
        const col = i % cols, row = Math.floor(i / cols);
        const x = 8 + col * GRID_X, y = 8 + row * GRID_Y;
        VFS.setPos(fid, n.id, x, y);
        const el = area._iconMap?.get(n.id) ?? area.querySelector(`.file-item[data-id="${n.id}"]`);
        if (el) {
            el.style.transition = 'left 0.12s ease, top 0.12s ease';
            el.style.left = x + 'px'; el.style.top = y + 'px';
            setTimeout(() => { if (el.parentNode) el.style.transition = ''; }, 150);
        }
    });
    saveVFS();
    logActivity('sort', `by ${by} (${dir})`);
}

/* ============================================================
   CAN EDIT AS PLAIN TEXT  (whitelist of text-ish types)
   ============================================================ */
function canEditAsText(node) {
    if (node.type === 'folder') return false;
    const mime = node.mime || getMime(node.name);
    if (mime.startsWith('text/')) return true;
    if (['application/json', 'application/xml', 'application/javascript',
        'application/x-yaml', 'application/sql'].includes(mime)) return true;
    const ext = getExt(node.name).toLowerCase();
    return ['txt', 'md', 'log', 'logs', 'conf', 'config', 'cfg', 'ini', 'env',
        'sh', 'bash', 'zsh', 'fish', 'bat', 'cmd', 'ps1',
        'js', 'ts', 'jsx', 'tsx', 'mjs', 'cjs',
        'py', 'pyw', 'rb', 'php', 'phps',
        'java', 'c', 'cpp', 'cc', 'cxx', 'h', 'hpp',
        'cs', 'fs', 'fsx', 'vb',
        'go', 'rs', 'swift', 'kt', 'kts', 'groovy', 'scala',
        'lua', 'pl', 'r', 'sql', 'graphql', 'gql',
        'json', 'xml', 'yaml', 'yml', 'toml', 'csv', 'tsv',
        'html', 'htm', 'css', 'scss', 'sass', 'less',
        'vue', 'svelte', 'astro',
        'dockerfile', 'makefile', 'cmake',
        'gitignore', 'gitattributes', 'editorconfig',
        'prettierrc', 'eslintrc', 'babelrc'].includes(ext);
}

/* ============================================================
   OPEN FILE AS PLAIN TEXT  (force text editor, any file type)
   ============================================================ */
async function openFileAsText(node) {
    if (!App.key || !App.container) return;
    showLoading('Decrypting file...');
    const TIMEOUT_MS = 5000;
    try {
        const rec = await DB.getFile(node.id);
        if (!rec) { toast('File data not found', 'error'); hideLoading(); return; }
        let buf;
        if (!rec.blob || (rec.blob instanceof ArrayBuffer && rec.blob.byteLength === 0)) {
            buf = new ArrayBuffer(0);
        } else {
            const decryptPromise = Crypto.decryptBin(App.key, rec.iv, rec.blob);
            const timeoutPromise = new Promise((_, reject) =>
                setTimeout(() => reject(new Error('timeout')), TIMEOUT_MS)
            );
            buf = await Promise.race([decryptPromise, timeoutPromise]);
        }
        hideLoading();
        openEditor(node, buf);
    } catch (e) {
        hideLoading();
        if (e.message === 'timeout') {
            toast('Operation timed out after 5 seconds', 'warn');
        } else {
            toast('Decryption failed: ' + e.message, 'error');
        }
    }
}

/* ============================================================
   FOLDER SIZE  (recursive sum of all file descendants)
   ============================================================ */
function _folderSize(folderId, _visited = new Set()) {
    if (_visited.has(folderId)) return 0;
    _visited.add(folderId);
    let size = 0;
    VFS.children(folderId).forEach(n => {
        size += n.type === 'file' ? (n.size || 0) : _folderSize(n.id, _visited);
    });
    return size;
}

/* ============================================================
   PROPERTIES
   ============================================================ */
function showProps(node) {
    const body = document.getElementById('props-body');
    const icon = node.type === 'folder' ? getFolderSVG(node.color) : getFileIconSVG(node.mime || getMime(node.name), node.name);
    const folderSz = node.type === 'folder' ? _folderSize(node.id) : null;
    body.innerHTML = `
    <div class="props-icon">${icon}</div>
    <table class="props-table">
      <tr><td>Name</td><td>${escHtml(node.name)}</td></tr>
      <tr><td>Path</td><td>${escHtml(VFS.fullPath(node.id))}</td></tr>
      <tr><td>Type</td><td>${escHtml(node.type === 'folder' ? 'Folder' : (node.mime || getMime(node.name)))}</td></tr>
      ${node.size != null ? `<tr><td>Size</td><td>${fmtSize(node.size)}</td></tr>` : ''}
      ${folderSz !== null ? `<tr><td>Size</td><td>${fmtSize(folderSz)}</td></tr>` : ''}
      <tr><td>Created</td><td>${fmtDate(node.ctime)}</td></tr>
      <tr><td>Modified</td><td>${fmtDate(node.mtime)}</td></tr>
      ${node.type === 'folder' ? `<tr><td>Items</td><td>${VFS.children(node.id).length}</td></tr>` : ''}
      <tr><td>Encrypted</td><td style="color:var(--accent)">AES-256-GCM ✓</td></tr>
    </table>
  `;
    Overlay.show('modal-props');
}

/* ============================================================
   TEXT EDITOR
   ============================================================ */
let _editorNode = null;
let _editorOriginal = '';

function openEditor(node, buf) {
    _editorNode = node;
    const raw = new TextDecoder().decode(buf);
    // Normalize line endings to \n to match what <textarea> returns
    const text = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    _editorOriginal = text;
    const ta = document.getElementById('editor-textarea');
    ta.value = text;
    document.getElementById('editor-title').textContent = node.name;
    // Word wrap toggle
    const wrapBtn = document.getElementById('btn-wordwrap');
    wrapBtn.classList.toggle('active', ta.classList.contains('word-wrap'));
    wrapBtn.onclick = () => {
        ta.classList.toggle('word-wrap');
        wrapBtn.classList.toggle('active', ta.classList.contains('word-wrap'));
    };
    ta.oninput = () => {
        document.getElementById('editor-meta-chars').textContent = ta.value.length + ' chars';
        document.getElementById('editor-meta-lines').textContent = ta.value.split('\n').length + ' lines';
        const mod = document.getElementById('editor-meta-modified');
        mod.style.display = ta.value !== _editorOriginal ? '' : 'none';
    };
    ta.oninput();
    // Custom context menu for text editor (works on desktop + mobile)
    ta.oncontextmenu = e => {
        e.preventDefault();
        const hasSel = ta.selectionStart !== ta.selectionEnd;
        const _undoIcon = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M3 6l-2 2 2 2" stroke="currentColor" stroke-width="1.4" stroke-linecap="square" stroke-linejoin="miter"/><path d="M1 8h9a4 4 0 000-8" stroke="currentColor" stroke-width="1.4"/></svg>';
        const _redoIcon = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M13 6l2 2-2 2" stroke="currentColor" stroke-width="1.4" stroke-linecap="square" stroke-linejoin="miter"/><path d="M15 8H6a4 4 0 010-8" stroke="currentColor" stroke-width="1.4"/></svg>';
        const _selAllIcon = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="2" y="2" width="12" height="12" rx="1" stroke="currentColor" stroke-width="1.4"/><path d="M5 8h6M5 5.5h6M5 10.5h4" stroke="currentColor" stroke-width="1.2" stroke-linecap="square"/></svg>';
        showCtxMenu(e.clientX || e.pageX, e.clientY || e.pageY, [
            { label: 'Undo', icon: _undoIcon, action: () => { ta.focus(); document.execCommand('undo'); if (ta.oninput) ta.oninput(); } },
            { label: 'Redo', icon: _redoIcon, action: () => { ta.focus(); document.execCommand('redo'); if (ta.oninput) ta.oninput(); } },
            { sep: true },
            { label: 'Cut', icon: Icons.cut, action: () => { ta.focus(); document.execCommand('cut'); if (ta.oninput) ta.oninput(); }, disabled: !hasSel },
            { label: 'Copy', icon: Icons.copy, action: () => { ta.focus(); document.execCommand('copy'); }, disabled: !hasSel },
            {
                label: 'Paste', icon: Icons.paste, action: async () => {
                    ta.focus();
                    try {
                        const txt = await navigator.clipboard.readText();
                        const ss = ta.selectionStart, se = ta.selectionEnd;
                        ta.setRangeText(txt, ss, se, 'end');
                        if (ta.oninput) ta.oninput();
                    } catch (_) { /* clipboard read may be blocked by browser */ }
                }
            },
            { sep: true },
            { label: 'Select All', icon: _selAllIcon, action: () => { ta.focus(); ta.select(); } }
        ]);
    };
    Overlay.show('modal-editor');
    setTimeout(() => ta.focus(), 100);
}

async function saveEditor() {
    if (!_editorNode || !App.key) return;

    const text = document.getElementById('editor-textarea').value;
    const buf = new TextEncoder().encode(text);
    const needed = buf.byteLength * 1.1;
    const spCheck = await checkStorageSpace(needed);
    if (!spCheck.ok) {
        toast(`Cannot save: not enough device storage (${fmtSize(spCheck.available)} free)`, 'error');
        return;
    }

    let saved = false;
    showLoading('Saving...');
    try {
        const { iv, blob } = await Crypto.encryptBin(App.key, buf.buffer);
        _editorNode.size = buf.byteLength;
        _editorNode.mtime = Date.now();
        VFS.add(_editorNode);
        await DB.saveFile({ id: _editorNode.id, cid: App.container.id, iv: Array.from(iv), blob });
        _editorOriginal = text;
        document.getElementById('editor-meta-modified').style.display = 'none';
        await saveVFS();
        Desktop._patchIcons();
        toast('File saved', 'success');
        logActivity('edit', _editorNode.name, 1, VFS.fullPath(_editorNode.id));
        saved = true;
    } catch (e) { toast('Save failed: ' + e.message, 'error'); console.error(e); }
    hideLoading();
    return saved;
}

function closeEditor() {
    const ta = document.getElementById('editor-textarea');
    const modified = ta.value !== _editorOriginal;
    if (modified) {
        const dlg = document.getElementById('editor-unsaved-dialog');
        dlg.style.display = 'flex';
        return;
    }
    Overlay.hide();
    _editorNode = null;
}

function discardEditor() {
    Overlay.hide();
    _editorNode = null;
}

async function saveAndCloseEditor() {
    const ok = await saveEditor();
    if (ok) { Overlay.hide(); _editorNode = null; }
}

/* ============================================================
   FILE VIEWER
   ============================================================ */
let _viewerBlob = null;

function openViewer(node, buf, mime) {
    const content = document.getElementById('viewer-content');
    content.innerHTML = '';
    const blobObj = new Blob([buf], { type: mime }),
        url = URL.createObjectURL(blobObj);
    _viewerBlob = { url, node };

    document.getElementById('viewer-title').textContent = node.name;
    document.getElementById('btn-download-viewer').onclick = () => {
        const a = document.createElement('a'); a.href = url; a.download = node.name; a.click();
    };

    if (isImage(mime)) {
        const img = document.createElement('img');
        img.src = url; img.style.cssText = 'max-width:100%;max-height:100%;object-fit:contain';
        content.appendChild(img);
    } else if (isAudio(mime)) {
        content.appendChild(_buildCustomPlayer(url, 'audio'));
    } else if (isVideo(mime)) {
        content.appendChild(_buildCustomPlayer(url, 'video'));
    } else if (isPDF(mime)) {
        const fr = document.createElement('iframe');
        fr.src = url; fr.style.cssText = 'width:100%;height:100%;border:none';
        content.appendChild(fr);
    }
    Overlay.show('modal-viewer');
}

/* ---- Custom media player builder ---- */
function _buildCustomPlayer(url, kind) {
    const wrap = document.createElement('div');
    wrap.className = 'twc-player' + (kind === 'audio' ? ' audio-only' : '');

    const media = document.createElement(kind === 'audio' ? 'audio' : 'video');
    media.src = url;
    media.preload = 'metadata';
    media.volume = 1;
    media.muted = false;
    if (kind !== 'audio') media.setAttribute('playsinline', '');

    if (kind === 'audio') {
        media.style.display = 'none';  // keep in DOM so closeViewer() can find and pause it
        wrap.appendChild(media);
        const vis = document.createElement('div');
        vis.className = 'audio-vis';
        vis.innerHTML = `<svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M10 44V20l20-10v44L10 44z" fill="currentColor" opacity=".3" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>
      <path d="M34 22c4 2 7 6 7 10s-3 8-7 10" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
      <path d="M38 16c6 3 10 10 10 16s-4 13-10 16" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
    </svg>`;
        wrap.appendChild(vis);
    } else {
        wrap.appendChild(media);
    }

    const controls = document.createElement('div');
    controls.className = 'player-controls';

    // Play/Pause
    const btnPlay = document.createElement('button');
    btnPlay.className = 'player-btn';
    const playIcon = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M4 2l10 6-10 6z" fill="currentColor"/></svg>';
    const pauseIcon = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="3" y="2" width="3.5" height="12" rx=".5" fill="currentColor"/><rect x="9.5" y="2" width="3.5" height="12" rx=".5" fill="currentColor"/></svg>';
    btnPlay.innerHTML = playIcon;
    btnPlay.addEventListener('click', () => { media.paused ? media.play() : media.pause(); });

    // Seek bar
    const seek = document.createElement('input');
    seek.type = 'range'; seek.className = 'player-seek'; seek.min = 0; seek.max = 100; seek.value = 0; seek.step = 0.1;

    // Time label
    const timeLabel = document.createElement('span');
    timeLabel.className = 'player-time';
    timeLabel.textContent = '0:00 / 0:00';

    function fmtTime(s) {
        if (!isFinite(s)) return '0:00';
        const m = Math.floor(s / 60), sec = Math.floor(s % 60);
        return m + ':' + (sec < 10 ? '0' : '') + sec;
    }

    media.addEventListener('loadedmetadata', () => {
        seek.max = media.duration || 100;
        timeLabel.textContent = fmtTime(0) + ' / ' + fmtTime(media.duration);
    });
    media.addEventListener('timeupdate', () => {
        seek.value = media.currentTime;
        timeLabel.textContent = fmtTime(media.currentTime) + ' / ' + fmtTime(media.duration);
    });
    media.addEventListener('play', () => { btnPlay.innerHTML = pauseIcon; });
    media.addEventListener('pause', () => { btnPlay.innerHTML = playIcon; });
    media.addEventListener('ended', () => { btnPlay.innerHTML = playIcon; });

    let _seeking = false;
    seek.addEventListener('mousedown', () => { _seeking = true; });
    seek.addEventListener('touchstart', () => { _seeking = true; }, { passive: true });
    seek.addEventListener('input', () => { if (_seeking) media.currentTime = seek.value; });
    seek.addEventListener('mouseup', () => { _seeking = false; media.currentTime = seek.value; });
    seek.addEventListener('touchend', () => { _seeking = false; media.currentTime = seek.value; });

    // Volume
    const btnVol = document.createElement('button');
    btnVol.className = 'player-btn';
    const volIcon = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M2 6h3l4-3v10l-4-3H2z" fill="currentColor"/><path d="M12 4.5c1.3 1 2 2.3 2 3.5s-.7 2.5-2 3.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';
    const muteIcon = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M2 6h3l4-3v10l-4-3H2z" fill="currentColor"/><path d="M12 5l4 6M16 5l-4 6" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>';
    btnVol.innerHTML = volIcon;
    btnVol.addEventListener('click', () => {
        media.muted = !media.muted;
        btnVol.innerHTML = media.muted ? muteIcon : volIcon;
        vol.value = media.muted ? 0 : media.volume;
    });

    const vol = document.createElement('input');
    vol.type = 'range'; vol.className = 'player-vol'; vol.min = 0; vol.max = 1; vol.step = 0.01; vol.value = 1;
    vol.addEventListener('input', () => {
        media.volume = vol.value;
        media.muted = vol.value == 0;
        btnVol.innerHTML = media.muted ? muteIcon : volIcon;
    });

    controls.appendChild(btnPlay);
    controls.appendChild(seek);
    controls.appendChild(timeLabel);
    controls.appendChild(btnVol);
    controls.appendChild(vol);

    // Fullscreen button (video only)
    if (kind !== 'audio') {
        const btnFs = document.createElement('button');
        btnFs.className = 'player-btn';
        btnFs.title = 'Fullscreen (F)';
        const fsEnterIcon = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M1 1h4M1 1v4M15 1h-4M15 1v4M1 15h4M1 15v-4M15 15h-4M15 15v-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
        const fsExitIcon = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M5 1v4H1M11 1v4h4M5 15v-4H1M11 15v-4h4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
        btnFs.innerHTML = fsEnterIcon;
        btnFs.addEventListener('click', () => {
            if (!document.fullscreenElement) wrap.requestFullscreen?.();
            else document.exitFullscreen?.();
        });
        const _onFsChange = () => { btnFs.innerHTML = document.fullscreenElement ? fsExitIcon : fsEnterIcon; };
        document.addEventListener('fullscreenchange', _onFsChange);
        wrap._cleanupFs = () => document.removeEventListener('fullscreenchange', _onFsChange);
        controls.appendChild(btnFs);

        // Click on video = play/pause; double-click = toggle fullscreen
        let _lastClick = 0;
        media.addEventListener('click', () => {
            const now = Date.now();
            if (now - _lastClick < 300) {
                // Double-click: toggle fullscreen
                if (!document.fullscreenElement) wrap.requestFullscreen?.();
                else document.exitFullscreen?.();
            } else {
                media.paused ? media.play() : media.pause();
            }
            _lastClick = now;
        });
    }

    // Keyboard shortcuts: Space = play/pause, ←/→ = ±5s, F = fullscreen, M = mute
    const _onKey = e => {
        if (!wrap.isConnected) return;
        const tag = e.target?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'BUTTON') return;
        if (e.code === 'Space') { e.preventDefault(); media.paused ? media.play() : media.pause(); }
        if (e.code === 'ArrowLeft') { e.preventDefault(); media.currentTime = Math.max(0, media.currentTime - 5); }
        if (e.code === 'ArrowRight') { e.preventDefault(); media.currentTime = Math.min(media.duration || Infinity, media.currentTime + 5); }
        if (e.code === 'KeyF' && kind !== 'audio') {
            e.preventDefault();
            if (!document.fullscreenElement) wrap.requestFullscreen?.();
            else document.exitFullscreen?.();
        }
        if (e.code === 'KeyM') { e.preventDefault(); media.muted = !media.muted; btnVol.innerHTML = media.muted ? muteIcon : volIcon; vol.value = media.muted ? 0 : media.volume; }
    };
    document.addEventListener('keydown', _onKey);
    wrap._cleanupKeyboard = () => document.removeEventListener('keydown', _onKey);

    wrap.appendChild(controls);
    return wrap;
}

function closeViewer() {
    // Stop any playing media, cleanup event listeners
    const content = document.getElementById('viewer-content');
    content.querySelectorAll('audio, video').forEach(el => { el.pause(); el.src = ''; });
    content.querySelectorAll('.twc-player').forEach(p => { p._cleanupKeyboard?.(); p._cleanupFs?.(); });
    if (_viewerBlob) { URL.revokeObjectURL(_viewerBlob.url); _viewerBlob = null; }
    Overlay.hide();
}

/* ============================================================
   CLIPBOARD VISUAL / CUT FEEDBACK
   ============================================================ */
function _applyCutStyles() {
    document.querySelectorAll('.file-item.cut-item').forEach(el => el.classList.remove('cut-item'));
    if (App.clipboard?.op === 'cut') {
        App.clipboard.ids.forEach(id => {
            document.querySelectorAll(`.file-item[data-id="${id}"]`).forEach(el => el.classList.add('cut-item'));
        });
    }
}

function cancelClipboard() {
    App.clipboard = null;
    _applyCutStyles();
}

/* ============================================================
   ZIP EXPORT  (pure JS, no compression — stored only)
   ============================================================ */
function _escXml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function _readZip(buffer) {
    const view = new DataView(buffer);
    const u8 = new Uint8Array(buffer);
    const size = buffer.byteLength;
    let eocdOffset = -1;
    for (let i = size - 22; i >= Math.max(0, size - 65558); i--) {
        if (view.getUint32(i, true) === 0x06054b50) { eocdOffset = i; break; }
    }
    if (eocdOffset < 0) throw new Error('Not a valid ZIP file');
    const cdCount = view.getUint16(eocdOffset + 8, true),
        cdOffset = view.getUint32(eocdOffset + 16, true),
        dec = new TextDecoder('utf-8'),
        entries = {};
    let pos = cdOffset;
    for (let i = 0; i < cdCount; i++) {
        if (view.getUint32(pos, true) !== 0x02014b50) break;
        const fnLen = view.getUint16(pos + 28, true),
            exLen = view.getUint16(pos + 30, true),
            cmLen = view.getUint16(pos + 32, true),
            lhOff = view.getUint32(pos + 42, true),
            fn = dec.decode(u8.subarray(pos + 46, pos + 46 + fnLen)),
            lhFnLen = view.getUint16(lhOff + 26, true),
            lhExLen = view.getUint16(lhOff + 28, true),
            dataOff = lhOff + 30 + lhFnLen + lhExLen,
            dataLen = view.getUint32(lhOff + 22, true);
        entries[fn] = u8.slice(dataOff, dataOff + dataLen);
        pos += 46 + fnLen + exLen + cmLen;
    }
    return entries;
}
function _crc32(data) {
    if (!_crc32._t) {
        const t = new Uint32Array(256);
        for (let n = 0; n < 256; n++) {
            let c = n;
            for (let k = 0; k < 8; k++) c = (c & 1) ? 0xEDB88320 ^ (c >>> 1) : (c >>> 1);
            t[n] = c;
        }
        _crc32._t = t;
    }
    const table = _crc32._t;
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < data.length; i++) crc = table[(crc ^ data[i]) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
}

function _buildZip(entries) {
    // entries: [ { name: string, data: Uint8Array, mtime?: number } ]
    const enc = new TextEncoder();
    const locals = [], centralDir = [];
    let offset = 0;

    function dosDT(ts) {
        const d = new Date(ts || Date.now());
        return {
            t: ((d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2)),
            d: (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate())
        };
    }

    for (const entry of entries) {
        const nm = enc.encode(entry.name);
        const data = entry.data instanceof Uint8Array ? entry.data : new Uint8Array(entry.data);
        const crc = _crc32(data);
        const sz = data.length;
        const { t: mt, d: md } = dosDT(entry.mtime);

        const lh = new Uint8Array(30 + nm.length);
        const lv = new DataView(lh.buffer);
        lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true);
        lv.setUint16(6, 0x0800, true); lv.setUint16(8, 0, true);  // 0x0800 = UTF-8 filename flag
        lv.setUint16(10, mt, true); lv.setUint16(12, md, true);
        lv.setUint32(14, crc, true); lv.setUint32(18, sz, true);
        lv.setUint32(22, sz, true); lv.setUint16(26, nm.length, true);
        lv.setUint16(28, 0, true); lh.set(nm, 30);
        locals.push(lh, data);

        const cd = new Uint8Array(46 + nm.length);
        const cv = new DataView(cd.buffer);
        cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true);
        cv.setUint16(8, 0x0800, true); cv.setUint16(10, 0, true);  // 0x0800 = UTF-8 filename flag
        cv.setUint16(12, mt, true); cv.setUint16(14, md, true);
        cv.setUint32(16, crc, true); cv.setUint32(20, sz, true); cv.setUint32(24, sz, true);
        cv.setUint16(28, nm.length, true); cv.setUint16(30, 0, true); cv.setUint16(32, 0, true);
        cv.setUint16(34, 0, true); cv.setUint16(36, 0, true); cv.setUint32(38, 0, true);
        cv.setUint32(42, offset, true); cd.set(nm, 46);
        centralDir.push(cd);

        offset += 30 + nm.length + sz;
    }

    const cdSz = centralDir.reduce((s, a) => s + a.length, 0);
    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true); ev.setUint16(4, 0, true); ev.setUint16(6, 0, true);
    ev.setUint16(8, entries.length, true); ev.setUint16(10, entries.length, true);
    ev.setUint32(12, cdSz, true); ev.setUint32(16, offset, true); ev.setUint16(20, 0, true);

    const all = [...locals, ...centralDir, eocd];
    let total = 0; for (const p of all) total += p.length;
    const out = new Uint8Array(total);
    let off = 0; for (const p of all) { out.set(p, off); off += p.length; }
    return out;
}

async function exportAsZip(nodeIds, zipName) {
    if (!App.key || !App.container) return;
    if (!zipName) {
        zipName = nodeIds.length === 1
            ? (VFS.node(nodeIds[0])?.name?.replace(/\.[^.]+$/, '') || 'export') + '.zip'
            : 'export.zip';
    }
    showLoading('Preparing ZIP…');
    try {
        const entries = [], _zipSeen = new Set(), _flat = [];
        function _collectFlat(nodeId, prefix, _depth = 0) {
            if (_zipSeen.has(nodeId) || _depth > 64) return;
            _zipSeen.add(nodeId);
            const n = VFS.node(nodeId); if (!n) return;
            if (n.type === 'folder') {
                for (const c of VFS.children(nodeId)) _collectFlat(c.id, prefix + n.name + '/', _depth + 1);
            } else {
                _flat.push({ id: nodeId, name: prefix + n.name, mtime: n.mtime || n.ctime });
            }
        }
        for (const id of nodeIds) _collectFlat(id, '');
        // Fetch all file records in one IDB transaction, then decrypt fully in parallel
        const fileMap = await DB.getFilesByIds(_flat.map(f => f.id));
        const decResults = await Promise.allSettled(_flat.map(async item => {
            const rec = fileMap.get(item.id); if (!rec) return null;
            const buf = await Crypto.decryptBin(App.key, rec.iv, rec.blob);
            return { name: item.name, data: new Uint8Array(buf), mtime: item.mtime };
        }));
        decResults.forEach(r => { if (r.status === 'fulfilled' && r.value) entries.push(r.value); });
        if (!entries.length) { toast('Nothing to export', 'warn'); hideLoading(); return; }
        const zip = _buildZip(entries);
        downloadBuf(zip.buffer, zipName, 'application/zip');
        toast(`Exported ${entries.length} file${entries.length !== 1 ? 's' : ''} as ZIP`, 'success');
        logActivity('export-zip', nodeIds.length === 1 ? (VFS.node(nodeIds[0])?.name ?? entries[0]?.name ?? '1 file') : `${entries.length} files`, entries.length, nodeIds.length === 1 ? VFS.fullPath(nodeIds[0]) : null);
    } catch (e) { toast('ZIP export failed: ' + e.message, 'error'); console.error(e); }
    hideLoading();
}

/* ============================================================
   CONTAINER IMPORT / EXPORT
   ============================================================ */

// _buf2b64Safe removed — buf2b64 is now chunked and equivalent

/** Brute-force attempt tracker for export password prompts */
const _expFailCounts = new Map();

/** Prompt for password to derive the container key before exporting a locked container */
function _askExportPassword(c) {
    return new Promise(resolve => {
        const expKey = 'exp:' + c.id;
        const errEl = document.getElementById('exp-error');
        const btnOk = document.getElementById('exp-ok');
        document.getElementById('exp-cont-name').textContent = c.name;
        document.getElementById('exp-pw').value = '';
        errEl.innerHTML = '';
        errEl.style.color = '';
        btnOk.disabled = false;

        const prevFails = _expFailCounts.get(expKey);
        if (prevFails?.lockUntil > Date.now()) {
            _startAttemptCooldown(errEl, btnOk, () => { if (prevFails) prevFails.lockUntil = 0; });
        }

        Overlay.show('modal-export-pw');
        setTimeout(() => document.getElementById('exp-pw').focus(), 100);

        const cleanup = () => {
            Overlay.hide();
            btnOk.onclick = null;
            document.getElementById('exp-cancel').onclick = null;
            document.getElementById('exp-close').onclick = null;
            document.getElementById('exp-pw').onkeydown = null;
        };

        const doExport = async () => {
            const fails = _expFailCounts.get(expKey) || { count: 0, lockUntil: 0 };
            if (fails.lockUntil > Date.now()) return;
            const pw = document.getElementById('exp-pw').value;
            if (!pw) { errEl.innerHTML = _ERR_SVG + ' Enter password'; return; }
            errEl.innerHTML = '';
            btnOk.disabled = true;
            try {
                const key = await Crypto.deriveKey(pw, new Uint8Array(c.salt)),
                    ok = await Crypto.checkVerification(key, c.verIv, c.verBlob);
                if (!ok) {
                    fails.count++;
                    _expFailCounts.set(expKey, fails);
                    if (fails.count > 3) {
                        fails.lockUntil = Date.now() + 3000;
                        _startAttemptCooldown(errEl, btnOk, () => { fails.lockUntil = 0; });
                    } else {
                        errEl.innerHTML = _ERR_SVG + ' Incorrect password';
                        btnOk.disabled = false;
                    }
                    return;
                }
                _expFailCounts.delete(expKey);
                cleanup();
                resolve(key);
            } catch (e) {
                errEl.textContent = 'Error: ' + e.message;
                btnOk.disabled = false;
            }
        };

        btnOk.onclick = doExport;
        document.getElementById('exp-cancel').onclick = () => { cleanup(); resolve(null); };
        document.getElementById('exp-close').onclick = () => { cleanup(); resolve(null); };
        document.getElementById('exp-pw').onkeydown = e => { if (e.key === 'Enter') doExport(); };
    });
}

async function exportContainerFile(c, requirePassword = true) {
    showLoading('Exporting container…');
    try {
        const vfsRec = await DB.getVFS(c.id),
            fileRecs = await DB.getFilesByCid(c.id),
            now = Date.now();

        // Build file manifest and workspace.bin
        // Pre-convert blobs once, compute total size in a single pass
        const fileChunks = fileRecs.map(f => new Uint8Array(f.blob instanceof ArrayBuffer ? f.blob : f.blob));
        let offset = 0;
        const fileManifest = fileRecs.map((f, fi) => {
            const ivArr = f.iv instanceof Array ? f.iv : Array.from(new Uint8Array(f.iv));
            const ivB64 = btoa(String.fromCharCode(...ivArr));
            const entry = { id: f.id, ivB64, offset, size: fileChunks[fi].length };
            offset += fileChunks[fi].length;
            return entry;
        });

        // Concat all file blobs → safenova_efs/workspace.bin (single allocation + typed set)
        const workspaceBin = new Uint8Array(offset);
        let wOff = 0;
        for (const chunk of fileChunks) { workspaceBin.set(chunk, wOff); wOff += chunk.length; }

        // Encrypt file manifest with the container key
        const manifestJson = JSON.stringify(fileManifest);
        let key = (App.container?.id === c.id) ? App.key : null;
        // If the extra-confirmation setting is off, silently try the saved session
        if (!requirePassword && !key) {
            const rawKeyBytes = await loadSession(c.id);
            if (rawKeyBytes) {
                try {
                    const sk = await Crypto.importRawKey(rawKeyBytes);
                    if (await Crypto.checkVerification(sk, c.verIv, c.verBlob)) key = sk;
                } catch { /* corrupt session — will prompt below */ }
            }
        }
        if (!key) {
            hideLoading();
            key = await _askExportPassword(c);
            if (!key) return;
            showLoading('Exporting container…');
        }
        const encManifest = await Crypto.encryptBin(key, new TextEncoder().encode(manifestJson)),
            encManifestIv = new Uint8Array(encManifest.iv),
            encManifestBlob = new Uint8Array(encManifest.blob);

        // VFS bytes → meta/0 (iv raw), meta/1 (blob raw)
        const vfsIvData = vfsRec ? new Uint8Array(vfsRec.iv) : new Uint8Array(0),
            vfsBlobData = vfsRec ? new Uint8Array(typeof vfsRec.blob === 'string' ? b642buf(vfsRec.blob) : vfsRec.blob) : new Uint8Array(0);

        // container.xml — file manifest is encrypted, no <files> in plaintext
        const saltB64 = btoa(String.fromCharCode(...new Uint8Array(c.salt))),
            verIvB64 = btoa(String.fromCharCode(...new Uint8Array(c.verIv)));
        const settingsToExport = { ...SETTINGS_DEFAULTS, ...(c.settings || {}) };
        const xmlLines = [
            '<?xml version="1.0" encoding="UTF-8"?>',
            `<safenova version="3" exportedAt="${now}">`,
            '  <container>',
            `    <name>${_escXml(c.name)}</name>`,
            `    <createdAt>${c.createdAt}</createdAt>`,
            `    <salt>${saltB64}</salt>`,
            `    <verIv>${verIvB64}</verIv>`,
            `    <verBlob>${c.verBlob}</verBlob>`,
            `    <totalSize>${c.totalSize || 0}</totalSize>`,
            '  </container>',
            '  <settings>',
            ...Object.entries(settingsToExport).map(([k, v]) => `    <${k}>${_escXml(String(v))}</${k}>`),
            '  </settings>',
            '  <files encrypted="true"/>',
            '</safenova>',
        ];
        const xmlData = new TextEncoder().encode(xmlLines.join('\n'));

        const entries = [
            { name: 'container.xml', data: xmlData, mtime: now },
            { name: 'meta/0', data: vfsIvData, mtime: now },
            { name: 'meta/1', data: vfsBlobData, mtime: now },
            { name: 'meta/2', data: encManifestIv, mtime: now },
            { name: 'meta/3', data: encManifestBlob, mtime: now },
            { name: 'safenova_efs/workspace.bin', data: workspaceBin, mtime: now },
        ];
        // Optionally include activity log (encrypted)
        if (c.settings?.exportWithLogs === true) {
            let alogEnc;
            if (App.container?.id === c.id && typeof _activityLog !== 'undefined' && _activityLog.length) {
                const compressed = await _compressLog(_activityLog);
                alogEnc = await Crypto.encrypt(App.key, compressed);
            } else if (c._alogZ && c._alogZ.iv && c._alogZ.blob) {
                alogEnc = c._alogZ;
            }
            if (alogEnc) {
                const alogBytes = new TextEncoder().encode(JSON.stringify(alogEnc));
                entries.push({ name: 'meta/activity_logs/0', data: alogBytes, mtime: now });
            }
        }
        const zip = _buildZip(entries);
        const dateStr = new Date(now).toISOString().slice(0, 10);
        downloadBuf(zip.buffer, `SafeNova_${c.name}_${dateStr}.safenova`, 'application/octet-stream');
        toast(`Container "${c.name}" exported`, 'success');
        logActivity('export-container', c.name);
    } catch (e) { toast('Export failed: ' + e.message, 'error'); console.error(e); }
    hideLoading();
}

async function importContainerFile(file) {
    if (!file) return;
    const MAX_IMPORT_SIZE = 256 * 1024 * 1024; // 256 MB hard cap
    if (file.size > MAX_IMPORT_SIZE) {
        toast(`Import file too large (max ${fmtSize(MAX_IMPORT_SIZE)})`, 'error');
        return;
    }
    showLoading('Importing container…');
    try {
        const arrayBuf = await file.arrayBuffer(),
            u8first = new Uint8Array(arrayBuf, 0, 2),
            isZip = u8first[0] === 0x50 && u8first[1] === 0x4B;

        if (isZip) {
            const entries = _readZip(arrayBuf);
            if (!entries['container.xml'] || !entries['meta/0'] || !entries['meta/1'] || !entries['safenova_efs/workspace.bin'])
                throw new Error('Invalid SafeNova file: missing required entries');

            const xmlText = new TextDecoder('utf-8').decode(entries['container.xml']),
                doc = new DOMParser().parseFromString(xmlText, 'text/xml');
            const getText = (parent, sel) => { const el = parent.querySelector(sel); return el ? el.textContent.trim() : null; };

            const nameRaw = getText(doc, 'container > name'),
                createdAt = parseInt(getText(doc, 'container > createdAt') || '0', 10),
                saltB64 = getText(doc, 'container > salt'),
                verIvB64 = getText(doc, 'container > verIv'),
                verBlob = getText(doc, 'container > verBlob'),
                totalSize = parseInt(getText(doc, 'container > totalSize') || '0', 10);

            if (!nameRaw || !saltB64 || !verIvB64 || !verBlob)
                throw new Error('Invalid container.xml: missing required fields');

            // Parse settings block if present
            const settingsEl = doc.querySelector('settings');
            let importedSettings;
            if (settingsEl) {
                importedSettings = {};
                Array.from(settingsEl.children).forEach(el => {
                    const v = el.textContent.trim();
                    importedSettings[el.tagName] = v === 'true' ? true : v === 'false' ? false : v;
                });
            }

            const salt = Array.from(Uint8Array.from(atob(saltB64), ch => ch.charCodeAt(0))),
                verIv = Array.from(Uint8Array.from(atob(verIvB64), ch => ch.charCodeAt(0)));

            if (entries['meta/2'] && entries['meta/3']) {
                // v3: import without password — encrypted workspace stored as-is, expanded on first unlock
                const existing2 = await DB.getContainers();
                let name = nameRaw, suffix = 2;
                while (existing2.find(x => x.name.toLowerCase() === name.toLowerCase()))
                    name = nameRaw + ' (' + suffix++ + ')';

                const newCid = uid();
                const cObj = {
                    id: newCid, name, createdAt, salt, verIv, verBlob, totalSize,
                    settings: importedSettings || undefined,
                    lazyWorkspace: {
                        bin: entries['safenova_efs/workspace.bin'],
                        mIv: entries['meta/2'],
                        mBlob: entries['meta/3'],
                    }
                };
                // Restore encrypted activity log (if present)
                if (entries['meta/activity_logs/0']) {
                    try { cObj._alogZ = JSON.parse(new TextDecoder().decode(entries['meta/activity_logs/0'])); } catch {}
                } else if (entries['meta/activity_log.zlib']) {
                    // Legacy: plain compressed bytes — store raw, will be encrypted on first flush
                    cObj._alogZ = entries['meta/activity_log.zlib'];
                }
                await DB.saveContainer(cObj);
                await DB.saveVFS(newCid, Array.from(entries['meta/0']), entries['meta/1'].buffer);
                hideLoading();
                toast(`Container "${name}" imported`, 'success');
                await Home.render();
                return;
            }

            throw new Error('Unsupported container format. Only SafeNova v3 (.safenova) exports are supported.');

        } else {
            throw new Error('Unsupported file format. Please use a .safenova export.');
        }
    } catch (e) {
        hideLoading();
        toast('Import failed: ' + e.message, 'error');
        console.error(e);
    }
}

/* ============================================================
   THUMBNAIL GENERATION  (async, cached)
   ============================================================ */
async function generateThumb(node) {
    if (!App.key || !App.container) return null;
    try {
        const rec = await DB.getFile(node.id); if (!rec) return null;
        const buf = await Crypto.decryptBin(App.key, rec.iv, rec.blob);
        const mime = node.mime || getMime(node.name);
        if (!isImage(mime)) return null;

        const blob = new Blob([buf], { type: mime }),
            url = URL.createObjectURL(blob);
        return new Promise(res => {
            const img = new Image();
            img.onload = () => {
                const canvas = document.createElement('canvas');
                canvas.width = canvas.height = 56;
                const ctx = canvas.getContext('2d');
                const scale = Math.min(56 / img.width, 56 / img.height),
                    w = img.width * scale,
                    h = img.height * scale;
                ctx.fillStyle = '#2d2d30'; ctx.fillRect(0, 0, 56, 56);
                ctx.drawImage(img, (56 - w) / 2, (56 - h) / 2, w, h);
                URL.revokeObjectURL(url);
                res(canvas.toDataURL('image/jpeg', 0.75));
            };
            img.onerror = () => { URL.revokeObjectURL(url); res(null); };
            img.src = url;
        });
    } catch { return null; }
}
