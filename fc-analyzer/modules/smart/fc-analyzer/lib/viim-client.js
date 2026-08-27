/**
 * viim-client.js — VIIM Jira REST API client
 *
 * Ported from Python scripts/viim_client.py
 * Uses native Node.js fetch (v18+). Falls back to https module for older versions.
 */

'use strict';

const https = require('https');
const http = require('http');
const {
  SEVERITY_MAP, FIELDS, VIIM_PROJECT_KEY, VIIM_ISSUE_TYPE_ID, VIIM_ISSUE_TYPE_NAME
} = require('./constants');

/* ============================================================
 *  Error class
 * ============================================================ */
class VIIMError extends Error {
  constructor(code, payload) {
    super(`VIIM API Error ${code}: ${JSON.stringify(payload)}`);
    this.name = 'VIIMError';
    this.code = code;
    this.payload = payload;
  }
}

/* ============================================================
 *  Client class
 * ============================================================ */
class VIIMClient {
  /**
   * @param {string} token — Bearer token (required)
   * @param {string} [baseUrl] — VIIM base URL (from env if omitted)
   */
  constructor(token, baseUrl) {
    this.token = token || process.env.VIIM_API_TOKEN || '';
    this.baseUrl = (baseUrl || process.env.VIIM_URL || '').replace(/\/+$/, '');
    if (!this.token) throw new Error('VIIM token is required');
    if (!this.baseUrl) throw new Error('VIIM_URL is required');
  }

  /* ----------------------------------------------------------
   *  Internal HTTP helper
   * ---------------------------------------------------------- */
  async _request(method, path, body, timeout = 30000) {
    const url = new URL(path, this.baseUrl);
    const isHttps = url.protocol === 'https:';
    const transport = isHttps ? https : http;

    const headers = {
      'Authorization': `Bearer ${this.token}`,
      'Accept': 'application/json',
    };

    let payload = null;
    if (body && method !== 'GET') {
      if (body instanceof FormData || (typeof body === 'object' && body._isMultipart)) {
        // Multipart — handled by caller
        payload = body.payload;
        Object.assign(headers, body.headers);
      } else {
        payload = JSON.stringify(body);
        headers['Content-Type'] = 'application/json';
      }
      headers['Content-Length'] = Buffer.byteLength(payload);
    }

    return new Promise((resolve, reject) => {
      const req = transport.request({
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method,
        headers,
        timeout,
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          if (res.statusCode >= 400) {
            let payload;
            try { payload = JSON.parse(data); } catch { payload = { raw: data }; }
            return reject(new VIIMError(res.statusCode, payload));
          }
          try { resolve(JSON.parse(data)); }
          catch { resolve(data); }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
      if (payload) req.write(payload);
      req.end();
    });
  }

  /* ----------------------------------------------------------
 *  Public API methods
 * ---------------------------------------------------------- */

  /** Verify token / get current user */
  async getMyself() {
    return this._request('GET', '/rest/api/2/myself');
  }

  /** Get single issue by key (e.g. DEMODIR-123) */
  async getIssue(key) {
    try {
      const issue = await this._request('GET', `/rest/api/2/issue/${encodeURIComponent(key)}`);
      const f = issue.fields || {};
      return {
        key: issue.key,
        id: issue.id,
        summary: f.summary || '',
        description: f.description || '',
        status: f.status?.name || '',
        assignee: f.assignee?.displayName || f.assignee?.name || '',
        created: f.created || '',
        updated: f.updated || '',
        priority: f.priority?.name || '',
        severity: f[FIELD_MAP.severity] || '',
        urgency: f[FIELD_MAP.urgency] || '',
        area: f[FIELD_MAP.area] || '',
        phase: f[FIELD_MAP.phase] || '',
        car_model: f[FIELD_MAP.car_model] || '',
        close_date: f[FIELD_MAP.close_date] || '',
        cas_date: f[FIELD_MAP.cas_date] || '',
        department: f[FIELD_MAP.department] || '',
        url: `${this.baseUrl}/browse/${issue.key}`,
      };
    } catch (e) {
      if (e.code === 404) return null;
      throw e;
    }
  }

  /** JQL search */
  async searchIssues(jql, fields = ['summary', 'status', 'assignee', 'created', 'updated'], maxResults = 50) {
    const resp = await this._request('POST', '/rest/api/2/search', {
      jql,
      fields,
      maxResults,
    });
    return (resp.issues || []).map(issue => {
      const f = issue.fields || {};
      return {
        key: issue.key,
        id: issue.id,
        summary: f.summary || '',
        status: f.status?.name || '',
        assignee: f.assignee?.displayName || f.assignee?.name || '',
        created: f.created || '',
        updated: f.updated || '',
        ...Object.fromEntries(
          Object.entries(FIELD_MAP).map(([k, cf]) => [k, f[cf] || ''])
        ),
        url: `${this.baseUrl}/browse/${issue.key}`,
      };
    });
  }

  /** Create a new issue */
  async createIssue(summary, description, additionalFields = {}, projectKey, issueTypeId, issueTypeName) {
    const body = {
      fields: {
        project: { key: projectKey || VIIM_PROJECT_KEY },
        issuetype: {
          id: issueTypeId || VIIM_ISSUE_TYPE_ID,
          name: issueTypeName || VIIM_ISSUE_TYPE_NAME,
        },
        summary,
        description,
        ...additionalFields,
      },
    };

    const resp = await this._request('POST', '/rest/api/2/issue', body);
    return {
      key: resp.key,
      id: resp.id,
      url: `${this.baseUrl}/browse/${resp.key}`,
      raw: resp,
    };
  }

  /** Upload attachment to an issue (not commonly needed, but ported for completeness) */
  async uploadAttachment(issueKey, fileBuffer, filename) {
    const boundary = '----FormBoundary' + Date.now().toString(36);
    const header = Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      `Content-Type: application/octet-stream\r\n\r\n`
    );
    const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
    const payload = Buffer.concat([header, fileBuffer, footer]);

    const result = await this._request('POST',
      `/rest/api/2/issue/${encodeURIComponent(issueKey)}/attachments`,
      {
        payload,
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'X-Atlassian-Token': 'no-check',
        },
      },
      60000
    );
    return result;
  }

