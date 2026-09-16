# Bilibili Buffer Unlocker (B站缓冲解限)

[![GitHub Repo](https://img.shields.io/badge/GitHub-liweichen6%2FBilibili--Buffer--Unlocker-181717?logo=github)](https://github.com/liweichen6/Bilibili-Buffer-Unlocker)
[![Forked from GreasyFork](https://img.shields.io/badge/Forked%20from-GreasyFork%20546615-orange?logo=greasyfork)](https://greasyfork.org/zh-CN/scripts/546615-bilibili-buffer-unlocker-b%E7%AB%99%E7%BC%93%E5%86%B2%E8%A7%A3%E9%99%90)
[![Version](https://img.shields.io/badge/Release-v3.2-brightgreen)](https://github.com/liweichen6/Bilibili-Buffer-Unlocker)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/Platform-Tampermonkey%20%7C%20Violentmonkey%20%7C%20ScriptCat-green)](#-安装指南--installation)

> **突破 B 站 Web 端播放器缓冲时长限制，智能按码率计算安全内存，杜绝浏览器 GC 内存溢出与反复重设循环，提供双重原生 UI 状态监控。**

---

> [!NOTE]
> ### 📌 项目渊源与 Fork 持续维护说明 (Lineage & Fork Notice)
> 本项目 **Fork 自 Greasy Fork 上的开源用户脚本 [Bilibili Buffer Unlocker(B站缓冲解限)](https://greasyfork.org/zh-CN/scripts/546615-bilibili-buffer-unlocker-b%E7%AB%99%E7%BC%93%E5%86%B2%E8%A7%A3%E9%99%90)**，原始创作者为 [**\7.**](https://greasyfork.org/zh-CN/users/1507253-7)（在 Greasy Fork 上发布了 v1.0 至 v2.2 版本）。
> 
> 由于上游原版脚本后续停更，本项目在此基础上建立独立仓库进行**持续演进与深度现代化重构**。自 **v3.0** 起，所有关键 Bug 修复（离散区间计算错误、只读解耦等）、Chromium MSE 内存防爆机制升级、无损 DOM 引擎以及双 UI 控制栏集成均由本仓库（[`liweichen6/Bilibili-Buffer-Unlocker`](https://github.com/liweichen6/Bilibili-Buffer-Unlocker)）独立维护并继续开发。
> 
> 衷心感谢原作者 `\7.` 早期开拓性的设计灵感与代码贡献！

---

## 📖 简介 / Overview

默认情况下，哔哩哔哩（Bilibili）Web 端播放器（基于 Dash.js / flv.js 的定制内核）对视频前向缓冲做了极其严格的节流控制，通常仅预载 **20 ~ 30 秒**（`core.getStableBufferTime() = 20`）。在网络环境波动、跨国/海外访问、高码率 4K 播放或频繁快进时，极易造成卡顿和频繁转圈。

**Bilibili Buffer Unlocker** 深入拦截并接管 B 站播放器底层流媒体引擎 (`window.player.__core()`)，将前向缓冲上限从官方默认 20 秒提升至最高 **300 秒（5 分钟）**。同时内置智能防爆流控引擎，根据视频码率动态自适应调整缓冲目标，彻底避免触发 Chromium 浏览器的强制 GC 驱逐陷阱。

---

## ✨ 核心特性 / Features

- 🚀 **突破时长限制**：默认缓冲时长由官方 20s 提升至 **300s（5 分钟）**，网络不稳定或高倍速播放时平滑无阻。
- 🛡️ **双配额动态安全内存上限（智能限流）**：
  - 自动从播放器元数据独立提取音视频码率 (`mediaInfo.videoDataRate` 与 `mediaInfo.audioDataRate`)。
  - 深度对齐 Chromium MSE 底层规范：视频轨安全上限 **110 MiB**（硬限制 150 MiB），音频轨安全上限 **10 MiB**（硬限制 12 MiB），双轨取交集保底，杜绝单轨内存溢出与 GC 驱逐。
- 🔬 **真·连续缓冲计算（Range-Containment）**：
  - 准确遍历 `HTMLMediaElement.buffered` 的离散区间，智能聚合微小缝隙（$\le 0.25\text{s}$）的连续分片，精准匹配当前进度点。
  - 彻底解决用户回拖进度条（Seek）或分段拉流时缓冲区虚标与假死问题。
- ⚡ **事件驱动即时响应**：
  - 启动时立即绑定视频事件，监听 `<video>` 元素的 `loadedmetadata`、`play`、`ratechange`，在换 P、换集、切换清晰度时 **300ms 内即刻生效**。
- 🎵 **Hi-Res / 杜比全景声特殊流自适应与状态重置**：
  - 自动识别 FLAC、EC-3、EAC3、AC-3、AC3、AC-4、Dolby 以及 B 站音质 ID `30250`（杜比全景声）、`30251`（Hi-Res）。
  - 当切入高规格音频时，若播放器处于前序视频的扩容高位（$>30\text{s}$），主动安全重置为官方默认 $20\text{s}$，彻底杜绝内核复用导致的音频溢出。
- 📊 **双重 UI 深度集成与交互增强**：
  - **播放器控制栏常驻微标**：在左下角播放控制条常驻显示 `⚡[缓冲时长]` 微标，悬停即可查看详细指标，支持点击事件隔离与一键手动重触发解限，文字节点常驻缓存。
  - **全屏幕模式对齐**：完美适配普通窗口、宽屏模式（`data-screen="wide"`）、网页全屏与全屏模式的 32px 视觉基准线。
  - **原生统计面板扩展**：右键打开播放器「实时统计信息」，无缝嵌入专属缓冲健康度监控条，修复 DOM 节点可能重复创建的隐患。
- 🔋 **零 DOM 损耗与防抖死区**：
  - 统计窗口关闭时自动跳过 DOM 渲染计算；
  - 增加 `currentSetting !== targetSeconds` 守卫与 $\ge 5\text{s}$ 容差死区（Hysteresis Deadband），彻底规避 4K/8K 等极端高码率下每 3 秒重复写入内核的开销。
- 🛡️ **沙箱穿透与无害隔离**：
  - 元数据显式声明 `@grant unsafeWindow` 确保 Manifest V3 环境稳定运行，引入 `@noframes` 规避广告及评论区 iframe 内无效执行。

---

## 🧠 技术原理深度解析 / Technical Deep-Dive

### 1. 为什么不能无脑调大内存？“161 MB” 崩溃陷阱解析

部分用户尝试自行将配置中的 `SAFE_BYTE_LIMIT` 改为数百兆甚至数吉字节，结果发现**视频缓冲到 160MB 左右就会瞬间清空，然后无限重新下载（无限重设循环）**。

这是由 **Chromium 浏览器底层内核的硬编码限制** 决定的：

在 Chromium 源码 [`media/filters/source_buffer_platform.cc`](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/media/filters/source_buffer_platform.cc) 中，Media Source Extensions (MSE) 的 `SourceBuffer` 内存上限为硬编码常量：

```cpp
// Chromium 源码 media/filters/source_buffer_platform.cc:
const int kSourceBufferVideoMemoryLimit = 150 * 1024 * 1024; // 150 MiB (约 157.28 MB)
const int kSourceBufferAudioMemoryLimit = 12 * 1024 * 1024;  //  12 MiB (约 12.58 MB)
```

| 媒体流类型 | Chromium 内部配额 | 字节数 | 对应大小 |
| :--- | :--- | :--- | :--- |
| **视频轨 (Video)** | `kSourceBufferVideoMemoryLimit` | 157,286,400 Bytes | **150.0 MiB** |
| **音频轨 (Audio)** | `kSourceBufferAudioMemoryLimit` | 12,582,912 Bytes | **12.0 MiB** |
| **合计硬顶阈值** | Video + Audio | 169,869,312 Bytes | **~161–162 MB** |

#### 崩溃循环连锁反应：
```
1. 脚本命令播放器预载超大缓冲
   ↓
2. 缓冲数据达到 ~161 MB，触发 Chromium 的 SourceBufferStream::GarbageCollectIfNeeded()
   ↓
3. 刚开始播放，当前时间点之前的历史缓冲极少，GC 无法通过释放历史数据来腾出空间
   ↓
4. 浏览器抛出 QuotaExceededError 或强行丢弃后方未播放分片
   ↓
5. B 站内核捕获管道异常，触发容灾重置逻辑 (recreateVideoBuffer / removeVideoBuffer)
   ↓
6. 播放器缓冲区被全部抹除清零！
   ↓
7. 脚本检测到缓冲降为 0，再次指令拉取缓冲……进入死循环，疯狂消耗带宽并导致播放卡死
```

### 2. 黄金法则：为什么默认预设 120 MB？

$$\text{Chromium 硬顶 162 MB} - \text{脚本预设 120 MB} = \mathbf{42\text{ MB 安全余量}}$$

1. **GOP / 关键帧脉冲**：4K 视频一个 GOP 切片往往达 15~25 MB。若将上限设在 150 MB，下一个切片追加瞬间便会冲破 162 MB 触发 GC 崩溃。
2. **VBR（动态码率）突发**：高动态场景（演唱会、特效大片）瞬间码率可能飙升至均值的 2 倍以上。
3. **结论**：**`120 MB ~ 130 MB` 是兼顾超长缓冲与绝对稳定性的最佳平衡点**。

### 3. v3.2 架构升级：音视频双配额隔离安全模型 (Dual-Quota Safety Budget)

在旧版单配额模型下，仅以音视频综合码率（`totalBps`）进行统一计算，容易引发两类极端单轨击穿风险：
- **音频单轨溢出**：在特殊高码率音频（如未被特殊识别的 320 kbps+ 音轨）或低画质长视频流下，综合配额可能计算出极大时长，导致音频缓冲超出 Chromium 的 **12 MiB 音频硬限制** 触发崩溃；
- **视频单轨溢出**：高动态 4K/8K 视频轨若抢占绝大部分配额，单 GOP 脉冲可能直接突破 **150 MiB 视频硬顶**。

v3.2 引入 **音视频独立双配额隔离预算**：
$$\text{safeVideoSec} = \frac{\text{SAFE\_VIDEO\_BYTE\_LIMIT (110 MiB)}}{\text{videoBps}},\quad \text{safeAudioSec} = \frac{\text{SAFE\_AUDIO\_BYTE\_LIMIT (8 MiB)}}{\text{audioBps}}$$
$$\text{safeSeconds} = \max\left(20,\; \min(\text{safeAudioSec},\; \text{safeVideoSec},\; 600)\right)$$

双轨各自按码率计算可缓冲秒数并严格取**交集下限**，在数学上绝对保证了：
1. **视频轨内存消耗** $\le 110\text{ MiB}$（低于 Chromium 150 MiB 硬顶，预留 40 MiB 安全余量）；
2. **音频轨内存消耗** $\le 8\text{ MiB}$（低于 Chromium 12 MiB 硬顶，预留 4 MiB 安全余量）；
3. **综合内存消耗** $\le 118\text{ MiB}$（低于 162 MB 合计硬顶，预留 44 MB 安全余量）。

---

## 🛠️ 配置说明 / Configuration

可在脚本开头 `CONFIG` 字典中按需自定义（直接编辑脚本即可保存）：

```javascript
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
```

---

## 📊 实测数据 (基于 BV19Q4y1x7nw)

使用 Chrome DevTools 进行真实环境注入测试与抓包验证：

| 指标 / 属性 | 实测数值 / 行为 | 说明 |
| :--- | :--- | :--- |
| **官方默认缓冲** | `core.getStableBufferTime() = 20` | B 站默认将预载控制在 20 秒左右 |
| **实测码率 (1080P)** | 视频 175 kbps / 音频 46 kbps | 综合约 27.1 KB/s |
| **缓冲解除后爬升** | **21.0s $\rightarrow$ 210.4s**（耗时仅约 10 秒） | 成功下载后续数十个分片，进度条完全解锁 |
| **内存实际占用** | 210 秒缓冲仅占约 **5.6 MB** | 与码率计算值完全吻合，远在 120MB 安全线内 |

---

## 📝 版本更新历史 / Changelog

### 🚀 当前仓库持续演进版本 (Forked & Maintained by liweichen6)

#### v3.2 (2026-09)
- 🛡️ **双配额独立内存安全预算 (Dual-Quota Memory Budget)**：
  - 将缓冲时长安全计算解耦为独立的视频轨与音频轨配额预算（视频 110 MiB 安全线 / 音频 10 MiB 安全线），双轨各自按码率计算可缓冲秒数并取下限交集，彻底消除高规格音频或超高码率单轨突破 Chromium MSE 阈值引发的 GC 驱逐风险；
  - 增加单轨码率缺失自适应补全：当仅音频或仅视频码率已知但流总带宽有效时，智能差分推导另一轨码率，杜绝因单轨缺省引发的时长虚高与内存击穿。
- 🎵 **Hi-Res / 杜比全景声全面识别与主动安全重置**：
  - 扩展特殊流识别范围，覆盖 `ac-3`、`ac3`、`ac-4` 及 B 站音频质量 ID `30250`（杜比全景声）和 `30251`（Hi-Res 无损），同时支持对 `audioQualityName` 字符串的文本特征深度识别；
  - 增加播放器复用防护：切入特殊音频流时，若播放器内核配置仍处于前序视频的扩容高位（`currentSetting > 30s` 或 `_lastAppliedTarget !== 20`），主动重置为官方默认 `20s` 保底策略并输出防抖提示日志。
- 🔬 **连续缓冲区间聚合计算 (Contiguous Range Merging)**：重构 `video.buffered` 判定逻辑，消除对首个匹配区间的过早中断（Premature Break），智能聚拢缝隙 $\le 0.25\text{s}$ 的连续缓冲片段，精准统计并展示播放器真实向后可用缓冲。
- ⚖️ **防抖死区强一致校验与无状态内核兼容 (Hysteresis & Fallback Guard)**：
  - 在 `applyOptimization()` 中增加 `effectiveSetting !== targetSeconds` 前置守卫，彻底解决 4K/8K 等极端高码率场景下安全目标低于 30 秒时每 3 秒定时器重复写内核的缺陷；
  - 引入 `_lastAppliedTarget` 内部状态跟踪，在播放器内核未暴露 `getStableBufferTime()` 读接口时亦能精准规避定时器高频重复写入。
- ⚡ **统计查询彻底纯函数化 (Pure getStats)**：将 `getStats()` 中的健康度裁剪追踪与警告逻辑剥离至独立的 `trackBufferHealth()`，确保 `getStats()` 为 100% 只读、无副作用的状态查询函数，避免外部调用干扰异常裁剪判定。
- 🎬 **生命周期极速启动绑定**：脚本初始化 `main()` 时立即调用 `bindVideoEvents()` 与 `applyOptimization()`，彻底消除首个周期内的事件监听盲区与优化延迟。
- 🛡️ **沙箱穿透与无害隔离**：显式声明 `// @grant unsafeWindow` 保障 Manifest V3 隔离环境下的穿透访问；引入 `// @noframes` 规避广告/评论 iframe 中的无效运行与定时器浪费。
- 🎨 **宽屏模式居中与微标交互增强**：
  - 补齐宽屏模式（`[data-screen="wide"]`）样式规则，在宽屏模式下完美对齐 32px 视觉基准线；
  - 为控制栏微标添加 `click`、`mousedown`、`mouseup`、`pointerdown` 事件阻止冒泡（`stopPropagation` / `preventDefault`），支持点击微标一键强制重新应用优化并刷新 UI；
  - 增加微标内部文本节点常驻引用缓存，避免每秒调用 DOM 查询。
- 🐞 **修复统计面板 DOM 重复创建缺陷**：优化 `updateStatsPanel()` 逻辑，在面板已存在时复用现有 DOM 节点并刷新引用，同时清理容器外的游离孤儿面板，彻底规避多面板重叠缺陷。

#### v3.1 (2026-09)
- 🎨 **控制栏微标全场景像素级居中对齐**：全面适配普通窗口、网页全屏与全屏模式，精准锚定原生 32px 视觉基准线（与播放键、时间标签实现 0 像素垂直偏差）。
- 🔤 **修复微标文字塌陷隐形 Bug**：显式指定文字大小与行高，彻底规避 B 站原生 `.bpx-player-ctrl-btn` 规则中 `font-size: 0px` 导致的文字宽高归零缺陷。
- ✨ **增强交互动效**：增加微标悬浮（Hover）高亮渐变过渡，完美融入原生播放器控制栏交互质感。

#### v3.0 (2026-09) - *里程碑版本：全面重构、性能飞跃与双 UI 架构*
- 🐞 **修复离散缓冲区间计算 Bug**：改用精确的范围匹配算法 (`start - 0.25 <= currentTime <= end`)，彻底解决回拖进度条后 `video.buffered` 报告虚高缓冲的严重缺陷。
- ⚡ **分离查询与修改副作用**：将 `getStats()` 转为纯粹的只读查询函数，杜绝每秒 UI 刷新时对播放器内核的重复写入。
- ⚖️ **重构防抖死区（Hysteresis Deadband）**：严谨限定 $\ge 5\text{s}$ 或保底值才下发配置，消除了码率微波动导致的内核配置频繁抖动。
- 🚫 **杜绝缓冲重置误报**：增加 `video.seeking` 及视频源切换（`currentSrc`）识别，正常拖拽进度或切集时不再触发误报警告。
- 🖥️ **高性能 UI 渲染引擎**：
  - 引入可见性侦测：统计面板隐藏时自动挂起 DOM 绘制；
  - 采用 DOM 节点引用缓存，使用 `.textContent` 增量更新，杜绝布局抖动（Layout Thrashing）。
- ⚡ **全新功能：播放器控制栏常驻微标**：无需右键打开统计面板，直接在播放器底栏常驻显示轻量状态标（`⚡[时长]`），带悬浮信息提示。
- 🎬 **生命周期事件驱动**：绑定 `<video>` 的 `loadedmetadata`、`play`、`ratechange`，切 P、切清晰度无需等待定时器，毫秒级响应。

---

### 📦 Greasy Fork 原版历史归档 (Original by \7.)

#### v2.2 (2026-03-20)
- 🎵 适配 Hi-Res 视频：检测到 FLAC / 杜比全景声等高规格音频流时保持 B 站默认策略免干预，保障特殊音轨平稳解码。

#### v2.1 (2026-01-25)
- 🎨 修正 UI 统计面板中的缓冲区时长与缓存上限显示。

#### v2.0 (2026-01-21)
- 🛡️ **鲁棒性增强**：加入守护机制，解决自动换集或清晰度切换后配置失效的问题。
- 🧠 **智能限流初版**：引入码率与内存占用估算，解决高画质下因浏览器内存溢出导致的“缓冲消失”与“反复重缓冲”。
- 🎨 UI 展示优化。

#### v1.0 ~ v1.3 (2025-08-21)
- 初始版本发布：突破 B 站播放器缓冲长度限制，在播放器右键统计信息中集成缓冲指标展示。

---

## 📥 安装指南 / Installation

### 途径一：本仓库持续维护版（v3.2+ 推荐）

1. 安装浏览器脚本管理器扩展：
   - [Tampermonkey (篡改猴)](https://www.tampermonkey.net/)
   - [Violentmonkey (暴力猴)](https://violentmonkey.github.io/)
   - [ScriptCat (脚本猫)](https://scriptcat.org/)
2. 点击下方链接一键安装最新重构版：
   - 👉 **[安装 v3.2+ 最新版 (GitHub Raw)](https://raw.githubusercontent.com/liweichen6/Bilibili-Buffer-Unlocker/main/Bilibili%20Buffer%20Unlocker.js)**
   - 或直接下载本仓库根目录的 [`Bilibili Buffer Unlocker.js`](./Bilibili%20Buffer%20Unlocker.js) 导入至脚本管理器。

### 途径二：Greasy Fork 原版（v2.2 基础归档）

- 可前往上游原版主页查看：[Greasy Fork 脚本主页 (v2.2)](https://greasyfork.org/zh-CN/scripts/546615-bilibili-buffer-unlocker-b%E7%AB%99%E7%BC%93%E5%86%B2%E8%A7%A3%E9%99%90)

---

## 📜 许可证 / License

本项目基于 [MIT License](LICENSE) 开源发布。
原版代码版权归原作者 `\7.` 所有；v3.0+ 演进维护由 `liweichen6` 持续推进。