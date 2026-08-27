/**
 * 球面反射纯数学核心 — 外后视镜 (GB 15084 II/III 类)
 *
 * 内后视镜是平面镜, 外后视镜是凸球面镜 (SR 依车型)。光线在球面某点 P 反射,
 * 法线 = normalize(P − 球心 C)。这两个函数是全部外镜算法的原子原语, 独立可测。
 *
 * 坐标: 整车坐标系 (X+=后方, Y+=乘客右, Z+=上), 长度 m。
 * NaN/非有限输入 → 返回 null (照搬内镜 isOnReflectiveSurface 的 NaN 防御原则, 绝不让假值穿透)。
 */
const { vec3Sub, vec3Scale, vec3Dot, vec3Norm, vec3Normalize, vec3Add } = require('../shared/geometry');

function allFiniteVec(v) { return Array.isArray(v) && v.length >= 3 && v.every(Number.isFinite); }

/**
 * 射线与球面求交 — 精确公式 (二次方程闭式解)
 * 射线 P(t) = o + t·d (d 需归一化或给定方向), 球面 |P − c|² = R²
 *   展开: a·t² + b·t + c = 0
 *     a = d·d        (d 归一化后 a = 1)
 *     b = 2·(oc·d)   oc = o − c
 *     c = |oc|² − R²
 *   Δ = b² − 4ac  →  a=1 时 t = (−b ± √Δ) / 2
 * @param {number[]} o - 射线原点 (3,)
 * @param {number[]} d - 射线方向 (3,) (内部归一化)
 * @param {number[]} c - 球心 (3,)
 * @param {number} R  - 球面半径 (m), 须 > 0
 * @returns {{t:number, point:number[]}|null} 最近交点或 null (不打到球/球在身后/非法输入)
 */
function raySphereIntersect(o, d, c, R) {
  if (!allFiniteVec(o) || !allFiniteVec(d) || !allFiniteVec(c) || !Number.isFinite(R) || R <= 0) return null;
  const dU = vec3Normalize(d);
  if (vec3Norm(dU) < 1e-12) return null;

  const oc = vec3Sub(o, c);
  const b  = 2 * vec3Dot(oc, dU);        // b 项 (d 归一化, a=1)
  const cq = vec3Dot(oc, oc) - R * R;    // c 项
  const disc = b * b - 4 * cq;           // Δ = b² − 4c (a=1)
  if (disc < 0) return null;             // 无实根 → 光线不打到球
  const s = Math.sqrt(disc);
  const tNear = (-b - s) / 2;
  const tFar  = (-b + s) / 2;

  let t;
  if (tNear >= 0) t = tNear;             // 最近正根 (常规: 眼在球外, 取近侧交点)
  else if (tFar >= 0) t = tFar;          // 眼在球内 → 近根为负, 取远根
  else return null;                      // 两根均负 → 球在身后
  if (!Number.isFinite(t)) return null;

  return { t, point: vec3Add(o, vec3Scale(dU, t)) };
}

/**
 * 球面反射方向 — 法线 n = normalize(P − c) (凸球, 指向球心)
 *   反射 r = d − 2(d·n)·n, 再归一化
 * @param {number[]} d - 入射方向 (单位向量优先)
 * @param {number[]} P - 球面交点 (3,)
 * @param {number[]} c - 球心 (3,)
 * @returns {number[]|null} 反射方向或 null (非法输入)
 */
function sphereReflectDir(d, P, c) {
  if (!allFiniteVec(d) || !allFiniteVec(P) || !allFiniteVec(c)) return null;
  const n = vec3Normalize(vec3Sub(P, c));
  if (vec3Norm(n) < 1e-12) return null;  // P === c (球心处, 法线未定义)
  const dn = vec3Dot(d, n);
  const r = vec3Sub(d, vec3Scale(n, 2 * dn));
  const rU = vec3Normalize(r);
  return vec3Norm(rU) < 1e-12 ? null : rU;
}

module.exports = { raySphereIntersect, sphereReflectDir };
