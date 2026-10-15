'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { chromium } = require('playwright');
async function fixture(browser) {
    const page = await browser.newPage();
    await page.route('http://localhost/**', route => route.fulfill({ contentType: 'text/html', body: '<div></div>' }));
    await page.goto('http://localhost/');
    await page.evaluate(() => {
        window.App = { key: {}, container: { id: 'test', name: 'Test' }, folder: 'root' };
        window.records = new Map(); window.messages = []; window.loading = false;
        window.DB = { saveFile: async rec => { if (window.failWrite) throw new Error('Write failed'); records.set(rec.id, rec); } };
        window.Crypto = { encryptBin: async (_, buf) => ({ iv: new Uint8Array(12), blob: buf }) };
        window.Desktop = { _patchIcons() { } };
        window.saveVFS = async () => { };
        window.toast = (...args) => messages.push(args);
        window.logActivity = window._scheduleExportCacheRefresh = () => { };
        window.showLoading = () => { loading = true; }; window.hideLoading = () => { loading = false; };
        window.checkStorageSpace = async () => ({ ok: true });
    });
    for (const file of ['constants.js', 'vfs.js', 'fileops.js']) {
        const content = process.env.TEST_BASELINE && file === 'fileops.js'
            ? execFileSync('git', ['show', 'HEAD:src/js/' + file], { encoding: 'utf8' })
            : fs.readFileSync(path.join(__dirname, '../src/js', file), 'utf8');
        await page.addScriptTag({ content });
    }
    await page.evaluate(() => {
        VFS.init();
        window.fileEntry = name => ({ name, isFile: true, file: resolve => resolve(new File(['data'], name, { type: 'text/plain' })) });
        window.dirEntry = (name, children, fail = false) => ({
            name, isDirectory: true, createReader: () => {
                let read = false;
                return { readEntries: (resolve, reject) => { if (fail) { reject(new Error('Folder read denied')); return; } const entries = read ? [] : children; read = true; resolve(entries); } };
            }
        });
        window.drop = entry => uploadEntries([{ webkitGetAsEntry: () => entry }], 'root');
        window.result = () => ({ nodes: Object.values(VFS.toObj().nodes).map(n => n.name).sort(), records: records.size, messages, loading });
    });
    return page;
}
const cases = [
    ['failed file import releases its name and capacity for retry', async page => {
        const r = await page.evaluate(async () => {
            failWrite = true;
            try { await _uploadFileEntry(fileEntry('retry.txt'), 'root'); } catch (_) { }
            failWrite = false;
            await _uploadFileEntry(fileEntry('retry.txt'), 'root');
            return result();
        });
        assert.deepEqual(r.nodes, ['/', 'retry.txt']); assert.equal(r.records, 1);
    }],
    ['unreadable directory reports failure without creating empty impostor', async page => {
        const r = await page.evaluate(async () => { await drop(dirEntry('folder', [], true)); return result(); });
        assert.deepEqual(r.nodes, ['/']); assert.equal(r.loading, false);
        assert.ok(r.messages.some(([, type]) => type === 'error'));
        assert.ok(!r.messages.some(([, type]) => type === 'success'));
    }],
    ['file write failure inside directory is reported as partial import', async page => {
        const r = await page.evaluate(async () => { failWrite = true; await drop(dirEntry('folder', [fileEntry('a.txt')])); return result(); });
        assert.equal(r.records, 0); assert.equal(r.loading, false);
        assert.ok(r.messages.some(([, type]) => type === 'error'));
        assert.ok(!r.messages.some(([, type]) => type === 'success'));
    }],
    ['unreadable child directory does not prevent importing healthy sibling', async page => {
        const r = await page.evaluate(async () => { await drop(dirEntry('folder', [dirEntry('bad', [], true), dirEntry('good', [fileEntry('ok.txt')])])); return result(); });
        assert.ok(r.nodes.includes('ok.txt')); assert.ok(!r.nodes.includes('bad')); assert.equal(r.records, 1);
        assert.ok(r.messages.some(([, type]) => type === 'error'));
    }],
    ['parallel directory files respect remaining container capacity', async page => {
        const r = await page.evaluate(async () => {
            VFS.add({ id: 'existing', name: 'existing.bin', type: 'file', size: CONTAINER_LIMIT - 6, parentId: 'root' });
            await drop(dirEntry('folder', [fileEntry('a.txt'), fileEntry('b.txt')]));
            return { ...result(), size: VFS.totalSize(), limit: CONTAINER_LIMIT };
        });
        assert.ok(r.size <= r.limit); assert.equal(r.records, 1);
    }],
    ['parallel names that sanitize identically do not produce duplicates', async page => {
        const r = await page.evaluate(async () => { await drop(dirEntry('folder', [fileEntry('a&b.txt'), fileEntry('a_b.txt')])); return result(); });
        assert.equal(r.nodes.filter(n => n === 'a_b.txt').length, 1); assert.equal(r.records, 1);
    }],
    ['normal nested directory and empty folder import successfully', async page => {
        const r = await page.evaluate(async () => { await drop(dirEntry('folder', [dirEntry('empty', []), dirEntry('child', [fileEntry('ok.txt')])])); return result(); });
        assert.deepEqual(r.nodes, ['/', 'child', 'empty', 'folder', 'ok.txt']); assert.equal(r.records, 1); assert.equal(r.loading, false);
        assert.ok(r.messages.some(([, type]) => type === 'success'));
    }],
];
(async () => {
    const browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_CHANNEL || 'msedge' });
    try {
        for (const [label, test] of cases) {
            const page = await fixture(browser);
            try { await test(page); console.log('PASS', label); }
            catch (error) { process.exitCode = 1; console.error('FAIL', label, error.message); }
            finally { await page.close(); }
        }
    } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
