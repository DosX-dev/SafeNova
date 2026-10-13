'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

async function fixture(browser) {
    const page = await browser.newPage();
    await page.route('http://localhost/**', route => route.fulfill({
        contentType: 'text/html',
        body: `<style>
        #desktop-area { position:relative;width:1000px;height:700px; }
        .folder-window { position:absolute; }
        .fw-area { position:relative;height:300px; }
        .file-item { position:absolute;width:90px;height:80px; }
        .fw-canvas,.fw-drop-overlay { pointer-events:none; }
        #ctx-menu:not(.show) { display:none; }
        </style><div id="desktop-area" tabindex="0"></div><div id="drop-overlay"></div><div id="ctx-menu"></div>`,
    }));
    await page.goto('http://localhost/');
    await page.evaluate(() => {
        window.App = { folder: 'root', selection: new Set(), clipboard: null, thumbCache: {}, container: { id: 'test', name: 'Test' } };
    });
    for (const file of ['constants.js', 'vfs.js', 'desktop.js', 'fileops.js']) {
        const source = file === 'desktop.js' && process.env.DESKTOP_SOURCE ? process.env.DESKTOP_SOURCE : path.join(__dirname, '../src/js', file);
        await page.addScriptTag({ content: fs.readFileSync(source, 'utf8') });
    }
    await page.evaluate(() => {
        saveVFS = async () => { };
        toast = () => { };
        logActivity = () => { };
        Desktop._updateSelectionBar = () => { };
        Desktop.updateTaskbar = () => { };
        VFS.init();
        VFS.add({ id: 'source', type: 'folder', name: 'Source', parentId: 'root' });
        for (const [id, parentId] of [['desk', 'root'], ['first', 'source'], ['second', 'source']]) {
            VFS.add({ id, type: 'file', name: id + '.txt', mime: 'text/plain', parentId });
        }
        Desktop.initEvents();
        window.sourceWin = WinManager.open('source');
        Desktop._renderIcons();
    });
    return page;
}

const tests = [
    ['Clicking folder file directs real Ctrl+C to that folder', async page => {
        await page.locator('#desktop-area').focus();
        await page.locator('.fw-area [data-id="first"]').click();
        await page.keyboard.press('Control+c');
        assert.deepEqual(await page.evaluate(() => App.clipboard), { op: 'copy', ids: ['first'] });
        assert.equal(await page.evaluate(() => document.activeElement === sourceWin.el.querySelector('.fw-area')), true);
    }],
    ['Clicking desktop file transfers keyboard focus from folder', async page => {
        await page.locator('.fw-area').focus();
        await page.locator('#desktop-area > [data-id="desk"]').click();
        await page.keyboard.press('Control+c');
        assert.deepEqual(await page.evaluate(() => App.clipboard), { op: 'copy', ids: ['desk'] });
    }],
    ['Clicking empty desktop directs select-all away from folder', async page => {
        await page.locator('.fw-area').focus();
        await page.locator('#desktop-area').click({ position: { x: 950, y: 650 } });
        await page.keyboard.press('Control+a');
        assert.deepEqual(await page.evaluate(() => [...sourceWin.selection]), []);
        assert.deepEqual(await page.evaluate(() => [...Desktop.selection].sort()), ['desk', 'source']);
    }],
    ['Ordinary click collapses folder multiselection to clicked file', async page => {
        await page.locator('.fw-area [data-id="first"]').click();
        await page.locator('.fw-area [data-id="second"]').click({ modifiers: ['Control'] });
        assert.equal(await page.evaluate(() => sourceWin.selection.size), 2);
        await page.locator('.fw-area [data-id="first"]').click();
        assert.deepEqual(await page.evaluate(() => [...sourceWin.selection]), ['first']);
        assert.equal(await page.locator('.fw-area .selected').count(), 1);
    }],
    ['Ctrl+click still toggles selected file off', async page => {
        await page.locator('.fw-area [data-id="first"]').click();
        await page.locator('.fw-area [data-id="second"]').click({ modifiers: ['Control'] });
        await page.locator('.fw-area [data-id="first"]').click({ modifiers: ['Control'] });
        assert.deepEqual(await page.evaluate(() => [...sourceWin.selection]), ['second']);
    }],
    ['Ordinary desktop click collapses multiselection', async page => {
        await page.locator('#desktop-area > [data-id="source"]').click();
        await page.locator('#desktop-area > [data-id="desk"]').click({ modifiers: ['Control'] });
        assert.equal(await page.evaluate(() => Desktop.selection.size), 2);
        await page.locator('#desktop-area > [data-id="desk"]').click();
        assert.deepEqual(await page.evaluate(() => [...Desktop.selection]), ['desk']);
    }],
    ['Dragging a selected group preserves both selected files', async page => {
        await page.locator('.fw-area [data-id="first"]').click();
        await page.locator('.fw-area [data-id="second"]').click({ modifiers: ['Control'] });
        const box = await page.locator('.fw-area [data-id="first"]').boundingBox();
        await page.mouse.move(box.x + 20, box.y + 20);
        await page.mouse.down();
        await page.mouse.move(box.x + 30, box.y + 150, { steps: 4 });
        await page.mouse.up();
        assert.deepEqual(await page.evaluate(() => [...sourceWin.selection].sort()), ['first', 'second']);
        assert.equal(await page.locator('.fw-area .selected').count(), 2);
    }],
    ['Clicking another window redirects shortcuts to that window', async page => {
        await page.locator('.fw-area').focus();
        await page.evaluate(() => {
            VFS.add({ id: 'other', type: 'folder', name: 'Other', parentId: 'root' });
            VFS.add({ id: 'other-file', type: 'file', name: 'other.txt', mime: 'text/plain', parentId: 'other' });
            window.otherWin = WinManager.open('other');
        });
        await page.locator('.fw-area [data-id="other-file"]').click();
        await page.keyboard.press('Control+c');
        assert.deepEqual(await page.evaluate(() => App.clipboard), { op: 'copy', ids: ['other-file'] });
    }],
    ['Handled select-all cancels native browser select-all', async page => {
        assert.equal(await page.evaluate(() => {
            const event = new KeyboardEvent('keydown', { key: 'a', code: 'KeyA', ctrlKey: true, bubbles: true, cancelable: true });
            sourceWin.el.querySelector('.fw-area').dispatchEvent(event);
            return event.defaultPrevented;
        }), true);
    }],
];

(async () => {
    const browser = await chromium.launch({ headless: true, channel: 'msedge' });
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
