// Run with Playwright available: node tests/mime.browser.cjs
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

(async () => {
    const browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_CHANNEL || 'msedge' });
    try {
        const page = await browser.newPage();
        const errors = [];
        page.on('pageerror', error => errors.push(error));
        await page.route('http://localhost/**', route => route.fulfill({
            contentType: 'text/html',
            body: '<input id="rename-input"><button id="rename-ok">Rename</button>',
        }));
        await page.goto('http://localhost/');
        await page.evaluate(async () => {
            window.App = {
                folder: 'root', container: { id: 'test', name: 'Test' }, thumbCache: {},
                key: await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']),
            };
            window.records = new Map();
            window.DB = {
                getFile: async id => records.get(id),
                saveFiles: async recs => { for (const rec of recs) records.set(rec.id, rec); },
            };
            window.Desktop = { _patchIcons: () => { } };
            window.Overlay = { show: () => { }, hide: () => { } };
            window.showLoading = window.hideLoading = window.toast = () => { };
            window.checkStorageSpace = async () => ({ ok: true });
            window.saveVFS = async () => { };
            window.logActivity = window._scheduleExportCacheRefresh = () => { };
        });
        for (const file of ['constants.js', 'vfs.js', 'crypto.js', 'fileops.js']) {
            await page.addScriptTag({ content: fs.readFileSync(path.join(__dirname, '../src/js', file), 'utf8') });
        }
        await page.evaluate(() => {
            VFS.init();
            // Keep real upload, rename dialog, VFS and decrypt/dispatch; capture viewer selection.
            openEditor = (node, buf) => { window.opened = { kind: 'editor', text: new TextDecoder().decode(buf) }; };
            openViewer = (node, buf, mime) => { window.opened = { kind: 'viewer', mime, text: new TextDecoder().decode(buf) }; };
            _confirmExport = () => { window.opened = { kind: 'download' }; };
            window.upload = async (name, mime) => {
                await uploadFiles([new File(['content of ' + name], name, { type: mime })]);
                return VFS.children('root').find(n => n.name === name).id;
            };
            window.rename = async (id, name) => {
                renameNode(VFS.node(id));
                document.getElementById('rename-input').value = name;
                await document.getElementById('rename-ok').onclick();
            };
            window.open = async id => {
                window.opened = null;
                await openFile(VFS.node(id));
                return { ...window.opened, mime: VFS.node(id).mime };
            };
        });

        for (const newName of ['Vacation', 'Vacation.unknown']) {
            const result = await page.evaluate(async newName => {
                const id = await upload('photo-' + newName + '.png', 'image/png');
                await rename(id, newName);
                return open(id);
            }, newName);
            assert.equal(result.kind, 'viewer');
            assert.equal(result.mime, 'image/png');
            assert.ok(result.text.startsWith('content of photo-'));
            console.log('PASS image viewer survives rename to ' + newName);
        }

        const video = await page.evaluate(async () => {
            const id = await upload('original.ogg', 'video/ogg');
            await rename(id, 'renamed.ogg');
            return open(id);
        });
        assert.equal(video.kind, 'viewer');
        assert.equal(video.mime, 'video/ogg');
        console.log('PASS same-extension rename preserves upload MIME');

        const changed = await page.evaluate(async () => {
            const id = await upload('change.txt', 'text/plain');
            await rename(id, 'change.png');
            return open(id);
        });
        assert.equal(changed.kind, 'viewer');
        assert.equal(changed.mime, 'image/png');
        console.log('PASS known extension change updates viewer type');

        for (const ext of ['cs', 'php', 'rb', 'cmd', 'ps1', 'vbs']) {
            const source = await page.evaluate(async ext => open(await upload('source.' + ext, '')), ext);
            assert.equal(source.kind, 'editor');
            assert.equal(source.text, 'content of source.' + ext);
            console.log('PASS uploaded .' + ext + ' opens in editor');
        }

        const unknown = await page.evaluate(async () => open(await upload('binary.dat', '')));
        assert.equal(unknown.kind, 'download');
        assert.deepEqual(errors, []);
        console.log('PASS unknown binary type retains download behavior');
    } finally {
        await browser.close();
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
