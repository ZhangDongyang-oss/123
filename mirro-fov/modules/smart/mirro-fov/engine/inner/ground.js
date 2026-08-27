/**
 * 反射法 FOV — 内镜 (参考判据)
 *
 * 从原 engine/ground.js 提出内镜专用部分: 反射法 FOV / 双眼并集 / 单眼判据。
 * 共享的 Ground 类 + rayPlaneIntersect 已在 engine/shared/plane.js。
 * 这些在 Python 中作为"参考信息", JS 端同样仅计算供报告, 不参与五线法 PASS 判定。
 */
const { vec3Sub, vec3Add, vec3Scale, vec3Dot, vec3Norm, vec3Normalize } = require('../shared/geometry');
const { Ground, rayPlaneIntersect } = require('../shared/plane');

/**
 * 反射射线 — 等价 Python reflect_ray (反向追踪)
 * @returns {number[][]} [mirror_point, reflect_dir]
 */
function reflectRay(eye, mirrorPoint, normal) {
  const incident = vec3Normalize(vec3Sub(mirrorPoint, eye));
  let reflectDir = vec3Sub(incident, vec3Scale(normal, 2 * vec3Dot(incident, normal)));
  reflectDir = vec3Normalize(reflectDir);
  return [mirrorPoint, reflectDir];
}

/**
 * 单眼点反射法 FOV — 等价 Python compute_fov_for_eye (镜面角点 + 每边30点采样)
 */
function computeFovForEye(eye, mirror, farPlaneX, ground = null) {
  if (!ground) ground = Ground.horizontal(0.0);
  const normal = mirror.normal;
  const farNormal = [-1.0, 0.0, 0.0];
  const farPlanePt = [farPlaneX, 0.0, 0.0];

  const corners = mirror.corners();
  const reflectedCorners = corners.map(cp => {
    const [, rdir] = reflectRay(eye, cp, normal);
    return rayPlaneIntersect(cp, rdir, farPlanePt, farNormal);
  });

  const edgePts = mirror.sampleEdges(30);
  const reflectedEdges = edgePts.map(ep => {
    const [, rdir] = reflectRay(eye, ep, normal);
    return rayPlaneIntersect(ep, rdir, farPlanePt, farNormal);
  });

  const allPoints = reflectedCorners.concat(reflectedEdges);
  const ys = allPoints.map(p => p[1]), zs = allPoints.map(p => p[2]);
  const yMin = Math.min(...ys), yMax = Math.max(...ys);
  const zMin = Math.min(...zs), zMax = Math.max(...zs);

  const groundNormal = ground.normal();
  const groundPt = [ground.ref_x, 0.0, ground.ref_z];
  const groundHits = corners.map(cp => {
    const [, rdir] = reflectRay(eye, cp, normal);
    return rayPlaneIntersect(cp, rdir, groundPt, groundNormal);
  });

  return {
    eyePoint: eye.slice(),
    reflectedCorners, reflectedEdgePoints: reflectedEdges,
    visibleBBox: [yMin, yMax, zMin, zMax],
    groundIntersection: groundHits,
  };
}

/**
 * 单眼判据 — 等价 Python verify_against_standard
 */
function verifyAgainstStandard(fov, requiredWidth, farPlaneX, ground = null, eyeLabel = 'center', coverageYtol = 0.5, groundZtol = 1.0) {
  if (!ground) ground = Ground.horizontal(0.0);
  const [yMin, yMax, zMin, zMax] = fov.visibleBBox;
  const visibleWidth = yMax - yMin;
  const halfReq = requiredWidth / 2;
  const widthPass = visibleWidth >= requiredWidth;
  const coveragePass = (yMin <= -halfReq + coverageYtol) && (yMax >= halfReq - coverageYtol);
  const groundZAtFar = ground.zAtX(farPlaneX);
  const groundVisible = zMin <= groundZAtFar + groundZtol;
  const passed = widthPass && coveragePass;
  return {
    passed, eyeLabel,
    visibleWidthAtFar: visibleWidth, requiredWidthAtFar: requiredWidth,
    visibleZMin: zMin, visibleZMax: zMax, groundVisibleAtFar: groundVisible,
    details: { yRange: [yMin, yMax], zRange: [zMin, zMax], widthPass, coveragePass },
  };
}

/**
 * 双眼并集判据 — 等价 Python verify_binocular_union
 */
function verifyBinocularUnion(fovLeft, fovRight, requiredWidth, farPlaneX, ground = null, coverageYtol = 0.5, groundZtol = 1.0) {
  if (!ground) ground = Ground.horizontal(0.0);
  const [ly0, ly1, lz0, lz1] = fovLeft.visibleBBox;
  const [ry0, ry1, rz0, rz1] = fovRight.visibleBBox;
  const yMin = Math.min(ly0, ry0), yMax = Math.max(ly1, ry1);
  const zMin = Math.min(lz0, rz0), zMax = Math.max(lz1, rz1);
  const visibleWidth = yMax - yMin;
  const halfReq = requiredWidth / 2;
  const widthPass = visibleWidth >= requiredWidth;
  const coveragePass = (yMin <= -halfReq + coverageYtol) && (yMax >= halfReq - coverageYtol);
  const groundZAtFar = ground.zAtX(farPlaneX);
  const groundVisible = zMin <= groundZAtFar + groundZtol;
  const passed = widthPass && coveragePass;
  return {
    passed, eyeLabel: '双眼并集',
    visibleWidthAtFar: visibleWidth, requiredWidthAtFar: requiredWidth,
    visibleZMin: zMin, visibleZMax: zMax, groundVisibleAtFar: groundVisible,
    details: {
      yRange: [yMin, yMax], zRange: [zMin, zMax],
      widthPass, coveragePass,
      leftYRange: [ly0, ly1], rightYRange: [ry0, ry1],
    },
  };
}

module.exports = { reflectRay, computeFovForEye, verifyAgainstStandard, verifyBinocularUnion };
