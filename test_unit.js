// test_unit.js - Automated unit tests for Bilibili Buffer Unlocker v3.3
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

console.log('--- Running Automated Unit Tests for v3.3 ---');

// Setup mock browser environment
class MockTimeRanges {
    constructor(ranges = []) {
        this._ranges = ranges.map(r => ({ start: r[0], end: r[1] }));
    }
    get length() { return this._ranges.length; }
    start(i) { return this._ranges[i]?.start; }
    end(i) { return this._ranges[i]?.end; }
    _setRanges(ranges) {
        this._ranges = ranges.map(r => ({ start: r[0], end: r[1] }));
    }
}

class MockEventTarget {
    constructor() {
        this._listeners = {};
    }
    addEventListener(event, fn, opts) {
        if (!this._listeners[event]) this._listeners[event] = [];
        this._listeners[event].push({ fn, once: opts?.once || false });
    }
    removeEventListener(event, fn) {
        if (!this._listeners[event]) return;
        this._listeners[event] = this._listeners[event].filter(l => l.fn !== fn);
    }
    dispatchEvent(event) {
        if (!this._listeners[event]) return;
        const list = [...this._listeners[event]];
        list.forEach(l => {
            if (l.once) {
                this.removeEventListener(event, l.fn);
            }
            l.fn({ type: event });
        });
    }
}

class MockSourceBuffer extends MockEventTarget {
    constructor() {
        super();
        this.buffered = new MockTimeRanges([]);
        this.updating = false;
        this.__appendedData = [];
    }
    appendBuffer(data) {
        this.updating = true;
        this.__appendedData.push(data);
        // Simulate async decoding and buffer range update before updateend
        setTimeout(() => {
            if (typeof this._onNextUpdate === 'function') {
                this._onNextUpdate();
                this._onNextUpdate = null;
            }
            this.updating = false;
            this.dispatchEvent('updateend');
        }, 5);
    }
    remove(start, end) {
        this.updating = true;
        setTimeout(() => {
            this.updating = false;
            this.dispatchEvent('updateend');
        }, 5);
    }
}

class MockMediaSource extends MockEventTarget {
    constructor() {
        super();
        this.sourceBuffers = [];
    }
    addSourceBuffer(mimeType) {
        const sb = new MockSourceBuffer();
        sb.__mime = mimeType;
        this.sourceBuffers.push(sb);
        return sb;
    }
}

// Mock DOM
const mockVideo = {
    currentTime: 0,
    duration: 300,
    buffered: new MockTimeRanges([]),
    seeking: false,
    currentSrc: 'https://test.bilibili.com/video.mp4',
    addEventListener: () => {}
};

const mockDocument = {
    readyState: 'complete',
    head: { appendChild: () => {} },
    body: { appendChild: () => {} },
    documentElement: { appendChild: () => {} },
    querySelector: (selector) => {
        if (selector === 'video') return mockVideo;
        if (selector.includes('info-container')) return mockInfoContainer;
        if (selector.includes('control-bottom-left')) return mockCtrlBottomLeft;
        return null;
    },
    querySelectorAll: (selector) => {
        if (selector.includes('my-buffer-overlay')) return mockInfoPanels;
        if (selector.includes('bili-buffer-badge')) return mockCtrlBadges;
        return [];
    },
    _elementsById: {},
    getElementById: (id) => mockDocument._elementsById[id] || null,
    createElement: (tag) => {
        const el = {
            tagName: tag.toUpperCase(),
            style: {},
            _id: '',
            _textContent: '',
            _subElements: {},
            set id(val) {
                this._id = val;
                mockDocument._elementsById[val] = this;
                if (!this._textContent) {
                    if (val === 'buf-hires-tag') this._textContent = 'Hi-Res 免干预';
                    else if (val === 'buf-video-val') this._textContent = '0 MB + 0 MB = 0 MB';
                    else if (val === 'buf-time-cur') this._textContent = '0s';
                    else if (val === 'buf-time-tar') this._textContent = '0s';
                    else if (val === 'buf-video-limit') this._textContent = '0 MB';
                    else if (val === 'buf-audio-val') this._textContent = '0 MB';
                    else if (val === 'buf-audio-limit') this._textContent = '0 MB';
                }
            },
            get id() { return this._id; },
            get textContent() {
                if (this._id === 'buf-line-cache') {
                    const cur = mockDocument._elementsById['buf-time-cur']?.textContent || '0s';
                    const tar = mockDocument._elementsById['buf-time-tar']?.textContent || '0s';
                    const hires = mockDocument._elementsById['buf-hires-tag'];
                    const hiresText = (hires && hires.style && hires.style.display === 'inline') ? ' [Hi-Res 免干预]' : '';
                    return `缓存: ${cur} / ${tar}${hiresText}`;
                }
                if (this._id === 'buf-line-video') {
                    return '视频: ' + (mockDocument._elementsById['buf-video-val']?.textContent || '0 MB') + ' / ' + (mockDocument._elementsById['buf-video-limit']?.textContent || '0 MB');
                }
                if (this._id === 'buf-line-audio') {
                    return '音频: ' + (mockDocument._elementsById['buf-audio-val']?.textContent || '0 MB') + ' / ' + (mockDocument._elementsById['buf-audio-limit']?.textContent || '0 MB');
                }
                if (this._id === 'my-buffer-overlay') {
                    const c = mockDocument._elementsById['buf-line-cache']?.textContent || '';
                    const v = mockDocument._elementsById['buf-line-video']?.textContent || '';
                    const a = mockDocument._elementsById['buf-line-audio']?.textContent || '';
                    return [c, v, a].filter(Boolean).join('\n');
                }
                return this._textContent;
            },
            set textContent(v) { this._textContent = v; },
            querySelector: function(sel) {
                if (!this._subElements[sel]) {
                    const sub = mockDocument.createElement('span');
                    if (sel.startsWith('#')) sub.id = sel.slice(1);
                    this._subElements[sel] = sub;
                }
                return this._subElements[sel];
            },
            querySelectorAll: function(sel) {
                if (sel === '.info-line') {
                    const l1 = mockDocument._elementsById['buf-line-cache'];
                    const l2 = mockDocument._elementsById['buf-line-video'];
                    const l3 = mockDocument._elementsById['buf-line-audio'];
                    return [l1, l2, l3].filter(Boolean);
                }
                return [];
            },
            addEventListener: () => {},
            contains: () => true,
            remove: function() {
                mockInfoPanels = mockInfoPanels.filter(p => p !== this);
                mockCtrlBadges = mockCtrlBadges.filter(b => b !== this);
                if (this._id) delete mockDocument._elementsById[this._id];
            }
        };
        return el;
    },
    addEventListener: () => {}
};

let mockInfoPanels = [];
const mockInfoContainer = {
    offsetParent: {},
    contains: (el) => mockInfoPanels.includes(el),
    appendChild: (el) => { if (!mockInfoPanels.includes(el)) mockInfoPanels.push(el); },
    querySelectorAll: (sel) => sel.includes('my-buffer-overlay') ? mockInfoPanels : []
};

let mockCtrlBadges = [];
const mockCtrlBottomLeft = {
    contains: (el) => mockCtrlBadges.includes(el),
    appendChild: (el) => { if (!mockCtrlBadges.includes(el)) mockCtrlBadges.push(el); },
    querySelectorAll: (sel) => sel.includes('bili-buffer-badge') ? mockCtrlBadges : []
};

const mockWindow = {
    MediaSource: MockMediaSource,
    SourceBuffer: MockSourceBuffer,
    document: mockDocument,
    setInterval: (fn) => setTimeout(fn, 100000),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    console: console,
    player: {
        __core: () => ({
            state: {
                mediaInfo: {
                    videoDataRate: 8000000, // 8 Mbps = 1,000,000 Bps
                    audioDataRate: 320000   // 320 kbps = 40,000 Bps
                }
            },
            _bufferTime: 20,
            setStableBufferTime(t) { this._bufferTime = t; },
            getStableBufferTime() { return this._bufferTime; },
            getBufferLength() { return 0; }
        })
    }
};

mockWindow.window = mockWindow;
mockWindow.unsafeWindow = mockWindow;

// Read and evaluate script in VM context
const scriptCode = fs.readFileSync(path.join(__dirname, 'Bilibili Buffer Unlocker.js'), 'utf-8');
const context = vm.createContext(mockWindow);
vm.runInContext(scriptCode, context);

const unlocker = mockWindow.__BiliBufferUnlocker;
assert(unlocker, 'Unlocker module should be exposed on window.__BiliBufferUnlocker');

