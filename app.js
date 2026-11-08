/* ============================================================
 * 甲油库 · 指甲油出入库管理（本地单机版）
 * 数据存储：localStorage（记录）+ IndexedDB（图片），无需登录
 * AI 识别：匿名调用云端视觉大模型（截图不落库，仅用于提取信息）
 * ============================================================ */

/* ---------- 云服务公共配置（仅用于 LLM 截图识别，可选） ----------
 * 默认为空：AI 截图识别不可用，其余功能（手动录入 / 库存 / 售出 / 看板 / 导入导出）完全正常。
 * 如需启用 AI 识别，在下面填入你自己发布应用后获得的配置：
 *   endpoint:      你的应用域名，如 https://your-app.app.workbuddy.host
 *   publishableKey: 你的应用 publishable key（wbpk_ 开头）
 * 详见随附的《部署教程.md》。
 */
const publicConfig = {
  endpoint: '',
  oauthRelayBaseUrl: '',
  publishableKey: '',
};

/* SDK 初始化加保护：配置无效或 SDK 加载异常时不影响页面启动 */
let cloud = null;
try {
  cloud = window.WorkBuddyCloud
    ? window.WorkBuddyCloud.createWorkBuddyCloud(publicConfig)
    : null;
} catch (e) {
  cloud = null;
}

const SALE_CHANNELS = ['闲鱼', '淘宝', '微信', '线下', '其他'];
const COLOR_FAMILIES = ['红', '粉', '橘', '黄', '绿', '蓝', '紫', '棕', '裸色', '白', '黑', '闪粉/珠光', '猫眼', '金属', '渐变', '其他'];

/* ============================================================
 * 色系标签表：默认标签 + 用户自定义标签（localStorage 持久化）
 * 自定义标签全局生效：录入 chips / 识别项 / 批量栏 / 管理弹窗
 * ============================================================ */
const FAMILIES_KEY = 'nail-polish-families-v1';
const FAMILIES_MIGRATED_KEY = 'nail-polish-families-migrated';

function loadFamilyTags() {
  try {
    const arr = JSON.parse(localStorage.getItem(FAMILIES_KEY));
    if (Array.isArray(arr)) {
      const list = [...new Set(arr.map((s) => String(s).trim()).filter(Boolean))];
      if (list.length) return list;
    }
  } catch (e) { /* 数据损坏时回默认标签 */ }
  return COLOR_FAMILIES.slice();
}
function saveFamilyTags() { localStorage.setItem(FAMILIES_KEY, JSON.stringify(familyTags)); }
let familyTags = loadFamilyTags();

/* 当前生效的色系标签（含默认与自定义） */
function allFamilies() { return familyTags; }

/* 一次性迁移：历史记录里用过、但不在标签表中的色系补进标签表 */
function migrateLegacyFamiliesOnce() {
  if (localStorage.getItem(FAMILIES_MIGRATED_KEY)) return;
  localStorage.setItem(FAMILIES_MIGRATED_KEY, '1');
  const used = [...new Set(polishes.flatMap((p) => familiesOf(p)))];
  const missing = used.filter((f) => !familyTags.includes(f));
  if (missing.length) { familyTags = familyTags.concat(missing); saveFamilyTags(); }
}

function addFamilyTag(name) {
  const v = String(name || '').trim();
  if (!v) { toast('请输入色系名称', 'error'); return false; }
  if (v.length > 12) { toast('色系名称最多 12 个字', 'error'); return false; }
  if (familyTags.some((f) => f.toLowerCase() === v.toLowerCase())) { toast('该色系已存在', 'error'); return false; }
  familyTags.push(v);
  saveFamilyTags();
  return true;
}

/* 确保标签存在（已存在则跳过，不报错），返回是否可用 */
function ensureFamilyTag(name) {
  const v = String(name || '').trim();
  if (!v || v.length > 12) return false;
  if (!familyTags.some((f) => f.toLowerCase() === v.toLowerCase())) {
    familyTags.push(v);
    saveFamilyTags();
  }
  return true;
}

function removeFamilyTag(name) {
  const i = familyTags.indexOf(name);
  if (i === -1) return false;
  familyTags.splice(i, 1);
  saveFamilyTags();
  return true;
}

function resetFamilyTags() {
  familyTags = COLOR_FAMILIES.slice();
  saveFamilyTags();
}

/* ============================================================
 * 色系标签管理弹窗（统一添加 / 删除）
 * ============================================================ */
function renderFamilyTagsModal() {
  const list = $('families-tag-list');
  if (!list) return;
  list.innerHTML = familyTags.map((f) => `
    <span class="family-tag-item">
      <span class="family-tag-name">${esc(f)}</span>
      <button type="button" class="family-tag-remove" data-family-remove="${esc(f)}" title="删除「${esc(f)}」">×</button>
    </span>`).join('') || '<p class="families-empty">暂无色系标签，可在上方输入框添加</p>';
  $('families-count').textContent = `共 ${familyTags.length} 个标签`;
}

function openFamiliesModal() {
  renderFamilyTagsModal();
  setVal('families-input', '');
  openModal('modal-families');
  setTimeout(() => $('families-input').focus(), 50);
}

function confirmAddFamilyTag() {
  const v = getVal('families-input');
  if (addFamilyTag(v)) {
    setVal('families-input', '');
    refreshFamilyUIs();
    $('families-input').focus();
  }
}

/* 标签变动后同步所有相关 UI（录入 chips / 批量栏 / 管理列表 / 筛选） */
function refreshFamilyUIs() {
  fillBatchFamilyOptions();
  renderFamilyTagsModal();
  if (!$('modal-stockin').classList.contains('hidden')) {
    // 标签被删除后，同步清理录入中的已选集合，避免出现无效选项
    stockin.families = stockin.families.filter((f) => familyTags.includes(f));
    renderFamilyChips($('family-chips'), stockin.families, pickFamily);
  }
  if (currentView === 'inventory') refreshFilterOptions();
}

const RECOGNIZE_SYSTEM_PROMPT =
  '你是甲油购买截图信息提取助手。用户会发来一张购买截图（电商订单、代购下单记录、购物车结算页等）。' +
  '截图里可能包含多个商品：请把每一个指甲油商品都单独列为一项，不要合并、不要遗漏、不要编造不存在的信息。' +
  '只返回 JSON 对象，不要输出任何其他文字、解释或 markdown 代码块。' +
  'JSON 结构：{"channel": 整单购买渠道(无则为空字符串), "purchase_date": 整单购入日期(格式 YYYY-MM-DD，无则为空字符串), ' +
  '"items": [{"brand": 品牌名(必填), "series": 系列名(无则为空字符串), "color_name": 颜色名(无则为空字符串), ' +
  '"color_code": 色号(无则为空字符串), "price": 数字(该商品实付单价，无法判断则为 null)}]}。' +
  '重点保证 brand / series / color_code 准确；price / channel / purchase_date 供数据汇总用，顺带提取即可。' +
  '如果截图里只有一个商品，items 数组也只包含一项。';

const VISION_PREFERENCE = [
  'glm-5.3', 'kimi-k3-1', 'deepseek-v4-pro', 'minimax-m3', 'step-5-preview',
  'hy4-preview', 'glm-4.6v', 'kimi-k2.8-preview',
];

const CHART_COLORS = ['#c14e78', '#e2799f', '#9b5de5', '#6a8eae', '#e8a87c', '#7fb685', '#d6604d', '#8a7ca8', '#5aa9a6', '#c9a227'];

/* ============================================================
 * 本地存储层：localStorage 存记录，IndexedDB 存图片
 * ============================================================ */
const LS_KEY = 'nail-polish-records-v1';
const IDB_NAME = 'nail-polish-images';
const IDB_STORE = 'images';
const SEED_FLAG_KEY = 'nail-polish-seed-imported';

function readStore() {
  try {
    const s = JSON.parse(localStorage.getItem(LS_KEY));
    if (s && Array.isArray(s.records)) return s;
  } catch (e) { /* 数据损坏时从空开始 */ }
  return { seq: 0, records: [] };
}

function writeStore(s) {
  localStorage.setItem(LS_KEY, JSON.stringify(s));
}

function openIdb() {
  return new Promise((resolve, reject) => {
    if (!window.indexedDB) { reject(new Error('浏览器不支持本地存储')); return; }
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(IDB_STORE)) {
        req.result.createObjectStore(IDB_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('本地存储打开失败'));
  });
}

async function idbPut(key, value) {
  const db = await openIdb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('本地写入失败'));
  });
}

async function idbGet(key) {
  const db = await openIdb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readonly');
    const req = tx.objectStore(IDB_STORE).get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function idbDelete(key) {
  const db = await openIdb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbKeys() {
  const db = await openIdb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readonly');
    const req = tx.objectStore(IDB_STORE).getAllKeys();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

/* 图片引用格式：local:<key>（IndexedDB）或 data:...（内联，兼容历史数据） */
function isDataUrl(v) {
  return typeof v === 'string' && v.startsWith('data:');
}

function imgKeyOf(ref) {
  return typeof ref === 'string' && ref.startsWith('local:') ? ref.slice(6) : null;
}

/* 保存图片到 IndexedDB，返回本地引用（同时写入 objectURL 缓存，保证上传后立即可读） */
async function saveImage(blob, key) {
  await idbPut(key, blob);
  const ref = `local:${key}`;
  urlCache.set(ref, URL.createObjectURL(blob));
  return ref;
}

/* ---------- 全局状态 ---------- */
let polishes = [];
let currentView = 'dashboard';
const filters = { search: '', brand: '', series: '', family: '', sort: 'newest' };
const urlCache = new Map(); // local:<key> -> objectURL
const charts = {};          // chart name -> Chart 实例
const query = { brand: '', series: '', family: '', status: '' }; // 看板多条件筛选

const stockin = { mode: 'create', editingId: null, editingRecord: null, families: [], rows: [], screenshotBlob: null, screenshotKey: null, screenshotName: '' };
let sellingId = null;
/* 试色图弹窗状态：existing=已保存引用，newBlobs=待上传 {blob,url}，removed=待删除的旧引用 */
const realcolor = { targetId: null, existing: [], newBlobs: [], removed: [] };
/* 试色图查看器状态 */
const imageview = { refs: [], index: 0 };
let confirmCallback = null;
let recognizeItems = []; // AI 识别出的多商品列表（逐项确认后统一入库）

/* 统一读取色系列表：优先新字段 color_families（数组，多选），兼容旧字段 color_family（单值） */
function familiesOf(p) {
  if (!p) return [];
  if (Array.isArray(p.color_families)) {
    const list = p.color_families.map((s) => String(s || '').trim()).filter(Boolean);
    if (list.length) return list;
  }
  if (p.color_family) return [String(p.color_family).trim()].filter(Boolean);
  return [];
}

/* 试色图最多上传张数 */
const MAX_REALCOLOR_IMAGES = 5;
/* 手动入库多行录入：一次最多添加的行数（每行可再填数量，总量不限） */
const MAX_STOCKIN_ROWS = 20;
let stockinRowSeq = 0;

/* 统一读取试色图列表：优先新字段 real_color_images（数组），兼容旧字段 real_color_image（单值） */
function realColorImages(p) {
  if (!p) return [];
  if (Array.isArray(p.real_color_images)) {
    return p.real_color_images.filter(Boolean);
  }
  if (p.real_color_image) return [p.real_color_image];
  return [];
}

/* ============================================================
 * 工具函数
 * ============================================================ */
const $ = (id) => document.getElementById(id);

function esc(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const moneyFmt = new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'CNY', minimumFractionDigits: 2, maximumFractionDigits: 2 });
function fmtMoney(n) {
  const v = Number(n);
  return moneyFmt.format(Number.isFinite(v) ? v : 0);
}

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function isHexColor(v) {
  return typeof v === 'string' && /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(v.trim());
}

function normalizeHex(v) {
  if (!isHexColor(v)) return '';
  let h = v.trim().toLowerCase();
  if (h.length === 4) h = '#' + h[1] + h[1] + h[2] + h[2] + h[3] + h[3];
  return h;
}

function readableTextColor(hex) {
  const h = normalizeHex(hex);
  if (!h) return '#ffffff';
  const r = parseInt(h.slice(1, 3), 16);
  const g = parseInt(h.slice(3, 5), 16);
  const b = parseInt(h.slice(5, 7), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.62 ? '#3a2c33' : '#ffffff';
}

function num(v) {
  // 空串 / null / undefined 一律视为未填写（Number('') === 0，不能当成 0 元）
  if (v === null || v === undefined) return null;
  if (typeof v === 'string' && v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function toast(message, type = 'info', duration = 2800) {
  const root = $('toast-root');
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.textContent = message;
  root.appendChild(el);
  setTimeout(() => {
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 300);
  }, duration);
}

function openModal(id) { $(id).classList.remove('hidden'); }
function closeModal(id) { $(id).classList.add('hidden'); }

/* 数据录入类模态框：只允许通过按钮关闭，点遮罩不关
 * （防止误触 / 手机文件选择器返回后的残留点击丢失录入进度） */
const NO_OVERLAY_CLOSE = new Set(['modal-stockin', 'modal-sell', 'modal-realcolor', 'modal-families']);

/* 文件选择器关闭的时间戳：部分移动浏览器会在选完图后派发一次“残留”click */
let lastFilePickAt = 0;
function markFilePick() { lastFilePickAt = Date.now(); }

/* ============================================================
 * 图片处理（压缩 / 转码）
 * ============================================================ */
function resizeImage(file, maxSize, quality) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const objectUrl = URL.createObjectURL(file);
    img.onload = () => {
      try {
        let { width, height } = img;
        const scale = Math.min(1, maxSize / Math.max(width, height));
        width = Math.max(1, Math.round(width * scale));
        height = Math.max(1, Math.round(height * scale));
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);
        canvas.toBlob(
          (blob) => (blob ? resolve(blob) : reject(new Error('图片处理失败'))),
          'image/jpeg',
          quality
        );
      } catch (err) {
        reject(err);
      } finally {
        URL.revokeObjectURL(objectUrl);
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error('图片读取失败，请更换图片重试'));
    };
    img.src = objectUrl;
  });
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('图片转换失败'));
    reader.readAsDataURL(blob);
  });
}

