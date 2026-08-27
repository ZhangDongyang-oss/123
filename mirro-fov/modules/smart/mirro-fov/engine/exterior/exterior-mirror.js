/**
 * 外后视镜视野校核 — 凸球面镜 (GB 15084-2022 II/III 类, 先做左外 LHD)
 *
 * 与内后视镜 (平面镜 + 五线法) 是另一套建模:
 *   - 镜面: 凸球面 (SR 依车型), 非矩形边界
 *   - 旋转: 绕转向器轴线 (非球铰 pivot)
 *   - 法规区: 地面两个三角形区域 (III 类: 近 1m@眼后4m, 远 4m@眼后20m; 数值可被 regulation 覆盖)
 *   - 判据: 边界线可见 — 三角形三条边界线经镜面反射后全部可被中心眼看到 → PASS
 *
 * 数学依据: ../Mirro-fov/docs/exterior_mirror.md (人工校核流程 + 建模要点)
 * 坐标: 整车坐标系 (X+=后方, Y+=乘客右, Z+=上), 长度 m, 角度输入度 (内部弧度)。
 */
const { vec3Add, vec3Sub, vec3Scale, vec3Dot, vec3Cross, vec3Norm, vec3Normalize, rotatePointAroundAxis } = require('../shared/geometry');
const { raySphereIntersect, sphereReflectDir } = require('./spherical');
const { Ground, rayPlaneIntersect } = require('../shared/plane');
const { pointInPolygon2D, edgeDistanceTo } = require('../shared/polygon');

const DEG = Math.PI / 180;

// ─── DoorPanel: 车门板外沿 (外镜法规参照面) ───
class DoorPanel {
  /**
   * @param {number} doorOuterY - 驾驶员侧车门最外点 Y (整车坐标, m; LHD 为负值)
   */
  constructor(doorOuterY) {
    if (!Number.isFinite(doorOuterY)) throw new Error(`door_outer_Y 必须为有限数: ${doorOuterY}`);
    this.doorOuterY = doorOuterY;
  }
}

// ─── ExteriorMirror: 凸球面外后视镜 ───
class ExteriorMirror {
  /**
   * @param {Object} opts
   * @param {number} opts.radius - 球面曲率半径 SR (m)
   * @param {number[]} opts.sphereCenter - 球心 (整车坐标, m; 凸球球心在镜面后方 R 处)
   * @param {number[][]} opts.outline - 反射面边界点 (N≥4, 在球面上, 整车坐标 m; CATIA 手动标)
   * @param {number[]} opts.turretAxisPoint - 转向器轴线过点 (整车坐标 m)
   * @param {number[]} opts.turretAxisDir - 转向器轴线方向 (上下调节轴, rotation_axis_dir)
   * @param {number[]} [opts.foldAxisDir] - 折叠轴方向 (左右调节轴, fold_axis_dir; 缺省 null → 单轴向后兼容)
   */
  constructor({ radius, sphereCenter, outline, turretAxisPoint, turretAxisDir, foldAxisDir }) {
    const fin = v => Array.isArray(v) && v.length >= 3 && v.every(Number.isFinite);
    if (!Number.isFinite(radius) || radius <= 0) throw new Error(`球面半径必须为正有限数: ${radius}`);
    if (!fin(sphereCenter)) throw new Error('sphereCenter 非法');
    if (!Array.isArray(outline) || outline.length < 4 || !outline.every(fin)) throw new Error('outline 必须为 (N≥4,3) 且全有限');
    if (!fin(turretAxisPoint) || !fin(turretAxisDir) || vec3Norm(turretAxisDir) < 1e-12) throw new Error('转向器轴线非法');

    this.radius = radius;
    this.sphereCenter = sphereCenter.slice();
    this.outline = outline.map(p => p.slice());
    this.turretAxisPoint = turretAxisPoint.slice();
    this.turretAxisDir = vec3Normalize(turretAxisDir);
    // 折叠轴 (左右调节轴): 缺省 null → 完全退化为单轴 (rotated2D 退化为 rotated, 向后兼容)
    this.foldAxisDir = (foldAxisDir && fin(foldAxisDir) && vec3Norm(foldAxisDir) > 1e-12) ? vec3Normalize(foldAxisDir) : null;

    // 派生: 帽面中心 = C + R·normalize(mean(outline) − C)
    const mean = [0, 0, 0];
    for (const p of outline) { mean[0] += p[0]; mean[1] += p[1]; mean[2] += p[2]; }
    mean[0] /= outline.length; mean[1] /= outline.length; mean[2] /= outline.length;
    const nCand = vec3Normalize(vec3Sub(mean, this.sphereCenter));
    this.capCenter = vec3Add(this.sphereCenter, vec3Scale(nCand, this.radius));

    // 面外法线 (帽面中心 → 球心)
    this.nHat = vec3Normalize(vec3Sub(this.capCenter, this.sphereCenter));

    // upVec = 世界 Z (竖直) 投影到切平面 → 镜面"上"方向 (2D 投影图正立);
    // 旋转轴 Y 是横向的(上下翻转), 不能当"上"。nHat ∥ Z 退化用 +Y。
    const zAxis = [0, 0, 1];
    let up = vec3Sub(zAxis, vec3Scale(this.nHat, vec3Dot(zAxis, this.nHat)));
    if (vec3Norm(up) < 1e-9) up = [0, 1, 0];
    this.upVec = vec3Normalize(up);
    // rightVec = upVec × nHat (横向, 与 up/nHat 正交)
    this.rightVec = vec3Normalize(vec3Cross(this.upVec, this.nHat));

    // 局部切平面坐标 (mm) — 供 onReflectiveSurface / boundaryDistance
    this.outlineUV = outline.map(p => this.localUV(p));
  }

