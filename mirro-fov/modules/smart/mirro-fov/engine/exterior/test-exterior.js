/**
 * 外后视镜 (GB 15084 II/III 类) 引擎测试 — 纯几何构造, 不依赖真实车型
 * 对照 Python 讨论稿 docs/exterior_mirror.md + 本实现设计 (计划文件)
 *
 * 复用 test.js 的 assert/approx 风格, 失败非零退出。
 * 独立运行: node engine/test-exterior.js (不触碰内镜 49 断言)
 */
const { raySphereIntersect, sphereReflectDir } = require('./spherical');
const { rodriguesRotate, rotatePointAroundAxis,
        vec3Add, vec3Sub, vec3Scale, vec3Norm, vec3Normalize, vec3Dot, vec3Cross } = require('../shared/geometry');
const { Ground } = require('../shared/plane');
const { ExteriorMirror, DoorPanel, findMirrorPointForTarget,
        buildTriangles, verifyExterior, searchExteriorAngles, sampleVisibility } = require('./exterior-mirror');

let _fails = 0;
function assert(cond, msg) {
  if (!cond) { console.error(`  ✗ FAIL: ${msg}`); _fails++; }
  else console.log(`  ✓ ${msg}`);
}
function approx(a, b, tol = 0.05) { return Math.abs(a - b) <= tol; }

// ═══ 构造一个合理的外镜 (球心在镜面后方, 帽面朝 −X 稍上) ═══
const R = 1.320;
const C = [2.9, -0.75, 1.55];
const capDir = vec3Normalize([-0.9, -0.1, 0.35]);
const capCenter = vec3Add(C, vec3Scale(capDir, R));
const nHat = vec3Normalize(vec3Sub(capCenter, C));
let up0 = vec3Sub([0, 0, 1], vec3Scale(nHat, vec3Dot([0, 0, 1], nHat)));
if (vec3Norm(up0) < 1e-9) up0 = [0, 1, 0];
const upV = vec3Normalize(up0);
const rightV = vec3Normalize(vec3Cross(upV, nHat));
const HW = 0.125, HH = 0.075;
function corner(sx, sy, scale = 1) {
  // 切平面偏移后回投球面, 确保点在球面上 (弦长近似弧长, 误差 <1%)
  const lin = vec3Add(capCenter, vec3Add(vec3Scale(rightV, sx * HW * scale), vec3Scale(upV, sy * HH * scale)));
  return vec3Add(C, vec3Scale(vec3Normalize(vec3Sub(lin, C)), R));
}
const outline = [corner(1, 1), corner(-1, 1), corner(-1, -1), corner(1, -1)];
function makeMirror(cCenter, axisPoint, axisDir, o = outline) {
  return new ExteriorMirror({ radius: R, sphereCenter: cCenter, outline: o, turretAxisPoint: axisPoint, turretAxisDir: axisDir });
}
const m0 = makeMirror(C, [2.95, -0.75, 1.4], [0, 0, 1]);
// 大帽面 (scale 12, 半高 ~542mm) — 覆盖两三角全部反射点 → PASS (验证聚合逻辑)
const coverMirror = makeMirror(C, [2.95, -0.75, 1.4], [0, 0, 1],
  [corner(1, 1, 12), corner(-1, 1, 12), corner(-1, -1, 12), corner(1, -1, 12)]);

// ======================================================================
// 1. 球面求交 (raySphereIntersect) — 精确闭式解
// ======================================================================
console.log("=== 1. 球面求交 raySphereIntersect ===\n");
// 1.1 正面: 球心 C, 从 [0.36,0,1.5] 沿 +X 打到球面
let hit = raySphereIntersect([0.36, 0, 1.5], [1, 0, 0], [3, 0, 1.5], 1.320);
assert(hit && approx(hit.t, 1.32, 1e-9) && approx(hit.point[0], 1.68, 1e-9), `正面命中 t=1.32 点=[1.68,0,1.5] (得 t=${hit && hit.t.toFixed(4)})`);
// 1.2 掠射 (平行不打到球) → null
assert(raySphereIntersect([0.36, 0, 1.5], [0, 1, 0], [3, 0, 1.5], 1.320) === null, '掠射 (Δ<0) → null');
// 1.3 眼在球心 → 取远根
hit = raySphereIntersect([3, 0, 1.5], [1, 0, 0], [3, 0, 1.5], 1.320);
assert(hit && approx(hit.t, 1.32, 1e-9) && approx(hit.point[0], 4.32, 1e-9), '眼在球心 → 远根 t=1.32 点=[4.32,0,1.5]');
// 1.4 球在身后 → null
assert(raySphereIntersect([5, 0, 1.5], [1, 0, 0], [3, 0, 1.5], 1.320) === null, '球在身后 (两根均负) → null');
// 1.5 NaN 防御
assert(raySphereIntersect([NaN, 0, 1.5], [1, 0, 0], [3, 0, 1.5], 1.320) === null, 'NaN 原点 → null');
assert(raySphereIntersect([0.36, 0, 1.5], [1, 0, 0], [3, 0, 1.5], -1) === null, '负半径 → null');

