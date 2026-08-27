/**
 * 2D 多边形几何谓词 — 共享 (内镜外镜都用)
 *
 * 从原 engine/rear-window.js 提出, 只含纯 2D 数学 (零依赖):
 *   - pointInPolygon2D: 2D 点在多边形内部判定 (射线法)
 *   - edgeDistanceTo: 2D 点到线段最短距离
 *
 * 后挡风建模相关 (buildRearWindow/lineSegmentPlaneIntersect/pointInPolygon3D/
 * checkLineThroughRearWindow/buildProjection/rearWindowProjectionOnMirror) 仍在内镜侧
 * engine/inner/rear-window.js。
 */

/**
 * 2D 点在多边形内部判定 (射线法) — 等价 Python point_in_polygon_2d
 */
function pointInPolygon2D(pt, poly) {
  const [px, py] = pt;
  let inside = false;
  const n = poly.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = poly[i][0], yi = poly[i][1];
    const xj = poly[j][0], yj = poly[j][1];
    if (((yi > py) !== (yj > py)) &&
        (px < (xj - xi) * (py - yi) / (yj - yi) + xi)) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * 2D 点到线段最短距离 (垂足 + 端点钳制) — 等价 Python _edge_distance_to
 * @returns {{dist:number, ex:number, ey:number}}
 */
function edgeDistanceTo(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const segLen2 = dx * dx + dy * dy;
  if (segLen2 < 1e-12) return { dist: Math.hypot(px - ax, py - ay), ex: ax, ey: ay };
  let t = ((px - ax) * dx + (py - ay) * dy) / segLen2;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx, cy = ay + t * dy;
  return { dist: Math.hypot(px - cx, py - cy), ex: cx, ey: cy };
}

module.exports = { pointInPolygon2D, edgeDistanceTo };
