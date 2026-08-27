/**
 * 球面拟合 — 从反射面轮廓点坐标求球心 (纯点坐标, 零依赖)
 *
 * 背景: 外后视镜是凸球面镜, 镜面是球面上切下的"帽"。供应商提供 N≥4 轮廓点
 * (在反射面边界曲线上) + SR 设计值。球心由拟合推导, 不手量、不直接采信
 * (供应商球心可作交叉校核)。
 *
 * 两种轮廓形态 (自动检测, 分支处理):
 *   A. 轮廓非共面 — 代数球拟合 (未知数 C + R, SR 不参与), 4+ 点满秩可解
 *   B. 轮廓共面 (帽由平面切割 — 常见!) — 等距方程组秩亏, 必须改用
 *      "面内圆拟合 + 沿面法线偏移": 面内拟合圆 (O, r) →
 *      h = sqrt(SR_design² − r²) → C = O − h·n̂_eye
 *      (n̂_eye = 指向眼点一侧的平面法线; 凸球球心在镜面背面, 与眼点异侧)
 *      此路径必需 SR 设计值 + 眼点。
 *
 * SR 约定 (勿混淆):
 *   - 拟合用 srDesign — 轮廓点物理上在设计曲面上 (如 1.260)
 *   - 校核用 srVerify = srDesign + 公差上限 — 最平 = 视野最小 (如 1.320)
 *   - 拟合得 C 后: projectToSphere 把轮廓点沿径向投到 srVerify 球面
 *
 * 单位: 输入/输出长度 m; 诊断字段 *Mm 为毫米。
 */
const { vec3Add, vec3Sub, vec3Scale, vec3Dot, vec3Norm, vec3Normalize } = require('../shared/geometry');

// ─── 基础线性代数 (零依赖) ───

/** 高斯消元解 n×n 线性方程组 (列主元), 奇异返回 null */
function solveLinear(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    if (Math.abs(M[piv][col]) < 1e-12) return null;
    if (piv !== col) { const t = M[col]; M[col] = M[piv]; M[piv] = t; }
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col] / M[col][col];
      if (f === 0) continue;
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
    }
  }
  return M.map((row, i) => row[n] / row[i]); // Gauss-Jordan 后 row[i] 即对角元
}

/** 3×3 实对称矩阵特征分解 (循环 Jacobi), 特征值升序, vectors[i] = 第 i 小特征值对应单位特征向量 */
function eigenSym3(S) {
  const A = [S[0].slice(), S[1].slice(), S[2].slice()];
  const V = [[1, 0, 0], [0, 1, 0], [0, 0, 1]]; // V[k][j] = 特征向量 j 的第 k 分量
  for (let iter = 0; iter < 64; iter++) {
    let p = 0, q = 1, mx = Math.abs(A[0][1]);
    if (Math.abs(A[0][2]) > mx) { p = 0; q = 2; mx = Math.abs(A[0][2]); }
    if (Math.abs(A[1][2]) > mx) { p = 1; q = 2; mx = Math.abs(A[1][2]); }
    if (mx < 1e-14) break;
    const theta = (A[q][q] - A[p][p]) / (2 * A[p][q]);
    const t = (theta >= 0 ? 1 : -1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
    const c = 1 / Math.sqrt(t * t + 1), s = t * c;
    for (let k = 0; k < 3; k++) { // A ← A·G (列 p,q)
      const akp = A[k][p], akq = A[k][q];
      A[k][p] = c * akp - s * akq;
      A[k][q] = s * akp + c * akq;
    }
    for (let k = 0; k < 3; k++) { // A ← Gᵀ·A (行 p,q)
      const apk = A[p][k], aqk = A[q][k];
      A[p][k] = c * apk - s * aqk;
      A[q][k] = s * apk + c * aqk;
    }
    for (let k = 0; k < 3; k++) { // V ← V·G (特征向量随转)
      const vkp = V[k][p], vkq = V[k][q];
      V[k][p] = c * vkp - s * vkq;
      V[k][q] = s * vkp + c * vkq;
    }
  }
  const idx = [0, 1, 2].sort((a, b) => A[a][a] - A[b][b]);
  return {
    values: idx.map(i => A[i][i]),
    vectors: idx.map(i => [V[0][i], V[1][i], V[2][i]]),
  };
}

// ─── 点集校验 / 平面拟合 ───

function validatePoints(points, minN = 4) {
  const fin = v => Array.isArray(v) && v.length >= 3 && v.every(Number.isFinite);
  if (!Array.isArray(points) || points.length < minN) {
    throw new Error(`轮廓点至少 ${minN} 个 (当前 ${Array.isArray(points) ? points.length : '非数组'})`);
  }
  if (!points.every(fin)) throw new Error('轮廓点必须全为有限 [x,y,z]');
}

/**
 * 平面拟合 (质心 + 协方差特征分解)
 * @returns {{centroid:number[], normal:number[], u:number[], v:number[],
 *            residualMm:number, spread1Mm:number, spread2Mm:number}}
 *   normal = 最小特征值方向 (最佳平面法线); u/v = 面内主轴 (展度大→小)
 *   residualMm = 点到平面 RMS 距离 (共面性指标)
 */
function fitPlane(points) {
  validatePoints(points, 3);
  const n = points.length;
  const mu = [0, 0, 0];
  for (const p of points) { mu[0] += p[0]; mu[1] += p[1]; mu[2] += p[2]; }
  mu[0] /= n; mu[1] /= n; mu[2] /= n;
  const S = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (const p of points) {
    const d = vec3Sub(p, mu);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) S[i][j] += d[i] * d[j];
  }
  const { values, vectors } = eigenSym3(S);
  // spread = sqrt(特征值/n) = 该主轴 RMS 展度
  return {
    centroid: mu,
    normal: vectors[0],
    u: vectors[2],
    v: vectors[1],
    residualMm: Math.sqrt(Math.max(values[0], 0) / n) * 1000,
    spread2Mm: Math.sqrt(Math.max(values[1], 0) / n) * 1000, // 次主轴展度 (共线检测)
    spread1Mm: Math.sqrt(Math.max(values[2], 0) / n) * 1000, // 主轴展度
  };
}

