/**
 * upload-store.js —— 用户上传曲目的本地持久化（IndexedDB）
 *
 * 为什么用 IndexedDB 而不是 localStorage：
 *   ① localStorage 只能存字符串，base64 会把 4MB 的 mp3 膨胀到 5.3MB，且配额通常只有 5MB
 *   ② IndexedDB 可直接存 Blob，配额按磁盘比例分配（通常 GB 级），适合放音频
 *   ③ 音频二进制留在本机，绝不上传服务器，符合本项目的本地化原则
 */

const DB_NAME = 'emotionMusic';
const DB_VER = 1;
const STORE = 'uploads';

let _dbPromise = null;

function openDB() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('当前浏览器不支持 IndexedDB（隐私模式常见），本次上传只在当前页面有效'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDB 打开失败'));
  });
  return _dbPromise;
}

function tx(mode, fn) {
  return openDB().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const store = t.objectStore(STORE);
    let out;
    try { out = fn(store); } catch (e) { reject(e); return; }
    t.oncomplete = () => resolve(out && out.result !== undefined ? out.result : out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('事务被中断'));
  }));
}

/**
 * 保存一首上传曲目
 * @param {{id:string,title:string,filename:string,sizeKB:number,duration:number,analysis:object,blob:Blob}} rec
 */
export function saveUpload(rec) {
  return tx('readwrite', (store) => store.put({ ...rec, addedAt: Date.now() }));
}

/** 读取全部上传曲目（按加入时间升序） */
export async function loadUploads() {
  const list = await tx('readonly', (store) => store.getAll());
  return (list || []).sort((a, b) => (a.addedAt || 0) - (b.addedAt || 0));
}

export function deleteUpload(id) {
  return tx('readwrite', (store) => store.delete(id));
}

/** 估算占用，用于界面上提示 */
export async function uploadUsage() {
  try {
    const est = await navigator.storage.estimate();
    return { usage: est.usage || 0, quota: est.quota || 0 };
  } catch (e) {
    return { usage: 0, quota: 0 };
  }
}
