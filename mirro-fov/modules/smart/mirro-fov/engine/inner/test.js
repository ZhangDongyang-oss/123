/**
 * 验证 JS 计算结果与 Python 一致
 * 对照 Python 输出: 五线法 5/5 PASS, 命中点坐标, 自动搜角 yaw=-24°
 * 坐标系: 整车坐标系 (原点=车身参考点)
 *
 * 本测试读取真实车型文件 (data/vehicles/*.json), 不再硬编码数据,
 * 确保引擎与车型数据共同验证。任一断言失败 → 非零退出 (CI 可用)。
 */
const fs = require('fs');
const path = require('path');
const { Mirror } = require('./mirror');
const { computeVirtualEye, fiveLineVerification } = require('./five-line');
const { searchPassingAngles } = require('./auto-verify');
const { optimizePitch } = require('./optimizer');
const { Ground } = require('../shared/plane');
const { buildRearWindow, rearWindowProjectionOnMirror, lineSegmentPlaneIntersect,
        pointInPolygon3D, checkLineThroughRearWindow, buildProjection } = require('./rear-window');
const { pointInPolygon2D, edgeDistanceTo } = require('../shared/polygon');

const VEHICLES_DIR = path.join(__dirname, '..', '..', 'data', 'vehicles');

// ─── 从车型 JSON 构建引擎对象 (与 routes.js::loadDefaultConfig 同口径) ───
function loadVehicle(name) {
  const raw = JSON.parse(fs.readFileSync(path.join(VEHICLES_DIR, `${name}.json`), 'utf8'));
  const m = raw.mirror, d = raw.driver, g = raw.ground, rw = raw.rear_window, reg = raw.regulation;
  const cz = m.center_zero, pv = m.pivot;
  const armOffset = cz ? [cz[0]-pv[0], cz[1]-pv[1], cz[2]-pv[2]] : m.arm_offset;
  return {
    mirrorBase: {
      width: m.width, height: m.height, pivot: pv, armOffset,
      cornerRadius: m.corner_radius || 0,
    },
    eyePoints: { center: d.eye_center, ipd: d.interpupillary_distance },
    yawDeg: m.yaw, pitchDeg: m.pitch,
    ground: (g && g.front_mid && g.rear_mid) ? Ground.fromTwoPoints(g.front_mid, g.rear_mid) : Ground.horizontal((raw.visualization||{}).ground_plane_z || 0),
    rearWindow: rw && rw.outline ? buildRearWindow(rw.outline, rw.transparent_zone || rw.outline) : null,
    farDist: reg.far_distance, reqWidth: reg.required_width_at_far,
  };
}

// ─── 断言工具 ───
let _fails = 0;
function assert(cond, msg) {
  if (!cond) { console.error(`  ✗ FAIL: ${msg}`); _fails++; }
  else console.log(`  ✓ ${msg}`);
}
function approx(a, b, tol = 0.05) { return Math.abs(a - b) <= tol; }

// ======================================================================
// 1. 车型C 默认角度五线校核 (对照 Python: 5/5 PASS, 命中点逐位一致)
// ======================================================================
console.log("=== 1. 车型C 默认角度五线校核 ===\n");
const 车型C = loadVehicle('车型C');
const m = new Mirror({
  ...车型C.mirrorBase,
  yaw: 车型C.yawDeg * Math.PI / 180,
  pitch: 车型C.pitchDeg * Math.PI / 180,
});
console.log(`Mirror center: [${m.center.map(v => v.toFixed(6)).join(', ')}]`);
console.log(`Mirror normal: [${m.normal.map(v => v.toFixed(6)).join(', ')}]`);

const ec = 车型C.eyePoints.center;
const leftEye = [ec[0], ec[1] - 车型C.eyePoints.ipd/2, ec[2]];
const rightEye = [ec[0], ec[1] + 车型C.eyePoints.ipd/2, ec[2]];
const farPlaneX = ec[0] + 车型C.farDist;
const halfW = 车型C.reqWidth / 2;
const gzReg = 车型C.ground.zAtX(farPlaneX);
const regEps = [[farPlaneX, -halfW, gzReg], [farPlaneX, halfW, gzReg]];
const virtualEyes = [computeVirtualEye(leftEye, m), computeVirtualEye(rightEye, m), computeVirtualEye(ec, m)];

