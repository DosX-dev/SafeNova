'use strict';

/* ============================================================
   HOME VIEW
   ============================================================ */

function _loadCardOrder() {
    try { return JSON.parse(localStorage.getItem('snv-card-order') || '[]'); } catch { return []; }
}
function _saveCardOrder(ids) {
    localStorage.setItem('snv-card-order', JSON.stringify(ids));
}

const Home = {
    async render() {
        const grid = document.getElementById('container-grid'),
            empty = document.getElementById('container-empty'),
            containers = await DB.getContainers();

        grid.querySelectorAll('.container-card').forEach(c => c.remove());

        if (containers.length === 0) {
            empty.style.display = 'flex';
        } else {
            empty.style.display = 'none';
            // Re-validate stored sessions: clear stale/expired ones before rendering badges
            for (const c of containers) {
                if (hasSession(c.id)) await loadSession(c.id);
            }
            const savedOrder = _loadCardOrder();
            containers.sort((a, b) => {
                const ia = savedOrder.indexOf(a.id), ib = savedOrder.indexOf(b.id);
                if (ia === -1 && ib === -1) return b.createdAt - a.createdAt;
                if (ia === -1) return 1;
                if (ib === -1) return -1;
                return ia - ib;
            });
            containers.forEach(c => grid.appendChild(this._makeCard(c)));
        }
        await updateStorageInfo();

        // ---- Persistent visibility: warning box (only when 1+ container exists) ----
        const warnBox = document.getElementById('home-warning-box'),
            dismissBtn = document.getElementById('warning-dismiss');
        if (warnBox) {
            const shouldShow = containers.length > 0 && localStorage.getItem('snv-warn-hide') !== '1';
            warnBox.classList.toggle('hidden', !shouldShow);
            if (dismissBtn) {
                dismissBtn.onclick = () => {
                    warnBox.classList.add('hidden');
                    localStorage.setItem('snv-warn-hide', '1');
                };
            }
        }

        // ---- Persistent visibility: doc block ----
        const docEl = document.getElementById('home-doc'),
            docTab = document.getElementById('home-doc-tab'),
            collapseBtn = document.getElementById('home-doc-collapse');
        const _applyDoc = (hidden) => {
            if (!docEl || !docTab) return;
            docEl.classList.toggle('collapsed', hidden);
            docTab.classList.toggle('visible', hidden);
        };
        // Disable transition during initial render to avoid animating on page load
        if (docEl) docEl.style.transition = 'none';
        _applyDoc(localStorage.getItem('snv-doc-hide') === '1');
        // Remove the pre-hide html class now that the correct class is set
        document.documentElement.classList.remove('snv-doc-hidden');
        // Re-enable transitions after layout settles
        if (docEl) requestAnimationFrame(() => { docEl.style.transition = ''; });
        if (collapseBtn) {
            collapseBtn.onclick = () => {
                localStorage.setItem('snv-doc-hide', '1');
                _applyDoc(true);
            };
        }
        if (docTab) {
            docTab.onclick = () => {
                localStorage.setItem('snv-doc-hide', '0');
                _applyDoc(false);
            };
        }
    },

    _makeCard(c) {
        const pct = Math.min((c.totalSize || 0) / CONTAINER_LIMIT * 100, 100),
            fill = pct > 90 ? 'danger' : pct > 70 ? 'warn' : '',
            hasSess = hasSession(c.id),
            card = document.createElement('div');
        card.className = 'container-card';
        card.dataset.id = c.id;
        card.innerHTML = `
      <div class="container-drag-handle" title="Drag to reorder">
        <svg width="10" height="14" viewBox="0 0 10 14" fill="none" xmlns="http://www.w3.org/2000/svg">
          <circle cx="3" cy="2.5"  r="1.2" fill="currentColor"/>
          <circle cx="7" cy="2.5"  r="1.2" fill="currentColor"/>
          <circle cx="3" cy="7"    r="1.2" fill="currentColor"/>
          <circle cx="7" cy="7"    r="1.2" fill="currentColor"/>
          <circle cx="3" cy="11.5" r="1.2" fill="currentColor"/>
          <circle cx="7" cy="11.5" r="1.2" fill="currentColor"/>
        </svg>
      </div>
      <div class="container-card-header">
        <div class="container-card-icon">
          <img src="favicon.png" width="20" height="20" alt="" style="object-fit:contain;display:block;">
        </div>
        <div>
          <div class="container-card-name">${escHtml(c.name)}</div>
          <div class="container-card-date">${fmtDate(c.createdAt)}</div>
        </div>
      </div>
      <div class="container-card-body">
        <div class="container-bar-wrap">
          <div class="container-bar-fill ${fill}" style="width:${pct.toFixed(1)}%"></div>
        </div>
        <div class="container-card-sizes">
          <span>${fmtSize(c.totalSize || 0)} used</span>
          <span>${fmtSize(CONTAINER_LIMIT - (c.totalSize || 0))} free</span>
        </div>
      </div>
      ${hasSess ? `<div class="session-badge" title="Active session — click to resume">
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg">
          <circle cx="6" cy="6" r="5" stroke="currentColor" stroke-width="1.3"/>
          <path d="M4 6l1.5 1.5L8.5 4" stroke="currentColor" stroke-width="1.3" stroke-linecap="square"/>
        </svg>
        Session active
      </div>` : ''}
      <div class="container-card-menu" data-id="${c.id}" title="Options">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
          <circle cx="8" cy="3"  r="1.2" fill="currentColor"/>
          <circle cx="8" cy="8"  r="1.2" fill="currentColor"/>
          <circle cx="8" cy="13" r="1.2" fill="currentColor"/>
        </svg>
      </div>
    `;

        // Drag-to-reorder via handle — whole card used as ghost image
        const handle = card.querySelector('.container-drag-handle');
        handle.setAttribute('draggable', 'true');
        handle.addEventListener('dragstart', e => {
            e.dataTransfer.setData('text/plain', c.id);
            e.dataTransfer.effectAllowed = 'move';
            // Use the full card as ghost image so it looks like the whole card is being dragged
            const rect = card.getBoundingClientRect();
            e.dataTransfer.setDragImage(card, e.clientX - rect.left, e.clientY - rect.top);
            // Delay adding source class so ghost is captured before card fades
            requestAnimationFrame(() => card.classList.add('drag-reorder-source'));
            e.stopPropagation();
        });
        handle.addEventListener('dragend', () => card.classList.remove('drag-reorder-source'));
        card.addEventListener('dragover', e => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            card.classList.add('drag-reorder-over');
        });
        card.addEventListener('dragleave', e => {
            if (!card.contains(e.relatedTarget)) card.classList.remove('drag-reorder-over');
        });
        card.addEventListener('drop', e => {
            e.preventDefault();
            card.classList.remove('drag-reorder-over');
            const sourceId = e.dataTransfer.getData('text/plain');
            if (!sourceId || sourceId === c.id) return;
            const grid2 = document.getElementById('container-grid');
            const sourceCard = grid2.querySelector(`.container-card[data-id="${CSS.escape(sourceId)}"]`);
            if (!sourceCard) return;
            const all = [...grid2.querySelectorAll('.container-card')];
            const fromIdx = all.indexOf(sourceCard);
            const toIdx = all.indexOf(card);
            if (fromIdx < toIdx) card.after(sourceCard);
            else card.before(sourceCard);
            const newOrder = [...grid2.querySelectorAll('.container-card')].map(el => el.dataset.id).filter(Boolean);
            _saveCardOrder(newOrder);
        });

        card.addEventListener('click', async e => {
            if (e.target.closest('.container-card-menu') || e.target.closest('.container-drag-handle')) return;
            _tryOpenContainer(c);
        });
        card.querySelector('.container-card-menu').addEventListener('click', e => {
            e.stopPropagation();
            showContainerMenu(e, c);
        });
        return card;
    }
};

