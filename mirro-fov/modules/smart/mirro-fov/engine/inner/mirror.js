/**
 * Mirror 模型 — 等价于 Python models.py::Mirror
 * 平面内后视镜 (球铰安装刚体)
 */
const { vec3Add, vec3Sub, vec3Scale, vec3Dot, vec3Cross, vec3Norm, vec3Normalize, rotZY, matVec } = require('../shared/geometry');

class Mirror {
  /**
   * @param {Object} opts
   * @param {number} opts.width - 镜面宽度 (m)
   * @param {number} opts.height - 镜面高度 (m)
   * @param {number[]} opts.pivot - 球铰旋转中心 [x,y,z] (m)
   * @param {number[]} opts.armOffset - 零位臂向量 [x,y,z] (m)
   * @param {number} opts.yaw - 偏航角 (rad)
   * @param {number} opts.pitch - 俯仰角 (rad)
   * @param {number} [opts.cornerRadius=0] - 圆角半径 (m)
   * @param {number[][]} [opts.outlineLocal] - 真实反射区轮廓 [lx,ly] mm (STEP 采样, 优先于圆角矩形判定)
   */
  constructor({ width, height, pivot, armOffset, yaw, pitch, cornerRadius = 0, outlineLocal = null }) {
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0)
      throw new Error(`镜面尺寸必须为正有限数: ${width}x${height}`);
    if (!armOffset || vec3Norm(armOffset) < 1e-6) throw new Error('armOffset 几乎为零, pivot 与镜面中心重合');
    if (Math.abs(pitch) > Math.PI / 3) {
      console.warn(`pitch=${(pitch * 180 / Math.PI).toFixed(1)}° 超出常规范围 (±60°)`);
    }
    if (cornerRadius < 0) throw new Error(`圆角半径不能为负: ${cornerRadius}`);
    const maxR = Math.min(width, height) / 2;
    if (cornerRadius > maxR + 1e-9) {
      throw new Error(`圆角半径 ${cornerRadius * 1000}mm 超过镜面短边一半 ${maxR * 1000}mm`);
    }

    this.width = width;
    this.height = height;
    this.pivot = pivot;
    this.armOffset = armOffset;
    this.yaw = yaw;
    this.pitch = pitch;
    this.cornerRadius = cornerRadius;
    this.outlineLocal = outlineLocal;  // [[lx,ly], ...] mm 或 null