  /** 球面点 → 局部切平面坐标 [u,v] (mm, 相对 capCenter, 弦长近似弧长) */
  localUV(P) {
    const off = vec3Sub(P, this.capCenter);
    return [vec3Dot(off, this.rightVec) * 1000, vec3Dot(off, this.upVec) * 1000];
  }

  /** 局部坐标 (u,v) 是否在反射面内 (NaN 防御 + 非凸多边形判定) */
  onReflectiveSurface(u, v) {
    if (!Number.isFinite(u) || !Number.isFinite(v)) return false;
    return pointInPolygon2D([u, v], this.outlineUV);
  }

  /** 局部点到反射面边界的最短距离 (mm) — 安全距离 >3mm 判据用 */
  boundaryDistanceMm(u, v) {
    if (!Number.isFinite(u) || !Number.isFinite(v)) return NaN;
    const uv = this.outlineUV;
    let best = Infinity;
    for (let i = 0; i < uv.length; i++) {
      const j = (i + 1) % uv.length;
      const d = edgeDistanceTo(u, v, uv[i][0], uv[i][1], uv[j][0], uv[j][1]);
      if (d.dist < best) best = d.dist;
    }
    return best;
  }

  /** outline 中 Z 最大点 (3D) — 作地面三角形顶点 (文档 §3.4) */
  maxZPoint() {
    let mz = null;
    for (const p of this.outline) {
      if (mz === null || p[2] > mz[2]) mz = p;
    }
    return mz.slice();
  }

  /** 对 outline 每条边弦长等分, 中点回投球面 (球面插值) */
  sampleBoundary(K = 20) {
    const pts = [];
    const n = this.outline.length;
    for (let i = 0; i < n; i++) {
      const a = this.outline[i], b = this.outline[(i + 1) % n];
      for (let k = 1; k < K; k++) {
        const t = k / K;
        const lin = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
        const dir = vec3Normalize(vec3Sub(lin, this.sphereCenter));
        pts.push(vec3Add(this.sphereCenter, vec3Scale(dir, this.radius)));
      }
    }
    return pts;
  }

  /** 绕转向器轴线旋转 psiDeg, 返回新实例 (不原地改, 便于 ±3° 网格搜索) */
  rotated(psiDeg) {
    if (!Number.isFinite(psiDeg)) return this;
    const psi = psiDeg * DEG;
    const r = (p) => rotatePointAroundAxis(p, this.turretAxisPoint, this.turretAxisDir, psi);
    if (r === null) return this;
    return new ExteriorMirror({
      radius: this.radius,
      sphereCenter: r(this.sphereCenter),
      outline: this.outline.map(p => r(p)),
      turretAxisPoint: r(this.turretAxisPoint),
      turretAxisDir: this.turretAxisDir, // 轴线是物理基准, 旋转后不变
      foldAxisDir: this.foldAxisDir,
    });
  }

