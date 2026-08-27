"""
3DE 曲线采样可行性探测
=======================
目标: 验证"选一条镜片边界曲线 → 自动采样 N 点坐标"是否可行。
背景: PROBE_REPORT (2026-07-28) 确认面级 GetVertices/GetNormal 不可用,
      但曲线采样 (在曲线上按参数取多点) 从未探测。本脚本填补该空白,
      为外镜 outline "选曲线代替逐点手选" 提供技术依据。
红线: 纯只读 — 只 SelectElement2 + GetMeasurable + 读属性, 不 Update/Modify/AddNew*。

用法 (在 mirro-fov-js 项目内):
    cd modules/smart/mirro-fov/python
    python probe_curve_sample.py

流程: 连接 3DE → 选一条曲线 → 枚举 Measurable(curve) 可用方法 →
      试 HybridShape/Part 路径 → 报告 + 若采样成功则打印点坐标。
"""
import os
import sys

# 让脚本能从 python/ 目录直接 import mirror_fov 包
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from mirror_fov.catia_conn import (  # noqa: E402
    CATIAConnection, ConnectionError,
    MEASURABLE_CURVE, MEASURABLE_POINT, MEASURABLE_PLANE, MEASURABLE_LINE, MEASURABLE_SURFACE,
)

# 候选方法名 — V5/3DE Measurable 曲线相关 (含已知可用的 GetLength)
CURVE_METHOD_CANDIDATES = [
    "GetLength", "GetPoints", "GetPointsOnCurve", "GetParametricPosition",
    "GetCurveType", "GetDirection", "GetRadius", "GetMidPoint",
    "GetCenterOfGravity", "GetBoundingBox", "GetVertices", "GetNormal",
    "GetArea", "GetPoint", "GetSubCurve", "GetSubElements",
]


def _try_call(label, obj, method_name, *args):
    """安全调用 COM 方法, 返回 (ok, result_or_error)"""
    try:
        m = getattr(obj, method_name)
    except AttributeError:
        return ("absent", "<属性不存在>")
    except Exception as e:
        return ("err", f"{type(e).__name__}: {str(e)[:80]}")
    try:
        r = m(*args)
        return ("ok", r)
    except Exception as e:
        return ("err", f"{type(e).__name__}: {str(e)[:80]}")


