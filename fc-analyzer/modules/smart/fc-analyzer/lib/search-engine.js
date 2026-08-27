/**
 * search-engine.js — TF-IDF case search with multi-dimensional bonuses
 *
 * Ported from Python scripts/lighting_search.py
 * Uses character n-gram tokenization instead of jieba for Chinese text.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { PATHS, loadJson } = require('./storage');

/* ============================================================
 *  Keyword taxonomy (loaded once)
 * ============================================================ */
let _keywords = null;
function loadKeywords() {
  if (_keywords) return _keywords;
  const projectRoot = path.join(__dirname, '..', '..', '..', '..');
  const candidates = [
    PATHS.keywords,
    path.join(projectRoot, 'database', 'lighting_keywords.json'),
  ];
  for (const p of candidates) {
    const kw = loadJson(p, null);
    if (kw && typeof kw === 'object') { _keywords = kw; return _keywords; }
  }
  _keywords = {};
  return _keywords;
}

function getKeywordSets() {
  const kw = loadKeywords();
  // Flatten nested keyword objects into sets
  const flatten = (obj) => {
    if (Array.isArray(obj)) return new Set(obj);
    if (typeof obj === 'object' && obj !== null) {
      const vals = [];
      for (const v of Object.values(obj)) {
        if (Array.isArray(v)) vals.push(...v);
        else if (typeof v === 'string') vals.push(v);
        else if (typeof v === 'object' && v !== null) {
          // Recurse one more level (e.g. area_keywords.front_light.keywords)
          for (const vv of Object.values(v)) {
            if (Array.isArray(vv)) vals.push(...vv);
            else if (typeof vv === 'string') vals.push(vv);
          }
        }
      }
      return new Set(vals);
    }
    return new Set();
  };

  return {
    symptom: flatten(kw.problem_keywords),
    part: flatten(kw.part_keywords),
    trigger: flatten(kw.trigger_keywords),
    standard: flatten(kw.standard_keywords),
    relation: new Set(kw.relation_words || []),
  };
}

/* ============================================================
 *  Chinese text tokenization (character n-gram approach)
 *  Replaces jieba from Python version
 * ============================================================ */

// Chinese stop characters/phrases
const STOPWORDS = new Set([
  '的', '了', '和', '是', '在', '有', '与', '及', '或', '等',
  '中', '上', '下', '到', '从', '为', '对', '被', '把', '将',
  '会', '能', '可以', '可能', '需要', '应该', '已经', '正在',
  '这', '那', '这个', '那个', '什么', '怎么', '为什么',
  '一个', '一些', '所有', '每个', '问题', '出现', '发现',
  '进行', '通过', '使用', '情况', '方面', '问题', '导致',
]);

function isChinese(ch) {
  const code = ch.charCodeAt(0);
  return code >= 0x4E00 && code <= 0x9FFF;
}

function isAlphanumeric(ch) {
  return /[a-zA-Z0-9]/.test(ch);
}

/**
 * Tokenize Chinese/mixed text into meaningful tokens.
 * Strategy:
 * 1. Extract CJK bigrams (2-char combinations)
 * 2. Extract alphanumeric words
 * 3. Extract CJK trigrams for important patterns
 */
