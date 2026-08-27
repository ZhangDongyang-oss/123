/**
 * 真实外镜数据校核 — 读 data/exterior/exterior-vehicle-draft.json, 跑完整链路
 * 链路: 拟合(sr_fit=1260) → crossCheck → 闸门 → projectToSphere → ExteriorMirror(实测旋转轴) → verifyExterior → ±3°搜索
 * 输出: 打印校核结果 + dump public/exterior-viz-real-data.js
 * 运行: node engine/exterior/verify-real.js [left|right]  (默认 left)
 */
const fs = require('fs');
const path = require('path');
const { fitSphereFromOutline, projectToSphere, validateOutlineOnSphere } = require('./sphere-fit');
const { ExteriorMirror, buildTriangles, findMirrorPointsForTarget, verifyExterior, searchExteriorAngles } = require('./exterior-mirror');
const { Ground } = require('../shared/plane');
const { vec3Sub, vec3Add, vec3Scale, vec3Normalize, vec3Dot, vec3Cross, vec3Norm } = require('../shared/geometry');

const side = (process.argv[2] || 'left').toLowerCase();
const DRAFT = path.join(__dirname, '..', '..', 'data', 'exterior', 'exterior-vehicle-draft.json');
const raw = JSON.parse(fs.readFileSync(DRAFT, 'utf8'));
const mir = raw[`exterior_mirror_${side}`];
const eyeCenter = raw.driver.eye_center;
const eyes = { left: raw.driver.eye_left_raw, right: raw.driver.eye_right_raw };
const doorOuterY = raw.door_panel[`door_outer_Y_${side}`];
const g = raw.ground;
const ground = Ground.fromTwoPoints(g.front_mid, g.rear_mid);
const regulation = raw.regulation;
const srFit = mir.sr_fit;
const supplierC = mir.supplier_sphere_center;

console.log(`═══════ 外镜真实数据校核 (${side}) ═══════`);
console.log(`眼点 center = [${eyeCenter.map(v=>v.toFixed(4)).join(', ')}]`);
console.log(`眼点 left   = [${eyes.left.map(v=>v.toFixed(4)).join(', ')}]`);
console.log(`眼点 right  = [${eyes.right.map(v=>v.toFixed(4)).join(', ')}]  (双眼交集判据)`);
console.log(`车门最外 Y = ${doorOuterY.toFixed(4)}`);
console.log(`地面: front_mid=[${g.front_mid.join(',')}], rear_mid=[${g.rear_mid.join(',')}]`);
console.log(`SR 校核 = ${srFit} (设计 ${mir.sr_nominal}±${mir.sr_tolerance})`);
console.log(`旋转轴方向 = [${mir.rotation_axis_dir.join(', ')}]  (原点 p1=[${mir.turret_axis_p1.join(',')}])`);
console.log(`旋转轴偏离整车 Y = ${(Math.acos(Math.min(1,Math.abs(mir.rotation_axis_dir[1])))*180/Math.PI).toFixed(2)}°\n`);

// ── 1. 拟合球心 ──
console.log('── 1. 球心拟合 (planar-cut 路径, srDesign=1260) ──');
const fit = fitSphereFromOutline(mir.outline_raw, { srDesign: srFit, eye: eyeCenter, supplierCenter: supplierC });
console.log(`  method = ${fit.method}`);
console.log(`  球心 C = [${fit.center.map(v=>v.toFixed(6)).join(', ')}]`);
console.log(`  拟合半径 = ${fit.radius.toFixed(6)} m`);
console.log(`  残差 = ${fit.fitResidualMm.toExponential(2)} mm`);
console.log(`  warnings = ${JSON.stringify(fit.warnings)}`);
if (fit.crossCheck) {
  console.log(`  crossCheck: ok=${fit.crossCheck.ok} devMm=${fit.crossCheck.devMm.toFixed(3)} impliedR=${fit.crossCheck.impliedRadius.toFixed(4)} srDevMm=${fit.crossCheck.srDevMm.toFixed(2)}`);
}

