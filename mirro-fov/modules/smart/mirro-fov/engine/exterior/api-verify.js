/**
 * 外镜 API 校核助手 — 支持车型文件加载 + 双镜(L+R)合并校核 + 合并 viz
 * 供 routes.js 调用
 */
const fs = require('fs');
const path = require('path');
const { fitSphereFromOutline, projectToSphere, validateOutlineOnSphere } = require('./sphere-fit');
const { ExteriorMirror, buildTriangles, findMirrorPointsForTarget, verifyExterior, searchExteriorAngles } = require('./exterior-mirror');
const { Ground } = require('../shared/plane');
const { vec3Sub, vec3Add, vec3Scale, vec3Normalize, vec3Norm } = require('../shared/geometry');

const EXTERIOR_DIR = path.join(__dirname, '..', '..', 'data', 'exterior');

const r1 = x => Math.round(x * 10) / 10;
const r3 = x => Math.round(x * 1000) / 1000;
const r4 = x => Math.round(x * 10000) / 10000;
const r4v = v => v ? v.map(r4) : v;

function loadExteriorVehicle(p) {
  const fp = p || path.join(EXTERIOR_DIR, 'exterior-vehicle-draft.json');
  return JSON.parse(fs.readFileSync(fp, 'utf8'));
}

function scanExteriorVehicles() {
  if (!fs.existsSync(EXTERIOR_DIR)) return [];
  const files = fs.readdirSync(EXTERIOR_DIR).filter(f => f.endsWith('.json') && !f.endsWith('.example.json'));
  const out = [];
  for (const f of files) {
    try {
      const raw = loadExteriorVehicle(path.join(EXTERIOR_DIR, f));
      out.push({ label: (raw.vehicle && raw.vehicle.name) || f.replace(/\.json$/, ''), value: path.join(EXTERIOR_DIR, f), name: (raw.vehicle && raw.vehicle.name) || f });
    } catch (e) { /* skip */ }
  }
  return out;
}

function capMesh(mirror) {
  const N = 18;
  const us = mirror.outlineUV.map(p => p[0]), vs = mirror.outlineUV.map(p => p[1]);
  const uMin = Math.min(...us), uMax = Math.max(...us), vMin = Math.min(...vs), vMax = Math.max(...vs);
  const x = [], y = [], z = [], I = [], J = [], K = [];
  const idx = (i, j) => i * (N + 1) + j;
  for (let i = 0; i <= N; i++) for (let j = 0; j <= N; j++) {
    const u = uMin + (uMax - uMin) * i / N, vv = vMin + (vMax - vMin) * j / N;
    const P = vec3Add(mirror.capCenter, vec3Add(vec3Scale(mirror.rightVec, u / 1000), vec3Scale(mirror.upVec, vv / 1000)));
    const dir = vec3Normalize(vec3Sub(P, mirror.sphereCenter));
    const sp = vec3Add(mirror.sphereCenter, vec3Scale(dir, mirror.radius));
    x.push(r4(sp[0])); y.push(r4(sp[1])); z.push(r4(sp[2]));
  }
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
    const a = idx(i, j), b = idx(i + 1, j), c = idx(i + 1, j + 1), d = idx(i, j + 1);
    I.push(a, a); J.push(b, c); K.push(c, d);
  }
  return { x, y, z, i: I, j: J, k: K };
}

function axisLine(pt, dir, halfLen) {
  return [vec3Add(pt, vec3Scale(dir, -halfLen)), vec3Add(pt, vec3Scale(dir, halfLen))].map(r4v);
}

function raysFromEdge(eye, tri, n, mirror) {
  const out = [];
  const [A, B] = tri.vertices;
  for (let k = 0; k <= n; k++) {
    const t = k / n;
    const Q = [A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t];
    const pts = findMirrorPointsForTarget(eye, Q, mirror);
    if (pts.length) out.push({ eye: r4v(eye), mirrorPoint: r4v(pts[0].point), target: r4v(Q) });
  }
  return out;
}

