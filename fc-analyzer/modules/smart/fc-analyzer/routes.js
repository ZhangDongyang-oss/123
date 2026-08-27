/**
 * FC Analyzer — Express Router Module
 *
 * 模块ID: fc-analyzer
 * 所属分组: exterior (外饰组)
 * 一句话描述: 灯具FC问题智能分析工具 — AI字段提取 + 历史案例检索 + VIIM工单管理
 *
 * Platform: 车身外饰部工程平台
 * Auth: req.user provided by platform middleware (open_id, name, department, avatar)
 * AI: aiChat from shared/ai-proxy (MIFY platform, acme-auto/ollama-v2.5-pro)
 */

'use strict';

const express = require('express');
const path = require('path');
const router = express.Router();

// Platform capabilities — from modules/smart/fc-analyzer/ → 3 levels up to project root
const { aiChat } = require('../../../shared/ai-proxy');
const { FEISHU_APP_ID, FEISHU_APP_SECRET } = require('../../../shared/auth');
const db = require('../../../shared/db');

// Module internals
const { VIIMClient } = require('./lib/viim-client');
const { extractFields, generateReport, formatReportMarkdown, buildAdviceContext } = require('./lib/analyzer');
const { searchSimilarIssues, keywordSearch, loadCorpus } = require('./lib/search-engine');
const { PATHS, loadJson, saveJson, loadCollection, appendToCollection, removeFromCollection, updateInCollection, DATA_DIR } = require('./lib/storage');
const { trackIssue, updateIssueStatus, checkAlerts, getManagementDashboard, getFollowupReminders, formatDashboardMarkdown, formatRemindersMarkdown } = require('./lib/tracker');
const { FIELDS, SEVERITY_MAP, DEFAULT_TEMPLATE, STATUS, STATUS_CLOSED } = require('./lib/constants');

/* ============================================================
 *  Helpers
 * ============================================================ */

const log = console;

function userId(req) {
  return req.user?.open_id || req.user?.name || 'anonymous';
}

function userName(req) {
  return req.user?.name || '未知用户';
}

function userDept(req) {
  return req.user?.department || '';
}

/** Build a VIIM client from env or user-stored token */
function getViimClient() {
  const url = process.env.VIIM_URL;
  const token = process.env.VIIM_API_TOKEN;
  if (!url || !token) return null;
  try { return new VIIMClient(token, url); }
  catch { return null; }
}

/* ============================================================
 *  API — User Info
 * ============================================================ */

router.get('/api/me', (req, res) => {
  res.json({
    open_id: req.user?.open_id || '',
    name: req.user?.name || '',
    department: req.user?.department || '',
    avatar: req.user?.avatar || '',
  });
});

/* ============================================================
 *  API — Analyze (核心分析接口)
 * ============================================================ */

router.post('/api/analyze', async (req, res) => {
  const { text, query, area, severity, phase } = req.body || {};
  const input = text || query || '';
  if (!input.trim()) {
    return res.status(400).json({ error: '请输入FC问题描述' });
  }

  try {
    // Step 1: AI field extraction
    const fields = await extractFields(input, aiChat);

    // Step 2: Search similar cases
    const hits = searchSimilarIssues(input, {
      area: fields.area || area,
      top: 5,
      minScore: 0.03,
    });

    // Step 3: Generate report
    const report = generateReport(hits, input, fields.area || area, fields.severity || severity, fields.phase || phase);

    // Step 4: Build response
    const adviceContext = buildAdviceContext(report, hits, input, fields.severity, 'local');
    const reportMd = formatReportMarkdown(report);

    res.json({
      fields,
      hits,
      report,
      report_markdown: reportMd,
      advice_context: adviceContext,
      hit_count: hits.length,
    });
  } catch (e) {
    log.error('[/api/analyze] Error:', e.message);
    res.status(500).json({ error: '分析失败: ' + e.message });
  }
});