const { ChunkTracker, CoreManager, UIManager, CONFIG, Utils } = unlocker;

console.log('✓ Script evaluated successfully, exposed modules verified.');

// Test 1: ChunkTracker Range Diffs
{
    console.log('\n[Test 1] Testing ChunkTracker.diffRanges...');
    // Initial append
    const d1 = ChunkTracker.diffRanges([], [{ start: 0, end: 3.01 }]);
    assert.strictEqual(d1.start, 0, 'First chunk start mismatch');
    assert.strictEqual(d1.end, 3.01, 'First chunk end mismatch');
    assert.strictEqual(d1.duration, 3.01, 'First chunk duration mismatch');

    // Sequential append
    const d2 = ChunkTracker.diffRanges(
        [{ start: 0, end: 3.01 }],
        [{ start: 0, end: 6.05 }]
    );
    assert(Math.abs(d2.start - 3.01) < 0.001, 'Sequential start mismatch');
    assert(Math.abs(d2.end - 6.05) < 0.001, 'Sequential end mismatch');
    assert(Math.abs(d2.duration - 3.04) < 0.001, 'Sequential duration mismatch');

    // Init segment append (no range added)
    const d3 = ChunkTracker.diffRanges(
        [{ start: 0, end: 6.05 }],
        [{ start: 0, end: 6.05 }]
    );
    assert.strictEqual(d3, null, 'Init segment should produce null diff');

    // Discontinuous append (seek)
    const d4 = ChunkTracker.diffRanges(
        [{ start: 0, end: 6.05 }],
        [{ start: 0, end: 6.05 }, { start: 50.0, end: 53.0 }]
    );
    assert.strictEqual(d4.start, 50.0, 'Seek chunk start mismatch');
    assert.strictEqual(d4.end, 53.0, 'Seek chunk end mismatch');
    assert.strictEqual(d4.duration, 3.0, 'Seek chunk duration mismatch');
    console.log('✓ ChunkTracker.diffRanges passed.');
}

// Test 2: ChunkTracker Ledgers & Overlap Replacement
{
    console.log('\n[Test 2] Testing ChunkTracker.recordChunk and ledger management...');
    ChunkTracker.reset();

    // Record sequential video chunks
    // Chunk 1: [0, 3], 3MB
    ChunkTracker.recordChunk('video', 0, 3, 3 * 1024 * 1024);
    // Chunk 2: [3, 6], 3MB
    ChunkTracker.recordChunk('video', 3, 6, 3 * 1024 * 1024);
    // Chunk 3: [6, 9], 6MB (bitrate surge)
    ChunkTracker.recordChunk('video', 6, 9, 6 * 1024 * 1024);

    assert.strictEqual(ChunkTracker.videoLedger.length, 3, 'Video ledger should have 3 chunks');

    // Test overwrite: A new chunk arrives covering [2, 5]
    ChunkTracker.recordChunk('video', 2, 5, 4 * 1024 * 1024);
    // Overlap should have pruned intervals [2, 5] from previous chunks
    const totalVideoLedgerDuration = ChunkTracker.videoLedger.reduce((sum, c) => sum + c.duration, 0);
    assert(Math.abs(totalVideoLedgerDuration - 9.0) < 0.05, `Total duration should be ~9s, got ${totalVideoLedgerDuration}`);
    console.log('✓ ChunkTracker ledger and overlap pruning passed.');
}

// Test 3: SourceBuffer.remove / pruneInterval
{
    console.log('\n[Test 3] Testing ChunkTracker.onRemove...');
    ChunkTracker.reset();
    ChunkTracker.recordChunk('video', 0, 10, 10 * 1024 * 1024);
    ChunkTracker.recordChunk('video', 10, 20, 10 * 1024 * 1024);

    // Remove [5, 15]
    ChunkTracker.onRemove('video', 5, 15);
    // Should leave [0, 5] (5s, 5MB) and [15, 20] (5s, 5MB)
    assert.strictEqual(ChunkTracker.videoLedger.length, 2, 'Should have 2 chunks after removal');
    assert.strictEqual(ChunkTracker.videoLedger[0].start, 0);
    assert.strictEqual(ChunkTracker.videoLedger[0].end, 5);
    assert.strictEqual(ChunkTracker.videoLedger[0].bytes, 5 * 1024 * 1024);

    assert.strictEqual(ChunkTracker.videoLedger[1].start, 15);
    assert.strictEqual(ChunkTracker.videoLedger[1].end, 20);
    assert.strictEqual(ChunkTracker.videoLedger[1].bytes, 5 * 1024 * 1024);
    console.log('✓ ChunkTracker onRemove interval pruning passed.');
}

// Test 4: getRollingBitrate (VBR surge detection)
{
    console.log('\n[Test 4] Testing ChunkTracker.getRollingBitrate...');
    ChunkTracker.reset();
    assert.strictEqual(ChunkTracker.getRollingBitrate('video'), 0, 'Empty ledger rolling bitrate should be 0');

    // Add 10 normal chunks (3s, 3MB each = 1MB/s = 8 Mbps)
    for (let i = 0; i < 10; i++) {
        ChunkTracker.recordChunk('video', i * 3, (i + 1) * 3, 3 * 1024 * 1024);
    }
    const normalBps = ChunkTracker.getRollingBitrate('video', 30);
    assert(Math.abs(normalBps - 1024 * 1024) < 10, `Expected ~1MB/s, got ${normalBps}`);

    // Now append a high-complexity surge: 3 chunks of 3s each with 9MB each (3MB/s = 24 Mbps)
    for (let i = 10; i < 13; i++) {
        ChunkTracker.recordChunk('video', i * 3, (i + 1) * 3, 9 * 1024 * 1024);
    }
    const surgeBps = ChunkTracker.getRollingBitrate('video', 9); // over last 9s
    assert(Math.abs(surgeBps - 3 * 1024 * 1024) < 10, `Surge bitrate should be ~3MB/s, got ${surgeBps}`);
    console.log('✓ ChunkTracker.getRollingBitrate and VBR surge detection passed.');
}

// Test 5: getActualBufferedBytes
{
    console.log('\n[Test 5] Testing ChunkTracker.getActualBufferedBytes...');
    ChunkTracker.reset();

    // Mock video with currentTime = 5, buffered = [[0, 20]]
    mockVideo.currentTime = 5;
    mockVideo.buffered._setRanges([[0, 20]]);

    // Record video chunks:
    // [0, 5]: 5MB (behind currentTime)
    // [5, 10]: 5MB (forward)
    // [10, 20]: 10MB (forward)
    // [20, 25]: 5MB (beyond forward buffered boundary of 20)
    ChunkTracker.recordChunk('video', 0, 5, 5 * 1024 * 1024);
    ChunkTracker.recordChunk('video', 5, 10, 5 * 1024 * 1024);
    ChunkTracker.recordChunk('video', 10, 20, 10 * 1024 * 1024);
    ChunkTracker.recordChunk('video', 20, 25, 5 * 1024 * 1024);

    // Audio chunk [0, 20]: 1MB
    ChunkTracker.recordChunk('audio', 0, 20, 1 * 1024 * 1024);

    const actual = ChunkTracker.getActualBufferedBytes(mockVideo);
    // Forward video: [5, 10] (5MB) + [10, 20] (10MB) = 15MB
    assert.strictEqual(actual.videoBytes, 15 * 1024 * 1024, `Expected 15MB forward video, got ${actual.videoBytes}`);
    assert.strictEqual(actual.forwardVideoBytes, 15 * 1024 * 1024);
    // Forward audio: [5, 20] of [0, 20] (15/20 * 1MB = 786432 bytes)
    const expectedAudio = Math.round(1 * 1024 * 1024 * (15 / 20));
    assert.strictEqual(actual.audioBytes, expectedAudio, `Expected ${expectedAudio} forward audio, got ${actual.audioBytes}`);
    assert.strictEqual(actual.forwardAudioBytes, expectedAudio);
    assert.strictEqual(actual.totalBytes, actual.videoBytes + actual.audioBytes);
    assert.strictEqual(actual.forwardTotalBytes, actual.videoBytes + actual.audioBytes);

    // Past video: [0, 5] (5MB)
    assert.strictEqual(actual.pastVideoBytes, 5 * 1024 * 1024, `Expected 5MB past video, got ${actual.pastVideoBytes}`);
    // Past audio: [0, 5] of [0, 20] (5/20 * 1MB = 262144 bytes)
    const expectedPastAudio = Math.round(1 * 1024 * 1024 * (5 / 20));
    assert.strictEqual(actual.pastAudioBytes, expectedPastAudio, `Expected ${expectedPastAudio} past audio, got ${actual.pastAudioBytes}`);
    assert.strictEqual(actual.pastTotalBytes, 5 * 1024 * 1024 + expectedPastAudio);

    // Total active ledger across all unpruned chunks:
    // Video: [0,5] (5M) + [5,10] (5M) + [10,20] (10M) + [20,25] (5M) = 25MB
    assert.strictEqual(actual.totalVideoBytes, 25 * 1024 * 1024, `Expected 25MB total active video, got ${actual.totalVideoBytes}`);
    // Audio: [0,20] = 1MB
    assert.strictEqual(actual.totalAudioBytes, 1 * 1024 * 1024, `Expected 1MB total active audio, got ${actual.totalAudioBytes}`);
    assert.strictEqual(actual.totalActiveBytes, 26 * 1024 * 1024);

    // ChunkTracker property getters & helper functions
    assert.strictEqual(ChunkTracker.totalVideoBytes, 25 * 1024 * 1024);
    assert.strictEqual(ChunkTracker.totalAudioBytes, 1 * 1024 * 1024);
    assert.strictEqual(ChunkTracker.totalBytes, 26 * 1024 * 1024);
    assert.strictEqual(ChunkTracker.getTotalActiveBytes('video'), 25 * 1024 * 1024);
    assert.strictEqual(ChunkTracker.getTotalActiveBytes('audio'), 1 * 1024 * 1024);
    assert.strictEqual(ChunkTracker.getTotalActiveBytes().totalBytes, 26 * 1024 * 1024);
    assert.strictEqual(ChunkTracker.getPastBufferedBytes(mockVideo, 'video'), 5 * 1024 * 1024);
    assert.strictEqual(ChunkTracker.getPastBufferedBytes(mockVideo, 'audio'), expectedPastAudio);
    console.log('✓ ChunkTracker.getActualBufferedBytes passed.');
}

