'use strict';

/* ============================================================
   CONSOLE SECURITY WARNING
   ============================================================ */
(function consoleSecurityWarning() {
    const W = 60,
        pad = s => s + ' '.repeat(Math.max(0, W - s.length)),
        row = s => `║ ${pad(s)} ║`,
        top = `╔${'═'.repeat(W + 2)}╗`,
        bot = `╚${'═'.repeat(W + 2)}╝`,
        sep = `╠${'═'.repeat(W + 2)}╣`,
        _ = row('');

    const box = [
        top,
        _,
        row('  DO NOT paste any code or commands into this console.'),
        row('  Not from the internet. Not from anyone. For any reason.'),
        _,
        sep,
        _,
        row('  A single malicious snippet can silently:'),
        row('    \u203a  intercept and exfiltrate your encryption keys'),
        row('    \u203a  dump the entire local file storage in plaintext'),
        row('    \u203a  steal your container password as you type'),
        row('    \u203a  re-encrypt your files with an attacker-controlled key'),
        _,
        sep,
        _,
        row('  [!] Only use this console if you know what you are doing.'),
        row('      If someone told you to paste something here \u2014'),
        row('      you are being socially engineered.'),
        _,
        bot,
    ].join('\n');

    const show = () => console.log(
        '%c STOP %c SafeNova \u2014 Security Warning\n%c\n' + box,
        'font-size:13px;font-weight:900;color:#1e1e1e;background:#f44747;padding:2px 10px;border-radius:2px;font-family:Consolas,monospace',
        'font-size:13px;font-weight:700;color:#f44747;font-family:Consolas,monospace',
        'font-size:12px;color:#d4d4d4;line-height:1;font-family:Consolas,monospace'
    );
    show();
    setInterval(show, 5_000);
})();

/* ============================================================
   PASSWORD EYE TOGGLE
   ============================================================ */
function togglePwEye(inputId, btnId) {
    const input = document.getElementById(inputId),
        btn = document.getElementById(btnId);
    if (input.type === 'password') {
        input.type = 'text';
        btn.style.color = 'var(--accent)';
        btn.innerHTML = Icons.eyeoff;
    } else {
        input.type = 'password';
        btn.style.color = '';
        btn.innerHTML = Icons.eye;
    }
}

/* ============================================================
   EVENT LISTENERS
   ============================================================ */
