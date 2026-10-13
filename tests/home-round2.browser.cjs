'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const sourceRoot = process.env.SAFENOVA_SOURCE_ROOT || path.join(__dirname, '../src');

async function fixture(browser) {
    const page = await browser.newPage({ bypassCSP: true });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const html = fs.readFileSync(path.join(sourceRoot, 'index.html'), 'utf8')
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<link\b[^>]*>/gi, '');
    await page.route('http://localhost/**', route => route.fulfill({ contentType: 'text/html', body: html }));
    await page.goto('http://localhost/');
    for (const file of ['constants.js', 'vfs.js', 'home.js', 'main.js']) {
        const override = file === 'home.js' ? process.env.SAFENOVA_HOME_SOURCE
            : file === 'main.js' ? process.env.SAFENOVA_MAIN_SOURCE : null;
        const filePath = override || path.join(sourceRoot, 'js', file);
        await page.addScriptTag({ content: fs.readFileSync(filePath, 'utf8') });
    }
    await page.evaluate(() => {
        for (const name of ['importContainerFile', 'newTextFile', 'newFolder', 'openSettings', 'uploadFiles',
            'saveEditor', 'closeEditor', 'discardEditor', 'saveAndCloseEditor', 'closeViewer',
            'createTextFile', 'createFolder', 'hideCtxMenu', 'showLoading', 'hideLoading', 'toast',
            'clearSession', 'saveSession', '_startContainerSession', 'updateStorageInfo']) window[name] = () => { };
        window.App = { view: 'home', container: null, key: null, selection: new Set(), showView(name) { this.view = name; } };
        window.Desktop = { initEvents() { }, render() { window.desktopRenders++; } };
        window.desktopRenders = 0;
        window.Overlay = { current: null, show(id) { this.current = id; }, hide() { this.current = null; } };
        window.InitLog = { step() { }, done() { } };
        window.container = { id: 'test', name: 'Test', createdAt: 1, salt: [1], verIv: [2], verBlob: 'verified' };
        window.DB = { getContainers: async () => [structuredClone(container)], getVFS: async () => null };
        window.Crypto = {
            deriveKeyAndRaw: async () => {
                window.deriveCalls++;
                await new Promise(resolve => { window.releases.push(resolve); });
                return { key: {}, raw: new Uint8Array(32) };
            },
            checkVerification: async () => window.verificationOK !== false,
        };
        window.deriveCalls = 0;
        window.releases = [];
        window.hasSession = () => false;
        window.loadSession = async () => null;
        initEvents();
        window.pending = [];
        const unlock = doUnlock;
        doUnlock = () => { const p = unlock(); pending.push(p); return p; };
        window.enterUnlock = () => document.getElementById('unlock-pw').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        window.startUnlock = () => { openUnlockView(container); document.getElementById('unlock-pw').value = 'password'; enterUnlock(); };
        window.finishUnlock = async () => { releases.splice(0).forEach(resolve => resolve()); await Promise.all(pending); };
    });
    return { page, errors };
}

