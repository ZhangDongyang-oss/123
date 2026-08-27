"""
3DE SelectElement3 多点连续选择探测 (最后一个 3DE 原生采样探测)
================================================================
背景: 曲线离散化已两轮全封死 (Measurable GetPoints failed / VisuServices 无 tessellation)。
      Search 批量选也 failed。唯一没交互测过的 3DE 原生能力 = SelectElement3 (多选版)。
目标: 测 SelectElement3 能否让用户【一次对话框里连点多个点再确认】,
      而非每点一个对话框 (当前 extract_outline_points 的痛点)。
      若 sel.Count > 1 → 多点连续选择可行 → 采样速度 N× 提升。

用法:
    cd modules/smart/mirro-fov/python
    python probe_multiselect.py

操作:
    脚本会依次试 3 种调用方式, 每次弹 CATIA 选择框:
      - 方式 A: SelectElement2 (当前用的, 单选, 对照基线)
      - 方式 B: SelectElement3 单选模式
      - 方式 C: SelectElement3 多选模式 (关键 — 试着连点 3-5 个点再确定)
    每次选完看 sel.Count: >1 就是多选成功。
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

from mirror_fov.catia_conn import CATIAConnection, ConnectionError, MEASURABLE_POINT  # noqa: E402


def read_all_points(spa, sel):
    """读当前 Selection 里所有点的坐标"""
    pts = []
    for i in range(1, sel.Count + 1):
        try:
            obj = sel.Item(i).Value
            meas = spa.GetMeasurable(obj, MEASURABLE_POINT)
            p = meas.GetPoint()
            pts.append((float(p[0]), float(p[1]), float(p[2])))
        except Exception as e:
            pts.append(f"<读取失败: {str(e)[:50]}>")
    return pts


def try_select(label, fn):
    """弹框 + 读结果, 返回 (status, count, points)"""
    c = try_select._c
    spa = c.spa
    sel = c.get_selection()
    sel.Clear()
    print(f"\n--- {label} ---")
    print(f"  操作: 弹出选择框后, 【试着连点 3-5 个点再按确定】(若能连点); 取消则跳过")
    try:
        status = fn(sel)
    except Exception as e:
        print(f"  调用失败: {type(e).__name__}: {str(e)[:80]}")
        return ("err", 0, [])
    count = sel.Count
    print(f"  返回 status={status!r}, sel.Count={count}")
    if count > 0:
        pts = read_all_points(spa, sel)
        for j, p in enumerate(pts, 1):
            if isinstance(p, tuple):
                print(f"    点{j}: ({p[0]:.2f}, {p[1]:.2f}, {p[2]:.2f}) mm")
            else:
                print(f"    点{j}: {p}")
        verdict = "✅ 多点连续选择可行!" if count > 1 else "单选 (和 SelectElement2 一样)"
        print(f"  → {verdict}")
        sel.Clear()
        return (status, count, pts)
    sel.Clear()
    return (status, 0, [])


def probe():
    c = CATIAConnection()
    try:
        c.connect()
    except ConnectionError as e:
        print(f"连接失败: {e}")
        return
    try_select._c = c
    print(f"已连接: {c.get_version()}")
    print("=" * 60)
    print("本脚本测 SelectElement3 能否【连续多点选择】")
    print("每种方式弹一次框, 你试着连点多个点再确定, 看 sel.Count 能否 >1")
    print("=" * 60)

    results = {}

    # 方式 A: SelectElement2 (对照基线, 当前代码用的)
    results["A_SelectElement2"] = try_select(
        "方式 A: SelectElement2 (当前用的, 对照)",
        lambda sel: sel.SelectElement2(["Point"], "A: 选一个点 (基线对照)", False)
    )

    # 方式 B: SelectElement3 — 试不同 iPickMode 参数
    # CATIA V5 SelectElement3(iFilterType, iPrompt, iTriggerMode, iPickMode)
    # iTriggerMode: 0=Click,1=IndicationOrClick,2=Indication
    # iPickMode: 试 0 和 1 (不确定哪个是多选)
    for pick_mode in [0, 1]:
        for trigger in [0, 1]:
            key = f"B_SE3_pick{pick_mode}_trig{trigger}"
            results[key] = try_select(
                f"方式 B: SelectElement3 (pickMode={pick_mode}, trigger={trigger})",
                lambda sel, pm=pick_mode, tg=trigger: sel.SelectElement3(
                    ["Point"], f"选点 (pick={pm},trig={tg})", tg, pm)
            )
            # 只测第一个成功的组合就够, 不用全试 4 种
            if results[key][1] > 1:
                print(f"\n  ★ pickMode={pick_mode}/trigger={trigger} 已能多点, 跳过剩余组合")
                break
        else:
            continue
        break

    # ─── 汇总 ─────────────────────────────────────────────
    print("\n" + "=" * 60)
    print("汇总")
    print("=" * 60)
    multi = [(k, v) for k, v in results.items() if v[1] > 1]
    if multi:
        print(f"✅ 发现 {len(multi)} 种多点选择方式:")
        for k, (st, cnt, pts) in multi:
            print(f"  {k}: sel.Count={cnt}")
        print("\n→ 可在 catia_extract 改用 SelectElement3, 一次对话框连点 N 个轮廓点,")
        print("  替代当前'每点一个对话框'的循环。采样速度大幅提升。")
    else:
        max_cnt = max(v[1] for v in results.values())
        print(f"❌ 所有方式 sel.Count 均 ≤ {max_cnt} — SelectElement3 不能多点连续选择。")
        print("→ 3DE 原生采样能力到此穷尽: 只能每点一个对话框 (GetPoint proven)。")
        print("→ 提升采样质量的剩余路径:")
        print("   ① 多选点 (现成代码支持, 操作费时但可靠)")
        print("   ② 3DE 导出边界为 STEP/IGS/DXF → Python 解析 (高分辨率, 依赖重)")
        print("   ③ 供应商直接提供 CAD 边界曲线点集")

    c.disconnect()
    print("\n探测完成 — 请把输出贴回给 Claude")


if __name__ == "__main__":
    probe()