// Test 6: CoreManager.calculateSafeDuration & Closed-Loop Memory Budgeting
{
    console.log('\n[Test 6] Testing CoreManager.calculateSafeDuration & Closed-Loop Regulation...');
    ChunkTracker.reset();

    // Baseline: manifest says 8 Mbps video (1,000,000 Bps), 320 kbps audio (40,000 Bps)
    // Safe limits: Video 125 MiB (131,072,000 B), Audio 9.5 MiB (9,961,472 B)
    // safeVideoSec = 131,072,000 / 1,000,000 = 131s
    // safeAudioSec = 9,961,472 / 40,000 = 249s
    // safeDuration = 131s
    const baseline = CoreManager.calculateSafeDuration();
    assert.strictEqual(baseline, 131, `Expected baseline 131s, got ${baseline}`);

    // Surge: ChunkTracker records rolling bitrate of 3,500,000 Bps (28 Mbps)
    // effectiveVideoBps = max(1,000,000, 3,500,000) = 3,500,000
    // safeVideoSec = 131,072,000 / 3,500,000 = 37.45s -> 37s
    mockVideo.currentTime = 0;
    mockVideo.buffered._setRanges([[0, 30]]);
    for (let i = 0; i < 10; i++) {
        ChunkTracker.recordChunk('video', i * 3, (i + 1) * 3, Math.round(3 * 3500000));
    }
    const surgeDuration = CoreManager.calculateSafeDuration();
    assert.strictEqual(surgeDuration, 37, `Expected 37s under surge, got ${surgeDuration}`);

    // Closed-loop regulation: Actual physical memory approaches SAFE_VIDEO_BYTE_LIMIT (>= 90%)
    // 90% of 125 MiB = 112.5 MiB (117,964,800 B)
    // Let current buffered ahead = 28s (video at 0, buffered [0, 28])
    mockVideo.currentTime = 0;
    mockVideo.buffered._setRanges([[0, 28]]);
    ChunkTracker.reset();
    ChunkTracker.recordChunk('video', 0, 28, 115 * 1024 * 1024); // 115 MiB (>= 90%)

    const throttledDuration = CoreManager.calculateSafeDuration();
    assert.strictEqual(throttledDuration, 28, `Expected target capped at current buffered 28s, got ${throttledDuration}`);
    console.log('✓ CoreManager closed-loop regulation passed.');
}

// Test 7: CoreManager.getStats() & UIManager Integration
{
    console.log('\n[Test 7] Testing CoreManager.getStats and UIManager integration...');
    const stats = CoreManager.getStats();
    assert(stats !== null, 'getStats should return object');
    assert(stats.memory.hasActual === true, 'hasActual should be true when chunks are recorded');
    assert(stats.memory.actualVideo > 0, 'actualVideo should be > 0');
    assert(stats.memory.actualCurrent > 0, 'actualCurrent should be > 0');
    assert(stats.memory.actualTotalActive !== undefined, 'actualTotalActive should be defined');
    assert(stats.memory.actualPastTotal !== undefined, 'actualPastTotal should be defined');

    // UI update
    UIManager.update();
    console.log('✓ getStats and UIManager passed.');
}

// Test 9: Edge Cases & Boundary Value Stress Tests
{
    console.log('\n[Test 9] Testing Edge Cases & Boundary Values...');
    ChunkTracker.reset();

    // Edge Case 9.1: Empty and invalid inputs to getActualBufferedBytes
    assert.strictEqual(ChunkTracker.getActualBufferedBytes(null).totalBytes, 0);
    assert.strictEqual(ChunkTracker.getActualBufferedBytes({ currentTime: NaN }).totalBytes, 0);
    assert.strictEqual(ChunkTracker.getActualBufferedBytes({ currentTime: -5, buffered: new MockTimeRanges([]) }).totalBytes, 0);
    assert.strictEqual(ChunkTracker.getActualBufferedBytes(null, 'video'), 0);
    assert.strictEqual(ChunkTracker.getActualBufferedBytes(null, 'audio'), 0);
    assert.strictEqual(ChunkTracker.getActualBufferedBytes(null, 'total'), 0);
    assert.strictEqual(ChunkTracker.getPastBufferedBytes(null, 'total'), 0);
    assert.strictEqual(ChunkTracker.getTotalActiveBytes('total'), 0);

    // Edge Case 9.2: Chunks behind currentTime or beyond forward buffer
    mockVideo.currentTime = 50;
    mockVideo.buffered._setRanges([[50, 70]]);
    // Chunk completely in past [0, 40]
    ChunkTracker.recordChunk('video', 0, 40, 20 * 1024 * 1024);
    // Chunk completely in future [80, 100]
    ChunkTracker.recordChunk('video', 80, 100, 20 * 1024 * 1024);
    assert.strictEqual(ChunkTracker.getActualBufferedBytes(mockVideo).videoBytes, 0, 'Past/future chunks should yield 0 forward bytes');

    // Edge Case 9.3: Invalid removeStart >= removeEnd in pruneInterval
    ChunkTracker.reset();
    ChunkTracker.recordChunk('video', 0, 10, 1000);
    ChunkTracker.pruneInterval(ChunkTracker.videoLedger, 10, 5); // inverted range
    assert.strictEqual(ChunkTracker.videoLedger.length, 1, 'Inverted prune range should be no-op');
    ChunkTracker.pruneInterval(ChunkTracker.videoLedger, 5, 5); // zero duration
    assert.strictEqual(ChunkTracker.videoLedger.length, 1, 'Zero duration prune should be no-op');

    // Edge Case 9.4: Split middle chunk into two
    ChunkTracker.pruneInterval(ChunkTracker.videoLedger, 4, 6);
    assert.strictEqual(ChunkTracker.videoLedger.length, 2, 'Middle prune should split into 2 chunks');
    assert.strictEqual(ChunkTracker.videoLedger[0].start, 0);
    assert.strictEqual(ChunkTracker.videoLedger[0].end, 4);
    assert.strictEqual(ChunkTracker.videoLedger[0].bytes, 400);
    assert.strictEqual(ChunkTracker.videoLedger[1].start, 6);
    assert.strictEqual(ChunkTracker.videoLedger[1].end, 10);
    assert.strictEqual(ChunkTracker.videoLedger[1].bytes, 400);

    // Edge Case 9.5: Gap bridging in diffRanges
    const bridged = ChunkTracker.diffRanges(
        [{ start: 0, end: 3 }, { start: 5, end: 8 }],
        [{ start: 0, end: 8 }]
    );
    assert(bridged !== null, 'Bridged range should be detected');
    assert.strictEqual(bridged.start, 3, 'Bridged gap start mismatch');
    assert.strictEqual(bridged.end, 5, 'Bridged gap end mismatch');

    // Edge Case 9.6: calculateSafeDuration with 0 rates
    const origGetMediaRates = CoreManager.getMediaRates;
    CoreManager.getMediaRates = () => ({ videoBps: 0, audioBps: 0, totalBps: 0 });
    ChunkTracker.reset();
    assert.strictEqual(CoreManager.calculateSafeDuration(), CONFIG.MAX_TIME_LIMIT, 'Zero rates should yield MAX_TIME_LIMIT');

    // Edge Case 9.7: Closed loop capping below MIN_TIME_LIMIT
    CoreManager.getMediaRates = origGetMediaRates;
    mockVideo.currentTime = 0;
    mockVideo.buffered._setRanges([[0, 5]]); // Only 5s buffered (< MIN_TIME_LIMIT of 20s)
    ChunkTracker.recordChunk('video', 0, 5, 115 * 1024 * 1024); // Exceeds 90% of 125 MiB
    const cappedBelowMin = CoreManager.calculateSafeDuration();
    assert.strictEqual(cappedBelowMin, CONFIG.MIN_TIME_LIMIT, 'Throttling should never drop below MIN_TIME_LIMIT');

    console.log('✓ Edge cases & boundary values passed.');
}

