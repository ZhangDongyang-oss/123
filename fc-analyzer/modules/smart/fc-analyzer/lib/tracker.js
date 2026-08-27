/**
 * tracker.js — Issue tracking, alerts, and reminders
 *
 * Ported from Python scripts/alerts.py
 */

'use strict';

const { PATHS, loadCollection, appendToCollection, saveJson, updateInCollection } = require('./storage');
const { STATUS, STATUS_CLOSED } = require('./constants');

/* ============================================================
 *  Issue Tracking
 * ============================================================ */

function trackIssue(fcText, fields, viimKey, status, userId) {
  const issue = {
    id: 'trk_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6),
    viim_key: viimKey || '',
    fc_text: (fcText || '').slice(0, 200),
    area: fields?.area || '',
    severity: fields?.severity || '',
    urgency: fields?.urgency || '',
    stage: fields?.phase || '',
    part: Array.isArray(fields?.parts) ? fields.parts.join(', ') : (fields?.parts || ''),
    symptom: Array.isArray(fields?.symptoms) ? fields.symptoms.join(', ') : (fields?.symptoms || ''),
    status: status || STATUS.NEW,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    close_deadline: fields?.close_date || '',
    cas_deadline: fields?.cas_date || '',
    assigned_to: '',
    alerts_sent: [],
    notes: [],
  };

  appendToCollection(PATHS.tracking, issue);
  return issue.id;
}

function updateIssueStatus(issueId, newStatus, note) {
  return updateInCollection(
    PATHS.tracking,
    item => item.id === issueId,
    item => ({
      ...item,
      status: newStatus,
      updated_at: new Date().toISOString(),
      notes: note
        ? [...(item.notes || []), { text: note, at: new Date().toISOString() }]
        : item.notes || [],
    })
  );
}

function addIssueNote(issueId, note) {
  return updateInCollection(
    PATHS.tracking,
    item => item.id === issueId,
    item => ({
      ...item,
      notes: [...(item.notes || []), { text: note, at: new Date().toISOString() }],
      updated_at: new Date().toISOString(),
    })
  );
}

/* ============================================================
 *  Alert Rules
 * ============================================================ */

function checkAlerts() {
  const issues = loadCollection(PATHS.tracking);
  const alertsFile = PATHS.tracking.replace('tracking.json', 'alerts.json');
  const sentAlerts = loadCollection(alertsFile);
  const sentRefs = new Set(sentAlerts.map(a => a.ref_id));

  const newAlerts = [];
  const now = new Date();

  for (const issue of issues) {
    if (STATUS_CLOSED.includes(issue.status)) continue;

    // Rule 1: New FC (within 24h)
    const created = new Date(issue.created_at);
    const hoursSinceCreated = (now - created) / 3600000;
    if (hoursSinceCreated <= 24) {
      const ref = `new_${issue.id}`;
      if (!sentRefs.has(ref)) {
        newAlerts.push({
          type: 'new_issue',
          level: 'info',
          ref_id: ref,
          issue_id: issue.id,
          message: `新FC: ${issue.fc_text.slice(0, 50)}`,
          target: issue.assigned_to || '未分配',
          action: '请确认并分配',
        });
      }
    }

    // Rule 2: Severity S
    if (issue.severity === 'S' || (issue.severity && issue.severity.includes('S-'))) {
      const ref = `sev_s_${issue.id}`;
      if (!sentRefs.has(ref)) {
        newAlerts.push({
          type: 'severity_s',
          level: 'critical',
          ref_id: ref,
          issue_id: issue.id,
          message: `S级FC: ${issue.fc_text.slice(0, 50)}`,
          target: issue.assigned_to || '管理员',
          action: '需立即处理',
        });
      }
    }

    // Rule 3: Deadline approaching (<=3 days) or overdue
    const deadline = issue.close_deadline || issue.cas_deadline;
    if (deadline) {
      const deadlineDate = new Date(deadline);
      const daysLeft = (deadlineDate - now) / 86400000;
      if (daysLeft < 0) {
        const ref = `overdue_${issue.id}`;
        if (!sentRefs.has(ref)) {
          newAlerts.push({
            type: 'overdue',
            level: 'critical',
            ref_id: ref,
            issue_id: issue.id,
            message: `已逾期${Math.abs(Math.round(daysLeft))}天: ${issue.fc_text.slice(0, 40)}`,
            target: issue.assigned_to || '管理员',
            action: '请立即跟进',
          });
        }
      } else if (daysLeft <= 3) {
        const ref = `deadline_${issue.id}`;
        if (!sentRefs.has(ref)) {
          newAlerts.push({
            type: 'deadline_soon',
            level: 'warning',
            ref_id: ref,
            issue_id: issue.id,
            message: `距截止日${Math.round(daysLeft)}天: ${issue.fc_text.slice(0, 40)}`,
            target: issue.assigned_to || '管理员',
            action: '请尽快处理',
          });
        }
      }
    }
  }

  // Rule 4: Area trend (>=3 open issues in same area)
  const areaCounts = {};
  for (const issue of issues) {
    if (!STATUS_CLOSED.includes(issue.status) && issue.area) {
      areaCounts[issue.area] = (areaCounts[issue.area] || 0) + 1;
    }
  }
  for (const [area, count] of Object.entries(areaCounts)) {
    if (count >= 3) {
      const ref = `trend_${area}`;
      if (!sentRefs.has(ref)) {
        newAlerts.push({
          type: 'area_trend',
          level: 'warning',
          ref_id: ref,
          issue_id: '',
          message: `${area}有${count}个未关闭FC`,
          target: '管理员',
          action: '请检查区域问题趋势',
        });
      }
    }
  }

  // Save new alerts
  if (newAlerts.length) {
    saveJson(alertsFile, [...sentAlerts, ...newAlerts]);
  }

  return newAlerts;
}