// ── 2. 一致性闸门 ──
console.log('\n── 2. 一致性闸门 (轮廓 vs 球心+半径) ──');
const gate = validateOutlineOnSphere(mir.outline_raw, fit.center, srFit);
console.log(`  ok=${gate.ok} maxDev=${gate.maxDevMm.toExponential(2)} mm`);

// ── 3. 投影到校核球面 + 构造镜面 ──
console.log('\n── 3. 构造 ExteriorMirror (实测旋转轴) ──');
const projOutline = projectToSphere(mir.outline_raw, fit.center, srFit);
const mirror = new ExteriorMirror({
  radius: srFit, sphereCenter: fit.center, outline: projOutline,
  turretAxisPoint: mir.turret_axis_p1, turretAxisDir: mir.rotation_axis_dir,
});
console.log(`  capCenter = [${mirror.capCenter.map(v=>v.toFixed(4)).join(', ')}]`);
console.log(`  nHat = [${mirror.nHat.map(v=>v.toFixed(4)).join(', ')}]`);
console.log(`  帽心距边界 = ${mirror.boundaryDistanceMm(0,0).toFixed(1)} mm`);
const maxZ = mirror.maxZPoint();
console.log(`  镜面 Z 最高点 = [${maxZ.map(v=>v.toFixed(4)).join(', ')}]`);

// ── 4. 三角形 ──
console.log('\n── 4. 地面三角形 (III 类) ──');
const tris = buildTriangles(eyeCenter, doorOuterY, ground, mirror, regulation);
for (const t of tris) {
  console.log(`  ${t.name}: xRef=${t.xRef.toFixed(3)} A=[${t.vertices[0].map(v=>v.toFixed(3)).join(',')}] B=[${t.vertices[1].map(v=>v.toFixed(3)).join(',')}] T=[${t.vertices[2].map(v=>v.toFixed(3)).join(',')}]`);
}

// ── 5. 校核 ──
console.log('\n── 5. verifyExterior (中心眼, samplePerEdge=20, margin=3mm) ──');
const v = verifyExterior(eyes, doorOuterY, ground, mirror, { samplePerEdge: 20, minMarginMm: 3.0, regulation });
console.log(`  near.pass = ${v.near.pass}   far.pass = ${v.far.pass}`);
console.log(`  mirrorPass = ${v.mirrorPass ? '✅ PASS' : '❌ FAIL'}`);
// 失败时打印每边首个失败原因
function firstFail(tri) {
  for (const e of tri.edges) {
    if (!e.pass) {
      const bad = e.samples.find(s => !s.visible);
      return `${e.name}: ${bad ? bad.reason : '?'}${bad && bad.d != null ? ` (d=${bad.d.toFixed(2)}mm)` : ''}`;
    }
  }
  return null;
}
if (!v.near.pass) console.log(`  near 失败: ${firstFail(v.near)}`);
if (!v.far.pass) console.log(`  far 失败: ${firstFail(v.far)}`);

// ── 6. ±3° 搜索 ──
console.log('\n── 6. ±3° 调节搜索 (绕实测旋转轴) ──');
const search = searchExteriorAngles(eyes, doorOuterY, ground, mirror, { step: 0.5, range: 3.0, regulation });
console.log(`  found = ${search.found} ${search.found ? `(bestPsi=${search.bestPsi}°)` : ''}`);
console.log(`  各角度: ${search.results.map(r => `${r.psi}°:${r.mirrorPass?'✓':'✗'}`).join(' ')}`);

console.log(`\n═══════ 结论: ${side} 镜 ${v.mirrorPass ? '✅ PASS' : (search.found ? `±3° 内 PASS (psi=${search.bestPsi}°)` : '❌ FAIL (±3° 内无解)')} ═══════`);

