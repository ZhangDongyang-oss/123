/**
 * ccc_ece_check_cloud —— CCC/ECE 证书校核 · 全云版（v5.0）
 *
 * 形态：前端（panel.html）+ 后端，**纯云端**——无 hw-local、无本地 python。
 *
 * 架构：
 *   ① panel 上传 PDF base64 → /run
 *   ② AI 配置：require('../../../lib/ai')（平台模块，明文 http）→ 失败回落 env
 *   ③ PDF 解析全云端：pdfjs-dist（host legacy → 内置 lib/pdfjs 兜底）
 *      通道B 文本：getTextContent 逐页 → AI 文本提取（默认 acme-auto/qwen2.5:14b，面板可切 qwen2.5:7b）
 *      通道A 视觉：render ≤5 页 PNG（doc.canvasFactory → 自建 @napi-rs 兜底 → 降级）
 *                → AI 视觉识别（qwen2.5vl:7b，image 块）
 *   ④ 双 AI 并行 → 交叉验证 + 时效判定 + Markdown 报告（移植 v4.1）
 *
 * 实测依据（探针链 4-9）：
 *   - AI 走 http://localhost:11434（明文，无 TLS 坑）；anthropic 兼容 /anthropic/v1/messages + x-api-key
 *   - document 块被网关静默丢弃 → 视觉只喂 PNG
 *   - acme-auto/qwen2.5:7b 400 Unsupported → 不用
 *
 * 交叉验证/时效/报告函数移植自 ccc_ece_check_ui_v4.1/index.js；
 * TEXT_SYSTEM/VISION_SYSTEM/extractJSON 移植自 ccc-ece-check-platform/ai_check.py。
 */
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const TOOL_DIR = __dirname;
const REFS_DIR = path.join(TOOL_DIR, 'references');
const VISION_PAGE_LIMIT = parseInt(process.env.VISION_PAGE_LIMIT || '5', 10);
const MAX_PDF_BYTES = 20 * 1024 * 1024;
const VISION_WIDTH_PX = 1200;

// ─── AI 配置与调用 ─────────────────────────────────────

/** 平台 lib/ai 优先，失败回落 env（本地测试天然走 env） */
function getAiConfig() {
  try {
    const ai = require('../../../lib/ai');
    return { base: ai.AI_BASE_URL, key: ai.AI_API_KEY, defaultModel: ai.AI_DEFAULT_MODEL };
  } catch (e) {
    return {
      base: process.env.AI_BASE_URL || 'http://localhost:11434/v1/chat/completions',
      key: process.env.AI_KEY || process.env.OLLAMA_KEY || '',
      defaultModel: process.env.AI_MODEL || 'qwen2.5:7b',
    };
  }
}

/**
 * 统一 AI 调用（Anthropic Messages 兼容，明文 http，x-api-key）
 * 文本 = images 为空的特例；过滤 reasoning 模型的 thinking 块。
 * @returns {Promise<string>} AI 文本
 */
async function callOllamaAI(opts) {
  const ai = getAiConfig();
  if (!ai.key) throw new Error('未配置 AI key（lib/ai 或 AI_KEY/OLLAMA_KEY）');
  const anthBase = String(ai.base).replace(/\/v1\/chat\/completions$/, '/anthropic') + '/v1/messages';

  const content = [];
  for (const img of (opts.images || [])) {
    content.push({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: img } });
  }
  content.push({ type: 'text', text: opts.prompt });

  const controller = new AbortController();
  const timer = setTimeout(function () { controller.abort(); }, opts.timeoutMs || 150000);
  try {
    const resp = await fetch(anthBase, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01', 'x-api-key': ai.key },
      body: JSON.stringify({
        model: opts.model,
        max_tokens: opts.maxTokens || 2048,
        system: opts.system,
        messages: [{ role: 'user', content: content }],
      }),
      signal: controller.signal,
    });
    if (!resp.ok) {
      const t = await resp.text();
      throw new Error('AI HTTP ' + resp.status + ' ' + t.slice(0, 300));
    }
    const data = await resp.json();
    if (data.error) throw new Error('AI 返回错误: ' + JSON.stringify(data.error).slice(0, 300));
    const blocks = data.content || [];
    const texts = blocks.filter(function (b) { return b.type === 'text' && b.text; }).map(function (b) { return b.text; });
    if (!texts.length) throw new Error('AI 响应无 text 块（blockTypes=' + blocks.map(function (b) { return b.type; }).join(',') + '）');
    return texts.join('\n').trim();
  } finally {
    clearTimeout(timer);
  }
}

