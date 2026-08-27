/**
 * Express 路由 — GB 15084 内后视镜视野校核 (全功能版)
 * API: verify / auto-search / config / vehicles(list) / config?path / save / delete / catia
 */
const express = require('express');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const router = express.Router();

// 所有 POST 路由统一加 body parser (不全局挂载, 避免与平台 server.js 重复)
const jsonParser = express.json();

const { Mirror } = require('./engine/inner/mirror');
const { computeVirtualEye, fiveLineVerification } = require('./engine/inner/five-line');
const { searchPassingAngles, computeAngleSummary } = require('./engine/inner/auto-verify');
const { optimizePitch } = require('./engine/inner/optimizer');
const { Ground } = require('./engine/shared/plane');
const { buildRearWindow, buildProjection, rearWindowProjectionOnMirror } = require('./engine/inner/rear-window');
const { edgeDistanceTo } = require('./engine/shared/polygon');
const { vec3Sub, vec3Add, vec3Scale, vec3Dot, vec3Norm, vec3Normalize } = require('./engine/shared/geometry');
const { reflectPointAcrossPlane } = require('./engine/shared/geometry');
const { verifyExteriorBoth, loadExteriorVehicle, scanExteriorVehicles } = require('./engine/exterior/api-verify');

// ─── 车型目录 ───
const VEHICLES_DIR = path.join(__dirname, 'data', 'vehicles');
const EXTERIOR_DIR = path.join(__dirname, 'data', 'exterior');
const STEP_TMP_DIR = path.join(__dirname, 'data', 'tmp');
const DEFAULT_VEHICLE = path.join(VEHICLES_DIR, '车型C.json');
const DEFAULT_EXTERIOR = path.join(EXTERIOR_DIR, 'exterior-vehicle-draft.json');
// Python 3DE 读取脚本根目录 (内嵌在项目内, 自包含)。
// 环境变量 MIRRO_FOV_PY_DIR 可覆盖 (指向外部 Python 项目, 如完整 Mirro-fov)。
const PY_PROJECT = process.env.MIRRO_FOV_PY_DIR
  || path.join(__dirname, 'python');

// 默认车型判定 (大小写不敏感): Windows FS 不区分大小写, '车型C.json' 与 '车型C.json' 是同一文件,
// 严格 === 比较可被大小写变体绕过 → 覆盖/删除默认车型。toLowerCase 统一后比较。
function isDefaultVehicle(p) {
  return path.resolve(String(p)).toLowerCase() === path.resolve(DEFAULT_VEHICLE).toLowerCase();
}

// 外镜默认车型判定 (大小写不敏感, 同 isDefaultVehicle): exterior-vehicle-draft.json 为默认草稿车型
function isDefaultExterior(p) {
  return path.resolve(String(p)).toLowerCase() === path.resolve(DEFAULT_EXTERIOR).toLowerCase();
}

// 外镜可读路径白名单: 正式车型目录 (data/exterior) 或向导提取临时目录 (data/tmp)。
// 向导把提取结果暂存 tmp 供预览 (轮廓/球面偏差/球心), 保存时才落盘 exterior, 中途放弃不留 orphan 车型。
function isAllowedExteriorPath(p) {
  const r = path.resolve(String(p));
  return r.startsWith(path.resolve(EXTERIOR_DIR)) || r.startsWith(path.resolve(STEP_TMP_DIR));
}

// 后挡风轮廓显示点数 (与 Python dashboard RW_N 对齐)
const RW_N = 7;
const RW_T_N = 4;

// ─── 配置加载 / 扫描 ───
const round3 = x => Math.round(x * 1000) / 1000;

// 错误信息友好化: 业务错误(throw new Error)保留原文; 运行时内部错误转通用提示, 防泄漏堆栈/内部字段
function friendlyError(e) {
  if (!e) return '服务器内部错误';
  // ENOENT: 文件不存在 (车型/轮廓/脚本), 业务可读提示, 仅暴露文件名不暴露完整路径
  if (e.code === 'ENOENT') {
    console.error('[routes] 文件不存在:', e.path || e);
    return '文件不存在: ' + (e.path ? path.basename(e.path) : '未知');
  }
  const isInternal = e instanceof TypeError || e instanceof ReferenceError ||
                     e instanceof SyntaxError || e instanceof RangeError;
  if (isInternal) {
    console.error('[routes] 内部错误:', e);
    return '服务器内部错误, 请检查请求参数或车型数据文件';
  }
  console.error('[routes]', (e && e.message) || e);
  return (e && e.message) || String(e);
}

function padToN(arr, n) {
  // 等价 Python dashboard._pad_to_n: 不足则重复最后一点补到 n
  // 空数组防御: arr.length-1 = -1 → arr[-1] = undefined → [...undefined] 崩溃
  if (!Array.isArray(arr) || arr.length === 0) {
    return Array.from({ length: n }, () => [0, 0, 0]);
  }
  const out = [];
  for (let i = 0; i < n; i++) {
    const idx = Math.min(i, arr.length - 1);
    out.push([...arr[idx]]);
  }
  return out;
}

// 加载后挡风完整轮廓 (STEP 采样, 可选)
function _loadRwOutlineFull(cfgPath, rw) {
  if (!rw.outline_path) return null;
  try {
    const rwPath = path.join(path.dirname(cfgPath), rw.outline_path);
    const rwRaw = JSON.parse(fs.readFileSync(rwPath, 'utf8'));
    if (rwRaw.outline_mm && rwRaw.outline_mm.length >= 3) {
      return rwRaw.outline_mm.map(p => p[0] == null ? [NaN, NaN, NaN] : [p[0] / 1000, p[1] / 1000, p[2] / 1000]);
    }
  } catch (e) { /* 缺失/损坏 */ }
  return null;
}

function loadVehicleJson(cfgPath) {
  // 统一标准: 与 Python 相同的字段结构 (snake_case + 米) + JSON 格式。
  // 统一标准: 与 Python 相同的字段结构 (snake_case + 米) + JSON 格式。
  // 读入后转 mm 供前端显示 (前端仍读 widthMM/pvMM 等扁平字段, 界面零改动)。
  const raw = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  const m = raw.mirror || {};
  const d = raw.driver || {};
  const g = raw.ground || {};
  const gz = (raw.visualization && raw.visualization.ground_plane_z) != null
    ? raw.visualization.ground_plane_z : (g.front_mid ? g.front_mid[2] : 0.0);
  const gf = g.front_mid || [0.5, 0.0, gz];
  const gr = g.rear_mid || [5.9, 0.0, gz];
  const rw = raw.rear_window || {};
  const outline = rw.outline || [];
  const tz = (rw.transparent_zone && rw.transparent_zone.length >= 3) ? rw.transparent_zone : outline;
  const name = (raw.vehicle && raw.vehicle.name) || path.basename(cfgPath, '.json');
  // 可选: 真实反射区轮廓 (STEP 采样)
  // 内镜对齐外镜存储规范: inline outline_local_mm 优先, 旧车 (车型C) 回退 outline_path 文件
  let outlineLocal = null;
  if (m.outline_local_mm && Array.isArray(m.outline_local_mm) && m.outline_local_mm.length >= 3) {
    outlineLocal = m.outline_local_mm;
  } else if (m.outline_path) {
    try {
      const olPath = path.join(path.dirname(cfgPath), m.outline_path);
      const olRaw = JSON.parse(fs.readFileSync(olPath, 'utf8'));
      if (olRaw.outline_local_mm && olRaw.outline_local_mm.length >= 3) {
        outlineLocal = olRaw.outline_local_mm;
      }
    } catch (e) { /* outline 缺失/损坏, 退回圆角矩形 */ }
  }
  // 可选: 后挡风完整轮廓 (STEP 采样, 同目录 rear_window.outline_path)
  let rwOutlineFull = null;
  if (rw.outline_path) {
    try {
      const rwPath = path.join(path.dirname(cfgPath), rw.outline_path);
      const rwRaw = JSON.parse(fs.readFileSync(rwPath, 'utf8'));
      if (rwRaw.outline_mm && rwRaw.outline_mm.length >= 3) {
        rwOutlineFull = rwRaw.outline_mm.map(p => [p[0] / 1000, p[1] / 1000, p[2] / 1000]); // mm→m
      }
    } catch (e) { /* 缺失/损坏, 退回 inline 轮廓 */ }
  }
  // 新流程: 后挡风完整轮廓 inline 存于 rear_window.outline (米制, N 点 > 8), 不依赖 outline_path 文件
  if (!rwOutlineFull && Array.isArray(outline) && outline.length > 8) {
    rwOutlineFull = outline;
  }
  // 米→毫米 + round3 修约 (对齐 Python dashboard.py: round(×1000,3), 消除浮点精度尾巴)
  const x1000 = v => [round3(v[0] * 1000), round3(v[1] * 1000), round3(v[2] * 1000)];
  return {
    name, path: path.resolve(cfgPath),
    widthMM: round3(m.width * 1000), heightMM: round3(m.height * 1000),
    cornerRadiusMM: round3((m.corner_radius || 0) * 1000),
    yawDeg: m.yaw, pitchDeg: m.pitch,
    pvMM: x1000(m.pivot), czMM: x1000(m.center_zero),
    eyeMM: x1000(d.eye_center), ipdMM: round3(d.interpupillary_distance * 1000),
    gfMM: x1000(gf), grMM: x1000(gr),
    rwMM: padToN(outline, RW_N).map(x1000),   // 7 点 (显示, mm)
    rwTMM: padToN(tz, RW_T_N).map(x1000),     // 4 点 (显示, mm)
    regulation: raw.regulation || { far_distance: 60.0, required_width_at_far: 20.0 },
    groundZ: gz,
    outlineLocal,
    rwOutlineFull,
  };
}

