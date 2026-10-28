/**
 * app.js —— Vue 3 应用主逻辑
 *
 * 职责：
 *   ① 四种输入源（图片 / 视频 / 摄像头 / 屏幕）统一帧调度
 *   ② 调 FaceEmotionEngine 做本地人脸情绪识别
 *   ③ 调 music-engine 在浏览器里分析本地曲库的旋律情绪
 *   ④ 调 recommender 产出推荐，并处理播放与反馈学习
 */
import { EMOTIONS, EMOTION_KEYS, STRATEGIES, probsToVA, clamp01 } from './emotions.js';
import { FaceEmotionEngine } from './face-engine.js';
import { analyzeUrl, createAudioContext } from './music-engine.js';
import { recommend, computeTarget, updateProfile } from './recommender.js';
import { searchOnline } from './online.js';
import { saveUpload, loadUploads, deleteUpload } from './upload-store.js';

const MODES = [
  { key: 'image', label: '上传图片', icon: '🖼', tip: '选一张正脸照片，或点下方演示人脸库任意一张' },
  { key: 'video', label: '打开视频', icon: '🎞', tip: '选择本地 mp4 / webm，逐帧识别' },
  { key: 'camera', label: '实时摄像头', icon: '📷', tip: '点「开启摄像头」并授权浏览器' },
  { key: 'screen', label: '屏幕视频', icon: '🖥', tip: '共享正在播放视频的窗口' },
];

const LIB_CACHE_KEY = 'emotionMusic.library.v1';
const PROFILE_KEY = 'emotionMusic.profile.v1';   // 反馈画像：点赞学到的东西不该刷新即丢

const { createApp } = Vue;
let APP_VM = null;   // 便于自动化测试读取状态

