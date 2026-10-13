// Run with Playwright available: node tests/paste.browser.cjs
// Uses installed Edge; set BROWSER_CHANNEL to another Playwright channel if needed.
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

async function fixture(browser) {
    const page = await browser.newPage();
    page.on('pageerror', error => { throw error; });
    await page.route('http://localhost/**', route => route.fulfill({
        contentType: 'text/html',
        body: '<div id="desktop-area" tabindex="0"></div><div id="drop-overlay"></div>',
    }));
    await page.goto('http://localhost/');
    await page.evaluate(() => {
        window.App = {
            folder: 'root', selection: new Set(), clipboard: null, thumbCache: {},
            container: { id: 'test', name: 'Test' },
        };
        window.records = new Map();
        window.DB = {
            getFile: async id => {
                if (window.pauseCopy) {
                    window.pauseCopy = false;
                    await new Promise(resolve => { window.resumeCopy = resolve; });
                }
                return records.get(id);
            },
            saveFile: async record => records.set(record.id, record),
        };
    });
    for (const file of ['constants.js', 'vfs.js', 'desktop.js', 'fileops.js']) {
        await page.addScriptTag({ content: fs.readFileSync(path.join(__dirname, '../src/js', file), 'utf8') });
    }
    await page.evaluate(() => {
        // Isolate storage and taskbar UI; keep real VFS, handlers, copy and icon rendering.
        saveVFS = async () => {};
        toast = () => {};
        _scheduleExportCacheRefresh = () => {};
        window.logs = [];
        logActivity = (...args) => logs.push(args);
        Desktop._updateSelectionBar = () => {};
        Desktop.updateTaskbar = () => {};
        VFS.init();
        for (const id of ['source', 'target', 'other']) {
            VFS.add({ id, type: 'folder', name: id, parentId: 'root' });
        }
        for (const id of ['first', 'second']) {
            VFS.add({ id, type: 'file', name: id + '.txt', mime: 'text/plain', parentId: 'source' });
            records.set(id, { id, cid: 'test', blob: 'encrypted-' + id });
        }
        Desktop.initEvents();
        window.targetWin = new FolderWindow('target');
        window.otherWin = new FolderWindow('other');
        WinManager._wins.push(targetWin, otherWin);
        Desktop._renderIcons();
        window.pendingPastes = [];
        const originalPaste = pasteItems;
        pasteItems = () => {
            const pending = originalPaste();
            pendingPastes.push(pending);
            return pending;
        };
        window.press = (area, code, meta = false) => {
            const event = new KeyboardEvent('keydown', {
                key: code.slice(3).toLowerCase(), code,
                ctrlKey: !meta, metaKey: meta, bubbles: true, cancelable: true,
            });
            area.dispatchEvent(event);
            return event.defaultPrevented;
        };
    });
    return page;
}

async function snapshot(page) {
    return page.evaluate(() => ({
        target: VFS.children('target').map(n => n.name).sort(),
        other: VFS.children('other').map(n => n.name),
        rootFiles: VFS.children('root').filter(n => n.type === 'file').map(n => n.name),
        source: VFS.children('source').map(n => n.name).sort(),
        targetIcons: [...targetWin.el.querySelectorAll('.file-name')].map(n => n.textContent).sort(),
        otherIcons: otherWin.el.querySelectorAll('.file-item').length,
        calls: pendingPastes.length,
        destination: logs.findLast(entry => entry[0] === 'paste')?.[4],
    }));
}

(async () => {
    const browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_CHANNEL || 'msedge' });
    try {
        for (const [label, op, meta] of [['Ctrl+V copy', 'copy', false], ['Cmd+V copy', 'copy', true], ['Ctrl+V cut', 'cut', false]]) {
            const page = await fixture(browser);
            const prevented = await page.evaluate(({ op, meta }) => {
                App.clipboard = { op, ids: ['first'] };
                return press(targetWin.el.querySelector('.fw-area'), 'KeyV', meta);
            }, { op, meta });
            await page.evaluate(() => Promise.all(pendingPastes));
            const result = await snapshot(page);
            assert.equal(result.calls, 1);
            assert.equal(prevented, true);
            assert.deepEqual(result.target, ['first.txt']);
            assert.deepEqual(result.targetIcons, result.target);
            assert.deepEqual(result.other, []);
            assert.deepEqual(result.rootFiles, []);
            assert.equal(result.otherIcons, 0);
            assert.equal(result.destination, '/~/Test/target');
            assert.deepEqual(result.source, op === 'cut' ? ['second.txt'] : ['first.txt', 'second.txt']);
            console.log('PASS', label, 'with two open folders');
            await page.close();
        }
        {
            const page = await fixture(browser);
            await page.evaluate(() => {
                App.clipboard = { op: 'copy', ids: ['first', 'second'] };
                window.pauseCopy = true;
                press(targetWin.el.querySelector('.fw-area'), 'KeyV');
            });
            await page.waitForFunction(() => typeof resumeCopy === 'function');
            await page.evaluate(() => {
                otherWin._setCtx();
                // A new context-menu position belongs to the next operation.
                App._ctxScreenPos = { x: 50, y: 60 };
                resumeCopy();
            });
            await page.evaluate(() => Promise.all(pendingPastes));
            const result = await snapshot(page);
            assert.deepEqual(result.target, ['first.txt', 'second.txt']);
            assert.deepEqual(result.targetIcons, result.target);
            assert.deepEqual(result.other, []);
            assert.deepEqual(result.rootFiles, []);
            assert.equal(result.calls, 1);
            assert.equal(result.destination, '/~/Test/target');
            assert.deepEqual(await page.evaluate(() => App._ctxScreenPos), { x: 50, y: 60 });
            console.log('PASS multiple files while switching folder context during DB read');
            await page.close();
        }
        {
            const page = await fixture(browser);
            await page.evaluate(() => {
                Desktop._sel.add('other');
                targetWin.selection.add('first');
                press(targetWin.el.querySelector('.fw-area'), 'KeyC');
            });
            assert.deepEqual(await page.evaluate(() => App.clipboard.ids), ['first']);
            await page.evaluate(() => {
                press(targetWin.el.querySelector('.fw-area'), 'KeyA');
            });
            assert.deepEqual(await page.evaluate(() => [...Desktop._sel]), ['other']);
            console.log('PASS folder copy/select-all do not affect desktop selection');
            const endReachedDocument = await page.evaluate(() => {
                let reached = false;
                document.addEventListener('keydown', e => { if (e.key === 'End') reached = true; }, { once: true });
                targetWin.el.querySelector('.fw-area').dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
                return reached;
            });
            assert.equal(endReachedDocument, true);
            console.log('PASS global End shortcut still reaches document from folder');
            await page.close();
        }
        {
            const page = await fixture(browser);
            await page.evaluate(() => {
                App.clipboard = { op: 'copy', ids: ['first'] };
                press(document.getElementById('desktop-area'), 'KeyV');
            });
            await page.evaluate(() => Promise.all(pendingPastes));
            const result = await snapshot(page);
            assert.deepEqual(result.rootFiles, ['first.txt']);
            assert.deepEqual(result.target, []);
            assert.deepEqual(result.other, []);
            assert.equal(result.calls, 1);
            console.log('PASS desktop paste');
            await page.close();
        }
    } finally {
        await browser.close();
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
