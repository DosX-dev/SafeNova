'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const sourceRoot = process.env.SAFENOVA_SOURCE_ROOT || path.join(__dirname, '../src');
const testFilter = process.env.TEST_FILTER;

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
        const filePath = file === 'home.js' && process.env.SAFENOVA_HOME_SOURCE
            ? process.env.SAFENOVA_HOME_SOURCE : path.join(sourceRoot, 'js', file);
        await page.addScriptTag({ content: fs.readFileSync(filePath, 'utf8') });
    }
    await page.evaluate(() => {
        for (const name of ['importContainerFile', 'newTextFile', 'newFolder', 'openSettings', 'uploadFiles',
            'saveEditor', 'closeEditor', 'discardEditor', 'saveAndCloseEditor', 'closeViewer',
            'createTextFile', 'createFolder', 'hideCtxMenu', 'showLoading', 'hideLoading', 'toast',
            'clearSession']) window[name] = () => { };
        window.App = { showView() { } };
        window.Desktop = { initEvents() { } };
        window.Overlay = { current: null, show(id) { this.current = id; }, hide() { this.current = null; } };
        window.saved = [];
        window.containers = [];
        window.DB = {
            getContainers: async () => {
                const snapshot = structuredClone(containers);
                if (window.pauseLookup) {
                    window.pauseLookup = false;
                    await new Promise(resolve => { window.releaseLookup = resolve; });
                }
                return snapshot;
            },
            saveContainer: async c => { saved.push(structuredClone(c)); containers = [structuredClone(c)]; },
            saveVFS: async () => { }, getVFS: async () => null, getFilesByCid: async () => [],
        };
        window.deriveCalls = [];
        window.Crypto = {
            deriveKey: async pw => {
                deriveCalls.push(pw);
                if (window.pauseDerive) {
                    window.pauseDerive = false;
                    await new Promise(resolve => { window.releaseDerive = resolve; });
                }
                return { pw };
            },
            checkVerification: async () => window.verificationOK !== false,
            makeVerification: async () => ({ iv: [1], blob: 'verified' }),
            encrypt: async () => ({ iv: [2], blob: 'encrypted' }),
        };
        checkStorageSpace = async () => ({ ok: true });
        Home.render = async () => { };
        initEvents();
        window.setInput = (id, value) => { document.getElementById(id).value = value; };
        window.enter = id => document.getElementById(id).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        window.container = { id: 'test', name: 'Test', salt: [1], verIv: [2], verBlob: 'verified' };
        window.pending = [];
        const create = createContainer, change = doChangePassword;
        createContainer = () => { const p = create(); pending.push(p); return p; };
        doChangePassword = () => { const p = change(); pending.push(p); return p; };
    });
    return { page, errors };
}

(async () => {
    const browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_CHANNEL || 'msedge' });
    try {
        if (!testFilter || testFilter === 'create') {
            const { page, errors } = await fixture(browser);
            await page.evaluate(() => {
                setInput('nc-name', 'Created'); setInput('nc-pw', 'pass'); setInput('nc-pw2', 'pass');
                document.getElementById('nc-agree').checked = true;
                pauseLookup = true;
                enter('nc-pw2'); enter('nc-pw2');
            });
            await page.waitForFunction(() => typeof releaseLookup === 'function');
            await page.evaluate(() => { pauseLookup = false; releaseLookup(); });
            await page.evaluate(() => Promise.all(pending));
            assert.equal(await page.evaluate(() => saved.length), 1);
            assert.equal(await page.evaluate(() => deriveCalls.length), 1);
            assert.deepEqual(errors, []);
            console.log('PASS repeated Enter creates exactly one container');
            await page.close();
        }
        if (!testFilter || testFilter === 'password') {
            const { page, errors } = await fixture(browser);
            await page.evaluate(() => {
                openChangePasswordModal(container);
                setInput('cp-old', 'old-pass'); setInput('cp-new', 'new-pass'); setInput('cp-new2', 'new-pass');
                pauseDerive = true;
                enter('cp-new2'); enter('cp-new2');
            });
            await page.waitForFunction(() => typeof releaseDerive === 'function');
            await page.evaluate(() => releaseDerive());
            await page.evaluate(() => Promise.all(pending));
            assert.equal(await page.evaluate(() => saved.length), 1);
            assert.deepEqual(await page.evaluate(() => deriveCalls), ['old-pass', 'new-pass']);
            await page.evaluate(() => openChangePasswordModal(container));
            assert.equal(await page.locator('#cp-ok').isDisabled(), false);
            assert.deepEqual(errors, []);
            console.log('PASS repeated Enter changes password once; reopened dialog accepts clicks');
            await page.close();
        }
        if (!testFilter || testFilter === 'cooldown') {
            const { page } = await fixture(browser);
            await page.evaluate(async () => {
                openChangePasswordModal(container);
                setInput('cp-old', 'wrong'); setInput('cp-new', 'new-pass'); setInput('cp-new2', 'new-pass');
                verificationOK = false;
                for (let i = 0; i < 4; i++) await doChangePassword();
            });
            assert.equal(await page.locator('#cp-ok').isDisabled(), true);
            assert.equal(await page.evaluate(() => deriveCalls.length), 4);
            await page.evaluate(() => doChangePassword());
            assert.equal(await page.evaluate(() => deriveCalls.length), 4);
            await page.waitForFunction(() => !document.getElementById('cp-ok').disabled);
            console.log('PASS password attempt cooldown remains enforced and expires');
            await page.close();
        }
        if (!testFilter || testFilter === 'reopen') {
            const { page } = await fixture(browser);
            await page.evaluate(async () => {
                openChangePasswordModal(container);
                setInput('cp-old', 'old-pass'); setInput('cp-new', 'new-pass'); setInput('cp-new2', 'new-pass');
                await doChangePassword();
                openChangePasswordModal(container);
            });
            assert.equal(await page.locator('#cp-ok').isDisabled(), false);
            console.log('PASS successful password change does not disable the next dialog');
            await page.close();
        }
        if (!testFilter || testFilter === 'validation') {
            const { page } = await fixture(browser);
            await page.evaluate(async () => {
                document.getElementById('nc-agree').checked = true;
                await createContainer();
            });
            assert.equal(await page.locator('#nc-create').isDisabled(), false);
            assert.equal(await page.evaluate(() => saved.length), 0);
            console.log('PASS validation error releases the create button without saving');
            await page.close();
        }
        if (!testFilter || testFilter === 'rename') {
            const { page } = await fixture(browser);
            await page.evaluate(async () => {
                containers = [container];
                openRenameContainerModal(container);
                setInput('rc-name', 'TEST');
                await doRenameContainer();
            });
            assert.equal(await page.evaluate(() => saved[0]?.name), 'TEST');
            console.log('PASS container names can change letter case');
            await page.close();
        }
        if (!testFilter || testFilter === 'consent') {
            const { page, errors } = await fixture(browser);
            await page.evaluate(() => {
                openNewContainerModal();
                setInput('nc-name', 'Without consent'); setInput('nc-pw', 'pass'); setInput('nc-pw2', 'pass');
                enter('nc-pw2');
            });
            await page.evaluate(() => Promise.all(pending));
            assert.equal(await page.evaluate(() => saved.length), 0);
            assert.equal(await page.evaluate(() => deriveCalls.length), 0);
            assert.equal(await page.locator('#nc-create').isDisabled(), true);
            assert.deepEqual(errors, []);
            console.log('PASS Enter cannot create a container without accepting the terms');
            await page.close();
        }
    } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