/** 单镜校核 (内部) */
function verifyOne(side, raw, opts = {}) {
  const { psi = 0, theta = 0, samplePerEdge = 20, minMarginMm = 3.0, search: doSearch = false } = opts;
  const mir = raw[`exterior_mirror_${side}`];
  const eyeCenter = raw.driver.eye_center;
  const eyes = { left: raw.driver.eye_left_raw, right: raw.driver.eye_right_raw };
  const doorOuterY = raw.door_panel[`door_outer_Y_${side}`];
  const ground = Ground.fromTwoPoints(raw.ground.front_mid, raw.ground.rear_mid);
  const regulation = raw.regulation;
  // 轮廓度 (加工误差, 对称 ±, mm): 车型数据 profile_tol_mm, 缺省 0.3 (STEP 只有名义几何, 轮廓度需供应商图纸给)
  const profileTolMm = (typeof mir.profile_tol_mm === 'number' && Number.isFinite(mir.profile_tol_mm)) ? mir.profile_tol_mm : 0.3;

  // coplanarTolMm=1.0: 球面帽浅曲 (残差 0.3~0.5mm) 时走 planar-cut (用已知 SR 约束), 避免 general 拟合在浅帽上不稳定
  const fit = fitSphereFromOutline(mir.outline_raw, { srDesign: mir.sr_fit, eye: eyeCenter, supplierCenter: mir.supplier_sphere_center, coplanarTolMm: 1.0 });
  const gate = validateOutlineOnSphere(mir.outline_raw, fit.center, mir.sr_fit);
  const projOutline = projectToSphere(mir.outline_raw, fit.center, mir.sr_fit);
  let mirror = new ExteriorMirror({ radius: mir.sr_fit, sphereCenter: fit.center, outline: projOutline, turretAxisPoint: mir.turret_axis_p1, turretAxisDir: mir.rotation_axis_dir, foldAxisDir: mir.fold_axis_dir });
  if (psi || theta) mirror = mirror.rotated2D(psi, theta);

  const v = verifyExterior(eyes, doorOuterY, ground, mirror, { samplePerEdge, minMarginMm, profileTolMm, regulation });
  const tris = buildTriangles(eyeCenter, doorOuterY, ground, mirror, regulation);
  // search=false(默认): 只做当前角度校核, 不做二维搜索 (快); search=true: 做二维搜索拿可调窗口
  const search = doSearch
    ? searchExteriorAngles(eyes, doorOuterY, ground, mirror, { step: 0.5, range: 3.0, regulation })
    : null;

  return { side, fit, gate, mirror, v, tris, search, mir, eyeCenter, eyes, doorOuterY, ground, regulation, projOutline, profileTolMm, minMarginMm };
}