function dataUrlToBlob(dataUrl) {
  const [head, body] = dataUrl.split(',');
  const mime = (head.match(/data:([^;]+)/) || [, 'image/jpeg'])[1];
  const bin = atob(body);
  const len = bin.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

/* ============================================================
 * 数据层（本地）
 * ============================================================ */
async function loadPolishes() {
  const s = readStore();
  polishes = s.records.slice().sort((a, b) => (b.id || 0) - (a.id || 0));
  await loadImageCache();
  migrateLegacyFamiliesOnce(); // 历史记录里的自定义色系补进标签表（一次性）
  refreshFilterOptions();
  renderCurrentView();
  hydrateImages(document);
}

async function insertPolish(row) {
  const s = readStore();
  const id = ++s.seq;
  const rec = { ...row, id, created_at: new Date().toISOString() };
  s.records.push(rec);
  writeStore(s);
  return rec;
}

async function updatePolish(id, fields) {
  const s = readStore();
  const rec = s.records.find((r) => String(r.id) === String(id));
  if (!rec) throw new Error('记录不存在');
  Object.assign(rec, fields);
  writeStore(s);
  return rec;
}

async function deletePolish(id) {
  const s = readStore();
  const idx = s.records.findIndex((r) => String(r.id) === String(id));
  if (idx === -1) throw new Error('记录不存在');
  const [rec] = s.records.splice(idx, 1);
  writeStore(s);
  return rec;
}

/* 读取 IndexedDB 中所有被引用的图片，生成本地 objectURL 缓存 */
async function loadImageCache() {
  const refs = new Set();
  polishes.forEach((p) => {
    // 截图数据保留（UI 不再展示），缓存仍加载，保证备份导出等场景可读
    [p.purchase_screenshot, ...realColorImages(p)].forEach((ref) => {
      const key = imgKeyOf(ref);
      if (key) refs.add(key);
    });
  });
  for (const key of refs) {
    if (urlCache.has(`local:${key}`)) continue;
    try {
      const blob = await idbGet(key);
      if (blob) urlCache.set(`local:${key}`, URL.createObjectURL(blob));
    } catch (e) { /* 单张读取失败不影响其他图片 */ }
  }
}

function imgUrl(ref) {
  if (!ref) return '';
  if (isDataUrl(ref)) return ref;
  const key = imgKeyOf(ref);
  if (key) return urlCache.get(`local:${key}`) || '';
  return urlCache.get(ref) || '';
}

/* 渲染后把 <img data-img="引用"> 的 src 从本地存储填充 */
async function hydrateImages(root) {
  const els = (root || document).querySelectorAll('img[data-img]');
  for (const el of els) {
    const url = imgUrl(el.dataset.img);
    if (url && el.getAttribute('src') !== url) el.setAttribute('src', url);
  }
}

/* 删除记录时清理其引用的本地图片 */
async function removeImageRefs(refs) {
  for (const ref of refs || []) {
    const key = imgKeyOf(ref);
    if (!key) continue;
    urlCache.delete(`local:${key}`);
    try { await idbDelete(key); } catch (e) { /* 忽略清理失败 */ }
  }
}

/* ============================================================
 * LLM：购买截图识别（匿名调用，截图仅用于提取信息）
 * ============================================================ */
async function pickVisionModel() {
  const models = (await cloud.llm.models.list()) || [];
  const usable = models.filter((m) => m.disabled !== true);
  const vision = usable.filter((m) => m.supportsImages === true);
  for (const id of VISION_PREFERENCE) {
    const found = vision.find((m) => m.id === id);
    if (found) return found;
  }
  const anyVision = vision.find((m) => m.id !== 'auto');
  if (anyVision) return anyVision;
  return usable[0] || null;
}

function extractJson(text) {
  if (!text) return null;
  let t = String(text).trim();
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;
  try {
    return JSON.parse(t.slice(start, end + 1));
  } catch (e) {
    return null;
  }
}

async function recognizeScreenshot(file) {
  const model = await pickVisionModel();
  if (!model) throw new Error('暂无可用的识别模型，请改用手动录入');
  const blob = await resizeImage(file, 1024, 0.82);
  const dataUrl = await blobToDataUrl(blob);
  let answer = '';
  for await (const chunk of cloud.llm.chat.completions.create({
    model: model.id,
    stream: true,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: RECOGNIZE_SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          { type: 'text', text: '请提取这张购买截图中的甲油信息；若含多个商品，请逐项分别列出。' },
          { type: 'image_url', image_url: { url: dataUrl } },
        ],
      },
    ],
  })) {
    const delta = chunk.choices && chunk.choices[0] && chunk.choices[0].delta;
    if (delta && delta.content) answer += delta.content;
  }
  return extractJson(answer);
}

/* ============================================================
 * 视图：工作台
 * ============================================================ */
function computeStats() {
  const inStock = polishes.filter((p) => p.status !== 'sold');
  const sold = polishes.filter((p) => p.status === 'sold');
  const sum = (arr, key) => arr.reduce((s, p) => s + (Number(p[key]) || 0), 0);
  return {
    total: polishes.length,
    inStockCount: inStock.length,
    soldCount: sold.length,
    stockValue: sum(inStock, 'purchase_price'),
    soldTotal: sum(sold, 'sale_price'),
    totalSpend: sum(polishes, 'purchase_price'),
    brandCount: new Set(polishes.map((p) => (p.brand || '').trim().toLowerCase()).filter(Boolean)).size,
  };
}

function profitClass(v) {
  if (v > 0) return 'profit-pos';
  if (v < 0) return 'profit-neg';
  return 'profit-zero';
}