const result = fiveLineVerification({ virtualEyes, mirror: m, regEndpoints: regEps, rearWindow: 车型C.rearWindow });
console.log(`\n五线法: ${result.nHit}/${result.nTot} ${result.mirrorPass ? 'PASS' : 'FAIL'}`);
for (const ld of result.lineDetails) {
  if (ld.mirrorHit) console.log(`  ${ld.eyeLabel}→${ld.endpointLabel}: lx=${ld.lx.toFixed(1)} ly=${ld.ly.toFixed(1)}`);
  else console.log(`  ${ld.eyeLabel}→${ld.endpointLabel}: MISS`);
}

assert(result.mirrorPass, '车型C 默认角度五线 5/5 PASS');
// 逐位对照 Python 命中点 (lx, ly) — Python main.py --config data/vehicles/车型C.yaml 输出
// 注意: ly 随地面坡度变化 (车型C.json 用坡度地面 φ≈-0.155°, 非平地)
const expected = {
  'C→BL': { lx: -92.6, ly: 1.9 },
  'C→BR': { lx: 89.0, ly: 0.2 },
  'C→+X': { lx: -8.0, ly: 12.9 },
  'L→BR': { lx: 67.8, ly: 2.1 },
  'R→BL': { lx: -66.3, ly: 0.0 },
};
for (const ld of result.lineDetails) {
  if (!ld.mirrorHit) continue;
  const key = `${ld.eyeLabel}→${ld.endpointLabel}`;
  const e = expected[key];
  if (!e) continue;
  assert(approx(ld.lx, e.lx, 0.1) && approx(ld.ly, e.ly, 0.1), `${key} 命中点 (${ld.lx.toFixed(1)},${ld.ly.toFixed(1)}) ≈ Python (${e.lx},${e.ly})`);
}

// ======================================================================
// 2. 自动搜角 (对照 Python: 找到 yaw=-24° pitch=4°, 5/5 PASS)
// ======================================================================
console.log("\n=== 2. 自动搜角 (车型C) ===\n");
const searchResult = searchPassingAngles({
  mirrorBase: 车型C.mirrorBase, eyePoints: 车型C.eyePoints,
  farDist: 车型C.farDist, reqWidth: 车型C.reqWidth,
  ground: 车型C.ground, rearWindow: 车型C.rearWindow,
  yawRange: [-42, -18], pitchRange: [-10, 10],
  step: 2, seedYaw: -30, seedHalf: 12,
});
if (searchResult.found) {
  console.log(`找到 PASS: yaw=${searchResult.bestYaw}° pitch=${searchResult.bestPitch}°`);
  console.log(`五线: ${searchResult.summary.nHit}/${searchResult.summary.nTot}`);
  console.log(`耗时: ${searchResult.elapsed.toFixed(1)}s`);
  assert(searchResult.bestYaw === -24 && searchResult.bestPitch === 4, `搜角结果 yaw=-24° pitch=4° (得 ${searchResult.bestYaw}°/${searchResult.bestPitch}°)`);
  assert(searchResult.summary.nHit === 5, '搜角结果五线 5/5');
  assert(searchResult.grid.every(row => row.every(v => v >= 0)), '种子区命中后仍返回完整热图 grid');
  assert(searchResult.passRegion.yawMin !== null && searchResult.passRegion.pitchMin !== null, '种子区命中后仍返回完整 PASS 区域');
  // 关键回归: 旧 test.js 漏传 farDist 时假报 yaw=-28° 假 PASS, 此处必须排除
  assert(searchResult.bestYaw !== -28, '不退回假 PASS 角度 yaw=-28° (NaN 假 PASS 回归)');
} else {
  assert(false, '自动搜角应找到 PASS');
}