function initEvents() {

    /* ---- Home ---- */
    document.getElementById('btn-new-container').addEventListener('click', openNewContainerModal);
    document.getElementById('btn-import-container').addEventListener('click', () => document.getElementById('import-container-input').click());
    document.getElementById('import-container-input').addEventListener('change', e => {
        const file = e.target.files[0];
        if (file) importContainerFile(file);
        e.target.value = '';
    });

    /* ---- New Container Modal ---- */
    document.getElementById('nc-pw').addEventListener('input', e => updatePwStrength(e.target.value));
    document.getElementById('nc-pw-eye').addEventListener('click', () => togglePwEye('nc-pw', 'nc-pw-eye'));
    document.getElementById('nc-create').addEventListener('click', createContainer);
    document.getElementById('nc-cancel').addEventListener('click', () => Overlay.hide());
    document.getElementById('modal-nc-close').addEventListener('click', () => Overlay.hide());
    document.getElementById('nc-agree').addEventListener('change', e => {
        document.getElementById('nc-create').disabled = !e.target.checked;
    });
    document.getElementById('nc-hwkey-btn')?.addEventListener('click', _hwKeyBtnClick);
    document.getElementById('nc-name').addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('nc-pw').focus(); });
    document.getElementById('nc-pw').addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('nc-pw2').focus(); });
    document.getElementById('nc-pw2').addEventListener('keydown', e => { if (e.key === 'Enter') createContainer(); });

    /* ---- Unlock ---- */
    document.getElementById('btn-back').addEventListener('click', () => App.showView('home'));
    document.getElementById('btn-unlock').addEventListener('click', doUnlock);
    document.getElementById('unlock-pw').addEventListener('keydown', e => { if (e.key === 'Enter') doUnlock(); });
    document.getElementById('unlock-pw-eye').addEventListener('click', () => togglePwEye('unlock-pw', 'unlock-pw-eye'));

    /* ---- Export password modal eye toggle ---- */
    document.getElementById('exp-eye')?.addEventListener('click', () => {
        const inp = document.getElementById('exp-pw');
        const show = inp.type === 'password';
        inp.type = show ? 'text' : 'password';
        document.querySelector('#exp-eye .eye-open').style.display = show ? 'none' : '';
        document.querySelector('#exp-eye .eye-closed').style.display = show ? '' : 'none';
    });

    /* ---- Remember scope toggle ---- */
    document.getElementById('unlock-remember').addEventListener('change', e => {
        const opts = document.getElementById('remember-opts');
        if (!opts) return;
        const radios = opts.querySelectorAll('input[type="radio"]'),
            labels = opts.querySelectorAll('.remember-opt');
        radios.forEach(r => r.disabled = !e.target.checked);
        labels.forEach(l => l.classList.toggle('disabled', !e.target.checked));
    });

    /* ---- Desktop toolbar ---- */
    document.getElementById('btn-lock').addEventListener('click', () => App.backToMenu());
    document.getElementById('btn-lock-taskbar').addEventListener('click', () => App.lockContainer());

    document.getElementById('btn-upload-toolbar').addEventListener('click', () => document.getElementById('file-input').click());
    document.getElementById('btn-new-file-toolbar').addEventListener('click', newTextFile);
    document.getElementById('btn-new-folder-toolbar').addEventListener('click', newFolder);
    document.getElementById('btn-settings').addEventListener('click', openSettings);
    document.getElementById('settings-close').addEventListener('click', () => Overlay.hide());
    document.getElementById('settings-ok').addEventListener('click', () => Overlay.hide());
    document.getElementById('file-input').addEventListener('change', e => {
        uploadFiles(Array.from(e.target.files));
        e.target.value = '';
    });

    /* ---- Text Editor ---- */
    document.getElementById('btn-save-editor').addEventListener('click', saveEditor);
    document.getElementById('editor-close').addEventListener('click', closeEditor);
    document.getElementById('editor-textarea').addEventListener('keydown', e => {
        if (e.ctrlKey && e.code === 'KeyS') { e.preventDefault(); saveEditor(); }
    });

    /* ---- Unsaved-changes dialog buttons ---- */
    document.getElementById('editor-unsaved-cancel').addEventListener('click', () => {
        document.getElementById('editor-unsaved-dialog').style.display = 'none';
    });
    document.getElementById('editor-unsaved-discard').addEventListener('click', () => {
        document.getElementById('editor-unsaved-dialog').style.display = 'none';
        discardEditor();
    });
    document.getElementById('editor-unsaved-save').addEventListener('click', async () => {
        document.getElementById('editor-unsaved-dialog').style.display = 'none';
        await saveAndCloseEditor();
    });

    /* ---- File Viewer ---- */
    document.getElementById('viewer-close').addEventListener('click', closeViewer);

    /* ---- Properties ---- */
    document.getElementById('props-close').addEventListener('click', () => Overlay.hide());
    document.getElementById('props-ok').addEventListener('click', () => Overlay.hide());

    /* ---- Rename ---- */
    document.getElementById('rename-close').addEventListener('click', () => Overlay.hide());
    document.getElementById('rename-cancel').addEventListener('click', () => Overlay.hide());
    document.getElementById('rename-input').addEventListener('keydown', e => {
        if (e.key === 'Enter') document.getElementById('rename-ok').click();
    });

    /* ---- Delete confirm ---- */
    document.getElementById('delete-close').addEventListener('click', () => Overlay.hide());
    document.getElementById('delete-cancel').addEventListener('click', () => Overlay.hide());

    /* ---- New Text File ---- */
    document.getElementById('nf-close').addEventListener('click', () => Overlay.hide());
    document.getElementById('nf-cancel').addEventListener('click', () => Overlay.hide());
    document.getElementById('nf-ok').addEventListener('click', createTextFile);
    document.getElementById('nf-name').addEventListener('keydown', e => { if (e.key === 'Enter') createTextFile(); });

    /* ---- New Folder ---- */
    document.getElementById('nd-close').addEventListener('click', () => Overlay.hide());
    document.getElementById('nd-cancel').addEventListener('click', () => Overlay.hide());
    document.getElementById('nd-ok').addEventListener('click', createFolder);
    document.getElementById('nd-name').addEventListener('keydown', e => { if (e.key === 'Enter') createFolder(); });

    /* ---- Delete Container ---- */
    document.getElementById('dc-close').addEventListener('click', () => {
        const t = document.getElementById('dc-ok')._countdownTimer;
        if (t) { clearInterval(t); document.getElementById('dc-ok')._countdownTimer = null; }
        Overlay.hide();
    });
    document.getElementById('dc-cancel').addEventListener('click', () => {
        const t = document.getElementById('dc-ok')._countdownTimer;
        if (t) { clearInterval(t); document.getElementById('dc-ok')._countdownTimer = null; }
        Overlay.hide();
    });
    document.getElementById('dc-ok').addEventListener('click', deleteContainerConfirmed);

    /* ---- Change Password ---- */
    document.getElementById('cp-close').addEventListener('click', () => Overlay.hide());
    document.getElementById('cp-cancel').addEventListener('click', () => Overlay.hide());
    document.getElementById('cp-ok').addEventListener('click', doChangePassword);
    document.getElementById('cp-old-eye').addEventListener('click', () => togglePwEye('cp-old', 'cp-old-eye'));
    document.getElementById('cp-new-eye').addEventListener('click', () => togglePwEye('cp-new', 'cp-new-eye'));
    document.getElementById('cp-new').addEventListener('input', e => updatePwStrength(e.target.value, 'cp-pw-strength', 'cp-pw-strength-label'));

    /* ---- Duress password eyes ---- */
    document.getElementById('duress-pw-eye').innerHTML = Icons.eye;
    document.getElementById('duress-pw-eye').addEventListener('click', () => togglePwEye('duress-pw', 'duress-pw-eye'));

    document.getElementById('cp-old').addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('cp-new').focus(); });
    document.getElementById('cp-new').addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('cp-new2').focus(); });
    document.getElementById('cp-new2').addEventListener('keydown', e => { if (e.key === 'Enter') doChangePassword(); });

    /* ---- Rename Container ---- */
    document.getElementById('rc-close').addEventListener('click', () => Overlay.hide());
    document.getElementById('rc-cancel').addEventListener('click', () => Overlay.hide());
    document.getElementById('rc-ok').addEventListener('click', doRenameContainer);
    document.getElementById('rc-name').addEventListener('keydown', e => { if (e.key === 'Enter') doRenameContainer(); });

    /* ---- Export Confirm ---- */
    document.getElementById('ec-close').addEventListener('click', () => Overlay.hide());
    document.getElementById('ec-cancel').addEventListener('click', () => Overlay.hide());

    /* ---- Overlay background click ---- */
    let _overlayMousedownOnBg = false;
    const _overlayEl = document.getElementById('modal-overlay');
    _overlayEl.addEventListener('mousedown', e => {
        _overlayMousedownOnBg = (e.target === _overlayEl);
    });
    _overlayEl.addEventListener('click', e => {
        if (!_overlayMousedownOnBg || e.target !== _overlayEl) return;
        _overlayMousedownOnBg = false;
        const active = Overlay.current;
        if (active === 'modal-editor') closeEditor();
        else if (active === 'modal-viewer') closeViewer();
        else {
            // Clear delete-container countdown if running
            const t = document.getElementById('dc-ok')._countdownTimer;
            if (t) { clearInterval(t); document.getElementById('dc-ok')._countdownTimer = null; }
            Overlay.hide();
        }
    });

    /* ---- Block Ctrl+S system save globally (editor handles its own Ctrl+S) ---- */
    document.addEventListener('keydown', e => {
        if (e.ctrlKey && e.code === 'KeyS' && Overlay.current !== 'modal-editor') {
            e.preventDefault();
        }
    }, true);

    /* ---- Mobile burger menu ---- */
    (function initBurger() {
        const burger = document.getElementById('topbar-burger');
        const dd = document.getElementById('topbar-dropdown');
        if (!burger || !dd) return;

        const _close = () => dd.classList.remove('open'),
            _toggle = () => dd.classList.toggle('open');

        burger.addEventListener('click', e => { e.stopPropagation(); _toggle(); });

        // Proxy clicks in dropdown to real toolbar buttons
        document.getElementById('topbar-dd-settings')?.addEventListener('click', () => { _close(); document.getElementById('btn-settings').click(); });
        document.getElementById('topbar-dd-upload')?.addEventListener('click', () => { _close(); document.getElementById('btn-upload-toolbar').click(); });
        document.getElementById('topbar-dd-newfile')?.addEventListener('click', () => { _close(); document.getElementById('btn-new-file-toolbar').click(); });
        document.getElementById('topbar-dd-newfolder')?.addEventListener('click', () => { _close(); document.getElementById('btn-new-folder-toolbar').click(); });

        // Close dropdown on tap outside
        document.addEventListener('touchstart', e => {
            if (!e.target.closest('#topbar-dropdown') && !e.target.closest('#topbar-burger')) _close();
        }, { passive: true });
        document.addEventListener('mousedown', e => {
            if (!e.target.closest('#topbar-dropdown') && !e.target.closest('#topbar-burger')) _close();
        });
        // Close on Escape
        document.addEventListener('keydown', e => { if (e.key === 'Escape') _close(); });
    })();

    /* ---- Dismiss context menu ---- */
    document.addEventListener('mousedown', e => { if (!e.target.closest('.ctx-menu')) hideCtxMenu(); });
    document.addEventListener('touchstart', e => { if (!e.target.closest('.ctx-menu')) hideCtxMenu(); }, { passive: true });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') hideCtxMenu(); });

    /* ---- End key: lock container (only on desktop/folder view, not in text fields) ---- */
    document.addEventListener('keydown', e => {
        if (e.key !== 'End') return;
        const tag = document.activeElement?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || document.activeElement?.isContentEditable) return;
        if (!App.key || !App.container) return;
        App.lockContainer();
    });

    /* ---- Block native browser context menu globally ---- */
    document.addEventListener('contextmenu', e => { e.preventDefault(); });

    /* ---- Desktop area events ---- */
    Desktop.initEvents();
}

