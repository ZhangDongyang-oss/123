/**
 * 竞对专利风险分析 —— 全云版后端（v3.4，前后端结合）
 *
 * 形态：前端（panel.html 表单+进度+报告渲染）+ 后端，**纯云端**——无 hw-local。
 *
 * 搜索链路: Exa MCP 端点(多轮检索) → Ollama AI(风险分级) → 智慧芽 Backup(兜底)
 * 用户零配置：Exa 匿名免费，AI key 全靠平台 lib/ai 自动注入（见 getAiConfig）。
 *
 * ⚠️ v3.4 架构决策（基于 probe_patent_egress v2 实测，2026-08-06）：
 *   云环境**没有任何一条专利详情读取链路可用**——
 *   ① Jina Reader (r.jina.ai) 云端出公网超时（阻断）
 *   ② web_fetch_exa × Google Patents → CRAWL_NOT_FOUND（反爬）
 *   ③ web_fetch_exa × FreePatentsOnline → CRAWL_UNKNOWN_ERROR
 *   ④ web_fetch_exa × WIPO → 仅 JS 壳，无内容
 *   因此 v3.3 的「Round 2: Jina 读详情」整步砍掉。改为：Exa 多轮检索的 highlights
 *   （标题+语义摘要+状态关键词）直接喂 AI 做风险分级。Exa 是语义搜索引擎，highlights
 *   本就是最相关片段，足以支撑按技术方向聚类/标风险等级/识别空白区。全文详情是本地版
 *   （有 Jina）的锦上添花，云端拿不到时不影响风险分级主链路。
 *
 * v3.4 其他改进：
 * - **AI 模型显式指派**：manifest 加 aiModel select（默认 acme-auto/qwen2.5:14b，probe 实测
 *   Supported；平台默认的 qwen2.5:7b 反而 Unsupported）。run() 读 params.aiModel 传入 callOllamaAI。
 * - **加 panel.html**：表单 + 阶段进度 + 报告渲染 + 复制/下载。动态 TOOL_ID（坑#1 铁律）。
 *
 * v3.3 及更早改进见 git 历史（v3.3 零配置、v3.2 AI 调用迁移、v3.1 多轮精炼、v3 Exa 免费化）。
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

// ─── AI 配置（对齐 ccc_ece_check_cloud 全云版）────────

const AI_MAX_TOKENS = parseInt(process.env.AI_MAX_TOKENS || '8192', 10);

/**
 * 平台 lib/ai 模块优先（云端自动注入 key），失败回落 env（本地测试天然走 env）。
 * probe 实测：AI_BASE_URL=http://localhost:11434/v1/chat/completions（明文 http，无 TLS 坑）。
 */
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

/** 把 base 规整成 Anthropic Messages 端点（/v1/chat/completions → /anthropic/v1/messages） */
function toAnthropicBase(base) {
  const b = String(base || '');
  if (b.endsWith('/v1/messages')) return b;
  return b.replace(/\/v1\/chat\/completions$/, '/anthropic') + '/v1/messages';
}

// ─── Exa MCP 端点（匿名免费，无需 key）──────────────
const EXA_MCP_HOST = process.env.EXA_MCP_HOST || 'mcp.exa.ai';
const EXA_MCP_PATH = process.env.EXA_MCP_PATH || '/mcp';

// ─── Exa 多轮检索参数（对齐本地 SKILL Step 2）────────
const EXA_TARGET_PATENTS = parseInt(process.env.EXA_TARGET_PATENTS || '5', 10);
const EXA_MIN_PATENTS = parseInt(process.env.EXA_MIN_PATENTS || '3', 10);
const EXA_MAX_ROUNDS = parseInt(process.env.EXA_MAX_ROUNDS || '3', 10);
const EXA_NUM_RESULTS = parseInt(process.env.EXA_NUM_RESULTS || '8', 10);

const TOOL_DIR = __dirname;
const REFS_DIR = path.join(TOOL_DIR, 'references');

// ─── Exa MCP（匿名免费端点）──────────────────────────

/** MCP JSON-RPC 单次请求，返回 {status, headers, body} */
function mcpRequest(payload, sessionId) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'Content-Length': Buffer.byteLength(body),
    };
    if (sessionId) headers['Mcp-Session-Id'] = sessionId;
    const req = https.request({
      hostname: EXA_MCP_HOST, port: 443, path: EXA_MCP_PATH, method: 'POST', headers
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    req.setTimeout(60000, () => { req.destroy(); reject(new Error('Exa MCP 请求超时(60s)')); });
    req.write(body);
    req.end();
  });
}

