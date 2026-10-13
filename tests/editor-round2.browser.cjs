'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { chromium } = require('playwright');

async function fixture(browser) {
    const page = await browser.newPage();
    await page.route('http://localhost/**', route => route.fulfill({
        contentType: 'text/html',
        body: '<textarea id="editor-textarea" style="line-height:20px"></textarea>' +
            ['editor-title', 'editor-line-numbers', 'editor-meta-chars', 'editor-meta-lines',
                'editor-meta-modified', 'viewer-content', 'viewer-title'].map(id => `<div id="${id}"></div>`).join('') +
            '<button id="btn-wordwrap"></button><button id="btn-download-viewer"></button>',
    }));
    await page.goto('http://localhost/');
    await page.evaluate(() => {
        window.App = { key: {}, container: { id: 'test' } };
        window.messages = [];
        window.downloads = [];
        window.records = new Map();
        window.DB = {
            saveFile: async record => records.set(record.id, record),
            getFilesByIds: async ids => new Map(ids.filter(id => records.has(id)).map(id => [id, records.get(id)])),
        };
        window.Crypto = {
            encryptBin: async (_, buf) => ({ iv: new Uint8Array(12), blob: buf }),
            decryptBin: async (_, iv, blob) => blob,
        };
        window.Overlay = { show() { }, hide() { } };
        window.Desktop = { _patchIcons() { } };
        window.checkStorageSpace = async () => ({ ok: true });
        window.showLoading = window.hideLoading = () => { };
    });
    for (const file of ['constants.js', 'vfs.js', 'fileops.js']) {
        const content = process.env.TEST_BASELINE
            ? execFileSync('git', ['show', 'HEAD:src/js/' + file], { encoding: 'utf8' })
            : fs.readFileSync(path.join(__dirname, '../src/js', file), 'utf8');
        await page.addScriptTag({ content });
    }
    await page.evaluate(() => {
        toast = (...args) => messages.push(args);
        logActivity = _scheduleExportCacheRefresh = () => { };
        saveVFS = async () => { };
        downloadBuf = (...args) => downloads.push(args);
        VFS.init();
        window.addFile = (id = 'file') => {
            const node = { id, name: `${id}.txt`, type: 'file', parentId: 'root', size: 3, mtime: 123 };
            VFS.add(node);
            records.set(id, { id, iv: [], blob: new TextEncoder().encode('old').buffer });
            return node;
        };
    });
    return page;
}

