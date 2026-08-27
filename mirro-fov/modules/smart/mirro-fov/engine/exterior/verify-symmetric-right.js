/**
 * 对称化右镜校核 — 假设车辆左右对称, 把左镜几何 Y 镜像到右侧, 验证"若右镜对称安装"能否通过
 * 区分: 右镜真实 FAIL 是"玻璃测量状态偏(假象)" vs "几何天生不行(司机在左,右镜远)"
 * 眼点 = 真实驾驶员眼点 (左侧, 不镜像); 车门 = 右 door_outer_Y
 * 运行: node engine/exterior/verify-symmetric-right.js
 */
const fs = require('fs');
const path = require('path');
const { fitSphereFromOutline, projectToSphere } = require('./sphere-fit');
const { ExteriorMirror, verifyExterior, searchExteriorAngles } = require('./exterior-mirror');
const { Ground } = require('../shared/plane');

const DRAFT = path.join(__dirname, '..', '..', 'data', 'exterior', 'exterior-vehicle-draft.json');
const raw = JSON.parse(fs.readFileSync(DRAFT, 'utf8'));
const L = raw.exterior_mirror_left;
const eyeCenter = raw.driver.eye_center;
const eyes = { left: raw.driver.eye_left_raw, right: raw.driver.eye_right_raw };
const doorY = raw.door_panel.door_outer_Y_right;
const g = raw.ground;
const ground = Ground.fromTwoPoints(g.front_mid, g.rear_mid);
const regulation = raw.regulation;

const flip = p => [p[0], -p[1], p[2]];  // Y 镜像

// 左镜几何镜像 → 对称化右镜
const outlineR = L.outline_raw.map(flip);
const supplierC_R = flip(L.supplier_sphere_center);
const p1_R = flip(L.turret_axis_p1);
const axisDir_R = flip(L.rotation_axis_dir);

console.log('═══════ 对称化右镜校核 (左镜 Y 镜像) ═══════');
console.log(`眼点 (真实驾驶员, 不镜像): L=[${eyes.left.map(v=>v.toFixed(4)).join(', ')}] R=[${eyes.right.map(v=>v.toFixed(4)).join(', ')}]`);
console.log(`右车门最外 Y = ${doorY.toFixed(4)}`);
console.log(`镜像球心(期望) = [${supplierC_R.map(v=>v.toFixed(4)).join(', ')}]`);
console.log(`镜像旋转轴    = [${axisDir_R.map(v=>v.toFixed(4)).join(', ')}]`);

// 拟合 (镜像轮廓 + 真实眼点, 应得镜像球心 — 自洽性确认)
const fit = fitSphereFromOutline(outlineR, { srDesign: L.sr_fit, eye: eyeCenter, supplierCenter: supplierC_R });
console.log(`\n拟合: method=${fit.method} center=[${fit.center.map(v=>v.toFixed(6)).join(', ')}]`);
console.log(`crossCheck: ok=${fit.crossCheck.ok} devMm=${fit.crossCheck.devMm.toFixed(3)} (≈0 → 镜像自洽)`);

const projOutline = projectToSphere(outlineR, fit.center, L.sr_fit);
const mirror = new ExteriorMirror({
  radius: L.sr_fit, sphereCenter: fit.center, outline: projOutline,
  turretAxisPoint: p1_R, turretAxisDir: axisDir_R,
});
console.log(`nHat = [${mirror.nHat.map(v=>v.toFixed(4)).join(', ')}]`);

const v = verifyExterior(eyes, doorY, ground, mirror, { samplePerEdge: 20, minMarginMm: 3.0, regulation });
console.log(`\nverifyExterior: near=${v.near.pass} far=${v.far.pass} mirrorPass=${v.mirrorPass ? '✅ PASS' : '❌ FAIL'}`);

const search = searchExteriorAngles(eyes, doorY, ground, mirror, { step: 0.5, range: 3.0, regulation });
const window = search.results.filter(r => r.mirrorPass).map(r => r.psi + '°');
console.log(`±3° 搜索: found=${search.found} ${search.found ? `bestPsi=${search.bestPsi}°` : ''}`);
console.log(`通过窗口: ${window.join(', ') || '无'}`);

console.log(`\n═══════ 结论 ═══════`);
if (v.mirrorPass || search.found) {
  console.log('✅ 对称化右镜能过 → 右镜真实 FAIL 多半是玻璃测量状态偏(角度差 ~10°), 找供应商确认右镜实际安装位置后重采轮廓即可复检');
} else {
  console.log('❌ 对称化右镜仍不过 → 即便右镜对称安装也过不了: 司机在左/右镜远的几何天生吃力, 或双眼交集/T顶点约定需再查');
}
