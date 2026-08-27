/**
 * 平面/地面模型 — 共享 (内镜外镜都用)
 *
 * 从原 engine/ground.js 提出, 只含纯数学的平面模型与射线求交:
 *   - Ground 类: XZ 平面上射线确定的无限大平面 (仅绕 Y 旋转, 无侧倾)
 *   - rayPlaneIntersect: 射线与平面求交
 *
 * 内镜反射法 FOV 相关 (reflectRay/computeFovForEye/verifyAgainstStandard/verifyBinocularUnion)
 * 仍在内镜侧 engine/inner/ground.js。
 */
const { vec3Sub, vec3Add, vec3Scale, vec3Dot } = require('./geometry');

/**
 * 地平面模型 — XZ 平面上射线确定的无限大平面 (仅绕 Y 旋转, 无侧倾)。
 */
class Ground {
  constructor(ref_x = 0.0, ref_z = 0.0, pitch_rad = 0.0) {
    this.ref_x = ref_x; this.ref_z = ref_z; this.pitch_rad = pitch_rad;
  }
  normal() {
    // 地面单位法向量 [sin(φ), 0, cos(φ)]
    return [Math.sin(this.pitch_rad), 0.0, Math.cos(this.pitch_rad)];
  }
  zAtX(x) {
    // 给定 X 坐标处的地面 Z 值
    return this.ref_z + Math.tan(this.pitch_rad) * (x - this.ref_x);
  }
  static fromTwoPoints(front, rear) {
    const dx = rear[0] - front[0];
    const dz = rear[2] - front[2];
    if (Math.abs(dx) < 1e-12) {
      return new Ground(front[0], front[2], 0.0);
    }
    return new Ground(front[0], front[2], Math.atan2(dz, dx));
  }
  static horizontal(z = 0.0) {
    return new Ground(0.0, z, 0.0);
  }
}

/**
 * 射线与平面求交 — 等价 Python ray_plane_intersect (平行返回无穷远点 1e6)
 */
function rayPlaneIntersect(origin, direction, planePoint, planeNormal) {
  const denom = vec3Dot(direction, planeNormal);
  if (Math.abs(denom) < 1e-12) return vec3Add(origin, vec3Scale(direction, 1e6));
  const t = vec3Dot(vec3Sub(planePoint, origin), planeNormal) / denom;
  if (t < 0) return vec3Add(origin, vec3Scale(direction, 1e6));
  return vec3Add(origin, vec3Scale(direction, t));
}

module.exports = { Ground, rayPlaneIntersect };