/** 2D 圆拟合 (Kasa 代数最小二乘): x²+y²+Dx+Ey+F=0 */
function fitCircle2D(pts2d) {
  if (!Array.isArray(pts2d) || pts2d.length < 3) throw new Error('圆拟合至少 3 个 2D 点');
  let Sx = 0, Sy = 0, Sxx = 0, Syy = 0, Sxy = 0, Sxz = 0, Syz = 0, Sz = 0;
  for (const [x, y] of pts2d) {
    const z = x * x + y * y;
    Sx += x; Sy += y; Sz += z;
    Sxx += x * x; Syy += y * y; Sxy += x * y;
    Sxz += x * z; Syz += y * z;
  }
  const n = pts2d.length;
  const sol = solveLinear(
    [[Sxx, Sxy, Sx], [Sxy, Syy, Sy], [Sx, Sy, n]],
    [-Sxz, -Syz, -Sz],
  );
  if (!sol) throw new Error('2D 圆拟合奇异 (点共线?)');
  const [D, E, F] = sol;
  const cx = -D / 2, cy = -E / 2;
  const r2 = cx * cx + cy * cy - F;
  if (!Number.isFinite(r2) || r2 <= 0) throw new Error('2D 圆拟合半径非正 (点近共线?)');
  return { cx, cy, r: Math.sqrt(r2) };
}

/** 代数球拟合 (自由球心+半径): 2P·C − w = |P|², w = |C|²−R²; 非共面点满秩 */
function fitSphereGeneral(points) {
  validatePoints(points, 4);
  const n = points.length;
  const ATA = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
  const ATb = [0, 0, 0, 0];
  for (const p of points) {
    const row = [2 * p[0], 2 * p[1], 2 * p[2], -1];
    const rhs = p[0] * p[0] + p[1] * p[1] + p[2] * p[2];
    for (let i = 0; i < 4; i++) {
      ATb[i] += row[i] * rhs;
      for (let j = 0; j < 4; j++) ATA[i][j] += row[i] * row[j];
    }
  }
  const sol = solveLinear(ATA, ATb);
  if (!sol) throw new Error('球拟合奇异 — 轮廓点近共面, 应走平面切割路径 (需要 SR 设计值 + 眼点)');
  const center = [sol[0], sol[1], sol[2]];
  const w = sol[3];
  const r2 = vec3Dot(center, center) - w;
  if (!Number.isFinite(r2) || r2 <= 0) throw new Error('球拟合半径非正 (点分布退化)');
  const radius = Math.sqrt(r2);
  let sq = 0;
  for (const p of points) { const dv = vec3Norm(vec3Sub(p, center)) - radius; sq += dv * dv; }
  return { center, radius, residualMm: Math.sqrt(sq / n) * 1000 };
}

// ─── 主入口 ───