/* ---- Container context menu ---- */
function showContainerMenu(e, c) {
    const hasSess = hasSession(c.id),
        isOpen = App.container && App.container.id === c.id,
        reqExpPw = c.settings?.requireExportPassword !== false,
        items = [];

    // Open — resume if session exists, otherwise go to unlock view
    items.push({
        label: 'Open', icon: Icons.unlock,
        _keyHint: !hasSess ? '<span class="auth-dot"></span>' : null,
        action: () => _tryOpenContainer(c)
    });
    items.push({ sep: true });

    if (hasSess) {
        items.push({ label: 'Kill Session', icon: Icons.lock, action: () => killSession(c) });
    }

    // Change Password — always visible, disabled when session active or container open
    const cpDisabled = hasSess || isOpen;
    items.push({
        label: 'Change Password…', icon: Icons.key,
        _keyHint: !cpDisabled ? '<span class="auth-dot"></span>' : null,
        disabled: cpDisabled,
        _tooltip: cpDisabled ? 'End the active session first' : null,
        action: cpDisabled ? null : () => openChangePasswordModal(c)
    });

    // Rename Container — disabled when session active or container open
    const rnDisabled = hasSess || isOpen;
    items.push({
        label: 'Rename Container…', icon: Icons.rename, disabled: rnDisabled,
        _tooltip: rnDisabled ? 'End the active session first' : null,
        action: rnDisabled ? null : () => openRenameContainerModal(c)
    });

    items.push({ sep: true });
    items.push({
        label: 'Export Container', icon: Icons.download,
        _keyHint: reqExpPw ? '<span class="auth-dot"></span>' : null,
        action: () => exportContainerFile(c, reqExpPw)
    });
    items.push({ sep: true });
    items.push({ label: 'Delete Container...', icon: Icons.trash, danger: true, action: () => confirmDeleteContainer(c) });
    showCtxMenu(e.clientX, e.clientY, items);
}