const app = createApp({
  data() {
    return {
      modes: MODES,
      mode: 'image',
      engineReady: false,
      backend: '-',
      lastMs: 0,
      fps: 0,
      quality: '',
      qualityOptions: [],

      emotions: EMOTIONS,
      faceGroups: [],
      faces: [],
      imageUrl: '',
      videoReady: false,
      videoPaused: false,
      running: false,
      hasSource: false,
      stageAspect: 4 / 3,

      result: null,
      statusText: '等待输入',

      library: [],
      analyzedCount: 0,
      analyzing: false,
      analyzeMsg: '分析本地曲库',

      uploads: [],
      uploading: false,
      uploadMsg: '',
      uploadErr: '',
      dropActive: false,

      strategies: STRATEGIES,
      strategy: 'mixed',
      recommendations: [],
      target: null,
      onlineResults: [],
      onlineLoading: false,
      onlineMsg: '',

      current: null,
      playing: false,
      progress: 0,
      curTime: 0,
      duration: 0,
      feedback: {},
      profile: { va: { valence: 0.5, arousal: 0.5 }, weight: 0 },

      toast: '',
    };
  },

  computed: {
    currentMode() { return MODES.find((m) => m.key === this.mode) || MODES[0]; },
    emoInfo() { return (this.result && this.result.found && EMOTIONS[this.result.label]) || EMOTIONS.neutral; },
    currentVA() {
      if (!this.result || !this.result.found) return { valence: 0, arousal: 0 };
      return probsToVA(this.result.probs);
    },
    probRows() {
      const p = (this.result && this.result.probs) || {};
      return EMOTION_KEYS
        .map((k) => ({ key: k, cn: EMOTIONS[k].cn, color: EMOTIONS[k].color, p: p[k] || 0 }))
        .sort((a, b) => b.p - a.p);
    },
    fuseRows() {
      const r = this.result;
      if (!r || !r.found) return [];
      return EMOTION_KEYS
        .map((k) => ({ key: k, cn: EMOTIONS[k].cn, cnn: r.cnn[k], geo: r.geoProb[k], p: r.probs[k] }))
        .sort((a, b) => b.p - a.p);
    },
    libraryReady() { return this.library.length > 0 && this.analyzedCount >= this.library.length; },
    candidateCount() {
      return this.library.filter((t) => t.va).length + this.onlineResults.filter((t) => t.va).length;
    },
    scatter() {
      const pts = [];
      const recIds = new Set(this.recommendations.map((r) => r.id));
      for (const t of this.library) {
        if (!t.va) continue;
        const hit = recIds.has(t.id);
        pts.push({
          x: t.va.valence * 100,
          y: (1 - t.va.arousal) * 100,
          r: hit ? 2.1 : 1.3,
          op: hit ? 0.95 : 0.3,
          color: hit ? '#22d3ee' : '#8b93a7',
        });
      }
      for (const t of this.onlineResults) {
        if (!t.va || !recIds.has(t.id)) continue;
        pts.push({ x: t.va.valence * 100, y: (1 - t.va.arousal) * 100, r: 2.1, op: 0.95, color: '#a78bfa' });
      }
      if (this.current && this.current.va) {
        pts.push({
          x: this.current.va.valence * 100, y: (1 - this.current.va.arousal) * 100,
          r: 2.6, op: 1, color: '#f5a524',
        });
      }
      return pts;
    },
    targetXY() {
      if (!this.target) return null;
      return { x: this.target.valence * 100, y: (1 - this.target.arousal) * 100 };
    },
    coverGradient() {
      const c = (this.current && this.current.va)
        ? (this.current.va.valence > 0.5 ? 'linear-gradient(135deg,#f5a524,#f2545b)' : 'linear-gradient(135deg,#5b8def,#a78bfa)')
        : 'linear-gradient(135deg,#2a2f45,#1b2032)';
      return c;
    },
  },

  watch: {
    strategy() { this.refreshRecs(true); this.savePersonalization(); },
  },

  async mounted() {
    this._engine = new FaceEmotionEngine({ inputSize: 416, cnnWeight: 0.78, emaAlpha: 0.55 });
    this._loop = false;
    this._timer = null;
    this._lastVA = null;
    this._lastRecoAt = 0;
    this._fpsEma = 0;

    await this.loadFaces();
    this.loadPersonalization();
    await this.loadLibrary();
    this.initEngine();
    this.autoDemo();
  },

  beforeUnmount() {
    this.stopAll();
    for (const u of this._objUrls || []) URL.revokeObjectURL(u);
  },

  methods: {
    /* ---------------- 初始化 ---------------- */
    async loadFaces() {
      try {
        const res = await fetch('faces/manifest.json');
        const json = await res.json();
        this.faceGroups = json.groups || [];
        this.faces = this.faceGroups.flatMap((g) =>
          g.items.map((it) => ({ ...it, key: g.key, cn: g.cn, color: EMOTIONS[g.key] ? EMOTIONS[g.key].color : '#8b93a7' })));
      } catch (e) {
        console.warn('人脸清单加载失败', e);
      }
    },

    async loadLibrary() {
      let local = [];
      try {
        const res = await fetch('songs/tracks.json');
        const list = await res.json();
        local = list.map((t) => ({ ...t, source: 'local', va: null, analysis: null }));
      } catch (e) {
        this.showToast('曲库清单加载失败：' + e.message);
      }
      // 用户上传的曲目带完整分析结果，直接并入候选池
      const mine = await this.loadMyUploads();
      this.library = [...local, ...mine];
      if (this.library.length) this.analyzeLibrary();
    },

    /* ---------------- 我的歌曲（上传） ---------------- */
    /** 从 IndexedDB 恢复上次上传的曲目，重新生成可播放的 objectURL */
    async loadMyUploads() {
      let rows = [];
      try {
        rows = await loadUploads();
      } catch (e) {
        this.uploadErr = e.message;
        return [];
      }
      this.uploads = rows.map((r) => {
        const url = URL.createObjectURL(r.blob);
        this._objUrls = this._objUrls || [];
        this._objUrls.push(url);
        return {
          id: r.id,
          title: r.title,
          artist: '我的上传',
          filename: r.filename,
          sizeKB: r.sizeKB,
          duration: r.duration,
          file: url,
          url,
          source: 'upload',
          analysis: r.analysis,
          va: r.analysis ? r.analysis.va : null,
          tags: [],
        };
      });
      return [...this.uploads];
    },

    async onSongPick(e) {
      const files = Array.from(e.target.files || []);
      e.target.value = '';        // 允许重复选同一个文件
      await this.addSongFiles(files);
    },

    async onSongDrop(e) {
      this.dropActive = false;
      const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
      await this.addSongFiles(files);
    },

    /**
     * 接收用户音频：本地解码 → 本地 DSP 分析 → 并入推荐池 → 落 IndexedDB
     * 全程不上传服务器；分析只取前 90 秒，避免整首歌跑几十秒。
     */
    async addSongFiles(files) {
      const ok = files.filter((f) => /^audio\//.test(f.type) || /\.(mp3|wav|m4a|aac|flac|ogg|opus|webm)$/i.test(f.name));
      if (!ok.length) {
        this.showToast('请选择音频文件（mp3 / wav / m4a / flac / ogg）');
        return;
      }
      if (this.uploading) return;
      this.uploading = true;
      this.uploadErr = '';
      const ctx = createAudioContext();
      let added = 0;
      for (let i = 0; i < ok.length; i++) {
        const f = ok[i];
        this.uploadMsg = `分析「${f.name}」（${i + 1}/${ok.length}）…`;
        const url = URL.createObjectURL(f);
        try {
          const a = await analyzeUrl(url, ctx, 90);
          const id = 'u' + Date.now().toString(36) + i;
          const track = {
            id,
            title: f.name.replace(/\.[^.]+$/, ''),
            artist: '我的上传',
            filename: f.name,
            sizeKB: Math.round(f.size / 1024),
            duration: a.duration,
            file: url,
            url,
            source: 'upload',
            analysis: a,
            va: a.va,
            tags: [],
          };
          this.library.push(track);
          this.uploads.push(track);
          this.analyzedCount++;
          this._objUrls = this._objUrls || [];
          this._objUrls.push(url);
          added++;
          // 落盘：下次打开仍在（隐私模式下失败也不影响本次使用）
          try {
            await saveUpload({ id, title: track.title, filename: f.name, sizeKB: track.sizeKB, duration: track.duration, analysis: a, blob: f });
          } catch (e) {
            this.uploadErr = '本次可用，但保存失败（' + e.message + '）';
          }
        } catch (e) {
          // 浏览器抛的是英文原生错误，换成用户能据此行动的说法
          const friendly = /decode|audio data/i.test(e.message)
            ? '无法解码：文件可能损坏，或编码不被浏览器支持（mp3 / wav / m4a 最稳）'
            : e.message;
          this.uploadErr = `「${f.name}」${friendly}`;
          URL.revokeObjectURL(url);
        }
      }
      try { ctx.close(); } catch (e) { /* ignore */ }
      this.uploading = false;
      this.uploadMsg = '';
      if (added) {
        this.refreshRecs();
        this.showToast(`已添加 ${added} 首，已用本地算法算完情绪坐标并加入推荐池`);
      }
    },

    async removeUpload(track) {
      try { await deleteUpload(track.id); } catch (e) { /* 记录不一致时忽略 */ }
      this.uploads = this.uploads.filter((t) => t.id !== track.id);
      this.library = this.library.filter((t) => t.id !== track.id);
      this.recommendations = this.recommendations.filter((t) => t.id !== track.id);
      if (this.current && this.current.id === track.id) {
        this.stopAll();
        this.current = null;
      }
      if (track.file && track.file.startsWith('blob:')) URL.revokeObjectURL(track.file);
      this.analyzedCount = Math.max(0, this.analyzedCount - 1);
      if (this.target) this.refreshRecs();
      this.showToast('已移除「' + track.title + '」');
    },

    async initEngine() {
      try {
        await this._engine.init('models');
        this.engineReady = true;
        this.backend = this._engine.backend || '-';
        // 档位随算力给默认值：WebGL 用 416，纯 CPU 用 224（416 在 CPU 上是秒级）
        this.qualityOptions = this._engine.qualityOptions();
        // 实测（CPU/15 张演示人脸）：320 与 256 都是 12/15，但 256 快 26%、置信更高，故 CPU 默认取均衡
        const wanted = this._savedQuality || (this.backend === 'webgl' ? 'high' : 'balanced');
        this.setQuality(wanted, { silent: true });
      } catch (e) {
        console.error(e);
        this.showToast('识别模型加载失败：' + e.message);
      }
    },

    /** 切换识别档位（高精度 / 均衡 / 快速），选择会记住 */
    setQuality(key, opts = {}) {
      const applied = this._engine.setQuality(key);
      this.quality = applied.key;
      if (!opts.silent) {
        this.savePersonalization();
        this.showToast(`识别档位：${applied.cn}（输入 ${applied.size}）`);
        // 静态图/视频帧需要重算一次，实时流下一帧自然生效
        if (this.mode === 'image' && this.hasSource) this.detectOnce();
      }
    },

    /** 支持 ?face=faces/happy_1.jpg 直接进入演示态（便于分享与自动化验证） */
    async autoDemo() {
      const q = new URLSearchParams(location.search);
      const face = q.get('face');
      if (!face) return;
      this.mode = 'image';
      this.imageUrl = face;
      this.hasSource = true;
      // 等模型就绪后再识别
      const waitReady = () => {
        if (this.engineReady && this.$refs.img && this.$refs.img.complete) this.detectOnce();
        else setTimeout(waitReady, 300);
      };
      this.$nextTick(waitReady);
    },

    showToast(msg) {
      this.toast = msg;
      clearTimeout(this._toastTimer);
      this._toastTimer = setTimeout(() => { this.toast = ''; }, 3600);
    },

    /* ---------------- 模式切换 ---------------- */
    switchMode(key) {
      if (this.mode === key) return;
      this.stopAll();
      this.mode = key;
      this.result = null;
      this.hasSource = key === 'image' ? !!this.imageUrl : false;
      if (key === 'image' && this.imageUrl) this.$nextTick(() => this.detectOnce());
      this.clearOverlay();
    },

    /* ---------------- 图片 ---------------- */
    onImageFile(e) {
      const f = e.target.files && e.target.files[0];
      if (!f) return;
      if (this.imageUrl && this.imageUrl.startsWith('blob:')) URL.revokeObjectURL(this.imageUrl);
      this.imageUrl = URL.createObjectURL(f);
      this.hasSource = true;
      e.target.value = '';
    },

    pickFace(g, f) {
      this.stopAll();
      this.mode = 'image';
      this.imageUrl = (f && f.file) || g.file || g;
      this.hasSource = true;
      this.$nextTick(() => {
        const img = this.$refs.img;
        if (img && img.complete) this.detectOnce();
      });
    },

    clearImage() {
      if (this.imageUrl && this.imageUrl.startsWith('blob:')) URL.revokeObjectURL(this.imageUrl);
      this.imageUrl = '';
      this.hasSource = false;
      this.result = null;
      this.clearOverlay();
    },

    onImageLoad() {
      this.hasSource = true;
      this.detectOnce();
    },

    async detectOnce() {
      if (!this.engineReady || !this.$refs.img || !this.$refs.img.naturalWidth) return;
      this._engine.reset();
      try {
        const res = await this._engine.detect(this.$refs.img, { smooth: false });
        this.applyResult(res);
      } catch (e) {
        console.error(e);
      }
    },

    /* ---------------- 视频 ---------------- */
    onVideoFile(e) {
      const f = e.target.files && e.target.files[0];
      if (!f) return;
      const v = this.$refs.video;
      if (this._videoUrl) URL.revokeObjectURL(this._videoUrl);
      this._videoUrl = URL.createObjectURL(f);
      v.srcObject = null;
      v.src = this._videoUrl;
      v.loop = true;
      v.play().catch(() => {});
      this.videoReady = true;
      this.videoPaused = false;
      this.hasSource = true;
      this.running = true;
      this.startLoop();
      e.target.value = '';
    },

    toggleVideo() {
      const v = this.$refs.video;
      if (!v) return;
      if (v.paused) { v.play(); this.videoPaused = false; }
      else { v.pause(); this.videoPaused = true; }
    },

    /* ---------------- 摄像头 / 屏幕 ---------------- */
    async startCamera() {
      await this.stopAll();
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
          audio: false,
        });
        this.attachStream(stream);
      } catch (e) {
        this.showToast('摄像头开启失败：' + (e.message || e.name));
      }
    },

    async startScreen() {
      await this.stopAll();
      try {
        const stream = await navigator.mediaDevices.getDisplayMedia({
          video: { frameRate: { ideal: 15 } },
          audio: false,
        });
        this.attachStream(stream);
      } catch (e) {
        this.showToast('屏幕共享取消或失败：' + (e.message || e.name));
      }
    },

    attachStream(stream) {
      this.stream = stream;
      const v = this.$refs.video;
      v.src = '';
      v.srcObject = stream;
      v.play().catch(() => {});
      const track = stream.getVideoTracks()[0];
      if (track) track.onended = () => this.stopAll();
      this.hasSource = true;
      this.running = true;
      this.startLoop();
    },

    async stopAll() {
      this._loop = false;
      if (this._timer) { clearTimeout(this._timer); this._timer = null; }
      if (this.stream) {
        this.stream.getTracks().forEach((t) => t.stop());
        this.stream = null;
      }
      const v = this.$refs.video;
      if (v) {
        v.pause();
        if (v.srcObject) v.srcObject = null;
        if (this.mode === 'video') v.removeAttribute('src');
      }
      this.running = false;
      this.fps = 0;
      if (this.mode !== 'image') this.hasSource = false;
      if (this._engine) this._engine.reset();
    },

    /* ---------------- 识别循环 ---------------- */
    startLoop() {
      if (!this.engineReady) {
        this.showToast('识别模型还在加载，请稍候');
        return;
      }
      this._loop = true;
      this.tick();
    },

    async tick() {
      if (!this._loop) return;
      const t0 = performance.now();
      const src = this.$refs.video;
      let ok = false;
      if (src && src.readyState >= 2 && src.videoWidth) {
        try {
          const res = await this._engine.detect(src, { smooth: true });
          this.applyResult(res);
          ok = true;
        } catch (e) {
          console.warn(e);
        }
      }
      const now = performance.now();
      const cost = now - t0;
      const target = 1000 / 12;
      const wait = Math.max(0, target - cost);
      // 用"帧间隔"统计真实识别频率（含等待时间），再做 EMA 平滑
      if (this._lastTickTs) {
        const gap = now - this._lastTickTs + wait;
        const inst = 1000 / Math.max(1, gap);
        this._fpsEma = this._fpsEma ? this._fpsEma * 0.75 + inst * 0.25 : inst;
      }
      this._lastTickTs = now;
      this.fps = Math.max(1, Math.round(this._fpsEma || 0));
      if (!ok && src && src.readyState < 2) this.fps = 0;
      this._timer = setTimeout(() => this.tick(), wait);
    },

    applyResult(res) {
      this.result = res;
      this.lastMs = Math.round(res.ms || 0);
      this.statusText = res.found ? '识别中' : '未检测到人脸';
      if (res.found) {
        if (res.naturalWidth && res.naturalHeight) {
          this.stageAspect = res.naturalWidth / res.naturalHeight;
        }
        this.drawOverlay(res);
        this.maybeRecommend();
      } else {
        this.clearOverlay();
      }
    },

    /* ---------------- 叠加绘制 ---------------- */
    drawOverlay(res) {
      const c = this.$refs.overlay;
      if (!c) return;
      const W = Math.round(res.naturalWidth || 640);
      const H = Math.round(res.naturalHeight || 480);
      if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
      const ctx = c.getContext('2d');
      ctx.clearRect(0, 0, W, H);
      if (!res.found) return;

      const b = res.box;
      const color = (EMOTIONS[res.label] || EMOTIONS.neutral).color;
      const lw = Math.max(2, W / 300);

      // 关键点（低透明度，展示几何特征阶段的输入）
      if (res.landmarks) {
        ctx.fillStyle = 'rgba(255,255,255,0.55)';
        const rr = Math.max(1, W / 420);
        for (const p of res.landmarks) {
          ctx.beginPath();
          ctx.arc(p.x, p.y, rr, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      // 四角取景框
      const L = Math.min(b.width, b.height) * 0.26;
      ctx.strokeStyle = color;
      ctx.lineWidth = lw;
      ctx.shadowColor = color;
      ctx.shadowBlur = lw * 3;
      ctx.beginPath();
      const x0 = b.x, y0 = b.y, x1 = b.x + b.width, y1 = b.y + b.height;
      ctx.moveTo(x0, y0 + L); ctx.lineTo(x0, y0); ctx.lineTo(x0 + L, y0);
      ctx.moveTo(x1 - L, y0); ctx.lineTo(x1, y0); ctx.lineTo(x1, y0 + L);
      ctx.moveTo(x1, y1 - L); ctx.lineTo(x1, y1); ctx.lineTo(x1 - L, y1);
      ctx.moveTo(x0 + L, y1); ctx.lineTo(x0, y1); ctx.lineTo(x0, y1 - L);
      ctx.stroke();
      ctx.shadowBlur = 0;

      // 标签
      const text = `${(EMOTIONS[res.label] || EMOTIONS.neutral).cn} ${Math.round(res.confidence * 100)}%`;
      const fs = Math.max(13, W / 28);
      ctx.font = `700 ${fs}px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif`;
      const tw = ctx.measureText(text).width;
      const padX = fs * 0.5, padY = fs * 0.28, bh = fs + padY * 2;
      const bx = Math.max(2, Math.min(x0, W - tw - padX * 2 - 4));
      const by = Math.max(2, y0 - bh - fs * 0.35);
      ctx.fillStyle = 'rgba(6,9,14,0.74)';
      ctx.beginPath();
      const r = bh / 2;
      ctx.moveTo(bx + r, by);
      ctx.lineTo(bx + tw + padX * 2 - r, by);
      ctx.quadraticCurveTo(bx + tw + padX * 2, by, bx + tw + padX * 2, by + r);
      ctx.lineTo(bx + tw + padX * 2, by + bh - r);
      ctx.quadraticCurveTo(bx + tw + padX * 2, by + bh, bx + tw + padX * 2 - r, by + bh);
      ctx.lineTo(bx + r, by + bh);
      ctx.quadraticCurveTo(bx, by + bh, bx, by + bh - r);
      ctx.lineTo(bx, by + r);
      ctx.quadraticCurveTo(bx, by, bx + r, by);
      ctx.fill();
      ctx.fillStyle = color;
      ctx.textBaseline = 'middle';
      ctx.fillText(text, bx + padX, by + bh / 2 + 1);
    },

    clearOverlay() {
      const c = this.$refs.overlay;
      if (!c) return;
      const ctx = c.getContext('2d');
      ctx.clearRect(0, 0, c.width, c.height);
    },

    /* ---------------- 推荐 ---------------- */
    maybeRecommend() {
      if (!this.result || !this.result.found) return;
      const now = Date.now();
      const va = this.currentVA;
      const moved = this._lastVA
        ? Math.abs(va.valence - this._lastVA.valence) + Math.abs(va.arousal - this._lastVA.arousal)
        : 1;
      const changed = this.result.label !== this._lastLabel;
      if (!changed && moved < 0.08 && now - this._lastRecoAt < 2500) return;
      this._lastLabel = this.result.label;
      this._lastVA = va;
      this._lastRecoAt = now;
      this.refreshRecs();
      this.fetchOnline(false);
    },

    refreshRecs() {
      if (!this.result || !this.result.found) return;
      const tgt = computeTarget(this.result.probs, this.result.label, this.strategy);
      this.target = tgt;
      const pool = [...this.library.filter((t) => t.va), ...this.onlineResults.filter((t) => t.va)];
      this.recommendations = recommend({
        tracks: pool,
        target: tgt,
        feedback: this.feedback,
        profile: this.profile,
        topK: 6,
      });
    },

    async analyzeLibrary() {
      if (this.analyzing || !this.library.length) return;
      this.analyzing = true;
      let cache = {};
      try { cache = JSON.parse(localStorage.getItem(LIB_CACHE_KEY) || '{}'); } catch (e) { cache = {}; }
      this.analyzedCount = 0;
      const ctx = createAudioContext();
      let dirty = false;
      for (const t of this.library) {
        // 上传曲目在上传时就已算好，重新分析时跳过（也避免把大对象写进 localStorage）
        if (t.source === 'upload') { this.analyzedCount++; continue; }
        const hit = cache[t.id];
        if (hit && hit.duration === t.duration) {
          t.analysis = hit.analysis;
          t.va = hit.analysis.va;
          this.analyzedCount++;
          continue;
        }
        this.analyzeMsg = `分析「${t.title}」…`;
        await new Promise((r) => setTimeout(r, 16));
        try {
          const a = await analyzeUrl(t.file, ctx);
          t.analysis = a;
          t.va = a.va;
          cache[t.id] = { duration: t.duration, analysis: a };
          dirty = true;
          // 逐条落盘：中途刷新页面也不会白算
          try { localStorage.setItem(LIB_CACHE_KEY, JSON.stringify(cache)); } catch (e) { /* 配额不足忽略 */ }
        } catch (e) {
          t.error = e.message;
        }
        this.analyzedCount++;
      }
      try { ctx.close(); } catch (e) { /* ignore */ }
      if (dirty) { try { localStorage.setItem(LIB_CACHE_KEY, JSON.stringify(cache)); } catch (e) { /* ignore */ } }
      this.analyzeMsg = '重新分析曲库';
      this.analyzing = false;
      this.refreshRecs(true);
    },

    async fetchOnline(force) {
      if (!this.result || !this.result.found) {
        if (force) this.showToast('先让画面里出现人脸');
        return;
      }
      const label = this.result.label;
      if (!force && this._onlineLabel === label) return;
      this._onlineLabel = label;
      this.onlineLoading = true;
      this.onlineMsg = '';
      try {
        const list = await searchOnline(EMOTIONS[label].query, 4);
        // 只保留与本地曲库不重复的，并叠加当前策略下的目标约束
        this.onlineResults = list.map((t) => ({ ...t }));
        if (force && !list.length) this.onlineMsg = '在线曲库暂无匹配结果';
        this.refreshRecs();
      } catch (e) {
        this.onlineMsg = '在线曲库不可用：' + e.message;
        if (force) this.showToast(this.onlineMsg);
      } finally {
        this.onlineLoading = false;
      }
    },

    /* ---------------- 播放器 ---------------- */
    play(track) {
      if (!track) return;
      this.current = track;
      const a = this.$refs.audio;
      a.src = track.file || track.url;
      a.load();
      a.play().catch((err) => this.showToast('播放失败：' + err.message));
      if (track.source === 'online' && !track.analysis) this.analyzeOnlineTrack(track);
    },

    async analyzeOnlineTrack(track) {
      if (track._analyzing) return;
      track._analyzing = true;
      this.showToast('正在用本地算法分析在线曲目的旋律特征…');
      try {
        const a = await analyzeUrl(track.url);
        track.analysis = a;
        track.va = a.va;
        track.vaEstimated = false;
        this.refreshRecs(true);
        this.showToast(`在线曲目分析完成：BPM ${Math.round(a.raw.bpm)} · ${a.raw.mode === 'major' ? '大调' : '小调'}`);
      } catch (e) {
        this.showToast('在线曲目分析失败（可能是跨域限制）：' + e.message);
      } finally {
        track._analyzing = false;
      }
    },

    togglePlay() {
      const a = this.$refs.audio;
      if (!this.current || !a) return;
      if (a.paused) a.play().catch(() => {});
      else a.pause();
    },

    onTime() {
      const a = this.$refs.audio;
      if (!a) return;
      this.curTime = a.currentTime || 0;
      this.duration = a.duration || 0;
      this.progress = this.duration ? (this.curTime / this.duration) * 100 : 0;
    },

    onMeta() {
      const a = this.$refs.audio;
      this.duration = (a && a.duration) || 0;
    },

    seek(e) {
      const a = this.$refs.audio;
      if (!a || !a.duration) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const ratio = clamp01((e.clientX - rect.left) / rect.width);
      a.currentTime = ratio * a.duration;
    },

    onEnded() {
      this.playing = false;
      this.progress = 0;
    },

    onAudioError() {
      if (this.current) this.showToast('音频无法播放：' + (this.current.title || ''));
    },

    /* ---------------- 个性化记忆 ---------------- */
    /**
     * 反馈画像（Rocchio 累积向量）与策略选择落 localStorage。
     * 之前只有曲库分析结果被缓存，画像与反馈一刷新就回到 0，
     * 等于每次访问都要重新"认识"用户——这里补上。
     */
    loadPersonalization() {
      let raw = null;
      try { raw = JSON.parse(localStorage.getItem(PROFILE_KEY) || 'null'); } catch (e) { raw = null; }
      if (!raw || typeof raw !== 'object') return;
      if (raw.strategy && STRATEGIES[raw.strategy]) this.strategy = raw.strategy;
      if (typeof raw.quality === 'string') this._savedQuality = raw.quality;
      if (raw.feedback && typeof raw.feedback === 'object') this.feedback = raw.feedback;
      if (raw.profile && raw.profile.va && typeof raw.profile.weight === 'number') {
        this.profile = {
          va: {
            valence: Math.min(1, Math.max(0, Number(raw.profile.va.valence) || 0)),
            arousal: Math.min(1, Math.max(0, Number(raw.profile.va.arousal) || 0)),
          },
          weight: Math.min(1, Math.max(0, Number(raw.profile.weight) || 0)),
        };
      }
    },

    savePersonalization() {
      try {
        localStorage.setItem(PROFILE_KEY, JSON.stringify({
          strategy: this.strategy,
          feedback: this.feedback,
          profile: this.profile,
          quality: this.quality,
        }));
      } catch (e) { /* 配额不足时忽略，不影响本次使用 */ }
    },

    resetProfile() {
      this.feedback = {};
      this.profile = { va: { valence: 0.5, arousal: 0.5 }, weight: 0 };
      this.savePersonalization();
      if (this.target) this.refreshRecs();
      this.showToast('已清空反馈记录与情绪画像');
    },

    likeCurrent() {
      const t = this.current;
      if (!t) return;
      this.feedback = { ...this.feedback, [t.id]: 1 };
      if (t.va) this.profile = updateProfile(this.profile, t.va, true);
      this.savePersonalization();
      this.refreshRecs(true);
      this.showToast('已记录喜欢，情绪画像已更新');
    },

    skipCurrent() {
      const t = this.current;
      if (!t) return;
      this.feedback = { ...this.feedback, [t.id]: -1 };
      if (t.va) this.profile = updateProfile(this.profile, t.va, false);
      this.savePersonalization();
      const a = this.$refs.audio;
      if (a) { a.pause(); a.currentTime = 0; }
      this.playing = false;
      this.refreshRecs(true);
    },

    fmtTime(s) {
      if (!s || !isFinite(s)) return '0:00';
      const m = Math.floor(s / 60);
      const sec = Math.floor(s % 60);
      return `${m}:${String(sec).padStart(2, '0')}`;
    },
  },
});

APP_VM = app.mount('#app');
window.__app = APP_VM;