const cases = [
    ['successful editor save stores UTF-8 bytes and updates metadata', async page => {
        const result = await page.evaluate(async () => {
            openEditor(addFile(), new TextEncoder().encode('old'));
            document.getElementById('editor-textarea').value = 'Привет';
            const saved = await saveEditor();
            return {
                saved, size: VFS.node('file').size, text: new TextDecoder().decode(records.get('file').blob),
                modified: document.getElementById('editor-meta-modified').style.display
            };
        });
        assert.deepEqual(result, { saved: true, size: 12, text: 'Привет', modified: 'none' });
    }],
    ['failed editor write preserves file size and modification time', async page => {
        const result = await page.evaluate(async () => {
            openEditor(addFile(), new TextEncoder().encode('old'));
            document.getElementById('editor-textarea').value = 'new longer text';
            DB.saveFile = async () => { throw new Error('disk full'); };
            const saved = await saveEditor();
            return { saved, size: VFS.node('file').size, mtime: VFS.node('file').mtime };
        });
        assert.deepEqual(result, { saved: false, size: 3, mtime: 123 });
    }],
    ['keyboard seek changes playback position', async page => {
        await page.evaluate(() => {
            const player = _buildCustomPlayer('', 'audio');
            document.getElementById('viewer-content').appendChild(player);
            const media = player.querySelector('audio');
            Object.defineProperty(media, 'duration', { value: 100 });
            window.playbackPosition = 20;
            Object.defineProperty(media, 'currentTime', {
                get: () => playbackPosition, set: value => { playbackPosition = Number(value); },
            });
            media.dispatchEvent(new Event('loadedmetadata'));
            media.dispatchEvent(new Event('timeupdate'));
        });
        await page.locator('.player-seek').focus();
        await page.keyboard.press('ArrowRight');
        assert.equal(await page.evaluate(() => playbackPosition), 20.1);
    }],
    ['edits typed during save-and-close remain open and marked modified', async page => {
        const result = await page.evaluate(async () => {
            openEditor(addFile(), new TextEncoder().encode('old'));
            const ta = document.getElementById('editor-textarea');
            ta.value = 'saved draft';
            let closeCount = 0;
            Overlay.hide = () => { closeCount++; };
            Crypto.encryptBin = async (_, buf) => {
                ta.value = 'later unsaved draft';
                return { iv: new Uint8Array(12), blob: buf };
            };
            await saveAndCloseEditor();
            return { closeCount, text: ta.value, modified: document.getElementById('editor-meta-modified').style.display };
        });
        assert.deepEqual(result, { closeCount: 0, text: 'later unsaved draft', modified: '' });
    }],
    ['repeated save while encryption is pending writes once', async page => {
        const result = await page.evaluate(async () => {
            openEditor(addFile(), new TextEncoder().encode('old'));
            let encryptions = 0;
            Crypto.encryptBin = (_, buf) => {
                encryptions++;
                return new Promise(resolve => { window.finishEncryption = () => resolve({ iv: new Uint8Array(12), blob: buf }); });
            };
            const first = saveEditor();
            await Promise.resolve();
            const second = saveEditor();
            await Promise.resolve();
            finishEncryption();
            // On the old code, both encryptions start and the first promise remains pending.
            // Observe the violation without waiting for that unresolved promise.
            if (encryptions > 1) return { encryptions };
            await Promise.all([first, second]);
            return { encryptions };
        });
        assert.deepEqual(result, { encryptions: 1 });
    }],
    ['ZIP export can download a single empty folder', async page => {
        const names = await page.evaluate(async () => {
            VFS.add({ id: 'empty', name: 'Пустая', type: 'folder', parentId: 'root' });
            await exportAsZip(['empty']);
            return downloads.length ? Object.keys(_readZip(await new Blob(downloads[0][0]).arrayBuffer())) : [];
        });
        assert.deepEqual(names, ['Пустая/']);
    }],
    ['ZIP export preserves empty directories alongside files', async page => {
        const names = await page.evaluate(async () => {
            addFile();
            VFS.add({ id: 'empty', name: 'empty', type: 'folder', parentId: 'root' });
            await exportAsZip(['file', 'empty']);
            return Object.keys(_readZip(await new Blob(downloads[0][0]).arrayBuffer())).sort();
        });
        assert.deepEqual(names, ['empty/', 'file.txt']);
    }],
    ['ZIP export reports a missing selected file instead of incomplete success', async page => {
        const result = await page.evaluate(async () => {
            addFile();
            addFile('missing');
            records.delete('missing');
            await exportAsZip(['file', 'missing']);
            return { downloads: downloads.length, error: messages.some(m => m[1] === 'error') };
        });
        assert.deepEqual(result, { downloads: 0, error: true });
    }],
    ['ZIP export reports a decryption failure instead of incomplete success', async page => {
        const result = await page.evaluate(async () => {
            addFile();
            addFile('corrupt');
            records.get('corrupt').iv = ['corrupt'];
            Crypto.decryptBin = async (_, iv, blob) => {
                if (iv[0] === 'corrupt') throw new Error('decryption failure');
                return blob;
            };
            await exportAsZip(['file', 'corrupt']);
            return { downloads: downloads.length, error: messages.some(m => m[1] === 'error') };
        });
        assert.deepEqual(result, { downloads: 0, error: true });
    }],
];

(async () => {
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    let failures = 0;
    try {
        for (const [name, run] of cases) {
            const page = await fixture(browser);
            try { await run(page); console.log('PASS ' + name); }
            catch (error) { failures++; console.error('FAIL ' + name + ': ' + error.message); }
            finally { await page.close(); }
        }
    } finally { await browser.close(); }
    console.log(`${cases.length - failures}/${cases.length} passed`);
    process.exitCode = failures ? 1 : 0;
})();