// ======================================================================
// 2. 球面反射方向 (sphereReflectDir)
// ======================================================================
console.log("\n=== 2. 球面反射方向 sphereReflectDir ===\n");
// 2.1 正面入射 → 正反射
let r = sphereReflectDir([1, 0, 0], [2, 0, 1.5], [3, 0, 1.5]); // n=[-1,0,0]
assert(r && approx(r[0], -1, 1e-9) && approx(r[1], 0, 1e-9) && approx(r[2], 0, 1e-9), '正面入射 n=[-1,0,0] → 反射 [-1,0,0]');
// 2.2 掠射
r = sphereReflectDir([0, 1, 0], [2, 0, 1.5], [3, 0, 1.5]); // n=[-1,0,0], d·n=0 → 反射=入射
assert(r && approx(r[0], 0, 1e-9) && approx(r[1], 1, 1e-9) && approx(r[2], 0, 1e-9), '掠射 d·n=0 → 反射=入射 [0,1,0]');
// 2.3 NaN 防御
assert(sphereReflectDir([NaN, 1, 0], [2, 0, 1.5], [3, 0, 1.5]) === null, 'NaN 入射 → null');

// ======================================================================
// 3. 罗德里格斯旋转
// ======================================================================
console.log("\n=== 3. 罗德里格斯旋转 ===\n");
// 3.1 [1,0,0] 绕 Z 90° → [0,1,0]
let p = rodriguesRotate([1, 0, 0], [0, 0, 1], Math.PI / 2);
assert(approx(p[0], 0, 1e-9) && approx(p[1], 1, 1e-9), '[1,0,0] 绕 Z 90° → [0,1,0]');
// 3.2 绕自身轴 → 不变
p = rodriguesRotate([0, 0, 1], [0, 0, 1], Math.PI / 4);
assert(approx(p[2], 1, 1e-9) && approx(p[0], 0, 1e-9), '[0,0,1] 绕 Z 45° → 不变');
// 3.3 过非原点轴: 点 [2,1,0] 绕过 [1,0,0] 沿 Z 的轴 90° → [0,1,0]
p = rotatePointAroundAxis([2, 1, 0], [1, 0, 0], [0, 0, 1], Math.PI / 2);
assert(approx(p[0], 0, 1e-9) && approx(p[1], 1, 1e-9) && approx(p[2], 0, 1e-9), '绕非原点轴 90° → [0,1,0]');
// 3.4 0° → 恒等
p = rotatePointAroundAxis([2, 1, 0], [1, 0, 0], [0, 0, 1], 0);
assert(approx(p[0], 2, 1e-9) && approx(p[1], 1, 1e-9), '0° → 恒等');
// 3.5 NaN 防御
assert(rodriguesRotate([NaN, 0, 0], [0, 0, 1], 1) === null, 'NaN 向量 → null');
assert(rotatePointAroundAxis([2, 1, 0], [1, 0, 0], [0, 0, 0], 1) === null, '零轴 → null');

