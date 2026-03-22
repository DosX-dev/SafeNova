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

    /* ---- Block native browser context menu globally ---- */
    document.addEventListener('contextmenu', e => { e.preventDefault(); });

    /* ---- Desktop area events ---- */
    Desktop.initEvents();
}

/* ============================================================
   BOOT
   ============================================================ */
window.addEventListener('DOMContentLoaded', async () => {
    initEvents();
    await App.init();
});

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
// Both beforeunload (desktop) and pagehide (mobile / bfcache) are needed.
function _onTabUnload() {
    if (App.container?.id) _stopContainerSession(App.container.id);
}
window.addEventListener('beforeunload', _onTabUnload);
window.addEventListener('pagehide', _onTabUnload);