// ─── 云端 PDF 解析 ─────────────────────────────────────

let _pdfjs = null;   // 模块级缓存

/** host pdfjs-dist legacy 优先 → 内置 lib/pdfjs 兜底（main+worker 同源配对） */
async function loadPdfjs() {
  if (_pdfjs) return _pdfjs;
  const attempts = [
    {
      name: 'host',
      load: function () { return import('pdfjs-dist/legacy/build/pdf.mjs'); },
      worker: function () { return pathToFileURL(require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs')).href; },
      fonts: function () {
        try {
          const d = path.join(path.dirname(require.resolve('pdfjs-dist/legacy/build/pdf.mjs')), '..', '..', 'standard_fonts');
          if (fs.existsSync(d)) return pathToFileURL(d).href + '/';
        } catch (_) { /* 无字体目录则不传 */ }
        return undefined;
      },
    },
    {
      name: 'bundled',
      load: function () { return import(pathToFileURL(path.join(TOOL_DIR, 'lib/pdfjs/pdf.min.mjs')).href); },
      worker: function () { return pathToFileURL(path.join(TOOL_DIR, 'lib/pdfjs/pdf.worker.min.mjs')).href; },
      fonts: function () {
        const d = path.join(TOOL_DIR, 'lib', 'pdfjs', 'standard_fonts');
        if (fs.existsSync(d)) return pathToFileURL(d).href + '/';
        return undefined;
      },
    },
  ];
  let lastErr = null;
  for (const a of attempts) {
    try {
      const pdfjs = await a.load();
      pdfjs.GlobalWorkerOptions.workerSrc = a.worker();
      _pdfjs = { pdfjs: pdfjs, src: a.name, fontsUrl: a.fonts() };
      return _pdfjs;
    } catch (e) { lastErr = e; }
  }
  throw new Error('pdfjs 不可用（host 与内置均失败）：' + (lastErr && lastErr.message));
}

/** 通道B：逐页提取文本；返回 { extracted, scanned } */
async function extractText(doc) {
  const chunks = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    let line = '';
    for (const it of tc.items) {
      if (it.str != null) { line += it.str; if (it.hasEOL) line += '\n'; }
    }
    chunks.push('=== PAGE ' + i + ' ===\n' + (line.trim() || '(no extractable text on this page)'));
  }
  const extracted = chunks.join('\n');
  const meaningful = extracted.replace(/=== PAGE/g, '').replace(/\(no extractable text on this page\)/g, '').replace(/\s/g, '');
  // v5.2 噪声阈值：扫描件印章/水印层可能残留极少量字符，<40 字符视为扫描件
  return { extracted: extracted, scanned: meaningful.length < 40 };
}

/** 通道A：渲染前 N 页 PNG（base64 数组）。失败 throw 由调用方降级 */
async function renderPagesToPng(doc, pageLimit, targetWidthPx) {
  const target = targetWidthPx || VISION_WIDTH_PX;
  const maxPages = Math.min(pageLimit, doc.numPages);
  let factory = null;
  try { factory = doc.canvasFactory || null; } catch (_) { factory = null; }

  const pngs = [];
  for (let i = 1; i <= maxPages; i++) {
    const page = await doc.getPage(i);
    const base = page.getViewport({ scale: 1 });
    const scale = target / (base.width || 1);
    const viewport = page.getViewport({ scale: scale });
    const w = Math.ceil(viewport.width), h = Math.ceil(viewport.height);

    if (factory) {
      try {
        const cc = factory.create(w, h);
        await page.render({ canvasContext: cc.context, viewport: viewport }).promise;
        const png = cc.canvas.toBuffer('image/png');
        try { factory.destroy(cc); } catch (_) {}
        pngs.push(png.toString('base64'));
        continue;
      } catch (_) { factory = null; /* 落到自建 canvas */ }
    }
    const { createCanvas } = await import('@napi-rs/canvas');
    const canvas = createCanvas(w, h);
    const context = canvas.getContext('2d');
    await page.render({ canvasContext: context, viewport: viewport }).promise;
    pngs.push(canvas.toBuffer('image/png').toString('base64'));
  }
  return pngs;
}

// ─── Prompt（移植自 ai_check.py）─────────────────────────

const TEXT_SYSTEM = `你是 CCC/ECE 汽车玻璃合规证书校核助手。任务：从 pdfjs 提取的 PDF 纯文本中，按规则做结构化字段提取，返回 JSON。不要编造，找不到的字段置信度给 low。

## 证书类型识别
- ECE_R43：ECE R43 型式批准（满足任意2条识别特征即识别）
- CCC_SELF_DECL：CCC 强制性认证产品符合性自我声明
- CCC_ATTACHMENT：CCC 产品安全认证证书附件
- UNKNOWN：无法识别

## 字段提取规则
%s

## 输出要求
只返回一个 JSON 对象，不要任何解释文字、不要 markdown 代码块。字段：
{
  "certType": "ECE_R43 | CCC_SELF_DECL | CCC_ATTACHMENT | UNKNOWN",
  "certTypeName": "中文显示名",
  "productName": "提取的产品名称，空则填空字符串",
  "issueDate": "YYYY-MM-DD 格式签发日，无法识别则填空字符串",
  "issueDateRaw": "签发日原文，便于DRE核对",
  "producer": "生产者名称（仅CCC自我声明），无则填空字符串",
  "producerEnterprise": "生产企业名称（仅CCC自我声明），无则填空字符串",
  "confidence": { "certType": "high|medium|low", "productName": "high|medium|low", "issueDate": "high|medium|low", "producer": "high|medium|low" },
  "notes": "任何需提醒DRE的事项"
}

## 关键提醒
- ECE 签发日是第14项 Date 字段，不是展期日期列表、不是 Test date
- 日期必须转成 YYYY-MM-DD（英文月份如 01 January 2025 → 2025-01-01；中文 2025年01月01日 → 2025-01-01）
- CCC 附件无生产者字段，producer/producerEnterprise 填空字符串并在 notes 注明"CCC附件无生产者信息"
- 字段没找到置信度给 low，不要编造值`;

const VISION_SYSTEM = `你是 CCC/ECE 汽车玻璃合规证书校核助手。任务：从证书 PDF 页面图片中，按规则识别字段，返回 JSON。不要编造，看不清的字段置信度给 low。

## 证书类型识别
- ECE_R43：ECE R43 型式批准（含 "Regulation number 43" / "R43" 字样）
- CCC_SELF_DECL：CCC 强制性认证产品符合性自我声明
- CCC_ATTACHMENT：CCC 产品安全认证证书附件
- UNKNOWN：无法识别

## 字段识别规则
%s

## 输出要求
只返回一个 JSON 对象，字段：
{
  "certType": "ECE_R43 | CCC_SELF_DECL | CCC_ATTACHMENT | UNKNOWN",
  "certTypeName": "中文显示名",
  "productName": "识别到的产品名称",
  "issueDate": "YYYY-MM-DD 格式签发日",
  "issueDateRaw": "签发日原文",
  "producer": "生产者名称（仅CCC自我声明）",
  "producerEnterprise": "生产企业名称（仅CCC自我声明）",
  "confidence": { "certType": "high|medium|low", "productName": "high|medium|low", "issueDate": "high|medium|low", "producer": "high|medium|low" },
  "notes": "任何需提醒DRE的事项"
}

## 关键提醒
- ECE 签发日是第14项 "14. Date" 字段，**不是**展期日期列表、不是 "8. Date of report"、不是 Test date
- 页面很多时，签发日可能不在第1页，请在所有页面图片里找
- 日期必须转成 YYYY-MM-DD
- 看不清就给 low 置信度，不要编造值`;

/** 读 references 规则文件（拼接进 system prompt） */
function readRefs() {
  const names = ['ece-r43-fields.md', 'ccc-self-decl-fields.md', 'timeliness-rule.md'];
  const parts = [];
  for (const n of names) {
    try { parts.push(fs.readFileSync(path.join(REFS_DIR, n), 'utf8')); } catch (_) { /* 缺文件不致命 */ }
  }
  return parts.join('\n\n');
}

/** 从 AI 文本容错提取 JSON（移植自 ai_check.py extract_json） */
function extractJSON(text) {
  if (!text) return null;
  const t = String(text).trim();
  try { return JSON.parse(t); } catch (_) { }
  const m = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (m) {
    try { return JSON.parse(m[1].trim()); } catch (_) { }
  }
  const first = t.indexOf('{'), last = t.lastIndexOf('}');
  if (first !== -1 && last > first) {
    try { return JSON.parse(t.slice(first, last + 1)); } catch (_) { }
  }
  return null;
}

// ─── 交叉验证 / 时效 / 报告（移植自 v4.1 index.js）────────

function normalizeDateStr(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  let m = s.match(/(\d{4})[-/年.](\d{1,2})[-/月.](\d{1,2})/);
  if (m) return m[1] + '-' + String(m[2]).padStart(2, '0') + '-' + String(m[3]).padStart(2, '0');
  m = s.match(/(\d{1,2})\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})/i);
  if (m) {
    const months = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 };
    return m[3] + '-' + String(months[m[2].toLowerCase()]).padStart(2, '0') + '-' + String(m[1]).padStart(2, '0');
  }
  m = s.match(/(\d{1,2})\s+(\d{1,2})\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})/i);
  if (m) {
    const months = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 };
    return m[4] + '-' + String(months[m[3].toLowerCase()]).padStart(2, '0') + '-' + String(m[1] + m[2]).padStart(2, '0');
  }
  return null;
}