/**
 * 从轮廓点拟合球心 — 自动检测共面/非共面并分支
 * @param {number[][]} points - 轮廓点 (N≥4, 整车坐标 m, 在反射面边界曲线上)
 * @param {Object} [opts]
 * @param {number} [opts.srDesign] - SR 设计值 (m); 共面轮廓必需 (h=√(SR²−r²))
 * @param {number[]} [opts.eye] - 眼点 (m); 共面轮廓必需 (球前/球背二义定侧)
 * @param {number} [opts.coplanarTolMm=0.5] - 共面判定阈值 (点到最佳平面 RMS 距离, mm)
 * @param {number[]} [opts.supplierCenter] - 供应商球心 (可选): 仅交叉校核, 不参与拟合
 * @returns {{center:number[], method:'general'|'planar-cut', radius:number,
 *            fitResidualMm:number, circleRadius:(number|null), planeNormal:(number[]|null),
 *            warnings:string[], crossCheck:(Object|null)}}
 *   radius = 轮廓点所在球面的半径 (general=拟合值, planar-cut=srDesign)
 *   planeNormal = 指向眼点一侧的轮廓平面法线 (仅 planar-cut)
 *   crossCheck = { devMm, impliedRadius, srDevMm, ok } 供应商球心校核 (未提供则 null)
 */
function fitSphereFromOutline(points, opts = {}) {
  const { srDesign, eye, coplanarTolMm = 0.5, supplierCenter } = opts;
  validatePoints(points, 4);
  const warnings = [];

  const plane = fitPlane(points);
  // 共线防御 (无论走哪条路径): 次主轴展度太小 → 点挤在一条线上
  if (plane.spread2Mm < 1) {
    throw new Error(`轮廓点近共线 (次主轴展度 ${plane.spread2Mm.toFixed(2)}mm) — 请沿反射面外沿分散取点`);
  }

  // 供应商球心交叉校核 (可选): 不参与拟合, 只报偏差; 不过 → 警告但仍以轮廓拟合为准
  // 关键盲区: planar-cut 路径下 SR 错误不产生拟合残差 (点恒在 (C_fit, srDesign) 球面上),
  // 只会让球心沿面法线静默平移 — 此校核是该盲区唯一防线
  function withCrossCheck(result) {
    let crossCheck = null;
    if (supplierCenter !== undefined && supplierCenter !== null) {
      const fin = v => Array.isArray(v) && v.length >= 3 && v.every(Number.isFinite);
      if (!fin(supplierCenter)) throw new Error('supplierCenter 非法 (需 [x,y,z] 有限)');
      const devMm = sphereCenterDeviation(result.center, supplierCenter);
      let impliedRadius = 0;
      for (const p of points) impliedRadius += vec3Norm(vec3Sub(p, supplierCenter));
      impliedRadius /= points.length; // 供应商球心隐含的轮廓半径 = 平均 |P − C_sup|
      const srDevMm = (Number.isFinite(srDesign) && srDesign > 0)
        ? Math.abs(impliedRadius - srDesign) * 1000 : null;
      const ok = devMm <= 5 && (srDevMm === null || srDevMm <= 10);
      crossCheck = { devMm, impliedRadius, srDevMm, ok };
      if (!ok) {
        warnings.push(`供应商球心交叉校核未通过: 球心偏差 ${devMm.toFixed(1)}mm` +
          (srDevMm !== null ? `, 其隐含轮廓半径与 SR 设计值差 ${srDevMm.toFixed(1)}mm` : '') +
          ` — 以轮廓拟合(${result.method})为准, 核查供应商数据 (坐标系/零件/SR)`);
      }
    }
    result.crossCheck = crossCheck;
    return result;
  }

  if (plane.residualMm < coplanarTolMm) {
    // ── B. 共面轮廓 (平面切割): 面内圆 + SR 偏移, 眼点定侧 ──
    if (!Number.isFinite(srDesign) || srDesign <= 0) {
      throw new Error('轮廓点共面 (帽由平面切割): 球心高度 h=√(SR²−r²) 需要 SR 设计值, 请提供 opts.srDesign (m)');
    }
    if (!Array.isArray(eye) || eye.length < 3 || !eye.every(Number.isFinite)) {
      throw new Error('轮廓点共面: 球心在平面两侧各有一解, 需要眼点 opts.eye 定侧 (凸球球心与眼点异侧)');
    }
    const pts2d = points.map(p => [vec3Dot(vec3Sub(p, plane.centroid), plane.u),
                                   vec3Dot(vec3Sub(p, plane.centroid), plane.v)]);
    const circ = fitCircle2D(pts2d);
    if (circ.r >= srDesign) {
      throw new Error(`轮廓圆半径 r=${(circ.r * 1000).toFixed(1)}mm ≥ SR=${(srDesign * 1000).toFixed(1)}mm — ` +
        '该 SR 球面不可能切出此圆, 疑 SR 设计值错误或坐标系/单位错 (供应商 mm 未转 m?)');
    }
    // n̂ 定向: 指向眼点一侧 (帽凸向眼点); 球心在背面 → C = O − h·n̂
    let nHat = plane.normal;
    const eyeRel = vec3Dot(vec3Sub(eye, plane.centroid), nHat);
    if (eyeRel < 0) nHat = vec3Scale(nHat, -1);
    if (Math.abs(eyeRel) < 0.01) warnings.push('眼点距轮廓平面 <10mm, 球前/球背定侧不可靠');
    const h = Math.sqrt(srDesign * srDesign - circ.r * circ.r);
    const O3 = vec3Add(plane.centroid, vec3Add(vec3Scale(plane.u, circ.cx), vec3Scale(plane.v, circ.cy)));
    const center = vec3Sub(O3, vec3Scale(nHat, h));
    // 拟合残差: 各点到球 (C, srDesign) 的距离偏差
    let sq = 0;
    for (const p of points) { const dv = vec3Norm(vec3Sub(p, center)) - srDesign; sq += dv * dv; }
    return withCrossCheck({
      center, method: 'planar-cut', radius: srDesign,
      fitResidualMm: Math.sqrt(sq / points.length) * 1000,
      circleRadius: circ.r, planeNormal: nHat, warnings,
    });
  }

  // ── A. 非共面轮廓: 代数球拟合 (等距定球心, 与 SR 无关) ──
  const gen = fitSphereGeneral(points);
  if (Number.isFinite(srDesign) && srDesign > 0) {
    const devMm = Math.abs(gen.radius - srDesign) * 1000;
    if (devMm > 10) warnings.push(`拟合半径与 SR 设计值偏差 ${devMm.toFixed(1)}mm — 疑轮廓点不在设计球面 (选到壳体?)`);
  } else {
    warnings.push('未提供 srDesign, 拟合半径即采用值 (无法与设计值交叉核对)');
  }
  if (gen.residualMm > 1) warnings.push(`轮廓点球面度偏差 RMS=${gen.residualMm.toFixed(2)}mm — 点可能不在同一球面`);
  return withCrossCheck({
    center: gen.center, method: 'general', radius: gen.radius,
    fitResidualMm: gen.residualMm, circleRadius: null, planeNormal: null, warnings,
  });
}