/* ---- Kill Session ---- */
function killSession(c) {
    // Notify any tab that has this container open — they will call lockContainer() via the
    // storage event listener.  forceClaimSession writes kick=true; we then immediately clean
    // up the claim entry (we're on the home page, not opening this container ourselves).
    _forceClaimSession(c.id);
    _stopContainerSession(c.id); // removes the kick entry we just wrote
    clearSession(c.id);
    toast(`Session for "${c.name}" terminated`, 'info');
    Home.render();
}

/* ---- Change Password ---- */
function openChangePasswordModal(c) {
    document.getElementById('cp-old').value = '';
    document.getElementById('cp-new').value = '';
    document.getElementById('cp-new2').value = '';
    document.getElementById('cp-error').textContent = '';
    document.getElementById('cp-ok')._container = c;
    Overlay.show('modal-change-pw');
    setTimeout(() => document.getElementById('cp-old').focus(), 100);
}

async function doChangePassword() {
    const okBtn = document.getElementById('cp-ok'),
        c = okBtn._container;
    if (!c) return;
    const oldPw = document.getElementById('cp-old').value,
        newPw = document.getElementById('cp-new').value,
        newPw2 = document.getElementById('cp-new2').value,
        errEl = document.getElementById('cp-error');

    if (!oldPw) { errEl.textContent = 'Enter current password'; return; }
    if (newPw.length < 4) { errEl.textContent = 'New password must be at least 4 characters'; return; }
    if (newPw !== newPw2) { errEl.textContent = 'Passwords do not match'; return; }
    if (oldPw === newPw) { errEl.textContent = 'New password must differ from current'; return; }

    // Rate-limit check
    const cpKey = 'cp:' + c.id,
        cpFails = _failCounts.get(cpKey) || { count: 0, lockUntil: 0 };
    if (cpFails.lockUntil > Date.now()) return;

    errEl.innerHTML = '';
    okBtn.disabled = true;
    let _cpInModal = true;

    try {
        // Verify old password
        const oldKey = await Crypto.deriveKey(oldPw, new Uint8Array(c.salt)),
            ok = await Crypto.checkVerification(oldKey, c.verIv, c.verBlob);
        if (!ok) {
            cpFails.count++;
            _failCounts.set(cpKey, cpFails);
            if (cpFails.count > 3) {
                cpFails.lockUntil = Date.now() + 3000;
                _startAttemptCooldown(errEl, okBtn, () => { cpFails.lockUntil = 0; });
            } else {
                errEl.innerHTML = `${_ERR_SVG} Incorrect current password`;
                okBtn.disabled = false;
            }
            return;
        }
        _cpInModal = false;
        _failCounts.delete(cpKey);
        Overlay.hide();
        showLoading('Deriving new key…');

        const newSalt = Array.from(crypto.getRandomValues(new Uint8Array(32))),
            newKey = await Crypto.deriveKey(newPw, new Uint8Array(newSalt));

        // Re-encrypt VFS
        showLoading('Re-encrypting VFS…');
        const vfsRec = await DB.getVFS(c.id);
        if (vfsRec) {
            const vfsBuf = typeof vfsRec.blob === 'string'
                ? await Crypto.decrypt(oldKey, vfsRec.iv, vfsRec.blob)
                : await Crypto.decryptBin(oldKey, vfsRec.iv, vfsRec.blob);
            const { iv: newVfsIv, blob: newVfsBlob } = await Crypto.encryptBin(newKey, vfsBuf);
            await DB.saveVFS(c.id, newVfsIv, newVfsBlob);
        }

        // Re-encrypt all files fully in parallel (Web Crypto is async/hardware-accelerated;
        // browser schedules concurrent SubtleCrypto calls across available cores)
        const files = await DB.getFilesByCid(c.id);
        showLoading(`Re-encrypting files\u2026 0/${files.length}`);
        let _reencDone = 0;
        const reencResults = await Promise.allSettled(files.map(async f => {
            const buf = await Crypto.decryptBin(oldKey, f.iv, f.blob);
            const { iv, blob } = await Crypto.encryptBin(newKey, buf);
            _reencDone++;
            if (_reencDone % 4 === 0 || _reencDone === files.length)
                showLoading(`Re-encrypting files\u2026 ${_reencDone}/${files.length}`);
            return { id: f.id, cid: f.cid, iv: Array.from(iv), blob };
        }));
        const reencFiles = reencResults
            .filter(r => r.status === 'fulfilled')
            .map(r => r.value);
        if (reencFiles.length) await DB.saveFiles(reencFiles);

        // Re-encrypt lazyWorkspace manifest if present (imported-but-never-unlocked containers)
        if (c.lazyWorkspace) {
            showLoading('Re-encrypting workspace…');
            const { bin, mIv, mBlob } = c.lazyWorkspace;
            const manifestBuf = await Crypto.decryptBin(oldKey, Array.from(mIv), mBlob.buffer || mBlob);
            const reEnc = await Crypto.encryptBin(newKey, manifestBuf);
            c.lazyWorkspace = {
                bin,
                mIv: new Uint8Array(reEnc.iv),
                mBlob: new Uint8Array(reEnc.blob),
            };
        }

        // New verification blob
        showLoading('Finalizing…');
        const { iv: verIv, blob: verBlob } = await Crypto.makeVerification(newKey);

        // Update container metadata
        c.salt = newSalt;
        c.verIv = verIv;
        c.verBlob = verBlob;
        await DB.saveContainer(c);

        // Clear any stored sessions (password changed)
        clearSession(c.id);

        hideLoading();
        toast(`Password for "${c.name}" changed successfully`, 'success');
        Home.render();
    } catch (e) {
        if (_cpInModal) {
            okBtn.disabled = false;
            errEl.innerHTML = `${_ERR_SVG} ${e.message}`;
        } else {
            hideLoading();
            toast('Change password failed: ' + e.message, 'error');
        }
        console.error(e);
    }
}