// ======================================================================
// 4. ExteriorMirror 类
// ======================================================================
console.log("\n=== 4. ExteriorMirror 类 ===\n");
// 4.1 outline 各点距球心 ≈ R
for (const p of m0.outline) {
  const d = vec3Norm(vec3Sub(p, C));
  assert(approx(d, R, 1e-6), `outline 点 ${p.map(v => v.toFixed(3))} 距球心 ≈ R (得 ${d.toFixed(6)})`);
}
// 4.2 onReflectiveSurface
assert(m0.onReflectiveSurface(0, 0) === true, '(0,0) 在反射面内');
assert(m0.onReflectiveSurface(300, 0) === false, '(300,0) 在反射面外');
assert(m0.onReflectiveSurface(NaN, 0) === false, '(NaN,0) → false (NaN 防御)');
// 4.3 boundaryDistanceMm
assert(approx(m0.boundaryDistanceMm(0, 0), 75, 1), `(0,0) 距边界 ≈ 75mm (得 ${m0.boundaryDistanceMm(0, 0).toFixed(1)})`);
// 4.4 rotated(0) 与零位逐点一致
assert(JSON.stringify(m0.rotated(0).outline) === JSON.stringify(m0.outline), 'rotated(0) 与零位逐点一致');
// 4.5 rotated(90°) 绕 Z: outline 点应在原地转 90° (capCenter 位置可验证绕轴特性)
const m90 = m0.rotated(90);
// 球心绕轴 90° (Z 轴过 [2.95,-0.75,1.4]): [2.9,-0.75,1.55] 绕 [2.95,-0.75,1.4] 转 90°
// 偏移 [-0.05,0,0.15] 绕 Z 90° → [0,-0.05,0.15] → 新球心 [2.95,-0.8,1.55]
assert(approx(m90.sphereCenter[0], 2.95, 1e-6) && approx(m90.sphereCenter[1], -0.80, 1e-6) && approx(m90.sphereCenter[2], 1.55, 1e-6),
  `rotated(90) 球心绕轴转 90° → [2.95,-0.8,1.55] (得 [${m90.sphereCenter.map(v => v.toFixed(3))}])`);
// 4.6 DoorPanel 校验
assert(new DoorPanel(-0.7).doorOuterY === -0.7, 'DoorPanel 构造正常');
try { new DoorPanel(NaN); assert(false, 'DoorPanel 应拒 NaN'); } catch (e) { assert(true, 'DoorPanel 拒 NaN'); }

// 4.7 rotated2D 二维调节 (上下 psi × 左右 theta 复合)
// 折叠轴 [0,1,0] (左右), 与上下轴 [0,0,1] 正交, 同过 turretAxisPoint [2.95,-0.75,1.4]
const mFold = new ExteriorMirror({ radius: R, sphereCenter: C, outline, turretAxisPoint: [2.95, -0.75, 1.4], turretAxisDir: [0, 0, 1], foldAxisDir: [0, 1, 0] });
// theta=0 退化为单轴 rotated(psi)
assert(JSON.stringify(mFold.rotated2D(90, 0).sphereCenter) === JSON.stringify(mFold.rotated(90).sphereCenter),
  'rotated2D(90,0) == rotated(90) (theta=0 退化单轴)');
// 绕左右轴 Y 90°: 偏移 [-0.05,0,0.15] → [0.15,0,0.05] → 球心 [3.10,-0.75,1.45]
const mFoldTheta = mFold.rotated2D(0, 90);
assert(approx(mFoldTheta.sphereCenter[0], 3.10, 1e-6) && approx(mFoldTheta.sphereCenter[1], -0.75, 1e-6) && approx(mFoldTheta.sphereCenter[2], 1.45, 1e-6),
  `rotated2D(0,90) 绕左右轴转 90° → 球心 [3.10,-0.75,1.45] (得 [${mFoldTheta.sphereCenter.map(v => v.toFixed(3))}])`);
// 复合: 先绕 Z(上下) 90° 再绕 Y(左右) 90° → 球心 [3.10,-0.80,1.40]
const mFoldBoth = mFold.rotated2D(90, 90);
assert(approx(mFoldBoth.sphereCenter[0], 3.10, 1e-6) && approx(mFoldBoth.sphereCenter[1], -0.80, 1e-6) && approx(mFoldBoth.sphereCenter[2], 1.40, 1e-6),
  `rotated2D(90,90) 先上下后左右复合 → 球心 [3.10,-0.80,1.40] (得 [${mFoldBoth.sphereCenter.map(v => v.toFixed(3))}])`);