/* ============================================================
 *  Management Dashboard
 * ============================================================ */

function getManagementDashboard() {
  const issues = loadCollection(PATHS.tracking);
  const now = new Date();

  const summary = {
    total: issues.length,
    open: 0,
    closed: 0,
    overdue: 0,
  };

  const byArea = {};
  const bySeverity = {};
  const byStage = {};
  const criticalIssues = [];
  const trend7d = {};

  for (const issue of issues) {
    const isClosed = STATUS_CLOSED.includes(issue.status);
    if (isClosed) {
      summary.closed++;
    } else {
      summary.open++;

      // Check overdue
      const deadline = issue.close_deadline || issue.cas_deadline;
      if (deadline && new Date(deadline) < now) {
        summary.overdue++;
        criticalIssues.push(issue);
      }

      // Area breakdown
      if (issue.area) {
        byArea[issue.area] = (byArea[issue.area] || 0) + 1;
      }

      // Severity breakdown
      const sevKey = (issue.severity || '').charAt(0);
      bySeverity[sevKey || '未定'] = (bySeverity[sevKey || '未定'] || 0) + 1;

      // Stage breakdown
      if (issue.stage) {
        byStage[issue.stage] = (byStage[issue.stage] || 0) + 1;
      }
    }

    // 7-day trend
    const created = new Date(issue.created_at);
    const daysAgo = Math.floor((now - created) / 86400000);
    if (daysAgo < 7) {
      const dateKey = created.toISOString().slice(0, 10);
      trend7d[dateKey] = (trend7d[dateKey] || 0) + 1;
    }
  }

  return { summary, by_area: byArea, by_severity: bySeverity, by_stage: byStage, critical_issues: criticalIssues, trend_7d: trend7d };
}

/* ============================================================
 *  Follow-up Reminders
 * ============================================================ */

function getFollowupReminders() {
  const issues = loadCollection(PATHS.tracking);
  const reminders = [];
  const now = new Date();

  for (const issue of issues) {
    if (STATUS_CLOSED.includes(issue.status)) continue;

    // Priority 1: Overdue
    const deadline = issue.close_deadline || issue.cas_deadline;
    if (deadline) {
      const deadlineDate = new Date(deadline);
      const daysLeft = (deadlineDate - now) / 86400000;
      if (daysLeft < 0) {
        reminders.push({
          ...issue,
          priority: 1,
          reason: `已逾期${Math.abs(Math.round(daysLeft))}天`,
          action: '立即跟进',
        });
        continue;
      }
      if (daysLeft <= 3) {
        reminders.push({
          ...issue,
          priority: 2,
          reason: `距截止日${Math.round(daysLeft)}天`,
          action: '尽快处理',
        });
        continue;
      }
    }

    // Priority 2: Severity S
    if (issue.severity === 'S' || (issue.severity && issue.severity.includes('S-'))) {
      reminders.push({
        ...issue,
        priority: 2,
        reason: 'S级严重度',
        action: '优先处理',
      });
      continue;
    }

    // Priority 3: Stale (no update in 7 days)
    const updated = new Date(issue.updated_at || issue.created_at);
    const daysSinceUpdate = (now - updated) / 86400000;
    if (daysSinceUpdate >= 7) {
      reminders.push({
        ...issue,
        priority: 3,
        reason: `${Math.round(daysSinceUpdate)}天未更新`,
        action: '请更新状态',
      });
    }
  }

  reminders.sort((a, b) => a.priority - b.priority || new Date(b.updated_at) - new Date(a.updated_at));
  return reminders;
}

/* ============================================================
 *  Dashboard/Reminders formatting
 * ============================================================ */

function formatDashboardMarkdown(dashboard) {
  const lines = ['# FC 管理看板\n'];
  const s = dashboard.summary;
  lines.push(`总计 **${s.total}** 个FC，其中 **${s.open}** 个进行中，**${s.closed}** 个已关闭，**${s.overdue}** 个逾期\n`);

  if (Object.keys(dashboard.by_area).length) {
    lines.push('## 按区域');
    for (const [area, count] of Object.entries(dashboard.by_area).sort((a, b) => b[1] - a[1])) {
      lines.push(`- ${area}: ${count}`);
    }
    lines.push('');
  }

  if (Object.keys(dashboard.by_severity).length) {
    lines.push('## 按严重度');
    for (const [sev, count] of Object.entries(dashboard.by_severity).sort()) {
      lines.push(`- ${sev}级: ${count}`);
    }
  }

  return lines.join('\n');
}

function formatRemindersMarkdown(reminders) {
  const lines = ['# FC 跟进提醒\n'];
  if (!reminders.length) {
    lines.push('暂无需要跟进的事项。');
    return lines.join('\n');
  }
  for (const r of reminders) {
    const icon = r.priority === 1 ? '🔴' : r.priority === 2 ? '🟡' : '⚪';
    lines.push(`${icon} **${r.reason}** — ${r.fc_text}`);
    lines.push(`   操作: ${r.action} | 区域: ${r.area || '-'} | 严重度: ${r.severity || '-'}\n`);
  }
  return lines.join('\n');
}

module.exports = {
  trackIssue,
  updateIssueStatus,
  addIssueNote,
  checkAlerts,
  getManagementDashboard,
  getFollowupReminders,
  formatDashboardMarkdown,
  formatRemindersMarkdown,
};
