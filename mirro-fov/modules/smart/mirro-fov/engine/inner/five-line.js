/**
 * 五线校核 — 等价于 Python engine.py::five_line_verification
 * 主判据: 5 条射线全部命中反射面 → PASS
 */
const { vec3Sub, vec3Add, vec3Scale, vec3Dot, vec3Normalize } = require('../shared/geometry');
const { reflectPointAcrossPlane } = require('../shared/geometry');
const { checkLineThroughRearWindow } = require('./rear-window');

/**
 * 2D 点在三角形内 (重心坐标) — 等价 Python engine.py::pt_in_triangle
 */
function ptInTriangle(p, t) {
  const [px, py] = p;
  const a = t[0], b = t[1], c = t[2];
  const v0 = [b[0] - a[0], b[1] - a[1]];
  const v1 = [c[0] - a[0], c[1] - a[1]];
  const v2 = [px - a[0], py - a[1]];
  const d00 = v0[0] * v0[0] + v0[1] * v0[1];
  const d01 = v0[0] * v1[0] + v0[1] * v1[1];
  const d11 = v1[0] * v1[0] + v1[1] * v1[1];
  const d20 = v2[0] * v0[0] + v2[1] * v0[1];
  const d21 = v2[0] * v1[0] + v2[1] * v1[1];
  const denom = d00 * d11 - d01 * d01;
  if (Math.abs(denom) < 1e-12) return false;
  const beta = (d11 * d20 - d01 * d21) / denom;
  const gamma = (d00 * d21 - d01 * d20) / denom;
  return beta >= -1e-9 && gamma >= -1e-9 && (beta + gamma) <= 1 + 1e-9;
}

/**
 * 2D 凸包 (Andrew monotone chain) — 等价 scipy.spatial.ConvexHull
 * @param {number[][]} pts - [[x,y],...]
 * @returns {number[][]} 凸包顶点 (逆时针), 去重尾点
 */