  /* ----------------------------------------------------------
 *  Payload builder
 * ---------------------------------------------------------- */

  /**
   * Build a VIIM create-issue payload from extracted fields.
   * @param {object} fields — output of extractor (with viim_* keys)
   * @param {string} summary
   * @param {string} description
   * @returns {{ summary, description, additional_fields, project }}
   */
  buildPayload(fields, summary, description) {
    const additional = {};
    const set = (cf, val) => {
      if (val !== undefined && val !== null && val !== '') {
        additional[cf] = val;
      }
    };

    set(FIELDS.部门.cf,       fields.viim_department || fields.department);
    set(FIELDS.区域.cf,       fields.viim_area || fields.area);
    set(FIELDS.严重度.cf,     fields.viim_severity || SEVERITY_MAP[fields.severity] || fields.severity);
    set(FIELDS.紧急度.cf,     fields.viim_urgency || fields.urgency);
    set(FIELDS.开发阶段.cf,   fields.viim_phase || fields.phase);
    set(FIELDS.问题描述.cf,   fields.viim_description || fields.description);
    set(FIELDS.关闭时间.cf,   fields.viim_close_date || fields.close_date);
    set(FIELDS.CAS时间.cf,    fields.viim_cas_date || fields.cas_date);
    set(FIELDS.车型.cf,       fields.viim_car_model || fields.car_model);
    set(FIELDS.CAS编号.cf,    fields.viim_cas_number || fields.cas_number);
    set(FIELDS.TI状态.cf,     fields.viim_ti_status || fields.ti_status);
    set(FIELDS.TI零件号.cf,   fields.viim_ti_part || fields.ti_part);

    const related = fields.viim_related_owners || fields.related_owners;
    if (related) {
      const names = splitOwners(related);
      if (names.length) set(FIELDS.关联责任人.cf, names);
    }

    return {
      summary: summary || fields.summary || '',
      description: description || fields.description || '',
      additional_fields: additional,
      project: VIIM_PROJECT_KEY,
    };
  }

  /** Generate dry-run markdown preview of a payload */
  dryRunReport(payload) {
    const lines = ['## VIIM 工单预览\n'];
    lines.push(`**项目**: ${payload.project}`);
    lines.push(`**摘要**: ${payload.summary}`);
    lines.push('');
    lines.push('### 附加字段');
    for (const [cf, val] of Object.entries(payload.additional_fields || {})) {
      const display = typeof val === 'object' ? JSON.stringify(val) : String(val);
      lines.push(`- **${cf}**: ${display}`);
    }
    lines.push(`\n**描述** (前500字):\n`);
    lines.push((payload.description || '').slice(0, 500));
    return lines.join('\n');
  }
}

/* ============================================================
 *  Helper: VIIM customfield mapping for issue detail parsing
 * ============================================================ */
const FIELD_MAP = {
  severity:  'customfield_10621',
  urgency:   'customfield_14001',
  area:      'customfield_13088',
  phase:     'customfield_13089',
  car_model: 'customfield_13913',
  close_date:'customfield_13084',
  cas_date:  'customfield_13876',
  department:'customfield_13082',
  cas_number:'customfield_13083',
  ti_status: 'customfield_13085',
  ti_part:   'customfield_13915',
};

function splitOwners(val) {
  if (!val) return [];
  if (Array.isArray(val)) return val.map(v => typeof v === 'string' ? v : v.name || String(v));
  return String(val).split(/[,，;；\s]+/).map(s => s.trim()).filter(Boolean);
}

module.exports = { VIIMClient, VIIMError, FIELD_MAP };
