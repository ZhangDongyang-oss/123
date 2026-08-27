/**
 * analyzer.js — AI-powered field extraction and report generation
 *
 * Replaces Python lighting_extractor.py (regex) with platform aiChat.
 * Report generation ported from Python lighting_analyzer.py.
 */

'use strict';

const { PATHS, loadJson } = require('./storage');
const { AI_FIELD_MAP, SEVERITY_MAP, PHASE_NEXT } = require('./constants');

/* ============================================================
 *  AI Field Extraction (replaces regex-based extractor)
 * ============================================================ */

const EXTRACTION_PROMPT = `你是某新能源车企灯具工程FC问题分析专家。请从用户的描述中提取以下结构化字段。

必须返回纯JSON，不要任何其他文字。字段说明：
- area: 灯具区域（远光灯/近光灯/转向灯/日行灯/位置灯/后尾灯/制动灯/后雾灯/后转向灯/高位制动灯/内氛围灯/外氛围灯/迎宾灯/充电口灯/牌照灯/LOGO灯/ADB/ISD/投影灯/其他）
- severity: 严重度（S/A/B/C/D，S=安全法规，A=功能性能，B=外观间隙，C=轻微，D=建议）
- urgency: 紧急度（紧急/高/中/低）
- phase: 开发阶段（A面/CAS0/CAS1/OTS/AA1/SOP/M0/M1/M2/ST/EP1/EP2/PP）
- car_model: 车型（如车型F/车型H/车型I/车型C/车型D等）
- cas_number: CAS或STY编号
- summary: 一句话摘要（15字内）
- description: 详细描述（保留原文）
- parts: 涉及零件列表（数组）
- symptoms: 现象症状列表（数组）
- conditions: 触发条件列表（数组）
- problem_type: 问题类型（配光/密封/散热/固定/电气/外观/异响/装配/材料/光学/结构/其他）
- department: 责任部门

如果某个字段无法确定，设为空字符串""或空数组[]。severity如果无法确定默认"B"。`;

async function extractFields(text, aiChat) {
  if (!text || !aiChat) {
    return basicExtract(text || '');
  }

  try {
    const reply = await aiChat({
      messages: [
        { role: 'system', content: EXTRACTION_PROMPT },
        { role: 'user', content: text },
      ],
      model: 'qwen2.5:14b',
      stream: false,
    });

    const content = reply.content || reply || '';
    // Parse JSON from response (handle markdown code blocks)
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return normalizeFields(parsed, text);
    }
  } catch (e) {
    console.error('[analyzer] AI extraction failed, falling back to basic:', e.message);
  }

  return basicExtract(text);
}

/* ============================================================
 *  Basic regex-based extraction (fallback)
 * ============================================================ */