  /**
   * 二维调节: 先绕转向器轴 (turretAxisDir, 上下) 转 psiDeg, 再绕折叠轴 (foldAxisDir, 左右) 转 thetaDeg。
   * 两轴共用原点 turretAxisPoint (物理基准, 不随旋转变)。
   * foldAxisDir 为 null 或 theta=0 时退化为 rotated(psiDeg) (单轴向后兼容)。
   * @returns {ExteriorMirror} 新实例 (不原地改)
   */
  rotated2D(psiDeg, thetaDeg) {
    if (!Number.isFinite(psiDeg)) psiDeg = 0;
    // 退化: 无折叠轴 / theta 非有限 / theta=0 → 单轴
    if (!this.foldAxisDir || !Number.isFinite(thetaDeg) || thetaDeg === 0) {
      return this.rotated(psiDeg);
    }
    const psi = psiDeg * DEG;
    const theta = thetaDeg * DEG;
    const rPsi = (p) => rotatePointAroundAxis(p, this.turretAxisPoint, this.turretAxisDir, psi);
    const rTheta = (p) => rotatePointAroundAxis(p, this.turretAxisPoint, this.foldAxisDir, theta);
    const compose = (p) => { const a = rPsi(p); return a === null ? null : rTheta(a); };
    const c = compose(this.sphereCenter);
    const o = this.outline.map(p => compose(p));
    if (c === null || o.some(p => p === null)) return this.rotated(psiDeg);
    return new ExteriorMirror({
      radius: this.radius,
      sphereCenter: c,
      outline: o,
      turretAxisPoint: this.turretAxisPoint, // 轴共用原点, 绕自身轴不变
      turretAxisDir: this.turretAxisDir,     // 轴线是物理基准, 旋转后不变
      foldAxisDir: this.foldAxisDir,
    });
  }
}

/**
 * 反射点解算 (反问题): 地面目标点 Q 对应镜面上哪些反射点 P?
 *
 * 由对称性, E(眼点)、C(球心)、Q(目标) 与反射点 P 共面 (球法线过 C),
 * 问题降为 EQC 平面内 1 元方程。平面基:
 *   qHat = normalize(Q−C);  uHat = normalize(e − qHat·(e·qHat)), e = E−C
 * 帽面点 P(θ) = C + R·(cosθ·qHat + sinθ·uHat), 帽面法线 n̂(θ) = cosθ·qHat + sinθ·uHat
 * 反射定律 ⟺ i + r ∥ n̂ (i=normalize(E−P), r=normalize(Q−P)) ⟺ cross2D(i+r, n̂)=0
 *
 * 求根方式: 全球面扫描 f(θ) 变号区间 (0.5° 步长), 每个变号区间内二分。
 * 不用 outline 投影角作 bracket — 帽面可能在 qHat 反方向, atan2 投影角跨越 ±180°,
 * 端点同号会误判"无变号"而漏掉真实解 (环绕 bug)。反射点是否在帽面内由上层
 * onReflectiveSurface 判定, 此处只做纯几何解算。
 * @param {number[]} eye - 眼点 (3,)
 * @param {number[]} Q - 地面目标点 (3,)
 * @param {ExteriorMirror} mirror
 * @returns {Array<{point:number[], angle:number}>} 所有数学根的反射点数组 (可为空)
 */
