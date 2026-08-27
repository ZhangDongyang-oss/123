/**
 * 向量运算 / 旋转矩阵 / 射线求交
 * 等价于 Python 版 mirror_fov/engine.py 中的基础几何函数
 */

// 向量运算 (所有都是 [x, y, z] 数组)
function vec3Add(a, b) { return [a[0]+b[0], a[1]+b[1], a[2]+b[2]]; }
function vec3Sub(a, b) { return [a[0]-b[0], a[1]-b[1], a[2]-b[2]]; }
function vec3Scale(a, s) { return [a[0]*s, a[1]*s, a[2]*s]; }
function vec3Dot(a, b) { return a[0]*b[0] + a[1]*b[1] + a[2]*b[2]; }
function vec3Cross(a, b) {
  return [
    a[1]*b[2] - a[2]*b[1],
    a[2]*b[0] - a[0]*b[2],
    a[0]*b[1] - a[1]*b[0],
  ];
}
function vec3Norm(a) { return Math.sqrt(a[0]*a[0] + a[1]*a[1] + a[2]*a[2]); }
function vec3Normalize(a) {
  const n = vec3Norm(a);
  return n < 1e-12 ? [0,0,0] : [a[0]/n, a[1]/n, a[2]/n];
}

// 旋转矩阵 (3x3, 行主序: mat[row][col])
function rotZ(angle) {
  const c = Math.cos(angle), s = Math.sin(angle);
  return [[c,-s,0],[s,c,0],[0,0,1]];
}
function rotY(angle) {
  const c = Math.cos(angle), s = Math.sin(angle);
  return [[c,0,s],[0,1,0],[-s,0,c]];
}

// R = Rz(yaw) @ Ry(pitch)
function rotZY(yaw, pitch) {
  return matMul(rotZ(yaw), rotY(pitch));
}

// 矩阵乘法 3x3 @ 3x3
function matMul(a, b) {
  const r = [[0,0,0],[0,0,0],[0,0,0]];
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++)
      for (let k = 0; k < 3; k++)
        r[i][j] += a[i][k] * b[k][j];
  return r;
}

// 矩阵 @ 向量
function matVec(m, v) {
  return [
    m[0][0]*v[0] + m[0][1]*v[1] + m[0][2]*v[2],
    m[1][0]*v[0] + m[1][1]*v[1] + m[1][2]*v[2],
    m[2][0]*v[0] + m[2][1]*v[1] + m[2][2]*v[2],
  ];
}

// 注: reflectRay / rayPlaneIntersect 曾在此定义但与 Python 语义不符
// (reflectRay 只返回方向非 [点,方向] 元组; rayPlaneIntersect 返回 {t,point}/null 非 1e6 远点回退)。
// 正确实现见 ground.js, 由 computeFovForEye 等使用。此处已删除避免误用。
// reflectPointAcrossPlane 保留 (被 five-line.js / virtual-image.js / routes.js 使用)。

/**
 * 虚像眼点: 眼点关于镜面的对称点
 * 等价于 Python virtual_image.py::reflect_point_across_plane
 */
function reflectPointAcrossPlane(point, planePoint, planeNormal) {
  const d = vec3Dot(vec3Sub(point, planePoint), planeNormal);
  return vec3Sub(point, vec3Scale(planeNormal, 2 * d));
}

/**
 * 罗德里格斯旋转: 向量 v 绕单位轴 k 旋转 angleRad
 * v' = v·cosθ + (k×v)·sinθ + k·(k·v)·(1−cosθ)
 * @param {number[]} v     - 被旋转向量 (3,)
 * @param {number[]} k     - 旋转轴 (3, 内部归一化)
 * @param {number}   angle - 旋转角 (rad)
 * @returns {number[]|null} 旋转后向量或 null (非法输入)
 */
function rodriguesRotate(v, k, angle) {
  if (!v.every(Number.isFinite) || !k.every(Number.isFinite) || !Number.isFinite(angle)) return null;
  const kU = vec3Normalize(k);
  if (vec3Norm(kU) < 1e-12) return null; // 零轴
  const c = Math.cos(angle), s = Math.sin(angle);
  const kv = vec3Dot(kU, v), cr = vec3Cross(kU, v);
  return [
    v[0] * c + cr[0] * s + kU[0] * kv * (1 - c),
    v[1] * c + cr[1] * s + kU[1] * kv * (1 - c),
    v[2] * c + cr[2] * s + kU[2] * kv * (1 - c),
  ];
}

/**
 * 点 X 绕「过 axisPoint、沿 axisDir 的直线」旋转 angleRad
 * X' = axisPoint + Rodrigues(X − axisPoint, k, angle)
 * @returns {number[]|null} 旋转后点或 null (非法输入)
 */
function rotatePointAroundAxis(X, axisPoint, axisDir, angle) {
  if (!X.every(Number.isFinite) || !axisPoint.every(Number.isFinite) || !axisDir.every(Number.isFinite) || !Number.isFinite(angle)) return null;
  const kU = vec3Normalize(axisDir);
  if (vec3Norm(kU) < 1e-12) return null;
  const r = rodriguesRotate(vec3Sub(X, axisPoint), kU, angle);
  return r === null ? null : vec3Add(axisPoint, r);
}

module.exports = {
  vec3Add, vec3Sub, vec3Scale, vec3Dot, vec3Cross,
  vec3Norm, vec3Normalize,
  rotZ, rotY, rotZY, matMul, matVec,
  reflectPointAcrossPlane,
  rodriguesRotate, rotatePointAroundAxis,
};
