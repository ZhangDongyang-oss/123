#!/usr/bin/env python3
"""
STEP 提取结果内在校验闸门 (共享: 内镜/外镜/后挡风三条路径通用)
============================================================
精度原则 (DEVELOPMENT_SPEC §13.7): 连续闭合 / 无飞线 / 尺寸合理。
任何提取完成必须过闸门, 不过则抛错失败 — 绝不静默输出坏的轮廓。

用法:
  from step_verify import assert_outline_ok
  assert_outline_ok(outline, "镜面轮廓")   # 失败抛 ValueError
"""
import numpy as np


def consecutive_breaks(pts, min_jump_mm=10.0):
    """相邻点跳变检测。阈值 = max(固定下限, 3×中位间距) — 自适应采样密度,
    避免把正常点距误报, 同时抓住真实断点 (飞线/缺段)。"""
    arr = np.asarray(pts, dtype=float)
    if len(arr) < 2:
        return []
    d = np.linalg.norm(np.diff(arr, axis=0), axis=1)
    if len(d) == 0:
        return []
    med = float(np.median(d))
    thr = max(min_jump_mm, 3.0 * med)
    return [(int(i), round(float(d[i]), 1)) for i in range(len(d)) if d[i] > thr]


def closure_gap_mm(pts):
    """首尾点距 (闭合轮廓应 ≈0)"""
    arr = np.asarray(pts, dtype=float)
    if len(arr) < 2:
        return float('inf')
    return float(np.linalg.norm(arr[0] - arr[-1]))


def spans_mm(pts):
    """各维度跨度"""
    arr = np.asarray(pts, dtype=float)
    return [round(float(np.ptp(arr[:, k])), 1) for k in range(arr.shape[1])]


def assert_outline_ok(pts, label, min_jump_mm=10.0, need_closed=True, max_span_mm=3000.0):
    """提取自检闸门: 不通过抛 ValueError (脚本应失败, 不输出坏数据)"""
    arr = np.asarray(pts, dtype=float)
    if len(arr) < 4:
        raise ValueError(f"{label}: 点数过少 ({len(arr)}), 提取失败")
    br = consecutive_breaks(arr, min_jump_mm)
    if br:
        worst = max(br, key=lambda x: x[1])
        raise ValueError(
            f"{label}: 轮廓存在断点 {len(br)} 处 (最大 {worst[1]}mm @#{worst[0]}, "
            f"前5: {br[:5]}). 疑似边缝合不连续或 B-spline 采样异常"
        )
    if need_closed:
        g = closure_gap_mm(arr)
        if g > 1.0:
            raise ValueError(f"{label}: 轮廓未闭合 (首尾距 {g:.1f}mm)")
    sp = spans_mm(arr)
    bad = [s for s in sp if s > max_span_mm]
    if bad:
        raise ValueError(f"{label}: 跨度异常 {bad}mm (疑似采样异常点或装配上下文未转换)")
    return True