def probe():
    c = CATIAConnection()
    try:
        c.connect()
    except ConnectionError as e:
        print(f"连接失败: {e}")
        print("请确认 3DEXPERIENCE 已启动并登录。")
        return

    print(f"已连接: {c.get_version()}")
    sel = c.get_selection()
    sel.Clear()

    print("\n请在 3DE 中选一条【镜片边界曲线】(边 / BRep curve)。")
    print("选完按确定, 脚本自动探测其采样能力。")
    try:
        status = sel.SelectElement2(["Reference"], "选一条镜片边界曲线 (edge/BRep curve)", False)
    except Exception as e:
        print(f"SelectElement2 失败: {e}")
        c.disconnect()
        return

    if status == "Cancel" or sel.Count == 0:
        print("用户取消, 退出。")
        sel.Clear()
        c.disconnect()
        return

    item = sel.Item(1)
    obj = item.Value
    print("\n" + "=" * 60)
    print("1. 选中对象识别")
    print("=" * 60)
    print(f"  type: {type(obj).__name__}")
    for attr in ("Name", "Type", "DisplayName"):
        ok, val = _try_call(attr, obj, attr)
        if ok == "ok":
            print(f"  {attr}: {val}")

    # ─── 2. Reference 识别 ───────────────────────────────
    print("\n" + "=" * 60)
    print("2. Reference 路径")
    print("=" * 60)
    try:
        ref = item.Reference
        print(f"  Reference type: {type(ref).__name__}")
        for attr in ("DisplayName", "Name", "Type"):
            ok, val = _try_call(attr, ref, attr)
            if ok == "ok":
                print(f"    {attr}: {val}")
    except Exception as e:
        print(f"  Reference 获取失败: {str(e)[:80]}")

    # ─── 3. Measurable(curve, tid=4) 方法枚举 ───────────
    print("\n" + "=" * 60)
    print("3. Measurable(obj, tid=4=Curve) 方法枚举")
    print("=" * 60)
    spa = c.spa
    try:
        meas = spa.GetMeasurable(obj, MEASURABLE_CURVE)
    except Exception as e:
        print(f"  GetMeasurable(curve) 失败: {e}")
        meas = None

    sampled_points = None
    if meas is not None:
        for name in CURVE_METHOD_CANDIDATES:
            ok, val = _try_call(name, meas, name)
            tag = {"ok": "✓", "err": "✗", "absent": "·"}[ok]
            shown = repr(val)[:100]
            print(f"  {tag} {name}: {shown}")
            # 记录成功采样的方法
            if ok == "ok" and name in ("GetPoints", "GetPointsOnCurve") and val:
                sampled_points = (name, val)

        # GetLength 单独确认
        ok, val = _try_call("GetLength", meas, "GetLength")
        if ok == "ok":
            print(f"\n  → GetLength = {val:.3f} mm (曲线长度, 用于估算采样间距)")

    # ─── 4. 其他 type_id 试探 ───────────────────────────
    print("\n" + "=" * 60)
    print("4. 其他 type_id 试探 (能否当点/线/面读)")
    print("=" * 60)
    for tid, label, method in [
        (MEASURABLE_POINT, "8=Point", "GetPoint"),
        (MEASURABLE_LINE, "6=Line", "GetDirection"),
        (MEASURABLE_PLANE, "7=Plane", "GetNormal"),
        (MEASURABLE_SURFACE, "10=Surface", "GetArea"),
    ]:
        try:
            m2 = spa.GetMeasurable(obj, tid)
            ok, val = _try_call(method, m2, method)
            tag = {"ok": "✓", "err": "✗", "absent": "·"}[ok]
            print(f"  tid={tid:<2} {label:<10} {method}: {tag} {repr(val)[:60]}")
        except Exception as e:
            print(f"  tid={tid:<2} {label:<10}: GetMeasurable 失败 {str(e)[:50]}")

    # ─── 5. HybridShape / Part 路径 (可能需进 Part 编辑) ─
    print("\n" + "=" * 60)
    print("5. HybridShape / Part 路径 (参数化采样可能需要)")
    print("=" * 60)
    print("  (装配层级通常拿不到 HybridShape; 若上面 GetPointsOnCurve 等已成功, 可跳过本节)")
    try:
        ed = c.get_editor()
        for attr in ("ActiveObject", "Document", "Part"):
            ok, val = _try_call(attr, ed, attr)
            tag = {"ok": "✓", "err": "✗", "absent": "·"}[ok]
            tname = type(val).__name__ if val is not None else "None"
            print(f"  editor.{attr}: {tag} {tname}")
    except Exception as e:
        print(f"  editor 探测失败: {str(e)[:80]}")

    # 尝试通过 obj 拿 HybridShape (各路径都试, 失败就报告)
    hybrid_ok = False
    for getter in ("GetHybridShape", "HybridShape", "GetCurve"):
        ok, val = _try_call(getter, obj, getter)
        if ok == "ok" and val is not None:
            print(f"  obj.{getter}() → {type(val).__name__}")
            # 试 Evaluate / GetParametricPosition
            for em in ("Evaluate", "GetParametricPosition", "GetPoint", "GetPoints"):
                ok2, val2 = _try_call(em, val, em, 0.5)
                tag = {"ok": "✓", "err": "✗", "absent": "·"}[ok2]
                print(f"    {em}(0.5): {tag} {repr(val2)[:60]}")
            hybrid_ok = True
            break
    if not hybrid_ok:
        print("  obj 无 GetHybridShape/HybridShape/GetCurve 可用 (装配层级限制)")

    # ─── 6. 采样结果 ─────────────────────────────────────
    print("\n" + "=" * 60)
    print("6. 采样结果")
    print("=" * 60)
    if sampled_points:
        name, pts = sampled_points
        print(f"  ✅ 方法 {name} 返回采样点!")
        print(f"  点数: {len(pts) if hasattr(pts, '__len__') else '?'}")
        try:
            # 尝试打印前几个点
            import numpy as np
            arr = np.array(pts).reshape(-1, 3)
            print(f"  前 3 点 (mm): {arr[:3].tolist()}")
            print(f"  后 3 点 (mm): {arr[-3:].tolist()}")
            print(f"  总点数: {len(arr)}")
        except Exception as e:
            print(f"  解析点失败 (原始): {repr(pts)[:200]}")
        print("\n  → 结论: 曲线采样可行! 可实现'选曲线→自动采样'替代逐点手选。")
    else:
        print("  ❌ 未找到可用的曲线采样方法 (GetPoints/GetPointsOnCurve 均不可用)。")
        print("  → 结论: Measurable 曲线级 API 与面级一样弱, 只能 GetLength。")
        print("  → 后续方向: 退到代码侧'球面弧线插值'(HANDOFF §15) 或要求供应商 CAD 曲线导出。")

    sel.Clear()
    c.disconnect()
    print("\n" + "=" * 60)
    print("探测完成 — 请把以上输出贴回给 Claude 分析")
    print("=" * 60)


if __name__ == "__main__":
    probe()
