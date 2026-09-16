// ==UserScript==
// @name         Bilibili Buffer Unlocker(B站缓冲解限)
// @name:zh      B站缓冲解限
// @name:en      Bilibili Buffer Unlocker
// @namespace    https://github.com/liweichen6/Bilibili-Buffer-Unlocker
// @version      3.2
// @description  Increase Bilibili player video buffer duration, intelligently prevent memory overflow, and integrate with player statistics UI. 解限B站播放器缓冲时长，智能防止内存溢出，播放器统计信息UI集成
// @description:zh 解限B站播放器缓冲时长，智能防止内存溢出，播放器统计信息UI集成
// @description:en Increase Bilibili player video buffer duration, intelligently prevent memory overflow, and integrate with player statistics UI
// @author       \7. (Original Author), liweichen6 with Gemini (v3.0+ Ongoing Development)
// @homepageURL  https://github.com/liweichen6/Bilibili-Buffer-Unlocker
// @supportURL   https://github.com/liweichen6/Bilibili-Buffer-Unlocker/issues
// @match        *://*.bilibili.com/*
// @match        *://bilibili.com/*
// @grant        unsafeWindow
// @run-at       document-end
// @noframes
// @license      MIT
// @downloadURL  https://raw.githubusercontent.com/liweichen6/Bilibili-Buffer-Unlocker/main/Bilibili%20Buffer%20Unlocker.js
// @updateURL    https://raw.githubusercontent.com/liweichen6/Bilibili-Buffer-Unlocker/main/Bilibili%20Buffer%20Unlocker.js
// ==/UserScript==

