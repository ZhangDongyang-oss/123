/**
 * 地面条带定区模型 — 替代竖直三角形, 验证 GB 15084 III 类定区是否为地面区域
 * 近场: 1m 宽, X∈[eye+4, eye+20], Y∈[doorY, doorY+外向1m], 在地面
 * 远场: 4m 宽, X∈[eye+20, eye+60], Y∈[doorY, doorY+外向4m], 在地面
 * 采样每个矩形条带的 4 条边界, 所有采样点可见 → pass
 * 运行: node engine/exterior/verify-ground-strip.js
 */
const fs = require('fs');
const path = require('path');
const { fitSphereFromOutline, projectToSphere } = require('./sphere-fit');
const { ExteriorMirror, sampleVisibility } = require('./exterior-mirror');
const { Ground } = require('../shared/plane');

const DRAFT = path.join(__dirname, '..', '..', 'data', 'exterior', 'exterior-vehicle-draft.json');
const raw = JSON.parse(fs.readFileSync(DRAFT, 'utf8'));
const eyeCenter = raw.driver.eye_center;
const eyes = { left: raw.driver.eye_left_raw, right: raw.driver.eye_right_raw };
const g = raw.ground;
const ground = Ground.fromTwoPoints(g.front_mid, g.rear_mid);
const regulation = raw.regulation;
const flip = p => [p[0], -p[1], p[0]]; // unused placeholder
const flipY = p => [p[0], -p[1], p[2]];

function buildMirror(mir) {
  const fit = fitSphereFromOutline(mir.outline_raw, { srDesign: mir.sr_fit, eye: eyeCenter, supplierCenter: mir.supplier_sphere_center });
  const proj = projectToSphere(mir.outline_raw, fit.center, mir.sr_fit);
  return new ExteriorMirror({ radius: mir.sr_fit, sphereCenter: fit.center, outline: proj,
    turretAxisPoint: mir.turret_axis_p1, turretAxisDir: mir.rotation_axis_dir });
}

// 地面条带校核: 采样矩形边界, 全可见 → pass
function verifyGroundStrip(eyes, doorOuterY, ground, mirror, regulation) {
  const outward = doorOuterY >= 0 ? 1 : -1;
  const x0 = eyeCenter[0];
  const nearX = [x0 + (regulation.dist_near || 4), x0 + (regulation.dist_far || 20)];
  const farX = [x0 + (regulation.dist_far || 20), x0 + 60]; // 60m 代地平线
  const wNear = regulation.width_near || 1, wFar = regulation.width_far || 4;

  function rectEdges(xr, wr) {
    const yIn = doorOuterY, yOut = doorOuterY + outward * wr;
    const edges = [];
    const N = 12;
    for (let i = 0; i <= N; i++) { const t = i / N;
      edges.push({ name: 'inner', Q: [xr[0] + (xr[1]-xr[0])*t, yIn, 0] });
      edges.push({ name: 'outer', Q: [xr[0] + (xr[1]-xr[0])*t, yOut, 0] });
    }
    const M = 6;
    for (let j = 0; j <= M; j++) { const t = j / M;
      edges.push({ name: 'nearX', Q: [xr[0], yIn + (yOut-yIn)*t, 0] });
      edges.push({ name: 'farX',  Q: [xr[1], yIn + (yOut-yIn)*t, 0] });
    }
    return edges;
  }
  function checkRect(xr, wr) {
    let allOk = true, fails = [];
    for (const e of rectEdges(xr, wr)) {
      const Q = [e.Q[0], e.Q[1], ground.zAtX(e.Q[0])];
      const s = sampleVisibility(eyes, Q, mirror, regulation.margin_mm || 3.0);
      if (!s.visible) { allOk = false; fails.push({ name: e.name, Q: Q.map(v=>v.toFixed(2)), reason: s.reason }); }
    }
    return { pass: allOk, fails };
  }
  const near = checkRect(nearX, wNear);
  const far = checkRect(farX, wFar);
  return { nearPass: near.pass, farPass: far.pass, mirrorPass: near.pass && far.pass, nearFails: near.fails, farFails: far.fails };
}

const cases = [
  ['左镜 (真实)', raw.exterior_mirror_left, raw.door_panel.door_outer_Y_left],
  ['右镜 (真实)', raw.exterior_mirror_right, raw.door_panel.door_outer_Y_right],
  ['右镜 (对称化)', (() => { const m = JSON.parse(JSON.stringify(raw.exterior_mirror_left));
    m.outline_raw = m.outline_raw.map(flipY); m.supplier_sphere_center = flipY(m.supplier_sphere_center);
    m.turret_axis_p1 = flipY(m.turret_axis_p1); m.rotation_axis_dir = flipY(m.rotation_axis_dir); return m; })(),
    raw.door_panel.door_outer_Y_right],
];

console.log('═══════ 地面条带定区模型 ═══════');
console.log('近场: 1m宽 X∈[eye+4, eye+20] | 远场: 4m宽 X∈[eye+20, eye+60] | 双眼交集 | 地面采样\n');
for (const [label, mir, doorY] of cases) {
  const mirror = buildMirror(mir);
  const r = verifyGroundStrip(eyes, doorY, ground, mirror, regulation);
  console.log(`${label}: near=${r.nearPass?'✅':'❌'} far=${r.farPass?'✅':'❌'} → ${r.mirrorPass?'✅ PASS':'❌ FAIL'}`);
  if (!r.nearPass) console.log(`  近场失败 ${r.nearFails.length} 点: ${r.nearFails.slice(0,3).map(f=>f.name+'@'+f.Q[0]).join(', ')}...`);
  if (!r.farPass) console.log(`  远场失败 ${r.farFails.length} 点: ${r.farFails.slice(0,3).map(f=>f.name+'@'+f.Q[0]).join(', ')}...`);
}