// Test 10: Video Source Switching vs Initial Load Persistence
{
    console.log('\n[Test 10] Testing initial load chunk persistence & video switch reset...');
    ChunkTracker.reset();
    CoreManager._lastVideoSrc = '';
    ChunkTracker.recordChunk('video', 0, 5, 2 * 1024 * 1024);
    assert.strictEqual(ChunkTracker.videoLedger.length, 1, 'Chunk should be recorded');

    // First UI update on page startup with newly mounted video
    CoreManager.trackBufferHealth(5, 0, 'blob:https://www.bilibili.com/part1', false);
    assert.strictEqual(ChunkTracker.videoLedger.length, 1, 'Initial update should NOT wipe startup chunks');

    // Switch video source (user clicks Next Video / P2)
    CoreManager.trackBufferHealth(0, 0, 'blob:https://www.bilibili.com/part2', false);
    assert.strictEqual(ChunkTracker.videoLedger.length, 0, 'Switching video source MUST reset ledger');
    console.log('✓ Video source switching vs initial load persistence passed.');
}

// Test 11: Audio Closed-Loop Memory Regulation
{
    console.log('\n[Test 11] Testing Audio closed-loop memory regulation...');
    ChunkTracker.reset();
    mockVideo.currentTime = 0;
    mockVideo.buffered._setRanges([[0, 30]]);

    // Video is well below limit: 20MB of 125 MiB limit
    ChunkTracker.recordChunk('video', 0, 30, 20 * 1024 * 1024);
    // Audio approaches 90% of SAFE_AUDIO_BYTE_LIMIT (9.5 MiB * 0.9 = 8.55 MiB)
    ChunkTracker.recordChunk('audio', 0, 30, 9.0 * 1024 * 1024);

    const safeSec = CoreManager.calculateSafeDuration();
    assert.strictEqual(safeSec, 30, `Expected safe duration capped to currentBuffered (30s) due to audio limit, got ${safeSec}`);
    console.log('✓ Audio closed-loop regulation passed.');
}

// Test 12: Sub-second Spike Rejection in getRollingBitrate
{
    console.log('\n[Test 12] Testing sub-second spike rejection in getRollingBitrate...');
    ChunkTracker.reset();
    // Simulate a single SPS / keyframe fragment of 0.04s with 200KB
    ChunkTracker.recordChunk('video', 0, 0.04, 200 * 1024);
    const rollingBps = ChunkTracker.getRollingBitrate('video');
    assert.strictEqual(rollingBps, 0, 'Sub-second sample (< 1.0s) should return 0 to prevent false VBR spikes');

    // Once normal chunks accumulate to >= 1.0s
    ChunkTracker.recordChunk('video', 0.04, 3.04, 1024 * 1024);
    const validRollingBps = ChunkTracker.getRollingBitrate('video');
    assert(validRollingBps > 0, 'Normal duration chunk should produce valid rolling bitrate');
    console.log('✓ Sub-second spike rejection passed.');
}

// Test 13: Bidirectional Range Expansion in diffRanges
{
    console.log('\n[Test 13] Testing bidirectional range expansion in diffRanges...');
    const dBoth = ChunkTracker.diffRanges(
        [{ start: 10, end: 12 }],
        [{ start: 8, end: 14 }]
    );
    assert(dBoth !== null, 'Bidirectional expansion should be detected');
    assert.strictEqual(dBoth.start, 8, 'Start should expand to 8');
    assert.strictEqual(dBoth.end, 14, 'End should expand to 14');
    assert.strictEqual(dBoth.duration, 6, 'Duration should be 6');
    console.log('✓ Bidirectional range expansion passed.');
}

// Test 14: Safe appendBuffer Hook Error Handling
{
    console.log('\n[Test 14] Testing appendBuffer exception handling & zero-byte buffer safety...');
    const sb = new MockSourceBuffer();
    let listenerCount = 0;
    const origAddEventListener = sb.addEventListener.bind(sb);
    sb.addEventListener = (event, fn, opts) => {
        if (event === 'updateend') listenerCount++;
        return origAddEventListener(event, fn, opts);
    };

    // Make appendBuffer throw synchronously
    const origAppend = MockSourceBuffer.prototype.appendBuffer;
    MockSourceBuffer.prototype.appendBuffer = function() {
        throw new Error('QuotaExceededError');
    };

    try {
        sb.appendBuffer(new Uint8Array(1024));
    } catch {}

    assert.strictEqual(listenerCount, 0, 'Synchronous appendBuffer error must NOT register updateend listener');
    MockSourceBuffer.prototype.appendBuffer = origAppend;
    console.log('✓ Safe appendBuffer error handling passed.');
}

// Test 15: Zero Manifest Bitrate Dynamic Fallback in getStats
{
    console.log('\n[Test 15] Testing zero manifest bitrate fallback in getStats...');
    ChunkTracker.reset();
    mockVideo.currentTime = 0;
    mockVideo.buffered._setRanges([[0, 20]]);
    ChunkTracker.recordChunk('video', 0, 20, 10 * 1024 * 1024);

    const origRates = CoreManager.getMediaRates;
    CoreManager.getMediaRates = () => ({ videoBps: 0, audioBps: 0, totalBps: 0 });

    const stats = CoreManager.getStats();
    assert(stats.bps > 0, 'Effective bps should be derived from chunk tracking when manifest bps is 0');
    assert(stats.memory.target > 0, 'Target memory should not be 0 when chunks exist');

    CoreManager.getMediaRates = origRates;
    console.log('✓ Zero manifest bitrate dynamic fallback passed.');
}