(function () {
    'use strict';

    // === 配置区域 ===
    const CONFIG = {
        MIN_TIME_LIMIT: 15,                 // 最低缓冲时间下限 (秒)
        MAX_TIME_LIMIT: 300,                // 缓冲时间上限 300秒 (5分钟)
        SAFE_BYTE_LIMIT: 120 * 1024 * 1024, // 综合安全内存空间上限 120MB (展示基准)
        SAFE_VIDEO_BYTE_LIMIT: 110 * 1024 * 1024, // 视频安全内存上限 110 MiB (Chromium硬限制 150 MiB)
        SAFE_AUDIO_BYTE_LIMIT: 10 * 1024 * 1024,  // 音频安全内存上限 10 MiB (Chromium硬限制 12 MiB)
        CHECK_INTERVAL: 3000,               // 内核优化轮询间隔 (毫秒)
        UI_REFRESH_RATE: 1000,              // UI 刷新间隔 (毫秒)
        HYSTERESIS_DELTA: 5,                // 缓冲目标调整容差 (秒，防频繁抖动)
        SHOW_CONTROL_BAR_BADGE: true        // 是否在播放器控制栏常驻显示轻量缓冲微标 (⚡180s)
    };

    const win = (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;

    const Utils = {
        version: (typeof GM_info !== 'undefined' && GM_info.script && GM_info.script.version) ? GM_info.script.version : '3.2',

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
        }
    };

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

        // 动态根据码率计算内存安全的最大缓冲时长（音视频双配额隔离预算）
        calculateSafeDuration: () => {
            const { videoBps, audioBps, totalBps } = CoreManager.getMediaRates();
            if (totalBps <= 0) return CONFIG.MAX_TIME_LIMIT;

            const safeVideoSec = videoBps > 0 ? (CONFIG.SAFE_VIDEO_BYTE_LIMIT / videoBps) : CONFIG.MAX_TIME_LIMIT;
            const safeAudioSec = audioBps > 0 ? (CONFIG.SAFE_AUDIO_BYTE_LIMIT / audioBps) : CONFIG.MAX_TIME_LIMIT;

            const safeSeconds = Math.min(safeAudioSec, safeVideoSec, CONFIG.MAX_TIME_LIMIT);
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

                    // 容差判定：当当前设置与目标不一致时，在未设置、升级至解限(>=30s)或差值超过容差死区时更新
                    const shouldUpdate = force || (
                        effectiveSetting !== targetSeconds && (
                            !Number.isFinite(effectiveSetting) ||
                            (effectiveSetting < 30 && targetSeconds >= 30) ||
                            Math.abs(effectiveSetting - targetSeconds) >= CONFIG.HYSTERESIS_DELTA
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
                if (CoreManager._lastVideoSrc !== currentVideoSrc) {
                    CoreManager._hiResLogged = false;
                    CoreManager._lastAppliedTarget = null;
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

                const bps = CoreManager.getCurrentBytesPerSecond();
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

                // 精准计算当前播放进度点向后的连续有效缓冲时长 (合并微小缝隙 <= 0.25s 的相邻区间)
                let bufferedAhead = 0;
                if (video && video.buffered && video.buffered.length > 0) {
                    const ranges = video.buffered;
                    const raw = [];
                    for (let i = 0; i < ranges.length; i++) {
                        const s = ranges.start(i);
                        const e = ranges.end(i);
                        if (Number.isFinite(s) && Number.isFinite(e) && s <= e) {
                            raw.push({ start: s, end: e });
                        }
                    }
                    raw.sort((a, b) => a.start - b.start);

                    const mergedRanges = [];
                    for (let i = 0; i < raw.length; i++) {
                        const { start, end } = raw[i];
                        if (mergedRanges.length === 0) {
                            mergedRanges.push({ start, end });
                        } else {
                            const prev = mergedRanges[mergedRanges.length - 1];
                            if (start <= prev.end + 0.25) {
                                prev.end = Math.max(prev.end, end);
                            } else {
                                mergedRanges.push({ start, end });
                            }
                        }
                    }

                    for (let i = 0; i < mergedRanges.length; i++) {
                        const { start, end } = mergedRanges[i];
                        if (currentTime >= start - 0.25 && currentTime <= end) {
                            bufferedAhead = Math.max(0, end - currentTime);
                            break;
                        }
                    }
                }

                // 核心诊断 fallback
                if (bufferedAhead === 0 && core && typeof core.getBufferLength === 'function') {
                    try {
                        bufferedAhead = Math.max(0, Number(core.getBufferLength()) || 0);
                    } catch {}
                }

                const finalTargetTime = Number.isFinite(remainingTime) ? Math.min(baseTargetTime, remainingTime) : baseTargetTime;

                return {
                    time: {
                        current: bufferedAhead,
                        target: finalTargetTime,
                        percent: finalTargetTime > 0 ? Math.min(100, (bufferedAhead / finalTargetTime) * 100) : 100
                    },
                    memory: {
                        current: bufferedAhead * bps,
                        target: finalTargetTime * bps,
                        limit: CONFIG.SAFE_BYTE_LIMIT
                    },
                    bps,
                    hiRes
                };
            } catch {
                return null;
            }
        }
    };

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
                    memTar: panel.querySelector('#buf-mem-tar'),
                    hiresTag: panel.querySelector('#buf-hires-tag')
                };
            } else if (panel !== UIManager.statsPanelRef || !UIManager.cachedStatsElements || !UIManager.cachedStatsElements.timeCur) {
                UIManager.statsPanelRef = panel;
                UIManager.cachedStatsElements = {
                    timeCur: panel.querySelector('#buf-time-cur'),
                    timeTar: panel.querySelector('#buf-time-tar'),
                    memCur: panel.querySelector('#buf-mem-cur'),
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
            el.memCur.textContent = Utils.formatSize(stats.memory.current);
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
            (document.head || document.documentElement).appendChild(style);
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
            badge.title = `已缓冲: ${Utils.formatTime(stats.time.current)} / ${Utils.formatTime(stats.time.target)} | 内存估算: ${Utils.formatSize(stats.memory.current)} / ${Utils.formatSize(stats.memory.limit)} (点击手动触发解限)`;
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

    const main = () => {
        console.log(`[B站缓冲解限] 🚀 脚本已就绪 (v${Utils.version})`);

        // 立即绑定视频生命周期事件并初次尝试优化
        bindVideoEvents();
        CoreManager.applyOptimization();

        // 初始解限优化与事件重绑（应对内核延迟挂载）
        const initRun = () => {
            bindVideoEvents();
            CoreManager.applyOptimization();
        };
        setTimeout(initRun, 1000);
        setTimeout(initRun, 2500);

        // 周期检查优化与重绑
        setInterval(() => {
            bindVideoEvents();
            CoreManager.applyOptimization();
        }, CONFIG.CHECK_INTERVAL);

        // 启动 UI 引擎
        UIManager.start();
    };

    main();
})();