/* ---- Rename Container ---- */
function openRenameContainerModal(c) {
    document.getElementById('rc-name').value = c.name;
    document.getElementById('rc-error').textContent = '';
    document.getElementById('rc-ok')._container = c;
    Overlay.show('modal-rename-container');
    setTimeout(() => {
        const inp = document.getElementById('rc-name');
        inp.focus(); inp.select();
    }, 100);
}

async function doRenameContainer() {
    const okBtn = document.getElementById('rc-ok'),
        c = okBtn._container;
    if (!c) return;
    const name = document.getElementById('rc-name').value.trim(),
        errEl = document.getElementById('rc-error');

    if (!name) { errEl.textContent = 'Enter a name'; return; }
    const nameRegex = /^[a-zA-Zа-яА-ЯёЁ0-9 _\-.,!()@#$%&+=]+$/;
    if (!nameRegex.test(name)) { errEl.textContent = 'Invalid characters in name'; return; }
    if (name.toLowerCase() === c.name.toLowerCase()) { Overlay.hide(); return; }

    const existing = await DB.getContainers();
    if (existing.find(x => x.id !== c.id && x.name.toLowerCase() === name.toLowerCase())) {
        errEl.textContent = 'A container with this name already exists'; return;
    }

    c.name = name;
    await DB.saveContainer(c);
    Overlay.hide();
    toast(`Container renamed to "${name}"`, 'success');
    Home.render();
}

function confirmDeleteContainer(c) {
    document.getElementById('dc-name').textContent = c.name;
    document.getElementById('dc-msg').textContent =
        `Container "${c.name}" and ALL its files will be permanently erased. This cannot be undone.`;
    const okBtn = document.getElementById('dc-ok'),
        okLabel = document.getElementById('dc-ok-label');
    okBtn._container = c;
    okBtn.disabled = true;
    Overlay.show('modal-del-container');

    // 3-second countdown before allowing delete
    let remaining = 3;
    okLabel.textContent = `Wait\u2026 ${remaining}`;
    const timer = setInterval(() => {
        remaining--;
        if (remaining > 0) {
            okLabel.textContent = `Wait\u2026 ${remaining}`;
        } else {
            clearInterval(timer);
            okBtn.disabled = false;
            okLabel.textContent = 'Delete Forever';
        }
    }, 1000);

    // Cancel countdown if modal is dismissed
    okBtn._countdownTimer = timer;
}

/* ============================================================
   NEW CONTAINER
   ============================================================ */
let _hwSaltData = null;

/** CRC-32 of a string (for stable UA fingerprint) */
function _crc32str(str) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < str.length; i++) {
        crc ^= str.charCodeAt(i);
        for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
    }
    return ((crc ^ 0xFFFFFFFF) >>> 0).toString(16).padStart(8, '0');
}

/** Derived UA fingerprint as hex string */
function _uaCrc() { return _crc32str(navigator.userAgent); }

