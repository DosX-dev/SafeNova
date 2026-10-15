'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { chromium } = require('playwright');

async function fixture(browser) {
    const page = await browser.newPage();
    await page.route('http://localhost/**', route => route.fulfill({ contentType: 'text/html', body: '<div id="desktop-area"></div>' }));
    await page.goto('http://localhost/');
    await page.evaluate(() => {
        window.App = { folder: 'target', container: { id: 'test', name: 'Test' }, selection: new Set(), thumbCache: {} };
        window.records = new Map();
        window.DB = {
            getFile: async id => records.get(id),
            saveFile: async rec => {
                if (window.failWrite) throw new Error('Quota exceeded');
                records.set(rec.id, rec);
            },
            saveFiles: async recs => {
                if (window.failWrite) throw new Error('Quota exceeded');
                recs.forEach(rec => records.set(rec.id, rec));
            },
        };
        window.Desktop = { _patchIcons() { }, _updateSelectionBar() { } };
        window._openFolderGuard = () => null;
        window.saveVFS = async () => { };
        window.messages = [];
        window.logs = [];
        window.toast = (...args) => messages.push(args);
        window.logActivity = (...args) => logs.push(args);
        window._scheduleExportCacheRefresh = () => { };
    });
    for (const file of ['constants.js', 'vfs.js', 'fileops.js']) {
        const source = process.env.TEST_BASELINE
            ? execFileSync('git', ['show', 'HEAD:src/js/' + file], { encoding: 'utf8' })
            : fs.readFileSync(path.join(__dirname, '../src/js', file), 'utf8');
        await page.addScriptTag({ content: source });
    }
    await page.evaluate(() => {
        VFS.init();
        VFS.add({ id: 'source', name: 'source', type: 'folder', parentId: 'root' });
        VFS.add({ id: 'target', name: 'target', type: 'folder', parentId: 'root' });
        window.addFile = (id, parentId, name = id + '.txt', size = 4) => {
            VFS.add({ id, name, type: 'file', parentId, size });
            records.set(id, { id, cid: 'test', blob: 'data-' + id });
        };
        window.paste = async (op, ids) => {
            App.clipboard = { op, ids };
            try { await pasteItems(); } catch (_) { }
        };
    });
    return page;
}

const cases = [
    ['concurrent copies keep distinct destination names', async page => {
        const names = await page.evaluate(async () => {
            addFile('first', 'source');
            App.clipboard = { op: 'copy', ids: ['first'] };
            await Promise.all([pasteItems(), pasteItems()]);
            return VFS.children('target').map(n => n.name).sort();
        });
        assert.deepEqual(names, ['first (2).txt', 'first.txt']);
    }],
    ['failed cut remains available for retry after resolving collision', async page => {
        const result = await page.evaluate(async () => {
            addFile('first', 'source'); addFile('second', 'source'); addFile('collision', 'target', 'first.txt');
            await paste('cut', ['first', 'second']);
            const pending = structuredClone(App.clipboard);
            VFS.remove('collision'); records.delete('collision');
            await pasteItems();
            return { pending, target: VFS.children('target').map(n => n.name).sort(), clipboard: App.clipboard };
        });
        assert.deepEqual(result.pending, { op: 'cut', ids: ['first'] });
        assert.deepEqual(result.target, ['first.txt', 'second.txt']);
        assert.equal(result.clipboard, null);
    }],
    ['missing child data aborts entire folder copy', async page => {
        const result = await page.evaluate(async () => {
            addFile('first', 'source'); addFile('second', 'source'); records.delete('second');
            await paste('copy', ['source']);
            return { children: VFS.children('target').length, nodes: Object.keys(VFS.toObj().nodes).length, records: records.size, messages };
        });
        assert.equal(result.children, 0);
        assert.equal(result.nodes, 5);
        assert.equal(result.records, 1);
        assert.ok(result.messages.some(([, type]) => type === 'error'));
    }],
    ['copy write failure leaves no phantom nodes', async page => {
        const result = await page.evaluate(async () => {
            addFile('first', 'source'); failWrite = true;
            await paste('copy', ['source']);
            return { children: VFS.children('target').length, nodes: Object.keys(VFS.toObj().nodes).length, records: records.size, messages };
        });
        assert.equal(result.children, 0);
        assert.equal(result.nodes, 4);
        assert.equal(result.records, 1);
        assert.ok(result.messages.some(([, type]) => type === 'error'));
    }],
    ['copy respects container capacity', async page => {
        const result = await page.evaluate(async () => {
            addFile('large', 'source', 'large.bin', CONTAINER_LIMIT / 2 + 1);
            await paste('copy', ['large']);
            return { children: VFS.children('target').length, total: VFS.totalSize(), limit: CONTAINER_LIMIT, records: records.size, messages };
        });
        assert.equal(result.children, 0);
        assert.ok(result.total <= result.limit);
        assert.equal(result.records, 1);
        assert.ok(result.messages.some(([, type]) => type === 'error'));
    }],
    ['valid recursive copy preserves complete subtree and records', async page => {
        const result = await page.evaluate(async () => {
            VFS.add({ id: 'nested', type: 'folder', name: 'nested', parentId: 'source' });
            addFile('first', 'source'); addFile('second', 'nested');
            await paste('copy', ['source']);
            const copy = VFS.children('target')[0];
            const nested = VFS.children(copy.id).find(n => n.type === 'folder');
            const file = VFS.children(nested.id)[0];
            return { name: copy.name, children: VFS.children(copy.id).map(n => n.name).sort(), blob: records.get(file.id)?.blob, records: records.size };
        });
        assert.deepEqual(result, { name: 'source', children: ['first.txt', 'nested'], blob: 'data-second', records: 4 });
    }],
    ['failure of one copied item does not block other selected items', async page => {
        const result = await page.evaluate(async () => {
            addFile('first', 'source'); addFile('second', 'source'); records.delete('first');
            await paste('copy', ['first', 'second']);
            return { names: VFS.children('target').map(n => n.name), records: records.size, messages };
        });
        assert.deepEqual(result.names, ['second.txt']);
        assert.equal(result.records, 2);
        assert.ok(result.messages.some(([, type]) => type === 'error'));
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