// (0,0) 恒等
assert(JSON.stringify(mFold.rotated2D(0, 0).outline) === JSON.stringify(mFold.outline), 'rotated2D(0,0) 恒等');
// 无折叠轴退化: m0 (foldAxisDir=null) → rotated2D(90,45) == rotated(90)
assert(JSON.stringify(m0.rotated2D(90, 45).sphereCenter) === JSON.stringify(m0.rotated(90).sphereCenter),
  '无折叠轴 rotated2D(90,45) == rotated(90) (fold null 退化)');

// ======================================================================
// 5. 反射点解算 (findMirrorPointForTarget)
// ======================================================================
console.log("\n=== 5. 反射点解算 ===\n");
const E = [3.0, -0.4, 1.4];
const zG = 0.2;
// 5.1 由构造 Q 恰在 P* 反射光上 → 解算返回 P ≈ P*
const Pstar = outline[0];
const dInc = vec3Normalize(vec3Sub(Pstar, E));
const hitP = raySphereIntersect(E, dInc, C, R);
const rDir = sphereReflectDir(dInc, hitP.point, C);
const tQ = (zG - hitP.point[2]) / rDir[2];
const Q = vec3Add(hitP.point, vec3Scale(rDir, tQ));
const res = findMirrorPointForTarget(E, Q, m0);
assert(res !== null, '构造的目标 Q 应有解');
if (res) {
  const err = vec3Norm(vec3Sub(res.point, hitP.point));
  assert(err < 1e-3, `解算 P ≈ 构造 P (误差 ${err.toExponential(2)} m)`);
}
// 5.2 反向: Q 在反射场外 (地面 X 偏移很大) → 解算点 uv 落在镜面外
const QFar = [Q[0] + 50, Q[1], Q[2]];
const resFar = findMirrorPointForTarget(E, QFar, m0);
assert(resFar !== null && !m0.onReflectiveSurface(...m0.localUV(resFar.point)),
  `反射场外目标 → 解算点 uv 在镜外 (onSurface=${resFar && m0.onReflectiveSurface(...m0.localUV(resFar.point))})`);

// ======================================================================
// 6. 地面三角形构造
// ======================================================================
console.log("\n=== 6. 地面三角形构造 ===\n");
const ground = Ground.horizontal(zG);
const tris = buildTriangles(E, -0.7, ground, m0);
const near = tris[0], far = tris[1];
assert(near.name === 'near' && far.name === 'far', '三角形 near/far 存在');
assert(approx(near.vertices[0][0], E[0] + 4, 1e-6) && approx(near.vertices[0][1], -0.7, 1e-6) && approx(near.vertices[0][2], zG, 1e-6), 'near A = [7,-0.7,0.2]');
assert(approx(near.vertices[1][1], -1.7, 1e-6), 'near B (向外 1m) = Y −1.7');
assert(approx(far.vertices[0][0], E[0] + 20, 1e-6) && approx(far.vertices[1][1], -4.7, 1e-6), 'far: X=23, B 向外 4m Y=−4.7');
assert(approx(near.vertices[2][2], m0.maxZPoint()[2], 1e-6), 'near T = 镜面 Z 最高点投影');

// 6.5 III 类 regulation 参数化: dist/width 可被 regulation 覆盖 (缺省即 III 类 4/1/20/4)
const trisReg = buildTriangles(E, -0.7, ground, m0,
  { dist_near: 5, width_near: 2, dist_far: 25, width_far: 6 });
assert(approx(trisReg[0].vertices[0][0], E[0] + 5, 1e-6), 'regulation dist_near=5 → near A.x = eye+5');
assert(approx(trisReg[0].vertices[1][1], -0.7 - 2, 1e-6), 'regulation width_near=2 → near B.y = door−2');
assert(approx(trisReg[1].vertices[0][0], E[0] + 25, 1e-6), 'regulation dist_far=25 → far A.x = eye+25');
assert(approx(trisReg[1].vertices[1][1], -0.7 - 6, 1e-6), 'regulation width_far=6 → far B.y = door−6');
// 6.6 右镜外向: doorOuterY>0 时三角形往 +Y 延伸 (回归: 旧代码硬编码 -Y 致右镜三角形建反)
const trisR = buildTriangles(E, 0.7, ground, m0, {});
assert(approx(trisR[0].vertices[1][1], 0.7 + 1, 1e-6), '右镜 doorY=+0.7 → near B.y = +1.7 (外向 +Y, 非内)');
assert(approx(trisR[1].vertices[1][1], 0.7 + 4, 1e-6), '右镜 doorY=+0.7 → far B.y = +4.7 (外向 +Y)');