function tokenize(text) {
  if (!text) return [];
  const normalized = text.toLowerCase().replace(/\s+/g, ' ').trim();
  const tokens = [];

  // Extract alphanumeric words
  const alphaWords = normalized.match(/[a-z0-9]+(?:\.[a-z0-9]+)*/g) || [];
  for (const w of alphaWords) {
    if (w.length >= 2) tokens.push(w);
  }

  // Extract CJK characters for n-gram processing
  const cjkChars = [];
  for (const ch of normalized) {
    if (isChinese(ch)) cjkChars.push(ch);
  }

  // Generate bigrams
  for (let i = 0; i < cjkChars.length - 1; i++) {
    const bigram = cjkChars[i] + cjkChars[i + 1];
    if (!STOPWORDS.has(bigram)) {
      tokens.push(bigram);
    }
  }

  // Generate trigrams for longer sequences
  for (let i = 0; i < cjkChars.length - 2; i++) {
    const trigram = cjkChars[i] + cjkChars[i + 1] + cjkChars[i + 2];
    // Only add trigrams that contain non-stopword characters
    const allStop = cjkChars.slice(i, i + 3).every(ch => STOPWORDS.has(ch));
    if (!allStop) {
      tokens.push(trigram);
    }
  }

  // Extract single CJK characters that are not stopwords (for short queries)
  if (cjkChars.length <= 4) {
    for (const ch of cjkChars) {
      if (!STOPWORDS.has(ch)) tokens.push(ch);
    }
  }

  return tokens;
}

/* ============================================================
 *  TF-IDF computation
 * ============================================================ */

function buildTfIdf(tokens) {
  const tf = {};
  const maxTf = Math.max(...Object.values(
    tokens.reduce((acc, t) => { acc[t] = (acc[t] || 0) + 1; return acc; }, {})
  ));

  const counts = {};
  for (const t of tokens) counts[t] = (counts[t] || 0) + 1;

  for (const [term, count] of Object.entries(counts)) {
    // Augmented TF: 0.5 + 0.5 * tf / max_tf
    tf[term] = 0.5 + 0.5 * (count / (maxTf || 1));
  }

  return tf;
}

function computeIdf(corpusSize, docFreq) {
  return Math.log((corpusSize + 1) / (docFreq + 1)) + 1;
}

function cosine(v1, v2, norm1, norm2) {
  if (norm1 === 0 || norm2 === 0) return 0;
  let dot = 0;
  for (const [term, w1] of Object.entries(v1)) {
    if (v2[term]) dot += w1 * v2[term];
  }
  return dot / (norm1 * norm2);
}

/* ============================================================
 *  Attention profile
 * ============================================================ */

function attentionProfile(query) {
  const kwSets = getKeywordSets();
  const qLower = query.toLowerCase();
  const profile = { symptom: 1, part: 1, trigger: 1, standard: 1 };

  let symptomHits = 0, partHits = 0, triggerHits = 0, standardHits = 0;
  for (const word of kwSets.symptom) {
    if (qLower.includes(word.toLowerCase())) symptomHits++;
  }
  for (const word of kwSets.part) {
    if (qLower.includes(word.toLowerCase())) partHits++;
  }
  for (const word of kwSets.trigger) {
    if (qLower.includes(word.toLowerCase())) triggerHits++;
  }
  for (const word of kwSets.standard) {
    if (qLower.includes(word.toLowerCase())) standardHits++;
  }

  if (symptomHits >= 3) profile.symptom = 1.5;
  else if (symptomHits >= 2) profile.symptom = 1.2;

  if (partHits >= 3) profile.part = 1.5;
  else if (partHits >= 2) profile.part = 1.2;

  if (triggerHits >= 2) profile.trigger = 1.3;

  if (standardHits >= 2) profile.standard = 1.4;
  else if (standardHits >= 1) profile.standard = 1.2;

  return profile;
}

/* ============================================================
 *  Multi-dimensional keyword matching
 * ============================================================ */

function classifyKeywords(tokens) {
  const kwSets = getKeywordSets();
  const result = { symptom: 0, part: 0, trigger: 0, standard: 0 };

  for (const token of tokens) {
    if (kwSets.symptom.has(token)) result.symptom++;
    if (kwSets.part.has(token)) result.part++;
    if (kwSets.trigger.has(token)) result.trigger++;
    if (kwSets.standard.has(token)) result.standard++;
  }

  return result;
}

/* ============================================================
 *  Main search function
 * ============================================================ */

// Corpus cache
let _corpusCache = null;
let _corpusMtime = 0;

