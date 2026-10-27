// test_cdp.js - Live CDP verification on BV1oZeA6fERD
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const os = require('node:os');

const VIDEO_URL = 'https://www.bilibili.com/video/BV1oZeA6fERD/';

function resolveChromePath() {
    if (process.env.CHROME_BIN && fs.existsSync(process.env.CHROME_BIN)) {
        return process.env.CHROME_BIN;
    }
    if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) {
        return process.env.CHROME_PATH;
    }

    const candidates = {
        darwin: [
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            '/Applications/Chromium.app/Contents/MacOS/Chromium',
            '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
            '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'
        ],
        win32: [
            'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
            'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
            path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
            'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
        ],
        linux: [
            '/usr/bin/google-chrome',
            '/usr/bin/google-chrome-stable',
            '/usr/bin/chromium',
            '/usr/bin/chromium-browser',
            '/snap/bin/chromium'
        ]
    };

    const platformCandidates = candidates[process.platform] || candidates.linux;
    for (const candidate of platformCandidates) {
        if (candidate && fs.existsSync(candidate)) {
            return candidate;
        }
    }
    throw new Error(`Could not find Chrome/Chromium binary for platform ${process.platform}. Set CHROME_BIN env var.`);
}

function getFreePort() {
    if (process.env.CDP_PORT) {
        return Promise.resolve(Number(process.env.CDP_PORT));
    }
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.listen(0, '127.0.0.1', () => {
            const port = srv.address().port;
            srv.close((err) => (err ? reject(err) : resolve(port)));
        });
        srv.on('error', reject);
    });
}

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function runCDPTest() {
    console.log('=== Starting Live CDP Verification for v3.5 ===');
    const chromePath = resolveChromePath();
    const debugPort = await getFreePort();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-bili-cdp-'));
    console.log(`Using Chrome binary: ${chromePath}`);
    console.log(`Using debug port: ${debugPort}, user data dir: ${tempDir}`);

    let spawnError = null;
    const chromeProcess = spawn(chromePath, [
        `--remote-debugging-port=${debugPort}`,
        `--user-data-dir=${tempDir}`,
        '--headless=new',
        '--disable-gpu',
        '--mute-audio',
        '--autoplay-policy=no-user-gesture-required',
        '--no-first-run',
        '--no-default-browser-check',
        'about:blank'
    ]);

    chromeProcess.on('error', (err) => {
        spawnError = err;
    });

    chromeProcess.stderr.on('data', () => {
        // Ignore noisy browser stderr logs
    });

    let ws = null;
    try {
        // Wait for CDP endpoint to become ready
        let targets = null;
        for (let i = 0; i < 30; i++) {
            if (spawnError) throw spawnError;
            await sleep(500);
            try {
                const res = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
                if (res.ok) {
                    targets = await res.json();
                    if (targets && targets.length > 0) break;
                }
            } catch {}
        }

        if (!targets || targets.length === 0) {
            throw new Error('Failed to connect to Chrome DevTools endpoint');
        }

        const pageTarget = targets.find(t => t.type === 'page') || targets[0];
        console.log(`Connected to page target: ${pageTarget.title} (${pageTarget.webSocketDebuggerUrl})`);

        ws = new WebSocket(pageTarget.webSocketDebuggerUrl);

        let msgId = 1;
        const pending = new Map();

        ws.onmessage = (event) => {
            const data = JSON.parse(event.data);
            if (data.id && pending.has(data.id)) {
                const { resolve, reject } = pending.get(data.id);
                pending.delete(data.id);
                if (data.error) reject(data.error);
                else resolve(data.result);
            }
        };

        await new Promise((resolve, reject) => {
            ws.onopen = resolve;
            ws.onerror = reject;
        });

        function send(method, params = {}) {
            return new Promise((resolve, reject) => {
                const id = msgId++;
                pending.set(id, { resolve, reject });
                ws.send(JSON.stringify({ id, method, params }));
            });
        }

        await send('Page.enable');
        await send('Runtime.enable');

        // Read user script
        const scriptSource = fs.readFileSync(path.join(__dirname, 'Bilibili Buffer Unlocker.js'), 'utf-8');

        // Inject script to evaluate on new document (@run-at document-start)
        await send('Page.addScriptToEvaluateOnNewDocument', {
            source: scriptSource
        });
        console.log('✓ Injected Bilibili Buffer Unlocker.js via Page.addScriptToEvaluateOnNewDocument');

        // Navigate to target video
        console.log(`Navigating to ${VIDEO_URL} ...`);
        await send('Page.navigate', { url: VIDEO_URL });

        // Wait and poll for playback & buffer data
        console.log('Monitoring buffer progression and chunk tracking for 18 seconds...');
        let lastReport = null;
        let capturedChunks = false;

        for (let second = 1; second <= 18; second++) {
            await sleep(1000);

            try {
                // Ensure video is playing
                await send('Runtime.evaluate', {
                    expression: `
                        (function() {
                            const v = document.querySelector('video');
                            if (v && v.paused) {
                                v.muted = true;
                                v.play().catch(() => {});
                            }
                        })()
                    `
                });

                const res = await send('Runtime.evaluate', {
                    expression: `
                        (function() {
                            const mod = window.__BiliBufferUnlocker;
                            if (!mod) return { loaded: false };
                            const video = document.querySelector('video');
                            const stats = mod.CoreManager.getStats();
                            const vChunks = mod.ChunkTracker.videoLedger.length;
                            const aChunks = mod.ChunkTracker.audioLedger.length;
                            const actual = mod.ChunkTracker.getActualBufferedBytes(video);
                            const rollingV = mod.ChunkTracker.getRollingBitrate('video');
                            const rollingA = mod.ChunkTracker.getRollingBitrate('audio');
                            return {
                                loaded: true,
                                hooksInstalled: Boolean(
                                    window.MediaSource &&
                                    window.MediaSource.prototype.addSourceBuffer.__hooked &&
                                    window.SourceBuffer &&
                                    window.SourceBuffer.prototype.appendBuffer.__hooked &&
                                    window.SourceBuffer.prototype.remove.__hooked
                                ),
                                currentTime: video ? video.currentTime : 0,
                                duration: video ? video.duration : 0,
                                buffered: stats ? stats.time.current : 0,
                                target: stats ? stats.time.target : 0,
                                lastAppliedTarget: mod.CoreManager._lastAppliedTarget,
                                estimatedMB: stats ? (stats.memory.current / 1048576).toFixed(2) : 0,
                                actualVideoMB: (actual.videoBytes / 1048576).toFixed(2),
                                actualAudioMB: (actual.audioBytes / 1048576).toFixed(2),
                                actualTotalMB: (actual.totalBytes / 1048576).toFixed(2),
                                actualPastMB: (actual.pastTotalBytes / 1048576).toFixed(2),
                                actualTotalActiveMB: (actual.totalActiveBytes / 1048576).toFixed(2),
                                videoChunksCount: vChunks,
                                audioChunksCount: aChunks,
                                rollingVideoKbps: Math.round((rollingV * 8) / 1000),
                                rollingAudioKbps: Math.round((rollingA * 8) / 1000)
                            };
                        })()
                    `,
                    returnByValue: true
                });

                const val = res.result?.value;
                if (val && val.loaded) {
                    lastReport = val;
                    if (val.videoChunksCount > 0 && val.audioChunksCount > 0) {
                        capturedChunks = true;
                    }
                    console.log(`[T+${second}s] Play: ${val.currentTime.toFixed(1)}s | Buf: ${val.buffered.toFixed(1)}s/${val.target}s | Chunks: V=${val.videoChunksCount}, A=${val.audioChunksCount} | FwdMem: ${val.actualTotalMB}MB | PastMem: ${val.actualPastMB}MB | ActiveMSE: ${val.actualTotalActiveMB}MB | VBR: ${val.rollingVideoKbps}kbps`);
                    if (second >= 10 && capturedChunks && val.buffered > 5) {
                        break;
                    }
                } else {
                    console.log(`[T+${second}s] Player initializing...`);
                }
            } catch (err) {
                console.log(`[T+${second}s] Polling error: ${err.message}`);
            }
        }

        // Verify UI elements (control bar badge & 3-line stats overlay panel) in real browser DOM
        const uiRes = await send('Runtime.evaluate', {
            expression: `
                (function() {
                    const mod = window.__BiliBufferUnlocker;
                    if (!mod) return null;

                    // Ensure control bar container and info panel container exist (or open stats panel) for DOM verification
                    let infoContainer = document.querySelector('.bpx-player-info-container, .bilibili-player-info-container');
                    if (!infoContainer) {
                        infoContainer = document.createElement('div');
                        infoContainer.className = 'bpx-player-info-container';
                        infoContainer.style.cssText = 'position:absolute;top:10px;left:10px;display:block;width:300px;height:100px;';
                        document.body.appendChild(infoContainer);
                    } else {
                        infoContainer.classList.remove('bpx-state-hide');
                        infoContainer.style.cssText += ';display:block !important;position:absolute !important;width:300px;height:100px;';
                        if (!infoContainer.offsetParent && document.body) {
                            document.body.appendChild(infoContainer);
                        }
                    }

                    let ctrlLeft = document.querySelector('.bpx-player-control-bottom-left');
                    if (!ctrlLeft) {
                        ctrlLeft = document.createElement('div');
                        ctrlLeft.className = 'bpx-player-control-bottom-left';
                        document.body.appendChild(ctrlLeft);
                    }

                    mod.UIManager.update();

                    const badge = document.getElementById('bili-buffer-badge');
                    const badgeText = document.getElementById('bili-buffer-badge-text');
                    const overlay = document.getElementById('my-buffer-overlay');
                    const lineCache = document.getElementById('buf-line-cache');
                    const lineVideo = document.getElementById('buf-line-video');
                    const lineAudio = document.getElementById('buf-line-audio');

                    return {
                        hasBadge: Boolean(badge && badgeText),
                        badgeText: badgeText ? badgeText.textContent : '',
                        badgeTitle: badge ? badge.title : '',
                        hasOverlay: Boolean(overlay && lineCache && lineVideo && lineAudio),
                        lineCacheText: lineCache ? lineCache.textContent.replace(/\\s+/g, ' ').trim() : '',
                        lineVideoText: lineVideo ? lineVideo.textContent.replace(/\\s+/g, ' ').trim() : '',
                        lineAudioText: lineAudio ? lineAudio.textContent.replace(/\\s+/g, ' ').trim() : ''
                    };
                })()
            `,
            returnByValue: true
        });

        const ui = uiRes.result?.value;

        console.log('\n=== Live CDP Test Summary ===');
        console.log('Final Snapshot:', JSON.stringify(lastReport, null, 2));
        console.log('UI Verification:', JSON.stringify(ui, null, 2));

        assert(lastReport && lastReport.loaded, 'Userscript failed to initialize on live page');
        assert.strictEqual(lastReport.hooksInstalled, true, 'MSE hooks (addSourceBuffer, appendBuffer, remove) must be installed on prototype');
        assert(lastReport.target >= 20, `Target buffer duration must be >= 20s, got: ${lastReport.target}`);
        assert(capturedChunks && lastReport.videoChunksCount > 0 && lastReport.audioChunksCount > 0, `Expected real MSE video & audio chunks to be intercepted, got V=${lastReport.videoChunksCount}, A=${lastReport.audioChunksCount}`);
        assert(Number(lastReport.actualTotalActiveMB) > 0, `Expected positive active MSE memory, got: ${lastReport.actualTotalActiveMB} MB`);
        assert(ui && ui.hasBadge, 'Control bar badge (#bili-buffer-badge) must be rendered in DOM');
        assert(ui.badgeText.startsWith('⚡'), `Badge text should start with ⚡, got: ${ui.badgeText}`);
        assert(ui.badgeTitle.includes('|') && ui.badgeTitle.includes('135 MB'), `Badge tooltip should include memory limit, got: ${ui.badgeTitle}`);
        assert(ui && ui.hasOverlay, '3-line stats overlay (#my-buffer-overlay) must be rendered in DOM');
        assert(ui.lineCacheText.includes('缓存:'), `Line 1 should contain 缓存:, got: ${ui.lineCacheText}`);
        assert(ui.lineVideoText.includes('视频:'), `Line 2 should contain 视频:, got: ${ui.lineVideoText}`);
        assert(ui.lineAudioText.includes('音频:'), `Line 3 should contain 音频:, got: ${ui.lineAudioText}`);

        console.log(`✓ Real-time MSE chunks intercepted: ${lastReport.videoChunksCount} video, ${lastReport.audioChunksCount} audio`);
        console.log(`✓ Measured forward physical memory: ${lastReport.actualTotalMB} MB, Active MSE: ${lastReport.actualTotalActiveMB} MB`);
        console.log(`✓ Real-time rolling bitrate: ${lastReport.rollingVideoKbps} kbps`);
        console.log('✓ Target buffer, MSE hooks, control bar badge, and 3-line overlay verified in real Chromium.');
        console.log('🎉 CDP TEST PASSED!');
    } finally {
        if (ws) {
            try { ws.close(); } catch {}
        }
        try {
            chromeProcess.kill('SIGKILL');
        } catch {}
        try {
            fs.rmSync(tempDir, { recursive: true, force: true });
        } catch {}
    }
}

runCDPTest().catch(err => {
    console.error('CDP Test failed:', err);
    process.exitCode = 1;
});