// ======================================================================
// 7. PASS/FAIL 端到端
// ======================================================================
console.log("\n=== 7. PASS/FAIL 端到端 ===\n");
// 7.1 大帽面 (scale 12, 覆盖两三角全部反射点) → mirrorPass=true (验证聚合逻辑)
const vCover = verifyExterior(E, -0.7, ground, coverMirror, { samplePerEdge: 8 });
assert(vCover.mirrorPass === true, `大帽面应 PASS (得 mirrorPass=${vCover.mirrorPass})`);
// 7.2 原小帽面 (scale 1, 盖不住远三角) → mirrorPass=false
const vSmall = verifyExterior(E, -0.7, ground, m0, { samplePerEdge: 8 });
assert(vSmall.mirrorPass === false, `原小帽面应 FAIL (得 mirrorPass=${vSmall.mirrorPass})`);
// 7.3 searchExteriorAngles: 大帽面在 ±3° 内应有 PASS
const search = searchExteriorAngles(E, -0.7, ground, coverMirror, { step: 1.0, range: 3.0 });
assert(search.found === true, `大帽面 ±3° 搜索应找到 PASS (bestPsi=${search.bestPsi})`);
assert(search.results.length >= 5, `搜索覆盖 ${search.results.length} 档角度`);
// 7.3b 单轴向后兼容: 无折叠轴 coverMirror → 结果项无 theta 字段, bestTheta=null
assert(search.bestTheta === null, '单轴搜索 bestTheta=null (向后兼容)');
assert(search.results.every(r => r.theta === undefined), '单轴搜索结果项无 theta 字段 (向后兼容)');
// 7.3c 二维搜索: 带折叠轴的大帽面 ±3°×±3° (步 1.0, 7×7=49 档) 找到 PASS
const coverFold = new ExteriorMirror({ radius: R, sphereCenter: C, outline: [corner(1, 1, 12), corner(-1, 1, 12), corner(-1, -1, 12), corner(1, -1, 12)], turretAxisPoint: [2.95, -0.75, 1.4], turretAxisDir: [0, 0, 1], foldAxisDir: [0, 1, 0] });
const search2D = searchExteriorAngles(E, -0.7, ground, coverFold, { step: 1.0, range: 3.0 });
assert(search2D.found === true, `二维 ±3°×±3° 搜索应找到 PASS (bestPsi=${search2D.bestPsi}, bestTheta=${search2D.bestTheta})`);
assert(search2D.results.length === 49, `二维搜索覆盖 ${search2D.results.length} 档 (7×7=49)`);
assert(search2D.bestTheta !== null, `二维搜索 bestTheta 非空 (得 ${search2D.bestTheta})`);
// 7.3d 二维默认步长 0.5 → 13×13=169 档
const search2DFull = searchExteriorAngles(E, -0.7, ground, coverFold, { step: 0.5, range: 3.0 });
assert(search2DFull.results.length === 169, `二维默认步长覆盖 ${search2DFull.results.length} 档 (13×13=169)`);
// 7.4 regulation 透传 plumbing: 传显式 III 类 regulation 与缺省结果一致 (buildTriangles 参数化回归)
const vReg = verifyExterior(E, -0.7, ground, coverMirror,
  { samplePerEdge: 8, regulation: { dist_near: 4, width_near: 1, dist_far: 20, width_far: 4 } });
assert(vReg.mirrorPass === vCover.mirrorPass && vReg.near.pass === vCover.near.pass && vReg.far.pass === vCover.far.pass,
  `显式 III 类 regulation 与缺省结果一致 (mirrorPass=${vReg.mirrorPass})`);
