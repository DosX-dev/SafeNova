'use strict';

// Requires Playwright + Edge. TEST_BASELINE=1 uses committed source.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { chromium } = require('playwright');

async function fixture(browser) {
    const page = await browser.newPage();
    await page.route('http://localhost/**', route => route.fulfill({
        contentType: 'text/html', body:
            '<div id="desktop-area"></div><div id="loading-overlay"></div><div id="delete-msg"></div><button id="delete-ok">Delete</button>'
    }));
    await page.goto('http://localhost/');
    await page.evaluate(() => {
        window.App = { folder: 'root', selection: new Set(), key: {}, container: { id: 'test', name: 'Test' }, thumbCache: {} };
        window.records = new Map();
        window.DB = {
            saveFiles: async recs => {
                if (window.failWrite) throw new Error('Storage quota exceeded');
                recs.forEach(record => records.set(record.id, record));
            },
            deleteFiles: async ids => {
                if (window.failDelete) throw new Error('Storage unavailable');
                ids.forEach(id => records.delete(id));
            },
        };
        window.Crypto = { encryptBin: async (_, buf) => ({ iv: new Uint8Array(12), blob: buf }) };
        window.checkStorageSpace = async () => ({ ok: true });
        window.showLoading = () => document.getElementById('loading-overlay').classList.add('show');
        window.hideLoading = () => document.getElementById('loading-overlay').classList.remove('show');
        window.Overlay = { show: () => { }, hide: () => { } };
    });
    for (const file of ['constants.js', 'vfs.js', 'desktop.js', 'fileops.js']) {
        const content = process.env.TEST_BASELINE
            ? execFileSync('git', ['show', 'HEAD:src/js/' + file], { encoding: 'utf8' })
            : fs.readFileSync(path.join(__dirname, '../src/js', file), 'utf8');
        await page.addScriptTag({ content });
    }
    await page.evaluate(() => {
        saveVFS = async () => { };
        window.messages = [];
        window.logs = [];
        toast = (...args) => messages.push(args);
        logActivity = (...args) => logs.push(args);
        _scheduleExportCacheRefresh = () => { };
        Desktop._updateSelectionBar = () => { };
        Desktop.updateTaskbar = () => { };
        VFS.init();
        window.addOriginal = () => {
            VFS.add({ id: 'original', name: 'original.txt', type: 'file', size: 3, parentId: 'root' });
            records.set('original', { id: 'original', blob: 'old' });
            App.selection.add('original');
            Desktop._renderIcons();
        };
        window.result = () => ({
            names: VFS.children('root').map(n => n.name).sort(),
            icons: [...document.querySelectorAll('.file-name')].map(n => n.textContent).sort(),
            loading: document.getElementById('loading-overlay').classList.contains('show'),
            records: records.size, selected: [...App.selection], messages, logs,
        });
    });
    return page;
}

const cases = [
    ['reimport and same-batch name collisions preserve existing file', async page => {
        const result = await page.evaluate(async () => {
            addOriginal();
            await uploadFiles([new File(['replacement'], 'ORIGINAL.txt'), new File(['one'], 'new.txt'), new File(['two'], 'NEW.TXT')]);
            return { ...window.result(), originalBlob: records.get('original').blob };
        });
        assert.deepEqual(result.names, ['new.txt', 'original.txt']);
        assert.equal(result.originalBlob, 'old');
        assert.equal(result.records, 2);
        assert.deepEqual(result.icons, result.names);
        assert.equal(result.loading, false);
    }],
    ['unreadable file does not block good files or leave loading overlay', async page => {
        const result = await page.evaluate(async () => {
            try {
                await uploadFiles([
                    { name: 'bad.txt', size: 1, type: 'text/plain', arrayBuffer: async () => { throw new Error('Cannot read file'); } },
                    new File(['good'], 'good.txt'),
                ]);
            } catch (_) { /* Observe baseline UI after the rejected operation. */ }
            return window.result();
        });
        assert.equal(result.loading, false);
        assert.deepEqual(result.names, ['good.txt']);
        assert.equal(result.records, 1);
        assert.ok(result.messages.some(([, type]) => type === 'error'));
        assert.equal(result.logs.find(entry => entry[0] === 'upload')?.[1], 'good.txt');
    }],
    ['failed storage write creates no phantom files and releases loading overlay', async page => {
        const result = await page.evaluate(async () => {
            failWrite = true;
            try { await uploadFiles([new File(['new'], 'new.txt')]); } catch (_) { }
            return window.result();
        });
        assert.deepEqual(result.names, []);
        assert.equal(result.records, 0);
        assert.equal(result.loading, false);
        assert.ok(result.messages.some(([, type]) => type === 'error'));
        assert.ok(!result.messages.some(([, type]) => type === 'success'));
    }],
    ['failed deletion preserves file, selection and visible icon', async page => {
        const result = await page.evaluate(async () => {
            addOriginal();
            failDelete = true;
            await deleteSelected();
            await document.getElementById('delete-ok').onclick();
            return window.result();
        });
        assert.deepEqual(result.names, ['original.txt']);
        assert.equal(result.records, 1);
        assert.deepEqual(result.selected, ['original']);
        assert.deepEqual(result.icons, result.names);
        assert.equal(result.loading, false);
        assert.ok(result.messages.some(([msg, type]) => type === 'error' && msg.includes('Delete failed')));
        assert.ok(!result.logs.some(entry => entry[0] === 'delete'));
    }],
    ['successful deletion removes record and clears selection', async page => {
        const result = await page.evaluate(async () => {
            addOriginal();
            await deleteSelected();
            await document.getElementById('delete-ok').onclick();
            return window.result();
        });
        assert.deepEqual(result.names, []);
        assert.equal(result.records, 0);
        assert.deepEqual(result.selected, []);
        assert.equal(result.loading, false);
        assert.ok(result.logs.some(entry => entry[0] === 'delete'));
    }],
    ['later failed import batch preserves earlier committed files', async page => {
        const result = await page.evaluate(async () => {
            const originalSave = DB.saveFiles;
            let batches = 0;
            DB.saveFiles = async recs => {
                if (++batches === 2) throw new Error('Storage quota exceeded');
                await originalSave(recs);
            };
            const files = Array.from({ length: _CRYPTO_CONCURRENCY * 2 }, (_, i) => new File(['file-' + i], i + '.txt'));
            try { await uploadFiles(files); } catch (_) { }
            return { ...window.result(), batchSize: _CRYPTO_CONCURRENCY };
        });
        assert.equal(result.names.length, result.batchSize);
        assert.equal(result.records, result.batchSize);
        assert.deepEqual(result.icons, result.names);
        assert.equal(result.loading, false);
        assert.ok(result.messages.some(([, type]) => type === 'error'));
    }],
    ['multi-batch import saves all records and icons', async page => {
        const result = await page.evaluate(async () => {
            const files = Array.from({ length: 40 }, (_, i) => new File(['file-' + i], i + '.txt'));
            await uploadFiles(files);
            return window.result();
        });
        assert.equal(result.names.length, 40);
        assert.equal(result.records, 40);
        assert.deepEqual(result.icons, result.names);
        assert.equal(result.loading, false);
    }],
];

(async () => {
    const browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_CHANNEL || 'msedge' });
    try {
        for (const [name, run] of cases) {
            const page = await fixture(browser);
            try { await run(page); console.log('PASS', name); }
            catch (error) { console.error('FAIL', name, error.message); process.exitCode = 1; }
            finally { await page.close(); }
        }
    } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