function scanVehicles() {
  if (!fs.existsSync(VEHICLES_DIR)) return [];
  const files = fs.readdirSync(VEHICLES_DIR).filter(f => f.endsWith('.json'));
  const results = [];
  for (const f of files) {
    try {
      const cfg = loadVehicleJson(path.join(VEHICLES_DIR, f));
      results.push({ label: cfg.name, value: cfg.path, name: cfg.name });
    } catch (e) { /* skip */ }
  }
  results.sort((a, b) => a.label.localeCompare(b.label, 'zh'));
  return results;
}

// ─── 默认配置 (供引擎 auto-search 用, 返回米制) ───
function loadDefaultConfig() {
  // 统一标准: 字段结构 snake_case + 米制 (与 Python 一致)
  const raw = JSON.parse(fs.readFileSync(DEFAULT_VEHICLE, 'utf8'));
  const m = raw.mirror || {}, d = raw.driver || {}, g = raw.ground || {}, rw = raw.rear_window || {};
  const cz = m.center_zero, pv = m.pivot;
  const armOffset = cz ? [cz[0] - pv[0], cz[1] - pv[1], cz[2] - pv[2]] : (m.arm_offset || null);
  return {
    mirror: {
      width: m.width, height: m.height,
      pivot: pv, centerZero: cz, armOffset,
      yaw: m.yaw, pitch: m.pitch,
      cornerRadius: m.corner_radius || 0,
    },
    driver: { eyeCenter: d.eye_center, ipd: d.interpupillary_distance },
    ground: (g.front_mid && g.rear_mid) ? { front: g.front_mid, rear: g.rear_mid } : null,
    rearWindow: rw.outline ? { outline: rw.outline, transparentZone: (rw.transparent_zone && rw.transparent_zone.length >= 3) ? rw.transparent_zone : rw.outline } : null,
    rearWindowFull: _loadRwOutlineFull(DEFAULT_VEHICLE, rw),
    visualization: { groundZ: (raw.visualization && raw.visualization.ground_plane_z) || 0 },
    regulation: {
      farDistance: raw.regulation.far_distance,
      requiredWidth: raw.regulation.required_width_at_far,
    },
  };
}

/** 去除连续重复点 (后挡风 outline pad 产生的重复尾点), 得实际几何点 */
function dedupePoints(pts) {
  const out = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (!last || Math.abs(last[0] - p[0]) > 1e-9 ||
        Math.abs(last[1] - p[1]) > 1e-9 || Math.abs(last[2] - p[2]) > 1e-9) {
      out.push(p);
    }
  }
  return out;
}

/**
 * 法规地平线在镜面上的倒影曲线 (与 Python regulation_line_image_on_mirror 等价)
 */
function regulationCurve(virtualEye, mirror, farX, groundZ, halfWidth, n) {
  const ys = [];
  const step = (2 * halfWidth) / (n - 1);
  for (let i = 0; i < n; i++) ys.push(-halfWidth + i * step);

  const normal = mirror.normal;
  const pts = new Array(n).fill(null);

  for (let i = 0; i < n; i++) {
    const target = [farX, ys[i], groundZ];
    const d = vec3Sub(target, virtualEye);
    const dLen = vec3Norm(d);
    if (dLen < 1e-10) continue;
    const dU = vec3Normalize(d);
    const den = vec3Dot(dU, normal);
    if (Math.abs(den) < 1e-12) continue;
    const t = vec3Dot(vec3Sub(mirror.center, virtualEye), normal) / den;
    if (t < 1e-6 || t > dLen - 1e-6) continue;
    const hit = vec3Add(virtualEye, vec3Scale(dU, t));
    const offset = vec3Sub(hit, mirror.center);
    pts[i] = {
      lx: vec3Dot(offset, mirror.rightVec) * 1000,
      ly: vec3Dot(offset, mirror.upVec) * 1000,
    };
  }
  return pts;
}

function computeArmOffset(pivot, centerZero) {
  if (centerZero) return [centerZero[0] - pivot[0], centerZero[1] - pivot[1], centerZero[2] - pivot[2]];
  return null;
}

/**
 * 完整单角度校核 (含后挡风视图数据)
 */
function fullVerify(params) {
  const {
    width = 0.224796, height = 0.050794,
    pivot = [2.88307, 0, 1.441017],
    centerZero = null, armOffset,
    eyeCenter = [3.24309, -0.385, 1.372], ipd = 0.065,
    groundZ = 0.193209, ground = null,
    farDist = 60.0, reqWidth = 20.0,
    yawDeg = -23.5, pitchDeg = 5.0, cornerRadius = 0,
    rearWindow = null, // { outline:[[x,y,z]...], transparentZone:[[...]...] }
    coverageYTol = 0.5, groundZTol = 1.0,
    outlineLocal = null, // 真实反射区轮廓 [[lx,ly] mm] (STEP 采样, 可选)
  } = params;

  const arm = armOffset || computeArmOffset(pivot, centerZero) || [0.026145, 0.000007, 0.000863];

  const mirrorBase = { width, height, pivot, armOffset: arm, cornerRadius, outlineLocal };
  const eyePoints = { center: eyeCenter, ipd };
  const gd = ground ? Ground.fromTwoPoints(ground.front, ground.rear) : Ground.horizontal(groundZ);

  const summary = computeAngleSummary({
    mirrorBase, eyePoints, farDist, reqWidth, ground: gd,
    rearWindow: rearWindow ? buildRearWindow(rearWindow.outline, rearWindow.transparentZone) : null,
    yawDeg, pitchDeg, coverageYTol, groundZTol,
  });
  const m = summary.mirror;
  const result = summary.five;

  const farPlaneX = summary.farPlaneX;
  const halfW = reqWidth / 2;
  const centerVirtualEye = reflectPointAcrossPlane(eyeCenter, m.center, m.normal);
  // 法规地平线 Z 必须与五线判定的 ground 一致 (两点定线时用坡度 z_at_x, 不用裸 groundZ) — 修 A4
  const regGroundZ = gd.zAtX(farPlaneX);
  const regulationImg = regulationCurve(centerVirtualEye, m, farPlaneX, regGroundZ, halfW, 80);

  // ─── 后挡风视图数据 (对齐 build_rear_window_view_fig) ───
  let rwView = null;
  let rwProjection = null;
  if (rearWindow) {
    const rw = buildRearWindow(rearWindow.outline, rearWindow.transparentZone);
    const proj = buildProjection(rw);
    const outline2D = rw.outline.map(proj.to2d);
    const tz2D = rw.tz.map(proj.to2d);
    // 中心眼 3 线 (前 3 条), 距边距离: 每条线固定连到一个边 (不随角度变)
    // BL→左边 (左半的竖向边), BR→右边 (右半的竖向边), +X→上边 (上半的横向边)
    const lineEdgeMap = { 'BL': 'left', 'BR': 'right', '+X': 'top' };
    const centerLines = result.lineDetails.slice(0, 3).map(ld => {
      const p = { label: `C→${ld.endpointLabel}`, through: ld.throughTransparent };
      if (ld.rearWindowHit) {
        const [u, v] = proj.to2d(ld.rearWindowHit);
        p.hit2D = [round1(u), round1(v)];
        const edgeSide = lineEdgeMap[ld.endpointLabel] || 'left';
        let bestDist = Infinity, bestEx = 0, bestEy = 0;
        for (let i = 0; i < outline2D.length; i++) {
          const j = (i + 1) % outline2D.length;
          const [ax, ay] = outline2D[i], [bx, by] = outline2D[j];
          const midU = (ax + bx) / 2, midV = (ay + by) / 2;
          const du = Math.abs(bx - ax), dv = Math.abs(by - ay); // 边的 u/v 方向跨度
          // BL/BR 找竖向边 (dv>du, 即 Z 方向变化大于 Y 方向)
          // +X 找横向边 (du>dv, 即 Y 方向变化大于 Z 方向)
          if (edgeSide === 'left' && (midU > 0 || du > dv)) continue;
          if (edgeSide === 'right' && (midU < 0 || du > dv)) continue;
          if (edgeSide === 'top' && (midV < 0 || dv > du)) continue;
          const d = edgeDistanceTo(u, v, ax, ay, bx, by);
          if (d.dist < bestDist) { bestDist = d.dist; bestEx = d.ex; bestEy = d.ey; }
        }
        // 退回: 对应区域没找到则搜全部
        if (bestDist === Infinity) {
          for (let i = 0; i < outline2D.length; i++) {
            const j = (i + 1) % outline2D.length;
            const d = edgeDistanceTo(u, v, outline2D[i][0], outline2D[i][1], outline2D[j][0], outline2D[j][1]);
            if (d.dist < bestDist) { bestDist = d.dist; bestEx = d.ex; bestEy = d.ey; }
          }
        }
        p.dist = round1(bestDist);
        p.near = [round1(bestEx), round1(bestEy)];
      }
      return p;
    });
    // 后挡风开口在镜面上的投影覆盖 (报告项, 不参与 PASS 判定)
    const rwProj = rearWindowProjectionOnMirror(eyeCenter, m, rw);
    rwProjection = {
      projectionPoints2D: rwProj.projectionPoints.map(p => {
        const [u, v] = proj.to2d(p); return [round1(u), round1(v)];
      }),
      coversMirror: rwProj.coversMirror,
    };
    rwView = {
      planePoint: rw.planePoint.map(round4),
      planeNormal: rw.planeNormal.map(round4),
      outline2D: outline2D.map(([u, v]) => [round1(u), round1(v)]),
      tz2D: tz2D.map(([u, v]) => [round1(u), round1(v)]),
      centerLines,
      hasTz: rw.transparentZone !== null,
      pass: result.rearWindowPass,
      projection: rwProjection,
    };
  }

  // 数值修约 (对齐 Python: lx/ly 保留 1 位=0.1mm; 坐标向量保留 4 位=0.1μm; 消除浮点尾巴)
  const r1 = round1, r3 = round3, r4 = round4;
  const r1v = v => v ? v.map(r1) : v;       // mm 坐标向量 → 0.1mm
  const r4v = v => v ? v.map(r4) : v;       // m 坐标向量 → 0.1μm

  return {
    mirrorPass: result.mirrorPass,
    nHit: result.nHit,
    nTot: result.nTot,
    lineDetails: result.lineDetails.map(ld => ({
      eyeLabel: ld.eyeLabel, endpointLabel: ld.endpointLabel,
      rayOrigin: r4v(ld.rayOrigin), rayTarget: r4v(ld.rayTarget),
      mirrorHit: r4v(ld.mirrorHit), onMirror: ld.onMirror,
      lx: r1(ld.lx), ly: r1(ld.ly),
      rearWindowHit: r4v(ld.rearWindowHit), throughTransparent: ld.throughTransparent,
    })),
    rearWindowPass: result.rearWindowPass,
    failureDetails: result.failureDetails,
    // 参考判据 (界面不展示, 供报告/调试) — roundNums 递归修约消除浮点尾巴
    binocular: roundNums(summary.binocular),
    binocularPass: summary.binocularPass,
    binocularWidth: round4(summary.binocularWidth),
    binocularYRange: summary.binocularYRange ? summary.binocularYRange.map(round4) : summary.binocularYRange,
    singleEye: roundNums(summary.singleEye),
    viaVirtual: roundNums(summary.viaVirtual),
    mirrorProjectionCorners: result.mirrorProjectionCorners ? result.mirrorProjectionCorners.map(r4v) : result.mirrorProjectionCorners,
    crossInTriangle: result.crossInTriangle,
    mirror: {
      center: r4v(m.center), normal: r4v(m.normal),
      rightVec: r4v(m.rightVec), upVec: r4v(m.upVec),
      widthMM: r3(width * 1000), heightMM: r3(height * 1000),
      cornerRadiusMM: r3(cornerRadius * 1000),
      outline: m.reflectiveOutlineMM(),  // 真实轮廓 (有 outlineLocal 用之, 否则圆角矩形)
    },
    centerVirtualEye: r4v(centerVirtualEye),
    regulationCurve: regulationImg.map(p => p ? { lx: r1(p.lx), ly: r1(p.ly) } : p),
    farPlaneX: r4(farPlaneX), groundZ: r4(groundZ), halfW: r4(halfW),
    rearWindow: rwView,
  };
}