function basicExtract(text) {
  const t = text || '';
  const lower = t.toLowerCase();

  // Area detection
  const areaPatterns = [
    [/(远光|high\s*beam)/i, '远光灯'],
    [/(近光|low\s*beam|dipped)/i, '近光灯'],
    [/(转向|turn\s*signal|indicator)/i, '转向灯'],
    [/(日行|daytime|drl)/i, '日行灯'],
    [/(位置灯|position|parking)/i, '位置灯'],
    [/(尾灯|tail\s*light|rear\s*lam)/i, '后尾灯'],
    [/(制动|brake|stop\s*light)/i, '制动灯'],
    [/(后雾灯|rear\s*fog)/i, '后雾灯'],
    [/(高位制动|high\s*mount|chmsl)/i, '高位制动灯'],
    [/(氛围灯|ambient)/i, '外氛围灯'],
    [/(迎宾|welcome)/i, '迎宾灯'],
    [/(充电|charge)/i, '充电口灯'],
    [/(牌照|license)/i, '牌照灯'],
    [/(logo)/i, 'LOGO灯'],
    [/(ADB|自适应远光)/i, 'ADB'],
    [/(ISD|智能交互)/i, 'ISD'],
    [/(投影|projection)/i, '投影灯'],
    [/(前灯|headlamp|大灯)/i, '近光灯'],
    [/(灯)/i, '其他'],
  ];
  let area = '';
  for (const [pat, val] of areaPatterns) {
    if (pat.test(t)) { area = val; break; }
  }

  // Car model
  const modelMatch = t.match(/(车型F|车型G|车型H|车型I|车型J|车型C|车型D|车型K|车型L|车型A|车型B|车型B2|车型B3)[A-Z0-9-]*/i);
  const carModel = modelMatch ? modelMatch[0].toUpperCase() : '';

  // CAS/STY number
  const casMatch = t.match(/(?:CAS|STY|sty|cas)[-\s]*(\d{2,})/i);
  const casNumber = casMatch ? casMatch[0].toUpperCase() : '';

  // Severity keywords
  let severity = 'B';
  if (/安全|法规|抛锚|失控|起火|短路/.test(t)) severity = 'S';
  else if (/功能失效|不亮|不工作|性能|耐久|色差/.test(t)) severity = 'A';
  else if (/外观|间隙|面差|色差轻微|划痕/.test(t)) severity = 'B';
  else if (/异响|操作力|松动/.test(t)) severity = 'C';

  // Problem type
  const typePatterns = [
    [/配光|光学|光型|截止线|明暗|光照/, '配光'],
    [/密封|漏水|进水|起雾|IP\d/, '密封'],
    [/散热|温度|过热|热管理/, '散热'],
    [/固定|松脱|脱落|卡扣|安装/, '固定'],
    [/电气|电路|线束|插接|短路|断路/, '电气'],
    [/外观|表面|色差|变色|发黄/, '外观'],
    [/异响|噪声|震动/, '异响'],
    [/装配|间隙|面差|匹配/, '装配'],
    [/材料|老化|龟裂|开裂/, '材料'],
  ];
  let problemType = '';
  for (const [pat, val] of typePatterns) {
    if (pat.test(t)) { problemType = val; break; }
  }

  // Extract parts (simplified)
  const partPatterns = t.match(/(?:透镜|反射镜|灯壳|灯罩|灯泡|LED|PCB|驱动|线束|散热器|装饰框|面罩|底座|密封圈|防水膜)[A-Za-z0-9-\s]*/g);
  const parts = partPatterns ? [...new Set(partPatterns.map(p => p.trim()))] : [];

  // Summary
  const summary = t.length > 20 ? t.slice(0, 20) + '...' : t;

  return {
    area,
    severity,
    urgency: severity === 'S' ? '紧急' : severity === 'A' ? '高' : '中',
    phase: '',
    car_model: carModel,
    cas_number: casNumber,
    summary,
    description: t,
    parts,
    symptoms: [],
    conditions: [],
    problem_type: problemType,
    department: '',
    raw_text: t,
  };
}

/* ============================================================
 *  Normalize AI output to standard format
 * ============================================================ */

function normalizeFields(parsed, rawText) {
  const severity = (parsed.severity || 'B').toUpperCase().charAt(0);
  const validSeverity = ['S', 'A', 'B', 'C', 'D'].includes(severity) ? severity : 'B';

  return {
    area: parsed.area || '',
    severity: validSeverity,
    urgency: parsed.urgency || (validSeverity === 'S' ? '紧急' : validSeverity === 'A' ? '高' : '中'),
    phase: parsed.phase || '',
    car_model: (parsed.car_model || '').toUpperCase(),
    cas_number: (parsed.cas_number || '').toUpperCase(),
    summary: parsed.summary || rawText.slice(0, 20),
    description: parsed.description || rawText,
    parts: Array.isArray(parsed.parts) ? parsed.parts : (parsed.parts ? [parsed.parts] : []),
    symptoms: Array.isArray(parsed.symptoms) ? parsed.symptoms : (parsed.symptoms ? [parsed.symptoms] : []),
    conditions: Array.isArray(parsed.conditions) ? parsed.conditions : (parsed.conditions ? [parsed.conditions] : []),
    problem_type: parsed.problem_type || '',
    department: parsed.department || '',
    raw_text: rawText,

    // VIIM-compatible field names
    viim_area: parsed.area || '',
    viim_severity: SEVERITY_MAP[validSeverity] || '',
    viim_urgency: parsed.urgency || '',
    viim_phase: parsed.phase || '',
    viim_car_model: (parsed.car_model || '').toUpperCase(),
    viim_cas_number: (parsed.cas_number || '').toUpperCase(),
    viim_department: parsed.department || '',
    viim_description: parsed.description || rawText,
    viim_close_date: computeDate(14),
    viim_cas_date: computeDate(21),
    viim_ti_status: '',
    viim_ti_part: '',
    viim_related_owners: '',
  };
}