/** 双镜合并校核: 返回 left/right 结果 + 2D 反射面投影 viz */
function verifyExteriorBoth(p, opts = {}) {
  const raw = loadExteriorVehicle(p);
  const L = verifyOne('left', raw, opts);
  const R = verifyOne('right', raw, opts);

  // 2D 反射面投影: 镜面轮廓 + 4 个投影 (2眼×2三角形)。
  // 球面反射每个目标点有两个数学根, 选离上一个 UV 最近的 on-surface 根保持空间连续性。
  function mirrorViz2d(r) {
    const m = r.mirror;
    const outlineUV = m.outlineUV.map(p => [r1(p[0]), r1(p[1])]);
    const projections = [];
    for (const [eyeName, eye] of [['left', r.eyes.left], ['right', r.eyes.right]]) {
      for (let ti = 0; ti < 2; ti++) {
        const tri = r.tris[ti];
        const triName = ti === 0 ? 'near' : 'far';
        const pts = [];
        const edges = [[0, 1], [1, 2], [2, 0]];  // AB, BT, TA
        let prevUv = null;
        for (const [a, b] of edges) {
          for (let k = 0; k <= 10; k++) {
            const t = k / 10;
            const A = tri.vertices[a], B = tri.vertices[b];
            const Q = [A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t];
            const roots = findMirrorPointsForTarget(eye, Q, m);
            // 收集所有 on-surface 的根, 选离 prevUv 最近的 (空间连续性)
            const onRoots = [];
            for (const { point } of roots) {
              const [u, v] = m.localUV(point);
              if (!Number.isFinite(u) || !Number.isFinite(v)) continue;
              if (m.onReflectiveSurface(u, v)) onRoots.push({ u, v });
            }
            if (onRoots.length) {
              let best = onRoots[0];
              if (onRoots.length > 1 && prevUv) {
                let bestD = Infinity;
                for (const r of onRoots) {
                  const d = Math.hypot(r.u - prevUv[0], r.v - prevUv[1]);
                  if (d < bestD) { bestD = d; best = r; }
                }
              }
              const d = m.boundaryDistanceMm(best.u, best.v);
              pts.push({ u: r1(best.u), v: r1(best.v), onSurface: true, margin: Number.isFinite(d) ? r1(d) : null });
              prevUv = [best.u, best.v];
            } else {
              pts.push({ u: NaN, v: NaN, onSurface: false, margin: null });
            }
          }
        }
        const allVisible = pts.every(p => p.onSurface && p.margin != null && p.margin >= r.minMarginMm);
        projections.push({ eye: eyeName, tri: triName, points: pts, allVisible });
      }
    }
    return { side: r.side, outlineUV, projections, mirrorPass: r.v.mirrorPass, profileTolMm: r.profileTolMm };
  }

  const viz = {
    mirrors: [mirrorViz2d(L), mirrorViz2d(R)],
  };

  // 边的最小安全距离 (法规要求 ≥3mm), 供前端显示"还剩多少"
  function edgeMinMargin(edges) {
    let min = null;
    for (const e of edges) {
      for (const s of e.samples) {
        if (s.d != null && Number.isFinite(s.d) && (min === null || s.d < min)) min = s.d;
      }
    }
    return min;
  }

  function summary(r) {
    const cc = r.fit.crossCheck || {};
    const nearMin = edgeMinMargin(r.v.near.edges);
    const farMin = edgeMinMargin(r.v.far.edges);
    return {
      side: r.side,
      mirrorPass: r.v.mirrorPass, nearPass: r.v.near.pass, farPass: r.v.far.pass,
      nearMinMargin: nearMin === null ? null : r4(nearMin),
      farMinMargin: farMin === null ? null : r4(farMin),
      profileTolMm: r.profileTolMm, minMarginMm: r.minMarginMm,
      nearEdges: r.v.near.edges.map(e => ({ name: e.name, pass: e.pass, visible: e.samples.filter(s => s.visible).length + '/' + e.samples.length })),
      farEdges: r.v.far.edges.map(e => ({ name: e.name, pass: e.pass, visible: e.samples.filter(s => s.visible).length + '/' + e.samples.length })),
      search: r.search ? {
        found: r.search.found,
        bestPsi: r.search.bestPsi,
        bestTheta: r.search.bestTheta ?? null,
        window: r.search.results.filter(x => x.mirrorPass).map(x => x.psi),
        window2D: r.search.results.filter(x => x.mirrorPass).map(x => ({ psi: x.psi, theta: x.theta ?? null })),
        results: r.search.results,
      } : null,
      fit: { method: r.fit.method, center: r4v(r.fit.center), radius: r4(r.fit.radius), residualMm: r4(r.fit.fitResidualMm),
        crossCheck: cc ? { ok: cc.ok, devMm: r4(cc.devMm) } : null, gate: { ok: r.gate.ok, maxDevMm: r4(r.gate.maxDevMm) } },
    };
  }

  // 共同窗口: 同一 (psi, theta) 使两镜都过 (二维交集; 单轴退化时 theta=null, 交集退化为 psi 交集)
  // search=false 时两侧 search 均为 null, commonSearch 也置 null (前端据此显示"自动搜角可查")
  let commonSearch = null;
  if (L.search && R.search) {
    const key = x => `${x.psi},${x.theta ?? null}`;
    const Lpass = new Set(L.search.results.filter(x => x.mirrorPass).map(key));
    const commonPairs = R.search.results.filter(x => x.mirrorPass && Lpass.has(key(x)))
      .map(x => ({ psi: x.psi, theta: x.theta ?? null }));
    commonSearch = {
      found: commonPairs.length > 0,
      bestPsi: commonPairs[0] ? commonPairs[0].psi : null,
      bestTheta: commonPairs[0] ? commonPairs[0].theta : null,
      window: [...new Set(commonPairs.map(x => x.psi))],
      pairs: commonPairs,
    };
  }

  return {
    path: p || path.join(EXTERIOR_DIR, 'exterior-vehicle-draft.json'),
    vehicle: raw.vehicle,
    psi: opts.psi || 0,
    theta: opts.theta || 0,
    left: summary(L),
    right: summary(R),
    commonSearch,
    viz,
  };
}

module.exports = { verifyExteriorBoth, loadExteriorVehicle, scanExteriorVehicles };