// Test 16: Total Active Ledger vs Forward & Past Decomposition
{
    console.log('\n[Test 16] Testing Total Active Ledger vs Forward & Past Decomposition...');
    ChunkTracker.reset();

    // Mock video with currentTime = 20, forward continuous buffer [20, 50]
    mockVideo.currentTime = 20;
    mockVideo.buffered._setRanges([[0, 50]]);

    // Record past video chunks: [0, 10] (10 MB), [10, 20] (10 MB) -> 20 MB past
    ChunkTracker.recordChunk('video', 0, 10, 10 * 1024 * 1024);
    ChunkTracker.recordChunk('video', 10, 20, 10 * 1024 * 1024);

    // Record forward video chunks: [20, 35] (15 MB), [35, 50] (15 MB) -> 30 MB forward
    ChunkTracker.recordChunk('video', 20, 35, 15 * 1024 * 1024);
    ChunkTracker.recordChunk('video', 35, 50, 15 * 1024 * 1024);

    // Record disjoint future unevicted chunk (e.g. user seek or prefetch) [60, 70] (10 MB)
    ChunkTracker.recordChunk('video', 60, 70, 10 * 1024 * 1024);

    // Record audio chunk straddling currentTime: [10, 30] (2 MB total)
    // currentTime = 20: past [10, 20] (1 MB), forward [20, 30] (1 MB)
    ChunkTracker.recordChunk('audio', 10, 30, 2 * 1024 * 1024);

    const actual = ChunkTracker.getActualBufferedBytes(mockVideo);

    // Forward checks
    assert.strictEqual(actual.forwardVideoBytes, 30 * 1024 * 1024, 'Forward video should be exactly 30MB');
    assert.strictEqual(actual.forwardAudioBytes, 1 * 1024 * 1024, 'Forward audio should be exactly 1MB');
    assert.strictEqual(actual.forwardTotalBytes, 31 * 1024 * 1024, 'Forward total should be 31MB');

    // Past checks
    assert.strictEqual(actual.pastVideoBytes, 20 * 1024 * 1024, 'Past video should be exactly 20MB');
    assert.strictEqual(actual.pastAudioBytes, 1 * 1024 * 1024, 'Past audio should be exactly 1MB');
    assert.strictEqual(actual.pastTotalBytes, 21 * 1024 * 1024, 'Past total should be 21MB');

    // Total active ledger checks (all unpruned chunks in MSE)
    // Video: 10 + 10 + 15 + 15 + 10 = 60 MB
    assert.strictEqual(actual.totalVideoBytes, 60 * 1024 * 1024, 'Total video should be 60MB');
    assert.strictEqual(actual.totalAudioBytes, 2 * 1024 * 1024, 'Total audio should be 2MB');
    assert.strictEqual(actual.totalActiveBytes, 62 * 1024 * 1024, 'Total active MSE memory should be 62MB');

    // Getter properties on ChunkTracker
    assert.strictEqual(ChunkTracker.totalVideoBytes, 60 * 1024 * 1024);
    assert.strictEqual(ChunkTracker.totalAudioBytes, 2 * 1024 * 1024);
    assert.strictEqual(ChunkTracker.totalBytes, 62 * 1024 * 1024);
    assert.strictEqual(ChunkTracker.getTotalActiveBytes('video'), 60 * 1024 * 1024);
    assert.strictEqual(ChunkTracker.getTotalActiveBytes('audio'), 2 * 1024 * 1024);
    assert.strictEqual(ChunkTracker.getTotalActiveBytes('total'), 62 * 1024 * 1024);
    assert.strictEqual(ChunkTracker.getTotalActiveBytes().totalBytes, 62 * 1024 * 1024);

    // Standalone past and forward helpers (with video param and with 'total' track)
    assert.strictEqual(ChunkTracker.getPastBufferedBytes(mockVideo, 'video'), 20 * 1024 * 1024);
    assert.strictEqual(ChunkTracker.getPastBufferedBytes(mockVideo, 'audio'), 1 * 1024 * 1024);
    assert.strictEqual(ChunkTracker.getPastBufferedBytes(mockVideo, 'total'), 21 * 1024 * 1024);
    assert.strictEqual(ChunkTracker.getForwardBufferedBytes(mockVideo, 'video'), 30 * 1024 * 1024);
    assert.strictEqual(ChunkTracker.getForwardBufferedBytes(mockVideo, 'audio'), 1 * 1024 * 1024);
    assert.strictEqual(ChunkTracker.getForwardBufferedBytes(mockVideo, 'total'), 31 * 1024 * 1024);
    assert.strictEqual(ChunkTracker.getActualBufferedBytes(mockVideo, 'total'), 31 * 1024 * 1024);

    // ChunkTracker property getters (delegating to mockVideo via DOM query)
    assert.strictEqual(ChunkTracker.forwardVideoBytes, 30 * 1024 * 1024);
    assert.strictEqual(ChunkTracker.forwardAudioBytes, 1 * 1024 * 1024);
    assert.strictEqual(ChunkTracker.forwardTotalBytes, 31 * 1024 * 1024);
    assert.strictEqual(ChunkTracker.pastVideoBytes, 20 * 1024 * 1024);
    assert.strictEqual(ChunkTracker.pastAudioBytes, 1 * 1024 * 1024);
    assert.strictEqual(ChunkTracker.pastTotalBytes, 21 * 1024 * 1024);

    console.log('✓ Total Active Ledger vs Forward & Past Decomposition passed.');
}

// Test 17: Dynamic Back-Buffer Headroom Shrinkage & Eviction Expansion
{
    console.log('\n[Test 17] Testing Dynamic Back-Buffer Headroom Regulation & Eviction Expansion...');
    ChunkTracker.reset();

    // Baseline rates: 1 MB/s video (8 Mbps), 40 KB/s audio
    mockVideo.currentTime = 20;
    mockVideo.buffered._setRanges([[20, 50]]); // 30s forward buffer ahead of currentTime

    // 17.1 Forward only (no past buffer): 30s forward = 30 MB (1 MB/s)
    ChunkTracker.recordChunk('video', 20, 50, 30 * 1024 * 1024);
    // Headroom = 125 MB - 30 MB = 95 MB -> 95s allowed additional -> currentBuffered (30s) + 95s = 125s
    const durNoPast = CoreManager.calculateSafeDuration();
    assert.strictEqual(durNoPast, 125, `Expected 125s without past buffer, got ${durNoPast}`);

    // 17.2 Add high back-buffer (35 MB retained at [-15, 20], duration 35s = 1 MB/s)
    ChunkTracker.recordChunk('video', -15, 20, 35 * 1024 * 1024);
    // Total video = 30 MB + 35 MB = 65 MB
    // Headroom shrinks: 125 MB - 65 MB = 60 MB -> 60s allowed additional
    // Target duration shrinks to currentBuffered (30s) + 60s = 90s!
    const durWithPast = CoreManager.calculateSafeDuration();
    assert.strictEqual(durWithPast, 90, `Expected headroom to shrink to 90s with back-buffer, got ${durWithPast}`);

    // 17.3 Back-buffer approaches limit (add more past buffer at 1 MB/s, reaching 115 MB total)
    // 115 MB >= 90% of 125 MB (112.5 MB)
    ChunkTracker.recordChunk('video', -65, -15, 50 * 1024 * 1024);
    assert(ChunkTracker.totalVideoBytes >= 115 * 1024 * 1024);
    const durNearLimit = CoreManager.calculateSafeDuration();
    // Clamped to currentBuffered (30s)
    assert.strictEqual(durNearLimit, 30, `Expected duration clamped to currentBuffered (30s) when near limit, got ${durNearLimit}`);

    // 17.4 Back-buffer eviction via ChunkTracker.onRemove:
    // Bilibili cleaner evicts [-65, 0], removing 50 MB + 15 MB = 65 MB
    ChunkTracker.onRemove('video', -65, 0);
    // Total video drops to 50 MB (< 90% of 125 MB)
    // Headroom expands to 125 MB - 50 MB = 75 MB -> 75s additional
    // Target duration expands back up to 30s + 75s = 105s!
    const durAfterEviction = CoreManager.calculateSafeDuration();
    assert.strictEqual(durAfterEviction, 105, `Expected duration to expand to 105s after eviction, got ${durAfterEviction}`);

    console.log('✓ Dynamic Back-Buffer Headroom Regulation & Eviction Expansion passed.');
}

// Test 18: Straddling Chunk Boundary Math Precision & Sub-Chunk Ratio Partitioning
{
    console.log('\n[Test 18] Testing Straddling Chunk Boundary Math Precision...');
    ChunkTracker.reset();

    // A single 20-second chunk [10, 30] of 20 MB (1 MB/s)
    ChunkTracker.recordChunk('video', 10, 30, 20 * 1024 * 1024);
    mockVideo.buffered._setRanges([[10, 30]]);

    // Subtest 18.1: currentTime = 15 (25% past, 75% forward)
    mockVideo.currentTime = 15;
    let act = ChunkTracker.getActualBufferedBytes(mockVideo);
    assert.strictEqual(act.pastVideoBytes, 5 * 1024 * 1024, 'Past bytes at 15s should be 5MB');
    assert.strictEqual(act.forwardVideoBytes, 15 * 1024 * 1024, 'Forward bytes at 15s should be 15MB');
    assert.strictEqual(act.pastVideoBytes + act.forwardVideoBytes, act.totalVideoBytes, 'Sum of past and forward must equal total active bytes');

    // Subtest 18.2: currentTime = 10 (at chunk start: 0% past, 100% forward)
    mockVideo.currentTime = 10;
    act = ChunkTracker.getActualBufferedBytes(mockVideo);
    assert.strictEqual(act.pastVideoBytes, 0, 'Past bytes at start should be 0');
    assert.strictEqual(act.forwardVideoBytes, 20 * 1024 * 1024, 'Forward bytes at start should be 20MB');

    // Subtest 18.3: currentTime = 30 (at chunk end: 100% past, 0% forward)
    mockVideo.currentTime = 30;
    act = ChunkTracker.getActualBufferedBytes(mockVideo);
    assert.strictEqual(act.pastVideoBytes, 20 * 1024 * 1024, 'Past bytes at end should be 20MB');
    assert.strictEqual(act.forwardVideoBytes, 0, 'Forward bytes at end should be 0');

    console.log('✓ Straddling Chunk Boundary Math Precision passed.');
}

