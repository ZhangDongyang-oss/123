"""
3DE Part 层级曲线采样探测
==========================
背景: 装配层级 probe_curve_sample 证 GetLength 可用, GetPoints 抛 com_error
      (方法存在但失败), GetPointsOnCurve/GetParametricPosition absent。
线索: GetPoints "存在但失败" → 可能是装配层级上下文问题, Part 层级可能解锁。
      PROBE_REPORT §7.7 只测过编辑层级面级 GetArea, 曲线级/HybridShape 级未探。
目标: 进 Part/3DShape 编辑模式, 探曲线采样的可行 API。
红线: 纯只读 — 只选对象 + 读属性 + 枚举, 不 Update/Modify/AddNew*/Save。

前置操作 (重要):
  1. 在 3DE 里【双击镜片零件】进入 Part/3DShape 编辑模式
     (不是装配层级 — 装配层级已证采样不可行)
  2. 确认编辑器标题/特征树显示为 Part 或 3DShape
  3. 再运行本脚本

用法:
    cd modules/smart/mirro-fov/python
    python probe_curve_partlevel.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from mirror_fov.catia_conn import (  # noqa: E402
    CATIAConnection, ConnectionError,
    MEASURABLE_CURVE, MEASURABLE_POINT, MEASURABLE_LINE,
    MEASURABLE_PLANE, MEASURABLE_SURFACE,
)

# HybridShape 曲线对象候选方法 (参数化采样可能用)
HYBRIDSHAPE_CURVE_METHODS = [
    # 参数化采样
    "GetParametricPosition", "Evaluate", "GetPoint", "GetPoints",
    "GetSubElements", "GetCurveType", "GetEndPoints", "GetControlPoints",
    # 通用
    "GetLength", "GetName", "GetFeature",
]


def _try(label, obj, method_name, *args):
    """安全调用, 返回 (状态, 值或错误). 状态: ok/err/absent"""
    try:
        m = getattr(obj, method_name)
    except AttributeError:
        return ("absent", "<无此属性>")
    except Exception as e:
        return ("err", f"{type(e).__name__}: {str(e)[:90]}")
    try:
        return ("ok", m(*args))
    except Exception as e:
        return ("err", f"{type(e).__name__}: {str(e)[:90]}")


def _tag(ok):
    return {"ok": "✓", "err": "✗", "absent": "·"}[ok]


def probe():
    c = CATIAConnection()
    try:
        c.connect()
    except ConnectionError as e:
        print(f"连接失败: {e}")
        return

    print(f"已连接: {c.get_version()}")
    ed = c.get_editor()
    spa = c.spa
    sel = c.get_selection()
    sel.Clear()

    # ─── 1. 判断当前层级 (装配 vs Part) ───────────────────
    print("\n" + "=" * 60)
    print("1. 当前编辑层级判断")
    print("=" * 60)
    print("  (若下面 ActiveObject 是 Part/3DShape 对象 → 已在 Part 层级)")
    print("  (若是 str 或 None → 仍在装配层级, 请双击零件进 Part 编辑再跑)")
    for attr in ("ActiveObject", "Document", "Name", "Type"):
        ok, val = _try(attr, ed, attr)
        tname = type(val).__name__ if val is not None else "None"
        shown = str(val)[:70] if val is not None else "None"
        print(f"  editor.{attr}: {_tag(ok)} type={tname} val={shown}")

    # 试多路径拿 Part 对象
    part = None
    part_src = None
    candidates = [
        ("ed.ActiveObject", lambda: ed.ActiveObject),
        ("ed.ActiveObject.Value", lambda: ed.ActiveObject.Value),
        ("ed.Document.Part", lambda: ed.Document.Part),
        ("ed.Document", lambda: ed.Document),
    ]
    for label, getter in candidates:
        try:
            v = getter()
            if v is not None and not isinstance(v, str):
                # 试是不是 Part (有 HybridBodies 属性)
                hb_ok, _ = _try("HybridBodies", v, "HybridBodies")
                if hb_ok in ("ok",):
                    part = v
                    part_src = label
                    print(f"  ✅ 拿到 Part 对象 via {label} (type={type(v).__name__})")
                    break
                else:
                    print(f"  {label} → {type(v).__name__} (无 HybridBodies, 非 Part)")
            elif v is not None:
                print(f"  {label} → {type(v).__name__} = {str(v)[:50]}")
        except Exception as e:
            print(f"  {label} 失败: {str(e)[:70]}")

    if part is None:
        print("\n  ⚠️ 未拿到 Part 对象 — 仍可能在装配层级。")
        print("     请在 3DE 双击镜片零件进 Part/3DShape 编辑模式, 再重跑本脚本。")
        print("     (装配层级采样已证不可行, 本脚本只探 Part 层级)")
        # 仍继续后面的选中曲线探测 (BRep edge 在装配层级也试一次 GetPoints 带参, 留对照)

    # ─── 2. 枚举 Part 的 HybridBodies / HybridShapes ──────
    if part is not None:
        print("\n" + "=" * 60)
        print(f"2. Part 几何集枚举 (via {part_src})")
        print("=" * 60)
        try:
            hbs = part.HybridBodies
            print(f"  HybridBodies 数量: {hbs.Count}")
            for i in range(1, min(hbs.Count, 10) + 1):
                hb = hbs.Item(i)
                print(f"  [{i}] {hb.Name} (type={type(hb).__name__})")
                # 枚举每个 HybridBody 的 HybridShapes
                try:
                    shapes = hb.HybridShapes
                    sc = shapes.Count if shapes else 0
                    print(f"      HybridShapes 数量: {sc}")
                    for j in range(1, min(sc, 8) + 1):
                        sh = shapes.Item(j)
                        stype = type(sh).__name__
                        # 试读形状类型
                        st_ok, st_val = _try("Type", sh, "Type")
                        type_info = f" type={stype}" + (f" Type={st_val}" if st_ok == "ok" else "")
                        print(f"      [{j}] {sh.Name}{type_info}")
                except Exception as e:
                    print(f"      HybridShapes 枚举失败: {str(e)[:60]}")
        except Exception as e:
            print(f"  HybridBodies 枚举失败: {e}")

    # ─── 3. 选一条曲线, Part 层级重试 GetPoints ───────────
    print("\n" + "=" * 60)
    print("3. 选一条曲线 → Part 层级 Measurable(curve) 重试")
    print("=" * 60)
    print("  请在 3DE 选一条【镜片边界曲线 / edge】")
    try:
        status = sel.SelectElement2(["Reference"], "选一条镜片边界曲线", False)
    except Exception as e:
        print(f"  SelectElement2 失败: {e}")
        c.disconnect()
        return

    if status == "Cancel" or sel.Count == 0:
        print("  用户取消")
        sel.Clear()
        c.disconnect()
        return

    item = sel.Item(1)
    obj = item.Value
    print(f"  选中 type: {type(obj).__name__}")

    # 3a. Measurable(curve) GetPoints — 关键: 装配层级 com_error, Part 层级是否 success
    print("\n  3a. Measurable(obj, tid=4=Curve) 关键方法:")
    try:
        meas = spa.GetMeasurable(obj, MEASURABLE_CURVE)
    except Exception as e:
        meas = None
        print(f"    GetMeasurable(curve) 失败: {e}")

    sampled = None
    if meas is not None:
        # GetPoints 试三种调用方式: 无参 / 传空 list / 传 0
        for call_desc, args in [("GetPoints()", ()), ("GetPoints([])", ([],)), ("GetPoints(0)", (0,))]:
            ok, val = _try(call_desc, meas, "GetPoints", *args)
            print(f"    {_tag(ok)} {call_desc}: {repr(val)[:90]}")
            if ok == "ok" and val:
                sampled = ("Measurable.GetPoints", val, call_desc)
        # 其他曲线方法
        for name in ("GetLength", "GetCurveType", "GetSubElements", "GetPointsOnCurve",
                     "GetParametricPosition", "GetMidPoint", "GetEndPoints"):
            ok, val = _try(name, meas, name)
            if ok != "absent":  # 只报存在或失败的, 不报 absent (省篇幅)
                print(f"    {_tag(ok)} {name}: {repr(val)[:80]}")

    # 3b. 其他 type_id
    print("\n  3b. 其他 type_id (当点/线读):")
    for tid, lab, meth in [(MEASURABLE_POINT, "8=Point", "GetPoint"),
                           (MEASURABLE_LINE, "6=Line", "GetDirection")]:
        try:
            m2 = spa.GetMeasurable(obj, tid)
            ok, val = _try(meth, m2, meth)
            print(f"    tid={tid} {lab} {meth}: {_tag(ok)} {repr(val)[:60]}")
        except Exception as e:
            print(f"    tid={tid}: GetMeasurable 失败 {str(e)[:50]}")

    # ─── 4. HybridShape 对象路径 (Part 层级才可能有) ──────
    print("\n" + "=" * 60)
    print("4. HybridShape 对象路径 (参数化采样)")
    print("=" * 60)
    hybrid_shape = None
    for getter in ("GetHybridShape", "HybridShape", "GetCurve", "GetFeature"):
        ok, val = _try(getter, obj, getter)
        if ok == "ok" and val is not None and not isinstance(val, str):
            print(f"  ✅ obj.{getter}() → {type(val).__name__}")
            hybrid_shape = val
            break
        elif ok != "absent":
            print(f"  {obj}.{getter}: {_tag(ok)} {repr(val)[:60]}")

    if hybrid_shape is not None:
        print(f"\n  HybridShape 方法枚举 (type={type(hybrid_shape).__name__}):")
        for name in HYBRIDSHAPE_CURVE_METHODS:
            # Evaluate 试几个参数值
            if name == "Evaluate":
                for p in (0.0, 0.5, 1.0):
                    ok, val = _try(f"Evaluate({p})", hybrid_shape, "Evaluate", p)
                    if ok != "absent":
                        print(f"    {_tag(ok)} Evaluate({p}): {repr(val)[:70]}")
            else:
                ok, val = _try(name, hybrid_shape, name)
                if ok != "absent":
                    print(f"    {_tag(ok)} {name}: {repr(val)[:70]}")
        # 试通过 Reference 拿 HybridShape (另一路径)
    ref_ok, ref = _try("Reference", item, "Reference")
    if ref_ok == "ok" and ref is not None:
        print(f"\n  item.Reference → {type(ref).__name__}")
        for getter in ("GetHybridShape", "HybridShape"):
            ok, val = _try(getter, ref, getter)
            if ok == "ok" and val is not None and not isinstance(val, str):
                print(f"    ref.{getter}() → {type(val).__name__} ✅ (第二路径拿到 HybridShape)")

    # ─── 5. SPAWorkbench / 离散化服务 ────────────────────
    print("\n" + "=" * 60)
    print("5. SpaceAnalysis / 离散化服务")
    print("=" * 60)
    for svc_name in ("SPAWorkbench", "SpaceAnalysis", "Discretize"):
        try:
            svc = c.app.GetSessionService(svc_name)
            print(f"  GetSessionService('{svc_name}') → {type(svc).__name__} ✅")
            # 枚举它的方法 (试常见的离散/提取)
            for m in ("Extract", "Discretize", "GetPoints", "GetMesh", "CreateMeasurable"):
                ok, val = _try(m, svc, m)
                if ok != "absent":
                    print(f"    {_tag(ok)} {m}: {repr(val)[:60]}")
        except Exception as e:
            print(f"  GetSessionService('{svc_name}'): 失败 {str(e)[:60]}")

    # ─── 6. 采样结果汇总 ─────────────────────────────────
    print("\n" + "=" * 60)
    print("6. 采样结果汇总")
    print("=" * 60)
    if sampled:
        name, pts, call = sampled
        print(f"  ✅ {name} ({call}) 返回采样点!")
        try:
            import numpy as np
            arr = np.array(pts).reshape(-1, 3)
            print(f"  点数: {len(arr)}")
            print(f"  前 3 点 (mm): {arr[:3].tolist()}")
            print(f"  后 3 点 (mm): {arr[-3:].tolist()}")
            print(f"  坐标范围 X:{arr[:,0].min():.1f}~{arr[:,0].max():.1f} "
                  f"Y:{arr[:,1].min():.1f}~{arr[:,1].max():.1f} "
                  f"Z:{arr[:,2].min():.1f}~{arr[:,2].max():.1f}")
        except Exception as e:
            print(f"  解析失败: {e}\n  原始: {repr(pts)[:200]}")
        print("\n  → Part 层级曲线采样可行! 可在 catia_extract 加'选曲线自动采样'模式。")
    else:
        print("  ❌ Part 层级仍未找到可用采样方法。")
        print("  → 3DE MeasurableService 确实只是'测量'服务, 不暴露曲线离散化。")
        print("  → 剩余路径: ①供应商 CAD 导出边界曲线点集  ②3DE 内手动沿边多选点 (现成代码支持)")

    sel.Clear()
    c.disconnect()
    print("\n" + "=" * 60)
    print("探测完成 — 请把输出贴回给 Claude")
    print("=" * 60)


if __name__ == "__main__":
    probe()