/* ============================================================
   BOOT
   ============================================================ */
window.addEventListener('DOMContentLoaded', async () => {
    // SafeNova Proactive must be loaded and active before the app starts.
    // daemon.js is injected in <head> before all other scripts; if it
    // failed to load for any reason the guard token will be absent.
    // v4: __snvVerify() does canary cross-check (guards against pre-defined __snvGuard).
    // Legacy fallback: if __snvVerify is absent (v3), fall back to __snvGuard.active alone.
    const _snvOk = typeof window.__snvVerify === 'function'
        ? window.__snvVerify() === true
        : window.__snvGuard?.active === true;
    if (!_snvOk) {
        const ol = document.getElementById('loading-overlay');
        if (ol) {
            ol.innerHTML = `
              <div style="text-align:center;max-width:380px;padding:0 24px">
                <svg width="44" height="44" viewBox="0 0 24 24" fill="none" style="color:#f44747;margin-bottom:16px" xmlns="http://www.w3.org/2000/svg">
                  <path d="M12 2L3 7v5c0 5.25 3.75 10.15 9 11.35C17.25 22.15 21 17.25 21 12V7z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>
                  <path d="M12 8v5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
                  <circle cx="12" cy="16" r="1" fill="currentColor"/>
                </svg>
                <div style="color:var(--text);font-size:16px;font-weight:600;margin-bottom:8px">SafeNova Proactive failed to initialize</div>
                <div style="color:var(--text-dim);font-size:13px;line-height:1.7">
                  The runtime protection module did not load.<br>
                  The application cannot start without it.
                </div>
              </div>`;
            ol.style.cssText += 'display:flex;opacity:1;pointer-events:all;';
        }
        return;
    }
    InitLog.start();
    InitLog.step('initEvents');
    initEvents();
    InitLog.done('initEvents');
    try {
        await App.init();
        // Incognito / private-mode check — show warning once per session
        if (!sessionStorage.getItem('snv-incognito-warned')) {
            const { isPrivate } = await detectIncognito();
            if (isPrivate) {
                await showIncognitoWarning();
                sessionStorage.setItem('snv-incognito-warned', '1');
            }
        }
    } catch (err) {
        InitLog.error('App.init', err);
        // Show a visible error instead of leaving the user on a grey screen
        const ol = document.getElementById('loading-overlay');
        if (ol) {
            ol.innerHTML = `
              <div style="text-align:center;max-width:380px;padding:0 24px">
                <svg width="44" height="44" viewBox="0 0 24 24" fill="none" style="color:#f44747;margin-bottom:16px" xmlns="http://www.w3.org/2000/svg">
                  <path d="M12 2L2 20h20z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>
                  <path d="M12 9v5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
                  <circle cx="12" cy="16.5" r="0.8" fill="currentColor"/>
                </svg>
                <div style="color:var(--text);font-size:16px;font-weight:600;margin-bottom:8px">Failed to initialize</div>
                <div style="color:var(--text-dim);font-size:13px;line-height:1.7;margin-bottom:16px">${escHtml(String(err?.message || err))}</div>
                <button class="btn btn-primary" onclick="location.reload()">Reload</button>
              </div>`;
            ol.style.cssText += 'display:flex;opacity:1;pointer-events:all;';
        }
    }
    InitLog.finish();
});