// Test 19: UIManager and getStats Multi-Line Stats Panel Integration & Color Logic
{
    console.log('\n[Test 19] Testing UIManager and getStats Multi-Line Stats Panel Integration & Color Logic...');
    ChunkTracker.reset();
    mockVideo.currentTime = 10;
    mockVideo.buffered._setRanges([[0, 40]]);
    // 10 MB past video, 30 MB forward video -> 40 MB total video
    ChunkTracker.recordChunk('video', 0, 10, 10 * 1024 * 1024);
    ChunkTracker.recordChunk('video', 10, 40, 30 * 1024 * 1024);
    // Audio 9.48 MB (tests sub-MB precision formatting)
    ChunkTracker.recordChunk('audio', 0, 40, 9.48 * 1024 * 1024);

    const stats = CoreManager.getStats();
    assert.strictEqual(stats.memory.actualPastVideo, 10 * 1024 * 1024);
    assert.strictEqual(stats.memory.actualVideo, 30 * 1024 * 1024);
    assert.strictEqual(stats.memory.actualTotalVideo, 40 * 1024 * 1024);
    assert.strictEqual(stats.memory.actualTotalAudio, 9.48 * 1024 * 1024);
    assert.strictEqual(stats.memory.limit, 135 * 1024 * 1024);

    // Verify UI update renders multi-line stats panel
    UIManager.update();
    const panel = UIManager.statsPanelRef;
    assert(panel !== null, 'Stats panel should be created');

    const el = UIManager.cachedStatsElements;
    assert(el !== null, 'cachedStatsElements should exist');

    // Check Line 1: 缓存 (缓存: 30s / ...)
    const lineCache = panel.querySelector('#buf-line-cache');
    assert.strictEqual(el.timeCur.textContent, '30s');
    assert.strictEqual(lineCache.textContent, `缓存: 30s / ${el.timeTar.textContent}`);

    // Check Line 2: 视频 (视频: 10 MB + 30 MB = 40 MB / 135 MB)
    const lineVideo = panel.querySelector('#buf-line-video');
    assert.strictEqual(el.videoVal.textContent, '10 MB + 30 MB = 40 MB');
    assert.strictEqual(el.videoLimit.textContent, '135 MB');
    assert.strictEqual(lineVideo.textContent, '视频: 10 MB + 30 MB = 40 MB / 135 MB');

    // Check Line 3: 音频 (音频: 9.48 MB / 9.5 MB)
    const lineAudio = panel.querySelector('#buf-line-audio');
    assert.strictEqual(el.audioVal.textContent, '9.48 MB');
    assert.strictEqual(el.audioLimit.textContent, '9.5 MB');
    assert.strictEqual(lineAudio.textContent, '音频: 9.48 MB / 9.5 MB');

    // Check full panel text structure
    const fullText = panel.textContent;
    assert(fullText.includes(`缓存: 30s / ${el.timeTar.textContent}`), 'Panel should include Line 1 缓存');
    assert(fullText.includes('视频: 10 MB + 30 MB = 40 MB / 135 MB'), 'Panel should include Line 2 视频');
    assert(fullText.includes('音频: 9.48 MB / 9.5 MB'), 'Panel should include Line 3 音频');

    // Check Hi-Res tag display (hidden by default, visible when hiRes: true)
    assert.strictEqual(el.hiresTag.style.display, 'none', 'Hi-Res tag should be hidden by default');
    const statsHiRes = Object.assign({}, stats, { hiRes: true });
    UIManager.updateStatsPanel(statsHiRes);
    assert.strictEqual(el.hiresTag.style.display, 'inline', 'Hi-Res tag should be visible when hiRes is true');
    assert.strictEqual(el.hiresTag.textContent, 'Hi-Res 免干预', 'Hi-Res tag text should match');
    assert(panel.querySelector('#buf-line-cache').textContent.includes('Hi-Res 免干预'), 'Line 1 text should include Hi-Res tag');
    // Restore non-Hi-Res state
    UIManager.updateStatsPanel(stats);
    assert.strictEqual(el.hiresTag.style.display, 'none', 'Hi-Res tag should be hidden again');

    // Check Color Logic:
    // Video: 40 MB / 125 MB = 32% (< 80%) -> #00aeec
    // Audio: 9.48 MB / 9.5 MB = 99.8% (>= 90%) -> #ff7a45
    // Max ratio: 99.8% (>= 90%) -> #ff7a45 (Buffer throttled by audio saturation)
    assert.strictEqual(el.videoVal.style.color, '#00aeec', 'Video should be cyan (< 80%)');
    assert.strictEqual(el.audioVal.style.color, '#ff7a45', 'Audio should be coral (>= 90%)');
    assert.strictEqual(el.timeCur.style.color, '#ff7a45', 'Buffer time should be coral because overall buffer is capped by audio');

    // Subtest: Test amber warning color (0.80 <= ratio < 0.90)
    // Evict audio, and add video to 105 MB (105 / 125 = 84%)
    ChunkTracker.reset();
    ChunkTracker.recordChunk('video', 0, 30, 105 * 1024 * 1024);
    ChunkTracker.recordChunk('audio', 0, 30, 1 * 1024 * 1024); // 1 MB / 9.5 MB = 10.5%
    UIManager.update();
    assert.strictEqual(el.videoVal.style.color, '#faad14', 'Video at 84% should be amber (#faad14)');
    assert.strictEqual(el.audioVal.style.color, '#00aeec', 'Audio at 10.5% should be cyan (#00aeec)');
    assert.strictEqual(el.timeCur.style.color, '#faad14', 'Buffer time at 84% max ratio should be amber (#faad14)');

    // Subtest: Test all cyan (< 0.80) & past = 0 format
    ChunkTracker.reset();
    ChunkTracker.recordChunk('video', 10, 40, 58 * 1024 * 1024); // 58 MB forward, 0 past
    ChunkTracker.recordChunk('audio', 10, 40, 2 * 1024 * 1024);  // 2 MB audio
    UIManager.update();
    assert.strictEqual(el.videoVal.textContent, '0 MB + 58 MB = 58 MB', 'Past=0 should display 0 MB + 58 MB = 58 MB');
    assert.strictEqual(el.videoVal.style.color, '#00aeec', 'Video at 46% should be cyan (#00aeec)');
    assert.strictEqual(el.audioVal.style.color, '#00aeec', 'Audio at 21% should be cyan (#00aeec)');
    assert.strictEqual(el.timeCur.style.color, '#00aeec', 'Buffer time at 46% should be cyan (#00aeec)');

    // Subtest: Test exact prompt example
    // 缓存: 7m39s / 7m39s
    // 视频: 0.5 MB + 58 MB = 59 MB / 135 MB
    // 音频: 9.48 MB / 9.5 MB
    ChunkTracker.reset();
    mockVideo.currentTime = 459; // 7m39s
    mockVideo.duration = 918;
    mockVideo.buffered._setRanges([[0, 918]]); // 459s forward buffer = 7m39s
    ChunkTracker.recordChunk('video', 458.5, 459, 0.5 * 1024 * 1024); // 0.5 MB past
    ChunkTracker.recordChunk('video', 459, 918, 58 * 1024 * 1024);     // 58 MB forward
    ChunkTracker.recordChunk('audio', 0, 918, 9.48 * 1024 * 1024);     // 9.48 MB audio
    UIManager.update();
    assert.strictEqual(el.timeCur.textContent, '7m39s');
    assert.strictEqual(el.videoVal.textContent, '0.5 MB + 58 MB = 59 MB');
    assert.strictEqual(el.videoLimit.textContent, '135 MB');
    assert.strictEqual(el.audioVal.textContent, '9.48 MB');
    assert.strictEqual(el.audioLimit.textContent, '9.5 MB');
    assert.strictEqual(lineVideo.textContent, '视频: 0.5 MB + 58 MB = 59 MB / 135 MB');
    assert.strictEqual(lineAudio.textContent, '音频: 9.48 MB / 9.5 MB');

    // Subtest: Boundary test Utils.getColorByRatio and Utils.formatSize
    assert.strictEqual(Utils.getColorByRatio(0), '#00aeec');
    assert.strictEqual(Utils.getColorByRatio(0.799), '#00aeec');
    assert.strictEqual(Utils.getColorByRatio(0.80), '#faad14');
    assert.strictEqual(Utils.getColorByRatio(0.899), '#faad14');
    assert.strictEqual(Utils.getColorByRatio(0.90), '#ff7a45');
    assert.strictEqual(Utils.getColorByRatio(1.2), '#ff7a45');
    assert.strictEqual(Utils.getColorByRatio(Infinity), '#ff7a45');
    assert.strictEqual(Utils.getColorByRatio(NaN), '#00aeec');
    assert.strictEqual(Utils.getColorByRatio(undefined), '#00aeec');
    assert.strictEqual(Utils.getColorByRatio(null), '#00aeec');
    assert.strictEqual(Utils.getColorByRatio(-1), '#00aeec');

    assert.strictEqual(Utils.formatSize(0), '0 MB');
    assert.strictEqual(Utils.formatSize(0.5 * 1024 * 1024), '0.5 MB');
    assert.strictEqual(Utils.formatSize(9.48 * 1024 * 1024), '9.48 MB');
    assert.strictEqual(Utils.formatSize(9.5 * 1024 * 1024), '9.5 MB');
    assert.strictEqual(Utils.formatSize(10 * 1024 * 1024), '10 MB');
    assert.strictEqual(Utils.formatSize(58 * 1024 * 1024), '58 MB');
    assert.strictEqual(Utils.formatSize(59 * 1024 * 1024), '59 MB');
    assert.strictEqual(Utils.formatSize(135 * 1024 * 1024), '135 MB');
    assert.strictEqual(Utils.formatSize(0.005 * 1024 * 1024), '<0.01 MB');
    assert.strictEqual(Utils.formatSize(-100), '0 MB');
    assert.strictEqual(Utils.formatSize(NaN), '0 MB');
    assert.strictEqual(Utils.formatSize(undefined), '0 MB');
    assert.strictEqual(Utils.formatSize(null), '0 MB');

    console.log('✓ UIManager and getStats Multi-Line Stats Panel Integration & Color Logic passed.');
}