function computeDate(daysFromNow) {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  return d.toISOString().slice(0, 10);
}

/* ============================================================
 *  Report Generation (ported from lighting_analyzer.py)
 * ============================================================ */

const VERB_PATTERNS = [
  ['配光', ['配光', '光学设计', '光型', '截止线', '光照度']],
  ['密封', ['密封', '防水', '防尘', 'IP等级', '密封圈', '防水膜']],
  ['散热', ['散热', '热管理', '温度', '导热', '散热器']],
  ['固定', ['固定', '安装', '卡扣', '紧固', '螺栓', '定位']],
  ['电气', ['电气', '电路', '线束', '插接', '驱动', 'PCB']],
  ['材料', ['材料', '更换材料', '改材料', '材质']],
  ['结构', ['结构', '加强筋', '壁厚', '筋位']],
  ['工艺', ['工艺', '注塑', '涂装', '装配']],
  ['尺寸', ['尺寸', '公差', '间隙', '面差']],
  ['调整', ['调整', '优化', '改善', '改进']],
];

const NUM_RE = /(?:≥|≤|>|<|>=|<=)?\s*(\d+(?:\.\d+)?)\s*(mm|cm|度|°|%|N|MPa|kg|dB|lm|lux|cd|K)/g;

function generateReport(hits, query, area, severity, phase) {
  const rootCauses = clusterRootCauses(hits);
  const directions = extractModificationDirections(hits);
  const boundaries = extractCompromiseBoundaries(hits);

  const recommendation = buildRecommendation(rootCauses, directions, severity, phase);
  const summary = buildSummary(query, area, severity, hits.length, rootCauses);

  return {
    summary,
    root_causes: rootCauses,
    modification_directions: directions,
    compromise_boundaries: boundaries,
    recommendation,
    disclaimer: '本报告基于历史案例自动生成，仅供参考。最终方案需结合实际工程评估。',
  };
}

function clusterRootCauses(hits) {
  const freq = {};

  for (const hit of hits) {
    // From root_cause field
    if (hit.root_cause) {
      const cause = hit.root_cause.trim();
      if (cause) {
        freq[cause] = (freq[cause] || 0) + 1;
      }
    }
    // From keywords
    if (Array.isArray(hit.keywords)) {
      for (const kw of hit.keywords) {
        freq[kw] = (freq[kw] || 0) + 0.5;
      }
    }
  }

  const sorted = Object.entries(freq)
    .sort((a, b) => b[1] - a[1]);

  if (!sorted.length) {
    return [{ text: '未找到匹配的历史案例', level: 'info' }];
  }

  const maxCount = sorted[0][1];
  return sorted.slice(0, 8).map(([text, count]) => ({
    text,
    level: count >= maxCount * 0.67 ? 'primary' : count >= maxCount * 0.34 ? 'secondary' : 'edge',
    count: Math.round(count),
  }));
}

function extractModificationDirections(hits) {
  const dirMap = {};

  for (const hit of hits) {
    const solution = hit.solution || '';
    for (const [verb, synonyms] of VERB_PATTERNS) {
      for (const syn of synonyms) {
        if (solution.includes(syn)) {
          dirMap[verb] = (dirMap[verb] || 0) + 1;
          break;
        }
      }
    }
  }

  return Object.entries(dirMap)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([direction, count]) => ({ direction, count }));
}