// ======================================================================
// 3. 车型E 配置角度五线校核 (对照 Python git 历史: yaw=-22 pitch=8, 5/5 PASS)
// ======================================================================
console.log("\n=== 3. 车型E 配置角度五线校核 ===\n");
const 车型E = loadVehicle('车型E');
const mk = new Mirror({
  ...车型E.mirrorBase,
  yaw: 车型E.yawDeg * Math.PI / 180,
  pitch: 车型E.pitchDeg * Math.PI / 180,
});
const eck = 车型E.eyePoints.center;
const farPlaneXk = eck[0] + 车型E.farDist;
const gzRegk = 车型E.ground.zAtX(farPlaneXk);
const regEpsk = [[farPlaneXk, -车型E.reqWidth/2, gzRegk], [farPlaneXk, 车型E.reqWidth/2, gzRegk]];
const visk = [
  computeVirtualEye([eck[0], eck[1]-车型E.eyePoints.ipd/2, eck[2]], mk),
  computeVirtualEye([eck[0], eck[1]+车型E.eyePoints.ipd/2, eck[2]], mk),
  computeVirtualEye(eck, mk),
];
const resK = fiveLineVerification({ virtualEyes: visk, mirror: mk, regEndpoints: regEpsk, rearWindow: 车型E.rearWindow });
console.log(`五线法: ${resK.nHit}/${resK.nTot} ${resK.mirrorPass ? 'PASS' : 'FAIL'}`);
assert(resK.mirrorPass, '车型E 配置角度 (yaw=-22 pitch=8) 五线 5/5 PASS');

// ======================================================================
// 4. 圆角判定 + NaN 防御 (回归: isOn(NaN,NaN) 曾返回 true → 假 PASS)
// ======================================================================
console.log("\n=== 4. 圆角判定 + NaN 防御 ===\n");
const m0 = new Mirror({ ...车型C.mirrorBase, yaw: 0, pitch: 0, cornerRadius: 0 });
const m10 = new Mirror({ ...车型C.mirrorBase, yaw: 0, pitch: 0, cornerRadius: 0.010 });
assert(m0.isOnReflectiveSurface(0, 0) === true, '尖角镜 (0,0) 在反射面内');
assert(m0.isOnReflectiveSurface(112, 25) === true, '尖角镜 (112,25) 在反射面内 (边界)');
assert(m10.isOnReflectiveSurface(0, 0) === true, '圆角镜 (0,0) 在反射面内');
assert(m10.isOnReflectiveSurface(112, 25) === false, '圆角镜 (112,25) 角落被切 (不在反射面)');
assert(m10.isOnReflectiveSurface(NaN, NaN) === false, 'isOn(NaN,NaN)=false (NaN 防御, 阻断假 PASS)');
assert(m10.isOnReflectiveSurface(Infinity, 0) === false, 'isOn(Infinity,0)=false (非有限值防御)');
assert(m10.isOnReflectiveSurface(0, undefined) === false, 'isOn(0,undefined)=false (非有限值防御)');

// ======================================================================
// 5. 轮廓
// ======================================================================
console.log("\n=== 5. 反射面轮廓 ===\n");
const outline = m10.reflectiveOutlineMM();
console.log(`reflectiveOutlineMM (r=10mm): ${outline.xs.length} points`);
console.log(`  xs range: [${Math.min(...outline.xs).toFixed(1)}, ${Math.max(...outline.xs).toFixed(1)}]`);
console.log(`  ys range: [${Math.min(...outline.ys).toFixed(1)}, ${Math.max(...outline.ys).toFixed(1)}]`);
assert(approx(Math.max(...outline.xs), 112.4, 0.1) && approx(Math.min(...outline.xs), -112.4, 0.1), '轮廓 xs 范围 ±112.4mm');
assert(approx(Math.max(...outline.ys), 25.4, 0.1) && approx(Math.min(...outline.ys), -25.4, 0.1), '轮廓 ys 范围 ±25.4mm');

