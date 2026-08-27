"""
STEP 曲线采样器测试
====================
用 SAMPLE_MIRROR STEP 真实数据验证采样器正确性。
纯 STEP 解析测试 — 不依赖 CATIA COM。

运行:
    cd modules/smart/mirro-fov/python
    python test_step_sampler.py [<step_file>]

断言 (基于已知几何, 见 HANDOFF §7 车型数据格式):
  - 解析成功 (实体数 > 100000, 点数 > 100000)
  - 曲线总数 > 5000 (SAMPLE_MIRROR 实测 10046)
  - #270368 (478mm B-spline) 采样坐标匹配内镜几何:
      X ≈ 2909.216 (= center_zero.x 2.909215m, 镜面平面)
      Z 跨度 ≈ 50.79mm  (= 车型C height 0.050794m)
  - #174205 (261mm B-spline) Y 跨度 ≈ 246mm (≈ width 224.8mm + 圆角)
  - 采样点数 = 请求数 (de Boor 无掉点)
  - CIRCLE 解析 + 采样: 圆上点到圆心距离 = 半径 (容差 1e-6)
"""
import math
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

import step_curve_sampler as scs  # noqa: E402

# 默认 STEP 文件 (用户提供, 桌面路径)
DEFAULT_STEP = r"STEP_FILE_PLACEHOLDER.stp"

_passed = 0
_failed = 0


def assert_(cond, msg):
    global _passed, _failed
    if cond:
        _passed += 1
        print(f"  ✓ {msg}")
    else:
        _failed += 1
        print(f"  ✗ {msg}")


def approx(a, b, tol):
    return abs(a - b) <= tol


def main():
    step_file = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_STEP
    if not os.path.exists(step_file):
        print(f"STEP 文件不存在: {step_file}")
        print("用法: python test_step_sampler.py [<step_file>]")
        sys.exit(1)

    print(f"测试 STEP: {step_file}")
    print("=" * 60)

    # ─── 1. 解析 ──────────────────────────────────────────
    print("\n[1] STEP 解析")
    entities, points = scs.parse_step(step_file)
    assert_(len(entities) > 100000, f"实体数 {len(entities)} > 100000")
    assert_(len(points) > 100000, f"CARTESIAN_POINT 数 {len(points)} > 100000")

    # ─── 2. 曲线枚举 ──────────────────────────────────────
    print("\n[2] 曲线枚举")
    curves = []
    for eid, (etype, args) in entities.items():
        if etype == "B_SPLINE_CURVE_WITH_KNOTS":
            c = scs.parse_bspline_curve(eid, args, entities, points)
            if c:
                curves.append((eid, "B-spline", c))
    assert_(len(curves) > 5000, f"B-spline 曲线数 {len(curves)} > 5000")
    print(f"  B-spline 曲线: {len(curves)}")

    # ─── 3. #270368 镜面短边 (height 方向) ────────────────
    print("\n[3] #270368 镜面短边采样 (应匹配 height=50.794mm)")
    c270368 = scs.parse_bspline_curve(270368, entities[270368][1], entities, points)
    assert_(c270368 is not None, "#270368 解析成功")
    if c270368:
        pts = scs.sample_bspline(c270368, 30)
        assert_(len(pts) == 30, f"采样点数 {len(pts)} == 30 (de Boor 无掉点)")
        if len(pts) == 30:
            x_span = np.ptp(pts[:, 0])
            y_span = np.ptp(pts[:, 1])
            z_span = np.ptp(pts[:, 2])
            print(f"  X 跨度={x_span:.3f}mm  Y 跨度={y_span:.3f}mm  Z 跨度={z_span:.3f}mm")
            # X 恒定 (边在 YZ 平面) — 镜面平面
            assert_(approx(x_span, 0, 0.1), f"X 跨度 ≈ 0 (镜面平面边, 得 {x_span:.3f})")
            # Z 跨度 = 镜面高度 50.794mm (车型C height)
            assert_(approx(z_span, 50.794, 0.5), f"Z 跨度 ≈ 50.794mm (镜面高度, 得 {z_span:.3f})")
            # X 坐标 = center_zero.x = 2909.215mm (2.909215m)
            assert_(approx(pts[0, 0], 2909.215, 0.5),
                    f"X ≈ 2909.215 (center_zero.x, 得 {pts[0,0]:.3f})")

    # ─── 4. #174205 镜面长边 (width 方向) ─────────────────
    print("\n[4] #174205 镜面长边采样 (应匹配 width≈224.8mm)")
    c174205 = scs.parse_bspline_curve(174205, entities[174205][1], entities, points)
    assert_(c174205 is not None, "#174205 解析成功")
    if c174205:
        pts = scs.sample_bspline(c174205, 16)
        assert_(len(pts) == 16, f"采样点数 {len(pts)} == 16")
        if len(pts) == 16:
            y_span = np.ptp(pts[:, 1])
            print(f"  Y 跨度={y_span:.3f}mm")
            # Y 跨度 ≈ 镜面宽度 + 圆角余量 (width 224.8mm, 实测 ~246mm 含圆角)
            assert_(approx(y_span, 246, 5), f"Y 跨度 ≈ 246mm (width+圆角, 得 {y_span:.3f})")

    # ─── 5. CIRCLE 解析 + 采样 ────────────────────────────
    print("\n[5] CIRCLE 解析 + 采样 (圆上点距圆心 = 半径)")
    circle_tested = 0
    for eid, (etype, args) in entities.items():
        if etype != "CIRCLE" or circle_tested >= 3:
            continue
        c = scs.parse_circle(eid, args, entities, points)
        if not c:
            continue
        pts = scs.sample_circle(c, 12)
        # 每个采样点到圆心距离 = 半径
        dists = np.linalg.norm(pts - c["origin"], axis=1)
        max_err = np.max(np.abs(dists - c["radius"]))
        assert_(max_err < 1e-6, f"#{eid} 圆采样: 距圆心=半径 (最大误差 {max_err:.2e}mm)")
        circle_tested += 1
    assert_(circle_tested > 0, f"至少测试 1 个 CIRCLE (测了 {circle_tested} 个)")

    # ─── 6. 不同采样密度 ──────────────────────────────────
    print("\n[6] 采样密度可调 (同一曲线 10/50/100 点)")
    if c270368:
        for n in [10, 50, 100]:
            pts = scs.sample_bspline(c270368, n)
            assert_(len(pts) == n, f"n={n}: 采样 {len(pts)} 点 (预期 {n})")

    # ─── 汇总 ────────────────────────────────────────────
    print("\n" + "=" * 60)
    print(f"结果: {_passed} 通过, {_failed} 失败")
    print("=" * 60)
    sys.exit(0 if _failed == 0 else 1)


if __name__ == "__main__":
    main()