function findMirrorPointsForTarget(eye, Q, mirror) {
  const C = mirror.sphereCenter, R = mirror.radius;
  if (!eye.every(Number.isFinite) || !Q.every(Number.isFinite)) return [];

  const e = vec3Sub(eye, C);
  const qVec = vec3Sub(Q, C);
  const qHat = vec3Normalize(qVec);
  if (vec3Norm(qHat) < 1e-12) return []; // Q === C
  let uHat = vec3Sub(e, vec3Scale(qHat, vec3Dot(e, qHat)));
  if (vec3Norm(uHat) < 1e-12) return []; // e ∥ qHat 退化
  uHat = vec3Normalize(uHat);

  // e 与 Q−C 在基 (qHat, uHat) 中的分量
  const qc = vec3Dot(e, qHat), uc = vec3Dot(e, uHat);       // E 分量
  const qQ = vec3Dot(qVec, qHat);                            // Q−C 沿 qHat = |Q−C|

  // f(θ) = cross2D(i + r, n̂) = (i_q+r_q)·sinθ − (i_u+r_u)·cosθ
  function f(theta) {
    const cp = Math.cos(theta), sp = Math.sin(theta);
    const i_q = qc - R * cp, i_u = uc - R * sp;             // E − P (离开 P 方向)
    const iLen = Math.hypot(i_q, i_u);
    const r_q = qQ - R * cp, r_u = -R * sp;                 // Q − P
    const rLen = Math.hypot(r_q, r_u);
    if (iLen < 1e-12 || rLen < 1e-12) return NaN;
    return (i_q / iLen + r_q / rLen) * sp - (i_u / iLen + r_u / rLen) * cp;
  }

  // 全球面扫描变号区间 (0.5° 步长) → 每个区间二分求根
  const roots = [];
  const N = 720, step = 2 * Math.PI / N;
  let prev = f(-Math.PI), prevAng = -Math.PI;
  for (let i = 1; i <= N; i++) {
    const ang = -Math.PI + i * step;
    const val = f(ang);
    if (Number.isFinite(val) && Number.isFinite(prev) && prev * val < 0) {
      let a = prevAng, b = ang, fa = prev;
      for (let k = 0; k < 60; k++) {
        const mid = (a + b) / 2, fm = f(mid);
        if (Math.abs(fm) < 1e-10) { a = b = mid; break; }
        if (fa * fm < 0) b = mid; else { a = mid; fa = fm; }
      }
      const theta = (a + b) / 2;
      const dir = [Math.cos(theta) * qHat[0] + Math.sin(theta) * uHat[0],
                   Math.cos(theta) * qHat[1] + Math.sin(theta) * uHat[1],
                   Math.cos(theta) * qHat[2] + Math.sin(theta) * uHat[2]];
      roots.push({ point: vec3Add(C, vec3Scale(dir, R)), angle: theta });
    }
    prev = val; prevAng = ang;
  }
  return roots;
}

/** 便捷版: 第一个数学根 (供测试/上层直接用) */
function findMirrorPointForTarget(eye, Q, mirror) {
  const pts = findMirrorPointsForTarget(eye, Q, mirror);
  return pts.length ? pts[0] : null;
}

/**
 * 地面三角形构造 — GB 15084-2022 III 类外后视镜视野
 *   远区: 4m 宽水平道路, 从眼点后 20m 延伸至地平线 (法规条款: "4m 宽…眼点后 20m…")
 *   近区: 1m 宽路面, 从两眼点垂面后方 4m 开始 (法规条款: "1m 宽…垂面后方 4m…")
 * 数值可被 regulation 覆盖 (dist_near/width_near/dist_far/width_far, 与数据 schema 一致);
 * 缺省即 III 类 (4/1/20/4), 向后兼容。
 * 顶点: A=门板外沿侧 (door_outer_Y), B=向外 (LHD=−Y), T=镜面 Z 最高点沿 X 投影 (文档 §3.4)
 */
function buildTriangles(eye, doorOuterY, ground, mirror, regulation = {}) {
  if (!eye.every(Number.isFinite) || !Number.isFinite(doorOuterY)) return [];
  const maxZ = mirror.maxZPoint();
  const distNear  = regulation.dist_near  ?? 4;
  const widthNear = regulation.width_near ?? 1;
  const distFar   = regulation.dist_far   ?? 20;
  const widthFar  = regulation.width_far  ?? 4;
  const specs = [
    { name: 'near', xRef: eye[0] + distNear, w: widthNear },
    { name: 'far', xRef: eye[0] + distFar, w: widthFar },
  ];
  // 外向 = 远离车身中心: 左镜 doorOuterY<0 → −Y, 右镜 doorOuterY>0 → +Y
  const outward = doorOuterY >= 0 ? 1 : -1;
  return specs.map(({ name, xRef, w }) => {
    const zG = ground.zAtX(xRef);
    const A = [xRef, doorOuterY, zG];
    const B = [xRef, doorOuterY + outward * w, zG];
    const T = [xRef, maxZ[1], maxZ[2]];
    return { name, xRef, w, vertices: [A, B, T] };
  });
}

/**
 * 单点可见性判定: 目标 Q 是否经镜面反射可见
 * @param {number[]|{left:number[],right:number[]}} eye - 单眼 [x,y,z] (退化双眼) 或 {left,right} 双眼
 * @param {number[]} q - 地面目标点 (3,)
 * @param {ExteriorMirror} mirror
 * @param {number} minMarginMm - 反射点距镜片边缘最小安全距离 (法规 3mm)
 * @param {number} [profileTolMm=0.3] - 镜片轮廓度 (加工误差, mm, 对称 ±): 在面但距边 < 此值 → 判「可能超出加工边界」
 * @returns {{visible:boolean, reason?:string, u?:number, v?:number, d?:number}}
 *
 * 双眼判据 = 交集 (GB 15084): 两眼都必须有合格反射点 (on-surface + margin) Q 才可见。
 * 单眼输入退化为单眼判定 (= 旧行为, 测试兼容)。
 * 失败细分: 在面但 margin 不足 → 'margin'(安全距离不足) / 'profile'(距边 < 轮廓度, 可能超出加工边界); 全不在面 → 'off-surface'。
 */