function renderDashboard() {
  const view = $('view-dashboard');
  if (!polishes.length) {
    view.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon"></div>
        <p>还没有任何甲油记录<br>点击下方按钮，上传购买截图开始入库</p>
        <button class="btn-primary" type="button" data-action="open-stockin">上传截图入库</button>
      </div>`;
    return;
  }

  const s = computeStats();
  const kpis = [
    { label: '库存瓶数', value: s.inStockCount, unit: '瓶', note: `共记录 ${s.total} 瓶` },
    { label: '已售瓶数', value: s.soldCount, unit: '瓶', note: `占总量 ${s.total ? Math.round((s.soldCount / s.total) * 100) : 0}%` },
    { label: '库存总值', value: fmtMoney(s.stockValue), note: '按购入价计' },
    { label: '售出总额', value: fmtMoney(s.soldTotal), note: '累计回款' },
    { label: '购物总花费', value: fmtMoney(s.totalSpend), note: `${s.brandCount} 个品牌` },
  ];

  view.innerHTML = `
    <div class="kpi-grid">
      ${kpis.map((k) => `
        <div class="kpi-card">
          <div class="kpi-label">${esc(k.label)}</div>
          <div class="kpi-value ${k.cls || ''}">${esc(k.value)}${k.unit ? `<small>${esc(k.unit)}</small>` : ''}</div>
          <div class="kpi-note">${esc(k.note)}</div>
        </div>`).join('')}
    </div>
    <div class="dashboard-row">
      <div class="chart-card">
        <div class="chart-title">品牌分布（按瓶数）</div>
        <div class="chart-box"><canvas id="chart-brand"></canvas></div>
      </div>
      <div class="panel query-panel">
        <div class="panel-title">条件查账</div>
        <div class="query-grid">
          <label class="field">
            <span class="field-label">品牌</span>
            <select id="query-brand" class="toolbar-select"></select>
          </label>
          <label class="field">
            <span class="field-label">系列</span>
            <select id="query-series" class="toolbar-select"></select>
          </label>
          <label class="field">
            <span class="field-label">色系</span>
            <select id="query-family" class="toolbar-select"></select>
          </label>
          <label class="field">
            <span class="field-label">状态</span>
            <select id="query-status" class="toolbar-select">
              <option value="">全部</option>
              <option value="in_stock">库存中</option>
              <option value="sold">已售出</option>
            </select>
          </label>
        </div>
        <div id="query-result" class="query-result"></div>
      </div>
    </div>
    <div class="panel">
      <div class="panel-title">最近动态</div>
      <div class="activity-list">${renderActivity()}</div>
    </div>`;

  fillQuerySelects();
  applyQuery();
  renderCharts();
  hydrateImages(view);
}

/* ---------- 多条件筛选（条件查账） ---------- */
function fillQuerySelects() {
  const brands = distinctValues('brand');
  const series = query.brand
    ? distinctValues('series').filter((s) => polishes.some((p) => (p.brand || '').trim().toLowerCase() === query.brand.toLowerCase() && (p.series || '') === s))
    : distinctValues('series');
  const families = distinctFamilyValues();
  fillSelect($('query-brand'), brands, query.brand, '全部品牌');
  fillSelect($('query-series'), series, query.series, '全部系列');
  fillSelect($('query-family'), families, query.family, '全部色系');
}

/* 色系下拉取值：多选色系摊平去重后排序 */
function distinctFamilyValues() {
  const set = new Set();
  polishes.forEach((p) => familiesOf(p).forEach((f) => set.add(f)));
  return [...set].sort((a, b) => a.localeCompare(b, 'zh'));
}

function distinctValues(key) {
  return [...new Set(polishes.map((p) => (p[key] || '').trim()).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, 'zh'));
}

function getFilteredByQuery() {
  return polishes.filter((p) => {
    if (query.brand && (p.brand || '').trim().toLowerCase() !== query.brand.toLowerCase()) return false;
    if (query.series && (p.series || '') !== query.series) return false;
    if (query.family && !familiesOf(p).includes(query.family)) return false;
    if (query.status && p.status !== query.status) return false;
    return true;
  });
}

function applyQuery() {
  const list = getFilteredByQuery();
  const sum = (key) => list.reduce((s, p) => s + (Number(p[key]) || 0), 0);
  const spend = sum('purchase_price');
  const soldTotal = sum('sale_price');
  const soldCost = list.filter((p) => p.status === 'sold').reduce((s, p) => s + (Number(p.purchase_price) || 0), 0);
  const profit = soldTotal - soldCost;
  const scope = [query.brand, query.series, query.family, query.status === 'in_stock' ? '库存中' : query.status === 'sold' ? '已售出' : '']
    .filter(Boolean).join(' · ') || '全部甲油';
  $('query-result').innerHTML = `
    <div class="query-scope">${esc(scope)}</div>
    <div class="query-stats">
      <div class="query-stat"><span>瓶数</span><b>${list.length} 瓶</b></div>
      <div class="query-stat"><span>购物花费</span><b>${fmtMoney(spend)}</b></div>
      <div class="query-stat"><span>售出总额</span><b>${fmtMoney(soldTotal)}</b></div>
      <div class="query-stat"><span>利润</span><b class="${profitClass(profit)}">${profit > 0 ? '+' : ''}${fmtMoney(profit)}</b></div>
    </div>`;
}

function renderActivity() {
  const events = [];
  for (const p of polishes) {
    events.push({ type: 'in', date: p.created_at, item: p });
    if (p.status === 'sold') events.push({ type: 'out', date: p.sale_date || p.created_at, item: p });
  }
  events.sort((a, b) => new Date(b.date) - new Date(a.date));
  return events
    .slice(0, 6)
    .map((e) => {
      const p = e.item;
      const imgs = realColorImages(p);
      const img = imgUrl(imgs[0]);
      const thumb = img
        ? `<img data-img="${esc(imgs[0])}" alt="">`
        : `<span>${esc((p.color_code || p.color_name || '').slice(0, 4))}</span>`;
      const amount = e.type === 'in' ? fmtMoney(p.purchase_price) : fmtMoney(p.sale_price);
      const sub = e.type === 'in'
        ? `${esc(p.brand || '')}${p.series ? ' · ' + esc(p.series) : ''}${p.purchase_channel ? ' · ' + esc(p.purchase_channel) : ''}`
        : `${esc(p.sale_channel || '售出')} · 购入价 ${fmtMoney(p.purchase_price)}`;
      return `
        <div class="activity-row">
          <div class="activity-thumb">${thumb}</div>
          <div class="activity-info">
            <div class="activity-name">${esc(p.color_code || p.color_name || '未命名')}</div>
            <div class="activity-sub">${sub}</div>
          </div>
          <span class="activity-tag ${e.type}">${e.type === 'in' ? '入库' : '售出'}</span>
          <span class="activity-amount">${esc(amount)}</span>
        </div>`;
    })
    .join('');
}

function renderCharts() {
  if (typeof Chart === 'undefined') return;

  Object.values(charts).forEach((c) => c.destroy());
  charts.brand = null;

  Chart.defaults.font.family = '-apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif';
  Chart.defaults.font.size = 11;
  Chart.defaults.color = '#8b7a81';

  // 品牌分布（按瓶数，Top 8，横向条形图；大小写不同的同一品牌归并显示）
  const brandMap = new Map();
  polishes.forEach((p) => {
    const b = (p.brand || '').trim() || '未填写';
    const k = b.toLowerCase();
    const entry = brandMap.get(k) || { label: b, count: 0 };
    entry.count += 1;
    brandMap.set(k, entry);
  });
  const brandEntries = [...brandMap.values()].sort((a, b) => b.count - a.count).slice(0, 8);
  charts.brand = new Chart($('chart-brand'), {
    type: 'bar',
    data: {
      labels: brandEntries.map((e) => e.label),
      datasets: [{
        data: brandEntries.map((e) => e.count),
        backgroundColor: brandEntries.map((_, i) => CHART_COLORS[i % CHART_COLORS.length]),
        borderRadius: 6,
        barThickness: 14,
      }],
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: (ctx) => ` ${ctx.parsed.x} 瓶` } } },
      scales: {
        x: { beginAtZero: true, ticks: { precision: 0 }, grid: { color: '#f3e4ea' } },
        y: { grid: { display: false } },
      },
    },
  });
}

/* ============================================================
 * 视图：库存 / 已售出
 * ============================================================ */
function mediaHtml(p) {
  const imgs = realColorImages(p);
  const ref = imgs[0];
  if (ref) {
    const url = imgUrl(ref);
    if (url) {
      const more = imgs.length > 1
        ? `<span class="media-multi" title="共 ${imgs.length} 张试色图">+${imgs.length - 1}</span>`
        : '';
      return `<img data-img="${esc(ref)}" src="${esc(url)}" alt="${esc(p.color_code || p.color_name || '')}" loading="lazy">${more}`;
    }
  }
  const hex = normalizeHex(p.color_hex);
  if (hex) {
    return `<div class="media-fallback" style="background:${esc(hex)};color:${readableTextColor(hex)}">
      <span class="fallback-code">${esc(p.color_code || p.color_name || '')}</span>
      <span class="fallback-hint" style="text-shadow:none;opacity:.75">未上传试色图</span>
    </div>`;
  }
  return `<div class="media-none">暂无试色图</div>`;
}

/* 库存卡片标题：品牌 · 系列 · 色号（跳过空值，不显示颜色名） */
function cardTitle(p) {
  return [p.brand || '未知品牌', p.series, p.color_code].filter(Boolean).map(esc).join(' · ');
}

/* ============================================================
 * 重复甲油检测：录入时实时核验 + 在库多瓶提示
 * ============================================================ */
/* 归一化色号用于比对：忽略大小写、空格与常见分隔符（Le-80 ≡ le80） */
function normalizeCode(v) {
  return String(v || '').toLowerCase().replace(/[\s\-_.\/]/g, '');
}

/* 同一款甲油判定：品牌相同，且色号相同（两边都无色号时退化为系列相同） */
function isSamePolish(a, b) {
  const ba = (a.brand || '').trim().toLowerCase();
  const bb = (b.brand || '').trim().toLowerCase();
  if (!ba || ba !== bb) return false;
  const ca = normalizeCode(a.color_code);
  const cb = normalizeCode(b.color_code);
  if (ca || cb) return !!ca && ca === cb;
  const sa = (a.series || '').trim().toLowerCase();
  const sb = (b.series || '').trim().toLowerCase();
  return !!sa && sa === sb;
}

/* 在库（或指定范围）中与草稿匹配的甲油；excludeId 用于编辑时排除自身 */
function findPolishDuplicates(draft, scope, excludeId) {
  if (!draft || !(draft.brand || '').trim()) return [];
  const list = scope || polishes.filter((p) => p.status !== 'sold');
  return list.filter((p) => String(p.id) !== String(excludeId) && isSamePolish(p, draft));
}

/* 在库同款分组键（用于统计同款瓶数） */
function polishDupKey(p) {
  const brand = (p.brand || '').trim().toLowerCase();
  if (!brand) return '';
  const code = normalizeCode(p.color_code);
  return code ? `${brand}::${code}` : `${brand}::series:${(p.series || '').trim().toLowerCase()}`;
}

/* 在库同款甲油画像：key → 瓶数 */
function inStockDupCounts() {
  const counts = new Map();
  polishes.forEach((p) => {
    if (p.status === 'sold') return;
    const key = polishDupKey(p);
    if (!key) return;
    counts.set(key, (counts.get(key) || 0) + 1);
  });
  return counts;
}

/* 重复提示文案（录入实时提示与确认弹窗共用） */
function dupWarningText(matches) {
  if (!matches.length) return '';
  const names = matches.slice(0, 3).map((p) => [p.brand, p.series, p.color_code].filter(Boolean).join(' · '));
  const more = matches.length > 3 ? ` 等 ${matches.length} 瓶` : '';
  return `库存中已有相同甲油：${names.join('；')}${more}。如确为购入多瓶可继续入库；如为重复录入，请返回修改。`;
}

function renderInventory() {
  const list = getFilteredInventory();
  const grid = $('inventory-grid');
  if (!list.length) {
    grid.innerHTML = '';
    grid.insertAdjacentHTML('beforeend', `
      <div class="empty-state" style="grid-column:1/-1">
        <div class="empty-icon"></div>
        <p>${polishes.some((p) => p.status !== 'sold') ? '没有符合筛选条件的库存甲油' : '库存为空，点击右上角「入库」添加第一瓶甲油'}</p>
      </div>`);
    return;
  }
  // 同款瓶数统计（按全部在库计算，不受当前筛选影响）
  const dupCounts = inStockDupCounts();
  grid.innerHTML = list.map((p) => {
    const dupN = dupCounts.get(polishDupKey(p)) || 0;
    const dupBadge = dupN > 1
      ? `<span class="dup-badge" title="库存中有 ${dupN} 瓶相同甲油">× ${dupN} 瓶</span>`
      : '';
    const dupHint = dupN > 1
      ? `<div class="polish-dup-hint">库存中有 ${dupN} 瓶相同甲油</div>`
      : '';
    return `
    <article class="polish-card">
      <div class="polish-media" data-action="view-image" data-id="${p.id}" role="button" tabindex="0" title="点击查看图片">
        ${mediaHtml(p)}
        ${dupBadge}
        <span class="status-badge in">库存中</span>
      </div>
      <div class="polish-body">
        <div class="polish-brand">${cardTitle(p)}</div>
        ${dupHint}
        ${(p.purchase_price !== null && p.purchase_price !== undefined) || p.purchase_date ? `
        <div class="polish-price-row">
          ${(p.purchase_price !== null && p.purchase_price !== undefined) ? `<span class="polish-price">${fmtMoney(p.purchase_price)}</span><span class="polish-price-label">购入价</span>` : ''}
          <span class="polish-date">${esc(p.purchase_date || '')}</span>
        </div>` : ''}
        <div class="polish-actions">
          <button class="action-btn primary" type="button" data-action="sell" data-id="${p.id}">售出</button>
          <button class="action-btn" type="button" data-action="realcolor" data-id="${p.id}">试色图</button>
          <button class="action-btn" type="button" data-action="edit" data-id="${p.id}">编辑</button>
          <button class="action-btn danger" type="button" data-action="delete" data-id="${p.id}">删除</button>
        </div>
      </div>
    </article>`;
  }).join('');
  hydrateImages(grid);
}

function getFilteredInventory() {
  let list = polishes.filter((p) => p.status !== 'sold');
  const q = filters.search.trim().toLowerCase();
  if (q) {
    list = list.filter((p) =>
      [p.brand, p.series, p.color_name, p.color_code, ...familiesOf(p)].some((v) => (v || '').toLowerCase().includes(q))
    );
  }
  if (filters.brand) list = list.filter((p) => (p.brand || '').trim().toLowerCase() === filters.brand.toLowerCase());
  if (filters.series) list = list.filter((p) => (p.series || '') === filters.series);
  if (filters.family) list = list.filter((p) => familiesOf(p).includes(filters.family));
  const byNewest = (a, b) => (b.id || 0) - (a.id || 0);
  switch (filters.sort) {
    case 'price-desc':
      list.sort((a, b) => (Number(b.purchase_price) || 0) - (Number(a.purchase_price) || 0));
      break;
    case 'price-asc':
      list.sort((a, b) => (Number(a.purchase_price) || 0) - (Number(b.purchase_price) || 0));
      break;
    case 'brand':
      list.sort((a, b) => (a.brand || '').localeCompare(b.brand || '', 'zh') || (a.color_code || '').localeCompare(b.color_code || '', 'zh'));
      break;
    default:
      list.sort(byNewest);
  }
  return list;
}

function renderSold() {
  const list = polishes
    .filter((p) => p.status === 'sold')
    .sort((a, b) => new Date(b.sale_date || b.created_at) - new Date(a.sale_date || a.created_at));
  const grid = $('sold-grid');
  if (!list.length) {
    grid.innerHTML = `
      <div class="empty-state" style="grid-column:1/-1">
        <div class="empty-icon"></div>
        <p>还没有售出记录，库存甲油可以在「库存」页登记售出</p>
      </div>`;
    return;
  }
  grid.innerHTML = list.map((p) => {
    const hasCost = p.purchase_price !== null && p.purchase_price !== undefined;
    const profit = hasCost ? (Number(p.sale_price) || 0) - (Number(p.purchase_price) || 0) : null;
    return `
    <article class="polish-card">
      <div class="polish-media" data-action="view-image" data-id="${p.id}" role="button" tabindex="0" title="点击查看图片">
        ${mediaHtml(p)}
        <span class="status-badge out">已售出</span>
      </div>
      <div class="polish-body">
        <div class="polish-brand">${cardTitle(p)}</div>
        <div class="polish-sale">
          <div class="sale-line"><span>购入价</span><b>${hasCost ? fmtMoney(p.purchase_price) : '未记录'}</b></div>
          <div class="sale-line"><span>售出渠道</span><b>${esc(p.sale_channel || '未填写')}</b></div>
          <div class="sale-line"><span>售价</span><b>${fmtMoney(p.sale_price)}</b></div>
          <div class="sale-line"><span>利润</span><b class="${profit === null ? '' : profitClass(profit)}">${profit === null ? '—' : (profit > 0 ? '+' : '') + fmtMoney(profit)}</b></div>
          <div class="sale-line"><span>售出日期</span><b>${esc(p.sale_date || '')}</b></div>
        </div>
        <div class="polish-actions">
          <button class="action-btn" type="button" data-action="revert" data-id="${p.id}">撤回售出</button>
          <button class="action-btn danger" type="button" data-action="delete" data-id="${p.id}">删除</button>
        </div>
      </div>
    </article>`;
  }).join('');
  hydrateImages(grid);
}

/* ============================================================
 * 视图：色卡
 * ============================================================ */
function renderPalette() {
  const view = $('view-palette');
  if (!polishes.length) {
    view.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon"></div>
        <p>还没有颜色，入库后即可在这里管理试色图</p>
      </div>`;
    return;
  }
  const groups = new Map();
  polishes.forEach((p) => {
    const brand = (p.brand || '').trim() || '未填写品牌';
    if (!groups.has(brand)) groups.set(brand, []);
    groups.get(brand).push(p);
  });
  const sortedBrands = [...groups.keys()].sort((a, b) => a.localeCompare(b, 'zh'));

  view.innerHTML = `
    <div class="palette-hint">点击任意色块即可上传或更换试色图；绿点表示库存中，灰点表示已售出。</div>
    ${sortedBrands.map((brand) => {
      const items = groups.get(brand).slice().sort((a, b) => (a.color_code || a.color_name || '').localeCompare(b.color_code || b.color_name || '', 'zh'));
      return `
      <section class="palette-group">
        <div class="palette-group-head">
          <span class="palette-group-name">${esc(brand)}</span>
          <span class="palette-group-count">${items.length} 色</span>
        </div>
        <div class="palette-grid">
          ${items.map((p) => {
            const imgs = realColorImages(p);
            const ref = imgs[0];
            const url = imgUrl(ref);
            const hex = normalizeHex(p.color_hex);
            const media = url
              ? `<img data-img="${esc(ref)}" src="${esc(url)}" alt="${esc(p.color_code || p.color_name || '')}" loading="lazy">`
              : hex
                ? `<div class="swatch-fill" style="background:${esc(hex)}"></div>`
                : `<div class="swatch-none">未设置颜色</div>`;
            return `
            <button class="swatch" type="button" data-action="realcolor" data-id="${p.id}" title="点击上传试色图">
              <div class="swatch-media">
                ${media}
                <span class="swatch-dot ${p.status === 'sold' ? 'out' : 'in'}"></span>
                <span class="swatch-upload">${url ? '更换试色图' : '上传试色图'}</span>
              </div>
              <div class="swatch-body">
                <div class="swatch-name">${esc(p.color_code || p.color_name || '未命名')}</div>
                <div class="swatch-code">${esc(familiesOf(p).join(' / ') || p.series || '')}</div>
              </div>
            </button>`;
          }).join('')}
        </div>
      </section>`;
    }).join('')}`;
  hydrateImages(view);
}

