'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

async function fixture(browser, kind = 'audio') {
    const page = await browser.newPage();
    for (const file of ['constants.js', 'fileops.js']) {
        // A local HTTP origin makes the constants' sessionStorage access available.
        if (file === 'constants.js') {
            await page.route('http://localhost/**', route => route.fulfill({ contentType: 'text/html', body: '<main></main>' }));
            await page.goto('http://localhost/');
            await page.evaluate(() => { window.App = {}; });
        }
        await page.addScriptTag({ content: fs.readFileSync(path.join(__dirname, '../src/js', file), 'utf8') });
    }
    await page.evaluate(kind => {
        window.player = _buildCustomPlayer('', kind);
        document.querySelector('main').appendChild(player);
        window.media = player.querySelector('audio,video');
        window.volume = player.querySelector('.player-vol');
        window.volumeButton = player.querySelectorAll('.player-btn')[1];
        window.setVolume = value => { volume.value = value; volume.dispatchEvent(new Event('input', { bubbles: true })); };
        window.press = (target, code, ctrlKey = false) => {
            const event = new KeyboardEvent('keydown', { code, ctrlKey, bubbles: true, cancelable: true });
            target.dispatchEvent(event);
            return event.defaultPrevented;
        };
    }, kind);
    return page;
}

const cases = [
    ['unmute button restores last audible volume after slider reaches zero', 'audio', async page => {
        const r = await page.evaluate(() => {
            setVolume(0.4); setVolume(0); volumeButton.click();
            return { muted: media.muted, volume: media.volume, slider: Number(volume.value) };
        });
        assert.deepEqual(r, { muted: false, volume: 0.4, slider: 0.4 });
    }],
    ['M restores audible volume after slider reaches zero', 'audio', async page => {
        const r = await page.evaluate(() => {
            setVolume(0.6); setVolume(0); press(document.body, 'KeyM');
            return { muted: media.muted, volume: media.volume, slider: Number(volume.value) };
        });
        assert.deepEqual(r, { muted: false, volume: 0.6, slider: 0.6 });
    }],
    ['M works while a player button has keyboard focus', 'audio', async page => {
        await page.locator('.player-btn').first().focus();
        await page.keyboard.press('m');
        assert.equal(await page.evaluate(() => media.muted), true);
    }],
    ['Ctrl+F remains a browser shortcut instead of entering fullscreen', 'video', async page => {
        const r = await page.evaluate(() => {
            let fullscreenCalls = 0;
            player.requestFullscreen = () => { fullscreenCalls++; };
            return { prevented: press(document.body, 'KeyF', true), fullscreenCalls };
        });
        assert.deepEqual(r, { prevented: false, fullscreenCalls: 0 });
    }],
    ['ordinary mute/unmute retains chosen volume', 'audio', async page => {
        const r = await page.evaluate(() => {
            setVolume(0.3); volumeButton.click();
            const muted = media.muted;
            volumeButton.click();
            return { muted, finalMuted: media.muted, volume: media.volume, slider: Number(volume.value) };
        });
        assert.deepEqual(r, { muted: true, finalMuted: false, volume: 0.3, slider: 0.3 });
    }],
    ['player leaves native range arrows and button Space behavior intact', 'audio', async page => {
        const r = await page.evaluate(() => ({
            rangeArrow: press(volume, 'ArrowRight'),
            buttonSpace: press(volumeButton, 'Space'),
        }));
        assert.deepEqual(r, { rangeArrow: false, buttonSpace: false });
    }],
];

(async () => {
    const browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_CHANNEL || 'msedge' });
    try {
        for (const [label, kind, run] of cases) {
            const page = await fixture(browser, kind);
            try { await run(page); console.log('PASS', label); }
            catch (error) { process.exitCode = 1; console.error('FAIL', label, error.message); }
            finally { await page.close(); }
        }
    } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
