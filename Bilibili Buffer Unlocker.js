// ==UserScript==
// @name         Bilibili Buffer Unlocker(B站缓冲解限)
// @name:zh      B站缓冲解限
// @name:en      Bilibili Buffer Unlocker
// @namespace    https://github.com/liweichen6/Bilibili-Buffer-Unlocker
// @version      3.3-beta
// @description  Increase Bilibili player video buffer duration, intelligently prevent memory overflow, and integrate with player statistics UI. 解限B站播放器缓冲时长，智能防止内存溢出，播放器统计信息UI集成
// @description:zh 解限B站播放器缓冲时长，智能防止内存溢出，播放器统计信息UI集成
// @description:en Increase Bilibili player video buffer duration, intelligently prevent memory overflow, and integrate with player statistics UI
// @author       \7. (Original Author), liweichen6 with Gemini (v3.0+ Ongoing Development)
// @homepageURL  https://github.com/liweichen6/Bilibili-Buffer-Unlocker
// @supportURL   https://github.com/liweichen6/Bilibili-Buffer-Unlocker/issues
// @match        *://*.bilibili.com/*
// @match        *://bilibili.com/*
// @grant        unsafeWindow
// @run-at       document-start
// @noframes
// @license      MIT
// @downloadURL  https://raw.githubusercontent.com/liweichen6/Bilibili-Buffer-Unlocker/main/Bilibili%20Buffer%20Unlocker.js
// @updateURL    https://raw.githubusercontent.com/liweichen6/Bilibili-Buffer-Unlocker/main/Bilibili%20Buffer%20Unlocker.js
// ==/UserScript==