/* ============================================================
 * 视图切换与筛选
 * ============================================================ */
function switchView(name) {
  currentView = name;
  document.querySelectorAll('.nav-tab').forEach((tab) => {
    tab.classList.toggle('active', tab.dataset.view === name);
  });
  ['dashboard', 'inventory', 'sold', 'palette'].forEach((v) => {
    $('view-' + v).classList.toggle('hidden', v !== name);
  });
  renderCurrentView();
}

function renderCurrentView() {
  if (currentView === 'dashboard') renderDashboard();
  else if (currentView === 'inventory') renderInventory();
  else if (currentView === 'sold') renderSold();
  else if (currentView === 'palette') renderPalette();
}

function refreshFilterOptions() {
  const brands = distinctValues('brand');
  const series = distinctValues('series');
  const families = distinctFamilyValues();
  fillSelect($('filter-brand'), brands, filters.brand, '全部品牌');
  fillSelect($('filter-series'), series, filters.series, '全部系列');
  fillSelect($('filter-family'), families, filters.family, '全部色系');
  $('brand-suggestions').innerHTML = brands.map((b) => `<option value="${esc(b)}">`).join('');
}

function fillSelect(select, values, current, allLabel) {
  select.innerHTML = `<option value="">${esc(allLabel)}</option>` +
    values.map((v) => `<option value="${esc(v)}"${v === current ? ' selected' : ''}>${esc(v)}</option>`).join('');
}

/* 批量栏色系下拉（默认标签 + 自定义标签 + 自定义入口） */
function fillBatchFamilyOptions() {
  const sel = $('batch-family');
  if (!sel) return;
  sel.innerHTML = '<option value="">色系，应用到全部</option>' +
    allFamilies().map((f) => `<option value="${esc(f)}">${esc(f)}</option>`).join('') +
    '<option value="__custom__">＋ 自定义…</option>';
}

/* ============================================================
 * 入库 / 编辑模态框
 * ============================================================ */
function setVal(id, value) { $(id).value = value === null || value === undefined ? '' : value; }
function getVal(id) { return $(id).value.trim(); }

/* 录入表单色系 chips（多选）：selected 为已选数组，onPick 负责切换 */
function renderFamilyChips(container, selected, onPick) {
  const sel = (selected || []).filter(Boolean);
  const customSel = sel.filter((f) => !allFamilies().includes(f));
  container.innerHTML = `
    <div class="family-chips-row">
      ${allFamilies().map((f) =>
    `<button type="button" class="family-chip${sel.includes(f) ? ' active' : ''}" data-family="${esc(f)}">${esc(f)}</button>`
  ).join('')}
      ${customSel.map((f) => `<button type="button" class="family-chip active" data-family="${esc(f)}">${esc(f)}</button>`).join('')}
      <button type="button" class="family-chip family-chip-add" data-custom="1" title="自定义色系">＋ 自定义</button>
    </div>
    <div class="family-custom-row hidden">
      <input type="text" class="family-custom-input" maxlength="12" placeholder="输入色系名称，如：玫红、裸粉">
      <button type="button" class="family-chip family-chip-ok" data-custom-save="1">确定</button>
    </div>`;
  container.querySelectorAll('.family-chip[data-family]').forEach((chip) => {
    chip.addEventListener('click', () => onPick(chip.dataset.family));
  });
  const customRow = container.querySelector('.family-custom-row');
  const input = container.querySelector('.family-custom-input');
  const commit = () => {
    const v = input.value.trim();
    if (!v) { toast('请输入色系名称', 'error'); return; }
    // 新标签写入标签表持久化，下次可直接选择
    if (!ensureFamilyTag(v)) { toast('色系名称最多 12 个字', 'error'); return; }
    fillBatchFamilyOptions();
    customRow.classList.add('hidden');
    input.value = '';
    if (sel.includes(v)) return; // 已选中：仅收起，不取消选中
    onPick(v);
  };
  container.querySelector('[data-custom]').addEventListener('click', () => {
    customRow.classList.remove('hidden');
    input.value = customSel[0] || '';
    input.focus();
  });
  container.querySelector('[data-custom-save]').addEventListener('click', commit);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } });
}

function resetStockinForm() {
  ['f-brand', 'f-series', 'f-color-code', 'f-price'].forEach((id) => setVal(id, ''));
  stockin.families = [];
  renderFamilyChips($('family-chips'), stockin.families, pickFamily);
  resetStockinRows();
  $('recognize-status').textContent = '';
  $('recognize-status').className = 'recognize-status';
  clearRecognizeResults();
  resetScreenshot();
  updateStockinDupHint();
}

/* 录入实时查重：品牌 + 色号（/系列）与在库甲油比对，命中即显示提示条 */
function updateStockinDupHint() {
  const hint = $('stockin-dup-hint');
  if (!hint) return;
  const matches = findPolishDuplicates({
    brand: getVal('f-brand'),
    series: getVal('f-series'),
    color_code: getVal('f-color-code'),
  }, null, stockin.editingId);
  if (!matches.length) {
    hint.classList.add('hidden');
    hint.textContent = '';
    return;
  }
  hint.textContent = dupWarningText(matches);
  hint.classList.remove('hidden');
}

function resetScreenshot() {
  stockin.screenshotBlob = null;
  stockin.screenshotKey = null;
  stockin.screenshotName = '';
  $('file-screenshot').value = '';
  $('screenshot-preview').classList.add('hidden');
  $('dropzone').classList.remove('hidden');
}

/* ============================================================
 * 手动入库 · 多行批量录入（新建模式）
 * 每行一张卡片：品牌 / 系列 / 色号 / 购买金额 / 数量 / 色系（多选）
 * 行数上限 MAX_STOCKIN_ROWS，每行数量不限（一瓶一记录，可分别售出/编辑）
 * ============================================================ */
function newStockinRow() {
  stockinRowSeq += 1;
  return { uid: stockinRowSeq, brand: '', series: '', color_code: '', price: '', qty: '1', families: [] };
}

function resetStockinRows() {
  stockin.rows = [newStockinRow()];
  renderStockinRows();
}

function stockinRowHtml(item, index) {
  const canDel = stockin.rows.length > 1;
  return `
  <div class="stockin-row" data-uid="${item.uid}">
    <div class="stockin-row-head">
      <span class="stockin-row-no">第 ${index + 1} 项</span>
      ${canDel ? `<button type="button" class="stockin-row-del" data-del="${item.uid}" title="删除本项">×</button>` : ''}
    </div>
    <div class="stockin-row-grid">
      <label class="field">
        <span class="field-label">品牌 *</span>
        <input type="text" data-f="brand" value="${esc(item.brand)}" placeholder="如：品牌名称" list="brand-suggestions">
      </label>
      <label class="field">
        <span class="field-label">系列（选填）</span>
        <input type="text" data-f="series" value="${esc(item.series)}" placeholder="如：系列名称">
      </label>
      <label class="field">
        <span class="field-label">色号（选填）</span>
        <input type="text" data-f="color_code" value="${esc(item.color_code)}" placeholder="如：色号">
      </label>
      <label class="field">
        <span class="field-label">购买金额（¥）*</span>
        <input type="number" min="0" step="0.01" data-f="price" value="${esc(item.price)}" placeholder="0.00">
      </label>
      <label class="field">
        <span class="field-label">数量（瓶）</span>
        <input type="number" min="1" step="1" data-f="qty" value="${esc(item.qty)}" placeholder="1">
      </label>
    </div>
    <div class="stockin-row-families">
      <div class="family-chips" data-families="${item.uid}"></div>
      <div class="row-dup-hint dup-hint hidden"></div>
    </div>
  </div>`;
}

function renderStockinRows() {
  const box = $('stockin-rows');
  if (!box) return;
  box.innerHTML = stockin.rows.map((it, i) => stockinRowHtml(it, i)).join('');
  // 每行色系 chips 独立渲染与切换；行内查重提示
  stockin.rows.forEach((item) => {
    const wrap = box.querySelector(`[data-families="${item.uid}"]`);
    if (wrap) renderFamilyChips(wrap, item.families, (f) => toggleRowFamily(item.uid, f));
    const rowEl = box.querySelector(`.stockin-row[data-uid="${item.uid}"]`);
    if (rowEl) updateRowDupHint(rowEl, item);
  });
  updateStockinRowsFoot();
}

function updateStockinRowsFoot() {
  const btn = $('btn-add-stockin-row');
  const hint = $('stockin-rows-hint');
  const left = MAX_STOCKIN_ROWS - stockin.rows.length;
  if (btn) btn.disabled = left <= 0;
  if (hint) {
    hint.textContent = left > 0
      ? `还可添加 ${left} 项（上限 ${MAX_STOCKIN_ROWS} 项）`
      : `已达上限 ${MAX_STOCKIN_ROWS} 项`;
  }
}

function addStockinRow() {
  if (stockin.rows.length >= MAX_STOCKIN_ROWS) {
    toast(`一次最多录入 ${MAX_STOCKIN_ROWS} 项`, 'error');
    return;
  }
  stockin.rows.push(newStockinRow());
  renderStockinRows();
  const box = $('stockin-rows');
  const last = box && box.lastElementChild;
  if (last) {
    const inp = last.querySelector('[data-f="brand"]');
    if (inp) inp.focus();
  }
}

function removeStockinRow(uid) {
  if (stockin.rows.length <= 1) return;
  stockin.rows = stockin.rows.filter((r) => r.uid !== uid);
  renderStockinRows();
}

/* 行内色系多选切换：只重渲染该行 chips，避免整表重建丢失输入焦点 */
function toggleRowFamily(uid, f) {
  const item = stockin.rows.find((r) => r.uid === uid);
  if (!item) return;
  const i = item.families.indexOf(f);
  if (i === -1) item.families.push(f);
  else item.families.splice(i, 1);
  const wrap = document.querySelector(`#stockin-rows [data-families="${uid}"]`);
  if (wrap) renderFamilyChips(wrap, item.families, (ff) => toggleRowFamily(uid, ff));
}

/* 行内实时查重：与在库甲油重复时在行内显示提示条 */
function updateRowDupHint(rowEl, item) {
  const hint = rowEl.querySelector('.row-dup-hint');
  if (!hint) return;
  const matches = findPolishDuplicates({
    brand: (item.brand || '').trim(),
    series: (item.series || '').trim(),
    color_code: (item.color_code || '').trim(),
  });
  if (!matches.length) {
    hint.classList.add('hidden');
    hint.textContent = '';
    return;
  }
  hint.textContent = dupWarningText(matches);
  hint.classList.remove('hidden');
}

