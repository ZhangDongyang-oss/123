/**
 * constants.js — Shared constants for FC Analyzer module
 *
 * Ported from Python scripts: lighting_extractor.py, viim_client.py,
 * report_checker.py, alerts.py
 */

'use strict';

/* ============================================================
 *  Field Registry — canonical source of truth
 *  Maps Chinese field names → extractor keys & VIIM customfield IDs
 * ============================================================ */
const FIELDS = {
  部门:       { viim: 'viim_department',  cf: 'customfield_13082' },
  区域:       { viim: 'viim_area',        cf: 'customfield_13088' },
  严重度:     { viim: 'viim_severity',     cf: 'customfield_10621' },
  紧急度:     { viim: 'viim_urgency',      cf: 'customfield_14001' },
  开发阶段:   { viim: 'viim_phase',        cf: 'customfield_13089' },
  TI状态:     { viim: 'viim_ti_status',    cf: 'customfield_13085' },
  问题描述:   { viim: 'viim_description',  cf: 'customfield_13087' },
  关闭时间:   { viim: 'viim_close_date',   cf: 'customfield_13084' },
  CAS时间:    { viim: 'viim_cas_date',     cf: 'customfield_13876' },
  车型:       { viim: 'viim_car_model',    cf: 'customfield_13913' },
  CAS编号:    { viim: 'viim_cas_number',   cf: 'customfield_13083' },
  TI零件号:   { viim: 'viim_ti_part',      cf: 'customfield_13915' },
  关联责任人: { viim: 'viim_related_owners', cf: 'customfield_14064' },
  摘要:       { viim: 'summary',           cf: 'summary' },
  根因:       { viim: 'root_cause',        cf: null },
  解决方案:   { viim: 'solution',          cf: null },
  问题类型:   { viim: 'problem_type',      cf: null },
  零件:       { viim: 'parts',             cf: null },
  症状:       { viim: 'symptoms',          cf: null },
  触发条件:   { viim: 'conditions',        cf: null },
};

/* ============================================================
 *  Severity mapping
 * ============================================================ */
const SEVERITY_MAP = {
  S: 'S-非常重要（安全/法规/抛锚）',
  A: 'A-重要（功能/性能/耐久）',
  B: 'B-一般（外观/间隙/面差）',
  C: 'C-轻微（异响/操作力）',
  D: 'D-建议（优化/改善）',
};

/* ============================================================
 *  Phase mapping: current → next phase
 * ============================================================ */
const PHASE_NEXT = {
  'A面': 'CAS0', 'CAS0': 'CAS1', 'CAS1': 'OTS',
  'OTS': 'AA1', 'AA1': 'SOP', 'SOP': 'SOP',
  'M0': 'M1', 'M1': 'M2', 'M2': 'SOP',
  'ST': 'EP1', 'EP1': 'EP2', 'EP2': 'PP', 'PP': 'SOP',
};

/* ============================================================
 *  VIIM project configuration
 * ============================================================ */
const VIIM_PROJECT_KEY = process.env.VIIM_PROJECT_KEY || 'DEMODIR';
const VIIM_ISSUE_TYPE_ID = '10101';
const VIIM_ISSUE_TYPE_NAME = '故障';

/* ============================================================
 *  Status constants (from alerts.py)
 * ============================================================ */
const STATUS = {
  NEW: '新建',
  ANALYZING: '分析中',
  SUBMITTED: '已提交',
  CLOSED: '已关闭',
  OVERDUE: '已逾期',
};

const STATUS_CLOSED = ['已关闭', '让步接受', '取消'];

const STATUS_ACTIVE = [
  '待分配', '待处理', '处理中', '等待验证',
  '已重新打开', '待确认', '待评审', '挂起',
  '待关闭', '遗留',
];

/* ============================================================
 *  Report template (default required fields)
 * ============================================================ */
const DEFAULT_TEMPLATE = {
  id: 'default',
  name: '标准报告模板',
  required: [
    '部门', '区域', '严重度', '紧急度', '开发阶段',
    '车型', '问题描述', '摘要',
  ],
};

/* ============================================================
 *  Field-to-AI key mapping for extraction
 * ============================================================ */
const AI_FIELD_MAP = {
  '区域':     'area',
  '严重度':   'severity',
  '紧急度':   'urgency',
  '开发阶段': 'phase',
  '车型':     'car_model',
  'CAS编号':  'cas_number',
  '问题描述': 'description',
  '摘要':     'summary',
  '零件':     'parts',
  '症状':     'symptoms',
  '触发条件': 'conditions',
  '问题类型': 'problem_type',
  '部门':     'department',
};

module.exports = {
  FIELDS,
  SEVERITY_MAP,
  PHASE_NEXT,
  VIIM_PROJECT_KEY,
  VIIM_ISSUE_TYPE_ID,
  VIIM_ISSUE_TYPE_NAME,
  STATUS,
  STATUS_CLOSED,
  STATUS_ACTIVE,
  DEFAULT_TEMPLATE,
  AI_FIELD_MAP,
};