/* ============================================================
   SAFENOVA PROACTIVE — FORCE LOCK
   ============================================================ */
// Fired by daemon.js whenever a security threat is detected.
// F2: Call __snvEmergencyLock first — directly nukes storage and zeroes app state
// regardless of whether App.lockContainer was patched. Then also try lockContainer
// for full UI cleanup (close file editor, show lock screen).
// The reason from e.detail is shown as a toast so the user always sees why the
// container locked — even when _showAlert is blocked by its 10 s rate-limit.
window.addEventListener('snv:lock', e => {
    try { window.__snvEmergencyLock?.(); } catch { }
    if (typeof App !== 'undefined' && App.container) {
        const reason = e?.detail?.reason;
        if (typeof reason === 'string' && reason) toast(reason, 'warn');
        App.lockContainer();
    }
});

/* ============================================================
   SAFENOVA PROACTIVE — DEAD MAN'S SWITCH  (C1)
   ============================================================ */
// daemon.js dispatches 'snv:alive' every watchdog tick (~1 s).
// If the heartbeat goes silent for >3 s the watchdog was killed —
// lock all containers immediately so keys are not left in memory.
(() => {
    let _lastAlive = Date.now(), _lastHbN = 0;
    window.addEventListener('snv:alive', e => {
        // Only accept events with a strictly increasing monotonic counter (E5)
        // capped to a maximum jump of 15 per event.
        // Without the upper bound an attacker (Self-XSS / extension) can dispatch
        // snv:alive with n = Number.MAX_SAFE_INTEGER, permanently advancing _lastHbN
        // so all real daemon ticks (n=1,2,3…) are rejected → forced lockout in 3 s.
        //
        // The +15 bound was sized for "three slow mechanisms × ~1 tick/s = ~3 ticks/s"
        // (mechanisms 2/3/4). Mechanism 1 (setInterval 50 ms = 20 ticks/s) was added
        // later, bringing the real rate to ~23 ticks/s. At that rate, +15 covers only
        // ~650 ms of startup gap — far too small for a fresh browser session where the
        // ~485 KB of bottom-of-body scripts must be fetched over the network. During
        // those network fetches the main thread is idle and the daemon's 50 ms
        // setInterval fires freely, pushing _heartbeatN past 15 before this listener
        // is registered. Every subsequent real heartbeat then fails n <= _lastHbN + 15,
        // _lastAlive is never refreshed, and the DMS fires 3 s after unlock.
        //
        // Fix (bootstrap exemption): on the very first accepted event (_lastHbN === 0)
        // skip the upper-bound check entirely — any n > 0 is accepted. The daemon is
        // the only source of snv:alive events with a monotonically increasing counter,
        // so the first event is always genuine. After this single bootstrap event the
        // strict +15 window is restored, preserving the security guarantee that a
        // post-load fake-n jump > 15 cannot permanently silence the real heartbeat.
        const n = e?.detail?.n;
        const isBootstrap = (_lastHbN === 0);
        if (typeof n === 'number' && n > _lastHbN && (isBootstrap || n <= _lastHbN + 15)) {
            _lastHbN = n;
            _lastAlive = Date.now();
        }
    });
    let _dmsLocking = false;
    setInterval(() => {
        if (Date.now() - _lastAlive > 3000 && typeof App !== 'undefined' && App.container && !_dmsLocking) {
            // F2: __snvEmergencyLock nukes storage and zeroes app state directly,
            // bypassing a patched App.lockContainer. Then still try lockContainer
            // for UI cleanup (close editor, show lock screen).
            // _dmsLocking prevents re-entrant fires while lockContainer is still
            // running asynchronously (interval period < async completion time).
            _dmsLocking = true;
            // BUG-FIX: Pass the reason string so __snvEmergencyLock shows the alert
            // overlay (previously the user saw the animated veil with no explanation).
            try { window.__snvEmergencyLock?.('Security guard stopped responding \u2014 container locked for safety.'); } catch { }
            toast('Security guard stopped responding — container locked for safety.', 'warn');
            App.lockContainer().finally(() => { _dmsLocking = false; });
        }
    }, 1000);
})();