/* ============================================================
 *  API — Dry Run (快速预览，仅本地搜索)
 * ============================================================ */

router.post('/api/dryrun', async (req, res) => {
  const { text } = req.body || {};
  if (!text) return res.status(400).json({ error: '请输入描述' });

  try {
    const fields = await extractFields(text, aiChat);
    const hits = searchSimilarIssues(text, { top: 5 });
    res.json({ fields, hits, hit_count: hits.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ============================================================
 *  API — Submit to VIIM
 * ============================================================ */

router.post('/api/submit', async (req, res) => {
  const { summary, description, fields, payload: directPayload } = req.body || {};

  const client = getViimClient();
  if (!client) {
    return res.status(500).json({ error: 'VIIM未配置，请联系管理员设置 VIIM_URL 和 VIIM_API_TOKEN' });
  }

  try {
    let payload;
    if (directPayload) {
      payload = directPayload;
    } else if (fields) {
      payload = client.buildPayload(fields, summary || fields.summary, description || fields.description);
    } else {
      return res.status(400).json({ error: '缺少提交数据' });
    }

    const result = await client.createIssue(
      payload.summary,
      payload.description,
      payload.additional_fields,
      payload.project
    );

    // Save to submissions
    const record = {
      key: result.key,
      url: result.url,
      summary: payload.summary,
      fields,
      payload,
      submitted_by: userId(req),
      submitted_at: new Date().toISOString(),
    };
    appendToCollection(PATHS.submissions, record);

    // Auto-track
    trackIssue(payload.summary, fields, result.key, STATUS.SUBMITTED, userId(req));

    res.json({ success: true, key: result.key, url: result.url });
  } catch (e) {
    log.error('[/api/submit] Error:', e.message);
    res.status(e.code || 500).json({ error: e.message });
  }
});

/* ============================================================
 *  API — Search Cases
 * ============================================================ */

router.get('/api/search', (req, res) => {
  const { q, area, top } = req.query;
  if (!q) return res.status(400).json({ error: '请输入搜索关键词' });

  const results = searchSimilarIssues(q, {
    area,
    top: parseInt(top) || 10,
  });

  res.json({ results, total: results.length });
});

router.get('/api/cases/stats', (req, res) => {
  const corpus = loadCorpus();
  const areas = {};
  for (const c of corpus) {
    const a = c.area || '未知';
    areas[a] = (areas[a] || 0) + 1;
  }
  res.json({ total: corpus.length, areas });
});

/* ============================================================
 *  API — VIIM Issue Detail
 * ============================================================ */

router.get('/api/issue/:key', async (req, res) => {
  const { key } = req.params;

  // Check local cases first
  const corpus = loadCorpus();
  const local = corpus.find(c => c.key === key);
  if (local) return res.json(local);

  // Try VIIM
  const client = getViimClient();
  if (client) {
    try {
      const issue = await client.getIssue(key);
      if (issue) return res.json(issue);
    } catch (e) {
      log.error(`[/api/issue/${key}] VIIM error:`, e.message);
    }
  }

  res.status(404).json({ error: '工单未找到' });
});

/* ============================================================
 *  API — Track & Status
 * ============================================================ */

router.post('/api/track', (req, res) => {
  const { text, fields, viim_key, status } = req.body || {};
  const id = trackIssue(text || '', fields || {}, viim_key || '', status, userId(req));
  res.json({ success: true, id });
});

router.get('/api/tracking', (req, res) => {
  const issues = loadCollection(PATHS.tracking);
  const uid = userId(req);

  // Filter: default show all, ?mine=1 for only user's issues
  const mine = req.query.mine === '1';
  const filtered = mine ? issues.filter(i => i.assigned_to === uid || i.created_by === uid) : issues;

  res.json({ issues: filtered, total: filtered.length });
});

router.post('/api/track/:id/status', (req, res) => {
  const { status, note } = req.body || {};
  if (!status) return res.status(400).json({ error: '请提供新状态' });

  const ok = updateIssueStatus(req.params.id, status, note);
  res.json({ success: ok });
});

/* ============================================================
 *  API — Reminders
 * ============================================================ */

router.get('/api/reminders', (req, res) => {
  const reminders = getFollowupReminders();
  res.json({ reminders, total: reminders.length });
});

router.get('/api/alerts', (req, res) => {
  const alerts = checkAlerts();
  res.json({ alerts, total: alerts.length });
});

/* ============================================================
 *  API — Dashboard
 * ============================================================ */

router.get('/api/dashboard', (req, res) => {
  const dashboard = getManagementDashboard();
  res.json(dashboard);
});

/* ============================================================
 *  API — Report Check (报告完整性检查)
 * ============================================================ */

router.get('/api/report-check', async (req, res) => {
  const { template, source, assignee, overdue } = req.query;

  const templateDef = loadJson(PATHS.patterns, DEFAULT_TEMPLATE);
  const issues = loadCollection(PATHS.tracking);
  const submissions = loadCollection(PATHS.submissions);
  const drafts = loadCollection(PATHS.drafts);

  // Combine all issues
  let allIssues = [];

  // From tracking
  for (const issue of issues) {
    allIssues.push({
      key: issue.viim_key || issue.id,
      summary: issue.fc_text || '',
      status: issue.status || '',
      status_category: classifyStatus(issue.status || ''),
      completeness: 0.5,
      missing: [],
      source: 'tracking',
      owners: [issue.assigned_to || ''],
      days_open: Math.floor((Date.now() - new Date(issue.created_at)) / 86400000),
    });
  }

  // From submissions
  for (const sub of submissions) {
    const fields = sub.fields || sub.payload?.additional_fields || {};
    allIssues.push({
      key: sub.key || '',
      summary: sub.summary || '',
      status: '已提交',
      status_category: '处理中',
      completeness: 0.8,
      missing: [],
      source: 'submission',
      owners: [sub.submitted_by || ''],
      days_open: Math.floor((Date.now() - new Date(sub.submitted_at)) / 86400000),
    });
  }

  // Filter
  if (assignee) {
    allIssues = allIssues.filter(i =>
      i.owners.some(o => o.includes(assignee))
    );
  }
  if (overdue === '1') {
    allIssues = allIssues.filter(i => i.days_open > 14 && i.status_category !== '完成');
  }

  const summary = {
    total: allIssues.length,
    complete: allIssues.filter(i => i.completeness >= 1).length,
    incomplete: allIssues.filter(i => i.completeness < 1).length,
  };

  const statusCounts = {};
  for (const i of allIssues) {
    const cat = i.status_category || '未知';
    statusCounts[cat] = (statusCounts[cat] || 0) + 1;
  }

  res.json({ template: templateDef, source: source || 'all', summary, status_counts: statusCounts, issues: allIssues });
});

function classifyStatus(status) {
  if (STATUS_CLOSED.includes(status)) return '完成';
  if (['处理中', '待验证', '已重新打开'].includes(status)) return '处理中';
  if (['待分配', '待处理', '待确认', '待评审', '待关闭', '遗留'].includes(status)) return '待办';
  if (status === '本地') return '本地';
  return '未知';
}

/* ============================================================
 *  API — Drafts
 * ============================================================ */

router.post('/api/draft', (req, res) => {
  const { text, fields, report } = req.body || {};
  const draft = {
    id: 'dft_' + Date.now().toString(36),
    text: text || '',
    fields: fields || {},
    report: report || null,
    created_by: userId(req),
    created_at: new Date().toISOString(),
  };
  appendToCollection(PATHS.drafts, draft);
  res.json({ success: true, id: draft.id });
});

router.get('/api/drafts', (req, res) => {
  const drafts = loadCollection(PATHS.drafts);
  const uid = userId(req);
  const mine = req.query.mine === '1';
  const filtered = mine ? drafts.filter(d => d.created_by === uid) : drafts;
  res.json({ drafts: filtered, total: filtered.length });
});

router.delete('/api/draft/:id', (req, res) => {
  const ok = removeFromCollection(PATHS.drafts, d => d.id === req.params.id);
  res.json({ success: ok });
});

/* ============================================================
 *  API — History (drafts + submissions combined)
 * ============================================================ */

router.get('/api/history', (req, res) => {
  const drafts = loadCollection(PATHS.drafts).map(d => ({
    ...d,
    type: 'draft',
    key: d.id,
    created_at: d.created_at,
  }));

  const submissions = loadCollection(PATHS.submissions).map(s => ({
    ...s,
    type: 'submission',
    created_at: s.submitted_at,
  }));

  const all = [...drafts, ...submissions]
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  const uid = userId(req);
  const mine = req.query.mine === '1';
  const filtered = mine
    ? all.filter(i => i.created_by === uid || i.submitted_by === uid)
    : all;

  res.json({ items: filtered, total: filtered.length });
});

/* ============================================================
 *  API — Feedback
 * ============================================================ */

router.post('/api/feedback', (req, res) => {
  const { text, extracted, corrections, viim_key } = req.body || {};
  if (!text || !corrections) {
    return res.status(400).json({ error: '请提供原始文本和修正数据' });
  }

  const feedback = {
    id: 'fb_' + Date.now().toString(36),
    timestamp: new Date().toISOString(),
    fc_text: text,
    extracted: extracted || {},
    corrections,
    diffs: computeDiffs(extracted || {}, corrections),
    user_id: userId(req),
    viim_key: viim_key || '',
    learning_applied: false,
  };

  appendToCollection(PATHS.feedback, feedback);
  res.json({ success: true, id: feedback.id });
});

router.get('/api/feedback/cases', (req, res) => {
  const feedbacks = loadCollection(PATHS.feedback);
  res.json({ feedbacks, total: feedbacks.length });
});

router.delete('/api/feedback/:id', (req, res) => {
  const ok = removeFromCollection(PATHS.feedback, f => f.id === req.params.id);
  res.json({ success: ok });
});

function computeDiffs(extracted, corrections) {
  const diffs = {};
  for (const [key, corrected] of Object.entries(corrections)) {
    const original = extracted[key] || '';
    if (String(original) !== String(corrected)) {
      diffs[key] = { original, corrected };
    }
  }
  return diffs;
}

/* ============================================================
 *  API — Stats
 * ============================================================ */

router.get('/api/stats', (req, res) => {
  const feedbacks = loadCollection(PATHS.feedback);
  const total = feedbacks.length;
  const withDiffs = feedbacks.filter(f => Object.keys(f.diffs || {}).length > 0);
  const accuracy = total > 0 ? ((total - withDiffs.length) / total * 100).toFixed(1) : 'N/A';

  res.json({
    total_feedbacks: total,
    with_corrections: withDiffs.length,
    accuracy: accuracy + '%',
  });
});

/* ============================================================
 *  API — Data Files (for data migration from Python version)
 * ============================================================ */

router.post('/api/import', (req, res) => {
  const { type, data } = req.body || {};
  if (!type || !data) return res.status(400).json({ error: '缺少type或data' });

  const validTypes = { cases: PATHS.cases, tracking: PATHS.tracking, drafts: PATHS.drafts, submissions: PATHS.submissions };
  if (!validTypes[type]) return res.status(400).json({ error: '无效类型' });

  try {
    const existing = loadCollection(validTypes[type]);
    const merged = [...existing, ...(Array.isArray(data) ? data : [data])];
    saveJson(validTypes[type], merged);
    res.json({ success: true, imported: Array.isArray(data) ? data.length : 1, total: merged.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ============================================================
 *  Static files (MUST be last)
 * ============================================================ */

router.use(express.static(path.join(__dirname, 'public')));
router.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

module.exports = router;
