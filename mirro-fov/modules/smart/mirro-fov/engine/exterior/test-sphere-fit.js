/**
 * 球面拟合测试 (engine/exterior/sphere-fit.js) — 构造已知球心 → 轮廓点 → 拟合回推
 *
 * 覆盖: 非共面 general 路径 / 共面 planar-cut 路径 / 噪声鲁棒性 / 退化防御 /
 *       projectToSphere 投影 / ExteriorMirror 集成 / 供应商球心交叉校核 /
 *       一致性闸门 (轮廓 vs 球心+半径) / planar-cut 盲区 (SR 错 → 静默平移)
 *
 * 复用 test-exterior.js 的 assert/approx 风格, 失败非零退出。
 * 独立运行: node engine/exterior/test-sphere-fit.js
 */
const { fitPlane, fitCircle2D, fitSphereFromOutline, validateOutlineOnSphere,
        projectToSphere, sphereCenterDeviation } = require('./sphere-fit');
const { vec3Add, vec3Sub, vec3Scale, vec3Norm, vec3Normalize, vec3Dot, vec3Cross } = require('../shared/geometry');
const { ExteriorMirror } = require('./exterior-mirror');

let _fails = 0;
function assert(cond, msg) {
  if (!cond) { console.error(`  ✗ FAIL: ${msg}`); _fails++; }
  else console.log(`  ✓ ${msg}`);
}
function approx(a, b, tol = 0.05) { return Math.abs(a - b) <= tol; }
function throws(fn, re, msg) {
  try { fn(); assert(false, `${msg} (未抛异常)`); }
  catch (e) { assert(re.test(String(e.message)), `${msg} (抛: ${e.message.slice(0, 48)}…)`); }
}

// 确定性伪随机 (噪声测试可复现)
let _seed = 42;
function rand01() { _seed = (_seed * 1664525 + 1013904223) >>> 0; return _seed / 4294967296; }
function gauss() { return rand01() + rand01() + rand01() - 1.5; } // σ≈0.5

// ═══ 构造: 已知球心 C0 + 设计 SR=1.26 (供应商设计值), 帽朝 −X 稍上 ═══
const C0 = [2.9, -0.8, 1.5];
const R0 = 1.26;
const capDir = vec3Normalize([-0.9, -0.1, 0.35]);
const up0 = vec3Sub([0, 0, 1], vec3Scale(capDir, vec3Dot([0, 0, 1], capDir)));
const upV = vec3Normalize(up0);
const rightV = vec3Normalize(vec3Cross(upV, capDir));
function spherePoint(offsetU, offsetV, center = C0, r = R0) {
  const dir = vec3Normalize(vec3Add(capDir, vec3Add(vec3Scale(rightV, offsetU), vec3Scale(upV, offsetV))));
  return vec3Add(center, vec3Scale(dir, r));
}

// ── 非共面轮廓: 4 角点等角半径 (共圆) + 1 个近中心点 → 破共面 ──
const outlineNonCoplanar = [
  spherePoint(0.25, 0.15), spherePoint(-0.25, 0.15), spherePoint(-0.25, -0.15),
  spherePoint(0.25, -0.15), spherePoint(0.0, 0.05),
];

// ── 共面轮廓 (平面切割): 切割面法线 m̂, 圆半径 100mm ──
const mHat = vec3Normalize([-0.85, -0.15, 0.4]);
const rCut = 0.10;
const dCut = Math.sqrt(R0 * R0 - rCut * rCut);
const O3 = vec3Add(C0, vec3Scale(mHat, dCut));
let e1 = vec3Normalize(vec3Sub([0, 0, 1], vec3Scale(mHat, mHat[2])));
const e2 = vec3Normalize(vec3Cross(mHat, e1));
const phis = [0, 70, 150, 210, 300].map(d => d * Math.PI / 180); // 非均匀角度
const outlineCoplanar = phis.map(ph =>
  vec3Add(O3, vec3Add(vec3Scale(e1, rCut * Math.cos(ph)), vec3Scale(e2, rCut * Math.sin(ph)))));
const eyePt = vec3Add(vec3Add(C0, vec3Scale(mHat, R0 + 0.5)), [0, -0.05, 0]); // 帽前 0.5m (眼侧)