function loadCorpus() {
  const issuesFile = resolveCorpusPath();
  if (!issuesFile) return [];

  try {
    const stat = fs.statSync(issuesFile);
    if (_corpusCache && stat.mtimeMs === _corpusMtime) return _corpusCache;

    const raw = loadJson(issuesFile, []);
    // Handle both formats: bare array or {issues: [...]}
    const issues = Array.isArray(raw) ? raw : (raw.issues || raw.cases || []);
    _corpusCache = Array.isArray(issues) ? issues : [];
    _corpusMtime = stat.mtimeMs;
    return _corpusCache;
  } catch {
    return [];
  }
}

function resolveCorpusPath() {
  // Module is at modules/exterior/fc-analyzer/lib/ → 4 levels up to project root
  const projectRoot = path.join(__dirname, '..', '..', '..', '..');
  const candidates = [
    PATHS.cases,
    path.join(projectRoot, 'database', 'lighting_issues.json'),
    path.join(projectRoot, 'database', 'issues.json'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/**
 * Search for similar FC cases.
 * @param {string} query — natural language query
 * @param {object} [options]
 * @param {string} [options.area] — filter by area
 * @param {string} [options.problemType] — filter by problem type
 * @param {number} [options.top=5] — max results
 * @param {number} [options.minScore=0.05] — minimum score threshold
 * @param {string} [options.issuesFile] — custom corpus path
 * @returns {Array<{key, area, problem_type, keywords, root_cause, solution, score, summary}>}
 */
function searchSimilarIssues(query, options = {}) {
  const { area, problemType, top = 5, minScore = 0.05, issuesFile } = options;
  const raw = issuesFile ? loadJson(issuesFile, []) : null;
  const corpus = raw
    ? (Array.isArray(raw) ? raw : (raw.issues || raw.cases || []))
    : loadCorpus();

  if (!corpus.length || !query) return [];

  const queryTokens = tokenize(query);
  if (!queryTokens.length) return [];

  // Build query TF-IDF vector
  const queryTf = buildTfIdf(queryTokens);
  const profile = attentionProfile(query);
  const queryKw = classifyKeywords(queryTokens);

  // Document frequency counting
  const df = {};
  const docTokens = corpus.map(issue => {
    const text = [issue.summary || '', issue.description || '', issue.root_cause || '', issue.solution || ''].join(' ');
    const tokens = tokenize(text);
    const unique = new Set(tokens);
    for (const t of unique) df[t] = (df[t] || 0) + 1;
    return tokens;
  });

  const N = corpus.length;
  const idf = {};
  for (const [term, count] of Object.entries(df)) {
    idf[term] = computeIdf(N, count);
  }

  // Score weights (matching Python version)
  const W_TFIDF = 0.20;
  const W_SYMPTOM = 0.35;
  const W_PART = 0.25;
  const W_AREA = 0.10;
  const W_TRIGGER = 0.05;
  const W_RELATION = 0.10;
  const W_OPTICAL = 0.15;
  const W_STANDARD = 0.08;
  const MAX_BONUS = W_SYMPTOM + W_PART + W_AREA + W_TRIGGER + W_RELATION + W_OPTICAL + W_STANDARD;

  const results = [];

  for (let i = 0; i < corpus.length; i++) {
    const issue = corpus[i];

    // Area filter
    if (area && issue.area && !issue.area.includes(area) && !area.includes(issue.area)) continue;
    // Problem type filter
    if (problemType && issue.problem_type && issue.problem_type !== problemType) continue;

    // Build document vector
    const docTf = buildTfIdf(docTokens[i]);
    const docVec = {};
    let docNormSq = 0;
    for (const [term, tfVal] of Object.entries(docTf)) {
      const w = tfVal * (idf[term] || 1);
      docVec[term] = w;
      docNormSq += w * w;
    }
    const docNorm = Math.sqrt(docNormSq);

    // Query vector
    const qVec = {};
    let qNormSq = 0;
    for (const [term, tfVal] of Object.entries(queryTf)) {
      const w = tfVal * (idf[term] || 1);
      qVec[term] = w;
      qNormSq += w * w;
    }
    const qNorm = Math.sqrt(qNormSq);

    // TF-IDF cosine similarity
    const tfidfScore = cosine(qVec, qVec, qNorm, docNorm);

    // Near-exact match shortcut
    const qNormText = query.replace(/\s+/g, '').toLowerCase();
    const issueText = (issue.summary || '').replace(/\s+/g, '').toLowerCase();
    if (qNormText.length > 4 && issueText.length > 4) {
      if (qNormText.includes(issueText) || issueText.includes(qNormText)) {
        results.push({
          ...issue,
          score: 0.95,
        });
        continue;
      }
    }

    // Multi-dimensional keyword bonuses
    const issueKwTokens = tokenize(
      [issue.keywords || [], issue.root_cause || '', issue.solution || ''].flat().join(' ')
    );
    const issueKw = classifyKeywords(issueKwTokens);

    let bonus = 0;
    bonus += W_SYMPTOM * Math.min(1, (queryKw.symptom > 0 ? Math.min(issueKw.symptom, queryKw.symptom) / queryKw.symptom : 0)) * profile.symptom;
    bonus += W_PART * Math.min(1, (queryKw.part > 0 ? Math.min(issueKw.part, queryKw.part) / queryKw.part : 0)) * profile.part;
    bonus += W_TRIGGER * Math.min(1, (queryKw.trigger > 0 ? Math.min(issueKw.trigger, queryKw.trigger) / queryKw.trigger : 0)) * profile.trigger;
    bonus += W_STANDARD * Math.min(1, (queryKw.standard > 0 ? Math.min(issueKw.standard, queryKw.standard) / queryKw.standard : 0)) * profile.standard;

    // Area match bonus
    if (area && issue.area) {
      if (issue.area.includes(area) || area.includes(issue.area)) {
        bonus += W_AREA;
      }
    }

    const rawScore = W_TFIDF * tfidfScore + bonus;
    const normalizedScore = Math.min(1, rawScore / (W_TFIDF + MAX_BONUS));

    if (normalizedScore >= minScore) {
      results.push({
        ...issue,
        score: Math.round(normalizedScore * 1000) / 1000,
      });
    }
  }

  // Sort by score descending
  results.sort((a, b) => b.score - a.score);

  // Deduplicate by summary similarity
  const deduped = [];
  const seen = new Set();
  for (const r of results) {
    const dedupeKey = caseDedupeKey(r);
    if (!seen.has(dedupeKey)) {
      seen.add(dedupeKey);
      deduped.push(r);
    }
  }

  return deduped.slice(0, top);
}

/**
 * Dedupe key based on normalized summary + solution prefix.
 * Matches Python's _case_dedupe_key logic.
 */
function caseDedupeKey(issue) {
  const summary = (issue.summary || '').replace(/[\[\]【】]/g, '').replace(/DIR-\d+/gi, '').trim().slice(0, 60);
  const solution = (issue.solution || '').replace(/[\[\]【】]/g, '').replace(/DIR-\d+/gi, '').trim().slice(0, 60);
  return `${summary}||${solution}`.toLowerCase();
}

/**
 * Simple keyword search (for quick lookups without TF-IDF).
 */
function keywordSearch(query, corpus, top = 10) {
  const tokens = tokenize(query);
  if (!tokens.length) return [];

  return corpus
    .map(issue => {
      const text = [issue.summary || '', issue.root_cause || '', issue.description || ''].join(' ');
      const textTokens = new Set(tokenize(text));
      let hits = 0;
      for (const t of tokens) {
        if (textTokens.has(t)) hits++;
      }
      return { ...issue, score: hits / tokens.length };
    })
    .filter(r => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, top);
}

module.exports = {
  searchSimilarIssues,
  keywordSearch,
  tokenize,
  caseDedupeKey,
  loadCorpus,
};