function sampleVisibility(eye, q, mirror, minMarginMm, profileTolMm = 0.3) {
  const eyes = Array.isArray(eye) ? [eye] : [eye.left, eye.right];
  if (eyes.some(e => !e.every(Number.isFinite)) || !q.every(Number.isFinite)) return { visible: false, reason: 'non-finite' };
  let marginAcc = undefined; // 双眼各合格点 margin, 取最小
  for (const e of eyes) {
    const pts = findMirrorPointsForTarget(e, q, mirror);
    if (!pts.length) return { visible: false, reason: 'no-solution' };
    // 该眼找一个在镜面内 + margin 合格的反射点; 同时记录距边最小的在面点 (分类/显示用最坏 margin)
    let good = null, minOnSurface = null;
    for (const { point } of pts) {
      const [u, v] = mirror.localUV(point);
      if (!Number.isFinite(u) || !Number.isFinite(v)) continue;
      if (!mirror.onReflectiveSurface(u, v)) continue;
      const d = mirror.boundaryDistanceMm(u, v);
      if (!minOnSurface || (Number.isFinite(d) && d < minOnSurface.d)) minOnSurface = { u, v, d };
      if (Number.isFinite(d) && d >= minMarginMm) { good = { u, v, d }; break; }
    }
    if (!good) {
      // 该眼无合格点: 在面但距边 < 轮廓度 → profile(可能超出加工边界); 否则 margin(安全距离不足); 全不在面 → off-surface
      if (minOnSurface) {
        const reason = Number.isFinite(minOnSurface.d) && minOnSurface.d < profileTolMm ? 'profile' : 'margin';
        return { visible: false, reason, ...minOnSurface };
      }
      const [u0, v0] = mirror.localUV(pts[0].point);
      return { visible: false, reason: 'off-surface', u: u0, v: v0 };
    }
    // 记录该眼合格点的最小 margin (供前端显示安全距离)
    if (marginAcc === undefined) marginAcc = good.d;
    else if (good.d < marginAcc) marginAcc = good.d;
  }
  return marginAcc !== undefined ? { visible: true, d: marginAcc } : { visible: true };
}

/** 单边采样判定: 线段上 N 内点 + 两端点全部可见 → pass */
function checkEdge(edge, eye, mirror, samplePerEdge, minMarginMm, profileTolMm) {
  const samples = [];
  const pts = [edge.a, edge.b];
  for (let k = 0; k < samplePerEdge; k++) {
    const t = (k + 1) / (samplePerEdge + 1);
    pts.push([edge.a[0] + (edge.b[0] - edge.a[0]) * t,
              edge.a[1] + (edge.b[1] - edge.a[1]) * t,
              edge.a[2] + (edge.b[2] - edge.a[2]) * t]);
  }
  let allVisible = true;
  for (const q of pts) {
    const s = sampleVisibility(eye, q, mirror, minMarginMm, profileTolMm);
    samples.push(s);
    if (!s.visible) allVisible = false;
  }
  return { pass: allVisible, samples };
}

/** 单三角形判定: 三边 (AB/BT/TA) 全可见 → pass */
function checkTriangle(tri, eye, mirror, samplePerEdge, minMarginMm, profileTolMm) {
  const [A, B, T] = tri.vertices;
  const edges = [
    { name: 'AB', a: A, b: B },
    { name: 'BT', a: B, b: T },
    { name: 'TA', a: T, b: A },
  ].map(e => ({ name: e.name, ...checkEdge(e, eye, mirror, samplePerEdge, minMarginMm, profileTolMm) }));
  const pass = edges.every(r => r.pass);
  return { pass, edges };
}

