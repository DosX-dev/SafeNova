'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const root = path.join(__dirname, '../src');
const eyes = [
    ['export', 'exp-pw', 'exp-eye'], ['create', 'nc-pw', 'nc-pw-eye'],
    ['unlock', 'unlock-pw', 'unlock-pw-eye'], ['change', 'cp-old', 'cp-old-eye'],
    ['change', 'cp-new', 'cp-new-eye'], ['duress', 'duress-pw', 'duress-pw-eye'],
];

async function fixture(browser) {
    const page = await browser.newPage({ bypassCSP: true });
    const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<link\b[^>]*>/gi, '');
    await page.route('http://localhost/**', route => route.fulfill({ contentType: 'text/html', body: html }));
    await page.goto('http://localhost/');
    await page.addStyleTag({ content: fs.readFileSync(path.join(root, 'css/app.css'), 'utf8') });
    await page.evaluate(() => {
        window.App = {
            selection: new Set(), thumbCache: {}, folder: 'root', _winCtx: null, showView(view) {
                document.querySelectorAll('.view').forEach(el => el.classList.remove('active'));
                document.getElementById('view-' + view)?.classList.add('active');
                this.view = view;
            }
        };
        window.toast = window.showLoading = window.hideLoading = () => { };
    });
    for (const file of ['constants.js', 'vfs.js', 'desktop.js', 'fileops.js', 'home.js', 'main.js']) {
        await page.addScriptTag({ content: fs.readFileSync(path.join(root, 'js', file), 'utf8') });
    }
    const state = fs.readFileSync(path.join(root, 'js/state.js'), 'utf8'), start = state.indexOf('const Overlay = {');
    await page.addScriptTag({ content: state.slice(start, state.indexOf('\n};', start) + 3) });
    await page.evaluate(() => {
        Desktop.initEvents = () => { };
        initEvents();
        window.container = { id: 'test', name: 'Test' };
        window.openEye = kind => {
            if (kind === 'export') window.exporting = _askExportPassword(container);
            if (kind === 'create') openNewContainerModal();
            if (kind === 'unlock') openUnlockView(container);
            if (kind === 'change') openChangePasswordModal(container);
            if (kind === 'duress') { _resetDuressForm(); Overlay.show('modal-settings'); }
        };
        window.revealEye = id => {
            for (let el = document.getElementById(id); el; el = el.parentElement) {
                if (getComputedStyle(el).display === 'none') el.style.display = 'block';
            }
        };
        window.eyeState = (inputId, buttonId) => {
            const input = document.getElementById(inputId), button = document.getElementById(buttonId);
            const svg = [...button.querySelectorAll('svg')].filter(el => getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().width > 0);
            const probe = document.createElement('span');
            probe.style.color = 'var(--accent)'; button.appendChild(probe);
            const accent = getComputedStyle(probe).color;
            probe.remove();
            return {
                type: input.type, value: input.value, visibleIcons: svg.length,
                slash: !!button.querySelector('path[d="M3 3l10 10"]'),
                activeColor: button.style.color === 'var(--accent)' && getComputedStyle(button).color === accent,
                label: button.getAttribute('aria-label'), pressed: button.getAttribute('aria-pressed'),
            };
        };
    });
    return page;
}

(async () => {
    const browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_CHANNEL || 'msedge' });
    try {
        for (const [kind, input, button] of eyes) {
            const page = await fixture(browser);
            try {
                await page.evaluate(({ kind, input, button }) => { openEye(kind); revealEye(button); document.getElementById(input).value = 'test-password'; }, { kind, input, button });
                await page.evaluate(id => document.getElementById(id).click(), button);
                assert.deepEqual(await page.evaluate(({ input, button }) => eyeState(input, button), { input, button }), {
                    type: 'text', value: 'test-password', visibleIcons: 1, slash: true, activeColor: true, label: 'Hide password', pressed: 'true',
                });
                await page.evaluate(id => document.getElementById(id).click(), button);
                const hidden = await page.evaluate(({ input, button }) => eyeState(input, button), { input, button });
                assert.equal(hidden.type, 'password'); assert.equal(hidden.visibleIcons, 1); assert.equal(hidden.slash, false); assert.equal(hidden.activeColor, false);
                assert.equal(hidden.label, 'Show password'); assert.equal(hidden.pressed, 'false');
                console.log('PASS toggle ' + button);
            } catch (error) { process.exitCode = 1; console.error('FAIL toggle ' + button, error.message); }
            finally { await page.close(); }
        }
        for (const [kind, input, button] of eyes) {
            const page = await fixture(browser);
            try {
                const state = await page.evaluate(async ({ kind, input, button }) => {
                    openEye(kind); document.getElementById(button).click();
                    if (kind === 'export') { document.getElementById('exp-cancel').click(); await exporting; }
                    else Overlay.hide();
                    openEye(kind); revealEye(button);
                    return eyeState(input, button);
                }, { kind, input, button });
                assert.equal(state.type, 'password'); assert.equal(state.visibleIcons, 1); assert.equal(state.slash, false); assert.equal(state.activeColor, false);
                assert.equal(state.label, 'Show password'); assert.equal(state.pressed, 'false');
                console.log('PASS reopen ' + button);
            } catch (error) { process.exitCode = 1; console.error('FAIL reopen ' + button, error.message); }
            finally { await page.close(); }
        }
    } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