function convexHull2D(pts) {
  if (pts.length < 3) return pts.slice();
  const sorted = pts.slice().sort((a, b) => a[0] === b[0] ? a[1] - b[1] : a[0] - b[0]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (const p of sorted.reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop(); upper.pop();
  return lower.concat(upper);
}

/**
 * 计算虚像眼点
 * 等价于 Python virtual_image.py::compute_eye_virtual_image
 */
function computeVirtualEye(eye, mirror) {
  const virtualEye = reflectPointAcrossPlane(eye, mirror.center, mirror.normal);
  return { eye, virtualEye };
}

/**
 * 射线与镜面平面求交, 返回 { hit3D, lx, ly } 或 null
 * 等价于 Python five_line_verification::_plane_intersect
 */
function planeIntersect(virtualEye, target, mirror) {
  const d = vec3Sub(target, virtualEye);
  const dLen = vec3Dot(d, d);
  if (dLen < 1e-20) return null;
  const dU = vec3Normalize(d);
  const den = vec3Dot(dU, mirror.normal);
  if (Math.abs(den) < 1e-12) return null;
  const t = vec3Dot(vec3Sub(mirror.center, virtualEye), mirror.normal) / den;
  const dLenNorm = Math.sqrt(dLen);
  if (t < 1e-6 || t > dLenNorm - 1e-6) return null;
  const hit = vec3Add(virtualEye, vec3Scale(dU, t));
  const offset = vec3Sub(hit, mirror.center);
  const lx = vec3Dot(offset, mirror.rightVec) * 1000;
  const ly = vec3Dot(offset, mirror.upVec) * 1000;
  return { hit3D: hit, lx, ly };
}

/**
 * 五线校核
 * @param {Object} params
 * @param {Object[]} params.virtualEyes - [{eye, virtualEye}, ...] 左/右/中
 * @param {Mirror} params.mirror
 * @param {number[][]} params.regEndpoints - [left_ep, right_ep] 法规端点
 * @returns {Object} FiveLineVerificationResult
 */
function fiveLineVerification({ virtualEyes, mirror, regEndpoints, rearWindow }) {
  const [leftVi, rightVi, centerVi] = virtualEyes;
  const [leftEp, rightEp] = regEndpoints;

  // 中心眼 3 条线: BL, BR, +X
  const rearDir = [1, 0, 0];
  const triHits = [
    planeIntersect(centerVi.virtualEye, leftEp, mirror),
    planeIntersect(centerVi.virtualEye, rightEp, mirror),
    planeIntersect(centerVi.virtualEye, vec3Add(centerVi.virtualEye, vec3Scale(rearDir, 100)), mirror),
  ];

  // 交叉线: 左眼→BR, 右眼→BL
  const crossHits = [
    planeIntersect(leftVi.virtualEye, rightEp, mirror),
    planeIntersect(rightVi.virtualEye, leftEp, mirror),
  ];

  // 三角形顶点 (中心眼 3 点) + 交叉线落三角形 (信息项) — 等价 Python
  const triPts = triHits.map(h => (h ? [h.lx, h.ly] : null));
  const crossInTri = crossHits.map(h => (h && triPts.every(p => p !== null) ? ptInTriangle([h.lx, h.ly], triPts) : false));

  // 判定
  const triOnMirror = triHits.every(h => h !== null && mirror.isOnReflectiveSurface(h.lx, h.ly));
  const crossOnMirror = crossHits.every(h => h !== null && mirror.isOnReflectiveSurface(h.lx, h.ly));
  const mirrorPass = triOnMirror && crossOnMirror;

  // 构建 5 条线结果
  const lineData = [
    { eyeLabel: "C", endpointLabel: "BL", virtualEye: centerVi.virtualEye, target: leftEp, hit: triHits[0] },
    { eyeLabel: "C", endpointLabel: "BR", virtualEye: centerVi.virtualEye, target: rightEp, hit: triHits[1] },
    { eyeLabel: "C", endpointLabel: "+X", virtualEye: centerVi.virtualEye, target: vec3Add(centerVi.virtualEye, vec3Scale(rearDir, 100)), hit: triHits[2] },
    { eyeLabel: "L", endpointLabel: "BR", virtualEye: leftVi.virtualEye, target: rightEp, hit: crossHits[0] },
    { eyeLabel: "R", endpointLabel: "BL", virtualEye: rightVi.virtualEye, target: leftEp, hit: crossHits[1] },
  ];

  const lineDetails = lineData.map(ld => {
    // 后挡风穿透 (每条线: 虚像眼→目标线段穿玻璃)
    let rwThrough = false, rwHit = null;
    if (rearWindow) {
      const rw = checkLineThroughRearWindow(ld.virtualEye, ld.target, rearWindow);
      rwThrough = rw.through; rwHit = rw.hit;
    }
    return {
      eyeLabel: ld.eyeLabel,
      endpointLabel: ld.endpointLabel,
      rayOrigin: ld.virtualEye.slice(),
      rayTarget: ld.target.slice(),
      mirrorHit: ld.hit ? ld.hit.hit3D : null,
      onMirror: ld.hit ? mirror.isOnReflectiveSurface(ld.hit.lx, ld.hit.ly) : false,
      lx: ld.hit ? ld.hit.lx : null,
      ly: ld.hit ? ld.hit.ly : null,
      rearWindowHit: rwHit,
      throughTransparent: rwThrough,
    };
  });

  const nHit = lineDetails.filter(l => l.onMirror).length;
  // 后挡风穿透 (仅报告, 非硬判据): 中心眼 3 线交点全落透光区 → True
  const rearWindowPass = rearWindow
    ? lineDetails.slice(0, 3).every(l => l.throughTransparent)
    : null;
  const failureDetails = [];
  for (const ld of lineDetails) {
    if (ld.mirrorHit === null) {
      failureDetails.push(`${ld.eyeLabel}→${ld.endpointLabel}: 射线未与镜面平面相交`);
    } else if (!ld.onMirror) {
      failureDetails.push(`${ld.eyeLabel}→${ld.endpointLabel}: 交点超出镜面 (lx=${ld.lx.toFixed(1)} ly=${ld.ly.toFixed(1)}mm)`);
    }
  }

  // 法规区在镜面上的投影凸包 (5 交点, 若全命中) — 等价 Python _convex_hull_on_mirror
  const outerHits = lineDetails.filter(l => l.mirrorHit !== null).map(l => l.mirrorHit);
  let mirrorProjectionCorners = null;
  if (outerHits.length >= 3) {
    const local = outerHits.map(p => {
      const off = vec3Sub(p, mirror.center);
      return [vec3Dot(off, mirror.rightVec), vec3Dot(off, mirror.upVec)];
    });
    const hull = convexHull2D(local);
    mirrorProjectionCorners = hull.map(idxPt => {
      // convexHull2D 返回原对象引用, 需定位回 3D 点
      const lx = idxPt[0], ly = idxPt[1];
      return vec3Add(mirror.center, vec3Add(vec3Scale(mirror.rightVec, lx), vec3Scale(mirror.upVec, ly)));
    });
  }

  return {
    mirrorPass, nHit, nTot: 5, lineDetails, failureDetails, rearWindowPass,
    mirrorProjectionCorners,
    crossInTriangle: { 'L→BR_in_triangle': crossInTri[0], 'R→BL_in_triangle': crossInTri[1] },
  };
}

module.exports = { computeVirtualEye, fiveLineVerification };
