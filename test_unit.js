// test_unit.js - Automated unit tests for Bilibili Buffer Unlocker v3.3-beta
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

console.log('--- Running Automated Unit Tests for v3.3-beta ---');

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
        if (selector.includes('info-container')) return {
            offsetParent: {},
            contains: () => true,
            appendChild: () => {},
            querySelectorAll: () => []
        };
        if (selector.includes('control-bottom-left')) return {
            contains: () => true,
            appendChild: () => {}
        };
        return null;
    },
    querySelectorAll: (selector) => {
        return [];
    },
    _elementsById: {},
    getElementById: (id) => mockDocument._elementsById[id] || null,
    createElement: (tag) => {
        const el = {
            tagName: tag.toUpperCase(),
            style: {},
            innerHTML: '',
            textContent: '',
            _id: '',
            set id(val) {
                this._id = val;
                mockDocument._elementsById[val] = this;
            },
            get id() { return this._id; },
            querySelector: () => ({ style: {}, textContent: '' }),
            querySelectorAll: () => [],
            addEventListener: () => {},
            contains: () => true,
            remove: function() {
                if (this._id) delete mockDocument._elementsById[this._id];
            }
        };
        return el;
    },
    addEventListener: () => {}
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

// Test 19: UIManager and getStats Dual-Perspective Integration
{
    console.log('\n[Test 19] Testing UIManager and getStats Dual-Perspective Integration...');
    ChunkTracker.reset();
    mockVideo.currentTime = 10;
    mockVideo.buffered._setRanges([[0, 40]]);
    ChunkTracker.recordChunk('video', 0, 10, 10 * 1024 * 1024);
    ChunkTracker.recordChunk('video', 10, 40, 30 * 1024 * 1024);

    const stats = CoreManager.getStats();
    assert.strictEqual(stats.memory.actualPastVideo, 10 * 1024 * 1024);
    assert.strictEqual(stats.memory.actualVideo, 30 * 1024 * 1024);
    assert.strictEqual(stats.memory.actualTotalVideo, 40 * 1024 * 1024);
    assert.strictEqual(stats.memory.actualTotalActive, 40 * 1024 * 1024);
    assert.strictEqual(stats.memory.actualPast, 10 * 1024 * 1024);
    assert.strictEqual(stats.memory.actualPastTotal, 10 * 1024 * 1024);
    assert.strictEqual(stats.memory.actualTotal, 40 * 1024 * 1024);
    assert.strictEqual(stats.memory.limit, 135 * 1024 * 1024);

    // Verify UI update renders without error
    UIManager.update();
    const panel = UIManager.statsPanelRef;
    assert(panel !== null, 'Stats panel should be created');
    const memCur = UIManager.cachedStatsElements?.memCur;
    const memTar = UIManager.cachedStatsElements?.memTar;
    assert.strictEqual(memCur.textContent, '30 MB', 'memCur should show forward memory');
    assert.strictEqual(memTar.textContent, '135 MB', 'memTar should show limit (Scheme 1B)');
    assert.strictEqual(UIManager.cachedStatsElements?.memActualTag, undefined, 'memActualTag should be removed');
    assert(memCur && memCur.title.includes('前向 30 MB'), 'Tooltip should contain forward memory');
    assert(memCur.title.includes('回退未清理: 10 MB'), 'Tooltip should contain past memory');
    assert(memCur.title.includes('MSE总活跃: 40 MB'), 'Tooltip should contain total active memory');

    console.log('✓ UIManager and getStats Dual-Perspective Integration passed.');
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

// Test 22: UIManager.updateControlBarBadge Lifecycle & Tooltip Rendering
{
    console.log('\n[Test 22] Testing UIManager.updateControlBarBadge Lifecycle & Tooltip...');
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

    // Verify title text follows Scheme 2A (⚡time | ⏪ past + ⏩ forward = total / limit)
    assert(badge.title.includes('⏪ 10 MB + ⏩ 30 MB = 40 MB / 135 MB'), `Badge title should follow Scheme 2A format, got: ${badge.title}`);

    // Test badge when past memory is 0 (should preserve ⏪ 0 MB format)
    ChunkTracker.onRemove('video', 0, 10);
    const statsNoPast = CoreManager.getStats();
    UIManager.updateControlBarBadge(statsNoPast);
    assert(badge.title.includes('⏪ 0 MB + ⏩ 30 MB = 30 MB / 135 MB'), `Badge title without past should preserve ⏪ 0 MB format, got: ${badge.title}`);

    console.log('✓ UIManager.updateControlBarBadge Lifecycle & Tooltip passed.');
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