const round1 = x => Math.round(x * 10) / 10;
const round4 = x => Math.round(x * 10000) / 10000;
// 递归修约对象内所有 number (消除浮点尾巴, 保留 4 位=0.1μm; 不动 boolean/string/null)
const roundNums = obj => {
  if (typeof obj === 'number') return round4(obj);
  if (Array.isArray(obj)) return obj.map(roundNums);
  if (obj && typeof obj === 'object') {
    const o = {};
    for (const k of Object.keys(obj)) o[k] = roundNums(obj[k]);
    return o;
  }
  return obj;
};

// ---- 车型列表 ----
router.get('/api/vehicles', (req, res) => {
  try {
    res.json({ ok: true, vehicles: scanVehicles() });
  } catch (e) {
    res.status(500).json({ ok: false, error: friendlyError(e) });
  }
});

// ---- 获取指定车型配置 (扁平, 供前端填充表单) ----
router.get('/api/config', (req, res) => {
  try {
    const p = req.query.path || DEFAULT_VEHICLE;
    // path 越界校验 (只允许读 vehicles 目录内, 防止任意文件读)
    const resolved = path.resolve(p);
    if (!resolved.startsWith(path.resolve(VEHICLES_DIR))) {
      return res.status(400).json({ ok: false, error: '路径越界, 只能读取 vehicles 目录' });
    }
    const cfg = loadVehicleJson(resolved);
    res.json({
      ok: true,
      name: cfg.name, path: cfg.path,
      widthMM: cfg.widthMM, heightMM: cfg.heightMM, cornerRadiusMM: cfg.cornerRadiusMM,
      yawDeg: cfg.yawDeg, pitchDeg: cfg.pitchDeg,
      pvMM: cfg.pvMM, czMM: cfg.czMM,
      eyeMM: cfg.eyeMM, ipdMM: cfg.ipdMM,
      gfMM: cfg.gfMM, grMM: cfg.grMM,
      rwMM: cfg.rwMM, rwTMM: cfg.rwTMM,
      groundZ: cfg.groundZ,
      outlineLocal: cfg.outlineLocal,
      rwOutlineFull: cfg.rwOutlineFull,
      farDist: cfg.regulation.far_distance, reqWidth: cfg.regulation.required_width_at_far,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: friendlyError(e) });
  }
});

// ---- 单角度校核 ----
router.post('/api/verify', jsonParser, (req, res) => {
  try {
    const body = req.body || {};
    // 输入校验: 关键角度/尺寸必须是有限数, 否则 NaN 会静默传播 → 假 FAIL
    const mustFinite = { yawDeg: body.yawDeg, pitchDeg: body.pitchDeg, width: body.width, height: body.height };
    for (const [k, v] of Object.entries(mustFinite)) {
      if (v != null && !Number.isFinite(v)) throw new Error(`参数 ${k} 不是有效数值: ${v}`);
    }
    // ground 兼容: 前端发 { front:[..], rear:[..] } 或单 groundZ
    const g = body.ground || {};
    const gz = (body.groundZ != null) ? body.groundZ
      : (g.front ? g.front[2] : 0.193209);
    // 后挡风空轮廓防护: 无 REAR_WINDOW 命名的车型 outline 退化 (pad→去重→1 点),
    // buildRearWindow 要求 N≥3 会抛错 → 视为无后挡风 (null), 与 loadDefaultConfig 语义一致。
    const rwIn = body.rearWindow || null;
    const rearWindow = (rwIn && Array.isArray(rwIn.outline) && rwIn.outline.length >= 3) ? rwIn : null;
    const params = {
      width: body.width, height: body.height,
      pivot: body.pivot, centerZero: body.centerZero, armOffset: body.armOffset,
      eyeCenter: body.eyeCenter, ipd: body.ipd,
      groundZ: gz,
      farDist: body.farDist, reqWidth: body.reqWidth,
      yawDeg: body.yawDeg, pitchDeg: body.pitchDeg,
      cornerRadius: body.cornerRadius,
      rearWindow,
      outlineLocal: body.outlineLocal || null,
    };
    const result = fullVerify(params);
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(400).json({ ok: false, error: friendlyError(e) });
  }
});

// ---- pitch 优化 (二分找最优俯仰, 辅助工具, 不参与五线判定) ----
router.post('/api/optimize', jsonParser, (req, res) => {
  try {
    const body = req.body || {};
    const pivot = body.pivot ?? [2.88307, 0.0, 1.441017];
    const cz = body.centerZero ?? [2.909215, 0.000007, 1.441880];
    const armOffset = cz ? [cz[0]-pivot[0], cz[1]-pivot[1], cz[2]-pivot[2]] : (body.armOffset ?? [0.026145, 0.000007, 0.000863]);
    const mirror = {
      width: body.width ?? 0.224796, height: body.height ?? 0.050794,
      pivot, armOffset,
      yaw: (body.yawDeg ?? -23.5) * Math.PI / 180,
    };
    const eyePoints = { center: body.eyeCenter ?? [3.24309, -0.385, 1.372], ipd: body.ipd ?? 0.065 };
    const farDistance = body.farDist ?? 60.0;
    const requiredWidth = body.reqWidth ?? 20.0;
    const g = body.ground || {};
    const ground = (g.front && g.rear)
      ? Ground.fromTwoPoints(g.front, g.rear)
      : Ground.horizontal(body.groundZ ?? 0.193209);
    const result = optimizePitch({
      mirror, eyePoints, farDistance, requiredWidth, ground,
      pitchRange: body.pitchRange ?? [-5.0, 15.0],
      zMargin: body.zMargin ?? 0.0,
      tol: body.tol ?? 0.1,
      maxIter: body.maxIter ?? 50,
    });
    res.json({
      ok: true,
      optimalPitchDeg: result.optimalPitchDeg,
      converged: result.converged,
      zMinAtFar: result.zMinAtFar,
      visibleWidth: result.visibleWidth,
      searchLog: result.searchLog,
    });
  } catch (e) {
    res.status(400).json({ ok: false, error: friendlyError(e) });
  }
});

