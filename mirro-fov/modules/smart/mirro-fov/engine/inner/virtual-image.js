/**
 * 虚像眼法 FOV — 等价于 Python virtual_image.py
 * compute_eye_virtual_image / compute_target_virtual_image / compute_fov_via_virtual_eye / check_point_in_mirror_fov
 *
 * 参考判据 (非主判据): 用虚像眼点计算视野, 与反射法等价。
 */
const { vec3Sub, vec3Add, vec3Scale, vec3Dot, vec3Norm, vec3Normalize, reflectPointAcrossPlane } = require('../shared/geometry');

/**
 * 计算眼点虚像 — 等价 Python compute_eye_virtual_image
 */
function computeEyeVirtualImage(eye, mirror, eyeLabel = '') {
  const virtualEye = reflectPointAcrossPlane(eye, mirror.center, mirror.normal);
  return { eyeLabel, eye, virtualEye };
}

/**
 * 计算任意目标点虚像 — 等价 Python compute_target_virtual_image
 */
function computeTargetVirtualImage(target, mirror, label = '') {
  const virtualImage = reflectPointAcrossPlane(target, mirror.center, mirror.normal);
  return { label, point: target, virtualImage };
}

/**
 * 虚像眼法视野 — 等价 Python compute_fov_via_virtual_eye
 * 从虚像眼出发, 穿过镜面四角延伸到远点平面
 */
function computeFovViaVirtualEye(eye, mirror, farPlaneX, eyeLabel = 'center') {
  const eve = computeEyeVirtualImage(eye, mirror, eyeLabel);
  const v = eve.virtualEye;
  const corners = mirror.corners();
  const farNormal = [-1.0, 0.0, 0.0];
  const farPlanePt = [farPlaneX, 0.0, 0.0];

  const hits = corners.map(cp => {
    let dir = vec3Normalize(vec3Sub(cp, v)); // 虚像眼指向镜面角点 (+X)
    const denom = vec3Dot(dir, farNormal);
    if (Math.abs(denom) < 1e-12) return vec3Add(cp, vec3Scale(dir, 1e6));
    const t = vec3Dot(vec3Sub(farPlanePt, cp), farNormal) / denom;
    return t < 0 ? vec3Add(cp, vec3Scale(dir, 1e6)) : vec3Add(cp, vec3Scale(dir, t));
  });

  const ys = hits.map(p => p[1]), zs = hits.map(p => p[2]);
  const yMin = Math.min(...ys), yMax = Math.max(...ys);
  const zMin = Math.min(...zs), zMax = Math.max(...zs);

  return {
    eyeLabel, virtualEye: v.slice(),
    mirrorCornerVirtualImages: corners.map(c => c.slice()),
    fovConeApex: v.slice(),
    hits,
    visibleBBox: [yMin, yMax, zMin, zMax],
  };
}

/**
 * 判断目标点是否在单眼视野内 — 等价 Python check_point_in_mirror_fov
 * @returns {{inFov:boolean, hit:number[]|null}}
 */
function checkPointInMirrorFov(target, eye, mirror) {
  // 目标点虚像
  const tv = computeTargetVirtualImage(target, mirror, 'target');
  const [i0, i1] = [tv.virtualImage, eye]; // 虚像点 → 眼点连线
  const d = vec3Sub(i1, i0);
  const dLen = vec3Norm(d);
  if (dLen < 1e-10) return { inFov: false, hit: null };
  const dU = vec3Normalize(d);
  const denom = vec3Dot(dU, mirror.normal);
  if (Math.abs(denom) < 1e-12) return { inFov: false, hit: null };
  const t = vec3Dot(vec3Sub(mirror.center, i0), mirror.normal) / denom;
  if (t < -1e-6 || t > dLen + 1e-6) return { inFov: false, hit: null };
  const hit = vec3Add(i0, vec3Scale(dU, t));
  const offset = vec3Sub(hit, mirror.center);
  const lx = vec3Dot(offset, mirror.rightVec);
  const ly = vec3Dot(offset, mirror.upVec);
  return { inFov: mirror.isOnReflectiveSurface(lx * 1000, ly * 1000), hit };
}

module.exports = { computeEyeVirtualImage, computeTargetVirtualImage, computeFovViaVirtualEye, checkPointInMirrorFov };