/** 附带报告项: 镜面边界反射到地面的落点环 (不参与判定) */
function reflectLandingSamples(mirror, eye, ground) {
  const C = mirror.sphereCenter, R = mirror.radius;
  const landings = [];
  for (const P of mirror.sampleBoundary(20)) {
    const d = vec3Normalize(vec3Sub(P, eye));
    if (vec3Norm(d) < 1e-12) continue;
    const hit = raySphereIntersect(eye, d, C, R);
    if (!hit) continue;
    const r = sphereReflectDir(d, hit.point, C);
    if (!r) continue;
    const gp = [ground.ref_x, 0, ground.ref_z];
    const L = rayPlaneIntersect(hit.point, r, gp, ground.normal());
    if (L && L.every(Number.isFinite)) landings.push(L);
  }
  return landings;
}

/**
 * 外镜校核 — 主入口
 * @param {number[]|{left:number[],right:number[]}} eye - 单眼 [x,y,z] 或 {left,right} 双眼 (交集判据, 见 sampleVisibility)
 * @param {number} doorOuterY - 车门最外点 Y (m)
 * @param {Ground} ground
 * @param {ExteriorMirror} mirror
 * @param {Object} [opts] - { samplePerEdge=20, minMarginMm=3.0, profileTolMm=0.3, regulation={} } (regulation 见 buildTriangles, 缺省 III 类)
 * @returns {{mirrorPass:boolean, near:Object, far:Object, landings:number[][]}}
 */
function verifyExterior(eye, doorOuterY, ground, mirror, opts = {}) {
  const { samplePerEdge = 20, minMarginMm = 3.0, profileTolMm = 0.3, regulation = {} } = opts;
  if (!ground) ground = Ground.horizontal(0.0);
  // 眼点垂面 X (通过两眼点, 两眼 X 相同, 取左眼); 可见性判定用 eye (双眼交集)
  const eyeRef = Array.isArray(eye) ? eye : eye.left;
  const tris = buildTriangles(eyeRef, doorOuterY, ground, mirror, regulation);
  const near = tris[0] ? checkTriangle(tris[0], eye, mirror, samplePerEdge, minMarginMm, profileTolMm) : { pass: false, edges: [] };
  const far = tris[1] ? checkTriangle(tris[1], eye, mirror, samplePerEdge, minMarginMm, profileTolMm) : { pass: false, edges: [] };
  const mirrorPass = near.pass && far.pass;
  const landings = reflectLandingSamples(mirror, eyeRef, ground);
  return { mirrorPass, near, far, landings };
}

/**
 * ±3° 调节搜索: 绕转向器轴线网格扫描, 找使 mirrorPass 的角度。
 * 若 mirrorBase 有折叠轴 (foldAxisDir), 做二维搜索 (psi×theta 各 [-3,3] 步 0.5, 13×13=169 档);
 * 否则退化为单轴 psi 搜索 (向后兼容)。
 * @returns {{found:boolean, bestPsi:number|null, bestTheta:number|null, results:Object[]}}
 */
function searchExteriorAngles(eye, doorOuterY, ground, mirrorBase, opts = {}) {
  const { step = 0.5, range = 3.0, regulation = {} } = opts;
  const results = [];
  let found = false, bestPsi = null, bestTheta = null;
  const push = (m, psi, theta) => {
    const v = verifyExterior(eye, doorOuterY, ground, m, { regulation });
    const r = { psi: Math.round(psi * 100) / 100, mirrorPass: v.mirrorPass, near: v.near.pass, far: v.far.pass };
    if (theta !== undefined && theta !== null) r.theta = Math.round(theta * 100) / 100;
    results.push(r);
    if (v.mirrorPass && !found) { found = true; bestPsi = r.psi; bestTheta = r.theta ?? null; }
  };
  if (mirrorBase.foldAxisDir) {
    // 二维: psi (上下) × theta (左右) 各 ±range, 步 step
    for (let psi = -range; psi <= range + 1e-9; psi += step) {
      for (let theta = -range; theta <= range + 1e-9; theta += step) {
        const m = (psi === 0 && theta === 0) ? mirrorBase : mirrorBase.rotated2D(psi, theta);
        push(m, psi, theta);
      }
    }
  } else {
    // 单轴退化 (向后兼容): 结果项无 theta 字段
    for (let psi = -range; psi <= range + 1e-9; psi += step) {
      const m = psi === 0 ? mirrorBase : mirrorBase.rotated(psi);
      push(m, psi, undefined);
    }
  }
  return { found, bestPsi, bestTheta, results };
}

module.exports = {
  DoorPanel, ExteriorMirror,
  findMirrorPointsForTarget, findMirrorPointForTarget,
  buildTriangles, sampleVisibility, checkEdge, checkTriangle,
  reflectLandingSamples, verifyExterior, searchExteriorAngles,
};