/* ============================================================
   CROSS-TAB SESSION GUARD
   ============================================================ */
// When another tab claims (or force-kicks) our container, lock immediately.
window.addEventListener('storage', e => {
    // ── Kick: another tab force-claimed our container ──────────
    if (App.container && e.key === 'snv-open-' + App.container.id) {
        try {
            const d = e.newValue ? JSON.parse(e.newValue) : null;
            if (d && d.tab !== _TAB_ID && d.kick) {
                App.lockContainer();
                toast('This container was opened in another tab — session ended.', 'warn');
            }
        } catch { /* ignore corrupt value */ }
    }

    // ── Session badge live-update: any session blob change ─────
    // When another tab saves or clears a remembered session, refresh the home
    // view so the "Session active" badge is immediately up-to-date.
    if (App.view === 'home' && e.key && (e.key.startsWith('snv-sb-') || e.key.startsWith('snv-s-'))) {
        Home.render();
    }
});

// Release the session claim on tab close / navigation.
// beforeunload (desktop) shows a dialog when an operation is in progress.
// pagehide (mobile / bfcache) fires on navigation but is NOT cancelable —
// calling e.preventDefault() or setting e.returnValue here is a spec no-op,
// so it only handles session cleanup.
function _onTabUnload(e) {
    if (_appBusy > 0) { e.preventDefault(); e.returnValue = ''; }
    if (App.container?.id) _stopContainerSession(App.container.id);
}
window.addEventListener('beforeunload', _onTabUnload);
window.addEventListener('pagehide', () => {
    if (App.container?.id) _stopContainerSession(App.container.id);
});