function focusRowField(item, f) {
  const el = document.querySelector(`#stockin-rows .stockin-row[data-uid="${item.uid}"] [data-f="${f}"]`);
  if (el) el.focus();
}

/* 自愈：旧版 index.html（浏览器缓存旧入口文档）没有多行面板时动态创建，
 * 并清理旧版单表单里的数量字段（已由每行数量取代），
 * 避免「旧 HTML + 新 app.js」组合导致手动录入不可用。
 * 注意：面板若是本函数创建的，事件绑定也在此完成（自包含），
 * 不依赖 bindEvents 的时序——否则后调用的自愈会绑到已销毁的旧容器上。 */
function ensureStockinRowsPanel() {
  syncFamilyLabelMulti();
  const oldQty = $('stockin-qty-field');
  if (oldQty) oldQty.remove();
  if ($('stockin-rows-panel')) return;
  const grid = $('stockin-form-grid');
  if (!grid) return;
  const panel = document.createElement('div');
  panel.id = 'stockin-rows-panel';
  panel.className = 'stockin-rows-panel hidden';
  const rows = document.createElement('div');
  rows.id = 'stockin-rows';
  rows.className = 'stockin-rows';
  const foot = document.createElement('div');
  foot.className = 'stockin-rows-foot';
  const btn = document.createElement('button');
  btn.id = 'btn-add-stockin-row';
  btn.type = 'button';
  btn.className = 'btn-ghost btn-sm';
  btn.textContent = '＋ 添加一项';
  const hint = document.createElement('span');
  hint.id = 'stockin-rows-hint';
  hint.className = 'stockin-rows-hint';
  foot.appendChild(btn);
  foot.appendChild(hint);
  panel.appendChild(rows);
  panel.appendChild(foot);
  grid.parentNode.insertBefore(panel, grid.nextSibling);
  bindStockinRowsEvents();
}

/* 多行面板事件：添加按钮 + 行内委托（输入同步与行内查重 / 删除本项）。
 * 静态面板由 bindEvents 调用；自愈创建的面板由 ensureStockinRowsPanel 调用，两条路径互斥。 */
function bindStockinRowsEvents() {
  $('btn-add-stockin-row').addEventListener('click', addStockinRow);
  const rowsBox = $('stockin-rows');
  if (!rowsBox) return;
  rowsBox.addEventListener('input', (e) => {
    const row = e.target.closest('.stockin-row');
    if (!row) return;
    const uid = Number(row.dataset.uid);
    const item = stockin.rows.find((r) => r.uid === uid);
    const f = e.target.dataset.f;
    if (!item || !f) return;
    item[f] = e.target.value;
    if (f === 'brand' || f === 'series' || f === 'color_code') updateRowDupHint(row, item);
  });
  rowsBox.addEventListener('click', (e) => {
    const del = e.target.closest('[data-del]');
    if (del) removeStockinRow(Number(del.dataset.del));
  });
}

/* 旧版色系文案同步为多选表述 */
function syncFamilyLabelMulti() {
  const famLabel = document.querySelector('[data-page-node-id="fFam003"]');
  if (famLabel && famLabel.textContent.indexOf('点击选择') !== -1) {
    famLabel.textContent = famLabel.textContent.replace('点击选择', '可多选');
  }
}

function openStockinCreate() {
  stockin.mode = 'create';
  stockin.editingId = null;
  stockin.editingRecord = null;
  $('stockin-title').textContent = '甲油入库';
  $('btn-confirm-stockin').textContent = '确认入库';
  $('stockin-tabs').classList.remove('hidden');
  $('tab-ai').classList.remove('hidden');
  switchStockinTab('ai');
  resetStockinForm();
  openModal('modal-stockin');
}

function openStockinEdit(id) {
  const p = polishes.find((x) => String(x.id) === String(id));
  if (!p) return;
  stockin.mode = 'edit';
  stockin.editingId = p.id;
  stockin.editingRecord = p;
  $('stockin-title').textContent = '编辑甲油';
  $('btn-confirm-stockin').textContent = '保存修改';
  $('stockin-tabs').classList.add('hidden');
  $('tab-ai').classList.add('hidden');
  $('tab-manual').classList.add('hidden');
  $('stockin-form-grid').classList.remove('hidden');
  const rowsPanel = $('stockin-rows-panel');
  if (rowsPanel) rowsPanel.classList.add('hidden'); // 编辑的是单瓶，用单条表单
  resetScreenshot();
  clearRecognizeResults();
  // 录入字段：品牌 / 系列 / 色号 / 购买金额 / 色系（多选）；其余数据保留原值
  setVal('f-brand', p.brand);
  setVal('f-series', p.series);
  setVal('f-color-code', p.color_code);
  setVal('f-price', p.purchase_price === null || p.purchase_price === undefined ? '' : p.purchase_price);
  stockin.families = familiesOf(p);
  renderFamilyChips($('family-chips'), stockin.families, pickFamily);
  updateStockinDupHint();
  openModal('modal-stockin');
}

/* 色系多选：点击在选中的集合中增删 */
function pickFamily(f) {
  const i = stockin.families.indexOf(f);
  if (i === -1) stockin.families.push(f);
  else stockin.families.splice(i, 1);
  renderFamilyChips($('family-chips'), stockin.families, pickFamily);
}

