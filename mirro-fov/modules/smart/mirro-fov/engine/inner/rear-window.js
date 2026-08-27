/**
 * 后挡风 (RearWindow) 计算 — 内镜 (等价于 Python models.py::RearWindow + engine.py::check_line_through_rear_window)
 *
 * 从原 engine/rear-window.js 提出内镜专用部分: 后挡风建模/穿透/投影。
 * 共享的 2D 几何谓词 (pointInPolygon2D/edgeDistanceTo) 已在 engine/shared/polygon.js。
 *
 * 后挡风: CAS 外框 (outline, N 点) + 透光区 (transparentZone, M 点, 可选)。
 * through 判定基于后挡风外框 outline (暂不考虑透光区)。
 * 黑边 = outline 与 transparentZone 之间的区域, 距离要求由其他人员单独测量。
 */
const { vec3Sub, vec3Add, vec3Scale, vec3Dot, vec3Cross, vec3Norm, vec3Normalize } = require('../shared/geometry');
const { pointInPolygon2D } = require('../shared/polygon');

/**
 * 由 outline 构建后挡风对象 (平面点 + 平面法线拟合)
 * @param {number[][]} outline - CAS 轮廓顶点 (N,3), 整车坐标 m
 * @param {number[][]} [transparentZone] - 透光区顶点 (M,3), 可选
 * @returns {{outline:number[][], transparentZone:number[][], tz:number[][],
 *            planePoint:number[], planeNormal:number[]}}
 */
function buildRearWindow(outline, transparentZone) {
  if (!Array.isArray(outline) || outline.length < 3) {
    throw new Error(`outline 必须为 (N,3) 且 N≥3, 实际 ${outline && outline.length}`);
  }
  // 透光区 fallback: transparentZone 为空/缺失时退化用 outline (空数组 [] 是 truthy, 需显式判长度)
  const tz = (transparentZone && transparentZone.length >= 3) ? transparentZone : outline;

  // plane_point = outline 质心
  const nPts = outline.length;
  const planePoint = [0, 0, 0];
  for (const p of outline) { planePoint[0] += p[0]; planePoint[1] += p[1]; planePoint[2] += p[2]; }
  planePoint[0] /= nPts; planePoint[1] /= nPts; planePoint[2] /= nPts;

  // plane_normal: 用「不共线」的 3 点叉积 (前 3 点可能共线 → 法线不稳定)
  // 取: 首点 + 离首点最远的点 + 离该连线最远的点, 三点必不共线
  const p0 = outline[0];
  let p1 = outline[1], maxD = -1;
  for (const p of outline) {
    const d = vec3Norm(vec3Sub(p, p0));
    if (d > maxD) { maxD = d; p1 = p; }
  }
  const dir = vec3Normalize(vec3Sub(p1, p0));
  let p2 = outline[1], maxCross = -1;
  for (const p of outline) {
    const cross = vec3Norm(vec3Cross(vec3Sub(p, p0), dir));
    if (cross > maxCross) { maxCross = cross; p2 = p; }
  }
  let n = vec3Cross(vec3Sub(p1, p0), vec3Sub(p2, p0));
  const norm = vec3Norm(n);
  if (norm < 1e-12) throw new Error('后挡风轮廓退化, 无法拟合平面法线');
  n = vec3Scale(n, 1 / norm);
  if (n[0] > 0) n = vec3Scale(n, -1); // 法线朝 −X (车内侧)

  return { outline, transparentZone, tz, planePoint, planeNormal: n };
}

/**
 * 线段与平面求交 (只接受线段内部的交点) — 等价 Python line_segment_plane_intersect
 * @returns {number[]|null} 交点 (3,) 或 null
 */
function lineSegmentPlaneIntersect(p1, p2, planePoint, planeNormal) {
  const d = vec3Sub(p2, p1);
  const denom = vec3Dot(d, planeNormal);
  if (Math.abs(denom) < 1e-12) return null;
  const t = vec3Dot(vec3Sub(planePoint, p1), planeNormal) / denom;
  if (t < -1e-6 || t > 1.0 + 1e-6) return null;
  return vec3Add(p1, vec3Scale(d, t));
}

/**
 * 3D 点是否在 3D 多边形内 (投影到最大法线分量丢弃的平面) — 等价 Python check_point_in_polygon_3d
 */