(function () {
    'use strict';

    // === 配置区域 ===
    const CONFIG = {
        MIN_TIME_LIMIT: 20,                 // 最低缓冲时间下限 (秒)
        MAX_TIME_LIMIT: 600,                // 缓冲时间上限 600秒 (10分钟)
        SAFE_BYTE_LIMIT: 120 * 1024 * 1024, // 综合安全内存空间上限 120MB (展示基准)
        SAFE_VIDEO_BYTE_LIMIT: 110 * 1024 * 1024, // 视频安全内存上限 110 MiB (Chromium硬限制 150 MiB)
        SAFE_AUDIO_BYTE_LIMIT: 8 * 1024 * 1024,   // 音频安全内存上限 8 MiB (Chromium硬限制 12 MiB)
        CHECK_INTERVAL: 3000,               // 内核优化轮询间隔 (毫秒)
        UI_REFRESH_RATE: 1000,              // UI 刷新间隔 (毫秒)
        HYSTERESIS_DELTA: 5,                // 缓冲目标调整容差 (秒，防频繁抖动)
        SHOW_CONTROL_BAR_BADGE: true        // 是否在播放器控制栏常驻显示轻量缓冲微标 (⚡180s)
    };

    const win = (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;

    const Utils = {
        version: (typeof GM_info !== 'undefined' && GM_info.script && GM_info.script.version) ? GM_info.script.version : '3.3-beta',

        formatTime: (s) => {
            if (!Number.isFinite(s) || s < 0) return '0s';
            const total = Math.floor(s);
            if (total < 60) return `${total}s`;
            const m = Math.floor(total / 60);
            const sec = total % 60;
            return `${m}m${sec < 10 ? '0' : ''}${sec}s`;
        },

        formatSize: (bytes) => {
            if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB';
            const mb = bytes / (1024 * 1024);
            if (mb < 0.1) return '<0.1 MB';
            if (mb < 10) return `${mb.toFixed(1)} MB`;
            return `${Math.round(mb)} MB`;
        },

        // 从 video.buffered 中提取并合并与当前播放进度匹配的前向连续时间区间
        getForwardBufferedRange: (video) => {
            if (!video || !video.buffered) return null;
            const currentTime = Number.isFinite(video.currentTime) ? video.currentTime : 0;
            const count = video.buffered.length;
            if (count === 0) return null;

            const raw = [];
            for (let i = 0; i < count; i++) {
                const s = video.buffered.start(i);
                const e = video.buffered.end(i);
                if (Number.isFinite(s) && Number.isFinite(e) && s <= e) {
                    raw.push({ start: s, end: e });
                }
            }
            if (raw.length === 0) return null;
            raw.sort((a, b) => a.start - b.start);

            const merged = [];
            for (let i = 0; i < raw.length; i++) {
                const r = raw[i];
                if (merged.length === 0) {
                    merged.push({ start: r.start, end: r.end });
                } else {
                    const prev = merged[merged.length - 1];
                    if (r.start <= prev.end + 0.25) {
                        prev.end = Math.max(prev.end, r.end);
                    } else {
                        merged.push({ start: r.start, end: r.end });
                    }
                }
            }

            for (let i = 0; i < merged.length; i++) {
                const { start, end } = merged[i];
                // 允许起点微小提前量 (0.5s)，并对播放初期 (<=0.5s) 的首帧偏移做容错
                if ((currentTime >= start - 0.5 || (currentTime <= 0.5 && start <= 0.5)) && currentTime <= end) {
                    return {
                        start,
                        end,
                        ahead: Math.max(0, end - currentTime)
                    };
                }
            }
            return null;
        }
    };

    // === MSE 分片实时追踪引擎 ===
    const ChunkTracker = {
        videoLedger: [],
        audioLedger: [],
        MAX_LEDGER_ENTRIES: 500,
        _seq: 0,

        // 辅助：提取并标准化 TimeRanges 数组
        snapshotRanges: (buffered) => {
            if (!buffered) return [];
            const res = [];
            for (let i = 0; i < buffered.length; i++) {
                const s = buffered.start(i);
                const e = buffered.end(i);
                if (Number.isFinite(s) && Number.isFinite(e) && s <= e) {
                    res.push({ start: s, end: e });
                }
            }
            return res;
        },

        // 辅助：对比 appendBuffer 前后 Range 差分，提取新增或扩展的时间区间 [start, end]
        diffRanges: (before, after) => {
            if (!after || after.length === 0) return null;
            if (!before || before.length === 0) {
                const last = after[after.length - 1];
                return { start: last.start, end: last.end, duration: last.end - last.start };
            }

            for (let i = 0; i < after.length; i++) {
                const a = after[i];
                const overlapping = before.filter(b => Math.max(a.start, b.start) < Math.min(a.end, b.end) + 0.05);

                if (overlapping.length === 0) {
                    return { start: a.start, end: a.end, duration: a.end - a.start };
                }

                const maxBeforeEnd = Math.max(...overlapping.map(b => b.end));
                const minBeforeStart = Math.min(...overlapping.map(b => b.start));

                // 两侧同时扩展（例如质量切换覆盖或大跨度关键帧段）
                if (a.start < minBeforeStart - 0.05 && a.end > maxBeforeEnd + 0.05) {
                    return { start: a.start, end: a.end, duration: a.end - a.start };
                }

                // 右侧扩展（最常见的顺序流式加载）
                if (a.end > maxBeforeEnd + 0.05) {
                    const start = Math.max(a.start, maxBeforeEnd);
                    return { start, end: a.end, duration: a.end - start };
                }

                // 左侧扩展
                if (a.start < minBeforeStart - 0.05) {
                    const end = Math.min(a.end, minBeforeStart);
                    return { start: a.start, end, duration: end - a.start };
                }

                // 缝隙填充
                if (overlapping.length >= 2) {
                    overlapping.sort((x, y) => x.start - y.start);
                    for (let j = 0; j < overlapping.length - 1; j++) {
                        const gapStart = overlapping[j].end;
                        const gapEnd = overlapping[j + 1].start;
                        if (gapEnd > gapStart + 0.05) {
                            return { start: gapStart, end: gapEnd, duration: gapEnd - gapStart };
                        }
                    }
                }
            }

            return null;
        },

        // 裁剪指定账本中的时间区间 [removeStart, removeEnd]
        pruneInterval: (ledger, removeStart, removeEnd) => {
            if (!ledger || ledger.length === 0 || removeStart >= removeEnd) return;
            const next = [];
            for (let i = 0; i < ledger.length; i++) {
                const c = ledger[i];
                if (c.end <= removeStart || c.start >= removeEnd) {
                    next.push(c);
                } else if (c.start >= removeStart && c.end <= removeEnd) {
                    continue;
                } else if (c.start < removeStart && c.end > removeEnd) {
                    const dur1 = removeStart - c.start;
                    const dur2 = c.end - removeEnd;
                    const b1 = Math.round(c.bytes * (dur1 / c.duration));
                    const b2 = Math.round(c.bytes * (dur2 / c.duration));
                    if (dur1 > 0.01 && b1 > 0) {
                        next.push({
                            track: c.track,
                            start: c.start,
                            end: removeStart,
                            duration: dur1,
                            bytes: b1,
                            timestamp: c.timestamp,
                            seq: c.seq
                        });
                    }
                    if (dur2 > 0.01 && b2 > 0) {
                        next.push({
                            track: c.track,
                            start: removeEnd,
                            end: c.end,
                            duration: dur2,
                            bytes: b2,
                            timestamp: c.timestamp,
                            seq: c.seq
                        });
                    }
                } else if (c.start < removeStart && c.end <= removeEnd) {
                    const dur = removeStart - c.start;
                    const b = Math.round(c.bytes * (dur / c.duration));
                    if (dur > 0.01 && b > 0) {
                        next.push({
                            track: c.track,
                            start: c.start,
                            end: removeStart,
                            duration: dur,
                            bytes: b,
                            timestamp: c.timestamp,
                            seq: c.seq
                        });
                    }
                } else if (c.start >= removeStart && c.end > removeEnd) {
                    const dur = c.end - removeEnd;
                    const b = Math.round(c.bytes * (dur / c.duration));
                    if (dur > 0.01 && b > 0) {
                        next.push({
                            track: c.track,
                            start: removeEnd,
                            end: c.end,
                            duration: dur,
                            bytes: b,
                            timestamp: c.timestamp,
                            seq: c.seq
                        });
                    }
                }
            }
            ledger.length = 0;
            ledger.push(...next);
        },

        // 记录新分片
        recordChunk: (track, start, end, bytes) => {
            const duration = end - start;
            if (duration <= 0.02 || bytes <= 0 || !Number.isFinite(start) || !Number.isFinite(end)) return;

            const ledger = (track === 'audio') ? ChunkTracker.audioLedger : ChunkTracker.videoLedger;
            // 剔除覆盖/重叠的历史区间，避免重复统计
            ChunkTracker.pruneInterval(ledger, start, end);

            ledger.push({
                track,
                start,
                end,
                bytes,
                duration,
                timestamp: Date.now(),
                seq: ++ChunkTracker._seq
            });

            ledger.sort((a, b) => a.start - b.start);
            if (ledger.length > ChunkTracker.MAX_LEDGER_ENTRIES) {
                ledger.splice(0, ledger.length - ChunkTracker.MAX_LEDGER_ENTRIES);
            }
        },

        // SourceBuffer.prototype.remove 触发账本修剪
        onRemove: (track, start, end) => {
            if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) return;
            const ledger = (track === 'audio') ? ChunkTracker.audioLedger : ChunkTracker.videoLedger;
            ChunkTracker.pruneInterval(ledger, start, end);
        },

        // 计算当前播放点向前连续缓冲的真实物理内存
        getActualBufferedBytes: (video, track = null) => {
            try {
                const v = video || document.querySelector('video');
                if (!v || !Number.isFinite(v.currentTime)) {
                    if (track === 'video') return 0;
                    if (track === 'audio') return 0;
                    return { videoBytes: 0, audioBytes: 0, totalBytes: 0, valueOf() { return 0; } };
                }

                const currentTime = v.currentTime;
                const range = Utils.getForwardBufferedRange(v);
                const forwardEnd = range ? range.end : currentTime;

                if (forwardEnd <= currentTime) {
                    if (track === 'video') return 0;
                    if (track === 'audio') return 0;
                    return { videoBytes: 0, audioBytes: 0, totalBytes: 0, valueOf() { return 0; } };
                }

                const calcTrackBytes = (ledger) => {
                    if (!ledger || ledger.length === 0) return 0;
                    let bytes = 0;
                    for (let i = 0; i < ledger.length; i++) {
                        const c = ledger[i];
                        if (c.end <= currentTime || c.start >= forwardEnd) continue;
                        const oStart = Math.max(c.start, currentTime);
                        const oEnd = Math.min(c.end, forwardEnd);
                        const oDur = Math.max(0, oEnd - oStart);
                        if (oDur > 0 && c.duration > 0) {
                            const ratio = Math.min(1, oDur / c.duration);
                            bytes += Math.round(c.bytes * ratio);
                        }
                    }
                    return bytes;
                };

                const videoBytes = calcTrackBytes(ChunkTracker.videoLedger);
                const audioBytes = calcTrackBytes(ChunkTracker.audioLedger);
                const totalBytes = videoBytes + audioBytes;

                if (track === 'video') return videoBytes;
                if (track === 'audio') return audioBytes;

                return {
                    videoBytes,
                    audioBytes,
                    totalBytes,
                    valueOf() { return this.totalBytes; }
                };
            } catch {
                if (track === 'video') return 0;
                if (track === 'audio') return 0;
                return { videoBytes: 0, audioBytes: 0, totalBytes: 0, valueOf() { return 0; } };
            }
        },

        // 计算最近分片的滑动窗口移动平均码率 (Bytes/s)
        getRollingBitrate: (track = 'video', targetDuration = 30) => {
            const ledger = (track === 'audio') ? ChunkTracker.audioLedger : ChunkTracker.videoLedger;
            if (!ledger || ledger.length === 0) return 0;

            // 按分片追加时间倒序（最近下载的分片优先）
            const recent = [...ledger].sort((a, b) => (b.timestamp - a.timestamp) || ((b.seq || 0) - (a.seq || 0)));

            let totalBytes = 0;
            let totalDuration = 0;

            for (let i = 0; i < recent.length; i++) {
                const c = recent[i];
                if (c.duration <= 0 || c.bytes <= 0) continue;
                totalBytes += c.bytes;
                totalDuration += c.duration;
                if (totalDuration >= targetDuration) break;
            }

            // 样本时长至少需达到 1 秒，防止单帧极短分片（如 0.04s 的关键帧段）产生虚假瞬时码率暴增引发缓冲剧烈抖动
            if (totalDuration < 1.0) return 0;

            return totalBytes / totalDuration;
        },

        // 清空账本 (视频切换/重置时调用)
        reset: () => {
            ChunkTracker.videoLedger.length = 0;
            ChunkTracker.audioLedger.length = 0;
            ChunkTracker._seq = 0;
        },

        // 初始化拦截钩子
        init: () => {
            try {
                const targets = [];
                if (typeof win !== 'undefined' && win) targets.push(win);
                if (typeof window !== 'undefined' && window && window !== win) targets.push(window);

                const hookSourceBufferProto = (SBProto) => {
                    if (!SBProto || SBProto.appendBuffer?.__hooked) return;

                    const origAppendBuffer = SBProto.appendBuffer;
                    SBProto.appendBuffer = function (data) {
                        const sb = this;
                        const track = sb.__trackType || 'video';
                        const byteLength = (typeof data?.byteLength === 'number')
                            ? data.byteLength
                            : (typeof data?.buffer?.byteLength === 'number' ? data.buffer.byteLength : 0);
                        const rangesBefore = ChunkTracker.snapshotRanges(sb.buffered);

                        const onUpdateEnd = () => {
                            try {
                                const rangesAfter = ChunkTracker.snapshotRanges(sb.buffered);
                                const diff = ChunkTracker.diffRanges(rangesBefore, rangesAfter);
                                if (diff && diff.duration > 0.02) {
                                    ChunkTracker.recordChunk(track, diff.start, diff.end, byteLength);
                                }
                            } catch {}
                        };

                        // 先行调用底层原生方法，若抛出异常（如 QuotaExceededError / updating 状态错误）则不注册悬挂事件
                        const ret = origAppendBuffer.apply(this, arguments);
                        try {
                            sb.addEventListener('updateend', onUpdateEnd, { once: true });
                        } catch {}
                        return ret;
                    };
                    SBProto.appendBuffer.__hooked = true;

                    const origRemove = SBProto.remove;
                    if (origRemove && !origRemove.__hooked) {
                        SBProto.remove = function (start, end) {
                            try {
                                const track = this.__trackType || 'video';
                                ChunkTracker.onRemove(track, Number(start), Number(end));
                            } catch {}
                            return origRemove.apply(this, arguments);
                        };
                        SBProto.remove.__hooked = true;
                    }
                };

                targets.forEach(targetWin => {
                    const MS = targetWin.MediaSource;
                    if (MS && MS.prototype && !MS.prototype.addSourceBuffer.__hooked) {
                        const origAddSourceBuffer = MS.prototype.addSourceBuffer;
                        MS.prototype.addSourceBuffer = function (mimeType) {
                            const sb = origAddSourceBuffer.apply(this, arguments);
                            try {
                                const lower = String(mimeType || '').toLowerCase();
                                sb.__trackType = lower.includes('video') ? 'video' : (lower.includes('audio') ? 'audio' : 'unknown');
                                hookSourceBufferProto(sb.constructor?.prototype || targetWin.SourceBuffer?.prototype);
                            } catch {}
                            return sb;
                        };
                        MS.prototype.addSourceBuffer.__hooked = true;
                    }

                    if (targetWin.SourceBuffer && targetWin.SourceBuffer.prototype) {
                        hookSourceBufferProto(targetWin.SourceBuffer.prototype);
                    }
                });
            } catch (e) {
                console.warn('[缓冲解限] ChunkTracker 钩子安装异常:', e);
            }
        }
    };

    // === 核心业务管理器 ===
    const CoreManager = {
        _lastBufferedTime: 0,
        _lastCurrentTime: 0,
        _lastVideoSrc: '',
        _lastAppliedTarget: null,
        _hiResLogged: false,

        // 统一获取播放器内核实例
        getCore: () => {
            try {
                const p = win.player || win.bpxPlayer;
                if (!p) return null;
                if (typeof p.__core === 'function') return p.__core();
                if (p.__core && typeof p.__core === 'object') return p.__core;
                if (typeof p.getCore === 'function') return p.getCore();
                if (p.core && typeof p.core === 'object') return p.core;
                return null;
            } catch {
                return null;
            }
        },

        // 从媒体元数据获取当前音视频各自与综合传输速率 (Bytes/s)
        getMediaRates: () => {
            try {
                const core = CoreManager.getCore();
                if (!core) return { videoBps: 0, audioBps: 0, totalBps: 0 };
                const mediaInfo = core.state?.mediaInfo || core.mediaInfo || (typeof core.getMediaInfo === 'function' ? core.getMediaInfo() : null);
                if (!mediaInfo) return { videoBps: 0, audioBps: 0, totalBps: 0 };

                const videoRate = Number(
                    mediaInfo.videoDataRate ||
                    mediaInfo.video_data_rate ||
                    mediaInfo.videoBitrate ||
                    mediaInfo.video_bitrate ||
                    mediaInfo.videoRate ||
                    mediaInfo.video_rate
                ) || 0;

                const audioRate = Number(
                    mediaInfo.audioDataRate ||
                    mediaInfo.audio_data_rate ||
                    mediaInfo.audioBitrate ||
                    mediaInfo.audio_bitrate ||
                    mediaInfo.audioRate ||
                    mediaInfo.audio_rate
                ) || 0;

                let videoBps = videoRate > 0 ? videoRate / 8 : 0;
                let audioBps = audioRate > 0 ? audioRate / 8 : 0;
                let totalBps = videoBps + audioBps;

                const bandwidth = Number(
                    mediaInfo.bandwidth ||
                    mediaInfo.totalDataRate ||
                    mediaInfo.total_data_rate ||
                    mediaInfo.totalBitrate ||
                    mediaInfo.total_bitrate ||
                    mediaInfo.bitrate
                ) || 0;

                if (bandwidth > 0) {
                    const bandwidthBps = bandwidth / 8;
                    if (videoBps <= 0 && audioBps <= 0) {
                        videoBps = bandwidthBps * 0.9;
                        audioBps = bandwidthBps * 0.1;
                        totalBps = bandwidthBps;
                    } else if (videoBps <= 0 && audioBps > 0) {
                        videoBps = Math.max(0, bandwidthBps - audioBps);
                        if (videoBps <= 0) videoBps = bandwidthBps * 0.9;
                        totalBps = videoBps + audioBps;
                    } else if (audioBps <= 0 && videoBps > 0) {
                        if (bandwidthBps > videoBps) {
                            audioBps = bandwidthBps - videoBps;
                        } else {
                            audioBps = videoBps * 0.1;
                        }
                        totalBps = videoBps + audioBps;
                    }
                }

                return {
                    videoBps,
                    audioBps,
                    totalBps
                };
            } catch {
                return { videoBps: 0, audioBps: 0, totalBps: 0 };
            }
        },

        // 获取当前连续向前有效缓冲时长 (秒)
        getBufferedAhead: (video) => {
            try {
                const v = video || document.querySelector('video');
                if (!v) return 0;
                const range = Utils.getForwardBufferedRange(v);
                if (range) return range.ahead;

                const core = CoreManager.getCore();
                if (core && typeof core.getBufferLength === 'function') {
                    return Math.max(0, Number(core.getBufferLength()) || 0);
                }
                return 0;
            } catch {
                return 0;
            }
        },

        // 从媒体元数据获取当前音视频总传输速率 (Bytes/s)
        getCurrentBytesPerSecond: () => {
            return CoreManager.getMediaRates().totalBps;
        },

        // 检测是否包含 Hi-Res / 杜比全景声特殊音频流
        isHiRes: () => {
            try {
                const core = CoreManager.getCore();
                if (!core) return false;
                const mediaInfo = core.state?.mediaInfo || core.mediaInfo || (typeof core.getMediaInfo === 'function' ? core.getMediaInfo() : null);
                if (!mediaInfo) return false;

                const codec = String(
                    mediaInfo.audioCodec ||
                    mediaInfo.audioCodecName ||
                    mediaInfo.audio_codec ||
                    mediaInfo.audio_codec_name ||
                    ''
                ).toLowerCase();

                const isCodecMatch = codec.includes('flac') ||
                    codec.includes('ec-3') ||
                    codec.includes('eac3') ||
                    codec.includes('ac-3') ||
                    codec.includes('ac3') ||
                    codec.includes('ac-4') ||
                    codec.includes('dolby') ||
                    codec.includes('hires') ||
                    codec.includes('hi-res');

                if (isCodecMatch) return true;

                const qualityDesc = String(
                    mediaInfo.audioQualityName ||
                    mediaInfo.audio_quality_name ||
                    mediaInfo.audioQualityDesc ||
                    mediaInfo.audio_quality_desc ||
                    mediaInfo.audioDescription ||
                    mediaInfo.audio_description ||
                    ''
                ).toLowerCase();

                if (
                    qualityDesc.includes('dolby') ||
                    qualityDesc.includes('全景声') ||
                    qualityDesc.includes('hi-res') ||
                    qualityDesc.includes('hires') ||
                    qualityDesc.includes('无损')
                ) return true;

                const qId = Number(
                    mediaInfo.audioQuality ||
                    mediaInfo.audio_quality ||
                    mediaInfo.audioQualityId ||
                    mediaInfo.audio_quality_id ||
                    mediaInfo.audioId ||
                    mediaInfo.audio_id ||
                    mediaInfo.audioStream?.id ||
                    core.state?.audioQuality ||
                    (typeof core.getAudioQuality === 'function' ? core.getAudioQuality() : 0)
                );

                return qId === 30250 || qId === 30251;
            } catch {
                return false;
            }
        },

        // 动态根据码率与分片实测计算内存安全的最大缓冲时长（闭环动态预算）
        calculateSafeDuration: () => {
            const { videoBps: manifestVideoBps, audioBps: manifestAudioBps } = CoreManager.getMediaRates();
            const rollingVideoBps = ChunkTracker.getRollingBitrate('video');
            const rollingAudioBps = ChunkTracker.getRollingBitrate('audio');

            // 自适应捕捉 VBR 浪涌：取静态清单码率与实测滑动窗口码率的较大值
            const effectiveVideoBps = Math.max(manifestVideoBps || 0, rollingVideoBps || 0);
            const effectiveAudioBps = Math.max(manifestAudioBps || 0, rollingAudioBps || 0);
            const effectiveTotalBps = effectiveVideoBps + effectiveAudioBps;

            if (effectiveTotalBps <= 0) return CONFIG.MAX_TIME_LIMIT;

            const safeVideoSec = effectiveVideoBps > 0 ? (CONFIG.SAFE_VIDEO_BYTE_LIMIT / effectiveVideoBps) : CONFIG.MAX_TIME_LIMIT;
            const safeAudioSec = effectiveAudioBps > 0 ? (CONFIG.SAFE_AUDIO_BYTE_LIMIT / effectiveAudioBps) : CONFIG.MAX_TIME_LIMIT;

            let safeSeconds = Math.min(safeAudioSec, safeVideoSec, CONFIG.MAX_TIME_LIMIT);

            // 闭环物理内存节流控制 (Closed-Loop Physical Memory Regulation)
            const video = document.querySelector('video');
            const actual = ChunkTracker.getActualBufferedBytes(video);
            const actualVideoBytes = actual?.videoBytes || 0;
            const actualAudioBytes = actual?.audioBytes || 0;
            const currentBuffered = CoreManager.getBufferedAhead(video);

            const isVideoNearLimit = actualVideoBytes >= CONFIG.SAFE_VIDEO_BYTE_LIMIT * 0.90;
            const isAudioNearLimit = actualAudioBytes >= CONFIG.SAFE_AUDIO_BYTE_LIMIT * 0.90;

            if (isVideoNearLimit || isAudioNearLimit) {
                // 当音视频任一物理内存达到安全上限 90% 时，强制限制目标缓冲至当前缓冲量，停止拉取新分片
                safeSeconds = Math.min(safeSeconds, Math.max(CONFIG.MIN_TIME_LIMIT, Math.floor(currentBuffered)));
            } else {
                // 基于音视频各自剩余物理配额的平滑缓冲节流
                let maxAllowedSec = CONFIG.MAX_TIME_LIMIT;
                if (actualVideoBytes > 0 && effectiveVideoBps > 0) {
                    const remainingVideoBytes = Math.max(0, CONFIG.SAFE_VIDEO_BYTE_LIMIT - actualVideoBytes);
                    const allowedVideoSec = remainingVideoBytes / effectiveVideoBps;
                    maxAllowedSec = Math.min(maxAllowedSec, Math.floor(currentBuffered + allowedVideoSec));
                }
                if (actualAudioBytes > 0 && effectiveAudioBps > 0) {
                    const remainingAudioBytes = Math.max(0, CONFIG.SAFE_AUDIO_BYTE_LIMIT - actualAudioBytes);
                    const allowedAudioSec = remainingAudioBytes / effectiveAudioBps;
                    maxAllowedSec = Math.min(maxAllowedSec, Math.floor(currentBuffered + allowedAudioSec));
                }
                safeSeconds = Math.min(safeSeconds, Math.max(CONFIG.MIN_TIME_LIMIT, maxAllowedSec));
            }

            return Math.max(CONFIG.MIN_TIME_LIMIT, Math.floor(safeSeconds));
        },

        // 执行缓冲扩容优化
        applyOptimization: (force = false) => {
            try {
                const core = CoreManager.getCore();
                if (!core) return;

                // Hi-Res 音频遵循 B 站内置策略，若当前处于扩容高位主动重置，避免触发解码管道或 CDN 调度异常
                if (CoreManager.isHiRes()) {
                    if (typeof core.setStableBufferTime === 'function') {
                        const currentSetting = typeof core.getStableBufferTime === 'function' ? core.getStableBufferTime() : null;
                        const needsReset = Number.isFinite(currentSetting)
                            ? (currentSetting > 30 || currentSetting !== 20)
                            : (CoreManager._lastAppliedTarget !== null && CoreManager._lastAppliedTarget !== 20);

                        if (needsReset) {
                            core.setStableBufferTime(20);
                            CoreManager._lastAppliedTarget = 20;
                            if (!CoreManager._hiResLogged) {
                                const fromText = Number.isFinite(currentSetting) ? `${currentSetting}s` : (CoreManager._lastAppliedTarget ? `${CoreManager._lastAppliedTarget}s` : '自定义配置');
                                console.log(`[缓冲解限] 🎵 检测到 Hi-Res/杜比音质，缓冲从 ${fromText} 重置为默认策略 (20s)`);
                                CoreManager._hiResLogged = true;
                            }
                            return;
                        }
                    }
                    if (!CoreManager._hiResLogged) {
                        console.log('[缓冲解限] 🎵 检测到 Hi-Res/杜比音质，保持播放器默认策略 (20s)');
                        CoreManager._hiResLogged = true;
                    }
                    return;
                }
                CoreManager._hiResLogged = false;

                const targetSeconds = CoreManager.calculateSafeDuration();

                if (typeof core.setStableBufferTime === 'function') {
                    const currentSetting = typeof core.getStableBufferTime === 'function' ? core.getStableBufferTime() : null;
                    const hasValidCurrent = Number.isFinite(currentSetting);
                    const effectiveSetting = hasValidCurrent ? currentSetting : CoreManager._lastAppliedTarget;

                    const video = document.querySelector('video');
                    const actual = ChunkTracker.getActualBufferedBytes(video);
                    const isNearLimit = (actual?.videoBytes >= CONFIG.SAFE_VIDEO_BYTE_LIMIT * 0.90) ||
                                        (actual?.audioBytes >= CONFIG.SAFE_AUDIO_BYTE_LIMIT * 0.90);
                    const isUrgentDownward = isNearLimit && (targetSeconds < effectiveSetting);

                    // 容差判定：当当前设置与目标不一致时，在未设置、升级至解限(>=30s)、差值超过容差死区或处于物理防爆紧急下调时更新
                    const shouldUpdate = force || (
                        effectiveSetting !== targetSeconds && (
                            !Number.isFinite(effectiveSetting) ||
                            (effectiveSetting < 30 && targetSeconds >= 30) ||
                            Math.abs(effectiveSetting - targetSeconds) >= CONFIG.HYSTERESIS_DELTA ||
                            isUrgentDownward
                        )
                    );

                    if (shouldUpdate) {
                        core.setStableBufferTime(targetSeconds);
                        CoreManager._lastAppliedTarget = targetSeconds;
                        if (force) {
                            console.log(`[缓冲解限] ⚡ 手动重新应用解限策略: ${targetSeconds}s`);
                        }
                    }
                }
            } catch {
                // 静默恢复
            }
        },

        // 智能异常裁剪诊断（过滤用户正常拖动、回退、切换视频等行为）
        trackBufferHealth: (bufferedAhead, currentTime, currentVideoSrc, isSeeking) => {
            try {
                if (CoreManager._lastVideoSrc && CoreManager._lastVideoSrc !== currentVideoSrc) {
                    CoreManager._hiResLogged = false;
                    CoreManager._lastAppliedTarget = null;
                    if (currentVideoSrc) {
                        ChunkTracker.reset();
                    }
                }
                if (CoreManager._lastVideoSrc === currentVideoSrc && !isSeeking) {
                    const timeDelta = currentTime - CoreManager._lastCurrentTime;
                    if (timeDelta >= -0.5 && timeDelta <= 3) {
                        if (CoreManager._lastBufferedTime > 15 && bufferedAhead < CoreManager._lastBufferedTime - 8) {
                            console.warn(`[缓冲解限] ⚠️ 缓冲被浏览器/播放器裁剪: 从 ${CoreManager._lastBufferedTime.toFixed(1)}s 降至 ${bufferedAhead.toFixed(1)}s`);
                        }
                    }
                }

                CoreManager._lastBufferedTime = bufferedAhead;
                CoreManager._lastCurrentTime = currentTime;
                CoreManager._lastVideoSrc = currentVideoSrc;
            } catch {}
        },

        // 纯状态查询函数（只读，无任何副作用）
        getStats: () => {
            try {
                const core = CoreManager.getCore();
                const video = document.querySelector('video');
                if (!video && !core) return null;

                const { videoBps: manifestVideoBps, audioBps: manifestAudioBps } = CoreManager.getMediaRates();
                const rollingVideoBps = ChunkTracker.getRollingBitrate('video');
                const rollingAudioBps = ChunkTracker.getRollingBitrate('audio');
                const effectiveVideoBps = Math.max(manifestVideoBps || 0, rollingVideoBps || 0);
                const effectiveAudioBps = Math.max(manifestAudioBps || 0, rollingAudioBps || 0);
                let effectiveTotalBps = effectiveVideoBps + effectiveAudioBps;

                const hiRes = CoreManager.isHiRes();

                // 目标缓冲时长基准
                let baseTargetTime;
                if (hiRes) {
                    const setting = (core && typeof core.getStableBufferTime === 'function') ? core.getStableBufferTime() : null;
                    baseTargetTime = Number.isFinite(setting) ? setting : 20;
                } else {
                    baseTargetTime = CoreManager.calculateSafeDuration();
                }

                // 当前视频剩余可播时长
                let remainingTime = Infinity;
                let currentTime = 0;
                if (video && Number.isFinite(video.duration) && Number.isFinite(video.currentTime)) {
                    currentTime = video.currentTime;
                    remainingTime = Math.max(0, video.duration - currentTime);
                }

                const bufferedAhead = CoreManager.getBufferedAhead(video);
                const finalTargetTime = Number.isFinite(remainingTime) ? Math.min(baseTargetTime, remainingTime) : baseTargetTime;

                // 获取实测物理分片内存
                const actual = ChunkTracker.getActualBufferedBytes(video);
                const actualTotal = actual?.totalBytes || 0;
                const actualVideo = actual?.videoBytes || 0;
                const actualAudio = actual?.audioBytes || 0;
                const hasActual = actualTotal > 0;

                if (effectiveTotalBps <= 0 && hasActual && bufferedAhead > 0) {
                    effectiveTotalBps = actualTotal / bufferedAhead;
                }

                const bps = effectiveTotalBps;

                return {
                    time: {
                        current: bufferedAhead,
                        target: finalTargetTime,
                        percent: finalTargetTime > 0 ? Math.min(100, (bufferedAhead / finalTargetTime) * 100) : 100
                    },
                    memory: {
                        current: bufferedAhead * bps,
                        target: finalTargetTime * bps,
                        limit: CONFIG.SAFE_BYTE_LIMIT,
                        actualCurrent: actualTotal,
                        actualVideo: actualVideo,
                        actualAudio: actualAudio,
                        hasActual: hasActual
                    },
                    bps,
                    hiRes
                };
            } catch {
                return null;
            }
        }
    };

    // === UI 展示管理 ===
    const UIManager = {
        timer: null,
        statsPanelRef: null,
        cachedStatsElements: null,
        badgeRef: null,
        badgeTextRef: null,

        // 1. 原生统计信息面板集成 (右键 -> 实时统计信息)
        updateStatsPanel: (stats) => {
            const container = document.querySelector('.bpx-player-info-container, .bilibili-player-info-container');
            if (!container || !container.offsetParent) return;

            // 清理可能脱离或挂载在其它容器的旧面板
            const allPanels = document.querySelectorAll('#my-buffer-overlay');
            allPanels.forEach(p => {
                if (!container.contains(p)) p.remove();
            });

            // 清理 container 内可能残留的冗余面板
            const existingPanels = container.querySelectorAll('#my-buffer-overlay');
            if (existingPanels.length > 1) {
                for (let i = 1; i < existingPanels.length; i++) {
                    existingPanels[i].remove();
                }
            }

            let panel = existingPanels[0] || null;
            if (!panel || !panel.querySelector('#buf-time-cur')) {
                if (panel) panel.remove();
                panel = document.createElement('div');
                panel.id = 'my-buffer-overlay';
                panel.style.cssText = 'margin:0;padding:6px 12px;border-top:1px solid rgba(255,255,255,0.15);font-size:12px;color:#fff;display:block;font-family:inherit;line-height:20px;';

                panel.innerHTML = `
                    <div class="info-line" style="display:flex; align-items:center; flex-wrap:wrap;">
                        <span class="info-title" style="color:#999; margin-right:8px;">缓冲状态</span>
                        <span class="info-data" style="font-weight:bold; display:inline-flex; align-items:center;">
                            <span id="buf-time-cur">0s</span>
                            <span style="color:#666; margin:0 2px;">/</span>
                            <span id="buf-time-tar" style="color:#888;">0s</span>
                            <span style="display:inline-block; width:1px; height:10px; background:#444; margin:0 8px;"></span>
                            <span id="buf-mem-cur" style="color:#bae637;">0 MB</span>
                            <span id="buf-mem-actual-tag" style="display:none; color:#52c41a; font-size:10px; margin-left:4px; border:1px solid rgba(82,196,26,0.5); border-radius:3px; padding:0 2px;">实测</span>
                            <span style="color:#666; margin:0 2px;">/</span>
                            <span id="buf-mem-tar" style="color:#888; font-size:11px;">0 MB</span>
                            <span id="buf-hires-tag" style="display:none; color:#ff85c0; font-size:10px; margin-left:6px; border:1px solid #ff85c0; border-radius:3px; padding:0 3px;">Hi-Res 免干预</span>
                        </span>
                    </div>
                `;

                container.appendChild(panel);
                UIManager.statsPanelRef = panel;
                UIManager.cachedStatsElements = {
                    timeCur: panel.querySelector('#buf-time-cur'),
                    timeTar: panel.querySelector('#buf-time-tar'),
                    memCur: panel.querySelector('#buf-mem-cur'),
                    memActualTag: panel.querySelector('#buf-mem-actual-tag'),
                    memTar: panel.querySelector('#buf-mem-tar'),
                    hiresTag: panel.querySelector('#buf-hires-tag')
                };
            } else if (panel !== UIManager.statsPanelRef || !UIManager.cachedStatsElements || !UIManager.cachedStatsElements.timeCur) {
                UIManager.statsPanelRef = panel;
                UIManager.cachedStatsElements = {
                    timeCur: panel.querySelector('#buf-time-cur'),
                    timeTar: panel.querySelector('#buf-time-tar'),
                    memCur: panel.querySelector('#buf-mem-cur'),
                    memActualTag: panel.querySelector('#buf-mem-actual-tag'),
                    memTar: panel.querySelector('#buf-mem-tar'),
                    hiresTag: panel.querySelector('#buf-hires-tag')
                };
            }

            const el = UIManager.cachedStatsElements;
            if (!el || !el.timeCur) return;

            const isHealthy = stats.time.current > 10 && stats.time.percent > 30;
            el.timeCur.textContent = Utils.formatTime(stats.time.current);
            el.timeCur.style.color = isHealthy ? '#52c41a' : '#faad14';
            el.timeTar.textContent = Utils.formatTime(stats.time.target);

            if (stats.memory.hasActual) {
                el.memCur.textContent = Utils.formatSize(stats.memory.actualCurrent);
                if (el.memActualTag) el.memActualTag.style.display = 'inline';
                el.memCur.title = `物理实测: ${Utils.formatSize(stats.memory.actualCurrent)} (估算: ${Utils.formatSize(stats.memory.current)})`;
            } else {
                el.memCur.textContent = Utils.formatSize(stats.memory.current);
                if (el.memActualTag) el.memActualTag.style.display = 'none';
                el.memCur.title = `估算内存: ${Utils.formatSize(stats.memory.current)}`;
            }

            el.memTar.textContent = Utils.formatSize(stats.memory.target);
            el.hiresTag.style.display = stats.hiRes ? 'inline' : 'none';
        },

        ensureStyles: () => {
            if (document.getElementById('bili-buffer-badge-style')) return;
            const style = document.createElement('style');
            style.id = 'bili-buffer-badge-style';
            style.textContent = `
                #bili-buffer-badge {
                    display: inline-flex !important;
                    align-items: center !important;
                    justify-content: center !important;
                    height: 22px !important;
                    width: auto !important;
                    padding: 0 4px !important;
                    margin: 0 2px !important;
                    box-sizing: border-box !important;
                    cursor: pointer;
                    user-select: none;
                    vertical-align: middle !important;
                }
                .bpx-player-container[data-screen="wide"] #bili-buffer-badge,
                .bpx-player-container[data-screen="full"] #bili-buffer-badge,
                .bpx-player-container[data-screen="web"] #bili-buffer-badge,
                [data-screen="wide"] #bili-buffer-badge,
                [data-screen="full"] #bili-buffer-badge,
                [data-screen="web"] #bili-buffer-badge {
                    height: 32px !important;
                }
                #bili-buffer-badge-text {
                    display: inline-flex !important;
                    align-items: center !important;
                    justify-content: center !important;
                    font-size: 11px !important;
                    font-weight: bold;
                    font-family: inherit;
                    line-height: 16px;
                    color: #00aeec;
                    background: rgba(0, 174, 236, 0.12);
                    border: 1px solid rgba(0, 174, 236, 0.3);
                    border-radius: 4px;
                    padding: 1px 5px;
                    box-sizing: border-box;
                    white-space: nowrap;
                    transition: background 0.2s, border-color 0.2s;
                }
                #bili-buffer-badge:hover #bili-buffer-badge-text {
                    background: rgba(0, 174, 236, 0.22);
                    border-color: rgba(0, 174, 236, 0.55);
                }
                .bpx-player-container[data-screen="wide"] #bili-buffer-badge-text,
                .bpx-player-container[data-screen="full"] #bili-buffer-badge-text,
                .bpx-player-container[data-screen="web"] #bili-buffer-badge-text,
                [data-screen="wide"] #bili-buffer-badge-text,
                [data-screen="full"] #bili-buffer-badge-text,
                [data-screen="web"] #bili-buffer-badge-text {
                    font-size: 12px !important;
                    padding: 2px 7px;
                    line-height: 20px;
                }
            `;
            const target = document.head || document.documentElement || document.body;
            if (target && typeof target.appendChild === 'function') {
                target.appendChild(style);
            }
        },

        // 2. 播放器控制栏常驻微标 (无需右键展开即可常驻查看)
        updateControlBarBadge: (stats) => {
            if (!CONFIG.SHOW_CONTROL_BAR_BADGE) {
                const existingBadge = document.getElementById('bili-buffer-badge');
                if (existingBadge) existingBadge.remove();
                UIManager.badgeRef = null;
                UIManager.badgeTextRef = null;
                return;
            }

            const ctrlLeft = document.querySelector('.bpx-player-control-bottom-left');
            if (!ctrlLeft) return;

            UIManager.ensureStyles();

            let badge = document.getElementById('bili-buffer-badge');
            if (!badge || !ctrlLeft.contains(badge)) {
                // 清理可能脱离或重复挂载在页面的旧微标
                const allBadges = document.querySelectorAll('#bili-buffer-badge');
                allBadges.forEach(b => b.remove());

                badge = document.createElement('div');
                badge.id = 'bili-buffer-badge';
                badge.className = 'bpx-player-ctrl-btn';
                badge.innerHTML = '<span id="bili-buffer-badge-text">⚡0s</span>';
                badge.addEventListener('click', (e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    CoreManager.applyOptimization(true);
                    UIManager.update();
                });
                badge.addEventListener('mousedown', (e) => {
                    e.stopPropagation();
                });
                badge.addEventListener('mouseup', (e) => {
                    e.stopPropagation();
                });
                badge.addEventListener('pointerdown', (e) => {
                    e.stopPropagation();
                });
                badge.addEventListener('dblclick', (e) => {
                    e.stopPropagation();
                });
                ctrlLeft.appendChild(badge);
                UIManager.badgeRef = badge;
                UIManager.badgeTextRef = badge.querySelector('#bili-buffer-badge-text');
            } else if (!UIManager.badgeTextRef || UIManager.badgeRef !== badge || !badge.contains(UIManager.badgeTextRef)) {
                UIManager.badgeRef = badge;
                UIManager.badgeTextRef = badge.querySelector('#bili-buffer-badge-text');
            }

            if (UIManager.badgeTextRef) {
                UIManager.badgeTextRef.textContent = `⚡${Utils.formatTime(stats.time.current)}`;
            }

            const memText = stats.memory.hasActual
                ? `物理实测: ${Utils.formatSize(stats.memory.actualCurrent)} (估算: ${Utils.formatSize(stats.memory.current)})`
                : `内存估算: ${Utils.formatSize(stats.memory.current)}`;
            badge.title = `已缓冲: ${Utils.formatTime(stats.time.current)} / ${Utils.formatTime(stats.time.target)} | ${memText} / ${Utils.formatSize(stats.memory.limit)} (点击手动触发解限)`;
        },

        update: () => {
            const stats = CoreManager.getStats();
            if (!stats) return;

            const video = document.querySelector('video');
            const currentTime = video && Number.isFinite(video.currentTime) ? video.currentTime : 0;
            const currentVideoSrc = video ? (video.currentSrc || video.src || '') : '';
            const isSeeking = video ? Boolean(video.seeking) : false;
            CoreManager.trackBufferHealth(stats.time.current, currentTime, currentVideoSrc, isSeeking);

            UIManager.updateStatsPanel(stats);
            UIManager.updateControlBarBadge(stats);
        },

        start: () => {
            if (!UIManager.timer) {
                UIManager.timer = setInterval(UIManager.update, CONFIG.UI_REFRESH_RATE);
            }
        }
    };

    // 绑定视频标签生命周期，换 P / 换集 / 切换清晰度时即时解限
    let lastVideoElement = null;
    const bindVideoEvents = () => {
        const video = document.querySelector('video');
        if (!video || video === lastVideoElement) return;
        lastVideoElement = video;
        CoreManager._lastAppliedTarget = null;
        CoreManager._hiResLogged = false;

        const onTrigger = () => {
            CoreManager._hiResLogged = false;
            CoreManager._lastAppliedTarget = null;
            setTimeout(() => {
                CoreManager.applyOptimization();
                UIManager.update();
            }, 300);
        };

        video.addEventListener('loadedmetadata', onTrigger);
        video.addEventListener('play', onTrigger);
        video.addEventListener('ratechange', onTrigger);
    };

    // 暴露内部模块供外部/自动化测试调试
    win.__BiliBufferUnlocker = {
        CONFIG,
        Utils,
        ChunkTracker,
        CoreManager,
        UIManager
    };

    // 立即在 tick 0 初始化底层分片拦截引擎
    ChunkTracker.init();

    // DOM 就绪后启动播放器事件绑定与 UI 循环
    let appStarted = false;
    const startApp = () => {
        if (appStarted) return;
        appStarted = true;
        console.log(`[B站缓冲解限] 🚀 脚本已就绪 (v${Utils.version})`);

        bindVideoEvents();
        CoreManager.applyOptimization();

        const initRun = () => {
            bindVideoEvents();
            CoreManager.applyOptimization();
        };
        setTimeout(initRun, 1000);
        setTimeout(initRun, 2500);

        setInterval(() => {
            bindVideoEvents();
            CoreManager.applyOptimization();
        }, CONFIG.CHECK_INTERVAL);

        UIManager.start();
    };

    if (document.readyState !== 'loading' || document.body) {
        startApp();
    } else {
        document.addEventListener('DOMContentLoaded', startApp, { once: true });
        window.addEventListener('load', startApp, { once: true });
    }
})();