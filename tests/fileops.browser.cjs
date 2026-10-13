'use strict';

// Requires Playwright and installed Edge. TEST_BASELINE=1 tests committed source.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { chromium } = require('playwright');

async function fixture(browser) {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error));
    await page.route('http://localhost/**', route => route.fulfill({
        contentType: 'text/html',
        body: '<div id="desktop-area" tabindex="0"></div><div id="drop-overlay"></div>',
    }));
    await page.goto('http://localhost/');
    await page.evaluate(() => {
        window.App = {
            folder: 'root', selection: new Set(), clipboard: null, thumbCache: {}, key: {},
            container: { id: 'test', name: 'Test' },
        };
        window.records = new Map();
        window.DB = {
            getFile: async id => records.get(id),
            saveFile: async record => records.set(record.id, record),
            saveFiles: async recs => recs.forEach(record => records.set(record.id, record)),
        };
        window.Crypto = { encryptBin: async (_, buf) => ({ iv: new Uint8Array(12), blob: buf }) };
        window.checkStorageSpace = async () => ({ ok: true });
        window.showLoading = () => { };
        window.hideLoading = () => { };
    });
    for (const file of ['constants.js', 'vfs.js', 'desktop.js', 'fileops.js']) {
        const content = process.env.TEST_BASELINE
            ? execFileSync('git', ['show', 'HEAD:src/js/' + file], { encoding: 'utf8' })
            : fs.readFileSync(path.join(__dirname, '../src/js', file), 'utf8');
        await page.addScriptTag({ content });
    }
    assert.deepEqual(errors, []);
    await page.evaluate(() => {
        saveVFS = async () => { };
        window.messages = [];
        toast = (...args) => messages.push(args);
        logActivity = () => { };
        _scheduleExportCacheRefresh = () => { };
        Desktop._updateSelectionBar = () => { };
        Desktop.updateTaskbar = () => { };
        VFS.init();
        for (const id of ['source', 'target', 'other']) {
            VFS.add({ id, type: 'folder', name: id, parentId: 'root' });
        }
        window.targetWin = new FolderWindow('target');
        window.otherWin = new FolderWindow('other');
        WinManager._wins.push(targetWin, otherWin);
        Desktop._renderIcons();
    });
    return page;
}

async function filesAndIcons(page, folder = 'target') {
    return page.evaluate(folder => ({
        names: VFS.children(folder).map(n => n.name).sort(),
        targetIcons: [...targetWin.el.querySelectorAll('.file-name')].map(n => n.textContent).sort(),
        other: VFS.children('other').map(n => n.name),
        rootFiles: VFS.children('root').filter(n => n.type === 'file').map(n => n.name),
        records: records.size,
    }), folder);
}

const cases = [
    ['import destination stays fixed during storage check', async page => {
        await page.evaluate(async () => {
            targetWin._setCtx();
            checkStorageSpace = () => new Promise(resolve => { window.finishCheck = resolve; });
            window.importing = uploadFiles([new File(['test'], 'import.txt', { type: 'text/plain' })]);
            otherWin._setCtx();
            finishCheck({ ok: true });
            await importing;
        });
        const result = await filesAndIcons(page);
        assert.deepEqual(result.names, ['import.txt']);
        assert.deepEqual(result.other, []);
        assert.deepEqual(result.rootFiles, []);
        assert.deepEqual(result.targetIcons, result.names);
        assert.equal(result.records, 1);
    }],
    ['file picker import refreshes open folder icons', async page => {
        await page.evaluate(async () => {
            targetWin._setCtx();
            await uploadFiles([new File(['test'], 'import.txt', { type: 'text/plain' })]);
        });
        const result = await filesAndIcons(page);
        assert.deepEqual(result.names, ['import.txt']);
        assert.deepEqual(result.targetIcons, result.names);
    }],
    ['drop fallback respects explicitly hovered destination', async page => {
        await page.evaluate(async () => {
            App.folder = 'root';
            const file = new File(['test'], 'fallback.txt', { type: 'text/plain' });
            await uploadEntries([{ getAsFile: () => file }], 'target');
        });
        const result = await filesAndIcons(page);
        assert.deepEqual(result.names, ['fallback.txt']);
        assert.deepEqual(result.rootFiles, []);
        assert.deepEqual(result.targetIcons, result.names);
    }],
    ...['source', 'child'].map(destination => [
        'copy folder into ' + (destination === 'source' ? 'itself' : 'descendant') + ' is rejected',
        async page => {
            const result = await page.evaluate(async destination => {
                VFS.add({ id: 'child', name: 'child', type: 'folder', parentId: 'source' });
                VFS.add({ id: 'file', name: 'file.txt', type: 'file', parentId: 'source' });
                records.set('file', { id: 'file', cid: 'test', blob: 'data' });
                const before = Object.keys(VFS.toObj().nodes).length;
                App.clipboard = { op: 'copy', ids: ['source'] };
                App.folder = destination;
                await pasteItems();
                return { before, after: Object.keys(VFS.toObj().nodes).length, messages, records: records.size };
            }, destination);
            assert.equal(result.after, result.before);
            assert.equal(result.records, 1);
            assert.ok(result.messages.some(([msg, type]) => type === 'error' && msg.includes('subfolder')));
        },
    ]),
    ['ordinary recursive folder copy preserves files and blobs', async page => {
        const result = await page.evaluate(async () => {
            VFS.add({ id: 'child', name: 'child', type: 'folder', parentId: 'source' });
            VFS.add({ id: 'file', name: 'file.txt', type: 'file', parentId: 'child' });
            records.set('file', { id: 'file', cid: 'test', blob: 'data' });
            targetWin._setCtx();
            App.clipboard = { op: 'copy', ids: ['source'] };
            await pasteItems();
            const copy = VFS.children('target')[0];
            const child = VFS.children(copy.id)[0];
            const file = VFS.children(child.id)[0];
            return { copy: copy.name, child: child.name, file: file.name, blob: records.get(file.id)?.blob, sourceFiles: VFS.children('child').length };
        });
        assert.deepEqual(result, { copy: 'source', child: 'child', file: 'file.txt', blob: 'data', sourceFiles: 1 });
    }],
];

(async () => {
    const browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_CHANNEL || 'msedge' });
    try {
        for (const [label, test] of cases) {
            const page = await fixture(browser);
            try {
                await test(page);
                console.log('PASS', label);
            } catch (error) {
                console.error('FAIL', label, '\n' + error.message);
                process.exitCode = 1;
            } finally {
                await page.close();
            }
        }
    } finally {
        await browser.close();
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