/** 从 SSE（data: 行）或纯 JSON 响应中解析出 JSON-RPC 消息 */
function parseMcpBody(body) {
  const dataLines = String(body || '').split('\n')
    .filter(l => l.startsWith('data:'))
    .map(l => l.slice(5).trim());
  for (const d of dataLines) {
    try {
      const j = JSON.parse(d);
      if (j && (j.result !== undefined || j.error)) return j;
    } catch (_) { /* 继续找下一行 */ }
  }
  try { return JSON.parse(body); } catch (_) { return null; }
}

/**
 * 解析 Exa MCP 返回的纯文本结果为 {results:[{title,url,text}]}
 * MCP 文本格式（每条一块，块间空行分隔）：Title / URL / Published / Author / Highlights
 */
function parseExaMcpText(text) {
  const results = [];
  const blocks = String(text || '').split(/\n{2,}(?=Title: )/);
  for (const block of blocks) {
    const titleM = block.match(/^Title:\s*(.+)$/m);
    const urlM = block.match(/^URL:\s*(.+)$/m);
    if (!titleM && !urlM) continue;
    const hiIdx = block.indexOf('Highlights:');
    const highlights = hiIdx !== -1 ? block.slice(hiIdx + 'Highlights:'.length).trim() : '';
    results.push({
      title: titleM ? titleM[1].trim() : '',
      url: urlM ? urlM[1].trim() : '',
      text: highlights || block.trim(),
    });
  }
  return { results };
}

/**
 * 通过 Exa MCP 端点搜索专利（匿名免费，无需 API key）
 * 流程: initialize(拿 session) → notifications/initialized → tools/call web_search_exa
 */
async function searchExa(query, numResults) {
  const init = await mcpRequest({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'patent-risk-analysis', version: '3.0' }
    }
  });
  if (init.status !== 200) throw new Error(`Exa MCP initialize 返回 ${init.status}`);
  const sessionId = init.headers['mcp-session-id'];

  await mcpRequest({ jsonrpc: '2.0', method: 'notifications/initialized' }, sessionId);

  const call = await mcpRequest({
    jsonrpc: '2.0', id: 2, method: 'tools/call',
    params: { name: 'web_search_exa', arguments: { query, numResults: numResults || 8 } }
  }, sessionId);
  if (call.status !== 200) throw new Error(`Exa MCP tools/call 返回 ${call.status}`);

  const msg = parseMcpBody(call.body);
  if (!msg) throw new Error('Exa MCP 响应解析失败: ' + String(call.body).slice(0, 200));
  if (msg.error) throw new Error('Exa MCP 错误: ' + JSON.stringify(msg.error).slice(0, 200));

  const text = ((msg.result && msg.result.content) || [])
    .filter(c => c.type === 'text')
    .map(c => c.text)
    .join('\n');
  return parseExaMcpText(text);
}

// ─── Ollama AI（对齐 ccc_ece_check_cloud 全云版 callOllamaAI）───

/**
 * 统一 AI 调用（Anthropic Messages 兼容，明文 http，x-api-key）
 * v3.4：model 由调用方显式传入（manifest aiModel select），不再依赖 lib/ai 默认值。
 * 过滤 reasoning 模型的 thinking 块（只取 type==='text'）。
 */
