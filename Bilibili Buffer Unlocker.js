// ==UserScript==
// @name         Bilibili Buffer Unlocker(B站缓冲解限)
// @name:zh      B站缓冲解限
// @name:en      Bilibili Buffer Unlocker
// @namespace    https://github.com/liweichen6/Bilibili-Buffer-Unlocker
// @version      3.0
// @description  Increase Bilibili player video buffer duration, intelligently prevent memory overflow, and integrate with player statistics UI. 解限B站播放器缓冲时长，智能防止内存溢出，播放器统计信息UI集成
// @description:zh 解限B站播放器缓冲时长，智能防止内存溢出，播放器统计信息UI集成
// @description:en Increase Bilibili player video buffer duration, intelligently prevent memory overflow, and integrate with player statistics UI
// @author       \7. (Original Author), liweichen6 with Gemini (v3.0+ Ongoing Development)
// @homepageURL  https://github.com/liweichen6/Bilibili-Buffer-Unlocker
// @supportURL   https://github.com/liweichen6/Bilibili-Buffer-Unlocker/issues
// @match        *://*.bilibili.com/*
// @match        *://bilibili.com/*
// @grant        none
// @run-at       document-end
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
        SAFE_BYTE_LIMIT: 120 * 1024 * 1024, // 安全内存空间上限 120MB
        CHECK_INTERVAL: 3000,               // 内核优化轮询间隔 (毫秒)
        UI_REFRESH_RATE: 1000,              // UI 刷新间隔 (毫秒)
        HYSTERESIS_DELTA: 5,                // 缓冲目标调整容差 (秒，防频繁抖动)
        SHOW_CONTROL_BAR_BADGE: true        // 是否在播放器控制栏常驻显示轻量缓冲微标 (⚡180s)
    };

    const win = (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;

    const Utils = {
        version: (typeof GM_info !== 'undefined' && GM_info.script && GM_info.script.version) ? GM_info.script.version : '3.0',

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

        // 从媒体元数据获取当前音视频总传输速率 (Bytes/s)
        getCurrentBytesPerSecond: () => {
            try {
                const core = CoreManager.getCore();
                if (!core) return 0;
                const mediaInfo = core.state?.mediaInfo || core.mediaInfo;
                if (!mediaInfo) return 0;

                const videoRate = Number(mediaInfo.videoDataRate) || 0;
                const audioRate = Number(mediaInfo.audioDataRate) || 0;
                const totalBps = (videoRate + audioRate) / 8;

                return totalBps > 0 ? totalBps : 0;
            } catch {
                return 0;
            }
        },

        // 检测是否包含 Hi-Res / 杜比全景声特殊音频流
        isHiRes: () => {
            try {
                const core = CoreManager.getCore();
                if (!core) return false;
                const mediaInfo = core.state?.mediaInfo || core.mediaInfo;
                if (!mediaInfo) return false;
                const codec = String(mediaInfo.audioCodec || mediaInfo.audioCodecName || '').toLowerCase();
                return codec.includes('flac') || codec.includes('ec-3') || codec.includes('eac3') || codec.includes('dolby');
            } catch {
                return false;
            }
        },

        // 动态根据码率计算内存安全的最大缓冲时长
        calculateSafeDuration: () => {
            const bps = CoreManager.getCurrentBytesPerSecond();
            if (bps <= 0) return CONFIG.MAX_TIME_LIMIT;
            const safeSeconds = CONFIG.SAFE_BYTE_LIMIT / bps;
            return Math.max(CONFIG.MIN_TIME_LIMIT, Math.min(CONFIG.MAX_TIME_LIMIT, Math.floor(safeSeconds)));
        },

        // 执行缓冲扩容优化
        applyOptimization: () => {
            try {
                const core = CoreManager.getCore();
                if (!core) return;

                // Hi-Res 音频遵循 B 站内置策略，避免触发解码管道或 CDN 调度异常
                if (CoreManager.isHiRes()) {
                    if (!CoreManager._hiResLogged) {
                        console.log('[缓冲解限] 🎵 检测到 Hi-Res/杜比音质，跳过缓冲干预（保持播放器默认策略）');
                        CoreManager._hiResLogged = true;
                    }
                    return;
                }
                CoreManager._hiResLogged = false;

                const targetSeconds = CoreManager.calculateSafeDuration();

                if (typeof core.setStableBufferTime === 'function') {
                    const currentSetting = typeof core.getStableBufferTime === 'function' ? core.getStableBufferTime() : null;
                    const isInvalid = !Number.isFinite(currentSetting);

                    // 容差判定：当未设置、低于播放器默认保底(30s)或差值超过阈值时更新
                    if (isInvalid || currentSetting < 30 || Math.abs(currentSetting - targetSeconds) >= CONFIG.HYSTERESIS_DELTA) {
                        core.setStableBufferTime(targetSeconds);
                    }
                }
            } catch {
                // 静默恢复
            }
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
                let baseTargetTime = CONFIG.MAX_TIME_LIMIT;
                if (core && typeof core.getStableBufferTime === 'function') {
                    const setting = core.getStableBufferTime();
                    baseTargetTime = hiRes ? (Number.isFinite(setting) ? setting : 60) : CoreManager.calculateSafeDuration();
                }

                // 当前视频剩余可播时长
                let remainingTime = Infinity;
                let currentTime = 0;
                if (video && Number.isFinite(video.duration) && Number.isFinite(video.currentTime)) {
                    currentTime = video.currentTime;
                    remainingTime = Math.max(0, video.duration - currentTime);
                }

                // 精准计算当前播放进度点向后的连续有效缓冲时长
                let bufferedAhead = 0;
                if (video && video.buffered && video.buffered.length > 0) {
                    const ranges = video.buffered;
                    for (let i = 0; i < ranges.length; i++) {
                        const start = ranges.start(i);
                        const end = ranges.end(i);
                        if (currentTime >= start - 0.25 && currentTime <= end) {
                            bufferedAhead = Math.max(0, end - currentTime);
                            break;
                        }
                    }
                }

                // 核心诊断 fallback
                if (bufferedAhead === 0 && core && typeof core.getBufferLength === 'function') {
                    try {
                        bufferedAhead = core.getBufferLength() || 0;
                    } catch {}
                }

                // 智能异常裁剪诊断（过滤用户正常拖动、回退、切换视频等行为）
                const currentVideoSrc = video ? (video.currentSrc || video.src || '') : '';
                if (CoreManager._lastVideoSrc === currentVideoSrc && video && !video.seeking) {
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

        // 1. 原生统计信息面板集成 (右键 -> 实时统计信息)
        updateStatsPanel: (stats) => {
            const container = document.querySelector('.bpx-player-info-container, .bilibili-player-info-container');
            if (!container || !container.offsetParent) return;

            let panel = container.querySelector('#my-buffer-overlay');
            if (!panel || panel !== UIManager.statsPanelRef) {
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
                UIManager.cachedStatsElements = {
                    timeCur: panel.querySelector('#buf-time-cur'),
                    timeTar: panel.querySelector('#buf-time-tar'),
                    memCur: panel.querySelector('#buf-mem-cur'),
                    memTar: panel.querySelector('#buf-mem-tar'),
                    hiresTag: panel.querySelector('#buf-hires-tag')
                };
                UIManager.statsPanelRef = panel;
            }

            const el = UIManager.cachedStatsElements;
            if (!el) return;

            const isHealthy = stats.time.current > 10 && stats.time.percent > 30;
            el.timeCur.textContent = Utils.formatTime(stats.time.current);
            el.timeCur.style.color = isHealthy ? '#52c41a' : '#faad14';
            el.timeTar.textContent = Utils.formatTime(stats.time.target);
            el.memCur.textContent = Utils.formatSize(stats.memory.current);
            el.memTar.textContent = Utils.formatSize(stats.memory.target);
            el.hiresTag.style.display = stats.hiRes ? 'inline' : 'none';
        },

        // 2. 播放器控制栏常驻微标 (无需右键展开即可常驻查看)
        updateControlBarBadge: (stats) => {
            if (!CONFIG.SHOW_CONTROL_BAR_BADGE) return;

            const ctrlLeft = document.querySelector('.bpx-player-control-bottom-left');
            if (!ctrlLeft) return;

            let badge = document.getElementById('bili-buffer-badge');
            if (!badge || !ctrlLeft.contains(badge)) {
                if (badge && badge.parentNode) {
                    badge.parentNode.removeChild(badge);
                }
                badge = document.createElement('div');
                badge.id = 'bili-buffer-badge';
                badge.className = 'bpx-player-ctrl-btn';
                badge.style.cssText = 'display:inline-flex; align-items:center; justify-content:center; height:100% !important; width:auto !important; padding:0 4px; margin:0 2px; cursor:pointer; user-select:none; font-size:11px; font-family:inherit; box-sizing:border-box; vertical-align:middle;';
                badge.innerHTML = '<span id="bili-buffer-badge-text" style="display:inline-flex; align-items:center; justify-content:center; color:#00aeec; font-weight:bold; background:rgba(0,174,236,0.12); border:1px solid rgba(0,174,236,0.3); border-radius:4px; padding:1px 5px; line-height:16px; box-sizing:border-box; white-space:nowrap;">⚡0s</span>';
                ctrlLeft.appendChild(badge);
                UIManager.badgeRef = badge;
            }

            const textEl = badge.querySelector('#bili-buffer-badge-text');
            if (textEl) {
                textEl.textContent = `⚡${Utils.formatTime(stats.time.current)}`;
            }
            badge.title = `已缓冲: ${Utils.formatTime(stats.time.current)} / ${Utils.formatTime(stats.time.target)} | 内存估算: ${Utils.formatSize(stats.memory.current)} / ${Utils.formatSize(stats.memory.limit)}`;
        },

        update: () => {
            const stats = CoreManager.getStats();
            if (!stats) return;

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

        const onTrigger = () => {
            setTimeout(CoreManager.applyOptimization, 300);
        };

        video.addEventListener('loadedmetadata', onTrigger);
        video.addEventListener('play', onTrigger);
        video.addEventListener('ratechange', onTrigger);
    };

    const main = () => {
        console.log(`[B站缓冲解限] 🚀 脚本已就绪 (v${Utils.version})`);

        // 初始解限优化
        setTimeout(CoreManager.applyOptimization, 1000);
        setTimeout(CoreManager.applyOptimization, 2500);

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