// ======================================================================
// 6. pitch 优化器 (默认范围 [-5,15] 应收敛到 pitch≈3.4°, zMin 触及地面)
// 回归: 旧默认 (-30,-1) 因 pitch 符号约定反了永远走不到二分, converged=false
// ======================================================================
console.log("\n=== 6. pitch 优化器 ===\n");
const optMirror = {
  width: 车型C.mirrorBase.width, height: 车型C.mirrorBase.height,
  pivot: 车型C.mirrorBase.pivot, armOffset: 车型C.mirrorBase.armOffset,
  yaw: 车型C.yawDeg * Math.PI / 180,
};
const opt = optimizePitch({
  mirror: optMirror, eyePoints: 车型C.eyePoints,
  farDistance: 车型C.farDist, requiredWidth: 车型C.reqWidth,
  ground: 车型C.ground, // 默认 pitchRange [-5,15]
});
console.log(`最优 pitch: ${opt.optimalPitchDeg.toFixed(2)}°  converged=${opt.converged}  zMin=${opt.zMinAtFar.toFixed(2)}`);
assert(opt.converged, 'pitch 优化默认范围 [-5,15] 收敛 (不再卡在 -30° 早返回)');
assert(approx(opt.optimalPitchDeg, 3.4, 0.5), `最优 pitch ≈ 3.4° (得 ${opt.optimalPitchDeg.toFixed(2)}°)`);

// ======================================================================
// 7. 后挡风投影覆盖 (报告项, 与 Python 一致)
// 车型C 眼点(X=3.24)在镜面(X=2.91)与后挡风(X=4.54)之间,
// 射线从眼点向后挡风(+X)不回头经过镜面 → t<0 被过滤 → 0 投影点。
// 此为 Python 算法固有行为, JS 移植一致。
// ======================================================================
console.log("\n=== 7. 后挡风投影覆盖 ===\n");
const rwProj = rearWindowProjectionOnMirror(车型C.eyePoints.center, m, 车型C.rearWindow);
console.log(`投影点数: ${rwProj.projectionPoints.length}  覆盖镜面: ${rwProj.coversMirror}`);
assert(rwProj.projectionPoints.length === 0, `后挡风投影 0 点 (与 Python 一致, 眼点在镜面与后挡风之间)`);
assert(rwProj.coversMirror === false, 'coversMirror=false (与 Python 一致)');

// ======================================================================
// 8. 后挡风底层纯函数单元测试 (纯几何构造, 不依赖车型数据)
// 构造 x=4 竖平面上的四边形后挡风: 平面法线应朝 −X (车内侧)
// ======================================================================
console.log("\n=== 8. 后挡风底层纯函数 ===\n");

// 8.1 buildRearWindow: 平面拟合 + 质心 + 法线定向
const rwOutline = [[4, -0.5, 1.3], [4, 0.5, 1.3], [4, 0.5, 1.6], [4, -0.5, 1.6]];
const rw = buildRearWindow(rwOutline, []);
console.log(`planePoint=[${rw.planePoint.map(v => v.toFixed(3)).join(', ')}]  planeNormal=[${rw.planeNormal.map(v => v.toFixed(3)).join(', ')}]`);
assert(approx(rw.planePoint[0], 4, 1e-6) && approx(rw.planePoint[1], 0, 1e-6) && approx(rw.planePoint[2], 1.45, 1e-6), 'planePoint = 轮廓质心 [4, 0, 1.45]');
assert(rw.planeNormal[0] < 0, '平面法线朝 −X (车内侧)');
assert(approx(Math.hypot(...rw.planeNormal), 1, 1e-9), 'planeNormal 单位长度');
assert(rw.tz === rwOutline, 'transparentZone 空数组 fallback 到 outline');

// 8.2 lineSegmentPlaneIntersect: 线段与平面求交 (只接受内部交点)
const planeP = [4, 0, 0], planeN = [1, 0, 0];
const hit = lineSegmentPlaneIntersect([0, 0, 0], [8, 0, 0], planeP, planeN);
assert(hit && approx(hit[0], 4, 1e-9) && hit[1] === 0 && hit[2] === 0, '线段穿过平面 → 命中 (4,0,0)');
assert(lineSegmentPlaneIntersect([0, 0, 0], [2, 0, 0], planeP, planeN) === null, '线段未达平面 (t>1) → null');
assert(lineSegmentPlaneIntersect([0, 1, 0], [0, 2, 0], planeP, planeN) === null, '线段平行平面 (denom=0) → null');