// Test 20: Audio Back-Buffer Dynamic Headroom Regulation & Eviction Expansion
{
    console.log('\n[Test 20] Testing Audio Back-Buffer Dynamic Headroom Regulation & Eviction Expansion...');
    ChunkTracker.reset();

    // Baseline rates: Manifest video 8 Mbps (1 MB/s), Audio 320 kbps (40 KB/s)
    mockVideo.currentTime = 50;
    mockVideo.buffered._setRanges([[50, 80]]); // 30s forward ahead of 50s
    // Video has 30 MB forward (1 MB/s, well within 125 MB)
    ChunkTracker.recordChunk('video', 50, 80, 30 * 1024 * 1024);

    // Subtest 20.1: Forward audio only [50, 80] = 30s * 40 KB/s = 1.2 MB
    ChunkTracker.recordChunk('audio', 50, 80, 1.2 * 1024 * 1024);
    // Headroom audio = 9.5 MB - 1.2 MB = 8.3 MB -> 8.3 MB / 40 KB/s = 207.5s -> 30 + 207 = 237s
    // Video headroom = 125 MB - 30 MB = 95 MB -> 95s -> 30 + 95 = 125s
    // Min(125s, 237s) = 125s
    const durNormal = CoreManager.calculateSafeDuration();
    assert.strictEqual(durNormal, 125);

    // Subtest 20.2: Heavy back-buffer audio accumulated (e.g. 7.5 MB past audio [0, 50])
    // Total audio = 1.2 MB + 7.5 MB = 8.7 MB
    // 8.7 MB >= 90% of 9.5 MB (8.55 MB)!
    ChunkTracker.recordChunk('audio', 0, 50, 7.5 * 1024 * 1024);
    assert(ChunkTracker.totalAudioBytes >= 8.55 * 1024 * 1024, 'Audio should be near 90% limit');
    const durAudioNearLimit = CoreManager.calculateSafeDuration();
    assert.strictEqual(durAudioNearLimit, 30, `Expected duration clamped to currentBuffered (30s) due to audio back-buffer near limit, got ${durAudioNearLimit}`);

    // Subtest 20.3: Back-buffer audio eviction via onRemove
    // Bilibili cleaner evicts audio past buffer [0, 40] (6 MB)
    ChunkTracker.onRemove('audio', 0, 40);
    // Total audio drops to 8.7 - 6.0 = 2.7 MB (< 90% of 9.5 MB)
    // Audio headroom expands: 9.5 MB - 2.7 MB = 6.8 MB -> 6.8 MB / 40 KB/s = 170s -> 30 + 170 = 200s
    // Video headroom remains 125s -> safeDuration = min(125, 200) = 125s
    const durAfterAudioEvict = CoreManager.calculateSafeDuration();
    assert.strictEqual(durAfterAudioEvict, 125, `Expected duration to rebound to 125s after audio eviction, got ${durAfterAudioEvict}`);

    console.log('✓ Audio Back-Buffer Dynamic Headroom Regulation & Eviction Expansion passed.');
}

// Test 21: Total Physical Byte Limit (SAFE_BYTE_LIMIT) Closed-Loop Regulation
{
    console.log('\n[Test 21] Testing Total Physical Byte Limit (SAFE_BYTE_LIMIT) Closed-Loop Regulation...');
    ChunkTracker.reset();

    // Rates: Video 1 MB/s, Audio 40 KB/s -> Total Bps = 1,040,000 Bps
    // Test custom SAFE_BYTE_LIMIT constraint
    const origSafeLimit = CONFIG.SAFE_BYTE_LIMIT;
    CONFIG.SAFE_BYTE_LIMIT = 100 * 1024 * 1024; // 100 MiB total limit (90% = 90 MiB)

    mockVideo.currentTime = 30;
    mockVideo.buffered._setRanges([[30, 60]]); // 30s forward buffer ahead

    // Video: 30s forward = 30 MB, 40 MB past = 70 MB total (< 90% of 125 MB = 112.5 MB)
    // Audio: 30s forward = 1.2 MB, 3.8 MB past = 5 MB total (< 90% of 9.5 MB = 8.55 MB)
    // Total Active: 70 MB + 5 MB = 75 MB (< 90% of 100 MB = 90 MB)
    ChunkTracker.recordChunk('video', 30, 60, 30 * 1024 * 1024);
    ChunkTracker.recordChunk('video', 0, 30, 40 * 1024 * 1024);
    ChunkTracker.recordChunk('audio', 30, 60, 1.2 * 1024 * 1024);
    ChunkTracker.recordChunk('audio', 0, 30, 3.8 * 1024 * 1024);

    assert(ChunkTracker.totalVideoBytes < CONFIG.SAFE_VIDEO_BYTE_LIMIT * 0.90, 'Video alone is below 90%');
    assert(ChunkTracker.totalAudioBytes < CONFIG.SAFE_AUDIO_BYTE_LIMIT * 0.90, 'Audio alone is below 90%');
    assert(ChunkTracker.totalBytes < CONFIG.SAFE_BYTE_LIMIT * 0.90, 'Total active is below 90%');

    // Total headroom: 100 MB - 75 MB = 25 MB (26,214,400 B)
    // Most recent chunks yield rolling rates: video 40MB/30s = 1,398,101 Bps, audio 3.8MB/30s = 132,820 Bps
    // effectiveTotalBps = 1,530,920 Bps
    // allowedTotalSec = 26,214,400 / 1,530,920 ≈ 17.12s -> Math.floor(30 + 17.12) = 47s
    // Video headroom alone: (125 - 70) MB / 1.398 MB/s = 39.3s -> 30 + 39 = 69s
    // Safe duration governed by total headroom: min(69s, 47s) = 47s!
    const durTotalHeadroom = CoreManager.calculateSafeDuration();
    assert.strictEqual(durTotalHeadroom, 47, `Expected duration throttled by total headroom to 47s, got ${durTotalHeadroom}`);

    // Subtest 21.2: Add past chunk pushing total active to 92 MB (>= 90% of 100 MB = 90 MB)
    // Video: +17 MB past = 87 MB (< 112.5 MB)
    // Audio: 5 MB (< 8.55 MB)
    // Total: 87 + 5 = 92 MB >= 90 MB!
    ChunkTracker.recordChunk('video', -20, 0, 17 * 1024 * 1024);
    assert(ChunkTracker.totalVideoBytes < CONFIG.SAFE_VIDEO_BYTE_LIMIT * 0.90, 'Video is still below 90% of 125MB');
    assert(ChunkTracker.totalAudioBytes < CONFIG.SAFE_AUDIO_BYTE_LIMIT * 0.90, 'Audio is still below 90% of 9.5MB');
    assert(ChunkTracker.totalBytes >= CONFIG.SAFE_BYTE_LIMIT * 0.90, 'Total active reaches 90% of SAFE_BYTE_LIMIT');

    const durTotalNearLimit = CoreManager.calculateSafeDuration();
    assert.strictEqual(durTotalNearLimit, 30, `Expected duration clamped to currentBuffered (30s) due to total near limit, got ${durTotalNearLimit}`);

    // Restore CONFIG.SAFE_BYTE_LIMIT
    CONFIG.SAFE_BYTE_LIMIT = origSafeLimit;
    console.log('✓ Total Physical Byte Limit (SAFE_BYTE_LIMIT) Closed-Loop Regulation passed.');
}

