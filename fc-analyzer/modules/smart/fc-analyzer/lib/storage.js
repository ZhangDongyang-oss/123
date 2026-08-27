/**
 * storage.js — JSON file storage with atomic writes
 *
 * Ported from Python webapp/infra.py
 * Uses simple read/write with no external dependencies.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');

// Ensure data directory exists
function ensureDir(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
}
ensureDir(DATA_DIR);

/* ============================================================
 *  JSON file operations
 * ============================================================ */

function loadJson(filePath, defaultVal = null) {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return defaultVal;
  }
}

function saveJson(filePath, data) {
  ensureDir(path.dirname(filePath));
  const tmp = filePath + '.tmp.' + process.pid;
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
    fs.renameSync(tmp, filePath);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {}
    throw e;
  }
}

/* ============================================================
 *  Data file paths
 * ============================================================ */
const PATHS = {
  cases:      path.join(DATA_DIR, 'cases.json'),
  tracking:   path.join(DATA_DIR, 'tracking.json'),
  reminders:  path.join(DATA_DIR, 'reminders.json'),
  feedback:   path.join(DATA_DIR, 'feedback.json'),
  drafts:     path.join(DATA_DIR, 'drafts.json'),
  submissions:path.join(DATA_DIR, 'submissions.json'),
  keywords:   path.join(DATA_DIR, 'lighting_keywords.json'),
  patterns:   path.join(DATA_DIR, 'lighting_patterns.json'),
  usage:      path.join(DATA_DIR, 'usage.json'),
};

/* ============================================================
 *  Generic collection helpers
 * ============================================================ */

function loadCollection(filePath) {
  const data = loadJson(filePath, []);
  return Array.isArray(data) ? data : [];
}

function appendToCollection(filePath, item) {
  const arr = loadCollection(filePath);
  arr.push(item);
  saveJson(filePath, arr);
  return arr;
}

function removeFromCollection(filePath, predicate) {
  const arr = loadCollection(filePath);
  const filtered = arr.filter(item => !predicate(item));
  if (filtered.length < arr.length) {
    saveJson(filePath, filtered);
    return true;
  }
  return false;
}

function updateInCollection(filePath, predicate, updater) {
  const arr = loadCollection(filePath);
  let found = false;
  for (let i = 0; i < arr.length; i++) {
    if (predicate(arr[i])) {
      arr[i] = updater(arr[i]);
      found = true;
      break;
    }
  }
  if (found) saveJson(filePath, arr);
  return found;
}

module.exports = {
  DATA_DIR,
  PATHS,
  loadJson,
  saveJson,
  loadCollection,
  appendToCollection,
  removeFromCollection,
  updateInCollection,
  ensureDir,
};