    // 旋转矩阵 R = Rz(yaw) @ Ry(pitch)
    this._R = rotZY(yaw, pitch);
  }

  // 镜面中心 = pivot + R @ armOffset
  get center() {
    return vec3Add(this.pivot, matVec(this._R, this.armOffset));
  }

  // 零位法线 n0 = [+1,0,0] → 旋转后法线
  get normal() {
    return vec3Normalize(matVec(this._R, [1, 0, 0]));
  }

  // 局部右方向 (零位 +Y)
  get rightVec() {
    return vec3Normalize(matVec(this._R, [0, 1, 0]));
  }

  // 局部上方向 = normal × right
  get upVec() {
    return vec3Normalize(vec3Cross(this.normal, this.rightVec));
  }

  /**
   * 镜面四角点 (右上, 左上, 左下, 右下) -> [[x,y,z], ...]
   */
  corners() {
    const hw = this.width / 2, hh = this.height / 2;
    const r = this.rightVec, u = this.upVec, c = this.center;
    return [
      vec3Add(vec3Add(c, vec3Scale(r, hw)), vec3Scale(u, hh)),
      vec3Add(vec3Add(c, vec3Scale(r, -hw)), vec3Scale(u, hh)),
      vec3Add(vec3Add(c, vec3Scale(r, -hw)), vec3Scale(u, -hh)),
      vec3Add(vec3Add(c, vec3Scale(r, hw)), vec3Scale(u, -hh)),
    ];
  }

  /**
   * 镜面边缘采样点 (反射法 FOV 用) — 等价 Python models.py::Mirror.sample_edges
   * 每条边取 n 个点, 端点用 open interval 避免角点重复
   * @param {number} n - 每条边采样数
   * @returns {number[][]} (N,3) 采样点
   */
  sampleEdges(n = 20) {
    const hw = this.width / 2, hh = this.height / 2;
    const r = this.rightVec, u = this.upVec, c = this.center;
    const points = [];
    // 上下边 (沿 right 方向)
    for (let i = 1; i <= n; i++) {
      const t = -1 + 2 * i / (n + 1); // open interval: -1..1 不含端点
      points.push(vec3Add(vec3Add(c, vec3Scale(r, hw * t)), vec3Scale(u, hh)));
      points.push(vec3Add(vec3Sub(c, vec3Scale(r, hw * t)), vec3Scale(u, -hh)));
    }
    // 左右边 (沿 up 方向)
    for (let i = 1; i <= n; i++) {
      const t = -1 + 2 * i / (n + 1);
      points.push(vec3Add(vec3Add(c, vec3Scale(r, hw)), vec3Scale(u, hh * t)));
      points.push(vec3Sub(vec3Sub(c, vec3Scale(r, hw)), vec3Scale(u, hh * t)));
    }
    return points;
  }

  /**
   * 判断镜面局部坐标 (lx, ly) 是否在反射面内 (考虑圆角)
   * 等价于 Python models.py::Mirror.is_on_reflective_surface
   * @param {number} lx - 局部 X (mm)
   * @param {number} ly - 局部 Y (mm)
   * @returns {boolean}
   */
  isOnReflectiveSurface(lx, ly) {
    // NaN/非有限值防御: NaN 击穿所有比较会落入默认 return true → 假 PASS
    if (!Number.isFinite(lx) || !Number.isFinite(ly)) return false;

    // 真实轮廓优先 (STEP 采样, point-in-polygon)
    if (this.outlineLocal && this.outlineLocal.length >= 3) {
      return Mirror.pointInPolygon(lx, ly, this.outlineLocal);
    }

    // 退回圆角矩形判定 (向后兼容)
    const hw = this.width / 2 * 1000;
    const hh = this.height / 2 * 1000;
    const r = this.cornerRadius * 1000;

    if (Math.abs(lx) > hw + 1e-3 || Math.abs(ly) > hh + 1e-3) return false;
    if (r < 1e-6) return true;

    const corners = [
      [hw - r, hh - r],   // 右上
      [-hw + r, hh - r],  // 左上
      [-hw + r, -hh + r], // 左下
      [hw - r, -hh + r],  // 右下
    ];

    for (const [cx, cy] of corners) {
      if (Math.abs(lx - cx) <= r && Math.abs(ly - cy) <= r) {
        const distSq = (lx - cx) ** 2 + (ly - cy) ** 2;
        if (distSq > r * r + 1e-6) return false;
      }
    }
    return true;
  }

  /**
   * 射线法 point-in-polygon (Python 探测验证 5/5 一致)
   * @param {number} x - 点 X
   * @param {number} y - 点 Y
   * @param {number[][]} poly - [[x,y], ...] 闭合多边形
   * @returns {boolean}
   */
  static pointInPolygon(x, y, poly) {
    let inside = false;
    let j = poly.length - 1;
    for (let i = 0; i < poly.length; i++) {
      const xi = poly[i][0], yi = poly[i][1];
      const xj = poly[j][0], yj = poly[j][1];
      if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) {
        inside = !inside;
      }
      j = i;
    }
    return inside;
  }

  /**
   * 反射面轮廓坐标 (mm) — 用于可视化
   * 等价于 Python models.py::Mirror.reflective_outline_mm
   * 有真实轮廓 (STEP 采样) 时直接返回; 否则退回圆角矩形
   * @returns {{ xs: number[], ys: number[] }}
   */
  reflectiveOutlineMM(nArc = 20) {
    // 真实轮廓优先
    if (this.outlineLocal && this.outlineLocal.length >= 3) {
      return {
        xs: this.outlineLocal.map(p => p[0]),
        ys: this.outlineLocal.map(p => p[1]),
      };
    }

    const hw = this.width / 2 * 1000;
    const hh = this.height / 2 * 1000;
    const r = this.cornerRadius * 1000;

    if (r < 1e-6) {
      return { xs: [-hw, hw, hw, -hw, -hw], ys: [-hh, -hh, hh, hh, -hh] };
    }

    const corners = [
      [hw - r, hh - r, 0, 90],
      [-hw + r, hh - r, 90, 180],
      [-hw + r, -hh + r, 180, 270],
      [hw - r, -hh + r, 270, 360],
    ];

    const xs = [], ys = [];
    for (const [cx, cy, aStart, aEnd] of corners) {
      for (let j = 0; j <= nArc; j++) {
        const a = (aStart + (aEnd - aStart) * j / nArc) * Math.PI / 180;
        xs.push(cx + r * Math.cos(a));
        ys.push(cy + r * Math.sin(a));
      }
    }
    xs.push(xs[0]); ys.push(ys[0]);
    return { xs, ys };
  }
}

module.exports = { Mirror };
