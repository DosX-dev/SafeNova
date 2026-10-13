'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

async function fixture(browser) {
    const page = await browser.newPage();
    await page.route('http://localhost/**', route => route.fulfill({
        contentType: 'text/html',
        body: '<div id="desktop-area" tabindex="0" style="width:1000px;height:700px"></div><div id="drop-overlay"></div><div id="ctx-menu"></div>',
    }));
    await page.goto('http://localhost/');
    await page.evaluate(() => {
        window.App = { folder: 'root', selection: new Set(), clipboard: null, thumbCache: {}, container: { id: 'test', name: 'Test' } };
    });
    for (const file of ['constants.js', 'vfs.js', 'desktop.js', 'fileops.js']) {
        await page.addScriptTag({ content: fs.readFileSync(path.join(__dirname, '../src/js', file), 'utf8') });
    }
    await page.evaluate(() => {
        saveVFS = async () => { };
        toast = () => { };
        logActivity = () => { };
        Desktop._updateSelectionBar = () => { };
        Desktop.updateTaskbar = () => { };
        VFS.init();
        for (const id of ['source', 'empty']) VFS.add({ id, type: 'folder', name: id, parentId: 'root' });
        VFS.add({ id: 'first', type: 'file', name: 'first.txt', mime: 'text/plain', parentId: 'source' });
        Desktop.initEvents();
        window.sourceWin = new FolderWindow('source');
        WinManager._wins.push(sourceWin);
        Desktop._renderIcons();
    });
    return page;
}

const tests = [
    ['Desktop Escape preserves selection in folder windows', async page => {
        await page.evaluate(() => {
            sourceWin.selection.add('first');
            sourceWin.el.querySelector('.file-item').classList.add('selected');
            Desktop.selection.add('empty');
            document.querySelector('#desktop-area > .file-item[data-id="empty"]').classList.add('selected');
            document.getElementById('desktop-area').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        });
        assert.deepEqual(await page.evaluate(() => ({
            desktop: [...Desktop.selection],
            desktopSelected: document.querySelectorAll('#desktop-area > .file-item.selected').length,
            window: [...sourceWin.selection],
            windowSelected: sourceWin.el.querySelectorAll('.file-item.selected').length,
        })), { desktop: [], desktopSelected: 0, window: ['first'], windowSelected: 1 });
        await page.evaluate(() => sourceWin.el.querySelector('.fw-area').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
        assert.equal(await page.evaluate(() => sourceWin.selection.size), 0);
        assert.equal(await page.evaluate(() => sourceWin.el.querySelectorAll('.file-item.selected').length), 0);
    }],
    ['Navigating to empty folder cancels pending large-folder render', async page => {
        await page.evaluate(() => {
            VFS.add({ id: 'empty-child', type: 'folder', name: 'Empty child', parentId: 'source' });
            for (let i = 0; i < 950; i++) VFS.add({ id: 'many-' + i, type: 'file', name: String(i).padStart(3, '0') + '.txt', parentId: 'source' });
            sourceWin._renderedFolderId = null;
            sourceWin.render();
            window.firstChunk = sourceWin.el.querySelectorAll('.file-item').length;
            sourceWin.el.querySelector('.file-item[data-id="empty-child"]').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        });
        assert.equal(await page.evaluate(() => firstChunk), 300);
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        assert.equal(await page.evaluate(() => sourceWin.el.querySelectorAll('.file-item').length), 0);
        assert.equal(await page.evaluate(() => sourceWin.el.querySelector('.fw-status-text').textContent), '0 items');
    }],
    ['Folder context menu copies selected files', async page => {
        await page.evaluate(() => {
            Desktop.selection.add('empty');
            sourceWin._contextIcon({ clientX: 10, clientY: 10 }, VFS.node('first'));
        });
        const copy = page.locator('#ctx-menu .ctx-item').filter({ hasText: /^Copy$/ });
        assert.equal(await copy.count(), 1);
        await copy.click();
        assert.deepEqual(await page.evaluate(() => App.clipboard), { op: 'copy', ids: ['first'] });
        assert.deepEqual(await page.evaluate(() => [...Desktop.selection]), ['empty']);
    }],
    ['Select all changes only the active folder window', async page => {
        await page.evaluate(() => {
            window.secondWin = new FolderWindow('source');
            WinManager._wins.push(secondWin);
            secondWin.el.querySelector('.fw-area').dispatchEvent(new KeyboardEvent('keydown', {
                key: 'a', code: 'KeyA', ctrlKey: true, bubbles: true, cancelable: true,
            }));
        });
        assert.deepEqual(await page.evaluate(() => ({
            firstSelection: [...sourceWin.selection],
            firstSelected: sourceWin.el.querySelectorAll('.file-item.selected').length,
            secondSelection: [...secondWin.selection],
            secondSelected: secondWin.el.querySelectorAll('.file-item.selected').length,
        })), { firstSelection: [], firstSelected: 0, secondSelection: ['first'], secondSelected: 1 });
    }],
];

(async () => {
    const browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_CHANNEL || 'msedge' });
    let failures = 0;
    try {
        for (const [label, run] of tests) {
            const page = await fixture(browser);
            try { await run(page); console.log('PASS', label); }
            catch (error) { failures++; console.error('FAIL', label, error.message); }
            finally { await page.close(); }
        }
    } finally { await browser.close(); }
    if (failures) process.exitCode = 1;
})().catch(error => { console.error(error); process.exitCode = 1; });