async function callOllamaAI(opts) {
  const ai = getAiConfig();
  const key = opts.key || ai.key;
  if (!key) throw new Error('未配置 AI key（lib/ai 或 AI_KEY/OLLAMA_KEY）');
  const anthBase = toAnthropicBase(opts.base || ai.base);
  const model = opts.model || ai.defaultModel;   // v3.4：run() 总是传 model，此回落仅防御

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs || 180000);
  try {
    const resp = await fetch(anthBase, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01', 'x-api-key': key },
      body: JSON.stringify({
        model,
        max_tokens: opts.maxTokens || AI_MAX_TOKENS,
        system: opts.system || '你是专利分析助手',
        messages: [{ role: 'user', content: opts.prompt }],
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
    const texts = blocks.filter(b => b.type === 'text' && b.text).map(b => b.text);
    if (!texts.length) throw new Error('AI 响应无 text 块（blockTypes=' + blocks.map(b => b.type).join(',') + '）');
    return texts.join('\n').trim();
  } finally {
    clearTimeout(timer);
  }
}

// ─── 辅助 ────────────────────────────────────────────

/** 从 Exa 返回结果中提取专利号列表（去重） */
function extractPatentIds(exaResults) {
  if (!exaResults || !exaResults.results) return [];
  const ids = new Set();
  for (const r of exaResults.results) {
    const text = (r.text || '') + ' ' + (r.title || '') + ' ' + (r.url || '');
    const cnMatches = text.match(/\bCN\d{7,9}[ABU]?\b/gi) || [];
    const usMatches = text.match(/\bUS\d{7,11}[AB]\d?\b/gi) || [];
    const epMatches = text.match(/\bEP\d{7,9}[AB]\d?\b/gi) || [];
    const woMatches = text.match(/\bWO\d{7,9}[AB]\d?\b/gi) || [];
    for (const id of [...cnMatches, ...usMatches, ...epMatches, ...woMatches]) ids.add(id.toUpperCase());
    const urlMatch = (r.url || '').match(/\/patent\/([A-Z]{2}\d+[A-Z]?\d*)/);
    if (urlMatch) ids.add(urlMatch[1].toUpperCase());
  }
  return [...ids];
}

/**
 * v3.4：从 Exa 检索结果构造每件专利的元信息（替代 v3.3 的 Jina 详情读取）。
 * 云端无可用详情读取链路，改用 Exa highlights（标题+语义摘要+状态关键词）。
 * @returns [{patentId, title, status, highlights}]
 */
function buildPatentMetasFromResults(patentIds, allResults) {
  return patentIds.map(pid => {
    const pidU = pid.toUpperCase();
    const matches = allResults.filter(r => {
      const t = ((r.text || '') + ' ' + (r.title || '') + ' ' + (r.url || '')).toUpperCase();
      return t.includes(pidU);
    });
    const title = matches.map(r => r.title).filter(Boolean)[0] || '';
    const highlights = matches.map(r => r.text).filter(Boolean).join(' / ').slice(0, 800);
    const blob = (title + ' ' + highlights).toLowerCase();
    let status = '状态待确认';
    if (/已授权|granted|active|授权公告/.test(blob)) status = '已授权/Active';
    else if (/在审|pending|审查中|application/.test(blob)) status = '在审/Pending';
    return { patentId: pid, title, status, highlights };
  });
}

// ─── 报告格式化（0618 模板）──────────────────────────

function formatReport(opts) {
  const {
    competitorName, competitorNameEn, techDirection, geography, ourSolution,
    patentIds, patentMetas, aiAnalysis, ftoAnalysis, channelStatus,
    searchRounds, totalHits, backupTriggered, backupInstructions
  } = opts;
  const today = new Date().toISOString().slice(0, 10);
  const lines = [];

  lines.push(`# ${competitorName}${competitorNameEn ? `（${competitorNameEn}）` : ''}${techDirection}专利风险分析报告`);
  lines.push(`调研日期：${today} | 数据来源：Exa MCP 语义检索摘要 | 渠道状态：${channelStatus}`);
  lines.push('');

  lines.push('## 一、专利总览');
  lines.push('');
  lines.push(`### 1.1 全部 ${patentIds.length} 件专利一览`);
  lines.push('');
  lines.push('| 专利号 | 状态 | 技术方向 |');
  lines.push('| --- | --- | --- |');
  patentMetas.forEach(m => lines.push(`| ${m.patentId} | ${m.status} | ${m.title ? m.title.slice(0, 40) : '<方向待确认>'} |`));
  lines.push('');

  if (aiAnalysis) {
    lines.push('## 二、技术方向分组 + 风险分级');
    lines.push('');
    lines.push(aiAnalysis);
    lines.push('');
  }

  if (ftoAnalysis) {
    lines.push('## 三、FTO 自由实施分析');
    lines.push('');
    lines.push(ftoAnalysis);
    lines.push('');
    lines.push('> ⚠️ **AI 不替代专利律师**，最终 FTO 意见需专利代理人签字。');
    lines.push('');
  }

  if (backupTriggered) {
    lines.push('## 四、智慧芽 Backup 待办');
    lines.push('');
    lines.push(`> ⚠️ 已执行 ${searchRounds} 轮 Exa 检索仍不足。共识别 ${totalHits} 条相关记录、可识别专利号 ${patentIds.length} 个，不足以完成完整分析。`);
    lines.push('');
    lines.push('### 待补查清单');
    backupInstructions.needed.forEach((n, i) => lines.push(`${i + 1}. ${n}`));
    lines.push('');
    lines.push('### 推荐检索式（智慧芽用）');
    lines.push(`- 申请人: "${competitorName}"`);
    lines.push(`- 关键词: ${techDirection}`);
    lines.push(`- 检索范围: ${geography}`);
    lines.push('');
    lines.push('> DRE 在智慧芽查到结果后，将数据贴回，继续分析。');
    lines.push('');
  }

  lines.push('---');
  lines.push('');
  lines.push('## ⚠️ 重要声明');
  lines.push('- 本报告由工具自动生成，仅作 DRE 风险排查参考');
  lines.push('- **最终 FTO 意见必须由专利代理人签字**，本工具不替代专利律师');
  lines.push('- 实时数据请通过 CNIPA/USPTO/EPO 官网或智慧芽二次核实');
  lines.push('- 本报告基于 Exa 语义检索摘要生成（云端无专利全文读取链路），具体权利要求以专利全文为准');

  return lines.join('\n');
}

// ─── 主入口 ──────────────────────────────────────────

exports.run = async function (params) {
  // 依赖注入（测试用）：params._inject.searchExa 可替换
  const searchExaFn = (params._inject && params._inject.searchExa) || searchExa;

  const {
    competitorName,
    competitorNameEn,
    techDirection,
    ourSolution,
    geography = '中国'
  } = params;

  if (!competitorName) return { error: '请填写竞对名称' };
  if (!techDirection) return { error: '请填写技术方向' };

  // v3.4：AI 模型显式指派（manifest aiModel select，probe 实测 qwen2.5:14b Supported）
  const aiModel = String(params.aiModel || process.env.AI_MODEL || 'qwen2.5:14b');

  // ─── Exa MCP 多轮检索（基础轮中英 + <TARGET 补搜精炼轮，≤MAX_ROUNDS）───
  let allResults = [];
  let channelStatus = '[Exa MCP]';
  let searchRounds = 0;
  let patentCount = 0;
  const seen = new Set();
  const roundNotes = [];

  const runRound = async (query, label) => {
    try {
      const res = await searchExaFn(query, EXA_NUM_RESULTS);
      searchRounds++;
      let added = 0;
      for (const r of (res.results || [])) {
        const key = r.url || r.title;
        if (seen.has(key)) continue;
        seen.add(key);
        allResults.push(r);
        added++;
      }
      patentCount = extractPatentIds({ results: allResults }).length;
      roundNotes.push(`${label}: +${added} 条，累计专利 ${patentCount}`);
    } catch (e) {
      channelStatus += ` [Exa MCP ${label}失败: ${e.message.slice(0, 50)}]`;
    }
  };

  // Phase 1: 基础轮（中文 + 英文）
  await runRound(`${competitorName} ${techDirection} 专利`, '中文');
  if (competitorNameEn) await runRound(`${competitorNameEn} ${techDirection} patent`, '英文');

  // Phase 2: 补搜轮（< TARGET 时加 Google Patents 站点提示精炼，≤ MAX_ROUNDS）
  const refinedQueries = [
    [`${competitorName} ${techDirection} 专利 patents.google.com`, '中文补搜'],
    [competitorNameEn
        ? `${competitorNameEn} ${techDirection} patent patents.google.com`
        : `${competitorName} ${techDirection} 专利 申请号 专利`,
     competitorNameEn ? '英文补搜' : '中文补搜2'],
  ];
  for (const [q, label] of refinedQueries) {
    if (patentCount >= EXA_TARGET_PATENTS || searchRounds >= EXA_MAX_ROUNDS) break;
    await runRound(q, label);
  }

  const patentIds = extractPatentIds({ results: allResults });

  // ─── 质量自检：MAX_ROUNDS 后仍 < MIN_PATENTS → backup ───
  const backupTriggered = patentIds.length < EXA_MIN_PATENTS;

  if (backupTriggered) {
    const backupInstructions = {
      applicant: competitorName,
      keywords: techDirection,
      geography,
      needed: ['专利号', '法律状态', '权利要求摘要', '同族信息']
    };
    const report = formatReport({
      competitorName, competitorNameEn, techDirection, geography, ourSolution,
      patentIds, patentMetas: patentIds.map(id => ({ patentId: id, status: '待确认', title: '', highlights: '' })),
      aiAnalysis: null, ftoAnalysis: null,
      channelStatus, searchRounds, totalHits: allResults.length,
      backupTriggered, backupInstructions
    });

    return {
      report,
      reportJson: {
        searchRounds, totalHits: allResults.length, patentIds, roundNotes,
        backupTriggered: true,
        aiModel,
        backupInstructions
      },
      patentCount: patentIds.length,
      riskSummary: '⚠️ 数据不足，需智慧芽补查',
      channelStatus
    };
  }

  // ─── v3.4：从 Exa 检索摘要构造专利元信息（替代 Jina 详情读取）───
  const patentMetas = buildPatentMetasFromResults(patentIds, allResults);

  // ─── AI 分析（key 全部来自平台 lib/ai，云端零配置）───
  let aiAnalysis = null;
  let ftoAnalysis = null;
  let hasAIAnalysis = false;
  let hasFTO = false;

  const aiKey = getAiConfig().key;
  if (aiKey) {
    try {
      // 技术方向分组 + 风险分级（用 Exa 摘要作为专利数据）
      const analysisPrompt = [
        '你是专利风险分析专家。请分析以下竞对专利数据，输出结构化风险报告。',
        '',
        '## 竞对信息',
        `- 公司: ${competitorName}${competitorNameEn ? ` (${competitorNameEn})` : ''}`,
        `- 技术方向: ${techDirection}`,
        `- 地理范围: ${geography}`,
        '',
        '## 专利数据（基于 Exa 语义检索摘要，含标题与相关片段）',
        patentMetas.map(m => `### ${m.patentId}（${m.status}）\n标题: ${m.title || '(无标题)'}\n相关片段: ${m.highlights || '(无摘要)'}`).join('\n'),
        '',
        '## 要求（严格按 0618 模板）',
        '1. 按技术方向聚类分组，每方向一节',
        '2. 每方向标注风险等级: 🔴已授权(立即生效) / 🟡在审(需跟踪) / 🟢空白区',
        '3. 每件已授权专利给出规避建议（改路线/改触发/改结构/许可/法律意见）',
        '4. 同族追踪：识别 PCT/优先权/分案同族，汇总表',
        '5. 列出技术空白区（竞对未覆盖的方向）',
        '',
        '⚠️ AI 不替代专利律师：只输出风险提示清单 + 推荐行动方向，不下侵权判定结论。',
        '⚠️ 数据为检索摘要非全文，若某专利信息不足请标注"需查全文确认"。',
      ].join('\n');
      aiAnalysis = await callOllamaAI({ prompt: analysisPrompt, system: '你是专利风险分析专家。给定竞对专利数据，按技术方向聚类、标注风险等级、给出规避建议、识别同族。', maxTokens: 8192, key: aiKey, model: aiModel });
      hasAIAnalysis = true;

      // FTO 对照（如有我方方案）
      if (ourSolution) {
        const ftoPrompt = [
          '你是 FTO（自由实施）分析专家。请逐特征比对我方方案与竞对专利，标注风险。',
          '',
          '## 我方方案',
          ourSolution,
          '',
          '## 竞对专利（已识别）',
          patentMetas.map(m => `- ${m.patentId}: ${m.title}（${m.status}）`).join('\n'),
          '',
          '## 要求',
          '| 我方特征 | 涉及专利 | 风险等级(🟢/🟡/🔴) | 说明 |',
          '逐行填写。最后给出综合结论。',
          '',
          '⚠️ 声明: AI 不替代专利律师，最终 FTO 意见需专利权代理人签字。',
        ].join('\n');
        ftoAnalysis = await callOllamaAI({ prompt: ftoPrompt, system: '你是 FTO 专利风险分析专家。逐特征比对给出风险等级。', maxTokens: 4096, key: aiKey, model: aiModel });
        hasFTO = true;
      }
    } catch (e) {
      // 模型 Unsupported 等错误显式带出，便于面板切换模型重试
      channelStatus += ` [AI 分析失败: ${e.message.slice(0, 80)}]`;
    }
  }

  // ─── 输出报告 ───
  const report = formatReport({
    competitorName, competitorNameEn, techDirection, geography, ourSolution,
    patentIds, patentMetas,
    aiAnalysis, ftoAnalysis,
    channelStatus, searchRounds, totalHits: allResults.length,
    backupTriggered: false, backupInstructions: null
  });

  return {
    report,
    reportJson: {
      searchRounds, totalHits: allResults.length, patentIds, roundNotes,
      patentMetas,
      geography, techDirection, competitorName,
      aiModel,
      channelStatus,
      hasAIAnalysis, hasFTO
    },
    patentCount: patentIds.length,
    riskSummary: hasAIAnalysis
      ? `共检索到 ${patentIds.length} 件相关专利，已通过 AI（${aiModel}）完成风险分级分析`
      : `共检索到 ${patentIds.length} 件相关专利（AI 分析未启用或失败，需人工完成风险分级）`,
    channelStatus
  };
};

// 导出内部函数供测试
exports.parseExaMcpText = parseExaMcpText;
exports.extractPatentIds = extractPatentIds;