const _KEY_ICON = `<svg width="13" height="13" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="1" y="6" width="9" height="7" rx="1.2" stroke="currentColor" stroke-width="1.3"/><path d="M3.5 6V4a2.5 2.5 0 015 0v2" stroke="currentColor" stroke-width="1.3" stroke-linecap="square"/><circle cx="11.5" cy="5.5" r="1.8" stroke="currentColor" stroke-width="1.2"/><path d="M11.5 7.3V9.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>`;

const _HW_STATES = {
    idle: () => `${_KEY_ICON}<span>Use passkey for salt</span>`,
    loading: () => `<div class="spinner" style="width:11px;height:11px;border-width:1.5px;flex-shrink:0"></div><span>Connecting…</span>`,
    ok: () => `<svg width="12" height="12" viewBox="0 0 12 12" fill="none" style="color:var(--green);flex-shrink:0"><path d="M1.5 6l3 3 6-6" stroke="currentColor" stroke-width="1.5" stroke-linecap="square"/></svg><span style="color:var(--green)">Salt secured</span>`,
    fail: () => `${_KEY_ICON}<span>Use passkey for salt</span>`,
    unavailable: () => `${_KEY_ICON}<span>Use passkey for salt</span>`,
};

/**
 * Returns a human-readable reason why WebAuthn cannot be used,
 * or null if the API appears available (sync checks only).
 */
function _webAuthnUnavailableReason() {
    if (!window.isSecureContext)
        return 'Requires a secure context (HTTPS or localhost)';
    if (typeof window.PublicKeyCredential === 'undefined')
        return 'WebAuthn is not supported in this browser';
    if (!navigator.credentials || typeof navigator.credentials.create !== 'function')
        return 'Credentials API is not available in this browser';
    return null;
}

function _setHwBtn(state) {
    const btn = document.getElementById('nc-hwkey-btn');
    if (!btn) return;
    btn.innerHTML = _HW_STATES[state]();
    btn.disabled = (state === 'loading' || state === 'ok' || state === 'unavailable');
}

async function _hwKeyBtnClick() {
    _setHwBtn('loading');
    try {
        _hwSaltData = await _webAuthnSalt();
        _setHwBtn('ok');
    } catch (e) {
        _hwSaltData = null;
        _setHwBtn('idle');
    }
}

function openNewContainerModal() {
    document.getElementById('nc-name').value = '';
    document.getElementById('nc-pw').value = '';
    document.getElementById('nc-pw2').value = '';
    document.getElementById('nc-pw-strength').style.width = '0%';
    document.getElementById('nc-pw-strength-label').textContent = '';
    document.getElementById('nc-agree').checked = false;
    document.getElementById('nc-create').disabled = true;
    // Reset hardware key button
    _hwSaltData = null;
    const hwBtn = document.getElementById('nc-hwkey-btn');
    if (hwBtn) {
        hwBtn.classList.add('show');
        const unavailReason = _webAuthnUnavailableReason();
        if (unavailReason) {
            _setHwBtn('unavailable');
            hwBtn.title = unavailReason;
        } else {
            _setHwBtn('idle');
            hwBtn.title = 'Mix passkey entropy into salt';
            // Async check: does this device actually have a platform authenticator?
            if (typeof PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable === 'function') {
                PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()
                    .then(ok => {
                        if (!ok) {
                            _setHwBtn('unavailable');
                            hwBtn.title = 'No platform authenticator available on this device';
                        }
                    })
                    .catch(() => {
                        _setHwBtn('unavailable');
                        hwBtn.title = 'Platform authenticator check failed';
                    });
            }
        }
    }
    Overlay.show('modal-new-container');
    setTimeout(() => document.getElementById('nc-name').focus(), 100);
}

/** Generate salt using WebAuthn passkey mixed with CSPRNG */
async function _webAuthnSalt() {
    const challenge = crypto.getRandomValues(new Uint8Array(32)),
        userId = crypto.getRandomValues(new Uint8Array(16));
    const cred = await navigator.credentials.create({
        publicKey: {
            challenge,
            rp: { name: 'SafeNova' },
            user: { id: userId, name: `safenova-${_uaCrc()}`, displayName: 'SafeNova' },
            pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
            authenticatorSelection: { userVerification: 'required' },
            attestation: 'none',
            timeout: 60000,
        }
    });
    // Mix authenticatorData with CSPRNG for the final 32-byte salt
    const authData = new Uint8Array(cred.response.authenticatorData || cred.response.clientDataJSON);
    const rng = crypto.getRandomValues(new Uint8Array(32));
    const combined = new Uint8Array(authData.length + rng.length);
    combined.set(authData, 0);
    combined.set(rng, authData.length);
    const hashBuf = await crypto.subtle.digest('SHA-256', combined);
    return Array.from(new Uint8Array(hashBuf));
}

