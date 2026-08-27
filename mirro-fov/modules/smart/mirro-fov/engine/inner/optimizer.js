/**
 * pitch 优化 — 等价于 Python optimizer.py::optimize_pitch (二分搜索, 反射法)
 *
 * 参考判据: 二分找最优 pitch, 使中心眼远点平面 Z_min 刚好触及地面。
 * 不参与五线法 PASS 判定。
 *
 * 注意 pitch 符号约定: 在 R=Rz(yaw)@Ry(pitch) 旋转下, pitch 越正 → 法线越上仰 →
 * 反射光线越向下 → Z_min 越低 (越能看到地面)。故默认 pitchRange 含正 pitch。
 * (Python optimizer.py 文档曾误记为"pitch 越负视野越向下", 实际相反, 默认 (-30,-1)
 *  范围永远走不到二分主路径 — 此 JS 版已修正默认范围。)
 */
const { Mirror } = require('./mirror');
const { computeFovForEye, verifyAgainstStandard } = require('./ground');
const { Ground } = require('../shared/plane');

/**
 * 二分搜索最优 pitch 角, 使中心眼远点平面 Z_min <= 地面 Z + z_margin
 * @param {Object} params
 * @returns {Object} PitchOptResult
 */
function optimizePitch({
  mirror, eyePoints, farDistance, requiredWidth,
  ground = null, pitchRange = [-5.0, 15.0],
  zMargin = 0.0, tol = 0.1, maxIter = 50,
}) {
  if (!ground) ground = Ground.horizontal(0.0);
  const eyeCx = eyePoints.center;
  const farPlaneX = eyeCx[0] + farDistance;
  const targetZ = ground.zAtX(farPlaneX) + zMargin;

  let [pLo, pHi] = pitchRange;
  if (Math.abs(pLo) < Math.abs(pHi)) { const t = pLo; pLo = pHi; pHi = t; }

  const searchLog = [];

  function evalZmin(pitchDeg) {
    const m = new Mirror({
      width: mirror.width, height: mirror.height,
      pivot: mirror.pivot.slice(), armOffset: mirror.armOffset.slice(),
      yaw: mirror.yaw, pitch: pitchDeg * Math.PI / 180,
    });
    const fov = computeFovForEye(eyeCx, m, farPlaneX, ground);
    return [fov.visibleBBox[2], fov];
  }

  const [zAtLo] = evalZmin(pLo);
  const [zAtHi] = evalZmin(pHi);
  searchLog.push([pLo, zAtLo], [pHi, zAtHi]);

  // 最小负角度仍未看到地面 → 全范围无法满足, 用 p_lo
  if (zAtLo > targetZ) {
    const [, fovBest] = evalZmin(pLo);
    const vc = verifyAgainstStandard(fovBest, requiredWidth, farPlaneX, ground, '中心眼');
    return { optimalPitchDeg: pLo, fovCenter: fovBest, verifyCenter: vc,
      zMinAtFar: zAtLo, visibleWidth: vc.visibleWidthAtFar, converged: false, searchLog };
  }
  // 最小负角度已看到地面 → 直接用 (边界收敛)
  if (zAtHi <= targetZ) {
    const [, fovBest] = evalZmin(pHi);
    const vc = verifyAgainstStandard(fovBest, requiredWidth, farPlaneX, ground, '中心眼');
    return { optimalPitchDeg: pHi, fovCenter: fovBest, verifyCenter: vc,
      zMinAtFar: zAtHi, visibleWidth: vc.visibleWidthAtFar, converged: true, searchLog };
  }

  // 二分: z_at_lo <= target, z_at_hi > target
  let lo = pLo, hi = pHi;
  let bestPitch = pHi, bestFov = null, bestZmin = 0.0, converged = false;

  for (let i = 0; i < maxIter; i++) {
    const mid = (lo + hi) / 2;
    const [zMid, fovMid] = evalZmin(mid);
    searchLog.push([mid, zMid]);
    if (Math.abs(zMid - targetZ) <= tol) { bestPitch = mid; bestFov = fovMid; bestZmin = zMid; converged = true; break; }
    if (zMid <= targetZ) lo = mid; else hi = mid;
    bestFov = fovMid; bestZmin = zMid;
  }

  if (!converged && (bestFov === null || bestZmin > targetZ)) {
    bestPitch = lo;
    const [zLoF, fovLoF] = evalZmin(lo);
    bestFov = fovLoF; bestZmin = zLoF;
  }

  const vc = verifyAgainstStandard(bestFov, requiredWidth, farPlaneX, ground, '中心眼');
  return { optimalPitchDeg: bestPitch, fovCenter: bestFov, verifyCenter: vc,
    zMinAtFar: bestZmin, visibleWidth: vc.visibleWidthAtFar, converged, searchLog };
}

module.exports = { optimizePitch };