// 8.3 pointInPolygon2D: 2D 点在多边形内 (射线法)
const sq = [[0, 0], [2, 0], [2, 2], [0, 2]];
assert(pointInPolygon2D([1, 1], sq) === true, '2D (1,1) 在正方形内');
assert(pointInPolygon2D([3, 1], sq) === false, '2D (3,1) 在正方形外');
assert(pointInPolygon2D([1, 3], sq) === false, '2D (1,3) 在正方形外');

// 8.4 pointInPolygon3D: 3D 点在多边形内 (投影到丢弃最大法线分量的平面)
assert(pointInPolygon3D([4, 0, 1.45], rwOutline, rw.planeNormal) === true, '3D 点在后挡风内 → true');
assert(pointInPolygon3D([4, 2, 1.45], rwOutline, rw.planeNormal) === false, '3D 点 (4,2,1.45) 在后挡风外 → false');

// 8.5 checkLineThroughRearWindow: 线段穿过后挡风透光区
assert(checkLineThroughRearWindow([0, 0, 1.45], [8, 0, 1.45], rw).through === true, '射线经后挡风中心 → through=true');
assert(checkLineThroughRearWindow([0, 2, 1.45], [8, 2, 1.45], rw).through === false, '射线偏离透光区 → through=false');
assert(checkLineThroughRearWindow([0, 0, 1.45], [2, 0, 1.45], rw).through === false, '线段未达后挡风平面 → through=false');

// 8.6 edgeDistanceTo: 点到线段最短距离 (垂足 + 端点钳制)
const d1 = edgeDistanceTo(2, 3, 0, 0, 4, 0);
assert(approx(d1.dist, 3, 1e-9) && approx(d1.ex, 2, 1e-9) && d1.ey === 0, '垂足在线段内 → dist=3 @ (2,0)');
const d2 = edgeDistanceTo(5, 3, 0, 0, 4, 0);
assert(approx(d2.dist, Math.hypot(1, 3), 1e-9), '垂足超出线段 → 钳到端点, dist=√10');
assert(approx(edgeDistanceTo(1, 1, 0, 0, 0, 0).dist, Math.hypot(1, 1), 1e-9), '退化线段 → 距离到端点');

// 8.7 buildProjection: 平面内 u-v 局部坐标 (mm) + 基向量正交性
const proj = buildProjection(rw);
const c2d = proj.to2d(rw.planePoint);
assert(Math.abs(c2d[0]) < 1e-6 && Math.abs(c2d[1]) < 1e-6, '平面质心投影到 (0,0)mm');
const y2d = proj.to2d([4, 1, 1.45]);
assert(Math.abs(y2d[0] - 1000) < 1 && Math.abs(y2d[1]) < 1, '+Y 偏移 1m → u≈1000mm, v≈0');
const z2d = proj.to2d([4, 0, 2.45]);
assert(Math.abs(z2d[0]) < 1 && Math.abs(z2d[1] - 1000) < 1, '+Z 偏移 1m → v≈1000mm, u≈0');
const uw = proj.widthVec, upv = proj.upVec;
assert(Math.abs(uw[0]**2 + uw[1]**2 + uw[2]**2 - 1) < 1e-9, 'widthVec 单位向量');
assert(Math.abs(upv[0]**2 + upv[1]**2 + upv[2]**2 - 1) < 1e-9, 'upVec 单位向量');
assert(Math.abs(uw[0]*upv[0] + uw[1]*upv[1] + uw[2]*upv[2]) < 1e-9, 'widthVec ⊥ upVec');
assert(Math.abs(uw[0]*rw.planeNormal[0] + uw[1]*rw.planeNormal[1] + uw[2]*rw.planeNormal[2]) < 1e-9, 'widthVec 在平面内 (⊥ 法线)');
assert(Math.abs(upv[0]*rw.planeNormal[0] + upv[1]*rw.planeNormal[1] + upv[2]*rw.planeNormal[2]) < 1e-9, 'upVec 在平面内 (⊥ 法线)');

// ======================================================================
console.log(`\n${_fails === 0 ? '✅ 全部通过' : `❌ ${_fails} 项失败`}`);
process.exit(_fails === 0 ? 0 : 1);