// ── 7. dump 可视化数据 ──
const zG = ground.zAtX(eyeCenter[0] + 4);
// 帽面网格: 在切平面采样投影到球面
const capN = 24, capX=[], capY=[], capZ=[], capI=[], capJ=[], capK=[];
const cIdx = (i,j) => i*(capN+1)+j;
const upV = mirror.upVec, rightV = mirror.rightVec;
// 用 outline 的 UV 范围采样
const us = mirror.outlineUV.map(p=>p[0]), vs = mirror.outlineUV.map(p=>p[1]);
const uMin = Math.min(...us), uMax = Math.max(...us), vMin = Math.min(...vs), vMax = Math.max(...vs);
for (let i=0;i<=capN;i++) for (let j=0;j<=capN;j++) {
  const u = uMin + (uMax-uMin)*i/capN, vv = vMin + (vMax-vMin)*j/capN;
  const P = vec3Add(mirror.capCenter, vec3Add(vec3Scale(rightV, u/1000), vec3Scale(upV, vv/1000)));
  const dir = vec3Normalize(vec3Sub(P, mirror.sphereCenter));
  const sp = vec3Add(mirror.sphereCenter, vec3Scale(dir, mirror.radius));
  capX.push(sp[0]); capY.push(sp[1]); capZ.push(sp[2]);
}
for (let i=0;i<capN;i++) for (let j=0;j<capN;j++) {
  const a=cIdx(i,j), b=cIdx(i+1,j), c=cIdx(i+1,j+1), d=cIdx(i,j+1);
  capI.push(a,a); capJ.push(b,c); capK.push(c,d);
}
function axisLine(pt, dir, halfLen) {
  return [vec3Add(pt, vec3Scale(dir,-halfLen)), vec3Add(pt, vec3Scale(dir,halfLen))];
}
// 反射光线 (near AB 边)
function raysFromEdge(tri, n) {
  const out=[]; const [A,B]=tri.vertices;
  for (let k=0;k<=n;k++) {
    const t=k/n; const Q=[A[0]+(B[0]-A[0])*t, A[1]+(B[1]-A[1])*t, A[2]+(B[2]-A[2])*t];
    const pts=findMirrorPointsForTarget(eyeCenter, Q, mirror);
    if (pts.length) out.push({ eye: eyeCenter, mirrorPoint: pts[0].point, target: Q });
  }
  return out;
}
const gx = [eyeCenter[0]-1, eyeCenter[0]+22], gy=[doorOuterY-5, doorOuterY+1];
const data = {
  mirror: {
    sphereCenter: mirror.sphereCenter, radius: mirror.radius, capCenter: mirror.capCenter, nHat: mirror.nHat,
    outline: projOutline, capMesh: { x:capX, y:capY, z:capZ, i:capI, j:capJ, k:capK },
    turretAxisPoint: mir.turret_axis_p1,
  },
  rotationAxis: axisLine(mir.turret_axis_p1, mir.rotation_axis_dir, 0.15),
  foldAxis: axisLine(mir.turret_axis_p1, [0,0,1], 0.15),
  eye: eyeCenter, doorOuterY, groundZ: zG,
  groundMesh: { x:[gx[0],gx[1],gx[1],gx[0]], y:[gy[0],gy[0],gy[1],gy[1]], z:[zG,zG,zG,zG], i:[0,0], j:[1,2], k:[2,3] },
  triangles: tris.map((t,i)=>({ name:t.name, vertices:t.vertices, pass: i===0?v.near.pass:v.far.pass })),
  raysNear: raysFromEdge(tris[0],4), raysFar: raysFromEdge(tris[1],4),
  verify: { mirrorPass: v.mirrorPass, nearPass: v.near.pass, farPass: v.far.pass, searchFound: search.found, bestPsi: search.bestPsi },
};
const outPath = path.join(__dirname,'..','..','public',`exterior-viz-real-${side}.js`);
fs.writeFileSync(outPath, `// 自动生成 by verify-real.js — 真实${side}镜数据\nwindow.VIZ_DATA = ${JSON.stringify(data, null, 2)};\n`, 'utf8');
console.log(`\n可视化数据已写出: ${outPath}`);