// ---- 自动搜角 ----
router.post('/api/auto-search', jsonParser, (req, res) => {
  try {
    const cfg = loadDefaultConfig();
    const body = req.body || {};
    const mirrorBase = {
      width: body.width ?? cfg.mirror.width,
      height: body.height ?? cfg.mirror.height,
      pivot: body.pivot ?? cfg.mirror.pivot,
      cornerRadius: body.cornerRadius ?? cfg.mirror.cornerRadius,
    };
    const pv = mirrorBase.pivot;
    const cz = body.centerZero ?? cfg.mirror.centerZero;
    mirrorBase.armOffset = (cz)
      ? [cz[0] - pv[0], cz[1] - pv[1], cz[2] - pv[2]]
      : (body.armOffset ?? cfg.mirror.armOffset);
    const eyeCenter = body.eyeCenter ?? cfg.driver.eyeCenter;
    const ipd = body.ipd ?? cfg.driver.ipd;
    const gz = body.groundZ ?? cfg.visualization.groundZ;
    // 法规参数: 优先用前端传入 (当前车型), 否则回退默认车型 (车型C)
    const farDist = body.farDist ?? cfg.regulation.farDistance;
    const reqWidth = body.reqWidth ?? cfg.regulation.requiredWidth;
    const eyePoints = { center: eyeCenter, ipd };
    // ground: 前端传两点定线 > 车型配置两点定线 > 水平地面
    const gd = (body.ground || cfg.ground)
      ? Ground.fromTwoPoints((body.ground || cfg.ground).front, (body.ground || cfg.ground).rear)
      : Ground.horizontal(gz);
    // rearWindow: 前端传后挡风, 搜角也参与穿透判定 (A1)
    const rw = body.rearWindow ? buildRearWindow(body.rearWindow.outline, body.rearWindow.transparentZone) : null;
    const result = searchPassingAngles({
      mirrorBase, eyePoints, farDist, reqWidth, ground: gd, rearWindow: rw,
      yawRange: body.yawRange ?? [-45, 15], pitchRange: body.pitchRange ?? [-10, 10],
      step: body.step ?? 2, seedYaw: body.seedYaw ?? -30, seedHalf: body.seedHalf ?? 12,
      coverageYTol: body.coverageYTol ?? 0.5, groundZTol: body.groundZTol ?? 1.0,
    });
    // 简化响应: 参考判据字段不塞给前端 (界面不展示)
    const { summary, grid, gridYaws, gridPitches, ...rest } = result;
    res.json({ ok: true, ...rest, best: summary ? summary.nHit : null });
  } catch (e) {
    res.status(400).json({ ok: false, error: friendlyError(e) });
  }
});