// ======================================================================
// 1. 共面性检测 (fitPlane)
// ======================================================================
console.log("=== 1. 共面性检测 fitPlane ===\n");
const planeCo = fitPlane(outlineCoplanar);
assert(planeCo.residualMm < 1e-6, `平面切割轮廓 residualMm≈0 (得 ${planeCo.residualMm.toExponential(2)})`);
const planeGen = fitPlane(outlineNonCoplanar);
assert(planeGen.residualMm > 0.5, `非共面轮廓 residualMm=${planeGen.residualMm.toFixed(1)}mm > 0.5 阈值 → 走 general`);

// ======================================================================
// 2. general 路径 (非共面轮廓) — 等距定球心, 与 SR 无关
// ======================================================================
console.log("\n=== 2. general 路径 (非共面) ===\n");
let fit = fitSphereFromOutline(outlineNonCoplanar, {});
assert(fit.method === 'general', `method=general (得 ${fit.method})`);
assert(vec3Norm(vec3Sub(fit.center, C0)) < 1e-8, `无 SR 也能回推球心 误差<1e-8 m (得 ${vec3Norm(vec3Sub(fit.center, C0)).toExponential(2)})`);
assert(approx(fit.radius, R0, 1e-8), `拟合半径=设计 SR ${R0} (得 ${fit.radius.toFixed(6)})`);
assert(fit.fitResidualMm < 1e-6, `点球面度残差≈0 (得 ${fit.fitResidualMm.toExponential(2)}mm)`);
assert(fit.warnings.some(w => /srDesign/.test(w)), '未给 srDesign → 警告提示');

fit = fitSphereFromOutline(outlineNonCoplanar, { srDesign: R0 });
assert(vec3Norm(vec3Sub(fit.center, C0)) < 1e-8, '给正确 srDesign 球心不变');
assert(fit.warnings.length === 0, `srDesign 与拟合一致 → 无警告 (得 ${JSON.stringify(fit.warnings)})`);

fit = fitSphereFromOutline(outlineNonCoplanar, { srDesign: 2.0 });
assert(vec3Norm(vec3Sub(fit.center, C0)) < 1e-8, '错误 srDesign 不影响球心 (等距解与 SR 无关)');
assert(fit.warnings.some(w => /偏差/.test(w)), '错误 srDesign → 半径偏差警告');

// ======================================================================
// 3. planar-cut 路径 (共面轮廓) — 面内圆 + SR 偏移 + 眼点定侧
// ======================================================================
console.log("\n=== 3. planar-cut 路径 (共面) ===\n");
fit = fitSphereFromOutline(outlineCoplanar, { srDesign: R0, eye: eyePt });
assert(fit.method === 'planar-cut', `method=planar-cut (得 ${fit.method})`);
assert(vec3Norm(vec3Sub(fit.center, C0)) < 1e-8, `共面轮廓回推球心 误差<1e-8 m (得 ${vec3Norm(vec3Sub(fit.center, C0)).toExponential(2)})`);
assert(approx(fit.circleRadius, rCut, 1e-9), `轮廓圆半径=${rCut * 1000}mm (得 ${(fit.circleRadius * 1000).toFixed(3)})`);
assert(vec3Dot(fit.planeNormal, mHat) > 0.999, 'planeNormal 指向眼点一侧');
assert(fit.fitResidualMm < 1e-6, `点球面度残差≈0 (得 ${fit.fitResidualMm.toExponential(2)}mm)`);

// 缺参防御
throws(() => fitSphereFromOutline(outlineCoplanar, { eye: eyePt }), /SR/, '共面缺 srDesign → 抛错');
throws(() => fitSphereFromOutline(outlineCoplanar, { srDesign: R0 }), /眼点/, '共面缺眼点 → 抛错');
throws(() => fitSphereFromOutline(outlineCoplanar, { srDesign: 0.09, eye: eyePt }), /SR/, 'r ≥ SR 不可能 → 抛错');

// ======================================================================
// 4. 噪声鲁棒性 (σ=0.05mm, CAD 采点量级)
// ======================================================================
console.log("\n=== 4. 噪声鲁棒性 ===\n");
function withNoise(pts) {
  return pts.map(p => [p[0] + gauss() * 1e-4, p[1] + gauss() * 1e-4, p[2] + gauss() * 1e-4]);
}
fit = fitSphereFromOutline(withNoise(outlineCoplanar), { srDesign: R0, eye: eyePt });
let errMm = vec3Norm(vec3Sub(fit.center, C0)) * 1000;
assert(errMm < 1, `共面+噪声 球心误差 ${errMm.toFixed(3)}mm < 1mm`);
assert(fit.fitResidualMm < 0.5, `共面+噪声 残差 ${fit.fitResidualMm.toFixed(3)}mm < 0.5mm`);
fit = fitSphereFromOutline(withNoise(outlineNonCoplanar), { srDesign: R0 });
errMm = vec3Norm(vec3Sub(fit.center, C0)) * 1000;
assert(errMm < 1, `非共面+噪声 球心误差 ${errMm.toFixed(3)}mm < 1mm`);

