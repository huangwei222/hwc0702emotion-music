# 情绪音乐推荐系统（Vue 3 · 本地算法）

一个完全跑在浏览器里的「人脸情绪 → 音乐推荐」系统：**不联网也能用**，人脸画面与音频文件都不上传服务器。

- **前端**：HTML5 + CSS3 + 原生 JavaScript（ES Module）+ Vue 3（本地 vendor，无构建步骤）
- **人脸情绪识别**：face-api.js（TinyFaceDetector + 68 点关键点 + FaceExpressionNet）+ 自研几何规则晚期融合 + EMA 时序平滑
- **旋律情绪识别**：自研纯 JS DSP（STFT → 对数谱通量 → 自相关测速 → 色度×Krumhansl 调式 → 谱质心 → VA 映射）
- **推荐**：VA 空间加权距离 + MMR 多样性重排 + 三种策略 + Rocchio 式反馈画像（画像/反馈/策略持久化到 localStorage，可一键重置画像）
- **在线曲库**：Audius 开放 API（免 Key、支持 CORS），关键词按「从长到短」逐级退让检索，点播后仍用本地算法复算旋律特征
- **自己的歌**：拖入或选择本地音频，浏览器内解码分析（只取前 90 秒）后并入推荐池，音频存 IndexedDB 不上传

## 运行

**方式一（Windows 推荐）**：双击本目录下的 `启动.bat`。
脚本会自动找到 Python、在 8123 端口起服务并打开浏览器；若服务已在运行则只打开浏览器。关闭该窗口即停止服务。

**方式二（命令行）**：

```bash
cd emoMusic20261028
python -m http.server 8123
# 打开 http://127.0.0.1:8123/index.html
```

> 需要用 HTTP 打开（不能双击 file:// 打开）：ES Module 与模型权重都按相对路径加载；
> 实时摄像头需要安全上下文，`localhost` / `127.0.0.1` 满足条件。

端口被占用时换一个即可，例如 `python -m http.server 8899`，再访问 `http://127.0.0.1:8899/index.html`。

演示快捷方式：`http://127.0.0.1:8123/index.html?face=faces/happy_1.jpg` 会自动跑完整条链路。

## 目录

```
index.html            页面 + 使用说明 + 算法说明（静态）
css/style.css         深色 UI
js/app.js             Vue 3 应用：四种输入源、识别调度、推荐、播放、反馈
js/face-engine.js     人脸情绪识别引擎
js/music-engine.js    旋律曲调情绪识别
js/dsp.js             FFT / 汉宁窗 / 重采样
js/recommender.js     目标点、加权距离、MMR、画像更新
js/online.js          Audius 在线曲库
js/upload-store.js    用户上传曲目的 IndexedDB 持久化（直接存 Blob）
js/emotions.js        情绪常量与 VA 映射
models/               face-api 权重（tiny detector 193KB + landmark 77KB + expression 329KB）
songs/                12 首本地曲目（WAV）+ tracks.json
faces/                15 张演示人脸（5 种情绪 × 3 张，AI 生成）+ manifest.json
tools/                曲库合成、参数调优、标定与离线测试脚本
docs/                 技术文档（Word + 可再生成的 HTML 源）
```

## 四种输入源

| 方式 | 说明 |
|---|---|
| 上传图片 | 本地图片或内置 15 张演示人脸，单帧识别 |
| 打开视频 | 本地 mp4/webm，逐帧识别（约 12 FPS） |
| 实时摄像头 | getUserMedia，实时跟随情绪切歌 |
| 屏幕视频 | getDisplayMedia，可共享正在播放影片的窗口 |

识别档位可在顶栏切换（高精度 / 均衡 / 快速），默认按后端自动选择并记住：WebGL 用 416，纯 CPU 用 256（比 320 快 26%，检出的脸还多一张）。

## 用自己的歌

点「上传我的歌曲」，或把 mp3 / wav / m4a / flac / ogg 直接拖进「我的歌曲」区域：

1. 浏览器本地解码 → 同一套 DSP 算 BPM、调式、VA 坐标（只统计前 90 秒，实测 8.4 MB / 199 秒的曲目 472 ms）
2. 音频 Blob 写入 IndexedDB，刷新、重开浏览器都还在；全程没有上传请求
3. 立刻进入候选池，与内置 12 首一起参与加权距离与 MMR 重排，列表里标「我的」
4. 点「移除」同时清理 IndexedDB 记录与内存 objectURL

## 实测数据（12 首标注曲目）

| 指标 | 结果 |
|---|---|
| BPM 平均相对误差 | **0.1 %**（倍频消歧前为 36 %） |
| 调式判定 | **11 / 12**（唯一错判的是刻意半音化的曲目） |
| 单曲旋律分析耗时 | 92–236 ms（25–50 秒曲目，单线程 JS） |
| 整首上传分析耗时 | 472 ms（8.4 MB / 199 秒，取前 90 秒；端到端 816 ms） |
| 人脸识别单帧 | 20–60 ms（WebGL）/ 300–800 ms（CPU 回退） |
| 识别档位（CPU，15 张演示人脸） | 320=检出13·正确12·1291 ms / **256=检出14·正确12·954 ms** / 192=检出11·正确10·611 ms |
| 在线检索命中（7 种情绪） | **7 / 7** 有结果（关键词逐级退让前为 5 / 7，「开心」「厌恶」为 0 条）；单次 0.6–2.1 s |

复现：

```bash
node tools/test_analyzer.js     # 用真实 WAV 跑 DSP，输出特征/精度表
node tools/tune.js              # 色度/测速参数网格实验
python tools/calibrate.py       # NNLS 标定 VA 映射权重
python tools/make_music.py      # 重新合成 12 首本地曲目
node tools/cdp.mjs <url> "<js>" # 极简 CDP 调试器（读页面状态/截图）
```

## 素材说明

- `songs/` 中的 12 首曲目由 `tools/make_music.py` 用加法合成 + 噪声打击乐生成（22050 Hz 单声道 WAV），BPM 与调式在生成时即已知，用于验证算法。
- `faces/` 中的 15 张人像是 AI 生成图像，仅用于演示，非真实人物。
- 在线曲目来自 Audius 开放 API，版权归各上传者所有，仅作流式试听。