/**
 * 一致性闸门: 轮廓点是否在指定球面 (center, radius) 上?
 * 用于"拿到供应商球心 + 供应商轮廓"时 — 进引擎前先验自洽。不一致的常见原因:
 * 轮廓选到壳体(不在镜片球面) / 球心与轮廓来自不同版本数据 / 坐标系或单位错。
 * 注意: 本闸门通过 ≠ 数据全对 — planar-cut 盲区 (SR 错 → 球心平移, 点仍恰在球面上)
 * 需配合 sphereCenterDeviation / crossCheck 才能发现。
 * @param {number[][]} outline - 轮廓点 (整车坐标 m)
 * @param {number[]} center - 球心 (m)
 * @param {number} radius - 球半径 (m)
 * @param {number} [tolMm=1.0] - 单点偏差容差 (mm)
 * @returns {{maxDevMm:number, rmsDevMm:number, ok:boolean, devsMm:number[]}}
 *   devsMm = |P−center| − radius 的逐点带符号偏差 (正 = 点在球面外)
 */
function validateOutlineOnSphere(outline, center, radius, tolMm = 1.0) {
  validatePoints(outline, 3);
  if (!Array.isArray(center) || center.length < 3 || !center.every(Number.isFinite)) throw new Error('球心非法');
  if (!Number.isFinite(radius) || radius <= 0) throw new Error('半径必须为正有限数');
  const devsMm = outline.map(p => (vec3Norm(vec3Sub(p, center)) - radius) * 1000);
  const maxDevMm = Math.max(...devsMm.map(Math.abs));
  const rmsDevMm = Math.sqrt(devsMm.reduce((s, d) => s + d * d, 0) / devsMm.length);
  return { maxDevMm, rmsDevMm, ok: maxDevMm <= tolMm, devsMm };
}

/**
 * 轮廓点径向投影到指定球面 — 校核用 srVerify 建模:
 * 保持球心 C 与轮廓角范围不变, 把设计面 (srDesign) 上的点推到 srVerify 球面
 * @returns {number[][]} 投影后点 (每点距 center 恰为 radius)
 */
function projectToSphere(points, center, radius) {
  if (!Array.isArray(center) || center.length < 3 || !center.every(Number.isFinite)) throw new Error('球心非法');
  if (!Number.isFinite(radius) || radius <= 0) throw new Error('半径必须为正有限数');
  return points.map(p => {
    const d = vec3Sub(p, center);
    if (vec3Norm(d) < 1e-9) throw new Error('轮廓点与球心重合, 无法投影');
    return vec3Add(center, vec3Scale(vec3Normalize(d), radius));
  });
}

/** 两球心偏差 (mm) — 供供应商提供球心时交叉校核 */
function sphereCenterDeviation(a, b) {
  return vec3Norm(vec3Sub(a, b)) * 1000;
}

module.exports = {
  fitPlane, fitCircle2D, fitSphereGeneral, fitSphereFromOutline,
  validateOutlineOnSphere, projectToSphere, sphereCenterDeviation,
};