// ======================================================================
// 5. 退化防御
// ======================================================================
console.log("\n=== 5. 退化防御 ===\n");
const line = [0, 1, 2, 3, 4].map(t => [1 + 0.05 * t, 2, 1.5]);
throws(() => fitSphereFromOutline(line, { srDesign: R0, eye: eyePt }), /共线/, '5 点共线 → 抛错');
throws(() => fitSphereFromOutline(outlineCoplanar.slice(0, 3), { srDesign: R0, eye: eyePt }), /至少 4/, 'N<4 → 抛错');
throws(() => fitSphereFromOutline([[NaN, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]]), /有限/, 'NaN 点 → 抛错');

// ======================================================================
// 6. projectToSphere — 设计面(1.26) → 校核面(1.32) 径向投影
// ======================================================================
console.log("\n=== 6. projectToSphere ===\n");
const R_VERIFY = 1.32; // srVerify = 设计 1.26 + 公差上限 0.06
const proj = projectToSphere(outlineCoplanar, C0, R_VERIFY);
assert(proj.every(p => approx(vec3Norm(vec3Sub(p, C0)), R_VERIFY, 1e-12)), '投影后所有点距球心 = 1.32');
assert(proj.every((p, i) =>
  vec3Dot(vec3Normalize(vec3Sub(p, C0)), vec3Normalize(vec3Sub(outlineCoplanar[i], C0))) > 1 - 1e-12),
  '投影保持径向方向不变 (角范围不变)');
throws(() => projectToSphere([C0], C0, R_VERIFY), /重合/, '点与球心重合 → 抛错');

// ======================================================================
// 7. 集成: 拟合 → 投影 → ExteriorMirror 构造
// ======================================================================
console.log("\n=== 7. 集成 ExteriorMirror ===\n");
const fitReal = fitSphereFromOutline(outlineNonCoplanar, { srDesign: R0 });
const projOutline = projectToSphere(outlineNonCoplanar, fitReal.center, R_VERIFY);
const mirror = new ExteriorMirror({
  radius: R_VERIFY, sphereCenter: fitReal.center, outline: projOutline,
  turretAxisPoint: [2.95, -0.8, 1.4], turretAxisDir: [0, 0, 1],
});
assert(mirror.onReflectiveSurface(0, 0), '拟合+投影后的镜面: 帽中心 (0,0) 在反射面内');
assert(mirror.boundaryDistanceMm(0, 0) > 10, `帽中心距边界 ${(mirror.boundaryDistanceMm(0, 0)).toFixed(1)}mm > 10mm`);
assert(projOutline.every(p => approx(vec3Norm(vec3Sub(p, fitReal.center)), R_VERIFY, 1e-9)),
  '构造后轮廓点在 srVerify 球面上');

// ======================================================================
// 8. 供应商球心交叉校核 (sphereCenterDeviation)
// ======================================================================
console.log("\n=== 8. 供应商球心交叉校核 ===\n");
assert(approx(sphereCenterDeviation(C0, C0), 0, 1e-9), '同点球心偏差 = 0mm');
assert(approx(sphereCenterDeviation(C0, vec3Add(C0, [0.05, 0, 0])), 50, 1e-9), '50mm 偏移 → 50mm 偏差');
const supplierBallCenter = vec3Add(fitReal.center, [0.001, 0, 0]); // 模拟供应商值偏 1mm
assert(sphereCenterDeviation(fitReal.center, supplierBallCenter) < 5, '供应商球心偏 1mm < 5mm 容差 → 校核通过');