function switchStockinTab(tab) {
  document.querySelectorAll('#stockin-tabs .tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === tab));
  $('tab-ai').classList.toggle('hidden', tab !== 'ai');
  $('tab-manual').classList.toggle('hidden', tab !== 'manual');
  if (tab === 'manual') {
    // 手动录入：新建走多行面板，编辑（无 tab）走单条表单
    $('recognize-results').classList.add('hidden');
    const isEdit = stockin.mode === 'edit';
    $('stockin-form-grid').classList.toggle('hidden', !isEdit);
    $('stockin-rows-panel').classList.toggle('hidden', isEdit);
    $('btn-confirm-stockin').classList.remove('hidden');
  } else if (recognizeItems.length) {
    renderRecognizeResults();
  }
}

async function handleScreenshotFile(file) {
  if (!file) return;
  if (!file.type || !file.type.startsWith('image/')) {
    toast('请选择图片文件', 'error');
    return;
  }
  try {
    stockin.screenshotBlob = await resizeImage(file, 1440, 0.82);
    stockin.screenshotName = file.name || '购买截图';
    const url = await blobToDataUrl(stockin.screenshotBlob);
    $('screenshot-img').src = url;
    $('screenshot-name').textContent = stockin.screenshotName;
    $('screenshot-preview').classList.remove('hidden');
    $('dropzone').classList.add('hidden');
    $('recognize-status').textContent = '';
    $('recognize-status').className = 'recognize-status';
  } catch (err) {
    toast(err.message || '图片处理失败', 'error');
  }
}

/* ---------- 多商品识别结果：逐项确认 + 统一录入 ---------- */
function normalizeRecognizeResult(result) {
  if (!result) return [];
  // 兼容三种返回：数组、{items:[...]}、旧版单对象
  const raw = Array.isArray(result)
    ? result
    : (Array.isArray(result.items) ? result.items : [result]);
  const sharedChannel = (!Array.isArray(result) && result && result.channel) ? String(result.channel).trim() : '';
  const sharedDate = (!Array.isArray(result) && result && typeof result.purchase_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(result.purchase_date))
    ? result.purchase_date : '';
  return raw
    .map((it) => ({
      brand: (it && it.brand ? String(it.brand).trim() : ''),
      series: (it && it.series ? String(it.series).trim() : ''),
      color_name: (it && it.color_name ? String(it.color_name).trim() : ''),
      color_code: (it && it.color_code ? String(it.color_code).trim() : ''),
      families: [],
      price: num(it && it.price),
      purchase_channel: (it && it.channel ? String(it.channel).trim() : '') || sharedChannel,
      purchase_date: (it && typeof it.purchase_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(it.purchase_date))
        ? it.purchase_date : sharedDate,
    }))
    .filter((it) => it.brand || it.color_name || it.color_code || it.series);
}

/* 识别项色系 chips（多选）：families 为已选数组 */
function familyChipsHtml(families) {
  const sel = (families || []).filter(Boolean);
  const customSel = sel.filter((f) => !allFamilies().includes(f));
  return `<div class="result-family" data-role="family-chips">${allFamilies().map((f) =>
    `<button type="button" class="family-chip${sel.includes(f) ? ' active' : ''}" data-family="${esc(f)}">${esc(f)}</button>`
  ).join('')}${customSel.map((f) => `<button type="button" class="family-chip active" data-family="${esc(f)}">${esc(f)}</button>`).join('')}<button type="button" class="family-chip family-chip-add" data-custom="1" title="自定义色系">＋自定义</button><span class="family-custom-row hidden"><input type="text" class="family-custom-input" data-custom-input maxlength="12" placeholder="色系"><button type="button" class="family-chip family-chip-ok" data-custom-save="1">确定</button></span></div>`;
}

function renderRecognizeResults() {
  const has = recognizeItems.length > 0;
  $('results-count').textContent = has
    ? `识别到 ${recognizeItems.length} 项，请逐项确认（可修改 / 删除 / 补充）`
    : '暂无待入库项目';
  const inStock = polishes.filter((p) => p.status !== 'sold');
  $('recognize-item-list').innerHTML = recognizeItems.map((it, i) => {
    // 重复标记：与在库相同 / 与本单其他项相同
    const dupInStock = findPolishDuplicates(it, inStock).length;
    let dupInBatch = 0;
    recognizeItems.forEach((other, j) => { if (j !== i && isSamePolish(other, it)) dupInBatch++; });
    const dupNote = dupInStock > 0
      ? `<div class="result-dup-warn">库存中已有 ${dupInStock} 瓶相同甲油，请确认是否重复录入</div>`
      : (dupInBatch > 0 ? `<div class="result-dup-warn">与本单其他项重复，请确认是否保留</div>` : '');
    return `
    <div class="result-item" data-idx="${i}">
      <div class="result-item-head">
        <span class="result-item-no">第 ${i + 1} 项</span>
        <button type="button" class="result-item-remove" data-remove="${i}" title="删除此项">×</button>
      </div>
      <div class="result-item-grid">
        <input data-field="brand" placeholder="品牌 *" value="${esc(it.brand)}">
        <input data-field="series" placeholder="系列（选填）" value="${esc(it.series)}">
        <input data-field="color_code" placeholder="色号（选填）" value="${esc(it.color_code)}">
        <input data-field="price" type="number" min="0" step="0.01" placeholder="购买金额 ¥ *" value="${it.price === null || it.price === undefined ? '' : it.price}">
      </div>
      ${dupNote}
      ${familyChipsHtml(it.families)}
    </div>`;
  }).join('');
  $('btn-confirm-recognize').textContent = has ? `确认入库（${recognizeItems.length}）` : '确认入库';
  $('recognize-results').classList.toggle('hidden', !has);
  // 结果面板出现时，隐藏单条表单与底部确认按钮，避免两套入口混淆
  $('stockin-form-grid').classList.toggle('hidden', has);
  $('btn-confirm-stockin').classList.toggle('hidden', has);
}

function clearRecognizeResults() {
  recognizeItems = [];
  $('recognize-item-list').innerHTML = '';
  $('recognize-results').classList.add('hidden');
  $('stockin-form-grid').classList.remove('hidden');
  $('btn-confirm-stockin').classList.remove('hidden');
  resetBatchFamily();
}

/* 重置批量设置栏（系列/金额/色系，含自定义输入） */
function resetBatchFamily() {
  setVal('batch-series', '');
  setVal('batch-price', '');
  setVal('batch-family', '');
  const custom = $('batch-family-custom');
  if (custom) {
    setVal('batch-family-custom', '');
    custom.classList.add('hidden');
  }
}

function onRecognizeItemInput(e) {
  const row = e.target.closest('.result-item');
  if (!row) return;
  const idx = Number(row.dataset.idx);
  const field = e.target.dataset.field;
  if (!recognizeItems[idx] || !field) return;
  recognizeItems[idx][field] = field === 'price' ? num(e.target.value) : e.target.value.trim();
}

/* 识别面板内色系 chips 选择（多选，事件委托）：局部更新，避免整表重渲染丢失焦点 */
function onRecognizeItemFamilyClick(e) {
  const chip = e.target.closest('.family-chip');
  if (!chip) return;
  const row = chip.closest('.result-item');
  if (!row) return;
  const idx = Number(row.dataset.idx);
  if (!recognizeItems[idx]) return;
  const item = recognizeItems[idx];
  if (!Array.isArray(item.families)) item.families = [];
  const sel = item.families;
  // ＋自定义：展开内联输入框
  if (chip.dataset.custom) {
    const wrap = chip.closest('.result-family');
    const customRow = wrap.querySelector('.family-custom-row');
    const input = wrap.querySelector('[data-custom-input]');
    const customSel = sel.filter((f) => !allFamilies().includes(f));
    customRow.classList.remove('hidden');
    input.value = customSel[0] || '';
    input.focus();
    return;
  }
  // 自定义输入确定：新标签写入标签表持久化，并加入该项已选
  if (chip.dataset.customSave) {
    const wrap = chip.closest('.result-family');
    const input = wrap.querySelector('[data-custom-input]');
    const v = input.value.trim();
    if (!v) { toast('请输入色系名称', 'error'); return; }
    if (!ensureFamilyTag(v)) { toast('色系名称最多 12 个字', 'error'); return; }
    fillBatchFamilyOptions();
    if (!sel.includes(v)) sel.push(v);
    wrap.outerHTML = familyChipsHtml(sel);
    return;
  }
  const f = chip.dataset.family;
  const i = sel.indexOf(f);
  if (i === -1) sel.push(f); else sel.splice(i, 1);
  row.querySelectorAll('.family-chip').forEach((c) => {
    if (c.dataset.family) c.classList.toggle('active', sel.includes(c.dataset.family));
  });
}

function onRecognizeItemClick(e) {
  const btn = e.target.closest('[data-remove]');
  if (!btn) return;
  recognizeItems.splice(Number(btn.dataset.remove), 1);
  renderRecognizeResults();
}

function applyBatchSettings() {
  if (!recognizeItems.length) {
    toast('当前没有可应用的项目', 'error');
    return;
  }
  const series = getVal('batch-series');
  const price = num(getVal('batch-price'));
  let family = getVal('batch-family');
  if (family === '__custom__') {
    family = getVal('batch-family-custom');
    if (!family) {
      toast('请输入自定义色系名称', 'error');
      $('batch-family-custom').focus();
      return;
    }
    if (!ensureFamilyTag(family)) { toast('色系名称最多 12 个字', 'error'); return; }
    fillBatchFamilyOptions();
  }
  if (!series && price === null && !family) {
    toast('请先填写要统一的系列、金额或色系', 'error');
    return;
  }
  recognizeItems = recognizeItems.map((it) => ({
    ...it,
    series: series || it.series,
    price: price === null ? it.price : price,
    // 色系统一设置：选了就整套覆盖为单选该项；没选则保留每项自己的多选
    families: family ? [family] : (Array.isArray(it.families) ? it.families : []),
  }));
  renderRecognizeResults();
  const parts = [series ? '系列' : '', price !== null ? '金额' : '', family ? '色系' : ''].filter(Boolean).join('、');
  toast(`已将${parts}应用到全部 ${recognizeItems.length} 项`, 'success');
}

async function confirmRecognizeBatch() {
  if (!recognizeItems.length) {
    toast('没有待入库的项目', 'error');
    return;
  }
  const invalidIdx = recognizeItems.findIndex((it) => !it.brand || num(it.price) === null);
  if (invalidIdx !== -1) {
    toast(`第 ${invalidIdx + 1} 项缺少品牌或购买金额，请补充后再入库`, 'error');
    return;
  }
  // 查重：与在库甲油重复 / 本单内部互相重复时先确认，避免误录
  const dupNotes = [];
  const inStock = polishes.filter((p) => p.status !== 'sold');
  const batchSeen = [];
  recognizeItems.forEach((it, i) => {
    const label = `第 ${i + 1} 项「${[it.brand, it.color_code].filter(Boolean).join(' ')}」`;
    const hits = findPolishDuplicates(it, inStock);
    if (hits.length) dupNotes.push(`${label}与在库 ${hits.length} 瓶相同`);
    const inner = [];
    batchSeen.forEach((s) => { if (isSamePolish(s, it)) inner.push(s.i + 1); });
    if (inner.length) dupNotes.push(`${label}与本单第 ${inner.join('、')} 项重复`);
    batchSeen.push({ i, ...it });
  });
  if (dupNotes.length) {
    openConfirm(`识别结果中存在重复：${dupNotes.join('；')}。如确为购入多瓶可继续入库；如为识别重复，请先删除多余项。`, () => doRecognizeBatchInsert(), '仍要入库');
    return;
  }
  await doRecognizeBatchInsert();
}

async function doRecognizeBatchInsert() {
  const btn = $('btn-confirm-recognize');
  btn.disabled = true;
  btn.textContent = '入库中…';
  // 截图只需存一次，同单商品共享同一张购买截图
  let screenshotRef = null;
  if (stockin.screenshotBlob) {
    try {
      screenshotRef = await saveImage(stockin.screenshotBlob, `ss_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
    } catch (err) {
      toast('截图保存失败：' + (err.message || '未知错误'), 'error');
      btn.disabled = false;
      btn.textContent = `确认入库（${recognizeItems.length}）`;
      return;
    }
  }
  let okCount = 0;
  const failures = [];
  for (const it of recognizeItems) {
    try {
      await insertPolish({
        brand: it.brand,
        series: it.series || null,
        // 颜色名用「色号 → 系列 → 未命名」兜底，保证列表可读
        color_name: it.color_code || it.series || '未命名',
        color_code: it.color_code || null,
        // 色系多选：color_families 存全量，color_family 兼容存第一个（旧版本/导出可读）
        color_families: it.families && it.families.length ? it.families.slice() : null,
        color_family: (it.families && it.families[0]) || null,
        color_hex: null,
        // AI 从截图识别到的价格/日期/渠道自动带上，供数据看板汇总
        purchase_price: it.price,
        purchase_date: it.purchase_date || null,
        purchase_channel: it.purchase_channel || null,
        notes: null,
        purchase_screenshot: screenshotRef,
        real_color_images: [],
        status: 'in_stock',
      });
      okCount++;
    } catch (err) {
      failures.push(it.color_code || it.brand || '未命名');
    }
  }
  btn.disabled = false;
  btn.textContent = `确认入库（${recognizeItems.length}）`;
  if (okCount > 0) {
    closeModal('modal-stockin');
    try {
      await loadPolishes();
    } catch (e) {
      /* 列表刷新失败不阻断入库成功的反馈 */
    }
  }
  if (failures.length) {
    toast(`成功入库 ${okCount} 项，失败 ${failures.length} 项（${failures.join('、')}），可重试`, 'error', 5000);
  } else {
    toast(`已成功入库 ${okCount} 项`, 'success');
  }
}

async function runRecognize() {
  const status = $('recognize-status');
  if (!stockin.screenshotBlob) {
    status.textContent = '请先上传购买截图';
    status.className = 'recognize-status error';
    return;
  }
  if (!cloud) {
    status.textContent = '识别组件未加载，请刷新页面重试';
    status.className = 'recognize-status error';
    return;
  }
  const btn = $('btn-recognize');
  btn.disabled = true;
  btn.textContent = '识别中…';
  status.textContent = 'AI 正在识别截图信息，请稍候…';
  status.className = 'recognize-status loading';
  try {
    const file = new File([stockin.screenshotBlob], stockin.screenshotName || 'screenshot.jpg', { type: 'image/jpeg' });
    const result = await recognizeScreenshot(file);
    const items = normalizeRecognizeResult(result);
    if (!items.length) throw new Error('未能从截图中识别出有效信息，请手动录入');
    recognizeItems = items;
    // 整单共享系列时预填到统一设置栏，一键应用到全部；金额不预填（各商品单价可能不同）
    setVal('batch-series', (!Array.isArray(result) && result.series) ? String(result.series).trim() : '');
    resetBatchFamily();
    renderRecognizeResults();
    status.textContent = `识别到 ${items.length} 项，请逐项确认后统一入库`;
    status.className = 'recognize-status ok';
  } catch (err) {
    status.textContent = (err && err.error && err.error.message) || err.message || '识别失败，请改用手动录入';
    status.className = 'recognize-status error';
  } finally {
    btn.disabled = false;
    btn.textContent = 'AI 识别提取';
  }
}

async function confirmStockin() {
  if (stockin.mode === 'create') {
    await confirmBatchStockin();
    return;
  }
  // ===== 编辑模式：单条表单 =====
  const brand = getVal('f-brand');
  const price = num(getVal('f-price'));
  if (!brand) {
    toast('请填写品牌', 'error');
    return;
  }
  if (price === null) {
    toast('请填写购买金额', 'error');
    return;
  }
  const series = getVal('f-series') || null;
  const colorCode = getVal('f-color-code') || null;
  const families = stockin.families.slice();
  // 色系多选：color_families 存全量，color_family 兼容存第一个（旧版本/导出可读）
  const familyFields = {
    color_families: families.length ? families : null,
    color_family: families.length ? families[0] : null,
  };
  const fields = {
    brand,
    series,
    color_code: colorCode,
    purchase_price: price,
    ...familyFields,
    // 若原颜色名是兜底值「未命名」且用户补填了色号，则同步升级，否则保留原值
    ...(stockin.editingRecord && stockin.editingRecord.color_name === '未命名' && colorCode
      ? { color_name: colorCode }
      : {}),
  };
  await saveStockinEdit(fields);
}

/* 新建模式：多行批量入库——逐行校验 → 查重确认 → 逐行按数量写入 */
async function confirmBatchStockin() {
  // 完全空白的行自动忽略（加行了但没填），只提交填写过的行，避免被空行误拦
  const rows = stockin.rows.filter((r) => {
    const touched = ['brand', 'series', 'color_code', 'price'].some((k) => (r[k] || '').toString().trim() !== '');
    const qtyTouched = (r.qty || '').toString().trim() !== '' && (r.qty || '').toString().trim() !== '1';
    return touched || qtyTouched;
  });
  if (!rows.length) {
    toast('请至少填写一项', 'error');
    return;
  }
  // 1) 逐行校验（错误定位到具体行并聚焦）
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const no = `第 ${i + 1} 项`;
    if (!(r.brand || '').trim()) {
      toast(`${no}请填写品牌`, 'error');
      focusRowField(r, 'brand');
      return;
    }
    if (num(r.price) === null) {
      toast(`${no}请填写购买金额`, 'error');
      focusRowField(r, 'price');
      return;
    }
    const qty = num(r.qty);
    if (qty !== null && (!Number.isInteger(qty) || qty < 1)) {
      toast(`${no}数量需为不小于 1 的整数`, 'error');
      focusRowField(r, 'qty');
      return;
    }
  }
  // 2) 查重：任一行与在库甲油重复时，一次性确认后全部入库
  const dupRows = rows.filter((r) => findPolishDuplicates({
    brand: (r.brand || '').trim(),
    series: (r.series || '').trim(),
    color_code: (r.color_code || '').trim(),
  }).length);
  if (dupRows.length) {
    const names = dupRows.slice(0, 3).map((r) => (r.brand || '') + (r.color_code ? ` · ${r.color_code}` : '')).join('；');
    const more = dupRows.length > 3 ? ` 等 ${dupRows.length} 项` : '';
    openConfirm(
      `有 ${dupRows.length} 项与库存重复：${names}${more}。如确为购入多瓶可继续入库；如为重复录入，请返回修改。`,
      () => createBatchStockin(rows),
      '仍要入库'
    );
    return;
  }
  await createBatchStockin(rows);
}

/* 批量写入：购买截图只存一次、多行共享；每行按数量连续入库（一瓶一记录，各自独立 id） */
async function createBatchStockin(rows) {
  const btn = $('btn-confirm-stockin');
  btn.disabled = true;
  btn.textContent = '保存中…';
  try {
    let screenshotRef = null;
    if (stockin.screenshotBlob) {
      screenshotRef = await saveImage(stockin.screenshotBlob, `ss_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
    }
    let bottles = 0;
    for (const r of rows) {
      const qty = num(r.qty);
      const count = qty === null ? 1 : qty;
      const families = (r.families || []).filter(Boolean);
      const familyFields = {
        color_families: families.length ? families : null,
        color_family: families.length ? families[0] : null,
      };
      const series = (r.series || '').trim() || null;
      const colorCode = (r.color_code || '').trim() || null;
      const fields = {
        brand: (r.brand || '').trim(),
        series,
        color_name: colorCode || series || '未命名',
        color_code: colorCode,
        purchase_price: num(r.price),
        ...familyFields,
      };
      for (let i = 0; i < count; i++) {
        await insertPolish({
          ...fields,
          purchase_screenshot: screenshotRef,
          real_color_images: [],
          status: 'in_stock',
        });
        bottles++;
      }
    }
    toast(
      rows.length > 1
        ? `已入库 ${rows.length} 项（${bottles} 瓶）`
        : (bottles > 1 ? `已入库 ${bottles} 瓶` : '入库成功'),
      'success'
    );
    closeModal('modal-stockin');
    await loadPolishes();
  } catch (err) {
    toast(err.message || '保存失败', 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '确认入库';
  }
}

async function saveStockinEdit(fields) {
  const btn = $('btn-confirm-stockin');
  btn.disabled = true;
  btn.textContent = '保存中…';
  try {
    await updatePolish(stockin.editingId, fields);
    toast('已保存修改', 'success');
    closeModal('modal-stockin');
    await loadPolishes();
  } catch (err) {
    toast(err.message || '保存失败', 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '保存修改';
  }
}

/* ============================================================
 * 售出模态框
 * ============================================================ */
function openSell(id) {
  const p = polishes.find((x) => String(x.id) === String(id));
  if (!p) return;
  sellingId = p.id;
  const img = imgUrl(p.real_color_image) || imgUrl(p.purchase_screenshot);
  $('sell-summary').innerHTML = `
    <div class="summary-thumb">${img ? `<img data-img="${esc(p.real_color_image || p.purchase_screenshot)}" src="${esc(img)}" alt="">` : esc((p.color_code || '').slice(0, 3))}</div>
    <div class="summary-info">
      <div class="summary-name">${esc(p.brand || '')}${p.series ? ' · ' + esc(p.series) : ''}</div>
      <div class="summary-sub">${esc(p.color_code || p.color_name || '')} · 购入价 ${(p.purchase_price !== null && p.purchase_price !== undefined) ? fmtMoney(p.purchase_price) : '未记录'}</div>
    </div>`;
  $('sale-channel').value = '闲鱼';
  setVal('sale-price', '');
  setVal('sale-date', todayStr());
  setVal('sale-notes', '');
  openModal('modal-sell');
}

async function confirmSell() {
  if (sellingId === null) return;
  const price = num(getVal('sale-price'));
  if (price === null) {
    toast('请填写售价', 'error');
    return;
  }
  const btn = $('btn-confirm-sell');
  btn.disabled = true;
  btn.textContent = '保存中…';
  try {
    await updatePolish(sellingId, {
      status: 'sold',
      sale_channel: getVal('sale-channel') || '闲鱼',
      sale_price: price,
      sale_date: getVal('sale-date') || todayStr(),
      notes: getVal('sale-notes') || null,
    });
    toast('已登记售出', 'success');
    closeModal('modal-sell');
    await loadPolishes();
  } catch (err) {
    toast(err.message || '登记失败', 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '确认售出';
    sellingId = null;
  }
}

async function revertSale(id) {
  try {
    await updatePolish(id, { status: 'in_stock', sale_channel: null, sale_price: null, sale_date: null });
    toast('已撤回至库存', 'success');
    await loadPolishes();
  } catch (err) {
    toast(err.message || '操作失败', 'error');
  }
}

/* ============================================================
 * 试色图模态框（支持多张，最多 5 张）
 * ============================================================ */
function openRealcolor(id) {
  const p = polishes.find((x) => String(x.id) === String(id));
  if (!p) return;
  realcolor.targetId = p.id;
  realcolor.existing = realColorImages(p).slice();
  realcolor.newBlobs = [];
  realcolor.removed = [];
  const imgs = realcolor.existing;
  $('realcolor-summary').innerHTML = `
    <div class="summary-thumb">${imgs.length && imgUrl(imgs[0]) ? `<img data-img="${esc(imgs[0])}" src="${esc(imgUrl(imgs[0]))}" alt="">` : esc((p.color_code || '').slice(0, 3))}</div>
    <div class="summary-info">
      <div class="summary-name">${esc(p.brand || '')}${p.series ? ' · ' + esc(p.series) : ''}</div>
      <div class="summary-sub">${esc(p.color_code || p.color_name || '')}${imgs.length ? ` · 已有 ${imgs.length} 张试色图` : ' · 暂未上传试色图'}</div>
    </div>`;
  $('file-realcolor').value = '';
  renderRealcolorList();
  openModal('modal-realcolor');
}

/* 渲染试色图缩略图列表（已保存 + 待上传），每张可删除 */
function renderRealcolorList() {
  const list = $('realcolor-list');
  const total = realcolor.existing.length + realcolor.newBlobs.length;
  $('realcolor-drop').classList.toggle('hidden', total >= MAX_REALCOLOR_IMAGES);
  $('realcolor-hint').textContent = total >= MAX_REALCOLOR_IMAGES
    ? `最多上传 ${MAX_REALCOLOR_IMAGES} 张试色图`
    : `还可上传 ${MAX_REALCOLOR_IMAGES - total} 张（最多 ${MAX_REALCOLOR_IMAGES} 张）`;
  const items = [
    ...realcolor.existing.map((ref, i) => ({ ref, i })),
    ...realcolor.newBlobs.map((b, i) => ({ blob: b, i })),
  ];
  if (!items.length) {
    list.innerHTML = '';
    list.classList.add('hidden');
    return;
  }
  list.classList.remove('hidden');
  list.innerHTML = items.map((it, idx) => {
    const url = it.ref ? imgUrl(it.ref) : it.blob.url;
    const isNew = !it.ref;
    return `
    <div class="realcolor-thumb" data-idx="${idx}">
      <img src="${esc(url)}" alt="试色图 ${idx + 1}">
      <button type="button" class="realcolor-thumb-remove" data-remove="${idx}" title="移除这张">×</button>
      ${isNew ? '<span class="realcolor-thumb-tag">待上传</span>' : ''}
    </div>`;
  }).join('');
}

/* 删除列表中的一张：新图直接丢弃，旧图标记待删除 */
function removeRealcolorAt(idx) {
  const existingCount = realcolor.existing.length;
  if (idx < existingCount) {
    const [ref] = realcolor.existing.splice(idx, 1);
    realcolor.removed.push(ref);
  } else {
    realcolor.newBlobs.splice(idx - existingCount, 1);
  }
  renderRealcolorList();
}

async function handleRealcolorFile(files) {
  const list = Array.from(files || []).filter((f) => f && f.type && f.type.startsWith('image/'));
  if (!list.length) {
    toast('请选择图片文件', 'error');
    return;
  }
  const total = realcolor.existing.length + realcolor.newBlobs.length;
  const room = MAX_REALCOLOR_IMAGES - total;
  if (room <= 0) {
    toast(`最多上传 ${MAX_REALCOLOR_IMAGES} 张试色图`, 'error');
    return;
  }
  const picked = list.slice(0, room);
  if (list.length > room) toast(`已达上限，仅添加前 ${room} 张`, 'error');
  try {
    for (const file of picked) {
      const blob = await resizeImage(file, 1200, 0.82);
      const url = await blobToDataUrl(blob);
      realcolor.newBlobs.push({ blob, url });
    }
    renderRealcolorList();
  } catch (err) {
    toast(err.message || '图片处理失败', 'error');
  }
}

async function confirmRealcolor() {
  if (realcolor.targetId === null) return;
  const btn = $('btn-confirm-realcolor');
  btn.disabled = true;
  btn.textContent = '保存中…';
  try {
    const newRefs = [];
    for (const b of realcolor.newBlobs) {
      newRefs.push(await saveImage(b.blob, `rc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`));
    }
    const finalRefs = realcolor.existing.concat(newRefs);
    if (!finalRefs.length) {
      toast('请先上传试色图', 'error');
      return;
    }
    await updatePolish(realcolor.targetId, { real_color_images: finalRefs, real_color_image: null });
    if (realcolor.removed.length) await removeImageRefs(realcolor.removed);
    toast(`已保存 ${finalRefs.length} 张试色图`, 'success');
    closeModal('modal-realcolor');
    await loadPolishes();
  } catch (err) {
    toast(err.message || '保存失败', 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '保存试色图';
  }
}

async function removeRealcolor() {
  if (realcolor.targetId === null) return;
  const count = realcolor.existing.length + realcolor.newBlobs.length;
  openConfirm(`确定移除该甲油的全部 ${count} 张试色图吗？`, async () => {
    try {
      await updatePolish(realcolor.targetId, { real_color_images: [], real_color_image: null });
      await removeImageRefs(realcolor.existing);
      toast('试色图已移除', 'success');
      closeModal('modal-realcolor');
      await loadPolishes();
    } catch (err) {
      toast(err.message || '操作失败', 'error');
    }
  }, '确认移除');
}

/* ============================================================
 * 删除与确认框
 * ============================================================ */
function openConfirm(text, onConfirm, okLabel = '确认删除') {
  $('confirm-text').textContent = text;
  $('btn-confirm-ok').textContent = okLabel;
  confirmCallback = onConfirm;
  openModal('modal-confirm');
}

function closeConfirm() {
  confirmCallback = null;
  closeModal('modal-confirm');
}

function askDelete(id) {
  const p = polishes.find((x) => String(x.id) === String(id));
  if (!p) return;
  openConfirm(`删除后不可恢复，将同时删除该甲油的相关图片。确定删除「${p.brand || ''} ${p.color_code || p.color_name || ''}」吗？`, async () => {
    try {
      await deletePolish(id);
      await removeImageRefs([p.purchase_screenshot, ...realColorImages(p)]);
      toast('已删除', 'success');
      await loadPolishes();
    } catch (err) {
      toast(err.message || '删除失败', 'error');
    }
  });
}

/* ============================================================
 * 试色图查看器（支持多张左右切换）
 * ============================================================ */
function openImageView(refs, index = 0) {
  const list = (refs || []).filter(Boolean);
  if (!list.length) {
    toast('暂无试色图', 'error');
    return;
  }
  imageview.refs = list;
  imageview.index = Math.max(0, Math.min(index, list.length - 1));
  updateImageView();
  openModal('modal-imageview');
}

function updateImageView() {
  const ref = imageview.refs[imageview.index];
  const url = imgUrl(ref);
  if (!url) {
    toast('图片读取失败', 'error');
    return;
  }
  $('imageview-img').src = url;
  const multi = imageview.refs.length > 1;
  $('imageview-count').textContent = `${imageview.index + 1} / ${imageview.refs.length}`;
  $('imageview-prev').classList.toggle('hidden', !multi);
  $('imageview-next').classList.toggle('hidden', !multi);
}

function imageviewStep(delta) {
  if (imageview.refs.length < 2) return;
  imageview.index = (imageview.index + delta + imageview.refs.length) % imageview.refs.length;
  updateImageView();
}

function viewImage(id) {
  const p = polishes.find((x) => String(x.id) === String(id));
  if (!p) return;
  openImageView(realColorImages(p), 0);
}

/* ============================================================
 * 数据备份 / 恢复（本地数据仅存于本机浏览器，建议定期备份）
 * ============================================================ */
async function exportBackup() {
  try {
    const store = readStore();
    const images = {};
    for (const rec of store.records) {
      for (const ref of [rec.purchase_screenshot, ...realColorImages(rec)]) {
        const key = imgKeyOf(ref);
        if (!key || images[key]) continue;
        const blob = await idbGet(key);
        if (blob) images[key] = await blobToDataUrl(blob);
      }
    }
    const payload = {
      app: 'nail-polish-manager',
      version: 1,
      exportedAt: new Date().toISOString(),
      seq: store.seq,
      records: store.records,
      images,
    };
    const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `甲油库备份_${todayStr()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    toast('备份文件已开始下载', 'success');
  } catch (err) {
    toast('备份失败：' + (err.message || '未知错误'), 'error');
  }
}

function importBackup(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const payload = JSON.parse(reader.result);
      if (!payload || !Array.isArray(payload.records)) throw new Error('文件格式不正确');
      openConfirm(`导入将覆盖当前全部数据（共 ${payload.records.length} 条记录），确定继续吗？`, async () => {
        try {
          // 先写图片，再写记录
          for (const [key, dataUrl] of Object.entries(payload.images || {})) {
            await idbPut(key, dataUrlToBlob(dataUrl));
          }
          urlCache.clear();
          writeStore({ seq: Number(payload.seq) || 0, records: payload.records });
          localStorage.setItem(SEED_FLAG_KEY, '1'); // 导入后不再触发种子导入
          closeModal('modal-stockin');
          await loadPolishes();
          toast(`已导入 ${payload.records.length} 条记录`, 'success');
        } catch (err) {
          toast('导入失败：' + (err.message || '文件解析错误'), 'error');
        }
      }, '确认导入');
    } catch (err) {
      toast('备份文件无法解析：' + (err.message || '格式错误'), 'error');
    }
  };
  reader.readAsText(file);
}

/* ============================================================
 * 历史数据一次性迁移（云端 → 本地）
 * ============================================================ */
async function importSeedIfNeeded() {
  if (localStorage.getItem(SEED_FLAG_KEY)) return false;
  const store = readStore();
  if (store.records.length) {
    localStorage.setItem(SEED_FLAG_KEY, '1');
    return false;
  }
  if (!window.__SEED_DATA__ || !Array.isArray(window.__SEED_DATA__.records)) return false;
  const seed = window.__SEED_DATA__;
  try {
    for (const [key, dataUrl] of Object.entries(seed.images || {})) {
      await idbPut(key, dataUrlToBlob(dataUrl));
    }
    writeStore({ seq: seed.seq || 0, records: seed.records });
    localStorage.setItem(SEED_FLAG_KEY, '1');
    return true;
  } catch (e) {
    console.warn('[甲油库] 历史数据导入失败：', e);
    return false;
  }
}

function loadSeedScript() {
  return new Promise((resolve) => {
    if (window.__SEED_DATA__) { resolve(true); return; }
    const s = document.createElement('script');
    s.src = 'seed-data.js?v=20261024c';
    s.onload = () => resolve(true);
    s.onerror = () => resolve(false); // 加载失败不阻塞启动
    document.head.appendChild(s);
  });
}

/* ============================================================
 * 事件绑定
 * ============================================================ */
function bindEvents() {
  // 导航与入口
  document.querySelectorAll('.nav-tab').forEach((tab) => {
    tab.addEventListener('click', () => switchView(tab.dataset.view));
  });
  $('btn-open-stockin').addEventListener('click', openStockinCreate);

  // 备份 / 恢复
  $('btn-export').addEventListener('click', exportBackup);
  $('btn-import').addEventListener('click', () => $('file-import').click());
  $('file-import').addEventListener('change', (e) => {
    markFilePick();
    importBackup(e.target.files && e.target.files[0]);
    e.target.value = '';
  });

  // 库存筛选
  $('filter-search').addEventListener('input', (e) => { filters.search = e.target.value; renderInventory(); });
  $('filter-brand').addEventListener('change', (e) => { filters.brand = e.target.value; renderInventory(); });
  $('filter-series').addEventListener('change', (e) => { filters.series = e.target.value; renderInventory(); });
  $('filter-family').addEventListener('change', (e) => { filters.family = e.target.value; renderInventory(); });
  $('filter-sort').addEventListener('change', (e) => { filters.sort = e.target.value; renderInventory(); });

  // 看板条件查账（控件由 renderDashboard 动态生成，用事件委托绑定）
  document.addEventListener('change', (e) => {
    const id = e.target && e.target.id;
    if (id === 'query-brand') { query.brand = e.target.value; query.series = ''; fillQuerySelects(); applyQuery(); }
    else if (id === 'query-series') { query.series = e.target.value; applyQuery(); }
    else if (id === 'query-family') { query.family = e.target.value; applyQuery(); }
    else if (id === 'query-status') { query.status = e.target.value; applyQuery(); }
  });

  // 入库弹窗
  document.querySelectorAll('#stockin-tabs .tab').forEach((tab) => {
    tab.addEventListener('click', () => switchStockinTab(tab.dataset.tab));
  });
  $('btn-add-recognize-item').addEventListener('click', () => {
    recognizeItems.push({ brand: '', series: '', color_name: '', color_code: '', families: [], price: null, purchase_channel: '', purchase_date: '' });
    renderRecognizeResults();
  });
  $('btn-apply-batch').addEventListener('click', applyBatchSettings);
  $('btn-confirm-recognize').addEventListener('click', confirmRecognizeBatch);
  $('btn-rerecognize').addEventListener('click', runRecognize);
  $('recognize-item-list').addEventListener('input', onRecognizeItemInput);
  $('recognize-item-list').addEventListener('click', (e) => {
    onRecognizeItemFamilyClick(e);
    onRecognizeItemClick(e);
  });
  // 识别项自定义色系输入框：回车确认（新标签写入标签表持久化）
  $('recognize-item-list').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const input = e.target.closest('[data-custom-input]');
    if (!input) return;
    e.preventDefault();
    const row = input.closest('.result-item');
    const wrap = input.closest('.result-family');
    const idx = Number(row && row.dataset.idx);
    if (!recognizeItems[idx]) return;
    const v = input.value.trim();
    if (!v) { toast('请输入色系名称', 'error'); return; }
    if (!ensureFamilyTag(v)) { toast('色系名称最多 12 个字', 'error'); return; }
    fillBatchFamilyOptions();
    const item = recognizeItems[idx];
    if (!Array.isArray(item.families)) item.families = [];
    if (!item.families.includes(v)) item.families.push(v);
    wrap.outerHTML = familyChipsHtml(item.families);
  });
  // 批量色系选「自定义…」时展示输入框
  $('batch-family').addEventListener('change', (e) => {
    const custom = $('batch-family-custom');
    if (!custom) return;
    custom.classList.toggle('hidden', e.target.value !== '__custom__');
    if (e.target.value === '__custom__') custom.focus();
  });

  // 色系标签管理（入库弹窗与库存工具栏两个入口，共用同一弹窗）
  $('btn-manage-families').addEventListener('click', openFamiliesModal);
  $('btn-manage-families-stockin').addEventListener('click', openFamiliesModal);
  $('btn-add-family-tag').addEventListener('click', confirmAddFamilyTag);
  $('families-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); confirmAddFamilyTag(); }
  });
  $('families-tag-list').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-family-remove]');
    if (!btn) return;
    const name = btn.dataset.familyRemove;
    if (removeFamilyTag(name)) {
      refreshFamilyUIs();
      toast(`已删除色系「${name}」`, 'success');
    }
  });
  $('btn-reset-families').addEventListener('click', () => {
    openConfirm('恢复默认色系标签？自定义添加的标签将被移除（不影响已录入记录）', () => {
      resetFamilyTags();
      refreshFamilyUIs();
      toast('已恢复默认色系标签', 'success');
    }, '恢复默认');
  });
  $('dropzone').addEventListener('click', () => $('file-screenshot').click());
  $('file-screenshot').addEventListener('change', (e) => {
    markFilePick();
    handleScreenshotFile(e.target.files && e.target.files[0]);
  });
  $('btn-rescreenshot').addEventListener('click', resetScreenshot);
  $('btn-recognize').addEventListener('click', runRecognize);
  $('btn-confirm-stockin').addEventListener('click', confirmStockin);
  // 多行录入面板事件（静态面板路径；自愈创建的面板在 ensureStockinRowsPanel 内自绑定）
  bindStockinRowsEvents();
  // 录入实时查重：品牌/系列/色号变化时更新提示条
  ['f-brand', 'f-series', 'f-color-code'].forEach((id) => {
    $(id).addEventListener('input', updateStockinDupHint);
  });

  // 拖拽上传
  ['dragenter', 'dragover'].forEach((evt) =>
    $('dropzone').addEventListener(evt, (e) => { e.preventDefault(); $('dropzone').classList.add('dragover'); })
  );
  ['dragleave', 'drop'].forEach((evt) =>
    $('dropzone').addEventListener(evt, (e) => { e.preventDefault(); $('dropzone').classList.remove('dragover'); })
  );
  $('dropzone').addEventListener('drop', (e) => {
    const file = e.dataTransfer.files && e.dataTransfer.files[0];
    if (file) handleScreenshotFile(file);
  });

  // 售出弹窗
  $('btn-confirm-sell').addEventListener('click', confirmSell);

  // 试色图弹窗
  $('realcolor-drop').addEventListener('click', () => $('file-realcolor').click());
  $('file-realcolor').addEventListener('change', (e) => {
    markFilePick();
    handleRealcolorFile(e.target.files);
    e.target.value = '';
  });
  $('btn-confirm-realcolor').addEventListener('click', confirmRealcolor);
  $('btn-remove-realcolor').addEventListener('click', removeRealcolor);
  // 试色图列表：删除单张
  $('realcolor-list').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-remove]');
    if (!btn) return;
    removeRealcolorAt(Number(btn.dataset.remove));
  });
  ['dragenter', 'dragover'].forEach((evt) =>
    $('realcolor-drop').addEventListener(evt, (e) => { e.preventDefault(); $('realcolor-drop').classList.add('dragover'); })
  );
  ['dragleave', 'drop'].forEach((evt) =>
    $('realcolor-drop').addEventListener(evt, (e) => { e.preventDefault(); $('realcolor-drop').classList.remove('dragover'); })
  );
  $('realcolor-drop').addEventListener('drop', (e) => {
    if (e.dataTransfer.files && e.dataTransfer.files.length) handleRealcolorFile(e.dataTransfer.files);
  });

  // 试色图查看器
  $('imageview-prev').addEventListener('click', () => imageviewStep(-1));
  $('imageview-next').addEventListener('click', () => imageviewStep(1));

  // 确认弹窗
  $('btn-confirm-cancel').addEventListener('click', closeConfirm);
  $('btn-confirm-ok').addEventListener('click', () => {
    const cb = confirmCallback;
    closeConfirm();
    if (cb) cb();
  });

  // 模态框关闭按钮与遮罩点击
  document.querySelectorAll('[data-close]').forEach((btn) => {
    btn.addEventListener('click', () => closeModal(btn.dataset.close));
  });
  document.querySelectorAll('.modal-overlay').forEach((overlay) => {
    overlay.addEventListener('click', (e) => {
      if (e.target !== overlay) return;
      if (NO_OVERLAY_CLOSE.has(overlay.id)) return; // 录入类模态框不因点遮罩而关闭
      overlay.classList.add('hidden');
    });
  });

  // 文件选择器返回后的“残留点击”防护：短时间内命中关闭/导航/切换类元素的点击直接吞掉
  document.addEventListener('click', (e) => {
    if (Date.now() - lastFilePickAt > 600) return;
    const t = e.target;
    if (!t || !t.closest) return;
    if (t.closest('[data-close]') || t.closest('.nav-tab') || t.closest('[data-action]')
      || t.closest('[data-tab]') || t.closest('.modal-overlay') === t) {
      e.stopPropagation();
      e.preventDefault();
    }
  }, true);

  // 卡片操作（事件委托）
  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    const id = el.dataset.id;
    switch (el.dataset.action) {
      case 'open-stockin': openStockinCreate(); break;
      case 'sell': openSell(id); break;
      case 'edit': openStockinEdit(id); break;
      case 'realcolor': openRealcolor(id); break;
      case 'delete': askDelete(id); break;
      case 'revert': revertSale(id); break;
      case 'view-image': viewImage(id); break;
      default: break;
    }
  });

  // 键盘：Esc 关闭模态框；查看器打开时左右方向键切换图片
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      document.querySelectorAll('.modal-overlay:not(.hidden)').forEach((m) => m.classList.add('hidden'));
      return;
    }
    if ($('modal-imageview').classList.contains('hidden')) return;
    if (e.key === 'ArrowLeft') imageviewStep(-1);
    else if (e.key === 'ArrowRight') imageviewStep(1);
  });
}

/* ============================================================
 * 启动
 * ============================================================ */
let appStarted = false;
async function init() {
  if (appStarted) return; // 幂等保护：避免重复初始化导致事件双绑
  appStarted = true;
  ensureStockinRowsPanel(); // 自愈：旧缓存 HTML 缺多行面板时动态创建
  bindEvents();
  fillBatchFamilyOptions();
  $('app-view').classList.remove('hidden');
  await loadPolishes(); // 先渲染已有数据，避免种子脚本加载期间白屏
  try {
    // 首次启动：导入云端历史数据（一次性）
    const seedLoaded = await loadSeedScript();
    if (seedLoaded) {
      const imported = await importSeedIfNeeded();
      if (imported) {
        await loadPolishes();
        const n = (window.__SEED_DATA__ && window.__SEED_DATA__.records || []).length;
        toast(`已从历史数据导入 ${n} 条甲油记录`, 'success', 4000);
      }
      else localStorage.setItem(SEED_FLAG_KEY, '1');
    } else {
      localStorage.setItem(SEED_FLAG_KEY, '1');
    }
  } catch (e) {
    console.warn('[甲油库] 初始化异常：', e);
  }
}

document.addEventListener('DOMContentLoaded', init);