// Test 22: UIManager.updateControlBarBadge Lifecycle, Simplified Tooltip & Text Color Logic
{
    console.log('\n[Test 22] Testing UIManager.updateControlBarBadge Lifecycle, Simplified Tooltip & Text Color Logic...');
    ChunkTracker.reset();

    mockVideo.currentTime = 10;
    mockVideo.buffered._setRanges([[0, 40]]);
    ChunkTracker.recordChunk('video', 0, 10, 10 * 1024 * 1024);
    ChunkTracker.recordChunk('video', 10, 40, 30 * 1024 * 1024);

    const stats = CoreManager.getStats();
    UIManager.updateControlBarBadge(stats);

    const badge = UIManager.badgeRef;
    assert(badge !== null, 'Badge element should be created');
    assert.strictEqual(badge.id, 'bili-buffer-badge');
    assert.strictEqual(UIManager.badgeTextRef.textContent, `⚡${Utils.formatTime(stats.time.current)}`);

    // Verify tooltip follows clean format: ${timeCur} / ${timeTar} | ${memTotalActive} / ${memLimit}
    const expectedTooltip = `${Utils.formatTime(stats.time.current)} / ${Utils.formatTime(stats.time.target)} | 40 MB / 135 MB`;
    assert.strictEqual(badge.title, expectedTooltip, `Badge title should be '${expectedTooltip}', got: ${badge.title}`);

    // Verify badge text color (< 0.80 -> #00aeec)
    assert.strictEqual(UIManager.badgeTextRef.style.color, '#00aeec', 'Badge text color should be cyan (< 80%)');
    // Verify border is not altered (only text color changes)
    assert.strictEqual(UIManager.badgeTextRef.style.border, undefined, 'Badge text border should not be touched');
    assert.strictEqual(UIManager.badgeTextRef.style.borderColor, undefined, 'Badge text borderColor should not be touched');

    // Test badge when past memory is 0
    ChunkTracker.onRemove('video', 0, 10);
    const statsNoPast = CoreManager.getStats();
    UIManager.updateControlBarBadge(statsNoPast);
    const expectedTooltipNoPast = `${Utils.formatTime(statsNoPast.time.current)} / ${Utils.formatTime(statsNoPast.time.target)} | 30 MB / 135 MB`;
    assert.strictEqual(badge.title, expectedTooltipNoPast, `Badge title without past should be '${expectedTooltipNoPast}', got: ${badge.title}`);

    // Test warning color (0.80 <= ratio < 0.90 -> #faad14)
    ChunkTracker.reset();
    ChunkTracker.recordChunk('video', 0, 30, 105 * 1024 * 1024); // 105 / 125 = 84%
    const statsAmber = CoreManager.getStats();
    UIManager.updateControlBarBadge(statsAmber);
    assert.strictEqual(UIManager.badgeTextRef.style.color, '#faad14', 'Badge text color should be amber at 84%');

    // Test capped color (ratio >= 0.90 -> #ff7a45)
    ChunkTracker.recordChunk('video', 30, 35, 12 * 1024 * 1024); // 117 / 125 = 93.6%
    const statsCoral = CoreManager.getStats();
    UIManager.updateControlBarBadge(statsCoral);
    assert.strictEqual(UIManager.badgeTextRef.style.color, '#ff7a45', 'Badge text color should be coral at >= 90%');

    // Test audio saturation triggering coral on badge text (> 90%)
    ChunkTracker.reset();
    ChunkTracker.recordChunk('video', 0, 30, 20 * 1024 * 1024); // Video 20 MB / 125 MB = 16% (cyan)
    ChunkTracker.recordChunk('audio', 0, 30, 9.48 * 1024 * 1024); // Audio 9.48 MB / 9.5 MB = 99.8% (coral)
    const statsAudioCap = CoreManager.getStats();
    UIManager.updateControlBarBadge(statsAudioCap);
    assert.strictEqual(UIManager.badgeTextRef.style.color, '#ff7a45', 'Badge text should be coral when audio triggers saturation cap');
    assert.strictEqual(badge.title, `${Utils.formatTime(statsAudioCap.time.current)} / ${Utils.formatTime(statsAudioCap.time.target)} | 29 MB / 135 MB`);
    assert.strictEqual(UIManager.badgeTextRef.title, badge.title, 'Badge text title should mirror badge.title');

    // Test fallback before actual chunks (hasActual = false)
    const statsFallback = {
        time: { current: 15, target: 60, percent: 25 },
        memory: { current: 20 * 1024 * 1024, limit: 135 * 1024 * 1024, hasActual: false }
    };
    UIManager.updateControlBarBadge(statsFallback);
    const expectedFallbackTooltip = `15s / 1m00s | 20 MB / 135 MB`;
    assert.strictEqual(badge.title, expectedFallbackTooltip, `Fallback badge title should be '${expectedFallbackTooltip}', got: ${badge.title}`);
    assert.strictEqual(UIManager.badgeTextRef.style.color, '#00aeec', 'Fallback badge text color should be cyan (< 80%)');

    console.log('✓ UIManager.updateControlBarBadge Lifecycle, Simplified Tooltip & Text Color Logic passed.');
}

// Test 8: End-to-end MSE Hook interception
async function testMSEHooks() {
    console.log('\n[Test 8] Testing live MSE hook execution with MockMediaSource...');
    ChunkTracker.reset();
    const ms = new MockMediaSource();
    const videoSb = ms.addSourceBuffer('video/mp4; codecs="avc1.640028"');
    const audioSb = ms.addSourceBuffer('audio/mp4; codecs="mp4a.40.2"');

    assert.strictEqual(videoSb.__trackType, 'video', 'Video track type should be tagged');
    assert.strictEqual(audioSb.__trackType, 'audio', 'Audio track type should be tagged');

    // Simulate appending chunk 1 [0, 3] (3MB)
    videoSb._onNextUpdate = () => {
        videoSb.buffered._setRanges([[0, 3]]);
    };
    const chunkData = new Uint8Array(3 * 1024 * 1024);
    videoSb.appendBuffer(chunkData);

    await new Promise(resolve => setTimeout(resolve, 20));

    assert.strictEqual(ChunkTracker.videoLedger.length, 1, 'ChunkTracker should have recorded 1 chunk');
    assert.strictEqual(ChunkTracker.videoLedger[0].start, 0);
    assert.strictEqual(ChunkTracker.videoLedger[0].end, 3);
    assert.strictEqual(ChunkTracker.videoLedger[0].bytes, 3 * 1024 * 1024);

    // Simulate appending chunk 2 [3, 6] (4MB)
    videoSb._onNextUpdate = () => {
        videoSb.buffered._setRanges([[0, 6]]);
    };
    const chunk2Data = new Uint8Array(4 * 1024 * 1024);
    videoSb.appendBuffer(chunk2Data);

    await new Promise(resolve => setTimeout(resolve, 20));

    assert.strictEqual(ChunkTracker.videoLedger.length, 2, 'ChunkTracker should have recorded 2 chunks');
    assert(Math.abs(ChunkTracker.videoLedger[1].start - 3) < 0.01);
    assert(Math.abs(ChunkTracker.videoLedger[1].end - 6) < 0.01);
    assert.strictEqual(ChunkTracker.videoLedger[1].bytes, 4 * 1024 * 1024);

    console.log('✓ End-to-end MSE hook interception passed.');
}

testMSEHooks().then(() => {
    console.log('\n========================================');
    console.log('🎉 ALL 22 UNIT & EDGE CASE TESTS PASSED!');
    console.log('========================================');
    process.exit(0);
}).catch(err => {
    console.error('Test failed:', err);
    process.exit(1);
});