// ======================================================================
// 9. 一致性闸门 validateOutlineOnSphere — 轮廓点在不在球心定义的球面上?
// ======================================================================
console.log("\n=== 9. 一致性闸门 (轮廓 vs 球心+半径) ===\n");
let gate = validateOutlineOnSphere(outlineCoplanar, C0, R0);
assert(gate.ok && gate.maxDevMm < 1e-6, `自洽数据: 轮廓在球面上 maxDev≈0 (得 ${gate.maxDevMm.toExponential(2)}mm)`);
// 轮廓点径向偏移 2mm (模拟选到壳体/错层) → 闸门拦截
const offOutline = outlineCoplanar.map(p => vec3Add(p, vec3Scale(vec3Normalize(vec3Sub(p, C0)), 0.002)));
gate = validateOutlineOnSphere(offOutline, C0, R0);
assert(!gate.ok && approx(gate.maxDevMm, 2, 0.01), `轮廓偏出球面 2mm → 闸门拦截 (maxDev=${gate.maxDevMm.toFixed(2)}mm)`);
assert(gate.devsMm.every(d => d > 0), 'devsMm 带符号: 偏外为正');
throws(() => validateOutlineOnSphere(outlineCoplanar, [NaN, 0, 0], R0), /球心/, 'NaN 球心 → 抛错');

// ======================================================================
// 10. planar-cut 盲区 — SR 错 → 球心静默平移, 残差恒 0, 靠供应商球心校核兜底
// ======================================================================
console.log("\n=== 10. planar-cut 盲区 (SR 错误的静默平移) ===\n");
// outlineCoplanar 由 (C0, R0=1.26) 构造; 故意用错误 SR=1.32 拟合
fit = fitSphereFromOutline(outlineCoplanar, { srDesign: 1.32, eye: eyePt });
assert(fit.fitResidualMm < 1e-6, `盲区证实: SR 错 60mm, 拟合残差仍≈0 (得 ${fit.fitResidualMm.toExponential(2)}mm)`);
const shiftMm = vec3Norm(vec3Sub(fit.center, C0)) * 1000;
assert(approx(shiftMm, 60.2, 1.5), `盲区代价: 球心沿面法线静默平移 ${shiftMm.toFixed(1)}mm ≈ Δh`);
gate = validateOutlineOnSphere(outlineCoplanar, fit.center, 1.32);
assert(gate.ok, '闸门单独不够: 点恰在 (C_fit,1.32) 球面上 → 闸门放行');
// 供应商球心交叉校核是唯一防线: 传入真球心 C0 → 双信号报警
fit = fitSphereFromOutline(outlineCoplanar, { srDesign: 1.32, eye: eyePt, supplierCenter: C0 });
assert(fit.crossCheck && !fit.crossCheck.ok, 'crossCheck.ok=false (SR 错被捕获)');
assert(approx(fit.crossCheck.devMm, 60.2, 1.5), `球心偏差信号 ≈ ${shiftMm.toFixed(0)}mm (得 ${fit.crossCheck.devMm.toFixed(1)}mm)`);
assert(approx(fit.crossCheck.impliedRadius, R0, 1e-9), `隐含半径=真实 1.26 (得 ${fit.crossCheck.impliedRadius.toFixed(4)})`);
assert(approx(fit.crossCheck.srDevMm, 60, 1e-6), '隐含半径 vs 申报 SR 差 60mm → 第二信号');
assert(fit.warnings.some(w => /交叉校核未通过/.test(w)), '警告明确: 以轮廓拟合为准 + 核查供应商数据');
// 正常情况: SR 正确 + 供应商球心一致 → crossCheck 通过
fit = fitSphereFromOutline(outlineCoplanar, { srDesign: R0, eye: eyePt, supplierCenter: C0 });
assert(fit.crossCheck.ok && fit.crossCheck.devMm < 0.01, '自洽数据 crossCheck.ok=true');
assert(fit.warnings.length === 0, `自洽数据无警告 (得 ${JSON.stringify(fit.warnings)})`);
// 非共面 + 供应商球心偏移 30mm → 报警
fit = fitSphereFromOutline(outlineNonCoplanar, { srDesign: R0, supplierCenter: vec3Add(C0, [0.03, 0, 0]) });
assert(!fit.crossCheck.ok && approx(fit.crossCheck.devMm, 30, 0.01), '非共面: 供应商球心偏 30mm → 校核拦截');
assert(fit.warnings.some(w => /交叉校核未通过/.test(w)), '非共面: 报警文案一致');
throws(() => fitSphereFromOutline(outlineCoplanar, { srDesign: R0, eye: eyePt, supplierCenter: [NaN, 0, 0] }),
  /supplierCenter/, 'supplierCenter 非法 → 抛错');

// ======================================================================
console.log(`\n${_fails === 0 ? '✅ 全部通过' : `❌ ${_fails} 项失败`}`);
process.exit(_fails === 0 ? 0 : 1);