function pointInPolygon3D(point, polygon, planeNormal) {
  const absN = planeNormal.map(Math.abs);
  let pt2d, poly2d;
  if (absN[0] >= absN[1] && absN[0] >= absN[2]) {
    pt2d = [point[1], point[2]];
    poly2d = polygon.map(p => [p[1], p[2]]);
  } else if (absN[1] >= absN[0] && absN[1] >= absN[2]) {
    pt2d = [point[0], point[2]];
    poly2d = polygon.map(p => [p[0], p[2]]);
  } else {
    pt2d = [point[0], point[1]];
    poly2d = polygon.map(p => [p[0], p[1]]);
  }
  return pointInPolygon2D(pt2d, poly2d);
}

/**
 * 检查线段是否命中后挡风外框 (outline 内) — 等价 Python check_line_through_rear_window
 * @returns {{through:boolean, hit:number[]|null}}
 */
function checkLineThroughRearWindow(p1, p2, rearWindow) {
  const hit = lineSegmentPlaneIntersect(p1, p2, rearWindow.planePoint, rearWindow.planeNormal);
  if (hit === null) return { through: false, hit: null };
  // 判据: 命中后挡风外框 outline 即合格 (暂不考虑透光区 tz)
  const through = pointInPolygon3D(hit, rearWindow.outline, rearWindow.planeNormal);
  return { through, hit };
}

/**
 * 后挡风视图 2D 局部坐标 (u-v, mm) — 从车后看, 直接用 Y-Z 投影
 * u = Y (左右, +Y=右), v = Z (上下, +Z=上)
 * 不依赖平面法线, 保证任意倾斜角度下 "上" = 整车 Z+
 */
function buildProjection(rearWindow) {
  const origin = rearWindow.planePoint;
  const widthVec = [0, 1, 0];  // Y 轴
  const upVec = [0, 0, 1];     // Z 轴

  function to2d(p) {
    const off = vec3Sub(p, origin);
    return [vec3Dot(off, widthVec) * 1000, vec3Dot(off, upVec) * 1000];
  }
  return { widthVec, upVec, origin, to2d };
}

/**
 * 后挡风玻璃开口在镜面上的投影 — 等价 Python engine.py::rear_window_projection_on_mirror
 * 从眼点连接后挡风 outline 每个顶点, 与镜面平面求交, 得到后挡风在镜面上的投影范围。
 * 判定投影是否覆盖镜面四角 (镜面是否被后挡风开口限制)。
 * 报告项, 不参与五线法 PASS 判定。
 * @param {number[]} eye - 眼点中心 (3,) m
 * @param {Object} mirror - Mirror 实例
 * @param {Object} rearWindow - buildRearWindow 返回值
 * @returns {{projectionPoints:number[][], coversMirror:boolean}}
 */
function rearWindowProjectionOnMirror(eye, mirror, rearWindow) {
  const border = rearWindow.outline;
  const normal = mirror.normal;
  const hw = mirror.width / 2;
  const hh = mirror.height / 2;
  const projectionPoints = [];

  for (const vertex of border) {
    const direction = vec3Sub(vertex, eye);
    const dist = vec3Norm(direction);
    if (dist < 1e-10) continue;
    const dU = vec3Normalize(direction);
    const denom = vec3Dot(dU, normal);
    if (Math.abs(denom) < 1e-12) continue;
    const t = vec3Dot(vec3Sub(mirror.center, eye), normal) / denom;
    if (t < 1e-6 || t > dist) continue;
    const hit = vec3Add(eye, vec3Scale(dU, t));
    const offset = vec3Sub(hit, mirror.center);
    const lx = vec3Dot(offset, mirror.rightVec);
    const ly = vec3Dot(offset, mirror.upVec);
    if (Math.abs(lx) <= hw + 1e-6 && Math.abs(ly) <= hh + 1e-6) {
      projectionPoints.push(hit);
    }
  }

  // 判断投影是否覆盖镜面 (镜面四角是否都在投影多边形内)
  let coversMirror = false;
  if (projectionPoints.length >= 3) {
    const corners = mirror.corners();
    coversMirror = corners.every(c => pointInPolygon3D(c, projectionPoints, normal));
  }
  return { projectionPoints, coversMirror };
}

module.exports = {
  buildRearWindow, lineSegmentPlaneIntersect, pointInPolygon3D,
  checkLineThroughRearWindow, buildProjection, rearWindowProjectionOnMirror,
};