function normalizeText(s) {
  if (!s) return '';
  return String(s).toLowerCase().replace(/[\s·•\-—_/\\:：()（）"'"`]+/g, '').trim();
}

/** UNKNOWN 等哨兵值视为缺失（v5.2：AI 的"无法识别"不是读数） */
function isSentinel(v) {
  return !v || /^unknown$/i.test(String(v).trim());
}

/** 取第一个非哨兵值 */
function pickFirst() {
  for (const v of arguments) if (!isSentinel(v)) return v;
  return '';
}

/**
 * 单字段交叉验证（v5.1 三态判定，v5.2 哨兵值按缺失处理）
 * status: match | conflict | single-vision | single-text | missing
 * 原则：缺失 ≠ 不一致——单通道自动采用并标注（不人工）；仅真冲突（两通道都有且不同）触发人工。
 */
function crossValidateField(visionVal, scriptVal, isScanned) {
  const a = isSentinel(visionVal) ? '' : normalizeText(visionVal);
  const b = isSentinel(scriptVal) ? '' : normalizeText(scriptVal);
  const base = { vision: isSentinel(visionVal) ? '' : visionVal, script: isSentinel(scriptVal) ? '' : scriptVal };
  if (!a && !b) return Object.assign(base, { status: 'missing', value: '', rule: '两通道均未获取' });
  if (!b) return Object.assign(base, { status: 'single-vision', value: visionVal, rule: isScanned ? '仅视觉（扫描件）' : '单通道(视觉)采用' });
  if (!a) return Object.assign(base, { status: 'single-text', value: scriptVal, rule: '单通道(文本)采用' });
  const containsEither = (b.indexOf(a) !== -1) || (a.indexOf(b) !== -1);
  if (a === b || containsEither) {
    return Object.assign(base, { status: 'match', value: scriptVal, rule: a === b ? '两路一致' : '基本一致（存在包含关系）' });
  }
  return Object.assign(base, { status: 'conflict', value: scriptVal, rule: '两路不一致，以文本为准（需人工确认）' });
}

function timelinessCheck(issueDateStr) {
  if (!issueDateStr) return { ok: false, label: '⚠️ 无法判定时效', months: null };
  const d = new Date(issueDateStr);
  if (isNaN(d.getTime())) return { ok: false, label: '⚠️ 签发日格式无法解析', months: null };
  const now = new Date();
  let months = (now.getFullYear() - d.getFullYear()) * 12 + (now.getMonth() - d.getMonth());
  if (now.getDate() < d.getDate()) months -= 1;
  if (months <= 24) return { ok: true, label: '✅ PASS', months: months };
  return { ok: true, label: '⚠️ 证书签发日已超过2年', months: months, warn: true };
}

function producerConsistencyCheck(fields) {
  if (fields.certType !== 'CCC_SELF_DECL') return { na: true };
  const a = (fields.producer || '').trim();
  const b = (fields.producerEnterprise || '').trim();
  if (!a && !b) return { na: true, reason: '未提取到生产者信息' };
  // v5.2 哲学：非关键字段单通道缺失不告警（缺失≠不一致）
  if (!a || !b) return { na: true, reason: '生产者信息单通道缺失，按缺失处理不告警' };
  if (a === b) return { na: false, consistent: true, label: '✅ 一致' };
  return { na: false, consistent: false, label: '⚠️ 生产者与生产企业不一致，需复核', a: a, b: b };
}

function formatReport(vis, scr, checks, timeliness, producerCheck, todayStr, channelMeta) {
  const isScanned = channelMeta.isScanned;
  const lines = [];

  const dispScript = function (v) { return v || (isScanned ? '扫描件（无文本）' : '—'); };
  const dispConsistent = function (ck) {
    if (ck.status === 'match') return '✅';
    if (ck.status === 'conflict') return '🔴';
    if (ck.status === 'single-vision' || ck.status === 'single-text') return '➕';
    return '—';
  };

  // v5.1 三态判定：缺失≠不一致；仅真冲突/关键字段缺失/扫描件触发人工
  const KEY_FIELDS = ['certType', 'productName', 'issueDate'];
  const FIELD_LABEL = { certType: '证书类型', productName: '产品名称', issueDate: '证书签发日', producer: '生产者' };
  const conflictFields = KEY_FIELDS.filter(function (k) { return checks[k].status === 'conflict'; });
  const missingFields = KEY_FIELDS.filter(function (k) { return checks[k].status === 'missing'; });
  const singleFields = KEY_FIELDS.filter(function (k) { return checks[k].status === 'single-vision' || checks[k].status === 'single-text'; });
  const lowConf = (vis.confidence && Object.values(vis.confidence).some(function (c) { return c === 'low'; })) ||
    (scr.confidence && Object.values(scr.confidence).some(function (c) { return c === 'low'; }));
  const certTypeOk = checks.certType.value && checks.certType.value !== 'UNKNOWN' && checks.certType.status !== 'missing';
  let overall;
  let overallIcon;
  if (isScanned) { overall = '需人工复核（扫描件，仅视觉通道）'; overallIcon = '⚠️'; }
  else if (!certTypeOk) { overall = '需人工复核（证书类型未识别）'; overallIcon = '❌'; }
  else if (missingFields.length > 0) { overall = '需人工复核（关键字段两通道均未获取：' + missingFields.map(function (k) { return FIELD_LABEL[k]; }).join('、') + '）'; overallIcon = '❌'; }
  else if (conflictFields.length > 0) { overall = '需人工复核（两通道真冲突：' + conflictFields.map(function (k) { return FIELD_LABEL[k]; }).join('、') + '）'; overallIcon = '❌'; }
  else if (singleFields.length > 0 || lowConf || timeliness.warn || (!producerCheck.na && !producerCheck.consistent)) { overall = '有提醒项'; overallIcon = '⚠️'; }
  else { overall = '通过'; overallIcon = '✅'; }

  lines.push('# CCC/ECE 证书辅助校核结论');
  lines.push('');
  lines.push('> ' + todayStr + ' · 双通道自动校核（AI 视觉 + 云端文字提取）· 结果为校核参考');

  const certName = checks.certType.value && checks.certType.value !== 'UNKNOWN'
    ? (checks.certType.value === 'ECE_R43' ? 'ECE R43 型式批准' : checks.certType.value)
    : '证书类型未知';
  lines.push('');
  lines.push('### 📋 校核结论');
  lines.push('');
  lines.push('- **证书类型**：' + certName);
  lines.push('- **产品名称**：' + (checks.productName.value || '未提取'));
  lines.push('- **证书签发日**：**' + (checks.issueDate.value || '未提取') + '**' + (timeliness.months != null ? '（距今 ' + timeliness.months + ' 个月）' : ''));
  if (!producerCheck.na && !producerCheck.consistent) {
    lines.push('- **生产者一致性**：' + producerCheck.label);
  }
  lines.push('');
  lines.push('**综合判定**：' + overallIcon + ' **' + overall + '**');
  lines.push('');

  lines.push('### 🔍 双通道交叉验证');
  lines.push('');
  lines.push('| 字段 | 通道A（视觉） | 通道B（文本） | 一致性 | 采用值 |');
  lines.push('|---|---|---|---|---|');
  lines.push('| 证书类型 | ' + (checks.certType.vision || '—') + ' | ' + dispScript(checks.certType.script) + ' | ' + dispConsistent(checks.certType) + ' | ' + (checks.certType.value || '—') + ' |');
  lines.push('| 产品名称 | ' + (checks.productName.vision || '—') + ' | ' + dispScript(checks.productName.script) + ' | ' + dispConsistent(checks.productName) + ' | ' + (checks.productName.value || '—') + ' |');
  lines.push('| 证书签发日 | ' + (checks.issueDate.vision || '—') + ' | ' + dispScript(checks.issueDate.script) + ' | ' + dispConsistent(checks.issueDate) + ' | **' + (checks.issueDate.value || '—') + '** |');
  lines.push('| 生产者 | ' + (checks.producer.vision || '—') + ' | ' + dispScript(checks.producer.script) + ' | ' + dispConsistent(checks.producer) + ' | ' + (checks.producer.value || '—') + ' |');
  lines.push('');

  // ── ④ 真冲突高亮 + 单通道标注（v5.1）──
  if (conflictFields.length > 0) {
    lines.push('### ⚠️ 需要关注的真冲突');
    lines.push('');
    lines.push('以下字段两通道读取不一致（**以文本通道为准**，请 DRE 对照原始 PDF 确认）：');
    lines.push('');
    conflictFields.forEach(function (k) {
      const ck = checks[k];
      lines.push('- 🔴 **' + FIELD_LABEL[k] + '**：视觉=`' + ck.vision + '` vs 文本=`' + ck.script + '`');
    });
    lines.push('');
  }
  if (singleFields.length > 0) {
    lines.push('### ➕ 单通道字段（自动采用，无需人工）');
    lines.push('');
    lines.push('以下字段仅一个通道提取到（另一通道信息缺失，嵌图/扫描类 PDF 属正常现象）：');
    lines.push('');
    singleFields.forEach(function (k) {
      const ck = checks[k];
      lines.push('- ' + FIELD_LABEL[k] + '（来自' + (ck.status === 'single-vision' ? '视觉' : '文本') + '通道）');
    });
    lines.push('');
  }
  if (isScanned) {
    lines.push('### ⚠️ 说明');
    lines.push('');
    lines.push('该 PDF **文字提取通道未获取有效信息**（扫描件或文本层不完整），以下结果**仅基于 AI 视觉识别**。所有字段需人工对照原始 PDF 复核。');
    lines.push('');
  }

  lines.push('### ⏱ 时效判定');
  lines.push('');
  lines.push('- 签发日 ' + (checks.issueDate.value || '—') + '，' + timeliness.label + (timeliness.warn ? '（>2 年，需关注）' : ''));
  lines.push('');

  lines.push('### 🔧 通道状态');
  lines.push('');
  if (channelMeta.visualFailed) lines.push('- ⚠️ 视觉通道不可用，仅文本单通道结果');
  else if (isScanned) lines.push('- ⚠️ 扫描件/文本层不完整，仅视觉通道有效');
  else lines.push('- ✅ 视觉 + 文本双通道均正常');
  if (channelMeta.visualErr) lines.push('- 🔎 视觉诊断：' + channelMeta.visualErr);
  if (channelMeta.textErr) lines.push('- 🔎 文本诊断：' + channelMeta.textErr);
  lines.push('');

  if (vis.notes || scr.notes) {
    const notes = [vis.notes, scr.notes].filter(Boolean).join('；');
    lines.push('### 📝 备注');
    lines.push('');
    lines.push(notes);
    lines.push('');
  }

  lines.push('### ✅ DRE 确认清单');
  lines.push('');
  let todoCount = 0;
  if (isScanned) {
    lines.push('- [ ] 🔴 扫描件，所有字段已人工对照原始 PDF 复核');
    todoCount++;
  }
  if (conflictFields.length > 0) {
    lines.push('- [ ] 🔴 真冲突字段已人工确认采用值：' + conflictFields.map(function (k) { return FIELD_LABEL[k]; }).join('、'));
    todoCount++;
  }
  if (missingFields.length > 0) {
    lines.push('- [ ] 🔴 两通道均未获取的字段已人工补录：' + missingFields.map(function (k) { return FIELD_LABEL[k]; }).join('、'));
    todoCount++;
  }
  if (!producerCheck.na && !producerCheck.consistent) {
    lines.push('- [ ] 生产者一致性：' + producerCheck.label + '（' + (producerCheck.a || '—') + ' vs ' + (producerCheck.b || '—') + '）');
    todoCount++;
  }
  if (checks.certType.value === 'CCC_ATTACHMENT') {
    lines.push('- [ ] （CCC 附件）已确认配套自我声明');
    todoCount++;
  }
  if (todoCount === 0) {
    lines.push('- （无人工确认项，本结果为自动校核参考）');
  }
  lines.push('');

  return lines.join('\n');
}

// ─── 主入口 ────────────────────────────────────────────

exports.run = async function (params) {
  // ① 输入校验（纯云端）
  const uploadB64 = String(params.pdfBase64 || '').replace(/\s+/g, '');
  if (!uploadB64) return { error: '请上传证书 PDF 文件' };
  let buf;
  try { buf = Buffer.from(uploadB64, 'base64'); }
  catch (e) { return { error: '非法 base64：' + e.message }; }
  if (!buf.length) return { error: 'PDF 内容为空' };
  if (buf.length > MAX_PDF_BYTES) return { error: 'PDF 超过 ' + (MAX_PDF_BYTES / 1024 / 1024) + 'MB 限制' };
  if (buf.slice(0, 5).toString('latin1') !== '%PDF-') return { error: '不是有效的 PDF（缺少 %PDF 头）' };

  // ② 模型选择
  const visionModel = String(params.visionModel || process.env.AI_VISION_MODEL || 'qwen2.5vl:7b');
  const textModel = String(params.textModel || process.env.AI_TEXT_MODEL || 'qwen2.5:14b');
  const refs = readRefs();

  // ③ pdfjs 加载 + 打开
  let pdfjs, doc;
  try {
    const loaded = await loadPdfjs();
    pdfjs = loaded.pdfjs;
    const docParams = { data: new Uint8Array(buf) };
    // 标准字体数据（未内嵌字体的 PDF 渲染必需，否则文字空白——容器 6.0.227 实测相关）
    if (loaded.fontsUrl) docParams.standardFontDataUrl = loaded.fontsUrl;
    doc = await pdfjs.getDocument(docParams).promise;
  } catch (e) {
    if (e && e.name === 'PasswordException') return { error: 'PDF 受密码保护，无法解析' };
    return { error: 'PDF 解析不可用：' + e.message };
  }

  // ④ 通道B：文本提取
  let extracted = '', scanned = false, parseErr = null;
  try {
    const t = await extractText(doc);
    extracted = t.extracted;
    scanned = t.scanned;
  } catch (e) { parseErr = e.message; }

  // ⑤ 通道A：渲染（可降级）
  let pngs = [], visualFailed = false, visualErr = null;
  try {
    pngs = await renderPagesToPng(doc, VISION_PAGE_LIMIT, VISION_WIDTH_PX);
    if (!pngs.length) { visualFailed = true; visualErr = '渲染 0 页'; }
  } catch (e) {
    visualFailed = true;
    visualErr = e.message;
  }

  // ⑥ 双 AI 并行
  const textOutcome = { data: null, err: parseErr };
  const visOutcome = { data: null, err: visualErr };

  await Promise.all([
    (async function () {
      if (scanned || parseErr) return;   // 扫描件无文本 / 解析失败 → 不调文本 AI
      try {
        const aiText = await callOllamaAI({
          model: textModel,
          system: TEXT_SYSTEM.replace('%s', refs),
          prompt: '以下是用 pdfjs 从证书 PDF 逐页提取的纯文本（=== PAGE N === 为页标记）。\n请按规则提取字段并返回 JSON。\n\n' + extracted,
        });
        const parsed = extractJSON(aiText);
        if (parsed) textOutcome.data = parsed;
        else textOutcome.err = '文本 AI 有返回但 JSON 解析失败，原文前200字: ' + (aiText || '(空)').slice(0, 200);
      } catch (e) { textOutcome.err = e.message; }
    })(),
    (async function () {
      if (visualFailed || !pngs.length) return;
      try {
        const aiText = await callOllamaAI({
          model: visionModel,
          system: VISION_SYSTEM.replace('%s', refs),
          prompt: '以下是证书 PDF 的前 ' + pngs.length + ' 页渲染图。\n请按规则识别证书字段并返回 JSON。\n⚠️ ECE 签发日是第14项 "14. Date"，不要选展期日期、Test date 或 "Date of report"。',
          images: pngs,
          timeoutMs: 180000,
        });
        const parsed = extractJSON(aiText);
        if (parsed) visOutcome.data = parsed;
        else visOutcome.err = '视觉 AI 有返回但 JSON 解析失败，原文前200字: ' + (aiText || '(空)').slice(0, 200);
      } catch (e) { visOutcome.err = e.message; }
    })(),
  ]);

  const scr = textOutcome.data;
  const vis = visOutcome.data;

  // 双通道全失败且非扫描件 → 带诊断返回（坑#8）
  if (!scr && !vis && !scanned) {
    return {
      error: '双通道均失败。\n- 文本通道：' + (textOutcome.err || '(无结果)') + '\n- 视觉通道：' + (visOutcome.err || '(无结果)') +
        '\n\n请重试；若持续失败，将本错误反馈工具开发者。',
    };
  }

  // ⑦ 交叉验证 + 时效 + 报告
  // v5.2：文本 AI 有返回但关键字段全空/全哨兵 → 文本实质无信息，按扫描件语义（仅视觉+人工）
  const textEmpty = !!scr && isSentinel(scr.certType) && !scr.productName && !scr.issueDate;
  const isScanned = scanned || (textEmpty && !!vis);
  const scrDate = normalizeDateStr(scr && scr.issueDate);
  const visDate = normalizeDateStr(vis && vis.issueDate);
  const scrDateRaw = (scr && scr.issueDateRaw) || (scr && scr.issueDate);
  const visDateRaw = (vis && vis.issueDateRaw) || (vis && vis.issueDate);

  const checks = {
    certType: crossValidateField(vis && vis.certType, scr && scr.certType, isScanned),
    productName: crossValidateField(vis && vis.productName, scr && scr.productName, isScanned),
    issueDate: {
      status: (scrDate && visDate) ? (scrDate === visDate ? 'match' : 'conflict') : (scrDate ? 'single-text' : (visDate ? 'single-vision' : 'missing')),
      value: scrDate || visDate || '',
      vision: visDateRaw || '',
      script: scrDateRaw || '',
      rule: (scrDate && visDate) ? (scrDate === visDate ? '两路一致' : '两路不一致，以文本为准（需人工确认）') : (scrDate ? '单通道(文本)采用' : (visDate ? '单通道(视觉)采用' : '两通道均未获取')),
    },
    producer: crossValidateField(vis && vis.producer, scr && scr.producer, isScanned),
  };
  const normV = isSentinel(checks.certType.vision) ? '' : normalizeText(checks.certType.vision);
  const normS = isSentinel(checks.certType.script) ? '' : normalizeText(checks.certType.script);
  if (normV && normS) {
    checks.certType.status = (normV === normS) ? 'match' : 'conflict';
    checks.certType.rule = checks.certType.status === 'match' ? '两路一致' : '两路不一致，以文本为准（需人工确认）';
  }
  checks.certType.value = pickFirst(scr && scr.certType, vis && vis.certType);

  const combined = {
    certType: pickFirst(scr && scr.certType, vis && vis.certType) || 'UNKNOWN',
    certTypeName: (scr && scr.certTypeName) || (vis && vis.certTypeName) || '',
    productName: checks.productName.value,
    issueDate: scrDate || visDate || '',
    issueDateRaw: scrDateRaw || visDateRaw || '',
    producer: (scr && scr.producer) || (vis && vis.producer) || '',
    producerEnterprise: (scr && scr.producerEnterprise) || (vis && vis.producerEnterprise) || '',
    confidence: (scr && scr.confidence) || (vis && vis.confidence) || {},
    notes: [vis && vis.notes, scr && scr.notes].filter(Boolean).join('；'),
  };

  const timeliness = timelinessCheck(combined.issueDate);
  const producerCheck = producerConsistencyCheck(combined);
  const todayStr = new Date().toISOString().slice(0, 10);

  const report = formatReport(vis || {}, scr || {}, checks, timeliness, producerCheck, todayStr, {
    visualFailed: visualFailed || !!visOutcome.err,
    isScanned: isScanned,
    visualErr: visOutcome.err,
    textErr: textOutcome.err,
  });

  // ⑧ outputs
  return {
    result: {
      source: 'panel-upload',
      engine: 'cloud-pdfjs',
      pdfjsSrc: _pdfjs ? _pdfjs.src : 'none',
      fileName: String(params.pdfName || '').trim() || 'cert.pdf',
      fileSizeKB: Math.round(buf.length / 1024),
      visionModel: visionModel,
      textModel: textModel,
      scanned: isScanned,
      visionFailed: visualFailed || !!visOutcome.err,
      certType: combined.certType,
      certTypeName: combined.certTypeName,
      productName: combined.productName,
      issueDate: combined.issueDate,
      producer: combined.producer,
      timeliness: timeliness.label,
      monthsSinceIssue: timeliness.months,
      confidence: combined.confidence,
      notes: combined.notes,
      crossValidation: {
        certType: checks.certType.status !== 'conflict' && checks.certType.status !== 'missing',
        productName: checks.productName.status !== 'conflict' && checks.productName.status !== 'missing',
        issueDate: checks.issueDate.status !== 'conflict' && checks.issueDate.status !== 'missing',
        noConflict: ['certType', 'productName', 'issueDate'].every(function (k) { return checks[k].status !== 'conflict'; }),
        fieldStatus: {
          certType: checks.certType.status,
          productName: checks.productName.status,
          issueDate: checks.issueDate.status,
        },
        visionFailed: visualFailed || !!visOutcome.err,
      },
    },
    report: report,
  };
};

// 本地测试钩子（平台无副作用）
exports._internal = { loadPdfjs: loadPdfjs, extractText: extractText, renderPagesToPng: renderPagesToPng, callOllamaAI: callOllamaAI, extractJSON: extractJSON };