/* ============================================================
   SETTINGS HINT TOOLTIPS
   ============================================================ */
(function () {
    let _stip = null;

    document.addEventListener('mouseover', e => {
        const hint = e.target.closest('.settings-hint');
        if (!hint || !hint.dataset.tip) return;
        if (_stip) return;
        _stip = document.createElement('div');
        _stip.className = 'settings-tip';
        // Use \u2028 in data-tip as line separator — render as <br>
        _stip.innerHTML = hint.dataset.tip.split('\u2028').map(s => escHtml(s)).join('<br>');
        _stip.style.cssText = 'visibility:hidden';
        document.body.appendChild(_stip);
        const r = hint.getBoundingClientRect(),
            tw = _stip.offsetWidth,
            th = _stip.offsetHeight;
        let left = r.right + 8,
            top = r.top + (r.height / 2) - (th / 2);
        // Flip left if not enough room on the right
        if (left + tw > window.innerWidth - 8) left = r.left - tw - 8;
        // Clamp vertically
        top = Math.min(Math.max(top, 6), window.innerHeight - th - 6);
        _stip.style.cssText = `left:${left}px;top:${top}px`;
    });

    document.addEventListener('mouseout', e => {
        const hint = e.target.closest('.settings-hint');
        if (!hint) return;
        // Cursor moved to a child element of the same hint — don't destroy
        if (hint.contains(e.relatedTarget)) return;
        if (_stip) { _stip.remove(); _stip = null; }
    });
})();