async function createContainer() {
    const name = document.getElementById('nc-name').value.trim(),
        pw = document.getElementById('nc-pw').value,
        pw2 = document.getElementById('nc-pw2').value;

    if (!name) { toast('Enter a container name', 'error'); return; }
    // Allow only letters (Latin + Cyrillic), digits, spaces, and safe filename chars
    const nameRegex = /^[a-zA-Zа-яА-ЯёЁ0-9 _\-.,!()@#$%&+=]+$/;
    if (!nameRegex.test(name)) {
        toast('Container name contains invalid characters. Use letters, digits, spaces, and safe symbols only', 'error'); return;
    } if (!document.getElementById('nc-agree').checked) { toast('Please accept the data responsibility terms', 'error'); return; } if (pw.length < 4) { toast('Password must be at least 4 characters', 'error'); return; }
    if (pw !== pw2) { toast('Passwords do not match', 'error'); return; }

    const existing = await DB.getContainers();
    if (existing.find(c => c.name.toLowerCase() === name.toLowerCase())) {
        toast('A container with this name already exists', 'error'); return;
    }

    // Check device storage before creating
    const spCheck = await checkStorageSpace(1024 * 1024); // minimal overhead
    if (!spCheck.ok) {
        toast(`Not enough device storage (${fmtSize(spCheck.available)} available)`, 'error'); return;
    }

    showLoading('Creating container and deriving key...');
    Overlay.hide();
    try {
        const salt = _hwSaltData || Array.from(crypto.getRandomValues(new Uint8Array(32))),
            key = await Crypto.deriveKey(pw, new Uint8Array(salt));
        const { iv, blob } = await Crypto.makeVerification(key);

        VFS.init();
        const vfsStr = JSON.stringify(VFS.toObj()),
            { iv: vfsIv, blob: vfsBlobB64 } = await Crypto.encrypt(key, vfsStr);

        const container = {
            id: uid(), name, createdAt: Date.now(),
            salt, verIv: iv, verBlob: blob,
            totalSize: 0
        };
        await DB.saveContainer(container);
        await DB.saveVFS(container.id, vfsIv, vfsBlobB64);
        toast(`Container "${name}" created`, 'success');
        await Home.render();
    } catch (e) { toast('Error: ' + e.message, 'error'); console.error(e); }
    hideLoading();
}

function updatePwStrength(pw) {
    const s = pwStrength(pw),
        pct = [0, 20, 40, 60, 80, 100][s],
        colors = ['#555', '#f44747', '#ce9178', '#dcdcaa', '#6a9955', '#4ec9b0'],
        labels = ['', 'Very Weak', 'Weak', 'Fair', 'Strong', 'Very Strong'],
        bar = document.getElementById('nc-pw-strength'),
        lbl = document.getElementById('nc-pw-strength-label');
    bar.style.width = pct + '%';
    bar.style.background = colors[s];
    lbl.textContent = pw.length ? labels[s] : '';
    lbl.style.color = colors[s];
}

/* ============================================================
   UNLOCK VIEW
   ============================================================ */
let _unlockContainer = null;
const _failCounts = new Map(); // containerId → { count, lockUntil }

function _startUnlockCooldown(c) {
    const fails = _failCounts.get(c.id);
    _startAttemptCooldown(
        document.getElementById('unlock-error'),
        document.getElementById('btn-unlock'),
        () => { if (fails) fails.lockUntil = 0; }
    );
}

function openUnlockView(c) {
    _unlockContainer = c;
    document.getElementById('unlock-name').textContent = c.name;
    document.getElementById('unlock-pw').value = '';
    document.getElementById('unlock-error').innerHTML = '';
    document.getElementById('unlock-spinner').classList.remove('show');
    // Pre-fill checkbox and scope based on saved session
    const hasSessT = !!sessionStorage.getItem('snv-s-' + c.id),
        hasSessW = !!localStorage.getItem('snv-sb-' + c.id),
        remEl = document.getElementById('unlock-remember'),
        opts = document.getElementById('remember-opts'),
        tabEl = document.getElementById('remember-tab'),
        brwEl = document.getElementById('remember-browser');
    if (remEl) {
        const remembered = hasSessT || hasSessW;
        remEl.checked = remembered;
        if (opts) {
            const radios = opts.querySelectorAll('input[type="radio"]'),
                labels = opts.querySelectorAll('.remember-opt');
            radios.forEach(r => r.disabled = !remembered);
            labels.forEach(l => l.classList.toggle('disabled', !remembered));
        }
        if (hasSessW && brwEl) brwEl.checked = true;
        else if (tabEl) tabEl.checked = true;
    }
    App.showView('unlock');
    setTimeout(() => document.getElementById('unlock-pw').focus(), 100);
}

// ── Tab deduplication guard ───────────────────────────────────

/** Show the session-conflict modal; `onConfirm` is called if the user
 *  chooses to force-close the other session. */
function _showSessionConflict(c, onConfirm) {
    document.getElementById('sc-cont-name').textContent = c.name;
    document.getElementById('sc-force').onclick = () => {
        _forceClaimSession(c.id);
        Overlay.hide();
        onConfirm?.();
    };
    document.getElementById('sc-cancel').onclick = () => Overlay.hide();
    Overlay.show('modal-session-conflict');
}

/**
 * Single entry point for opening any container.
 * Checks for cross-tab conflict FIRST (before any password prompt),
 * then resumes an existing session or shows the unlock view.
 */
async function _tryOpenContainer(c) {
    if (_checkContainerSession(c.id)) {
        _showSessionConflict(c, async () => {
            // Other tab has been kicked — proceed with open
            const savedPw = await loadSession(c.id);
            if (savedPw) _resumeSession(c, savedPw); else openUnlockView(c);
        });
        return;
    }
    const savedPw = await loadSession(c.id);
    if (savedPw) _resumeSession(c, savedPw); else openUnlockView(c);
}
// ────────────────────────────────────────────────────────────────

async function doUnlock() {
    const c = _unlockContainer; if (!c) return;
    const pw = document.getElementById('unlock-pw').value;
    if (!pw) { document.getElementById('unlock-error').innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M8 1.5a6.5 6.5 0 100 13 6.5 6.5 0 000-13zM7.25 5h1.5v4h-1.5V5zm0 5h1.5v1.5h-1.5V10z" fill="currentColor"/></svg> Enter password'; return; }

    // Brute-force protection: check if currently locked out
    const fails = _failCounts.get(c.id) || { count: 0, lockUntil: 0 };
    if (fails.lockUntil > Date.now()) return; // button is already disabled during lockout

    document.getElementById('unlock-error').innerHTML = '';
    document.getElementById('unlock-spinner').classList.add('show');
    document.getElementById('btn-unlock').disabled = true;

    try {
        const { key, raw: _sessionRawKey } = await Crypto.deriveKeyAndRaw(pw, new Uint8Array(c.salt)),
            ok = await Crypto.checkVerification(key, c.verIv, c.verBlob);

        if (!ok) {
            fails.count++;
            _failCounts.set(c.id, fails);
            document.getElementById('unlock-spinner').classList.remove('show');
            if (fails.count > 3) {
                fails.lockUntil = Date.now() + 3000;
                _startUnlockCooldown(c);
            } else {
                document.getElementById('unlock-error').innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M8 1.5a6.5 6.5 0 100 13 6.5 6.5 0 000-13zM7.25 5h1.5v4h-1.5V5zm0 5h1.5v1.5h-1.5V10z" fill="currentColor"/></svg> Incorrect password';
                document.getElementById('btn-unlock').disabled = false;
            }
            return;
        }

        // Load VFS (detect binary vs legacy base64 format)
        const vfsRec = await DB.getVFS(c.id);
        if (vfsRec) {
            try {
                const buf = typeof vfsRec.blob === 'string'
                    ? await Crypto.decrypt(key, vfsRec.iv, vfsRec.blob)
                    : await Crypto.decryptBin(key, vfsRec.iv, vfsRec.blob);
                const json = JSON.parse(new TextDecoder().decode(buf));
                VFS.fromObj(json);
            } catch { VFS.init(); }
        } else { VFS.init(); }

        // Expand lazy workspace if this container was imported without a password
        let _activeCont = c;
        if (c.lazyWorkspace) {
            showLoading('Restoring files from import\u2026');
            try {
                const { bin, mIv, mBlob } = c.lazyWorkspace;
                const decBuf = await Crypto.decryptBin(key, Array.from(mIv), mBlob.buffer || mBlob);
                const manifest = JSON.parse(new TextDecoder().decode(decBuf));
                const filesToSave = manifest.map(m => ({
                    id: m.id, cid: c.id,
                    iv: Array.from(Uint8Array.from(atob(m.ivB64), ch => ch.charCodeAt(0))),
                    blob: bin.slice(m.offset, m.offset + m.size).buffer
                }));
                await DB.saveFiles(filesToSave);
                const cleanCont = Object.assign({}, c);
                delete cleanCont.lazyWorkspace;
                await DB.saveContainer(cleanCont);
                _activeCont = cleanCont;
                _unlockContainer = cleanCont;
            } catch (expandErr) {
                console.error('Lazy expand failed', expandErr);
                toast('Could not restore files from import', 'error');
            }
            hideLoading();
        }

        _failCounts.delete(c.id); // reset fail count on successful unlock

        App.container = _activeCont;
        App.key = key;
        App.folder = 'root';
        App.selection.clear();
        _startContainerSession(_activeCont.id);
        App.showView('desktop');
        if (typeof _applySettings === 'function') _applySettings(_getSettings(), true);
        if (typeof _resetAutoLockTimer === 'function') _resetAutoLockTimer();
        Desktop.render();
        toast(`Container "${c.name}" unlocked`, 'success');
        // Save or clear session based on checkbox — uses rawKey already derived above (no second Argon2)
        const remEl = document.getElementById('unlock-remember');
        if (remEl && remEl.checked) {
            const scope = document.querySelector('input[name="remember-scope"]:checked')?.value || 'tab';
            try {
                await saveSession(c.id, _sessionRawKey, scope);
            } catch { /* non-critical */ }
        } else {
            // Checkbox unchecked — clear any previously saved session
            clearSession(c.id);
        }
    } catch (e) {
        document.getElementById('unlock-error').innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M8 1.5a6.5 6.5 0 100 13 6.5 6.5 0 000-13zM7.25 5h1.5v4h-1.5V5zm0 5h1.5v1.5h-1.5V10z" fill="currentColor"/></svg> ' + escHtml(e.message);
        console.error(e);
    }
    document.getElementById('unlock-spinner').classList.remove('show');
    document.getElementById('btn-unlock').disabled = false;
}

/* ============================================================
   DELETE CONTAINER (confirmed with password)
   ============================================================ */
async function deleteContainerConfirmed() {
    const okBtn = document.getElementById('dc-ok');
    const c = okBtn._container; if (!c) return;
    if (okBtn.disabled) return;

    // Clear countdown timer if still running
    if (okBtn._countdownTimer) { clearInterval(okBtn._countdownTimer); okBtn._countdownTimer = null; }

    showLoading('Erasing container...');
    Overlay.hide();
    try {
        await DB.nukeContainer(c.id);
        // Also clear any remembered session for this container
        clearSession(c.id);
        hideLoading();
        await Home.render();
        toast(`Container \"${c.name}\" deleted`, 'info');
    } catch (e) {
        hideLoading();
        toast('Delete failed: ' + e.message, 'error');
    }
}

/* ============================================================
   SESSION RESUME  —  auto-unlock using stored sessionStorage password
   ============================================================ */
async function _resumeSession(c, rawKeyBytes) {
    showLoading('Restoring session...');
    try {
        const key = await Crypto.importRawKey(rawKeyBytes),
            ok = await Crypto.checkVerification(key, c.verIv, c.verBlob);
        if (!ok) {
            // Stored session is invalid (password changed?) — clear it and open unlock view
            clearSession(c.id);
            hideLoading();
            openUnlockView(c);
            return;
        }
        const vfsRec = await DB.getVFS(c.id);
        if (vfsRec) {
            try {
                const buf = typeof vfsRec.blob === 'string'
                    ? await Crypto.decrypt(key, vfsRec.iv, vfsRec.blob)
                    : await Crypto.decryptBin(key, vfsRec.iv, vfsRec.blob);
                const json = JSON.parse(new TextDecoder().decode(buf));
                VFS.fromObj(json);
            } catch { VFS.init(); }
        } else { VFS.init(); }

        // Defensive: expand lazyWorkspace if somehow present at session resume
        if (c.lazyWorkspace) {
            try {
                const { bin, mIv, mBlob } = c.lazyWorkspace;
                const decBuf = await Crypto.decryptBin(key, Array.from(mIv), mBlob.buffer || mBlob);
                const manifest = JSON.parse(new TextDecoder().decode(decBuf));
                const filesToSave = manifest.map(m => ({
                    id: m.id, cid: c.id,
                    iv: Array.from(Uint8Array.from(atob(m.ivB64), ch => ch.charCodeAt(0))),
                    blob: bin.slice(m.offset, m.offset + m.size).buffer
                }));
                await DB.saveFiles(filesToSave);
                const cleanCont = Object.assign({}, c);
                delete cleanCont.lazyWorkspace;
                await DB.saveContainer(cleanCont);
                c = cleanCont;
            } catch (expandErr) {
                console.error('Lazy expand in resume failed', expandErr);
            }
        }

        App.container = c;
        App.key = key;
        App.folder = 'root';
        App.selection.clear();
        _startContainerSession(c.id);
        App.showView('desktop');
        if (typeof _applySettings === 'function') _applySettings(_getSettings(), true);
        if (typeof _resetAutoLockTimer === 'function') _resetAutoLockTimer();
        Desktop.render();
        toast(`Session for "${c.name}" restored`, 'success');
    } catch (e) {
        hideLoading();
        toast('Resume failed: ' + e.message, 'error');
        openUnlockView(c);
        return;
    }
    hideLoading();
}
