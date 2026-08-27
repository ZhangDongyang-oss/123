/**
 * 前端逻辑 — GB 15084 内后视镜视野校核 (全功能版)
 * 对齐 Python dashboard.py: landing/内镜页 + 车型CRUD + 后挡风视图 + 3DE代理
 */
(function () {
  'use strict';

  // ====== 调色板 (Apple 冷白: 系统蓝/绿/红) ======
  const C = {
    mirrorFace: '#0071e3',   // 系统蓝 (镜面淡填充)
    mirrorEdge: '#0071e3',   // 镜框
    hit: '#34c759',          // 系统绿 (与 PASS 徽章一致)
    miss: '#ff3b30',         // 系统红
    regulation: '#ff3b30',
    projection: '#0071e3',   // 系统蓝 (倒影曲线)
    edgeLine: '#9a9aa0',     // 弱灰 (距离线)
  };
  const SHORT_EP = { 'BL': 'BL', 'BR': 'BR', '+X': '+X' };

  // 视图高度自适应常量 (px): 容器高度 = 内容等比例 + 顶部留白 + 底部(轴标题+图例)
  const PLOT_MARGIN_T = 20;   // 顶部留白
  const PLOT_AXIS_B = 54;     // x 轴标题 + 刻度高度
  const PLOT_LEGEND_H = 36;   // 底部横向图例一行高度
  // 底部图例 y (paper 坐标, 负=plot 下方): 换算成固定像素偏移, 放在 x 轴标题下方
  const bottomLegendY = plotAreaH => -(PLOT_AXIS_B / Math.max(80, plotAreaH));

  // ====== DOM refs ======
  const $ = id => document.getElementById(id);
  const elYaw = $('yaw'), elPitch = $('pitch');
  const elWidth = $('width'), elHeight = $('height');
  const elPvX = $('pvt-x'), elPvY = $('pvt-y'), elPvZ = $('pvt-z');
  const elCzX = $('center-zero-x'), elCzY = $('center-zero-y'), elCzZ = $('center-zero-z');
  const elEyeX = $('eye-x'), elEyeY = $('eye-y'), elEyeZ = $('eye-z');
  const elIpd = $('ipd');
  const elGfX = $('gf-x'), elGfY = $('gf-y'), elGfZ = $('gf-z');
  const elGrX = $('gr-x'), elGrY = $('gr-y'), elGrZ = $('gr-z');
  const elVerifyBtn = $('verify-btn'), elAutoBtn = $('auto-btn');
  const elLastAngles = $('last-angles'), elAutoStatus = $('auto-status');
  const elVerdictDiv = $('verdict');
  const elVerdictCount = $('verdict-count');
  const elVerdictBadge = $('verdict-badge');
  const elRwBadge = $('rw-badge');
  const elVerdictLines = $('verdict-lines');
  const elVerdictFailures = $('verdict-failures');
  const elVerdictRwLines = $('verdict-rw-lines');

  const API_BASE = window.location.pathname.replace(/\/+$/, '') + '/api';
  let currentPath = null;
  let curFarDist = 60.0;   // 当前车型法规远距 (auto-search 用, 默认 GB 15084 60m)
  let curReqWidth = 20.0;  // 当前车型法规远距宽度 (默认 20m)
  let currentOutlineLocal = null; // 真实反射区轮廓 [[lx,ly] mm] (STEP 采样, 从车型加载)
  let currentRwOutline = null;   // 后挡风完整轮廓 [[x,y,z] m] (STEP 采样, 从车型加载)

  // 提取失败后重试所用的 sanitize 文件名 (STEP 已在盘, 重试不重传)
  let wizExtLastSafeName = null; // 外镜向导 (doWizExtUpload)
  let wizExtLastFiles = null;    // 外镜向导多文件模式: 已落盘 tmp 的文件名列表 (retry 用)
  let wizIntLastSafeName = null; // 内镜向导 (doWizIntUpload)
  let wizIntLastFiles = null;    // 内镜向导多文件模式: 已落盘 tmp 的文件名列表 (retry 用)

  // ====== 通用 XHR 上传 (流式进度 + JSON 解析 + 友好错误) ======
  // fetch(body:file) 无上传进度; 改用 XMLHttpRequest:
  // - xhr.upload.onprogress 显示 "上传 N%"
  // - onload 内 try/catch JSON.parse, 非 JSON 响应返回友好错误 (不抛 SyntaxError)
  // - 统一 resolve 返回 { ok, error, ... }, 调用方 await 后判 d.ok
  function uploadStep(url, file, opts) {
    opts = opts || {};
    return new Promise((resolve) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', url);
      const headers = Object.assign({ 'Content-Type': 'application/octet-stream', 'X-Filename': encodeURIComponent(file.name) }, opts.headers || {});
      for (const k of Object.keys(headers)) xhr.setRequestHeader(k, headers[k]);
      // 节流: onprogress 每秒触发数百次, 直接更新 DOM 会冻结浏览器
      let lastProgress = 0;
      xhr.upload.onprogress = (e) => {
        if (!e.lengthComputable || typeof opts.onProgress !== 'function') return;
        const now = Date.now();
        if (now - lastProgress < 500 && e.loaded < e.total) return;
        lastProgress = now;
        opts.onProgress(e.loaded, e.total);
      };
      xhr.onload = () => {
        let d;
        try { d = JSON.parse(xhr.responseText); }
        catch (e) { d = { ok: false, error: `服务器返回非 JSON (HTTP ${xhr.status}), 可能 STEP 过大或提取崩溃, 请查看服务终端日志` }; }
        if (d && d.ok && typeof opts.onResult === 'function') opts.onResult(d);
        if (d && !d.ok && typeof opts.onError === 'function') opts.onError(d);
        resolve(d);
      };
      xhr.onerror = () => {
        const d = { ok: false, error: '网络错误, 上传失败 (请确认服务正在运行)' };
        if (typeof opts.onError === 'function') opts.onError(d);
        resolve(d);
      };
      xhr.ontimeout = () => {
        const d = { ok: false, error: '上传超时' };
        if (typeof opts.onError === 'function') opts.onError(d);
        resolve(d);
      };
      xhr.send(file);
    });
  }

  // 通用: 在 result 元素后动态注入一个"重试提取"按钮 (不依赖 index.html, 满足"尽量不动 index.html")
  function ensureRetryBtn(resultId, onClick) {
    const resultEl = $(resultId);
    if (!resultEl || !resultEl.parentNode) return null;
    let btn = $(resultId + '-retry');
    if (!btn) {
      btn = document.createElement('button');
      btn.id = resultId + '-retry';
      btn.type = 'button';
      btn.className = 'btn btn-outline-accent btn-sm ms-2';
      btn.textContent = '重试提取';
      btn.style.display = 'none';
      btn.addEventListener('click', onClick);
      resultEl.parentNode.insertBefore(btn, resultEl.nextSibling);
    }
    return btn;
  }
  function showRetry(resultId, onClick) { const b = ensureRetryBtn(resultId, onClick); if (b) b.style.display = ''; }
  function hideRetry(resultId) { const b = $(resultId + '-retry'); if (b) b.style.display = 'none'; }

  // 参数详情折叠: 点击折叠头 toggle 参数卡区 + 按钮文字 ▸/▾ (手动 toggle, 与现有 style.display 模式一致)
  function toggleParamCollapse(toggleId, collapseId) {
    const btn = $(toggleId);
    const box = $(collapseId);
    if (!btn || !box) return;
    const open = box.style.display !== 'none';
    box.style.display = open ? 'none' : '';
    btn.textContent = (open ? '▸ ' : '▾ ') + btn.textContent.replace(/^[▸▾] /, '');
  }

  // ====== 参数收集 ======
  const pv = (el, def) => { const v = parseFloat(el.value); return isNaN(v) ? def : v; };

  function readParams() {
    return {
      widthMM: pv(elWidth, 224.796), heightMM: pv(elHeight, 50.794),
      // 圆角R 为人工取点遗留参数, STEP 时代镜面形状由轮廓定义, 固定 0 (仅回退圆角矩形时引擎才用)
      cornerRadiusMM: 0,
      yawDeg: pv(elYaw, -23.5), pitchDeg: pv(elPitch, 5.0),
      pvMM: [pv(elPvX, 2883.07), pv(elPvY, 0), pv(elPvZ, 1441.017)],
      czMM: [pv(elCzX, 2909.215), pv(elCzY, 0.007), pv(elCzZ, 1441.88)],
      eyeMM: [pv(elEyeX, 3243.09), pv(elEyeY, -385), pv(elEyeZ, 1372)],
      ipdMM: pv(elIpd, 65),
      gfMM: [pv(elGfX, 500), pv(elGfY, 0), pv(elGfZ, 193.209)],
      grMM: [pv(elGrX, 5900), pv(elGrY, 0), pv(elGrZ, 193.209)],
    };
  }

  // 后挡风 outline: 去连续重复 (pad 产生的重复尾点), 得实际几何点
  function dedupeOutline(pts) {
    const out = [];
    for (const p of pts) {
      const last = out[out.length - 1];
      if (!last || Math.abs(last[0] - p[0]) > 1e-9 || Math.abs(last[1] - p[1]) > 1e-9 || Math.abs(last[2] - p[2]) > 1e-9) {
        out.push(p);
      }
    }
    return out;
  }

  function toVerifyParams(p) {
    const mm = v => [v[0] / 1000, v[1] / 1000, v[2] / 1000];
    return {
      width: p.widthMM / 1000, height: p.heightMM / 1000,
      cornerRadius: p.cornerRadiusMM / 1000,
      yawDeg: p.yawDeg, pitchDeg: p.pitchDeg,
      pivot: mm(p.pvMM),
      centerZero: mm(p.czMM),
      eyeCenter: mm(p.eyeMM), ipd: p.ipdMM / 1000,
      groundZ: p.gfMM[2] / 1000,
      ground: { front: mm(p.gfMM), rear: mm(p.grMM) },
      rearWindow: currentRwOutline ? { outline: currentRwOutline, transparentZone: null } : null,
      outlineLocal: currentOutlineLocal,
    };
  }

  // ====== 页面路由 (landing / mirror-type / inner / exterior / wizard) ======
  // wizardMode: 'verify' 或 'new' — 决定镜子类型选择后进校核页还是向导
  let wizardMode = 'verify';
  const pages = {
    landing: $('landing-page'),
    'mirror-type': $('mirror-type-page'),
    inner: $('inner-page'),
    exterior: $('exterior-page'),
    'wizard-exterior': $('wizard-exterior-page'),
    'wizard-interior': $('wizard-interior-page'),
  };
  function showPage(name) {
    Object.entries(pages).forEach(([k, el]) => {
      if (el) el.style.display = k === name ? '' : 'none';
    });
    if (name === 'inner' && !pages.inner.__inited) {
      pages.inner.__inited = true;
      initInner();
    }
    if (name === 'exterior' && !pages.exterior.__inited) {
      pages.exterior.__inited = true;
      initExterior();
    }
    if (name === 'wizard-exterior' && !$('wizard-exterior-page').__inited) {
      $('wizard-exterior-page').__inited = true;
      initWizardExterior();
    }
    if (name === 'wizard-interior' && !$('wizard-interior-page').__inited) {
      $('wizard-interior-page').__inited = true;
      initWizardInterior();
    }
    if (name === 'landing') wizardMode = 'verify';
  }

  // Landing 动作优先: 校核/新建 → 镜子类型选择
  $('enter-verify-btn').addEventListener('click', () => {
    wizardMode = 'verify';
    $('type-title').textContent = '选择镜子类型 · 校核已有车型';
    showPage('mirror-type');
  });
  $('enter-new-btn').addEventListener('click', () => {
    wizardMode = 'new';
    $('type-title').textContent = '选择镜子类型 · 新建车型';
    showPage('mirror-type');
  });
  $('type-back-btn').addEventListener('click', () => showPage('landing'));
  $('select-inner-btn').addEventListener('click', () => {
    if (wizardMode === 'new') showPage('wizard-interior');
    else showPage('inner');
  });
  $('select-exterior-btn').addEventListener('click', () => {
    if (wizardMode === 'new') showPage('wizard-exterior');
    else showPage('exterior');
  });
  $('back-btn').addEventListener('click', () => showPage('mirror-type'));
  $('ext-back-btn').addEventListener('click', () => showPage('mirror-type'));

  // ====== 镜中倒影 (现有逻辑保留) ======
  function autoTextPos(lx, ly, allPts, hw, hh) {
    let def;
    if (lx < -hw * 0.5) def = ly > 0 ? 'top left' : 'bottom left';
    else if (lx > hw * 0.5) def = ly > 0 ? 'top right' : 'bottom right';
    else if (ly > 0) def = 'top center';
    else def = 'bottom center';
    const flip = { 'top left': 'bottom right', 'top right': 'bottom left',
                   'top center': 'bottom center', 'bottom center': 'top center',
                   'bottom left': 'top right', 'bottom right': 'top left' };
    for (const [ox, oy] of allPts) {
      if (Math.abs(ox - lx) < 25 && Math.abs(oy - ly) < 25) { def = flip[def] || def; break; }
    }
    return def;
  }

  // 尺寸标注位置: 连线中点沿垂直方向偏移, 落在远离质心(覆盖三角)一侧 — 对齐 Python _dim_label_pos
  function dimLabelPos(px, py, fx, fy, centroid, offset = 12) {
    const mx = (px + fx) / 2, my = (py + fy) / 2;
    const dx = fx - px, dy = fy - py;
    const L = Math.hypot(dx, dy);
    if (L < 1e-9) return [mx, my];
    let nx = -dy / L, ny = dx / L;                     // 垂直方向 (单位)
    const s = nx * (centroid[0] - mx) + ny * (centroid[1] - my);
    if (s > 0) { nx = -nx; ny = -ny; }                  // 质心在 +n 侧 → 放 -n 侧
    return [mx + offset * nx, my + offset * ny];
  }

  function convexHull(pts) {
    if (pts.length < 3) return pts;
    function cross(o, a, b) { return (a[0]-o[0])*(b[1]-o[1]) - (a[1]-o[1])*(b[0]-o[0]); }
    pts = pts.slice().sort((a, b) => a[0] === b[0] ? a[1] - b[1] : a[0] - b[0]);
    const lo = [], up = [];
    for (const p of pts) { while (lo.length >= 2 && cross(lo[lo.length-2], lo[lo.length-1], p) <= 0) lo.pop(); lo.push(p); }
    for (const p of pts.reverse()) { while (up.length >= 2 && cross(up[up.length-2], up[up.length-1], p) <= 0) up.pop(); up.push(p); }
    up.pop(); lo.pop();
    return lo.concat(up);
  }

  function renderMirrorView(data) {
    if (typeof Plotly === 'undefined') { console.warn('Plotly 未加载, 镜中倒影视图隐藏'); return; }
    const m = data.mirror;
    const hw = m.widthMM / 2, hh = m.heightMM / 2;
    const r = m.cornerRadiusMM || 0;
    // 留白 10mm; 图表高度由内容比例 + 容器宽度计算 —— 不能用 CSS aspect-ratio
    // (Plotly 渲染时 CSS 高度可能未解析 → 0 高度 → 图表不显示)
    const pad = 10;

    // 镜面轮廓: 优先用后端返回的真实轮廓 (STEP 采样), 否则前端退回圆角矩形
    // 图例标签跟随实际绘制: 真实轮廓不标 R (圆角R 是人工取点遗留参数), 仅回退圆角矩形才显示
    const hasOutline = !!(m.outline && m.outline.xs && m.outline.xs.length >= 3);
    const label = hasOutline ? '镜面' : (r > 0.01 ? `镜面 (R=${(r).toFixed(0)}mm)` : '镜面');
    let ox, oy;
    if (hasOutline) {
      ox = m.outline.xs; oy = m.outline.ys;
    } else if (r < 0.01) {
      ox = [-hw, hw, hw, -hw, -hw]; oy = [-hh, -hh, hh, hh, -hh];
    } else {
      ox = []; oy = [];
      const arcs = [[hw-r, hh-r, 0, 90], [-hw+r, hh-r, 90, 180],
                    [-hw+r, -hh+r, 180, 270], [hw-r, -hh+r, 270, 360]];
      for (const [cx, cy, a0, a1] of arcs) {
        for (let j = 0; j <= 20; j++) {
          const a = (a0 + (a1 - a0) * j / 20) * Math.PI / 180;
          ox.push(cx + r * Math.cos(a)); oy.push(cy + r * Math.sin(a));
        }
      }
      ox.push(ox[0]); oy.push(oy[0]);
    }

    const traces = [{
      x: ox, y: oy, mode: 'lines', fill: 'toself',
      fillcolor: 'rgba(0,113,227,0.08)',
      line: { color: C.mirrorEdge, width: 2 },
      name: label, hoverinfo: 'name',
    }];

    // 法规线倒影曲线 (中心眼, 80 采样点) — 对齐 Python build_mirror_view_fig
    // 显示 20m 宽地平线在镜面上的连续倒影, 直观判断是否整个落在镜面内
    if (Array.isArray(data.regulationCurve) && data.regulationCurve.length) {
      const cv = data.regulationCurve.filter(p => p && Number.isFinite(p.lx) && Number.isFinite(p.ly));
      if (cv.length >= 2) {
        traces.push({
          x: cv.map(p => p.lx), y: cv.map(p => p.ly), mode: 'lines+markers',
          line: { color: C.projection, width: 5 },
          marker: { size: 4, color: C.projection },
          name: '法规线倒影(中心眼)',
          hovertemplate: 'lx=%{x:.1f}mm ly=%{y:.1f}mm<extra></extra>',
        });
        // BL/BR 倒影端点标记 (曲线首末点)
        const bl = cv[0], br = cv[cv.length - 1];
        traces.push({
          x: [bl.lx, br.lx], y: [bl.ly, br.ly], mode: 'markers+text',
          marker: { size: 14, color: C.projection, line: { color: 'black', width: 1 } },
          text: ['BL倒影', 'BR倒影'], textposition: 'top center',
          name: 'BL/BR倒影', showlegend: false,
          hovertemplate: 'lx=%{x:.1f} ly=%{y:.1f}<extra></extra>',
        });
      }
    }

    // 中心眼投影三角: 只连中心眼 3 点 (C→BL/BR/+X), 不含交叉线点
    // 含镜外点 (只要平面有交点 lx!=null 即收) — 对齐 Python: lr.mirror_hit is not None
    // 这样 FAIL 场景下射线打飞的方向也能看到, 便于调试
    const hullPts = [];
    if (data.lineDetails) {
      for (let i = 0; i < 3 && i < data.lineDetails.length; i++) {
        const ld0 = data.lineDetails[i];
        if (ld0.lx != null) hullPts.push([ld0.lx, ld0.ly]);
      }
    }
    if (hullPts.length >= 3) {
      const hx = hullPts.map(p => p[0]).concat(hullPts[0][0]);
      const hy = hullPts.map(p => p[1]).concat(hullPts[0][1]);
      traces.push({
        x: hx, y: hy, mode: 'lines',
        line: { color: C.projection, width: 2, dash: 'dash' },
        name: '中心眼投影三角', opacity: 0.8, hoverinfo: 'name',
      });
    }

    const shapes = [], annotations = [];
    const hitPts = [];
    // 中心眼 3 投影点质心 (距离标注垂直偏移方向参考, 避开覆盖三角) — 对齐 Python
    const triPts = [];
    if (data.lineDetails) {
      for (let i = 0; i < 3 && i < data.lineDetails.length; i++) {
        const ld0 = data.lineDetails[i];
        if (ld0.lx != null) triPts.push([ld0.lx, ld0.ly]);
      }
    }
    const triCentroid = triPts.length
      ? [triPts.reduce((s, p) => s + p[0], 0) / triPts.length, triPts.reduce((s, p) => s + p[1], 0) / triPts.length]
      : [0, 0];
    if (data.lineDetails) {
      for (let i = 0; i < data.lineDetails.length; i++) {
        const ld = data.lineDetails[i];
        if (ld.lx == null) { hitPts.push(null); continue; }
        const lx = ld.lx, ly = ld.ly;
        hitPts.push([lx, ly]);
        const color = ld.onMirror ? C.hit : C.miss;
        const short = `${ld.eyeLabel}→${SHORT_EP[ld.endpointLabel] || ld.endpointLabel}`;
        const full = `${ld.eyeLabel}→${ld.endpointLabel}`;
        const validPts = hitPts.filter(p => p !== null);
        const pos = autoTextPos(lx, ly, validPts, hw, hh);
        // 点形统一: 中心眼 3 线(最外轮廓) = 圆形; 左右眼交叉线 = 三角形
        const symbol = ld.eyeLabel === 'C' ? 'circle' : 'triangle-up';
        traces.push({
          x: [lx], y: [ly], mode: 'markers+text',
          marker: { size: 13, color, symbol, line: { color: 'black', width: 1 } },
          text: [short], textposition: pos, name: full, showlegend: false,
          hovertemplate: `${full}<br>lx=%{x:.1f} ly=%{y:.1f}<extra></extra>`,
        });
        // 最外点(中心眼 3 线)到对应边框距离 — 红色密集虚线 (点↔边一一对应, 不随距离变)
        if (i < 3) {
          const ep = ld.endpointLabel;
          // 真实轮廓的对应边界 (轮廓可能不对称, 用 min/max 而非对称 ±hw/±hh)
          const minX = (m.outline && m.outline.xs && m.outline.xs.length) ? Math.min(...m.outline.xs) : -hw;
          const maxX = (m.outline && m.outline.xs && m.outline.xs.length) ? Math.max(...m.outline.xs) : hw;
          const maxY = (m.outline && m.outline.ys && m.outline.ys.length) ? Math.max(...m.outline.ys) : hh;
          let edgeX, edgeY, dist;
          if (ep === 'BL') { edgeX = minX; edgeY = ly; dist = Math.abs(lx - minX); }
          else if (ep === 'BR') { edgeX = maxX; edgeY = ly; dist = Math.abs(lx - maxX); }
          else { edgeX = lx; edgeY = maxY; dist = Math.abs(ly - maxY); }
          shapes.push({ type: 'line', x0: lx, y0: ly, x1: edgeX, y1: edgeY,
            line: { color: '#ff3b30', width: 1.5, dash: 'dot' } });
          const [tx, ty] = dimLabelPos(lx, ly, edgeX, edgeY, triCentroid);
          annotations.push({ x: tx, y: ty, text: `${dist.toFixed(0)}mm`, showarrow: false,
            font: { size: 10, color: '#ff3b30', family: 'Arial Black' }, xanchor: 'center', yanchor: 'middle' });
        }
      }
    }

    const pass = data.mirrorPass;
    const passBadge = { x: 0.99, xref: 'paper', y: 0.98, yref: 'paper',
      showarrow: false, font: { size: 20, color: 'white' },
      bgcolor: pass ? C.hit : C.miss, bordercolor: pass ? C.hit : C.miss,
      borderwidth: 2, borderpad: 6, align: 'center' };
    // 显式高度: 先算内容比例 + 容器宽 → 定 plot 高度 + 图例 y (避免 tall plot 图例随高度放大越界)
    const viewEl = $('mirror-view');
    const w = viewEl && viewEl.parentElement ? viewEl.parentElement.clientWidth - 20 : 600;
    const contentRatio = (hw * 2 + pad * 2) / (hh * 2 + pad * 2);
    const plotAreaH = w / contentRatio;
    const totalH = Math.max(120, Math.round(plotAreaH) + PLOT_MARGIN_T + PLOT_AXIS_B + PLOT_LEGEND_H);
    const layout = {
      height: totalH,
      xaxis: { title: 'lx (镜面右向, mm)', range: [-hw - pad, hw + pad],
               scaleanchor: 'y', scaleratio: 1, gridcolor: '#f0f0f2', zerolinecolor: '#e4e4e8' },
      yaxis: { title: 'ly (镜面上向, mm)', range: [-hh - pad, hh + pad],
               gridcolor: '#f0f0f2', zerolinecolor: '#e4e4e8' },
      margin: { l: 50, r: 20, t: PLOT_MARGIN_T, b: PLOT_AXIS_B + PLOT_LEGEND_H },
      paper_bgcolor: '#fff', plot_bgcolor: '#fff',
      font: { family: '"Segoe UI", "Microsoft YaHei", sans-serif', color: '#9a9aa0', size: 11 },
      annotations: [Object.assign({ text: pass ? '<b>PASS</b>' : '<b>FAIL</b>' }, passBadge)].concat(annotations),
      shapes,
      legend: { x: 0.5, y: bottomLegendY(plotAreaH), xanchor: 'center', yanchor: 'top', orientation: 'h', bgcolor: 'rgba(255,255,255,0.85)', bordercolor: '#e4e4e8', borderwidth: 1 },
    };
    if (viewEl) {
      viewEl.style.height = totalH + 'px';
    }
    Plotly.react('mirror-view', traces, layout, { responsive: true });
  }

  // ====== 后挡风视图 (对齐 build_rear_window_view_fig) ======
  function renderRearWindowView(rw) {
    if (typeof Plotly === 'undefined') { console.warn('Plotly 未加载, 后挡风视图隐藏'); return; }
    if (!rw || !rw.outline2D || !rw.outline2D.length) { Plotly.react('rear-window-view', [], {}); return; }
    const traces = [];
    // CAS 外框
    const casClosed = rw.outline2D.concat([rw.outline2D[0]]);
    traces.push({
      x: casClosed.map(p => p[0]), y: casClosed.map(p => p[1]), mode: 'lines',
      line: { color: C.mirrorEdge, width: 3 },
      name: 'CAS外框(整体玻璃)', hoverinfo: 'name',
    });
    // 透光区 (仅 hasTz 时渲染; 无透光区时 tz 退化为 outline, 会与 CAS 外框完全重叠)
    if (rw.hasTz) {
      const tzClosed = rw.tz2D.concat([rw.tz2D[0]]);
      traces.push({
        x: tzClosed.map(p => p[0]), y: tzClosed.map(p => p[1]),
        mode: 'lines', fill: 'toself',
        fillcolor: 'rgba(0,113,227,0.15)',
        line: { color: C.hit, width: 2, dash: 'dash' },
        name: '透光区', hoverinfo: 'name',
      });
    }
    // 中心眼 3 交点 + 距边距离
    const shapes = [], annotations = [], hitPts = [];
    // 画幅范围 (以 CAS 外框为准) — 供点标签自适应定位
    const xs = rw.outline2D.map(p => p[0]), ys = rw.outline2D.map(p => p[1]);
    const rwHw = (Math.max(...xs) - Math.min(...xs)) / 2;
    const rwHh = (Math.max(...ys) - Math.min(...ys)) / 2;
    // 中心眼 3 交点质心 (标注避让参考)
    const hitVals = rw.centerLines.filter(c => c.hit2D);
    const rwCentroid = hitVals.length
      ? [hitVals.reduce((s, c) => s + c.hit2D[0], 0) / hitVals.length,
         hitVals.reduce((s, c) => s + c.hit2D[1], 0) / hitVals.length]
      : [0, 0];
    for (const cl of rw.centerLines) {
      if (!cl.hit2D) continue;
      const [lx, ly] = cl.hit2D;
      hitPts.push([lx, ly]);
      const color = cl.through ? C.hit : C.miss;
      // 点标签自适应定位 (避开其他点) — 对齐 Python _auto_text_position
      const pos = autoTextPos(lx, ly, hitPts.filter(p => p !== null), rwHw, rwHh);
      traces.push({
        x: [lx], y: [ly], mode: 'markers+text',
        marker: { size: 13, color, symbol: 'circle', line: { color: 'black', width: 1 } },
        text: [cl.label], textposition: pos,
        name: cl.label, showlegend: false,
        hovertemplate: `${cl.label}<br>u=%{x:.1f} v=%{y:.1f}mm<extra></extra>`,
      });
      // 距边距离标注: 中点沿垂直方向偏移, 避开质心 — 对齐 Python _dim_label_pos
      if (cl.near) {
        shapes.push({ type: 'line', x0: lx, y0: ly, x1: cl.near[0], y1: cl.near[1],
          line: { color: '#ff3b30', width: 1.5, dash: 'dot' } });
        const [tx, ty] = dimLabelPos(lx, ly, cl.near[0], cl.near[1], rwCentroid);
        annotations.push({ x: tx, y: ty, text: `${cl.dist}mm`, showarrow: false,
          font: { size: 10, color: '#ff3b30', family: 'Arial Black' }, xanchor: 'center', yanchor: 'middle' });
      }
    }
    // 覆盖三角 (3点凸包)
    if (hitPts.length >= 3) {
      const hull = convexHull(hitPts);
      if (hull.length >= 3) {
        const hx = hull.map(p => p[0]).concat(hull[0][0]);
        const hy = hull.map(p => p[1]).concat(hull[0][1]);
        traces.push({ x: hx, y: hy, mode: 'lines',
          line: { color: C.projection, width: 2, dash: 'dash' }, name: '覆盖区(3点凸包)', opacity: 0.8 });
      }
    }
    // 画幅范围: padding 按短边 15% (下限 10mm); 显式高度 → 内容填满无变形无留白
    const rwW = Math.max(...xs) - Math.min(...xs);
    const rwH = Math.max(...ys) - Math.min(...ys);
    const pad = Math.max(10, Math.min(rwW, rwH) * 0.15);
    const nIn = rw.centerLines.filter(c => c.through).length;
    const tzLabel = rw.hasTz ? '透光区' : 'CAS框';
    const pass = rw.pass;
    const passBadge = { x: 0.99, xref: 'paper', y: 0.98, yref: 'paper',
      showarrow: false, font: { size: 20, color: 'white' },
      bgcolor: pass ? C.hit : C.miss, bordercolor: pass ? C.hit : C.miss,
      borderwidth: 2, borderpad: 6, align: 'center' };
    // 显式高度: 先算内容比例 + 容器宽 → 定 plot 高度 + 图例 y (避免 tall plot 图例越界)
    const rwEl = $('rear-window-view');
    const rwCw = rwEl && rwEl.parentElement ? rwEl.parentElement.clientWidth - 20 : 600;
    const ratio = (rwW + pad * 2) / (rwH + pad * 2);
    const plotAreaH = rwCw / ratio;
    const totalH = Math.max(120, Math.round(plotAreaH) + PLOT_MARGIN_T + PLOT_AXIS_B + PLOT_LEGEND_H);
    const layout = {
      height: totalH,
      xaxis: { title: 'u (玻璃宽向, mm)', range: [Math.min(...xs) - pad, Math.max(...xs) + pad],
               scaleanchor: 'y', scaleratio: 1, gridcolor: '#f0f0f2', zerolinecolor: '#e4e4e8' },
      yaxis: { title: 'v (玻璃上向, mm)', range: [Math.min(...ys) - pad, Math.max(...ys) + pad],
               gridcolor: '#f0f0f2', zerolinecolor: '#e4e4e8' },
      margin: { l: 50, r: 20, t: PLOT_MARGIN_T, b: PLOT_AXIS_B + PLOT_LEGEND_H },
      paper_bgcolor: '#fff', plot_bgcolor: '#fff',
      font: { family: '"Segoe UI", "Microsoft YaHei", sans-serif', color: '#9a9aa0', size: 11 },
      annotations: [Object.assign({ text: pass ? '<b>PASS</b>' : '<b>FAIL</b>' }, passBadge)].concat(annotations),
      shapes,
      legend: { x: 0.5, y: bottomLegendY(plotAreaH), xanchor: 'center', yanchor: 'top', orientation: 'h', bgcolor: 'rgba(255,255,255,0.85)', bordercolor: '#e4e4e8', borderwidth: 1 },
    };
    if (rwEl) {
      rwEl.style.height = totalH + 'px';
    }
    Plotly.react('rear-window-view', traces, layout, { responsive: true });
    const rwCount = $('rw-count');
    if (rwCount) rwCount.textContent = `中心眼3线穿玻璃 ${nIn}/3 落${tzLabel}内 · ${pass ? 'PASS' : 'FAIL'}`;
  }

  // ====== 判据面板 (含 rw_pass) ======
  function renderVerdict(data) {
    const pass = data.mirrorPass;
    elVerdictDiv.className = 'alert alert-light verdict-panel verdict-two-col py-3 px-3 mb-0 flex-grow-1 verdict-head-wrap ' + (pass ? 'verdict-pass' : 'verdict-fail');
    elVerdictCount.textContent = data.nHit + '/' + data.nTot;
    elVerdictBadge.textContent = pass ? 'PASS' : 'FAIL';
    elVerdictBadge.className = 'verdict-badge-md ' + (pass ? 'badge-pass' : 'badge-fail');
    // rw_pass (后挡风穿透, 仅报告)
    if (data.rearWindowPass != null) {
      const rp = data.rearWindowPass;
      elRwBadge.textContent = rp ? 'PASS' : 'FAIL';
      elRwBadge.className = 'verdict-badge-md ' + (rp ? 'badge-pass' : 'badge-fail');
    }

    // 镜片判定: 命中点显示镜面局部坐标 (lx, ly mm) — 直观反映交点在镜面哪个位置 (驾驶员判断余量)
    // 未命中显示「未命中」+ 红色 (镜面交点不在反射区域内)
    let lines = '';
    if (data.lineDetails) {
      for (const ld of data.lineDetails) {
        const ok = ld.onMirror;
        let coord = '—';
        if (ld.lx != null && ld.ly != null) {
          coord = `(${ld.lx.toFixed(0)}, ${ld.ly.toFixed(0)}) mm`;
        }
        const status = ok ? '✓ 命中' : '✗ 未命中';
        lines += `<div class="verdict-line-row ${ok ? 'ok' : 'no'}">` +
                 `<span class="verdict-line-name">${ld.eyeLabel}→${ld.endpointLabel}</span>` +
                 `<span class="verdict-line-info" style="color:${ok ? 'var(--pass)' : 'var(--fail)'}">${status}</span>` +
                 `<span class="verdict-line-dist">${coord}</span>` +
                 `</div>`;
      }
    }
    elVerdictLines.innerHTML = lines;
    // 后挡风三线命中明细 (镜片→镜面反射→后挡风外框→眼点) — 命中后挡风即合格
    let rwLines = '';
    if (data.lineDetails && data.rearWindow && data.rearWindow.centerLines) {
      for (let i = 0; i < data.lineDetails.length; i++) {
        const ld = data.lineDetails[i];
        const cl = data.rearWindow.centerLines[i];
        if (!cl) continue;
        const through = cl.through === true;
        const cls = through ? 'ok' : 'no';
        const status = through ? '✓ 命中' : '✗ 未命中';
        const color = through ? 'var(--pass)' : 'var(--fail)';
        const dist = cl.dist != null ? `${cl.dist.toFixed(1)} mm` : '—';
        rwLines += `<div class="verdict-line-row ${cls}">` +
                   `<span class="verdict-line-name">${ld.eyeLabel}→${ld.endpointLabel}</span>` +
                   `<span class="verdict-line-info" style="color:${color}">${status}</span>` +
                   `<span class="verdict-line-dist">${dist}</span>` +
                   `</div>`;
      }
    } else if (data.lineDetails) {
      // 后挡风未提取/未配置 — 给出提示
      rwLines = `<div class="verdict-line-row muted"><span class="verdict-line-name">后挡风</span><span class="verdict-line-info">轮廓未提取</span><span class="verdict-line-dist">—</span></div>`;
    }
    elVerdictRwLines.innerHTML = rwLines;
    let fail = '';
    if (data.failureDetails && data.failureDetails.length > 0) {
      fail = '<div class="verdict-fail-title">失败详情</div>';
      for (const fd of data.failureDetails) fail += `<div class="verdict-fail-item">${fd}</div>`;
    }
    elVerdictFailures.innerHTML = fail;
  }

  // ====== API 调用 ======
  async function callJson(url, body) {
    const resp = await fetch(API_BASE + url, {
      method: body ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await resp.json().catch(() => ({ error: resp.statusText }));
    if (!resp.ok || data.ok === false) throw new Error(data.error || '请求失败');
    return data;
  }

  let verifyBusy = false; // 请求锁: 防止双击/连按 Enter 触发重复请求
  async function doVerify() {
    if (verifyBusy) return;
    verifyBusy = true;
    elVerifyBtn.disabled = true;
    elLastAngles.textContent = '正在校核...';
    try {
      const p = readParams();
      const paramsM = toVerifyParams(p);
      const data = await callJson('/verify', paramsM);
      renderVerdict(data);
      renderMirrorView(data);
      renderRearWindowView(data.rearWindow);
      elLastAngles.textContent = `已校核: yaw=${paramsM.yawDeg}° pitch=${paramsM.pitchDeg}° → 五线 ${data.nHit}/${data.nTot} ${data.mirrorPass ? 'PASS' : 'FAIL'}`;
      const panelCount = $('panel-count');
      if (panelCount) panelCount.textContent = `五线 ${data.nHit}/${data.nTot} 命中镜面 · ${data.mirrorPass ? 'PASS' : 'FAIL'}`;
    } catch (e) {
      console.error('[verify]', e);
      elLastAngles.textContent = `错误: ${e.message}`;
      elVerdictDiv.className = 'alert alert-light verdict-panel verdict-two-col verdict-fail py-3 px-3 mb-0 flex-grow-1';
      elVerdictCount.textContent = '-/-';
      elVerdictBadge.textContent = 'ERROR';
      elVerdictBadge.className = 'verdict-badge-md badge-fail';
      elVerdictLines.innerHTML = '';
      elVerdictRwLines.innerHTML = '';
      elVerdictFailures.innerHTML = `<div class="verdict-fail-item">错误: ${e.message}</div>`;
      // 清空旧图, 防止 ERROR 时残留上次结果误导
      if (typeof Plotly !== 'undefined') {
        Plotly.react('mirror-view', [], {});
        Plotly.react('rear-window-view', [], {});
      }
      const pc = $('panel-count'); if (pc) pc.textContent = '';
      const rc = $('rw-count'); if (rc) rc.textContent = '';
      const rb = $('rw-badge'); if (rb) { rb.textContent = '--'; rb.className = 'verdict-badge-md'; }
    } finally {
      verifyBusy = false;
      elVerifyBtn.disabled = false;
    }
  }

  async function doAutoSearch() {
    elAutoStatus.textContent = '正在搜索...';
    elAutoStatus.className = 'text-muted mt-1 searching';
    elAutoBtn.disabled = true;
    try {
      const p = readParams();
      const paramsM = toVerifyParams(p);
      const data = await callJson('/auto-search', {
        width: paramsM.width, height: paramsM.height,
        pivot: paramsM.pivot, centerZero: paramsM.centerZero,
        eyeCenter: paramsM.eyeCenter, ipd: paramsM.ipd,
        groundZ: paramsM.groundZ, cornerRadius: paramsM.cornerRadius,
        ground: paramsM.ground, rearWindow: paramsM.rearWindow,
        farDist: curFarDist, reqWidth: curReqWidth,
        yawRange: [-45, 15], pitchRange: [-10, 10], step: 2, seedYaw: -30, seedHalf: 12,
      });
      if (data.found) {
        elYaw.value = data.bestYaw;
        elPitch.value = data.bestPitch;
        elAutoStatus.textContent = `找到: yaw=${data.bestYaw}° pitch=${data.bestPitch}° (${data.elapsed.toFixed(1)}s)`;
        elAutoStatus.className = 'text-muted mt-1';
        await doVerify();
      } else {
        elAutoStatus.textContent = `全范围无五线 PASS (${data.elapsed.toFixed(1)}s)`;
        elAutoStatus.className = 'text-muted mt-1';
      }
    } catch (e) {
      elAutoStatus.textContent = `错误: ${e.message}`;
      elAutoStatus.className = 'text-muted mt-1';
    } finally { elAutoBtn.disabled = false; }
  }

  // ====== 车型 CRUD ======
  async function loadVehicles() {
    const { vehicles } = await callJson('/vehicles');
    const sel = $('vehicle-select');
    sel.innerHTML = '';
    for (const v of vehicles) {
      const opt = document.createElement('option');
      opt.value = v.value; opt.textContent = v.label;
      sel.appendChild(opt);
    }
    return vehicles;
  }

  async function loadVehicleConfig(path) {
    // 先清空 STEP 轮廓 (防止上一个车型的数据残留)
    currentOutlineLocal = null;
    currentRwOutline = null;
    const cfg = await callJson('/config?path=' + encodeURIComponent(path || ''));
    console.log('[loadVehicleConfig]', cfg.name, 'outlineLocal:', cfg.outlineLocal?.length||'null', 'rwOutlineFull:', cfg.rwOutlineFull?.length||'null');
    currentPath = cfg.path;
    // 填充全部表单
    elYaw.value = cfg.yawDeg; elPitch.value = cfg.pitchDeg;
    elWidth.value = cfg.widthMM; elHeight.value = cfg.heightMM;
    elPvX.value = cfg.pvMM[0]; elPvY.value = cfg.pvMM[1]; elPvZ.value = cfg.pvMM[2];
    elCzX.value = cfg.czMM[0]; elCzY.value = cfg.czMM[1]; elCzZ.value = cfg.czMM[2];
    elEyeX.value = cfg.eyeMM[0]; elEyeY.value = cfg.eyeMM[1]; elEyeZ.value = cfg.eyeMM[2];
    elIpd.value = cfg.ipdMM;
    elGfX.value = cfg.gfMM[0]; elGfY.value = cfg.gfMM[1]; elGfZ.value = cfg.gfMM[2];
    elGrX.value = cfg.grMM[0]; elGrY.value = cfg.grMM[1]; elGrZ.value = cfg.grMM[2];
    currentOutlineLocal = cfg.outlineLocal || null;
    currentRwOutline = cfg.rwOutlineFull || null;
    // 记录法规参数, 供 auto-search 带上 (不同车型可能非 60/20)
    curFarDist = Number.isFinite(cfg.farDist) ? cfg.farDist : 60.0;
    curReqWidth = Number.isFinite(cfg.reqWidth) ? cfg.reqWidth : 20.0;
    elLastAngles.textContent = `已加载车型: ${cfg.name}`;
    // 折叠头摘要 (宽/高/pivot/角度)
    const isum = $('inner-params-summary');
    if (isum) {
      isum.textContent = `宽 ${Number(cfg.widthMM).toFixed(1)}mm · 高 ${Number(cfg.heightMM).toFixed(1)}mm · pivot=[${(cfg.pvMM || []).map(v => Number(v).toFixed(0)).join(', ')}] · yaw=${cfg.yawDeg}° pitch=${cfg.pitchDeg}°`;
    }
    // 参数卡只读逻辑: 有 STEP 轮廓时, 镜面尺寸/后挡风 CAS 卡只读
    updateReadonlyState(cfg);
  }

  // 有 STEP 轮廓时, 相关参数卡只读 (轮廓已定义形状, 编辑会破坏一致性)
  function updateReadonlyState(cfg) {
    const hasOutline = !!cfg.outlineLocal;
    // 镜面尺寸卡 (width/height): 有镜面轮廓则只读
    ['width', 'height'].forEach(id => {
      const el = $(id);
      if (el) { el.readOnly = hasOutline; el.style.opacity = hasOutline ? '0.6' : ''; }
    });
    // 尺寸卡副标题
    const sizeHeader = document.querySelector('#inner-params-collapse .param-row .col:first-child .card-header small');
    if (sizeHeader) sizeHeader.textContent = hasOutline ? `STEP ${cfg.outlineLocal.length} 点轮廓` : '反射涂层有效区域';
  }

  async function doSave() {
    try {
      const p = readParams();
      const result = await callJson('/vehicles/save', {
        path: currentPath,
        name: $('vehicle-select').selectedOptions[0]?.textContent || '新车型',
        widthMM: p.widthMM, heightMM: p.heightMM,
        yawDeg: p.yawDeg, pitchDeg: p.pitchDeg,
        pvMM: p.pvMM, czMM: p.czMM,
        eyeMM: p.eyeMM, ipdMM: p.ipdMM,
        gfMM: p.gfMM, grMM: p.grMM,
        groundZ: p.gfMM[2],
      });
      await loadVehicles();
      alert('已保存车型');
    } catch (e) { alert('保存失败: ' + e.message); }
  }

  async function doDelete() {
    if (!currentPath) return;
    const sel = $('vehicle-select');
    if (!confirm('确定删除该车型？此操作不可撤销。')) return;
    try {
      await callJson('/vehicles/delete', { path: currentPath });
      await loadVehicles();
      await loadVehicleConfig();
    } catch (e) { alert('删除失败: ' + e.message); }
  }

  // 另存为新车型: 不传 path → 后端用 name 生成新文件 (覆盖默认车型保护也在此生效)
  async function doSaveAs() {
    const name = (prompt('输入新车型名称:') || '').trim();
    if (!name) return;
    try {
      const p = readParams();
      const result = await callJson('/vehicles/save', {
        name, // 缺省 path → 后端 path.join(VEHICLES_DIR, `${safe}.json`)
        widthMM: p.widthMM, heightMM: p.heightMM,
        yawDeg: p.yawDeg, pitchDeg: p.pitchDeg,
        pvMM: p.pvMM, czMM: p.czMM,
        eyeMM: p.eyeMM, ipdMM: p.ipdMM,
        gfMM: p.gfMM, grMM: p.grMM,
        groundZ: p.gfMM[2],
      });
      await loadVehicles();
      // 切换到新车型 (按 label 匹配新 option, 兜底用后端返回路径)
      const sel = $('vehicle-select');
      let matchedPath = result.path;
      for (const opt of sel.options) {
        if (opt.textContent === name) { matchedPath = opt.value; break; }
      }
      await loadVehicleConfig(matchedPath);
      elLastAngles.textContent = `已另存为: ${name}`;
    } catch (e) { alert('另存为失败: ' + e.message); }
  }

  async function checkCatiaAvailability() {
    try {
      const r = await fetch('api/catia/available');
      const d = await r.json();
      return d.available;
    } catch (e) { return false; }
  }

  async function doCatia() {
    const btn = $('catia-btn');
    if (!confirm('将从 3DE 读取参数。\n\n请在【运行本服务的终端窗口】中完成选点与输入（CATIA 弹框选择），期间本按钮会等待。\n\n确定开始？')) return;
    btn.disabled = true;
    btn.textContent = '读取中...';
    try {
      const result = await callJson('/catia', {});
      // 后端已转成 JS 车型 JSON, 自动切到新车型 (D3)
      await loadVehicles();
      await loadVehicleConfig(result.output);
      await doVerify();
      alert('3DE 读取完成, 已切换到新车型:\n' + result.output);
    } catch (e) {
      alert('3DE 读取失败: ' + e.message + '\n\n请确认 3DE 已启动、Python/pywin32 已装、并在服务终端完成操作。');
    } finally { btn.disabled = false; btn.textContent = '从3DE读取'; }
  }

  // 外镜 3DE 读取: spawn Python catia_extract --mode exterior
  async function doExtCatia() {
    const btn = $('ext-catia-btn');
    if (!confirm('将从 3DE 读取外镜参数。\n\n流程: 眼点→地面2点→车门2点→左镜轮廓+轴线→右镜轮廓+轴线+SR手输\n请在服务终端完成选点, 期间本按钮等待。\n\n确定开始？')) return;
    btn.disabled = true; btn.textContent = '3DE读取中…'; $('ext-status').textContent = '';
    try {
      const r = await fetch('api/catia/exterior', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const d = await r.json();
      if (!d.ok) throw new Error(d.error);
      alert('3DE 外镜读取完成:\n' + d.output);
      await loadExtVehicles();
      await loadExtConfig();
      await doExtVerify();
    } catch (e) {
      alert('3DE 外镜读取失败: ' + e.message + '\n\n请在服务终端查看详细输出。');
    } finally { btn.disabled = false; btn.textContent = '从3DE读取'; }
  }

  // ====== 共享 DOM 初始化 (内镜页: 按钮事件绑定) ======
  // 提取为共享函数, initInner 和内镜保存后跳转两处调用 (消除 30 行复制)
  function initInnerDOM() {
    elVerifyBtn.addEventListener('click', doVerify);
    elAutoBtn.addEventListener('click', doAutoSearch);
    $('inner-params-toggle').addEventListener('click', () => toggleParamCollapse('inner-params-toggle', 'inner-params-collapse'));
    $('save-btn').addEventListener('click', doSave);
    $('save-as-btn').addEventListener('click', doSaveAs);
    $('delete-btn').addEventListener('click', doDelete);
    $('catia-btn').addEventListener('click', doCatia);
    checkCatiaAvailability().then(ok => { if (!ok) { $('catia-btn').disabled = true; $('catia-btn').title = '平台环境不支持 3DE 读取, 请本地使用'; $('catia-btn').textContent = '3DE不可用'; } });
    $('vehicle-select').addEventListener('change', async (e) => {
      await loadVehicleConfig(e.target.value);
      await doVerify();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && e.target.tagName === 'INPUT' && pages.inner.style.display !== 'none') doVerify();
    });
  }

  // ====== 内镜页初始化 (首次进入时调用) ======
  async function initInner() {
    initInnerDOM();
    await loadVehicles();
    await loadVehicleConfig($('vehicle-select').value);
    await doVerify();
  }

  // 支持 #inner / #landing / #exterior hash 路由
  if (window.location.hash === '#inner') showPage('inner');
  if (window.location.hash === '#exterior') showPage('exterior');
  window.addEventListener('hashchange', () => {
    const h = window.location.hash;
    showPage(h === '#inner' ? 'inner' : (h === '#exterior' ? 'exterior' : 'landing'));
  });

  // ============================================================
  // ====== 外后视镜页 (III 类, L+R 合并) ======
  // ============================================================
  let extCurrentPath = null;
  let extRawConfig = null; // 完整外镜 JSON (含 outline_raw + 轴线), 保存时原样回传
  // DOM 绑定 (不含自动加载): 向导保存后跳校核页时只绑定一次, 避免自动加载与新车型加载产生异步竞态
  function initExteriorDOM() {
    $('ext-verify-btn').addEventListener('click', doExtVerify);
    $('ext-auto-btn').addEventListener('click', doExtAuto);
    $('ext-params-toggle').addEventListener('click', () => toggleParamCollapse('ext-params-toggle', 'ext-params-collapse'));
    $('ext-vehicle-select').addEventListener('change', async (e) => {
      await loadExtConfig(e.target.value);
      await doExtVerify();
    });
    // 顶栏操作 (外镜 3DE 读取 — 按钮已隐藏, 函数保留)
    $('ext-catia-btn').addEventListener('click', doExtCatia);
    checkCatiaAvailability().then(ok => { if (!ok) { $('ext-catia-btn').disabled = true; $('ext-catia-btn').title = '平台环境不支持 3DE 读取, 请本地使用'; $('ext-catia-btn').textContent = '3DE不可用'; } });
    $('ext-save-btn').addEventListener('click', doExtSave);
    $('ext-save-as-btn').addEventListener('click', doExtSaveAs);
    $('ext-delete-btn').addEventListener('click', doExtDelete);
    // 轴线方向输入实时回显补录提示 (输入过程中即时更新默认轴/真轴状态)
    ['L', 'R'].forEach(side => {
      ['x', 'y', 'z'].forEach(ax => {
        $('ext-axis-' + side + '-' + ax).addEventListener('input', () => {
          const v = ['x', 'y', 'z'].map(a => parseFloat($('ext-axis-' + side + '-' + a).value));
          if (v.every(n => Number.isFinite(n))) setExtAxisHint(side, v);
        });
      });
    });
  }
  function initExterior() {
    initExteriorDOM();
    loadExtVehicles().then(() => loadExtConfig($('ext-vehicle-select').value).then(() => doExtVerify()));
  }

  // ====== 外后视镜新建向导 (阶段 5) ======
  let wizExtPath = null;    // 提取结果 tmp 路径 (data/tmp/<stem>.json)
  let wizExtRaw = null;     // 提取的完整外镜 JSON (保存时深拷贝 patch 轴线)

  // 步骤导航 (作用域限定在 wizard-exterior-page, 避免与内镜向导的 .wizard-step 冲突)
  function wizardExtNext(current) {
    $('wizard-exterior-page').querySelector('.wizard-step[data-step="' + current + '"]').style.display = 'none';
    $('wizard-exterior-page').querySelector('.wizard-step[data-step="' + (current + 1) + '"]').style.display = '';
  }
  function wizardExtPrev(current) {
    $('wizard-exterior-page').querySelector('.wizard-step[data-step="' + current + '"]').style.display = 'none';
    $('wizard-exterior-page').querySelector('.wizard-step[data-step="' + (current - 1) + '"]').style.display = '';
  }

  // Step 1: 上传 (一个或多个) STEP → 逐文件落盘 tmp → 合并提取 → 预览
  async function doWizExtUpload() {
    const input = $('wiz-ext-step');
    const files = input.files ? Array.from(input.files) : [];
    const resultDiv = $('wiz-ext-result');
    if (!files.length) { resultDiv.className = 'wizard-result'; resultDiv.textContent = '请先选择文件'; return; }
    // 预检: 超过 500MB 前端直接拦截
    for (const file of files) {
      if (file.size > 500 * 1024 * 1024) {
        alert('文件 ' + file.name + ' ' + (file.size / 1048576).toFixed(0) + 'MB 超过 500MB 限制');
        return;
      }
    }
    const btn = $('wiz-ext-upload-btn');
    btn.disabled = true; btn.textContent = '提取中…';
    resultDiv.className = 'wizard-result';
    hideRetry('wiz-ext-result');
    wizExtLastFiles = null;
    wizExtLastSafeName = files[0].name.replace(/[^a-zA-Z0-9._-]/g, '_');
    try {
      // 1. 逐文件上传到 tmp (仅落盘, 不提取)
      const names = [];
      for (let i = 0; i < files.length; i++) {
        resultDiv.textContent = `上传 ${i + 1}/${files.length}: ${files[i].name}`;
        const d = await uploadStep('api/exterior/upload-tmp', files[i], {
          onProgress: (loaded, total) => {
            if (total > 0) resultDiv.textContent = `上传 ${i + 1}/${files.length} ${(loaded / total * 100).toFixed(0)}%`;
          },
        });
        if (!d.ok) throw new Error(d.error);
        names.push(d.filename);
      }
      wizExtLastFiles = names;
      // 2. 合并提取
      resultDiv.textContent = '合并提取中...';
      const d2 = await fetch('api/exterior/extract-multi', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ files: names }),
      }).then(r => r.json());
      if (!d2.ok) throw new Error(d2.error);
      await wizExtHandleResult(d2);
      resultDiv.className = 'wizard-result ok';
      resultDiv.textContent = `提取完成 (${files.length} 文件合并)`;
      hideRetry('wiz-ext-result');
    } catch (e) {
      resultDiv.className = 'wizard-result err';
      resultDiv.textContent = '提取失败: ' + e.message;
      showRetry('wiz-ext-result', doWizExtRetry);
    } finally {
      btn.disabled = false; btn.textContent = '上传并提取';
    }
  }

  // 提取结果后处理: 读 config(raw) + verify(viz) → 预览 (上传与重试共用)
  async function wizExtHandleResult(d) {
    wizExtPath = d.path;
    // raw config (含 outline_raw + 轴线 + regulation), 保存时原样回传
    const cfgR = await fetch('api/exterior/config?path=' + encodeURIComponent(d.path));
    const cfg = await cfgR.json();
    if (!cfg.ok) throw new Error(cfg.error);
    wizExtRaw = cfg.raw || null;
    // 轴线已由提取器从 STEP (AXIS2_PLACEMENT_3D) 提取, 存于 cfg.raw, 保存时直接读, 无需手动输入
    // verify 结果: viz.mirrors[].outlineUV + left/right.fit (球面偏差/球心)
    const vR = await fetch('api/exterior/verify', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: d.path, psi: 0 }),
    });
    const v = await vR.json();
    if (!v.ok) throw new Error(v.error);
    renderWizExtPreview(v);
    const sumEl = $('wiz-ext-summary');
    if (sumEl) sumEl.innerHTML = wizExtSummaryHtml(cfg);
  }

  // 重试提取: 文件已在盘, 不重传, 重新 spawn (多文件走 extract-multi, 单文件走 retry)
  async function doWizExtRetry() {
    const resultDiv = $('wiz-ext-result');
    const retryBtn = $('wiz-ext-result-retry');
    if (retryBtn) retryBtn.disabled = true;
    try {
      resultDiv.className = 'wizard-result';
      let d;
      if (wizExtLastFiles && wizExtLastFiles.length) {
        resultDiv.textContent = '合并提取中...';
        const r = await fetch('api/exterior/extract-multi', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ files: wizExtLastFiles }),
        });
        d = await r.json().catch(() => ({ ok: false, error: '服务器返回非 JSON' }));
      } else {
        const safeName = wizExtLastSafeName || '';
        if (!safeName) { alert('没有可重试的文件, 请重新上传'); return; }
        resultDiv.textContent = '重试提取中...';
        const r = await fetch('api/exterior/extract/retry', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: safeName }),
        });
        d = await r.json().catch(() => ({ ok: false, error: '服务器返回非 JSON' }));
      }
      if (!d.ok) throw new Error(d.error);
      await wizExtHandleResult(d);
      resultDiv.className = 'wizard-result ok';
      resultDiv.textContent = '提取完成';
      hideRetry('wiz-ext-result');
    } catch (e) {
      resultDiv.className = 'wizard-result err';
      resultDiv.textContent = '重试提取失败: ' + e.message;
    } finally {
      if (retryBtn) retryBtn.disabled = false;
    }
  }

  // 预览: 左右 2D 轮廓 (outlineUV 闭合折线) + 球面偏差/球心标注 (只画轮廓, 不画投影/安全线)
  function renderWizExtPreview(v) {
    if (typeof Plotly === 'undefined') return;
    const mirs = (v.viz && v.viz.mirrors) || [];
    const leftMir = mirs.find(m => m.side === 'left') || mirs[0];
    const rightMir = mirs.find(m => m.side === 'right') || mirs[1];
    // 关键: 先显示容器再画 — Plotly 在 display:none 的容器里渲染会拿到 0 尺寸 → 图坍缩成一半
    // (同 commit 942422b 的 Plotly 隐藏渲染 bug)
    $('wiz-ext-preview').style.display = '';
    const draw = (plotDiv, fitDiv, M, fit, label) => {
      if (!M || !Array.isArray(M.outlineUV) || M.outlineUV.length < 3) { $(fitDiv).textContent = label + ': 无轮廓'; return; }
      const ol = M.outlineUV;
      const xs = ol.map(p => p[0]), ys = ol.map(p => p[1]);
      const uMin = Math.min(...xs), uMax = Math.max(...xs), vMin = Math.min(...ys), vMax = Math.max(...ys);
      // 等比例 + 显式 range: 对齐校核页 renderExtMirrorView, 否则 u 跨度>v 跨度时形状被压扁
      const pad = Math.max(uMax - uMin, vMax - vMin) * 0.15;
      xs.push(xs[0]); ys.push(ys[0]);
      Plotly.react(plotDiv, [{
        x: xs, y: ys, mode: 'lines+markers',
        line: { color: '#0071e3', width: 2 },
        marker: { size: 3, color: '#0071e3' },
        fill: 'toself', fillcolor: 'rgba(0,113,227,0.08)',
      }], {
        xaxis: { title: 'u (mm)', range: [uMin - pad, uMax + pad], scaleanchor: 'y', scaleratio: 1, gridcolor: '#f0f0f2', zerolinecolor: '#e4e4e8' },
        yaxis: { title: 'v (mm)', range: [vMin - pad, vMax + pad], gridcolor: '#f0f0f2', zerolinecolor: '#e4e4e8' },
        margin: { l: 50, r: 10, t: 24, b: 40 },
        paper_bgcolor: '#fff', plot_bgcolor: '#fff',
        font: { family: '"Segoe UI", "Microsoft YaHei", sans-serif', color: '#9a9aa0', size: 11 },
        title: { text: ol.length + ' 点', font: { size: 12, color: '#6e6e73' } },
      }, { responsive: true });
      const dev = fit && fit.gate && Number.isFinite(fit.gate.maxDevMm) ? fit.gate.maxDevMm.toFixed(3) : '-';
      const c = fit && Array.isArray(fit.center) ? fit.center.map(x => Number.isFinite(x) ? x.toFixed(2) : '-').join(', ') : '-';
      $(fitDiv).textContent = '球面偏差 ' + dev + 'mm · 球心[' + c + ']';
    };
    draw('wiz-ext-plot-left', 'wiz-ext-fit-left', leftMir, v.left && v.left.fit, '左镜轮廓');
    draw('wiz-ext-plot-right', 'wiz-ext-fit-right', rightMir, v.right && v.right.fit, '右镜轮廓');
  }

  // 提取摘要 (外镜): 紧凑表格 参数|值|状态 (SR/球心L|R/轴线L|R/眼点/地面/车门)
  function wizExtSummaryHtml(cfg) {
    const ok = '<span class="st-ok">✓</span>';
    const warn = '<span class="st-warn">⚠️</span>';
    const rows = [];
    const add = (label, value, good) => rows.push(`<tr><td class="st-k">${label}</td><td class="st-v">${value}</td><td class="st-s">${good ? ok : warn}</td></tr>`);
    const fmt3 = v => (Array.isArray(v) && v.length >= 3) ? '[' + v.map(x => Number.isFinite(x) ? x.toFixed(3) : '-').join(', ') + ']' : 'null';
    const fmt3mm = v => (Array.isArray(v) && v.length >= 3) ? '[' + v.map(x => Number.isFinite(x) ? (x * 1000).toFixed(0) : '-').join(', ') + ']' : 'null';
    // 镜体坐标系 = 原点(旋转中心, mm) + 旋转轴(Y, 系统算) + 折叠轴(Z)
    const frameTxt = (m) => {
      if (!m || !Array.isArray(m.turret_axis_p1)) return 'null';
      const rot = Array.isArray(m.rotation_axis_dir) ? fmt3(m.rotation_axis_dir) : 'null';
      const fold = Array.isArray(m.fold_axis_dir) ? fmt3(m.fold_axis_dir) : 'null';
      return `原点 ${fmt3mm(m.turret_axis_p1)} · 旋转轴 ${rot} · 折叠轴 ${fold}`;
    };

    const L = (cfg.mirrors && cfg.mirrors.left) || {};
    const R = (cfg.mirrors && cfg.mirrors.right) || {};
    const drv = cfg.driver || {};
    const g = cfg.ground || {};
    const dp = cfg.door_panel || {};

    add('SR 校核', L.sr_fit != null ? (L.sr_fit * 1000).toFixed(0) + ' mm' : 'null', L.sr_fit != null);
    // SR 交叉验证 (提取时几何实测半径 vs 标称值, 偏差超公差汇报不阻断)
    if (L.sr_check || R.sr_check) {
      const srTxt = (m) => m.sr_check
        ? `标称 ${(m.sr_check.nominal * 1000).toFixed(0)}±${(m.sr_check.tolerance * 1000).toFixed(0)} · 偏差 ${(m.sr_check.dev_mm >= 0 ? '+' : '') + m.sr_check.dev_mm.toFixed(0)}mm`
        : '-';
      const srAllOk = (L.sr_check ? L.sr_check.ok : true) && (R.sr_check ? R.sr_check.ok : true);
      add('SR 交叉验证', `${srTxt(L)} / ${srTxt(R)}`, srAllOk);
    }
    add('球心 (左)', fmt3mm(L.sphere_center), Array.isArray(L.sphere_center));
    add('球心 (右)', fmt3mm(R.sphere_center), Array.isArray(R.sphere_center));
    add('镜体坐标系 (左)', frameTxt(L), Array.isArray(L.rotation_axis_dir));
    add('镜体坐标系 (右)', frameTxt(R), Array.isArray(R.rotation_axis_dir));
    const eye = drv.eye_left_raw != null
      ? `${fmt3mm(drv.eye_left_raw)} · IPD ${drv.interpupillary_distance != null ? (drv.interpupillary_distance * 1000).toFixed(1) + 'mm' : 'null'}` : 'null';
    add('眼点', eye, drv.eye_left_raw != null);
    add('参考地平线', `前 ${fmt3mm(g.front_mid)} · 后 ${fmt3mm(g.rear_mid)}`, g.front_mid != null);
    add('车门 Y', `左 ${dp.door_outer_Y_left != null ? (dp.door_outer_Y_left * 1000).toFixed(1) : '-'} · 右 ${dp.door_outer_Y_right != null ? (dp.door_outer_Y_right * 1000).toFixed(1) : '-'}`, dp.door_outer_Y_left != null);

    return `<table class="extract-summary-table"><tbody>${rows.join('')}</tbody></table>`;
  }

  // 保存并校核 — 深拷贝 raw, 轴线已由提取器写入, 直接 POST /api/exterior/save
  async function doWizExtSave() {
    const btn = $('wiz-ext-save-btn');
    const name = ($('wiz-ext-name').value || '新外镜车型').trim();
    if (!wizExtRaw) { alert('请先完成整车 STEP 提取'); return; }
    btn.disabled = true; btn.textContent = '保存中…';
    try {
      const config = JSON.parse(JSON.stringify(wizExtRaw));
      // 轴线直接从 STEP 提取结果读 (工作流: 用户只上传一次, 提取器从 AXIS2_PLACEMENT_3D 提取)
      const axL = config.exterior_mirror_left && config.exterior_mirror_left.rotation_axis_dir;
      const axR = config.exterior_mirror_right && config.exterior_mirror_right.rotation_axis_dir;
      const isDefault = d => !d || (Math.abs(d[0]) < 1e-6 && Math.abs(d[1] - 1) < 1e-6 && Math.abs(d[2]) < 1e-6);
      if (isDefault(axL) || isDefault(axR)) {
        btn.disabled = false; btn.textContent = '保存并校核';
        alert('STEP 未提取到镜体坐标系 (AXIS2_PLACEMENT_3D)。\n请确认供应商 STEP 含命名「左镜体坐标系/右镜体坐标系」的坐标系。');
        return;
      }
      if (!config.vehicle) config.vehicle = {};
      config.vehicle.name = name;
      const r = await fetch('api/exterior/save', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, config }),
      });
      const d = await r.json();
      if (!d.ok) throw new Error(d.error);
      // 跳校核页: 只绑定一次 DOM (不触发自动加载, 避免竞态), 再显式加载新车型
      if (!pages.exterior.__inited) {
        pages.exterior.__inited = true;
        initExteriorDOM();
      }
      await loadExtVehicles();
      $('ext-vehicle-select').value = d.path;
      await loadExtConfig(d.path);
      await doExtVerify();
      showPage('exterior');
    } catch (e) {
      alert('保存失败: ' + e.message);
    } finally { btn.disabled = false; btn.textContent = '保存并校核'; }
  }

  // ====== 供应商 STEP 标注要求 (一键复制给供应商) ======
  const INTERIOR_SPEC_TEXT = `【内后视镜 STEP 标注要求】
坐标系：整车坐标系（X+后方、Y+乘客右、Z+上方，单位 mm）

请在 STEP 文件内，对以下几何实体命名标注（赋实体名）：

【点的标注】CARTESIAN_POINT
· 球铰 —— 镜片球铰中心点（旋转中心）
· 镜心 —— 镜面 yaw=pitch=0（处于原始位置）时的几何中心点
· 眼点左 / 眼点右 —— 驾驶员左右眼点
· 地面前 / 地面后 —— 参考地平线前端中点 / 后端中点

【面的标注】ADVANCED_FACE
· 镜片 —— 镜片反射 CAS 面
· 后挡风 —— 后挡风外框 CAS 面`;

  const EXTERIOR_SPEC_TEXT = `【外后视镜 STEP 标注要求】
坐标系：整车坐标系（X+后方、Y+乘客右、Z+上方，单位 mm）

请在 STEP 文件内，对以下几何实体命名标注（赋实体名）：

【面的标注】ADVANCED_FACE
· 镜片左 / 镜片右 —— 左右凸球面镜片 CAS 面

【坐标系的标注】AXIS2_PLACEMENT_3D
· 左镜体坐标系 / 右镜体坐标系 —— 镜体坐标系（原点=旋转中心 p1，Z轴=折叠轴，X轴=镜面右向，Y轴=旋转轴）

【点的标注】CARTESIAN_POINT
· 眼点左 / 眼点右 —— 驾驶员左右眼点
· 地面前 / 地面后 —— 参考地平线前端中点 / 后端中点
· 车门左 / 车门右 —— 车门蒙皮主面最外点

【参数】球面半径 SR
· SR 设计标称值 + 公差（如 1260 ± 60 mm）—— 供应商图纸提供，系统与 STEP 提取的球面半径交叉验证`;

  async function copySupplierSpec(text, btn) {
    try {
      await navigator.clipboard.writeText(text);
      const orig = btn.textContent;
      btn.textContent = '已复制 ✓';
      setTimeout(() => { btn.textContent = orig; }, 2000);
    } catch (e) {
      alert('复制失败: ' + e.message);
    }
  }

  function initWizardExterior() {
    $('wiz-ext-back').addEventListener('click', () => showPage('mirror-type'));
    $('wiz-ext-copy-spec').addEventListener('click', () => copySupplierSpec(EXTERIOR_SPEC_TEXT, $('wiz-ext-copy-spec')));
    $('wiz-ext-upload-btn').addEventListener('click', () => doWizExtUpload());
    $('wiz-ext-step').addEventListener('change', () => doWizExtUpload());
    $('wiz-ext-save-btn').addEventListener('click', doWizExtSave);
  }

  // ====== 内后视镜新建向导 (阶段 7: 一 STEP 全自动) ======
  let wizIntResult = null;  // 提取的完整内镜 JSON (车型C.json 结构, 含 _meta.outline_local_mm)

  function wizardIntNext(current) {
    $('wizard-interior-page').querySelector('.wizard-step[data-step="' + current + '"]').style.display = 'none';
    $('wizard-interior-page').querySelector('.wizard-step[data-step="' + (current + 1) + '"]').style.display = '';
  }
  function wizardIntPrev(current) {
    $('wizard-interior-page').querySelector('.wizard-step[data-step="' + current + '"]').style.display = 'none';
    $('wizard-interior-page').querySelector('.wizard-step[data-step="' + (current - 1) + '"]').style.display = '';
  }

  function fmtWizIntVec(v) {
    return v && v.length >= 3 ? '[' + v.map(x => (Number.isFinite(x) ? x.toFixed(4) : '-')).join(', ') + ']' : 'null';
  }
  function wizIntSummaryHtml(r) {
    const m = r.mirror || {}, d = r.driver || {}, g = r.ground || {}, rw = r.rear_window || {};
    const missing = (r._meta && r._meta.missing_named) || [];
    const ok = '<span class="st-ok">✓</span>';
    const warn = '<span class="st-warn">⚠️</span>';
    const rows = [];
    const add = (label, value, good) => rows.push(`<tr><td class="st-k">${label}</td><td class="st-v">${value}</td><td class="st-s">${good ? ok : warn}</td></tr>`);

    const wh = (m.width != null && m.height != null)
      ? `宽 ${(m.width * 1000).toFixed(2)}mm · 高 ${(m.height * 1000).toFixed(2)}mm` : 'null';
    add('镜面', wh, m.width != null && m.height != null);

    const ang = (m.yaw != null && m.pitch != null)
      ? `yaw ${m.yaw.toFixed(2)}° · pitch ${m.pitch.toFixed(2)}°` : 'null';
    add('安装角', ang, m.yaw != null && m.pitch != null);

    add('球铰 pivot', fmtWizIntVec(m.pivot), m.pivot != null);
    add('镜面中心', fmtWizIntVec(m.center_zero), m.center_zero != null);

    const eye = d.eye_center != null
      ? `${fmtWizIntVec(d.eye_center)} · IPD ${((d.interpupillary_distance || 0) * 1000).toFixed(1)}mm` : 'null';
    add('眼点', eye, d.eye_center != null);

    const ground = (g.front_mid != null && g.rear_mid != null)
      ? `前 ${fmtWizIntVec(g.front_mid)} · 后 ${fmtWizIntVec(g.rear_mid)}` : 'null';
    add('参考地平线', ground, g.front_mid != null && g.rear_mid != null);

    const rwOk = !!(rw.outline && rw.outline.length);
    add('后挡风', rwOk ? `${rw.outline.length} 点` : '未命名 (可空)', rwOk);

    if (missing.length) rows.push(`<tr><td class="st-k">缺命名</td><td class="st-v">${missing.join('; ')}</td><td class="st-s">${warn}</td></tr>`);

    return `<table class="extract-summary-table"><tbody>${rows.join('')}</tbody></table>`;
  }

  // Step 1: 上传整车 STEP → 提取到 tmp → 预览镜面轮廓 2D + 参数摘要
  async function doWizIntUpload() {
    const input = $('wiz-int-step');
    const files = input.files ? Array.from(input.files) : [];
    const resultDiv = $('wiz-int-result');
    if (!files.length) { resultDiv.className = 'wizard-result'; resultDiv.textContent = '请先选择文件'; return; }
    // 预检: 超过 500MB 前端直接拦截
    for (const file of files) {
      if (file.size > 500 * 1024 * 1024) {
        alert('文件 ' + file.name + ' ' + (file.size / 1048576).toFixed(0) + 'MB 超过 500MB 限制');
        return;
      }
    }
    const btn = $('wiz-int-upload-btn');
    btn.disabled = true; btn.textContent = '提取中…';
    resultDiv.className = 'wizard-result';
    hideRetry('wiz-int-result');
    wizIntLastFiles = null;
    wizIntLastSafeName = files[0].name.replace(/[^a-zA-Z0-9._-]/g, '_');
    try {
      // 1. 逐文件上传到 tmp (仅落盘, 不提取)
      const names = [];
      for (let i = 0; i < files.length; i++) {
        resultDiv.textContent = `上传 ${i + 1}/${files.length}: ${files[i].name}`;
        const d = await uploadStep('api/interior/upload-tmp', files[i], {
          onProgress: (loaded, total) => {
            if (total > 0) resultDiv.textContent = `上传 ${i + 1}/${files.length} ${(loaded / total * 100).toFixed(0)}%`;
          },
        });
        if (!d.ok) throw new Error(d.error);
        names.push(d.filename);
      }
      wizIntLastFiles = names;
      // 2. 合并提取
      resultDiv.textContent = '合并提取中...';
      const d2 = await fetch('api/interior/extract-multi', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ files: names }),
      }).then(r => r.json());
      if (!d2.ok) throw new Error(d2.error);
      wizIntHandleResult(d2);
      resultDiv.className = 'wizard-result ok';
      resultDiv.textContent = `提取完成 (${files.length} 文件合并)`;
      hideRetry('wiz-int-result');
    } catch (e) {
      resultDiv.className = 'wizard-result err';
      resultDiv.textContent = '提取失败: ' + e.message;
      showRetry('wiz-int-result', doWizIntRetry);
    } finally {
      btn.disabled = false; btn.textContent = '上传并提取';
    }
  }

  // 提取结果后处理: 预览镜面轮廓 + 参数摘要 (上传与重试共用)
  function wizIntHandleResult(d) {
    wizIntResult = d.result || null;
    if (!wizIntResult) throw new Error('提取结果为空');
    renderWizIntPreview(wizIntResult);
    renderWizIntRwPreview(wizIntResult);
  }

  // 重试提取: STEP 已在盘, 不重传, 调 /api/interior/extract/retry 重新 spawn
  async function doWizIntRetry() {
    const resultDiv = $('wiz-int-result');
    const retryBtn = $('wiz-int-result-retry');
    if (retryBtn) retryBtn.disabled = true;
    try {
      resultDiv.className = 'wizard-result';
      let d;
      if (wizIntLastFiles && wizIntLastFiles.length) {
        resultDiv.textContent = '合并提取中...';
        const r = await fetch('api/interior/extract-multi', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ files: wizIntLastFiles }),
        });
        d = await r.json().catch(() => ({ ok: false, error: '服务器返回非 JSON' }));
      } else {
        const safeName = wizIntLastSafeName || '';
        if (!safeName) { alert('没有可重试的文件, 请重新上传'); return; }
        resultDiv.textContent = '重试提取中...';
        const r = await fetch('api/interior/extract/retry', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: safeName }),
        });
        d = await r.json().catch(() => ({ ok: false, error: '服务器返回非 JSON' }));
      }
      if (!d.ok) throw new Error(d.error);
      wizIntHandleResult(d);
      resultDiv.className = 'wizard-result ok';
      resultDiv.textContent = '提取完成';
      hideRetry('wiz-int-result');
    } catch (e) {
      resultDiv.className = 'wizard-result err';
      resultDiv.textContent = '重试提取失败: ' + e.message;
    } finally {
      if (retryBtn) retryBtn.disabled = false;
    }
  }

  // 预览: 镜面轮廓 2D (outline_local_mm 闭合折线) + 尺寸/安装角标注 (平面镜, 无球面偏差)
  function renderWizIntPreview(r) {
    const ol = r._meta && r._meta.outline_local_mm;
    $('wiz-int-preview').style.display = '';
    const m = r.mirror || {};
    if (typeof Plotly === 'undefined') {
      $('wiz-int-summary').innerHTML = wizIntSummaryHtml(r);
      return;
    }
    if (!ol || ol.length < 3) {
      $('wiz-int-summary').innerHTML = '无镜面轮廓 (缺 INNER_MIRROR_GLASS 命名面)。<br>' + wizIntSummaryHtml(r);
      return;
    }
    const xs = ol.map(p => p[0]), ys = ol.map(p => p[1]);
    const uMin = Math.min(...xs), uMax = Math.max(...xs), vMin = Math.min(...ys), vMax = Math.max(...ys);
    const pad = Math.max(uMax - uMin, vMax - vMin) * 0.15;
    xs.push(xs[0]); ys.push(ys[0]);
    Plotly.react('wiz-int-plot', [{
      x: xs, y: ys, mode: 'lines+markers',
      line: { color: '#0071e3', width: 2 },
      marker: { size: 3, color: '#0071e3' },
      fill: 'toself', fillcolor: 'rgba(0,113,227,0.08)',
    }], {
      xaxis: { title: 'u (mm)', range: [uMin - pad, uMax + pad], scaleanchor: 'y', scaleratio: 1, gridcolor: '#f0f0f2', zerolinecolor: '#e4e4e8' },
      yaxis: { title: 'v (mm)', range: [vMin - pad, vMax + pad], gridcolor: '#f0f0f2', zerolinecolor: '#e4e4e8' },
      margin: { l: 50, r: 10, t: 24, b: 40 },
      paper_bgcolor: '#fff', plot_bgcolor: '#fff',
      font: { family: '"Segoe UI", "Microsoft YaHei", sans-serif', color: '#9a9aa0', size: 11 },
      title: { text: ol.length + ' 点', font: { size: 12, color: '#6e6e73' } },
    }, { responsive: true });
    $('wiz-int-summary').innerHTML = wizIntSummaryHtml(r);
  }

  // 后挡风轮廓预览: 提取到 rear_window.outline (3D 米) → 画 Y-Z 2D 轮廓; 否则显示缺命名提示
  function renderWizIntRwPreview(r) {
    const el = $('wiz-int-plot-rw');
    if (!el) return;
    const rw = (r && r.rear_window) || {};
    const ol = rw.outline;
    if (typeof Plotly === 'undefined') {
      el.innerHTML = '<div style="padding:70px 12px;text-align:center;color:#9a9aa0;font-size:12px">Plotly 未加载, 无法预览</div>';
      return;
    }
    if (!ol || ol.length < 3) {
      el.innerHTML = '<div style="padding:70px 12px;text-align:center;color:#ff9f0a;font-size:12px">⚠️ 缺 "后挡风" 命名面, 无法预览后挡风轮廓</div>';
      return;
    }
    const is2D = ol[0] && ol[0].length === 2;
    const xs = ol.map(p => (is2D ? p[0] : p[1]) * 1000); // mm
    const ys = ol.map(p => (is2D ? p[1] : p[2]) * 1000);
    xs.push(xs[0]); ys.push(ys[0]);
    const uMin = Math.min(...xs), uMax = Math.max(...xs), vMin = Math.min(...ys), vMax = Math.max(...ys);
    const pad = Math.max(uMax - uMin, vMax - vMin) * 0.15;
    Plotly.react(el, [{
      x: xs, y: ys, mode: 'lines+markers',
      line: { color: '#0071e3', width: 2 },
      marker: { size: 3, color: '#0071e3' },
      fill: 'toself', fillcolor: 'rgba(0,113,227,0.08)',
    }], {
      xaxis: { title: 'y (mm)', range: [uMin - pad, uMax + pad], scaleanchor: 'y', scaleratio: 1, gridcolor: '#f0f0f2', zerolinecolor: '#e4e4e8' },
      yaxis: { title: 'z (mm)', range: [vMin - pad, vMax + pad], gridcolor: '#f0f0f2', zerolinecolor: '#e4e4e8' },
      margin: { l: 50, r: 10, t: 24, b: 40 },
      paper_bgcolor: '#fff', plot_bgcolor: '#fff',
      font: { family: '"Segoe UI", "Microsoft YaHei", sans-serif', color: '#9a9aa0', size: 11 },
      title: { text: ol.length + ' 点', font: { size: 12, color: '#6e6e73' } },
    }, { responsive: true });
  }

  // Step 3: 保存并校核 — 深拷贝 wizIntResult (轮廓已 inline), 单接口 POST /api/interior/save → 跳 inner-page。
  // 对齐 doWizExtSave: 无 车型C 硬编码默认值, 关键参数任一 null → 提示缺哪个 + 阻止保存 (不兜底)。
  async function doWizIntSave() {
    const btn = $('wiz-int-save-btn');
    const name = ($('wiz-int-name').value || '新内镜车型').trim();
    if (!wizIntResult) { alert('请先完成整车 STEP 提取'); return; }
    const r = wizIntResult;
    const m = r.mirror || {}, d = r.driver || {}, g = r.ground || {};

    // 关键参数缺失防护: 任一 null → 提示缺哪个 + 不保存 (不再兜底 224.796/-23.5/5.0 等硬编码默认值)
    const missing = [];
    if (m.pivot == null) missing.push('pivot');
    if (m.center_zero == null) missing.push('center_zero');
    if (m.width == null) missing.push('width');
    if (m.height == null) missing.push('height');
    if (m.yaw == null) missing.push('yaw');
    if (m.pitch == null) missing.push('pitch');
    if (d.eye_center == null) missing.push('eye_center');
    if (g.front_mid == null || g.rear_mid == null) missing.push('ground');
    if (missing.length) {
      alert('提取缺关键参数: ' + missing.join(' / ') +
        '\n\n无法保存校核, 请让供应商按内镜规范补全对应命名后重试。');
      return;
    }

    btn.disabled = true; btn.textContent = '保存中…';
    try {
      const config = JSON.parse(JSON.stringify(wizIntResult));
      if (!config.vehicle) config.vehicle = {};
      config.vehicle.name = name;
      const resp = await fetch(API_BASE + '/interior/save', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, config }),
      });
      const d = await resp.json();
      if (!d.ok) throw new Error(d.error);

      // 跳校核页 (DOM 就绪 + 加载, 避免 initInner 竞态)
      if (!pages.inner.__inited) {
        pages.inner.__inited = true;
        initInnerDOM();
      }
      await loadVehicles();
      $('vehicle-select').value = d.path;
      showPage('inner');
      await loadVehicleConfig(d.path);
      await doVerify();
    } catch (e) {
      alert('保存失败: ' + e.message);
    } finally { btn.disabled = false; btn.textContent = '保存并校核'; }
  }

  function initWizardInterior() {
    $('wiz-int-back').addEventListener('click', () => showPage('mirror-type'));
    $('wiz-int-copy-spec').addEventListener('click', () => copySupplierSpec(INTERIOR_SPEC_TEXT, $('wiz-int-copy-spec')));
    $('wiz-int-upload-btn').addEventListener('click', () => doWizIntUpload());
    $('wiz-int-step').addEventListener('change', () => doWizIntUpload());
    $('wiz-int-save-btn').addEventListener('click', doWizIntSave);
  }

  async function loadExtVehicles() {
    try {
      const r = await fetch('api/exterior/vehicles');
      const d = await r.json();
      const sel = $('ext-vehicle-select');
      sel.innerHTML = '';
      for (const v of (d.vehicles || [])) {
        const opt = document.createElement('option');
        opt.value = v.value; opt.textContent = v.label;
        sel.appendChild(opt);
      }
    } catch (e) { $('ext-status').textContent = '车型列表加载失败: ' + e.message; }
  }

  async function loadExtConfig(path) {
    try {
      const r = await fetch('api/exterior/config?path=' + encodeURIComponent(path || ''));
      const d = await r.json();
      if (!d.ok) throw new Error(d.error);
      extCurrentPath = d.path;
      extRawConfig = d.raw || null;
      const set = (id, v) => { const el = $(id); if (el) el.value = v; };
      const L = d.mirrors.left, R = d.mirrors.right;
      // 单位统一 mm: 坐标/标量 m→mm 显示; 方向向量 (旋转轴/折叠轴) 无量纲不转换
      const mm = v => (v == null ? v : +(v * 1000).toFixed(3));
      set('ext-sr-fit', mm(L.sr_fit));
      set('ext-profile-tol', L.profile_tol_mm ?? 0.3);
      ['x', 'y', 'z'].forEach((ax, i) => {
        set('ext-c-L-' + ax, mm(L.sphere_center[i])); set('ext-c-R-' + ax, mm(R.sphere_center[i]));
        set('ext-p1-L-' + ax, mm(L.turret_axis_p1[i])); set('ext-p1-R-' + ax, mm(R.turret_axis_p1[i]));
        set('ext-axis-L-' + ax, L.rotation_axis_dir[i]); set('ext-axis-R-' + ax, R.rotation_axis_dir[i]);
        set('ext-fold-L-' + ax, L.fold_axis_dir ? L.fold_axis_dir[i] : '');
        set('ext-fold-R-' + ax, R.fold_axis_dir ? R.fold_axis_dir[i] : '');
      });
      setExtAxisHint('L', L.rotation_axis_dir); setExtAxisHint('R', R.rotation_axis_dir);
      ['x', 'y', 'z'].forEach((ax, i) => {
        set('ext-eye-L-' + ax, mm(d.driver.eye_left_raw[i]));
        set('ext-eye-R-' + ax, mm(d.driver.eye_right_raw[i]));
      });
      set('ext-ipd', mm(d.driver.interpupillary_distance));
      set('ext-door-L', mm(d.door_panel.door_outer_Y_left)); set('ext-door-R', mm(d.door_panel.door_outer_Y_right));
      set('ext-gf', d.ground.front_mid.map(v => mm(v).toFixed(1)).join(', '));
      set('ext-gr', d.ground.rear_mid.map(v => mm(v).toFixed(1)).join(', '));
      $('ext-badge-left').textContent = '左 --'; $('ext-badge-left').className = 'verdict-badge-md';
      $('ext-badge-right').textContent = '右 --'; $('ext-badge-right').className = 'verdict-badge-md';
      $('ext-verdict-detail').textContent = '点击校核';
      $('ext-verdict-edges-left').innerHTML = ''; $('ext-verdict-edges-right').innerHTML = '';
      $('ext-verdict-fit').textContent = ''; $('ext-verdict-fit').style.display = 'none'; $('ext-auto-status').textContent = '';
      $('ext-status').textContent = '';
      // 折叠头摘要 (SR / 球心 / 眼距)
      const esum = $('ext-params-summary');
      if (esum) {
        const cL = L.sphere_center || [];
        const ipdMm = d.driver.interpupillary_distance != null ? (d.driver.interpupillary_distance * 1000).toFixed(1) : '-';
        esum.textContent = `SR=${L.sr_fit != null ? (L.sr_fit * 1000).toFixed(0) + 'mm' : '-'} · 球心=[${cL.map(v => (v * 1000).toFixed(0)).join(', ')}] · 眼距=${ipdMm}mm`;
      }
      // 缺左右调节轴 (fold_axis_dir) 时提示: θ 不生效
      const hasFold = L.fold_axis_dir || R.fold_axis_dir;
      if (!hasFold) {
        $('ext-auto-status').textContent = '⚠️ 当前车型缺左右调节轴 (fold_axis_dir), θ 左右角度不生效。重新提取 STEP 或补录轴线可解决。';
        $('ext-auto-status').style.color = '#ff9f0a';
      } else {
        $('ext-auto-status').textContent = '';
        $('ext-auto-status').style.color = '';
      }
    } catch (e) { $('ext-status').textContent = '加载失败: ' + e.message; }
  }

  // 轴线补录: 默认 [0,1,0] 时提示补录真轴 (轴线已从 AXIS2_PLACEMENT_3D 提取, 默认轴为提取失败时的兜底)
  function setExtAxisHint(side, dir) {
    const el = $('ext-axis-hint-' + side);
    if (!el) return;
    const isDefault = Array.isArray(dir) && dir.length >= 3
      && Math.abs(dir[0]) < 1e-6 && Math.abs(dir[1] - 1) < 1e-6 && Math.abs(dir[2]) < 1e-6;
    el.style.color = isDefault ? '#ff9f0a' : '#9a9aa0';
    el.textContent = isDefault
      ? '使用默认轴 [0,1,0], 建议补录真轴'
      : '已补录真轴 [' + dir.map(v => v.toFixed(4)).join(', ') + ']';
  }

  // 读取某侧旋转轴方向输入, 非法 (NaN/零向量) 返回 null
  function readExtAxis(side) {
    const v = ['x', 'y', 'z'].map(ax => parseFloat($('ext-axis-' + side + '-' + ax).value));
    if (v.some(n => !Number.isFinite(n))) return null;
    if (Math.hypot(v[0], v[1], v[2]) < 1e-9) return null;
    return v;
  }

  // 读取镜片轮廓度输入 (mm, 对称 ±), 非法/非正回退 0.3
  function readProfileTol() {
    const el = $('ext-profile-tol');
    const v = el ? parseFloat(el.value) : NaN;
    return (Number.isFinite(v) && v > 0) ? v : 0.3;
  }

  // 从输入卡回写轴线 + 轮廓度到完整 JSON 副本 (深拷贝, 不污染 extRawConfig)
  function extPatchedConfig() {
    const axisL = readExtAxis('L'), axisR = readExtAxis('R');
    if (!axisL || !axisR) throw new Error('旋转轴方向向量非法 (需非零 3 维向量)');
    const profileTol = readProfileTol();
    const config = JSON.parse(JSON.stringify(extRawConfig));
    if (!config.exterior_mirror_left) config.exterior_mirror_left = {};
    if (!config.exterior_mirror_right) config.exterior_mirror_right = {};
    config.exterior_mirror_left.rotation_axis_dir = axisL;
    config.exterior_mirror_right.rotation_axis_dir = axisR;
    config.exterior_mirror_left.profile_tol_mm = profileTol;
    config.exterior_mirror_right.profile_tol_mm = profileTol;
    return config;
  }

  // 保存 (覆盖当前车型) — 默认车型被后端拦截, 需另存为
  async function doExtSave() {
    if (!extRawConfig) { $('ext-status').textContent = '请先加载车型'; return; }
    const name = $('ext-vehicle-select').selectedOptions[0]?.textContent || '新外镜车型';
    try {
      const config = extPatchedConfig();
      const r = await fetch('api/exterior/save', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, path: extCurrentPath, config }),
      });
      const d = await r.json();
      if (!d.ok) throw new Error(d.error);
      await loadExtVehicles();
      await loadExtConfig(d.path);
      await doExtVerify();
      $('ext-status').textContent = '已保存: ' + String(d.path || '').split(/[\\/]/).pop();
    } catch (e) {
      $('ext-status').textContent = '保存失败: ' + e.message;
      alert('保存失败: ' + e.message);
    }
  }

  // 另存为 (不传 path → 后端按 name 生成新文件; 默认车型保护也在此生效)
  async function doExtSaveAs() {
    if (!extRawConfig) { $('ext-status').textContent = '请先加载车型'; return; }
    const name = (prompt('输入新外镜车型名称:') || '').trim();
    if (!name) return;
    try {
      const config = extPatchedConfig();
      const r = await fetch('api/exterior/save', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, config }),
      });
      const d = await r.json();
      if (!d.ok) throw new Error(d.error);
      await loadExtVehicles();
      await loadExtConfig(d.path);
      await doExtVerify();
      $('ext-status').textContent = '已另存为: ' + name;
    } catch (e) {
      $('ext-status').textContent = '另存为失败: ' + e.message;
      alert('另存为失败: ' + e.message);
    }
  }

  // 删除当前车型 — 默认车型被后端拦截
  async function doExtDelete() {
    if (!extCurrentPath) return;
    if (!confirm('确定删除该外镜车型？此操作不可撤销。')) return;
    try {
      const r = await fetch('api/exterior/delete', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: extCurrentPath }),
      });
      const d = await r.json();
      if (!d.ok) throw new Error(d.error);
      await loadExtVehicles();
      await loadExtConfig($('ext-vehicle-select').value);
      await doExtVerify();
      $('ext-status').textContent = '已删除车型';
    } catch (e) {
      $('ext-status').textContent = '删除失败: ' + e.message;
      alert('删除失败: ' + e.message);
    }
  }

  async function doExtVerify() {
    const btn = $('ext-verify-btn');
    btn.disabled = true; btn.textContent = '校核中…'; $('ext-status').textContent = '';
    const psi = parseFloat($('ext-psi').value) || 0;
    const theta = parseFloat($('ext-theta').value) || 0;
    try {
      const r = await fetch('api/exterior/verify', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: extCurrentPath || '', psi, theta, search: false }),
      });
      const d = await r.json();
      if (!d.ok) throw new Error(d.error);
      renderExtVerdict(d);
      renderExtPlot(d.viz);
    } catch (e) { $('ext-status').textContent = '校核失败: ' + e.message; }
    finally { btn.disabled = false; btn.textContent = '校核'; }
  }

  // 自动搜角: 找一个 ψ 使两镜都过, 应用并重新渲染
  async function doExtAuto() {
    const btn = $('ext-auto-btn');
    btn.disabled = true; btn.textContent = '搜索中…'; $('ext-auto-status').textContent = '正在搜索…';
    try {
      const r0 = await fetch('api/exterior/verify', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: extCurrentPath || '', psi: 0, search: true }),
      });
      const d0 = await r0.json();
      if (!d0.ok) throw new Error(d0.error);
      const cs = d0.commonSearch;
      if (!cs.found) {
        renderExtVerdict(d0); renderExtPlot(d0.viz);
        $('ext-auto-status').textContent = '±3° 内无两镜都过的角度';
        return;
      }
      // 应用最佳 ψ/θ, 回填输入框, 重新校核渲染
      const bestPsi = cs.bestPsi ?? 0;
      const bestTheta = cs.bestTheta ?? 0;
      $('ext-psi').value = bestPsi;
      $('ext-theta').value = bestTheta;
      const r1 = await fetch('api/exterior/verify', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: extCurrentPath || '', psi: bestPsi, theta: bestTheta, search: false }),
      });
      const d1 = await r1.json();
      if (!d1.ok) throw new Error(d1.error);
      renderExtVerdict(d1); renderExtPlot(d1.viz);
      $('ext-auto-status').textContent = `已应用 ψ=${bestPsi}° θ=${bestTheta}° (窗口 [${cs.window.join(', ')}]°)`;
    } catch (e) { $('ext-auto-status').textContent = '搜索失败: ' + e.message; }
    finally { btn.disabled = false; btn.textContent = '自动搜角'; }
  }

  function renderExtVerdict(d) {
    const side = (s, r) => {
      const b = $('ext-badge-' + s);
      b.textContent = (s === 'left' ? '左 ' : '右 ') + (r.mirrorPass ? 'PASS' : 'FAIL');
      b.className = 'verdict-badge-md ' + (r.mirrorPass ? 'badge-pass' : 'badge-fail');
    };
    side('left', d.left); side('right', d.right);
    const hasSearch = (s) => s.search && s.search.found;
    $('ext-verdict-detail').textContent = `ψ=${d.psi != null ? d.psi : 0}° θ=${d.theta != null ? d.theta : 0}° · ${d.left.mirrorPass && d.right.mirrorPass ? '两镜均通过' : (hasSearch(d.left) || hasSearch(d.right) ? '±3° 内有解' : (d.left.search == null ? '自动搜角可查' : '±3° 内无解'))}`;

    // 行式判定: 每镜近/远场主行 + 三边 AB/BT/TA 采样子行 (证据链, 对齐内镜五线法)
    // marginMm < 轮廓度 → 距边落在加工不确定带内 (名义在面但可能因缺料实际 off) → 标注「可能超出加工边界」
    const zoneRow = (label, pass, marginMm, profileTolMm) => {
      const cls = pass ? 'ok' : 'no';
      const sign = pass ? '✓' : '✗';
      const color = pass ? 'var(--pass)' : 'var(--fail)';
      const overProfile = !pass && marginMm != null && Number.isFinite(profileTolMm) && marginMm < profileTolMm;
      const info = overProfile ? '可能超出加工边界' : (pass ? '满足' : '不足');
      const margin = marginMm != null ? `${marginMm.toFixed(1)} mm` : '—';
      return `<div class="verdict-line-row ${cls}">` +
             `<span class="verdict-line-name">${label}</span>` +
             `<span class="verdict-line-info" style="color:${color}">${sign} ${info}</span>` +
             `<span class="verdict-line-dist">${margin}</span>` +
             `</div>`;
    };
    // 三边采样子行: 每条边可见采样数 (x/y), 揭示"双眼反射点都落在镜面内"的证据
    const edgeRow = (edges) => {
      if (!edges || !edges.length) return '';
      const items = edges.map(e =>
        `<span class="edge-item${e.pass ? '' : ' edge-fail'}">${e.name} ${e.visible}</span>`).join('');
      return `<div class="verdict-edge-detail">${items}</div>`;
    };
    // 球面拟合 (栏内底部): SR/残差/交叉校核 — 并入各栏, 竖虚线从上到下贯通
    const fitItem = (r) => {
      const f = r.fit || {}, cc = f.crossCheck || {};
      const sr = Number.isFinite(f.radius) ? f.radius.toFixed(3) : '-';
      const res = Number.isFinite(f.residualMm)
        ? (Math.abs(f.residualMm) >= 0.01 ? f.residualMm.toFixed(2)
           : Math.abs(f.residualMm) >= 0.001 ? f.residualMm.toFixed(3)
           : f.residualMm.toExponential(0))
        : '-';
      const crossOk = cc.ok === true ? '✓' : (cc.ok === false ? '✗' : '-');
      const dev = Number.isFinite(cc.devMm) ? `${cc.devMm.toFixed(1)}mm` : '-';
      const tol = Number.isFinite(r.profileTolMm) ? `±${r.profileTolMm.toFixed(1)}mm` : '-';
      return `<div class="verdict-fit-item">` +
             `<span class="verdict-fit-label">球面拟合</span>` +
             `<span class="verdict-fit-kv">SR <b>${sr}</b></span>` +
             `<span class="verdict-fit-kv">残差 <b>${res}mm</b></span>` +
             `<span class="verdict-fit-kv">交叉${crossOk} <b>${dev}</b></span>` +
             `<span class="verdict-fit-kv">轮廓度 <b>${tol}</b></span>` +
             `</div>`;
    };
    const sideBlock = (r) =>
      zoneRow('近场 1m', r.nearPass, r.nearMinMargin, r.profileTolMm) + edgeRow(r.nearEdges) +
      zoneRow('远场 4m', r.farPass, r.farMinMargin, r.profileTolMm) + edgeRow(r.farEdges) +
      fitItem(r);
    $('ext-verdict-edges-left').innerHTML = sideBlock(d.left);
    $('ext-verdict-edges-right').innerHTML = sideBlock(d.right);
    $('ext-verdict-fit').innerHTML = '';
    $('ext-verdict-fit').style.display = 'none';
  }

  // 轮廓内偏移 3mm 安全线 (法规: 视野线到边缘安全距离 > 3mm)
  // 用局部法线偏移 (对密集点精确), 法线指向多边形内部 (质心方向)
  function computeSafetyLine(outlineUV, offsetMm) {
    const n = outlineUV.length;
    if (n < 3) return [];
    // 质心
    let cx = 0, cy = 0;
    for (const p of outlineUV) { cx += p[0]; cy += p[1]; }
    cx /= n; cy /= n;
    const out = [];
    for (let i = 0; i < n; i++) {
      const prev = outlineUV[(i - 1 + n) % n];
      const next = outlineUV[(i + 1) % n];
      // 局部切线 = 相邻点差分
      let tx = next[0] - prev[0], ty = next[1] - prev[1];
      const tl = Math.hypot(tx, ty);
      if (tl < 1e-9) continue;
      tx /= tl; ty /= tl;
      // 法线 (切线旋转 90°), 选指向质心的一侧
      let nx = -ty, ny = tx;
      if (nx * (cx - outlineUV[i][0]) + ny * (cy - outlineUV[i][1]) < 0) { nx = -nx; ny = -ny; }
      out.push([outlineUV[i][0] + nx * offsetMm, outlineUV[i][1] + ny * offsetMm]);
    }
    return out;
  }

  // ── 2D 反射面投影 (同内镜 mirror-view 风格: u-v mm, 轮廓 + 安全线 + 4 投影点) ──
  function renderExtMirrorView(divId, M, pass) {
    if (typeof Plotly === 'undefined') { console.warn('Plotly 未加载'); return; }
    const traces = [];
    // 镜面轮廓 (填充, 同内镜)
    const ol = M.outlineUV.concat([M.outlineUV[0]]);
    traces.push({
      x: ol.map(p => p[0]), y: ol.map(p => p[1]), mode: 'lines', fill: 'toself',
      fillcolor: 'rgba(0,113,227,0.08)', line: { color: C.mirrorEdge, width: 2 },
      name: '反射面', hoverinfo: 'name',
    });
    // 加工边界带 (轮廓度 ±tol mm): 名义轮廓内外各 tol 的对称加工不确定带, 两条琥珀点线紧贴名义轮廓
    // 亚像素级 (0.3mm 相对 ~130mm 镜面), 放大可见; 视野线落入此带 = 距边 < 轮廓度 = 可能超出加工边界
    const tol = M.profileTolMm;
    if (Number.isFinite(tol) && tol > 0) {
      const inner = computeSafetyLine(M.outlineUV, tol);   // 内侧 (加工缺料最坏)
      const outer = computeSafetyLine(M.outlineUV, -tol);  // 外侧 (加工余量最坏)
      const bandLine = { color: '#ff9500', width: 1.5, dash: 'dot' };
      if (inner.length >= 3) {
        const il = inner.concat([inner[0]]);
        traces.push({
          x: il.map(p => p[0]), y: il.map(p => p[1]), mode: 'lines',
          line: bandLine, name: `加工边界 ±${tol}mm`, hoverinfo: 'name',
        });
      }
      if (outer.length >= 3) {
        const ol2 = outer.concat([outer[0]]);
        traces.push({
          x: ol2.map(p => p[0]), y: ol2.map(p => p[1]), mode: 'lines',
          line: bandLine, name: `加工边界 ±${tol}mm`, hoverinfo: 'name', showlegend: false,
        });
      }
    }
    // 4 投影 (2眼×2三角形) — 纯线 (投影三角形轮廓), 左眼蓝/右眼橙, 近实远虚
    // 失败看线伸出镜面轮廓外 (同内镜法规线倒影风格)
    const eyeColor = { left: C.projection, right: '#ff9500' };
    for (const proj of M.projections) {
      traces.push({
        x: proj.points.map(p => p.u), y: proj.points.map(p => p.v), mode: 'lines',
        line: { color: eyeColor[proj.eye], width: 3, dash: proj.tri === 'far' ? 'dash' : 'solid' },
        name: `${proj.eye === 'left' ? '左' : '右'}眼·${proj.tri === 'near' ? '近' : '远'}`,
        hovertemplate: 'u=%{x:.1f} v=%{y:.1f}mm<extra></extra>',
        connectgaps: false,
      });
    }
    // 3mm 安全线 (虚线, 画在投影线之上确保可见; 视野线越过此线 = 安全距离不足)
    const safeLine = computeSafetyLine(M.outlineUV, 3.0);
    if (safeLine.length >= 3) {
      const sl = safeLine.concat([safeLine[0]]);
      traces.push({
        x: sl.map(p => p[0]), y: sl.map(p => p[1]), mode: 'lines',
        line: { color: '#ff3b30', width: 3, dash: 'dash' },
        name: '安全线 (距边缘 3mm)', hoverinfo: 'name',
      });
    }
    const us = M.outlineUV.map(p => p[0]), vs = M.outlineUV.map(p => p[1]);
    const uMin = Math.min(...us), uMax = Math.max(...us), vMin = Math.min(...vs), vMax = Math.max(...vs);
    const pad = Math.max(uMax - uMin, vMax - vMin) * 0.25;
    // 外镜固定高度 520px (容器全宽, 1:1 等比例下动态高度会过大); 图例 y 按固定 plot 高度换算
    const totalH = 520;
    const plotAreaH = totalH - PLOT_MARGIN_T - PLOT_AXIS_B - PLOT_LEGEND_H;
    const badge = { x: 0.99, xref: 'paper', y: 0.98, yref: 'paper', showarrow: false, font: { size: 20, color: 'white' },
      bgcolor: pass ? C.hit : C.miss, bordercolor: pass ? C.hit : C.miss, borderwidth: 2, borderpad: 6, align: 'center' };
    const layout = {
      height: totalH,
      xaxis: { title: 'u (镜面右向, mm)', range: [uMin - pad, uMax + pad], scaleanchor: 'y', scaleratio: 1, gridcolor: '#f0f0f2', zerolinecolor: '#e4e4e8' },
      yaxis: { title: 'v (镜面上向, mm)', range: [vMin - pad, vMax + pad], gridcolor: '#f0f0f2', zerolinecolor: '#e4e4e8' },
      margin: { l: 50, r: 20, t: PLOT_MARGIN_T, b: PLOT_AXIS_B + PLOT_LEGEND_H }, paper_bgcolor: '#fff', plot_bgcolor: '#fff',
      font: { family: '"Segoe UI", "Microsoft YaHei", sans-serif', color: '#9a9aa0', size: 11 },
      annotations: [Object.assign({ text: pass ? '<b>PASS</b>' : '<b>FAIL</b>' }, badge)],
      legend: { x: 0.5, y: bottomLegendY(plotAreaH), xanchor: 'center', yanchor: 'top', orientation: 'h', bgcolor: 'rgba(255,255,255,0.85)', bordercolor: '#e4e4e8', borderwidth: 1 },
    };
    Plotly.react(divId, traces, layout, { responsive: true });
  }

  function renderExtPlot(viz) {
    const Lm = viz.mirrors[0], Rm = viz.mirrors[1];
    renderExtMirrorView('ext-plot-left', Lm, Lm.mirrorPass);
    renderExtMirrorView('ext-plot-right', Rm, Rm.mirrorPass);
    $('ext-panel-left').textContent = Lm.mirrorPass ? 'PASS' : 'FAIL';
    $('ext-panel-right').textContent = Rm.mirrorPass ? 'PASS' : 'FAIL';
  }
})();