const tests = {
    repeat: async page => {
        await page.evaluate(() => { startUnlock(); enterUnlock(); enterUnlock(); });
        const count = await page.evaluate(() => deriveCalls);
        await page.evaluate(() => finishUnlock());
        assert.equal(count, 1, 'repeated Enter must run one password derivation');
        assert.equal(await page.evaluate(() => desktopRenders), 1);
    },
    back: async page => {
        await page.evaluate(() => { startUnlock(); document.getElementById('btn-back').click(); });
        await page.evaluate(() => finishUnlock());
        assert.equal(await page.evaluate(() => App.view), 'home', 'Back during derivation must remain on home');
        assert.equal(await page.evaluate(() => App.container), null);
        assert.equal(await page.evaluate(() => desktopRenders), 0);
    },
    switch: async page => {
        await page.evaluate(() => { startUnlock(); openUnlockView({ ...container, id: 'second', name: 'Second' }); });
        await page.evaluate(() => finishUnlock());
        assert.equal(await page.evaluate(() => App.view), 'unlock', 'old unlock must not replace the newly selected container');
        assert.equal(await page.evaluate(() => App.container), null);
        assert.equal(await page.locator('#btn-unlock').isDisabled(), false);
    },
    eye: async page => {
        await page.evaluate(() => {
            openUnlockView(container);
            document.getElementById('unlock-pw-eye').click();
            openUnlockView({ ...container, id: 'second' });
        });
        assert.equal(await page.locator('#unlock-pw').getAttribute('type'), 'password', 'new unlock must hide password entry');
    },
    render: async page => {
        await page.evaluate(() => {
            hasSession = () => true;
            loadSession = () => new Promise(resolve => { releases.push(resolve); });
            pending = [Home.render()];
        });
        await page.waitForFunction(() => releases.length === 1);
        await page.evaluate(() => pending.push(Home.render()));
        await page.waitForFunction(() => releases.length === 2);
        await page.evaluate(() => finishUnlock());
        assert.equal(await page.locator('.container-card').count(), 1, 'overlapping home renders must not duplicate cards');
    },
    retry: async page => {
        await page.evaluate(() => { verificationOK = false; startUnlock(); });
        await page.evaluate(() => finishUnlock());
        assert.equal(await page.locator('#btn-unlock').isDisabled(), false);
        await page.evaluate(() => { verificationOK = true; enterUnlock(); });
        await page.evaluate(() => finishUnlock());
        assert.equal(await page.evaluate(() => deriveCalls), 2);
        assert.equal(await page.evaluate(() => desktopRenders), 1);
    },
    cooldown: async page => {
        await page.evaluate(async () => {
            verificationOK = false;
            openUnlockView(container);
            document.getElementById('unlock-pw').value = 'wrong';
            for (let i = 0; i < 4; i++) { enterUnlock(); await finishUnlock(); }
        });
        assert.equal(await page.locator('#btn-unlock').isDisabled(), true);
        await page.evaluate(() => openUnlockView({ ...container, id: 'second' }));
        await page.waitForTimeout(1100);
        assert.equal(await page.locator('#unlock-error').innerText(), '', 'old cooldown must not write into another container');
        assert.equal(await page.locator('#btn-unlock').isDisabled(), false);
        await page.evaluate(() => openUnlockView(container));
        assert.equal(await page.locator('#btn-unlock').isDisabled(), true, 'returning must preserve original cooldown');
        await page.waitForFunction(() => !document.getElementById('btn-unlock').disabled);
    },
    supersede: async page => {
        await page.evaluate(() => {
            startUnlock();
            openUnlockView({ ...container, id: 'second' });
            document.getElementById('unlock-pw').value = 'second-password';
            enterUnlock();
        });
        await page.evaluate(async () => { releases.shift()(); await pending[0]; });
        assert.equal(await page.locator('#btn-unlock').isDisabled(), true, 'older completion must not enable current unlock button');
        assert.equal(await page.evaluate(() => desktopRenders), 0);
        await page.evaluate(() => finishUnlock());
        assert.equal(await page.evaluate(() => App.container.id), 'second');
    },
    vfsBack: async page => {
        await page.evaluate(() => {
            DB.getVFS = async () => { await new Promise(resolve => { window.releaseVFS = resolve; }); return null; };
            VFS.init();
            VFS.add({ id: 'keep', name: 'Keep', type: 'folder', parentId: 'root' });
            startUnlock();
            releases.shift()();
        });
        await page.waitForFunction(() => typeof releaseVFS === 'function');
        await page.evaluate(async () => {
            document.getElementById('btn-back').click();
            releaseVFS();
            await Promise.all(pending);
        });
        assert.equal(await page.evaluate(() => App.view), 'home');
        assert.equal(await page.evaluate(() => VFS.children('root').some(node => node.name === 'Keep')), true, 'canceled unlock must not reset another VFS');
    },
    canceledFailures: async page => {
        await page.evaluate(async () => {
            verificationOK = false;
            for (let i = 0; i < 4; i++) {
                startUnlock();
                document.getElementById('btn-back').click();
                await finishUnlock();
            }
            openUnlockView(container);
        });
        assert.equal(await page.locator('#btn-unlock').isDisabled(), true, 'Back must not bypass the password attempt cooldown');
        assert.equal(await page.evaluate(() => App.view), 'unlock');
    },
};

(async () => {
    const browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_CHANNEL || 'msedge' });
    let failed = 0;
    try {
        for (const [name, test] of Object.entries(tests)) {
            if (process.env.TEST_FILTER && process.env.TEST_FILTER !== name) continue;
            const { page, errors } = await fixture(browser);
            try { await test(page); assert.deepEqual(errors, []); console.log('PASS', name); }
            catch (error) { failed++; console.error('FAIL', name, error.message); }
            finally { await page.close(); }
        }
    } finally { await browser.close(); }
    if (failed) process.exitCode = 1;
})().catch(error => { console.error(error); process.exitCode = 1; });