function extractCompromiseBoundaries(hits) {
  const boundaries = [];

  for (const hit of hits) {
    const solution = hit.solution || '';
    let match;
    const re = new RegExp(NUM_RE.source, NUM_RE.flags);
    while ((match = re.exec(solution)) !== null) {
      const value = parseFloat(match[1]);
      const unit = match[2];
      if (isValidRange(value, unit)) {
        boundaries.push({
          value,
          unit,
          source: hit.key || '',
          context: solution.slice(Math.max(0, match.index - 20), match.index + match[0].length + 20),
        });
      }
    }
  }

  return boundaries.slice(0, 10);
}

function isValidRange(value, unit) {
  const ranges = {
    mm: [0.01, 10000], cm: [0.1, 1000], '度': [0, 360], '°': [0, 360],
    '%': [0, 100], N: [0, 100000], MPa: [0, 1000], kg: [0, 10000],
    dB: [0, 200], lm: [0, 1000000], lux: [0, 1000000], cd: [0, 1000000], K: [0, 10000],
  };
  const [min, max] = ranges[unit] || [0, Infinity];
  return value >= min && value <= max;
}

function buildRecommendation(rootCauses, directions, severity, phase) {
  const lines = [];

  const primary = rootCauses.filter(c => c.level === 'primary');
  if (primary.length) {
    lines.push(`主要根因: ${primary.map(c => c.text).join('、')}`);
  }

  if (directions.length) {
    lines.push(`建议修改方向: ${directions.slice(0, 3).map(d => d.direction).join('、')}`);
  }

  if (severity === 'S' || severity === 'A') {
    lines.push('该问题严重度较高，建议优先处理并同步相关方。');
  }

  if (phase && PHASE_NEXT[phase]) {
    lines.push(`当前阶段 ${phase}，下一阶段 ${PHASE_NEXT[phase]}，需关注时间节点。`);
  }

  return lines.join('\n');
}

function buildSummary(query, area, severity, hitCount, rootCauses) {
  const parts = [`针对"${query.slice(0, 30)}"的可行性分析`];
  if (area) parts.push(`涉及${area}`);
  parts.push(`严重度${severity || '未定'}，匹配到${hitCount}条历史案例`);
  const primary = rootCauses.filter(c => c.level === 'primary');
  if (primary.length) {
    parts.push(`主要原因为${primary[0].text}`);
  }
  return parts.join('，') + '。';
}

/* ============================================================
 *  Report formatting
 * ============================================================ */

function formatReportMarkdown(report) {
  const lines = ['# FC 可行性分析报告\n'];
  lines.push(report.summary);
  lines.push('');

  if (report.root_causes?.length) {
    lines.push('## 根因分析');
    for (const rc of report.root_causes) {
      const badge = rc.level === 'primary' ? '🔴' : rc.level === 'secondary' ? '🟡' : '⚪';
      lines.push(`- ${badge} ${rc.text}`);
    }
    lines.push('');
  }

  if (report.modification_directions?.length) {
    lines.push('## 修改方向');
    for (const d of report.modification_directions) {
      lines.push(`- ${d.direction} (出现${d.count}次)`);
    }
    lines.push('');
  }

  if (report.compromise_boundaries?.length) {
    lines.push('## 参考数值');
    for (const b of report.compromise_boundaries) {
      lines.push(`- ${b.value}${b.unit} (${b.source})`);
    }
    lines.push('');
  }

  if (report.recommendation) {
    lines.push('## 建议');
    lines.push(report.recommendation);
    lines.push('');
  }

  if (report.disclaimer) {
    lines.push(`> ${report.disclaimer}`);
  }

  return lines.join('\n');
}

/**
 * Build advice context for rendering (ported from Python build_advice_context).
 */
function buildAdviceContext(report, hits, query, severity, source) {
  return {
    root_causes: (report.root_causes || []).map(rc => ({
      text: rc.text,
      level: rc.level || 'info',
    })),
    directions: (report.modification_directions || []).map(d => d.direction),
    boundaries: (report.compromise_boundaries || []).map(b => `${b.value}${b.unit}`),
    suggestions: (report.recommendation || '').split('\n').filter(Boolean),
    hit_count: hits.length,
    source,
  };
}

module.exports = {
  extractFields,
  generateReport,
  formatReportMarkdown,
  buildAdviceContext,
  clusterRootCauses,
  extractModificationDirections,
  extractCompromiseBoundaries,
};
