/**
 * 外镜建模可视化数据导出 — 用引擎真实代码构造测试场景, dump 全部几何实体
 * 输出: public/exterior-viz-data.js (赋值 window.VIZ_DATA), 供 exterior-viz.html 渲染
 *
 * 场景 = test-exterior.js 的 coverMirror (大帽面 PASS) + m0 (小帽面 FAIL) 对照
 * 运行: node engine/exterior/vis-dump.js
 */
const fs = require('fs');
const path = require('path');
const { vec3Add, vec3Sub, vec3Scale, vec3Normalize, vec3Dot, vec3Cross, vec3Norm } = require('../shared/geometry');
const { Ground } = require('../shared/plane');
const { ExteriorMirror, buildTriangles, findMirrorPointsForTarget, verifyExterior } = require('./exterior-mirror');

// ═══ 构造 (同 test-exterior.js) ═══
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
  const lin = vec3Add(capCenter, vec3Add(vec3Scale(rightV, sx * HW * scale), vec3Scale(upV, sy * HH * scale)));
  return vec3Add(C, vec3Scale(vec3Normalize(vec3Sub(lin, C)), R));
}
const outlineSmall = [corner(1, 1), corner(-1, 1), corner(-1, -1), corner(1, -1)];          // m0: 小帽 (FAIL)
const outlineCover = [corner(1, 1, 12), corner(-1, 1, 12), corner(-1, -1, 12), corner(1, -1, 12)]; // 大帽 (PASS)
const p1 = [2.95, -0.75, 1.4];
const mirror = new ExteriorMirror({ radius: R, sphereCenter: C, outline: outlineCover, turretAxisPoint: p1, turretAxisDir: [0, 0, 1] });
const E = [3.0, -0.4, 1.4];
const zG = 0.2;
const doorY = -0.7;
const ground = Ground.horizontal(zG);

// ═══ 三角形 + 校核结果 ═══
const tris = buildTriangles(E, doorY, ground, mirror, {});
const v = verifyExterior(E, doorY, ground, mirror, { samplePerEdge: 8 });

// ═══ 反射光线: near/far 三角形 AB 边上各取几个点, 解反射点 P ═══
function raysFromEdge(tri, n) {
  const out = [];
  const [A, B] = tri.vertices;
  for (let k = 0; k <= n; k++) {
    const t = k / n;
    const Q = [A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t];
    const pts = findMirrorPointsForTarget(E, Q, mirror);
    if (pts.length) out.push({ eye: E, mirrorPoint: pts[0].point, target: Q });
  }
  return out;
}
const raysNear = raysFromEdge(tris[0], 4);
const raysFar = raysFromEdge(tris[1], 4);

// ═══ 帽面网格 (球面采样, 供 mesh3d) ═══
const N = 24;
const capX = [], capY = [], capZ = [], capI = [], capJ = [], capK = [];
const idx = (i, j) => i * (N + 1) + j;
for (let i = 0; i <= N; i++) {
  for (let j = 0; j <= N; j++) {
    const sx = -1 + 2 * i / N, sy = -1 + 2 * j / N;
    const P = corner(sx, sy, 12);
    capX.push(P[0]); capY.push(P[1]); capZ.push(P[2]);
  }
}
for (let i = 0; i < N; i++) {
  for (let j = 0; j < N; j++) {
    const a = idx(i, j), b = idx(i + 1, j), c = idx(i + 1, j + 1), d = idx(i, j + 1);
    capI.push(a, a); capJ.push(b, c); capK.push(c, d);
  }
}

// ═══ 轴线 (物理模型: 旋转=Y, 折叠=Z; 单元测试内部用 Z 测旋转机构) ═══
function axisLine(point, dir, halfLen) {
  const a = vec3Add(point, vec3Scale(dir, -halfLen));
  const b = vec3Add(point, vec3Scale(dir, halfLen));
  return [a, b];
}
const rotAxis = axisLine(p1, [0, 1, 0], 0.35);   // 旋转轴 Y
const foldAxis = axisLine(p1, [0, 0, 1], 0.35);  // 折叠轴 Z

// ═══ 地面矩形 ═══
const gx = [E[0] - 1, E[0] + 22], gy = [doorY - 5, doorY + 1];
const groundMesh = {
  x: [gx[0], gx[1], gx[1], gx[0]],
  y: [gy[0], gy[0], gy[1], gy[1]],
  z: [zG, zG, zG, zG],
  i: [0, 0], j: [1, 2], k: [2, 3],
};

const data = {
  mirror: {
    sphereCenter: C, radius: R, capCenter, nHat,
    outline: outlineCover, outlineSmall,
    capMesh: { x: capX, y: capY, z: capZ, i: capI, j: capJ, k: capK },
    turretAxisPoint: p1,
  },
  rotationAxis: rotAxis,   // Y
  foldAxis: foldAxis,      // Z
  eye: E, doorOuterY: doorY, groundZ: zG, groundMesh,
  triangles: tris.map((t, i) => ({ name: t.name, vertices: t.vertices, pass: i === 0 ? v.near.pass : v.far.pass })),
  raysNear, raysFar,
  verify: { mirrorPass: v.mirrorPass, nearPass: v.near.pass, farPass: v.far.pass },
};

const out = `// 自动生成 by engine/exterior/vis-dump.js — 外镜建模可视化数据 (测试场景: 大帽 PASS / 小帽 FAIL)\nwindow.VIZ_DATA = ${JSON.stringify(data, null, 2)};\n`;
const outPath = path.join(__dirname, '..', '..', 'public', 'exterior-viz-data.js');
fs.writeFileSync(outPath, out, 'utf8');
console.log(`已写出: ${outPath}`);
console.log(`校核结果: mirrorPass=${v.mirrorPass} near=${v.near.pass} far=${v.far.pass} | 反射线 near=${raysNear.length} far=${raysFar.length}`);
