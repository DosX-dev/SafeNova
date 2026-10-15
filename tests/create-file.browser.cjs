'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { chromium } = require('playwright');
const sourceDir = path.join(__dirname, '../src');

async function fixture(browser) {
    const page = await browser.newPage({ bypassCSP: true });
    const html = fs.readFileSync(path.join(sourceDir, 'index.html'), 'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<link\b[^>]*>/gi, '');
    await page.route('http://localhost/**', route => route.fulfill({ contentType: 'text/html', body: html }));
    await page.goto('http://localhost/');
    await page.evaluate(() => {
        window.App = { key: {}, container: { id: 'test', name: 'Test' }, folder: 'root', selection: new Set(), thumbCache: {} };
        window.records = new Map();
        window.messages = [];
        window.DB = { saveFile: async rec => { if (window.failWrite) throw new Error('Storage quota exceeded'); records.set(rec.id, rec); } };
        window.Crypto = {
            encryptBin: async () => {
                if (window.failEncrypt) throw new Error('Encryption failed');
                if (window.pauseEncrypt) { window.pauseEncrypt = false; await new Promise(resolve => { window.finishEncrypt = resolve; }); }
                return { iv: new Uint8Array(12), blob: new ArrayBuffer(0) };
            }
        };
        window.checkStorageSpace = async () => ({ ok: true });
        window.showLoading = window.hideLoading = () => { };
        window.toast = (...args) => messages.push(args);
        window.openSettings = window.hideCtxMenu = () => { };
    });
    for (const file of ['constants.js', 'vfs.js', 'desktop.js', 'fileops.js', 'home.js', 'main.js']) {
        const content = file === 'fileops.js' && process.env.TEST_BASELINE
            ? execFileSync('git', ['show', 'HEAD:src/js/' + file], { encoding: 'utf8' })
            : fs.readFileSync(path.join(sourceDir, 'js', file), 'utf8');
        await page.addScriptTag({ content });
    }
    const state = fs.readFileSync(path.join(sourceDir, 'js/state.js'), 'utf8');
    const start = state.indexOf('const Overlay = {');
    await page.addScriptTag({ content: state.slice(start, state.indexOf('\n};', start) + 3) });
    await page.evaluate(() => {
        saveVFS = async () => { };
        logActivity = _scheduleExportCacheRefresh = () => { };
        Desktop.initEvents = Desktop._patchIcons = () => { };
        VFS.init();
        VFS.add({ id: 'target', name: 'target', type: 'folder', parentId: 'root' });
        window.target = { el: document.querySelector('#desktop-area'), render() { } };
        App.folder = 'target'; App._winCtx = target;
        document.querySelector('#nf-name').value = 'new.txt';
        Overlay.show('modal-new-text');
        window.pending = [];
        const create = createTextFile;
        createTextFile = () => { const p = create(); pending.push(p); p.catch(() => { }); return p; };
        initEvents();
        window.enter = () => document.querySelector('#nf-name').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        window.result = () => ({ root: VFS.children('root').filter(n => n.type === 'file').map(n => n.name), target: VFS.children('target').map(n => n.name), records: records.size, messages });
    });
    return page;
}

const cases = [
    ['repeated Enter creates one file in the original folder', async page => {
        const result = await page.evaluate(async () => {
            pauseEncrypt = true;
            enter(); enter(); finishEncrypt();
            await Promise.allSettled(pending);
            return window.result();
        });
        assert.deepEqual(result.root, []);
        assert.deepEqual(result.target, ['new.txt']);
        assert.equal(result.records, 1);
    }],
    ['creation write failure leaves no phantom file and reports error', async page => {
        const result = await page.evaluate(async () => {
            failWrite = true; enter(); await Promise.allSettled(pending); return window.result();
        });
        assert.deepEqual(result.target, []);
        assert.equal(result.records, 0);
        assert.ok(result.messages.some(([, type]) => type === 'error'));
    }],
    ['encryption failure reports error and allows retry', async page => {
        const result = await page.evaluate(async () => {
            failEncrypt = true; enter(); await Promise.allSettled(pending);
            const errors = messages.filter(([, type]) => type === 'error').length;
            failEncrypt = false; App.folder = 'target'; App._winCtx = target;
            enter(); await Promise.allSettled(pending);
            return { ...window.result(), errors };
        });
        assert.equal(result.errors, 1);
        assert.deepEqual(result.target, ['new.txt']);
        assert.equal(result.records, 1);
    }],
    ['dropped file write failure does not enter VFS', async page => {
        const result = await page.evaluate(async () => {
            failWrite = true;
            const file = new File(['test'], 'drop.txt', { type: 'text/plain' });
            await uploadEntries([{ webkitGetAsEntry: () => ({ isFile: true, name: file.name, file: resolve => resolve(file) }) }], 'target');
            return window.result();
        });
        assert.deepEqual(result.target, []);
        assert.equal(result.records, 0);
        assert.ok(result.messages.some(([, type]) => type === 'error'));
    }],
    ['successful dropped file writes blob and node', async page => {
        const result = await page.evaluate(async () => {
            const file = new File(['test'], 'drop.txt', { type: 'text/plain' });
            await uploadEntries([{ webkitGetAsEntry: () => ({ isFile: true, name: file.name, file: resolve => resolve(file) }) }], 'target');
            return window.result();
        });
        assert.deepEqual(result.target, ['drop.txt']);
        assert.equal(result.records, 1);
    }],
];

(async () => {
    const browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_CHANNEL || 'msedge' });
    try {
        for (const [label, run] of cases) {
            const page = await fixture(browser);
            try { await run(page); console.log('PASS', label); }
            catch (error) { process.exitCode = 1; console.error('FAIL', label, error.message); }
            finally { await page.close(); }
        }
    } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