// 7.5 双眼交集: 两眼都必须有合格反射点 (on-surface+margin) 才可见, 比单眼严
const eyeL = [E[0], E[1] - 0.0325, E[2]], eyeR = [E[0], E[1] + 0.0325, E[2]];
// 退化: {left:E, right:E} 应与单眼 E 结果一致
const vDeg = verifyExterior({ left: E, right: E }, -0.7, ground, coverMirror, { samplePerEdge: 8 });
assert(vDeg.mirrorPass === vCover.mirrorPass, '双眼退化 (两眼=E) == 单眼 E');
// 交集严格性: coverMirror 的 near 三角形 T 顶点, 右眼反射点 margin 不足 → 双眼交集 FAIL, 单左眼 OK
const triT = buildTriangles(E, -0.7, ground, coverMirror, {})[0].vertices[2];
assert(sampleVisibility(eyeL, triT, coverMirror, 3.0).visible === true, '双眼交集: T 顶点左眼可见 (单眼 ok)');
assert(sampleVisibility({ left: eyeL, right: eyeR }, triT, coverMirror, 3.0).visible === false,
  '双眼交集: T 顶点右眼 margin 不足 → 交集 FAIL (比单眼严)');

// ======================================================================
// 8. 3mm 安全距离判据 (阈值翻转)
// ======================================================================
console.log("\n=== 8. 3mm 安全距离判据 ===\n");
// 8.1 构造 Q: 从上边中点反射到地面的落点。首个 on-surface 根距边 ≈4.9mm (>3 → visible)
const bEdgeMid = vec3Add(corner(1, 1), vec3Scale(vec3Sub(corner(-1, 1), corner(1, 1)), 0.5)); // 上边中点
const dEdge = vec3Normalize(vec3Sub(bEdgeMid, E));
const hitEdge = raySphereIntersect(E, dEdge, C, R);
const rEdge = sphereReflectDir(dEdge, hitEdge.point, C);
const tEdge = (zG - hitEdge.point[2]) / rEdge[2];
const QEdge = vec3Add(hitEdge.point, vec3Scale(rEdge, tEdge));
const svLo = sampleVisibility(E, QEdge, m0, 3.0);
assert(svLo.visible === true, `QEdge minMargin=3 → visible (首个 on-surface 根 d=${(svLo.d ?? NaN).toFixed(1)}mm > 3)`);
const svHi = sampleVisibility(E, QEdge, m0, 6.0);
assert(svHi.visible === false && svHi.reason === 'margin', `QEdge minMargin=6 → margin (阈值在 3~6mm 翻转)`);
// 8.1b 轮廓度: profileTolMm 大于点距边 → reason 'profile' (距边落在加工不确定带内, 可能超出加工边界)
const svProfile = sampleVisibility(E, QEdge, m0, 6.0, 10.0);
assert(svProfile.visible === false && svProfile.reason === 'profile',
  `QEdge profileTol=10 → profile (距边 d≈${(svProfile.d ?? NaN).toFixed(1)}mm < 10, 落在加工带内)`);
// 8.1c 轮廓度缺省 0.3 → 距边 ≈4.9 > 0.3 仍是 'margin' (不误判)
assert(sampleVisibility(E, QEdge, m0, 6.0).reason === 'margin', 'QEdge 缺省 profileTol=0.3 → margin (不误判为 profile)');
// 8.2 boundaryDistanceMm 边界行为: 上边中点反射点距边 ≈0, 帽心 ≈75
const resEdge = findMirrorPointForTarget(E, QEdge, m0);
if (resEdge) {
  const dOn = m0.boundaryDistanceMm(...m0.localUV(resEdge.point));
  assert(approx(dOn, 0, 5), `边界反射点距边 ≈ 0mm (得 ${dOn.toFixed(2)})`);
}
assert(approx(m0.boundaryDistanceMm(0, 0), 75, 5), `帽心距边 ≈ 75mm (得 ${m0.boundaryDistanceMm(0, 0).toFixed(1)})`);

// ======================================================================
// 9. NaN 端到端
// ======================================================================
console.log("\n=== 9. NaN 端到端 ===\n");
const vNaN = verifyExterior([NaN, -0.4, 1.4], -0.7, ground, coverMirror, { samplePerEdge: 5 });
assert(vNaN.mirrorPass === false, 'eye=[NaN] → mirrorPass=false 不抛异常');
const vNaN2 = verifyExterior(E, NaN, ground, coverMirror, { samplePerEdge: 5 });
assert(vNaN2.mirrorPass === false, 'doorOuterY=NaN → mirrorPass=false 不抛异常');

// ======================================================================
console.log(`\n${_fails === 0 ? '✅ 全部通过' : `❌ ${_fails} 项失败`}`);
process.exit(_fails === 0 ? 0 : 1);