// ---- 保存车型 (CRUD) ----
router.post('/api/vehicles/save', jsonParser, (req, res) => {
  try {
    const body = req.body || {};
    const name = (body.name || '新车型').trim();
    if (!name) return res.status(400).json({ ok: false, error: '车型名不能为空' });
    const safe = name.replace(/[\\/:*?"<>|]/g, '_');
    const cfgPath = body.path || path.join(VEHICLES_DIR, `${safe}.json`);
    // path 越界校验 (对齐 /api/vehicles/delete: 只允许写 vehicles 目录内)
    const resolved = path.resolve(cfgPath);
    if (!resolved.startsWith(path.resolve(VEHICLES_DIR))) {
      return res.status(400).json({ ok: false, error: '路径越界, 只能保存到 vehicles 目录' });
    }
    // 默认车型保护: 不允许直接覆盖 车型C.json (默认车型), 需另存为新名 (大小写不敏感)
    if (isDefaultVehicle(resolved) && !body.forceOverwriteDefault) {
      return res.status(400).json({ ok: false, error: '不能直接覆盖默认车型 (车型C), 请改车型名另存为新文件' });
    }

    // 合并模式: 读现有车型 JSON (path 存在则读, 不存在则 {}), 用 body flat 字段更新
    // mirror/driver/ground/rear_window, 保留现有 mirror.outline_local_mm / outline_path /
    // regulation / visualization / tolerance 不丢 (手动编辑不能抹掉 inline 轮廓 / 旧车 outline_path)。
    let existing = {};
    if (fs.existsSync(cfgPath)) {
      try { existing = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); }
      catch (e) { existing = {}; }
    }
    existing.vehicle = existing.vehicle || {};
    existing.vehicle.name = name;
    existing.mirror = existing.mirror || {};
    existing.driver = existing.driver || {};
    existing.ground = existing.ground || {};
    existing.rear_window = existing.rear_window || {};

    // mirror flat 更新 (mm→m), 保留 outline_local_mm / outline_path 不动
    existing.mirror.width = body.widthMM / 1000;
    existing.mirror.height = body.heightMM / 1000;
    existing.mirror.pivot = body.pvMM.map(v => v / 1000);
    existing.mirror.center_zero = body.czMM.map(v => v / 1000);
    existing.mirror.yaw = body.yawDeg;
    existing.mirror.pitch = body.pitchDeg;
    // corner_radius 为人工取点遗留参数, 不再写入 (镜面形状由 outline 定义)

    existing.driver.eye_center = body.eyeMM.map(v => v / 1000);
    existing.driver.interpupillary_distance = body.ipdMM / 1000;

    existing.ground.front_mid = body.gfMM.map(v => v / 1000);
    existing.ground.rear_mid = body.grMM.map(v => v / 1000);

    // 后挡风: 保留现有 inline 轮廓 / outline_path 不动 (STEP 提取的完整轮廓, 手动编辑不覆盖)。
    // 新流程已删前端 rwMM/rwTMM, 无这些字段时不清空 outline (仅旧手动数据向后兼容才更新)。
    if (Array.isArray(body.rwMM) && body.rwMM.length) {
      existing.rear_window.outline = dedupePoints(body.rwMM).map(p => p.map(v => v / 1000));
    }
    if (Array.isArray(body.rwTMM) && body.rwTMM.length) {
      existing.rear_window.transparent_zone = body.rwTMM.map(p => p.map(v => v / 1000));
    }

    // 全新文件补默认 (已有车型保留原 regulation / visualization / tolerance)
    if (!existing.regulation) existing.regulation = { standard: 'GB 15084', mirror_class: 'I', far_distance: 60.0, required_width_at_far: 20.0 };
    if (!existing.visualization) existing.visualization = { ground_plane_z: body.groundZ ?? (body.gfMM ? body.gfMM[2] / 1000 : 0) };
    if (!existing.tolerance) existing.tolerance = { coverage_y: 0.5, ground_visible_z: 1.0, pitch_convergence: 0.1 };

    fs.writeFileSync(cfgPath, JSON.stringify(existing, null, 2), 'utf8');
    res.json({ ok: true, path: cfgPath, vehicles: scanVehicles() });
  } catch (e) {
    res.status(400).json({ ok: false, error: friendlyError(e) });
  }
});

// ---- 删除车型 (CRUD) ----
router.post('/api/vehicles/delete', jsonParser, (req, res) => {
  try {
    const p = req.body.path;
    if (!p) return res.status(400).json({ ok: false, error: '缺少 path' });
    const resolved = path.resolve(p);
    if (isDefaultVehicle(resolved)) {
      return res.status(400).json({ ok: false, error: '不能删除默认车型' });
    }
    if (!resolved.startsWith(path.resolve(VEHICLES_DIR))) {
      return res.status(400).json({ ok: false, error: '路径越界' });
    }
    fs.unlinkSync(resolved);
    res.json({ ok: true, vehicles: scanVehicles() });
  } catch (e) {
    res.status(400).json({ ok: false, error: friendlyError(e) });
  }
});

// ---- 从 3DE 读取 (Node 代理调用 Python catia_extract, 输出转 JS 车型 JSON) ----
router.post('/api/catia', jsonParser, (req, res) => {
  // catia_extract 需要交互式 stdin (input() 读手动输入) + CATIA COM 弹框选点。
  // execFile 无 stdin 会让 input() 立即抛 EOFError, 故用 spawn 并把本进程 stdio 透传:
  // 用户在运行 node 服务的终端里完成选点/输入, 3DE 弹框照常弹出。
  const body = req.body || {};
  // 输出路径: 用户可控时必须落在 vehicles 目录内 (防 shell 注入: shell:true 下
  // body.output 含 '&'/'|' 会被 cmd.exe 解释为命令分隔 → 任意命令执行)
  let yamlPath;
  if (body.output) {
    const r = path.resolve(body.output);
    if (!r.startsWith(path.resolve(VEHICLES_DIR))) {
      return res.status(400).json({ ok: false, error: '路径越界, 只能写到 vehicles 目录' });
    }
    yamlPath = r;
  } else {
    yamlPath = path.join(VEHICLES_DIR, 'catia_read.yaml');
  }
  // 关键: spawn 前删除陈旧 yaml, 防止连接失败(exit 0 不生成新文件)时读到旧数据 → 假成功
  try { fs.unlinkSync(yamlPath); } catch (e) { /* 文件不存在, 忽略 */ }
  const child = spawn('python', ['-m', 'mirror_fov.catia_extract', '--output', yamlPath],
    { cwd: PY_PROJECT, stdio: 'inherit', shell: process.platform === 'win32' });
  let done = false;
  const finish = (status, payload) => { if (!done) { done = true; res.status(status).json(payload); } };
  // 超时保护: CATIA 选点交互可能慢, 但 10 分钟还没完判定为卡死 (对齐 Python dashboard timeout=600)
  const timeout = setTimeout(() => {
    try { child.kill(); } catch (e) {}
    finish(500, { ok: false, error: '3DE 读取超时 (10 分钟未完成)。请确认 CATIA 选点操作是否仍在进行。' });
  }, 600000);
  child.on('exit', (code) => {
    clearTimeout(timeout);

    if (code !== 0) {
      finish(500, { ok: false, error: `3DE 读取中断 (exit code ${code})。\n请确认 3DE 已启动并在终端完成选点。` });
      return;
    }
    // catia_extract 连接失败时 exit code 也是 0 (只打印错误), 但不会生成 yaml → 判为连接失败
    if (!fs.existsSync(yamlPath)) {
      finish(500, { ok: false, error: '3DE 读取未产生数据文件。\n请确认本机已安装并启动 3DEXPERIENCE/CATIA（当前电脑可能未安装 3DE）。\n也可在服务终端查看 catia_extract 的详细输出。' });
      return;
    }
    try {
      // catia_extract 输出 YAML (snake_case + 米制), 读入后补全为统一 json 标准 (snake_case + 米)
      const yaml = require('js-yaml');
      const pyCfg = yaml.load(fs.readFileSync(yamlPath, 'utf8'));
      const m = pyCfg.mirror || {}, d = pyCfg.driver || {}, g = pyCfg.ground || {}, rw = pyCfg.rear_window || {};
      const name = (pyCfg.vehicle && pyCfg.vehicle.name) || '3DE读取';
      const safe = name.replace(/[\\/:*?"<>|]/g, '_');
      const jsPath = path.join(VEHICLES_DIR, `${safe}.json`);
      const jsCfg = {
        vehicle: { name },
        mirror: m,           // 已是 snake_case + 米 (catia_extract 输出)
        driver: d,
        ground: g,
        rear_window: rw,
        regulation: pyCfg.regulation || { standard: 'GB 15084', mirror_class: 'I', far_distance: 60.0, required_width_at_far: 20.0 },
        visualization: { ground_plane_z: (g.front_mid || g.front || [0, 0, 0])[2] || 0 },
        tolerance: { coverage_y: 0.5, ground_visible_z: 1.0, pitch_convergence: 0.1 },
      };
      fs.writeFileSync(jsPath, JSON.stringify(jsCfg, null, 2), 'utf8');
      finish(200, { ok: true, output: jsPath, vehicles: scanVehicles() });
    } catch (e) {
      finish(500, { ok: false, error: `3DE 读取成功但转换失败: ${friendlyError(e)}` });
    }
  });
  child.on('error', (err) => finish(500, { ok: false, error: `3DE 读取启动失败: ${friendlyError(err)}` }));
});

// ---- 静态文件 ----
router.use(express.static(path.join(__dirname, 'public')));

// ---- 外后视镜: 车型列表 (扫 data/exterior/*.json) ----
router.get('/api/exterior/vehicles', (req, res) => {
  try {
    res.json({ ok: true, vehicles: scanExteriorVehicles() });
  } catch (e) {
    res.status(500).json({ ok: false, error: friendlyError(e) });
  }
});

// ---- 外后视镜: 读取车型参数 (扁平, 供前端填表) ----
router.get('/api/exterior/config', (req, res) => {
  try {
    const q = req.query.path || '';
    // 路径越界校验 (只允许读 exterior 目录 / tmp 提取目录内, 防任意 JSON 文件读)
    const p = q ? path.resolve(String(q)) : '';
    if (p && !isAllowedExteriorPath(p)) {
      return res.status(400).json({ ok: false, error: '路径越界, 只能读取 exterior/tmp 目录' });
    }
    const raw = loadExteriorVehicle(p || undefined);
    const sum = (m) => ({
      sr_fit: m.sr_fit, sr_nominal: m.sr_nominal, sr_tolerance: m.sr_tolerance, radius: m.radius,
      sr_check: m.sr_check || null,
      profile_tol_mm: m.profile_tol_mm ?? 0.3,
      sphere_center: m.supplier_sphere_center, outline_n: m.outline_raw.length,
      turret_axis_p1: m.turret_axis_p1, rotation_axis_dir: m.rotation_axis_dir,
      fold_axis_dir: m.fold_axis_dir || null,
    });
    res.json({
      ok: true, path: p, vehicle: raw.vehicle,
      driver: raw.driver, ground: raw.ground, door_panel: raw.door_panel, regulation: raw.regulation,
      mirrors: { left: sum(raw.exterior_mirror_left), right: sum(raw.exterior_mirror_right) },
      raw, // 完整原始 JSON (含 outline_raw 421 点 + 轴线, 供保存时原样回传, 避免前端重建轮廓)
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: friendlyError(e) });
  }
});

// ---- 外后视镜: 双镜合并校核 (L+R 同时, 返回结果+合并 viz) ----
router.post('/api/exterior/verify', jsonParser, (req, res) => {
  try {
    const body = req.body || {};
    const psi = Number.isFinite(body.psi) ? body.psi : 0;
    const theta = Number.isFinite(body.theta) ? body.theta : 0;
    const search = body.search === true; // 默认 false: 只做当前角度校核; 显式 true 才做二维搜索
    // 路径越界校验 (同 /api/exterior/config: exterior 目录 / tmp 提取目录)
    if (body.path && !isAllowedExteriorPath(body.path)) {
      return res.status(400).json({ ok: false, error: '路径越界, 只能读取 exterior/tmp 目录' });
    }
    const result = verifyExteriorBoth(body.path || '', { psi, theta, search });
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(400).json({ ok: false, error: friendlyError(e) });
  }
});

// ---- 外后视镜: 保存车型 (CRUD) ----
// 接收完整外镜 JSON (含 outline_raw 轮廓 + 补录的轴线), 落盘 data/exterior/<name>.json
router.post('/api/exterior/save', jsonParser, (req, res) => {
  try {
    const body = req.body || {};
    const config = body.config && typeof body.config === 'object' ? body.config : body;
    const name = (body.name || (config.vehicle && config.vehicle.name) || '新外镜车型').trim();
    if (!name) return res.status(400).json({ ok: false, error: '车型名不能为空' });
    const safe = name.replace(/[\\/:*?"<>|]/g, '_');
    const cfgPath = body.path || path.join(EXTERIOR_DIR, `${safe}.json`);
    // path 越界校验 (对齐 /api/exterior/extract: 只允许写 exterior 目录内)
    const resolved = path.resolve(cfgPath);
    if (!resolved.startsWith(path.resolve(EXTERIOR_DIR))) {
      return res.status(400).json({ ok: false, error: '路径越界, 只能保存到 exterior 目录' });
    }
    // 默认车型保护: 不允许直接覆盖 exterior-vehicle-draft.json (大小写不敏感, 对齐 /api/vehicles/save)
    if (isDefaultExterior(resolved) && !body.forceOverwriteDefault) {
      return res.status(400).json({ ok: false, error: '不能直接覆盖默认车型 (exterior-vehicle-draft), 请另存为新名' });
    }
    // 补全 vehicle.name (另存为时以用户输入名覆盖), 确保与文件名一致
    if (!config.vehicle) config.vehicle = {};
    config.vehicle.name = name;
    fs.writeFileSync(cfgPath, JSON.stringify(config, null, 2), 'utf8');
    res.json({ ok: true, path: cfgPath, vehicles: scanExteriorVehicles() });
  } catch (e) {
    res.status(400).json({ ok: false, error: friendlyError(e) });
  }
});

// ---- 外后视镜: 删除车型 (CRUD) ----
router.post('/api/exterior/delete', jsonParser, (req, res) => {
  try {
    const p = req.body.path;
    if (!p) return res.status(400).json({ ok: false, error: '缺少 path' });
    const resolved = path.resolve(p);
    if (isDefaultExterior(resolved)) {
      return res.status(400).json({ ok: false, error: '不能删除默认车型 (exterior-vehicle-draft)' });
    }
    if (!resolved.startsWith(path.resolve(EXTERIOR_DIR))) {
      return res.status(400).json({ ok: false, error: '路径越界, 只能删除 exterior 目录内车型' });
    }
    fs.unlinkSync(resolved);
    res.json({ ok: true, vehicles: scanExteriorVehicles() });
  } catch (e) {
    res.status(400).json({ ok: false, error: friendlyError(e) });
  }
});

// 3DE 可用性检测 (平台服务器无 Python/CATIA)
router.get('/api/catia/available', (req, res) => {
  const ok = fs.existsSync(PY_PROJECT);
  res.json({ available: ok });
});

// ---- 外后视镜: 3DE 读取 (spawn Python catia_extract --mode exterior) ----
router.post('/api/catia/exterior', jsonParser, (req, res) => {
  const body = req.body || {};
  // 输出路径: 用户可控时必须落在 exterior 目录内 (防 shell 注入, 同 /api/catia)
  let outPath;
  if (body.output) {
    const r = path.resolve(body.output);
    if (!r.startsWith(path.resolve(EXTERIOR_DIR))) {
      return res.status(400).json({ ok: false, error: '路径越界, 只能写到 exterior 目录' });
    }
    outPath = r;
  } else {
    outPath = path.join(EXTERIOR_DIR, 'exterior-3de-read.json');
  }
  try { fs.unlinkSync(outPath); } catch (e) { /* 不存在忽略 */ }
  const child = spawn('python', ['-m', 'mirror_fov.catia_extract', '--mode', 'exterior', '--output', outPath],
    { cwd: PY_PROJECT, stdio: 'inherit', shell: process.platform === 'win32' });
  let done = false;
  const finish = (status, payload) => { if (!done) { done = true; res.status(status).json(payload); } };
  const timeout = setTimeout(() => {
    try { child.kill(); } catch (e) {}
    finish(500, { ok: false, error: '3DE 读取超时 (10 分钟未完成)。' });
  }, 600000);
  child.on('exit', (code) => {
    clearTimeout(timeout);
    if (code !== 0) {
      finish(500, { ok: false, error: `3DE 读取中断 (exit ${code})。\n请在终端完成选点。` });
      return;
    }
    if (!fs.existsSync(outPath)) {
      finish(500, { ok: false, error: '3DE 读取未产生数据文件。\n请确认 3DE 已启动并在终端完成操作。' });
      return;
    }
    try {
      const raw = JSON.parse(fs.readFileSync(outPath, 'utf8'));
      finish(200, { ok: true, output: outPath, vehicles: scanExteriorVehicles() });
    } catch (e) {
      finish(500, { ok: false, error: `3DE 读取成功但解析失败: ${friendlyError(e)}` });
    }
  });
  child.on('error', (err) => finish(500, { ok: false, error: `3DE 启动失败: ${friendlyError(err)}` }));
});

// ---- 新建向导: STEP 上传 + 解析轮廓 (base64 → 临时文件 → spawn Python) ----
// 500MB 上限: 前端 file.size 预检 + 服务端 content-length/流式计数双保险
const MAX_STEP_BYTES = 500 * 1024 * 1024;
// 提取进度 (按文件名轮询): Python 打印 STEP_PROGRESS|xxx → 收集 → 前端轮询显示
const stepProgress = new Map();

// 通用: 流式写盘 (req 管道到 fs.createWriteStream, 不经堆内存, 防大 STEP 上传 OOM)。
// - 先查 content-length, >500MB → 413 JSON
// - 流中计 received, 超 500MB → 中断 + 删临时文件 + 413 JSON
// - 写盘 finish 后回调 onDone(stepPath) (此时才 spawn, 确保文件已完整落盘)
// - 写盘/请求 error → 删文件 + onError(status, msg)
function streamStepToTmp(req, filename, onDone, onError) {
  const contentLength = Number(req.headers['content-length']);
  if (Number.isFinite(contentLength) && contentLength > MAX_STEP_BYTES) {
    return onError(413, '文件过大 (' + Math.round(contentLength / 1048576) + 'MB), 超过 500MB 限制');
  }
  let stepPath;
  try {
    fs.mkdirSync(STEP_TMP_DIR, { recursive: true });
    stepPath = path.join(STEP_TMP_DIR, filename);
  } catch (e) {
    return onError(500, '无法创建临时目录: ' + friendlyError(e));
  }
  // 路径越界闸门 (filename 已 sanitize, 双保险)
  if (!path.resolve(stepPath).startsWith(path.resolve(STEP_TMP_DIR))) {
    return onError(400, '路径越界, 只能写到 tmp 目录');
  }
  const ws = fs.createWriteStream(stepPath);
  let received = 0;
  let settled = false;
  const fail = (status, msg) => {
    if (settled) return;
    settled = true;
    try { ws.destroy(); } catch (e) { /* ignore */ }
    try { fs.unlinkSync(stepPath); } catch (e) { /* ignore */ }
    onError(status, msg);
  };
  req.on('data', (chunk) => {
    received += chunk.length;
    if (received > MAX_STEP_BYTES) {
      req.pause();
      fail(413, '文件过大, 超过 500MB 限制');
    }
  });
  ws.on('finish', () => {
    if (settled) return;
    settled = true;
    if (received === 0) {
      try { fs.unlinkSync(stepPath); } catch (e) { /* ignore */ }
      return onError(400, '缺少文件内容');
    }
    const heapMB = (process.memoryUsage().heapUsed / 1048576).toFixed(1);
    const sizeMB = (received / 1048576).toFixed(1);
    console.log(`[routes][stream] ${filename}: ${sizeMB}MB 落盘完成, heapUsed=${heapMB}MB (流式, 不经堆内存)`);
    onDone(stepPath);
  });
  ws.on('error', (e) => fail(500, '写入临时文件失败: ' + friendlyError(e)));
  req.on('error', (e) => fail(500, '上传中断: ' + friendlyError(e)));
  req.pipe(ws);
}

// 通用: spawn Python 提取脚本 (进度收集 + 动态超时 + 退出处理)。
// 动态超时 = min(1800s, 120s + 1s/MB): 141MB STEP → ~261s, 不误杀大文件
function spawnStepExtract(opts) {
  const { stepPaths, outPath, script, extraArgs, progressMap, progressKey, failMsg, success, failure } = opts;
  const paths = Array.isArray(stepPaths) ? stepPaths : [stepPaths];
  let sizeMB = 0;
  for (const sp of paths) {
    try { sizeMB += fs.statSync(sp).size / 1048576; } catch (e) { /* ignore */ }
  }
  const timeoutMs = Math.min(1800000, 120000 + sizeMB * 1000);
  console.log(`[routes][spawn] ${progressKey}: ${paths.length} 文件 size=${sizeMB.toFixed(1)}MB → timeout=${Math.round(timeoutMs / 1000)}s`);
  const args = [path.join(__dirname, 'python', script)].concat(paths).concat(extraArgs || []);
  const child = spawn('python', args, { cwd: PY_PROJECT });
  let done = false;
  let stderrTail = '';
  child.stderr.on('data', (d) => { stderrTail = (stderrTail + d.toString()).slice(-800); });
  // 收集 stdout 的 STEP_PROGRESS|xxx 进度行, 供轮询
  // 注意: pipe 的 data chunk 任意大小, 行可能跨 chunk — 必须缓冲到完整行再匹配 (Windows \r\n 行尾)
  let stdoutBuf = '';
  child.stdout.on('data', (d) => {
    stdoutBuf += d.toString();
    const lines = stdoutBuf.split('\n');
    stdoutBuf = lines.pop();
    for (const line of lines) {
      if (line.startsWith('STEP_PROGRESS|')) {
        progressMap.set(progressKey, line.slice('STEP_PROGRESS|'.length).trim());
      }
    }
  });
  const finish = (fn, arg) => { if (done) return; done = true; progressMap.delete(progressKey); fn(arg); };
  const timeout = setTimeout(() => {
    try { child.kill(); } catch (e) { /* ignore */ }
    finish(failure, `${failMsg} (${Math.round(timeoutMs / 1000)} 秒超时)`);
  }, timeoutMs);
  child.on('exit', (code) => {
    clearTimeout(timeout);
    if (code !== 0 || !fs.existsSync(outPath)) {
      const detail = stderrTail.trim().split('\n')
        .filter(l => l.includes('❌') || l.includes('Error') || l.includes('Traceback'))
        .slice(-3).join(' | ');
      const suffix = detail ? `。详情: ${detail}` : '';
      finish(failure, `${failMsg} (exit ${code})。${suffix}`);
      return;
    }
    try {
      const result = JSON.parse(fs.readFileSync(outPath, 'utf8'));
      finish(success, result);
    } catch (e) {
      finish(failure, '提取结果解析失败: ' + friendlyError(e));
    }
  });
  child.on('error', (err) => finish(failure, 'Python 启动失败: ' + friendlyError(err)));
  return { timeoutMs, sizeMB };
}
router.get('/api/step/progress', (req, res) => {
  const name = String(req.query.name || '');
  res.json({ ok: true, progress: stepProgress.get(name) || null });
});
// 原始二进制上传 (前端直接发 File body): 无 base64/JSON 开销, 文件名/类型走请求头
router.post('/api/step/upload', (req, res) => {
  const filename = decodeURIComponent(req.get('x-filename') || 'upload.stp').replace(/[^a-zA-Z0-9._-]/g, '_');
  const type = req.get('x-type') || 'mirror'; // mirror | rear-window

  const onDone = (stepPath) => {
    // 按类型 spawn 对应 Python 提取脚本
    const script = type === 'rear-window' ? 'step_rear_window.py' : 'step_topology.py';
    // step_topology.py 输出 <step>.mirror-outline.json (不支持 --output); step_rear_window.py 支持 --output
    // step_topology.py 用 Path.with_suffix('.mirror-outline.json') 替换最后一个后缀,
    // 即 .stp 与 .step 都会被替换; JS 侧正则须同步覆盖两种扩展名, 否则 .step 文件
    // 的 expectedOut 多带一层后缀 → existsSync 假阴性 → 静默"未提取到目标轮廓"
    const expectedOut = type === 'rear-window'
      ? path.join(STEP_TMP_DIR, filename + '.outline.json')
      : path.join(STEP_TMP_DIR, filename.replace(/\.(stp|step)$/i, '') + '.mirror-outline.json');
    try { fs.unlinkSync(expectedOut); } catch (e) { /* 忽略 */ }

    const extraArgs = type === 'rear-window' ? ['--n', '30', '--output', expectedOut] : ['80'];
    const failMsg = type === 'mirror'
      ? '内镜向导提取失败 (需含"镜面/内镜片"面的内后视镜 STEP, 外镜整车不适用)'
      : '后挡风提取失败 (请确认文件为后挡风模型 STEP)';
    spawnStepExtract({
      stepPaths: [stepPath], outPath: expectedOut, script, extraArgs,
      progressMap: stepProgress, progressKey: filename,
      failMsg,
      success: (outlineJson) => {
        // 提取轮廓点: step_topology 输出 outline_local_mm (2D), step_rear_window 输出 outline_mm (3D, mm)
        // 均以 mm 原样返回前端 (预览/存储一致); 引擎使用时在 load 处 mm→m
        let outline = null;
        let count = 0;
        if (type === 'rear-window' && outlineJson.outline_mm) {
          outline = outlineJson.outline_mm;
          count = outline.length;
        } else if (outlineJson.outline_local_mm) {
          outline = outlineJson.outline_local_mm;
          count = outline.length;
        } else if (outlineJson.outline_global_mm) {
          outline = outlineJson.outline_global_mm.map(p => [p[0], p[1], p[2]]);
          count = outline.length;
        }
        if (!outline || count < 3) {
          return res.status(500).json({ ok: false, error: 'STEP 解析未产生有效轮廓点' });
        }
        res.json({ ok: true, outline, outline_count: count, face_id: outlineJson.face_id || null, face_name: outlineJson.face_name || null });
      },
      failure: (msg) => res.status(400).json({ ok: false, error: msg }),
    });
  };

  streamStepToTmp(req, filename, onDone, (status, msg) => res.status(status).json({ ok: false, error: msg }));
});

// ---- 外后视镜: STEP 上传一键提取 (raw 二进制 → 临时文件 → spawn step_exterior_extract) ----
// 提取进度 (按文件名轮询): Python 打印 STEP_PROGRESS|xxx → 收集 → 前端轮询显示
const extExtractProgress = new Map();
router.get('/api/exterior/extract/progress', (req, res) => {
  const name = String(req.query.name || '');
  res.json({ ok: true, progress: extExtractProgress.get(name) || null });
});
// type: () => true — 同 /api/step/upload: 不挑 Content-Type 一律按原始字节接收
router.post('/api/exterior/extract', (req, res) => {
  const filename = decodeURIComponent(req.get('x-filename') || 'upload.stp').replace(/[^a-zA-Z0-9._-]/g, '_');

  const onDone = (stepPath) => {
    // 输出名: <stem>.json, 落在 tmp 提取目录 (向导中途放弃不留 orphan 车型, 保存时才落盘 exterior)
    const stem = filename.replace(/\.(stp|step)$/i, '');
    const outPath = path.join(STEP_TMP_DIR, stem + '.json');
    if (!path.resolve(outPath).startsWith(path.resolve(STEP_TMP_DIR))) {
      return res.status(400).json({ ok: false, error: '路径越界, 只能写到 tmp 目录' });
    }
    try { fs.unlinkSync(outPath); } catch (e) { /* 不存在忽略 */ }

    spawnStepExtract({
      stepPaths: [stepPath], outPath, script: 'step_exterior_extract.py', extraArgs: ['--output', outPath],
      progressMap: extExtractProgress, progressKey: filename,
      failMsg: '外镜 STEP 提取失败, 请确认文件为含球面镜 (SPHERICAL_SURFACE) 的外镜整车模型',
      success: () => res.json({ ok: true, path: outPath, vehicles: scanExteriorVehicles() }),
      failure: (msg) => res.status(400).json({ ok: false, error: msg }),
    });
  };

  streamStepToTmp(req, filename, onDone, (status, msg) => res.status(status).json({ ok: false, error: msg }));
});

// ---- 外后视镜: 多文件上传 (同一车型多个 STEP 合并提取) ----
// 第一步: 上传单个文件到 tmp (仅落盘, 不提取), 返回文件名; 前端逐文件收集后调 extract-multi
router.post('/api/exterior/upload-tmp', (req, res) => {
  const filename = decodeURIComponent(req.get('x-filename') || 'upload.stp').replace(/[^a-zA-Z0-9._-]/g, '_');
  streamStepToTmp(req, filename, (stepPath) => {
    res.json({ ok: true, filename, path: stepPath });
  }, (status, msg) => res.status(status).json({ ok: false, error: msg }));
});

// 第二步: 合并提取 — 接收已落盘 tmp 的文件名列表, 一次性合并提取全部参数
router.post('/api/exterior/extract-multi', jsonParser, (req, res) => {
  const files = (req.body && req.body.files) || [];
  if (!Array.isArray(files) || files.length === 0) {
    return res.status(400).json({ ok: false, error: '缺少 files 列表' });
  }
  const stepPaths = [];
  for (const f of files) {
    const name = String(f).replace(/[^a-zA-Z0-9._-]/g, '_');
    const p = path.join(STEP_TMP_DIR, name);
    if (!path.resolve(p).startsWith(path.resolve(STEP_TMP_DIR)) || !fs.existsSync(p)) {
      return res.status(400).json({ ok: false, error: '临时文件不存在或越界: ' + name });
    }
    stepPaths.push(p);
  }
  // 输出名: 用第一个文件的 stem (多文件合并后仍是一个车型 JSON)
  const stem = path.basename(stepPaths[0], path.extname(stepPaths[0]));
  const outPath = path.join(STEP_TMP_DIR, stem + '.json');
  try { fs.unlinkSync(outPath); } catch (e) { /* 不存在忽略 */ }
  spawnStepExtract({
    stepPaths, outPath, script: 'step_exterior_extract.py', extraArgs: ['--output', outPath],
    progressMap: extExtractProgress, progressKey: files.join('+'),
    failMsg: '外镜多文件提取失败, 请确认文件含球面镜 (SPHERICAL_SURFACE) 与参数',
    success: () => res.json({ ok: true, path: outPath, vehicles: scanExteriorVehicles() }),
    failure: (msg) => res.status(400).json({ ok: false, error: msg }),
  });
});

// ---- 内后视镜: STEP 上传一键提取 (raw 二进制 → 临时文件 → spawn step_interior_extract) ----
// 与外镜 /api/exterior/extract 同模式: 输出落 data/tmp (向导中途放弃不留 orphan), 进度按文件名轮询。
const intExtractProgress = new Map();
router.get('/api/interior/extract/progress', (req, res) => {
  const name = String(req.query.name || '');
  res.json({ ok: true, progress: intExtractProgress.get(name) || null });
});
router.post('/api/interior/extract', (req, res) => {
  const filename = decodeURIComponent(req.get('x-filename') || 'upload.stp').replace(/[^a-zA-Z0-9._-]/g, '_');

  const onDone = (stepPath) => {
    const stem = filename.replace(/\.(stp|step)$/i, '');
    const outPath = path.join(STEP_TMP_DIR, stem + '.json');
    // 路径越界闸门: 输出必须落在 STEP_TMP_DIR 内 (对齐 /api/exterior/extract)
    if (!path.resolve(outPath).startsWith(path.resolve(STEP_TMP_DIR))) {
      return res.status(400).json({ ok: false, error: '路径越界, 只能写到 tmp 目录' });
    }
    try { fs.unlinkSync(outPath); } catch (e) { /* 不存在忽略 */ }

    spawnStepExtract({
      stepPaths: [stepPath], outPath, script: 'step_interior_extract.py', extraArgs: ['--output', outPath],
      progressMap: intExtractProgress, progressKey: filename,
      failMsg: '内镜 STEP 提取失败, 请确认文件为含内镜 (命名点/镜片面) 的整车 STEP',
      success: (result) => res.json({ ok: true, path: outPath, result }),
      failure: (msg) => res.status(400).json({ ok: false, error: msg }),
    });
  };

  streamStepToTmp(req, filename, onDone, (status, msg) => res.status(status).json({ ok: false, error: msg }));
});

// ---- 内后视镜: 多文件上传 (同一车型多个 STEP 合并提取) ----
// 第一步: 上传单个文件到 tmp (仅落盘, 不提取), 返回文件名
router.post('/api/interior/upload-tmp', (req, res) => {
  const filename = decodeURIComponent(req.get('x-filename') || 'upload.stp').replace(/[^a-zA-Z0-9._-]/g, '_');
  streamStepToTmp(req, filename, (stepPath) => {
    res.json({ ok: true, filename, path: stepPath });
  }, (status, msg) => res.status(status).json({ ok: false, error: msg }));
});

// 第二步: 合并提取 — 接收已落盘 tmp 的文件名列表, 一次性合并提取全部参数
router.post('/api/interior/extract-multi', jsonParser, (req, res) => {
  const files = (req.body && req.body.files) || [];
  if (!Array.isArray(files) || files.length === 0) {
    return res.status(400).json({ ok: false, error: '缺少 files 列表' });
  }
  const stepPaths = [];
  for (const f of files) {
    const name = String(f).replace(/[^a-zA-Z0-9._-]/g, '_');
    const p = path.join(STEP_TMP_DIR, name);
    if (!path.resolve(p).startsWith(path.resolve(STEP_TMP_DIR)) || !fs.existsSync(p)) {
      return res.status(400).json({ ok: false, error: '临时文件不存在或越界: ' + name });
    }
    stepPaths.push(p);
  }
  const stem = path.basename(stepPaths[0], path.extname(stepPaths[0]));
  const outPath = path.join(STEP_TMP_DIR, stem + '.json');
  try { fs.unlinkSync(outPath); } catch (e) { /* 不存在忽略 */ }
  spawnStepExtract({
    stepPaths, outPath, script: 'step_interior_extract.py', extraArgs: ['--output', outPath],
    progressMap: intExtractProgress, progressKey: files.join('+'),
    failMsg: '内镜多文件提取失败, 请确认文件含内镜 (命名点/镜片面) 与参数',
    success: (result) => res.json({ ok: true, path: outPath, result }),
    failure: (msg) => res.status(400).json({ ok: false, error: msg }),
  });
});

// ---- 重试提取: STEP 已在盘 (data/tmp), 不重传, 直接重新 spawn ----
// 提取失败/超时后, 临时 STEP 文件仍留在 data/tmp, 点"重试提取"复用该文件
router.post('/api/exterior/extract/retry', jsonParser, (req, res) => {
  const name = String((req.body && req.body.name) || '').replace(/[^a-zA-Z0-9._-]/g, '_');
  if (!name) return res.status(400).json({ ok: false, error: '缺少文件名 name' });
  const stepPath = path.join(STEP_TMP_DIR, name);
  if (!path.resolve(stepPath).startsWith(path.resolve(STEP_TMP_DIR))) {
    return res.status(400).json({ ok: false, error: '路径越界, 只能读取 tmp 目录' });
  }
  if (!fs.existsSync(stepPath)) {
    return res.status(404).json({ ok: false, error: '临时 STEP 文件不存在 (可能已被清理), 请重新上传' });
  }
  const stem = name.replace(/\.(stp|step)$/i, '');
  const outPath = path.join(STEP_TMP_DIR, stem + '.json');
  if (!path.resolve(outPath).startsWith(path.resolve(STEP_TMP_DIR))) {
    return res.status(400).json({ ok: false, error: '路径越界, 只能写到 tmp 目录' });
  }
  try { fs.unlinkSync(outPath); } catch (e) { /* 不存在忽略 */ }
  spawnStepExtract({
    stepPaths: [stepPath], outPath, script: 'step_exterior_extract.py', extraArgs: ['--output', outPath],
    progressMap: extExtractProgress, progressKey: name,
    failMsg: '外镜 STEP 提取失败, 请确认文件为含球面镜 (SPHERICAL_SURFACE) 的外镜整车模型',
    success: () => res.json({ ok: true, path: outPath, vehicles: scanExteriorVehicles() }),
    failure: (msg) => res.status(400).json({ ok: false, error: msg }),
  });
});

router.post('/api/interior/extract/retry', jsonParser, (req, res) => {
  const name = String((req.body && req.body.name) || '').replace(/[^a-zA-Z0-9._-]/g, '_');
  if (!name) return res.status(400).json({ ok: false, error: '缺少文件名 name' });
  const stepPath = path.join(STEP_TMP_DIR, name);
  if (!path.resolve(stepPath).startsWith(path.resolve(STEP_TMP_DIR))) {
    return res.status(400).json({ ok: false, error: '路径越界, 只能读取 tmp 目录' });
  }
  if (!fs.existsSync(stepPath)) {
    return res.status(404).json({ ok: false, error: '临时 STEP 文件不存在 (可能已被清理), 请重新上传' });
  }
  const stem = name.replace(/\.(stp|step)$/i, '');
  const outPath = path.join(STEP_TMP_DIR, stem + '.json');
  if (!path.resolve(outPath).startsWith(path.resolve(STEP_TMP_DIR))) {
    return res.status(400).json({ ok: false, error: '路径越界, 只能写到 tmp 目录' });
  }
  try { fs.unlinkSync(outPath); } catch (e) { /* 不存在忽略 */ }
  spawnStepExtract({
    stepPaths: [stepPath], outPath, script: 'step_interior_extract.py', extraArgs: ['--output', outPath],
    progressMap: intExtractProgress, progressKey: name,
    failMsg: '内镜 STEP 提取失败, 请确认文件为含内镜 (命名点/镜片面) 的整车 STEP',
    success: (result) => res.json({ ok: true, path: outPath, result }),
    failure: (msg) => res.status(400).json({ ok: false, error: msg }),
  });
});

// ---- 内后视镜: 保存车型 (单接口原子写, 平行 /api/exterior/save) ----
// 接收完整内镜 config (含 mirror.outline_local_mm inline 轮廓), 落盘 data/vehicles/<name>.json。
// 与外镜 /api/exterior/save 对齐: name sanitize + VEHICLES_DIR 越界闸门 + 默认车型保护 + 原子写。
router.post('/api/interior/save', jsonParser, (req, res) => {
  try {
    const body = req.body || {};
    const config = body.config && typeof body.config === 'object' ? body.config : body;
    const name = (body.name || (config.vehicle && config.vehicle.name) || '新内镜车型').trim();
    if (!name) return res.status(400).json({ ok: false, error: '车型名不能为空' });
    const safe = name.replace(/[\\/:*?"<>|]/g, '_');
    const cfgPath = body.path || path.join(VEHICLES_DIR, `${safe}.json`);
    // path 越界校验 (对齐 /api/vehicles/save: 只允许写 vehicles 目录内)
    const resolved = path.resolve(cfgPath);
    if (!resolved.startsWith(path.resolve(VEHICLES_DIR))) {
      return res.status(400).json({ ok: false, error: '路径越界, 只能保存到 vehicles 目录' });
    }
    // 默认车型保护: 不允许直接覆盖 车型C.json (默认车型), 需另存为新名 (大小写不敏感)
    if (isDefaultVehicle(resolved) && !body.forceOverwriteDefault) {
      return res.status(400).json({ ok: false, error: '不能直接覆盖默认车型 (车型C), 请改车型名另存为新文件' });
    }
    // 补全 vehicle.name (另存为时以用户输入名覆盖), 确保与文件名一致
    if (!config.vehicle) config.vehicle = {};
    config.vehicle.name = name;
    fs.writeFileSync(cfgPath, JSON.stringify(config, null, 2), 'utf8');
    res.json({ ok: true, path: cfgPath, vehicles: scanVehicles() });
  } catch (e) {
    res.status(400).json({ ok: false, error: friendlyError(e) });
  }
});

// ---- 新建向导: 保存提取的轮廓文件 + 设置车型 outline_path ----
router.post('/api/vehicles/save-outline', jsonParser, (req, res) => {
  try {
    const body = req.body || {};
    const vehiclePath = path.resolve(body.vehiclePath || '');
    const kind = body.kind || 'mirror'; // mirror | rear-window
    const outlineFile = body.outlineFile;
    if (!vehiclePath.startsWith(path.resolve(VEHICLES_DIR))) {
      return res.status(400).json({ ok: false, error: '路径越界' });
    }
    if (!outlineFile || !outlineFile.outline_count) {
      return res.status(400).json({ ok: false, error: '缺少轮廓数据' });
    }

    // 保存轮廓文件到车型同目录
    const base = path.basename(vehiclePath, '.json');
    const outlinePath = path.join(path.dirname(vehiclePath), `${base}.${kind === 'rear-window' ? 'rear-window' : 'outline'}.json`);
    fs.writeFileSync(outlinePath, JSON.stringify(outlineFile, null, 2), 'utf8');

    // 更新车型 JSON 的 outline_path
    const vehicle = JSON.parse(fs.readFileSync(vehiclePath, 'utf8'));
    if (kind === 'rear-window') {
      if (!vehicle.rear_window) vehicle.rear_window = {};
      vehicle.rear_window.outline_path = path.basename(outlinePath);
    } else {
      if (!vehicle.mirror) vehicle.mirror = {};
      vehicle.mirror.outline_path = path.basename(outlinePath);
    }
    fs.writeFileSync(vehiclePath, JSON.stringify(vehicle, null, 2), 'utf8');

    res.json({ ok: true, outlinePath, vehicles: scanVehicles() });
  } catch (e) {
    res.status(400).json({ ok: false, error: friendlyError(e) });
  }
});

// 静态文件 + 首页 (放最后, 平台 server.js 挂载后即生效)
router.use(express.static(path.join(__dirname, 'public')));
router.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ---- JSON 错误处理器 (放所有路由之后, module.exports 之前) ----
// 统一把 413 / 中间件错误 (body-parser 非法 JSON 等) 返回 JSON 而非 HTML。
// 注意: 上传端点已改流式写盘 (不再 express.raw), 413 由 streamStepToTmp 直接返回;
// 此 handler 兜底任何 next(err) 传出的错误 (含 jsonParser 语法错误)。
router.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const code = err && (err.status || err.statusCode);
  const limited = err && (err.code === 'LIMIT_FILE_SIZE' || err.code === 'LIMIT_PAYLOAD' ||
    err.type === 'entity.too.large' || code === 413);
  const status = limited ? 413 : (code || 500);
  const message = limited ? '文件过大, 超过 500MB 限制' : friendlyError(err);
  res.status(status).json({ ok: false, error: message });
});

module.exports = router;
