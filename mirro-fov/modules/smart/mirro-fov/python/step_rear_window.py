#!/usr/bin/env python3
"""
后挡风玻璃轮廓 STEP 提取
========================
从 STEP 文件中自动识别后挡风面, 提取完整边界轮廓 (所有边缝合)。

与镜面提取的区别:
  - 面名匹配: 后挡风/rear window/backlight (非 镜面/lens)
  - 边界处理: 全部边按 EDGE_LOOP 顺序缝合 (非只取最长边)
  - 无镜像: 后挡风是完整面, 不需要半模对称
  - 输出: 3D 整车坐标 mm (供 vehicle JSON 的 rear_window.outline 字段)

用法:
  python step_rear_window.py <step_file> [--n N] [--output out.json]
  python step_rear_window.py <step_file> --list    # 列出所有候选面
"""
import re
import sys
import json
import math
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import step_curve_sampler as scs
import step_topology as st
import step_verify
import numpy as np

try:
    # line_buffering: stdout 接管道时默认块缓冲, 进度行必须按行即时刷出
    sys.stdout.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)
except Exception:
    pass


# ─── 后挡风面名匹配 ───────────────────────────────────

REAR_WINDOW_KEYWORDS = [
    '后挡风', '后风挡', '后窗', '背门玻璃',
    'rear window', 'backlight', 'rear windshield', 'rear glass',
    '后挡风玻璃', '后风窗',
]


def find_rear_window_faces(entities):
    """找名字含后挡风关键词的 ADVANCED_FACE"""
    faces = []
    for eid, (etype, args) in entities.items():
        if etype != "ADVANCED_FACE":
            continue
        tokens = scs._split_top_level(args)
        if len(tokens) < 2:
            continue
        name_raw = tokens[0].strip().strip("'")
        name = st._decode_step_name(name_raw)
        name_lower = name.lower()
        kw = any(k in name_lower for k in REAR_WINDOW_KEYWORDS)
        if kw:
            bounds_ref = scs._parse_ref_list(tokens[1])
            faces.append((eid, name, bounds_ref, tokens))
    return faces


def find_all_faces(entities):
    """列出所有 ADVANCED_FACE (降级时供用户选)"""
    faces = []
    for eid, (etype, args) in entities.items():
        if etype != "ADVANCED_FACE":
            continue
        tokens = scs._split_top_level(args)
        if len(tokens) < 2:
            continue
        name_raw = tokens[0].strip().strip("'")
        name = st._decode_step_name(name_raw)
        bounds_ref = scs._parse_ref_list(tokens[1])
        faces.append((eid, name, bounds_ref))
    return faces


def sample_face_boundary_stitched(face_eid, bounds_refs, entities, points, n=20):
    """提取面的完整边界: 所有边按 LOOP 顺序采样后缝合为一个闭合轮廓。

    顶点锚定采样 (公共实现): B-spline 参数化采样不一定到达共享顶点,
    用 VERTEX_POINT 作为确定端点可消除相邻边的缝合飞线。
    """
    edges = st.trace_face_boundary(face_eid, bounds_refs, entities)
    if not edges:
        return None, []

    all_pts = []
    edge_info = []
    for edge in edges:
        # 按边长自适应采样密度 (点距 ~3mm 均匀), 保证闸门阈值可靠
        n_edge = st.edge_adaptive_sample_n(edge, entities, points, n, 3.0)
        chained = st.sample_edge_vertex_chained(edge, entities, points, n_edge)
        if chained is None or chained[1] is None or len(chained[1]) < 2:
            pts, length = st.sample_edge_curve(edge, entities, points, n_edge)  # 降级: 无顶点可用
            if pts is None or len(pts) < 2:
                edge_info.append({'id': edge['edge_curve'], 'type': edge['geom_type'],
                                  'length': 0, 'pts': 0, 'status': 'skip'})
                continue
            contribution = [[float(p[0]), float(p[1]), float(p[2])] for p in pts]
            length = length or 0
            status = 'ok'
        else:
            v_start, interior, v_end = chained
            stack = np.vstack([v_start, interior, v_end])
            contribution = [[float(p[0]), float(p[1]), float(p[2])] for p in stack]
            length = float(np.sum(np.linalg.norm(np.diff(stack, axis=0), axis=1)))  # 弧长近似
            status = 'ok-chained'
        # 去首点 (与上一条边尾点重合, 避免重复)
        if all_pts:
            last = np.array(all_pts[-1])
            first = np.array(contribution[0])
            if np.linalg.norm(last - first) < 1.0:
                contribution = contribution[1:]
        all_pts.extend(contribution)
        edge_info.append({'id': edge['edge_curve'], 'type': edge['geom_type'],
                          'length': round(length, 1), 'pts': len(contribution), 'status': status})

    # 删除退化环的重复描边段 (路径出去又沿原路折回) — 不删则轮廓自重叠/断点
    if all_pts:
        all_pts = st.strip_doubled_paths(np.array(all_pts), tol_mm=2.0).tolist()

    # 闭合
    if all_pts and np.linalg.norm(np.array(all_pts[0]) - np.array(all_pts[-1])) > 1.0:
        all_pts.append(all_pts[0])

    return all_pts, edge_info


def mirror_half_outline(pts, tol_mm=2.0):
    """半模镜像: 剔除 Y≈0 中心线接缝段 (保留接缝端点), 镜像 Y→-Y 拼接成完整轮廓。

    半模闭环 = [底中心 → 左/右弧 → 顶中心 → (Y≈0 接缝回到底中心)]。
    接缝端点 (顶/底中心, 精确 Y≈0) 作为拼接点, 不依赖弧末点的采样密度。
    """
    arr = np.asarray(pts, dtype=float)
    n = len(arr)
    # 1. 找 Y≈0 的连续接缝段 (最长的 |Y|<tol 连续块)
    on_seam = [abs(arr[i, 1]) < tol_mm for i in range(n)]
    best_run, best_start = 0, -1
    i = 0
    while i < n:
        if on_seam[i]:
            j = i
            while j < n and on_seam[j]:
                j += 1
            if j - i > best_run:
                best_run, best_start = j - i, i
            i = j
        else:
            i += 1
    if best_run < 3 or best_start < 0:
        return arr  # 无接缝, 原样返回

    # 2. 接缝端点 (精确 Y≈0): 顶中心 (接缝起点) / 底中心 (接缝终点)
    seam_end = best_start + best_run
    s_start = arr[best_start]       # 顶中心
    s_end = arr[seam_end - 1]       # 底中心

    # 3. 开弧含端点: [底中心 → 弧 → 顶中心]
    arc = np.concatenate([[s_end], arr[seam_end:], arr[:best_start], [s_start]])

    # 4. 镜像反向弧 (Y→-Y): [顶中心 → 右侧弧 → 底中心]
    mirrored = arc[::-1].copy()
    mirrored[:, 1] = -mirrored[:, 1]

    # 5. 拼接: arc + mirrored; 首尾都在 Y≈0 (顶中心), 去重后自然闭合
    full = list(arc)
    if np.linalg.norm(np.array(full[-1]) - mirrored[0]) < 2.0 * tol_mm:
        mirrored = mirrored[1:]
    full.extend(mirrored.tolist())
    if np.linalg.norm(np.array(full[0]) - np.array(full[-1])) > 1.0:
        full.append(full[0].tolist())
    return np.array(full)


def convex_hull_yz(pts_3d):
    """3D 点在 Y-Z 投影上的凸包 (monotone chain), 返回 3D 凸包顶点 (未闭合)。

    后挡风法线朝 -X, pointInPolygon3D 也投到 Y-Z 平面 → 两者投影一致。
    """
    keyed = {}
    for p in pts_3d:
        key = (round(p[1], 2), round(p[2], 2))  # (Y, Z) 去重
        if key not in keyed:
            keyed[key] = p
    keys = sorted(keyed.keys())
    if len(keys) < 3:
        return [keyed[k] for k in keys]

    def cross(o, a, b):
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])

    lower = []
    for p in keys:
        while len(lower) >= 2 and cross(lower[-2], lower[-1], p) <= 0:
            lower.pop()
        lower.append(p)
    upper = []
    for p in reversed(keys):
        while len(upper) >= 2 and cross(upper[-2], upper[-1], p) <= 0:
            upper.pop()
        upper.append(p)
    hull_keys = lower[:-1] + upper[:-1]
    return [keyed[k] for k in hull_keys]


def resample_outline(pts, spacing_mm=3.0):
    """对闭合轮廓重新均匀采样 (凸包顶点不均匀: 弧形边密集/直线边稀疏)。"""
    out = []
    n = len(pts)
    for i in range(n):
        a = np.array(pts[i])
        b = np.array(pts[(i + 1) % n])
        seg_len = float(np.linalg.norm(b - a))
        if seg_len < 1e-9:
            continue
        n_seg = max(1, int(seg_len / spacing_mm) + 1)
        for j in range(n_seg):
            t = j / n_seg
            out.append((a + (b - a) * t).tolist())
    return out


def merge_face_outlines(faces, entities, points, n=25):
    """合并多个同名面的轮廓 (供应商把零件拆成多个 patch)。

    凸包法: 各面轮廓点合并 → Y-Z 投影凸包 → 均匀重采样 → 完整外边界。
    失败返回 None。
    """
    all_pts = []
    for fid, name, bounds, tokens in faces:
        pts, _ = sample_face_boundary_stitched(fid, bounds, entities, points, n)
        if pts and len(pts) >= 3:
            all_pts.extend(pts)
    if len(all_pts) < 6:
        return None
    hull = convex_hull_yz(all_pts)
    if len(hull) < 4:
        return None
    # 凸包顶点点距不均匀, 重新均匀采样 (3mm) 避免自检闸门误报断点
    outline = resample_outline(hull, spacing_mm=3.0)
    if len(outline) < 4:
        return None
    if np.linalg.norm(np.array(outline[0]) - np.array(outline[-1])) > 1.0:
        outline.append(outline[0])
    return outline


def geometry_fallback_faces(entities, points):
    """关键词匹配失败时按几何特征找后挡风面 (两级筛选):
    1) 粗筛: 原始采样跨度合理 (<2000mm) + Y/Z 跨度在窗口量级
    2) 精筛: 对面积最大的候选做 锚定缝合 + 自检闸门, 取通过中最大者。
    返回与 find_rear_window_faces 同构的 4 元组 (eid, name, bounds, tokens)。"""
    all_faces = find_all_faces(entities)
    n_total = len(all_faces)
    coarse = []
    for idx, (fid, name, bounds) in enumerate(all_faces):
        if idx % 200 == 0:
            print(f"STEP_PROGRESS|降级扫描面 {idx}/{n_total}")
        edges = st.trace_face_boundary(fid, bounds, entities)
        if not edges:
            continue
        sample_pts = []
        for edge in edges[:8]:
            # 粗筛也必须用顶点锚定采样 — 原始曲线采样会被超出顶点的曲线延伸污染 (跨度虚高)
            chained = st.sample_edge_vertex_chained(edge, entities, points, 6)
            if chained is not None and chained[1] is not None and len(chained[1]) >= 2:
                ts, interior, te = chained
                sample_pts.extend(np.vstack([ts, interior, te]).tolist())
            else:
                pts, _ = st.sample_edge_curve(edge, entities, points, 6)
                if pts is not None:
                    sample_pts.extend(pts.tolist())
        if len(sample_pts) < 3:
            continue
        arr = np.array(sample_pts)
        sp = [float(np.ptp(arr[:, k])) for k in range(3)]
        if any(s > 2000 for s in sp):
            continue  # 跨度异常 (采样污染/装配上下文)
        if not (300 <= sp[1] <= 2000 and 100 <= sp[2] <= 1000):
            continue
        coarse.append((sp[1] * sp[2], fid, name, bounds))
    coarse.sort(key=lambda x: -x[0])

    passed = []
    for _, fid, name, bounds in coarse[:20]:  # 只精筛面积最大的前 20 个
        pts, _ = sample_face_boundary_stitched(fid, bounds, entities, points, 25)
        if not pts or len(pts) < 5:
            continue
        arr = np.array(pts)
        sp = [float(np.ptp(arr[:, k])) for k in range(3)]
        try:
            step_verify.assert_outline_ok(pts, f'#{fid}')
            passed.append((sp[1] * sp[2], fid, name, bounds))
        except ValueError:
            pass  # 缝合不连续的面直接淘汰
    passed.sort(key=lambda x: -x[0])
    return [(fid, name, bounds, None) for _, fid, name, bounds in passed[:3]]


def check_coordinate_system(pts):
    """校验坐标范围是否在整车坐标系合理区间"""
    arr = np.array(pts)
    x_min, x_max = float(arr[:, 0].min()), float(arr[:, 0].max())
    y_min, y_max = float(arr[:, 1].min()), float(arr[:, 1].max())
    z_min, z_max = float(arr[:, 2].min()), float(arr[:, 2].max())
    spans = {'x': x_max - x_min, 'y': y_max - y_min, 'z': z_max - z_min}

    # 整车坐标合理范围
    ok = (-500 < x_min < 8000 and -2500 < y_min < 2500 and -500 < z_min < 3500)
    # 后挡风典型尺寸: Y跨 800~1500mm, Z跨 300~800mm
    rear_window_like = spans['y'] > 500 and spans['z'] > 200

    return {
        'ranges': {'x': [round(x_min, 1), round(x_max, 1)],
                   'y': [round(y_min, 1), round(y_max, 1)],
                   'z': [round(z_min, 1), round(z_max, 1)]},
        'spans': {k: round(v, 1) for k, v in spans.items()},
        'vehicle_coord': ok,
        'rear_window_like': rear_window_like,
    }


def main():
    import argparse
    parser = argparse.ArgumentParser(description="后挡风轮廓 STEP 提取")
    parser.add_argument("step_file", help="STEP 文件路径")
    parser.add_argument("--n", type=int, default=30, help="每条边采样点数 (默认 30)")
    parser.add_argument("--output", "-o", help="输出 JSON 路径 (默认 <step>.rear-window.json)")
    parser.add_argument("--list", action="store_true", help="列出所有候选面, 不提取")
    parser.add_argument("--face-id", type=int, help="手动指定面 ID (自动识别失败时用)")
    args = parser.parse_args()

    print(f"解析 STEP: {args.step_file}")
    print("STEP_PROGRESS|解析 STEP 文件中...")
    entities, points = scs.parse_step(args.step_file)
    print(f"实体: {len(entities)}, 点: {len(points)}")
    print("STEP_PROGRESS|已解析实体, 查找后挡风面")

    # ─── 1. 找后挡风面 ──────────────────────────────────
    print("\n=== 1. 找后挡风 ADVANCED_FACE ===")
    faces = find_rear_window_faces(entities)

    if args.list:
        print(f"\n--list 模式: 列出所有 ADVANCED_FACE (共 {len(find_all_faces(entities))} 个)")
        all_faces = find_all_faces(entities)
        for fid, name, bounds in all_faces:
            # 快速采样看尺寸
            edges = st.trace_face_boundary(fid, bounds, entities)
            if not edges:
                continue
            sample_pts = []
            for edge in edges[:4]:  # 只采前4条边快速看尺寸
                pts, _ = st.sample_edge_curve(edge, entities, points, 5)
                if pts is not None:
                    sample_pts.extend([[float(p[0]), float(p[1]), float(p[2])] for p in pts])
            if len(sample_pts) < 3:
                continue
            arr = np.array(sample_pts)
            spans = f"X跨{np.ptp(arr[:,0]):.0f} Y跨{np.ptp(arr[:,1]):.0f} Z跨{np.ptp(arr[:,2]):.0f}"
            print(f"  #{fid} {name!r}: {spans} ({len(edges)} 边)")
        return

    if not faces and args.face_id is None:
        print("  ❌ 未找到后挡风面 (名字不含后挡风/rear window/backlight)")
        print("  💡 尝试按几何特征在所有面中降级查找...")
        faces = geometry_fallback_faces(entities, points)
        if not faces:
            print("  ❌ 几何降级也未找到合理后挡风面 (Y跨500~1600, Z跨150~800, 跨度<2000)")
            print("  💡 用 --list 查看所有面, 再用 --face-id #ID 手动指定")
            return
        print(f"  ✅ 几何降级: 找到 {len(faces)} 个候选面")

    # ─── 2. 选目标面 ────────────────────────────────────
    if args.face_id:
        # 手动指定
        target = None
        for fid, name, bounds, _ in faces:
            if fid == args.face_id:
                target = (fid, name, bounds)
                break
        if target is None:
            # 在所有面里找
            all_faces = find_all_faces(entities)
            for fid, name, bounds in all_faces:
                if fid == args.face_id:
                    target = (fid, name, bounds)
                    break
        if target is None:
            print(f"  ❌ 面 #{args.face_id} 不存在")
            return
        print(f"  手动指定: #{target[0]} {target[1]!r}")
    else:
        # 自动: 多同名面时合并 (供应商可能把零件拆成多个 patch), 单面取面积最大
        print(f"\n=== 2. 从 {len(faces)} 个候选面选后挡风 ===")
        if len(faces) > 1:
            target = None  # 多面合并模式
            print(f"  ✅ {len(faces)} 个同名面 → 合并提取")
        else:
            best = None
            best_score = -1
            for fid, name, bounds, _ in faces:
                pts, _ = sample_face_boundary_stitched(fid, bounds, entities, points, 25)
                if not pts or len(pts) < 5:
                    continue
                arr = np.array(pts)
                y_span = float(np.ptp(arr[:, 1]))
                z_span = float(np.ptp(arr[:, 2]))
                # 半模面 Y 跨只有一半 (如 571 vs 全 1143), 用 2×Y 估全宽
                eff_y = y_span * 2 if (arr[:, 1].min() > -5 or arr[:, 1].max() < 5) else y_span
                score = eff_y * z_span
                print(f"  #{fid} {name!r}: Y跨{y_span:.0f} Z跨{z_span:.0f} (score={score:.0f})")
                if y_span > 300 and z_span > 100 and score > best_score:
                    best_score = score
                    best = (fid, name, bounds)
            if best is None:
                print("  ❌ 没有面符合后挡风尺寸")
                print("  💡 用 --list 查看所有面, 再用 --face-id #ID 手动指定")
                return
            target = best
            print(f"\n  ✅ 选定: #{target[0]} {target[1]!r}")

    # ─── 3. 提取轮廓 (多面合并 或 单面) ──────────────────
    print("STEP_PROGRESS|缝合轮廓边...")
    if target is None:
        # 多面合并 (供应商拆 patch)
        print(f"\n=== 3. 合并 {len(faces)} 个同名面轮廓 ===")
        outline = merge_face_outlines(faces, entities, points, args.n)
        edge_info = []
        if not outline or len(outline) < 4:
            print("  ❌ 多面合并失败 (点太少)")
            return
        fid = faces[0][0]
        name = f'{len(faces)}个面合并'
        print(f"  合并后 {len(outline)} 点")
    else:
        fid, name, bounds = target
        print(f"\n=== 3. 提取完整边界 (面 #{fid}, 每边 {args.n} 点) ===")
        outline, edge_info = sample_face_boundary_stitched(fid, bounds, entities, points, args.n)
        if not outline or len(outline) < 4:
            print("  ❌ 边界提取失败 (点太少)")
            return
        print(f"  边数: {len(edge_info)}")
        for ei in edge_info:
            print(f"    #{ei['id']} {ei['type']} len={ei['length']}mm {ei['pts']}点 {ei['status']}")
        print(f"  轮廓总点数: {len(outline)}")

    # ─── 3.5 半模检测: 轮廓 Y 全在中心线一侧 (含 0) → 半模, 镜像成完整轮廓 ──
    # (后挡风与镜面一样可能存在半边建模; 完整轮廓 Y 应跨两侧)
    # 需同时满足: 单侧 + 一侧跨度 >150mm (排除小碎面) + 轮廓上有 Y≈0 接缝段
    arr0 = np.array(outline)
    y_min0, y_max0 = float(arr0[:, 1].min()), float(arr0[:, 1].max())
    one_side = y_min0 > -5 or y_max0 < 5
    has_seam = float(np.min(np.abs(arr0[:, 1]))) < 2.0
    if one_side and has_seam and (y_max0 - y_min0) > 150:
        print(f"\n=== 3.5 半模检测 ===\n  Y[{y_min0:.0f},{y_max0:.0f}] 单侧半模 (含 Y≈0 接缝) → 镜像 Y→-Y 成完整轮廓")
        outline = mirror_half_outline(np.array(outline)).tolist()
        print(f"  镜像后 {len(outline)} 点")

    # ─── 3.6 自检闸门: 连续闭合/无飞线/跨度合理, 不过则失败 ──
    try:
        step_verify.assert_outline_ok(outline, f"后挡风 #{fid} {name!r}")
        print(f"\n=== 3.5 自检闸门 ===\n  连续闭合 ✓ 无断点 ✓ 跨度合理 ✓")
    except ValueError as e:
        print(f"\n=== 3.5 自检闸门 ===\n  ❌ {e}")
        sys.exit(1)

    # ─── 4. 坐标系校验 ──────────────────────────────────
    print(f"\n=== 4. 坐标系校验 ===")
    coord = check_coordinate_system(outline)
    print(f"  范围: X{coord['ranges']['x']} Y{coord['ranges']['y']} Z{coord['ranges']['z']}")
    print(f"  跨度: X{coord['spans']['x']}mm Y{coord['spans']['y']}mm Z{coord['spans']['z']}mm")
    print(f"  整车坐标: {'✅' if coord['vehicle_coord'] else '⚠️ 可能不是整车坐标'}")
    print(f"  后挡风尺寸: {'✅' if coord['rear_window_like'] else '⚠️ 尺寸异常'}")

    # ─── 5. 输出 JSON ───────────────────────────────────
    out = {
        "source": "step_rear_window",
        "step_file": args.step_file,
        "face_id": fid,
        "face_name": name,
        "outline_mm": outline,
        "outline_count": len(outline),
        "edges": edge_info,
        "coordinate_system": "vehicle" if coord['vehicle_coord'] else "unknown",
        "ranges": coord['ranges'],
        "spans": coord['spans'],
        "unit": "mm",
    }
    out_path = args.output or str(Path(args.step_file).with_suffix('.rear-window.json'))
    with open(out_path, 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
    print(f"\n→ 输出: {out_path}")
    print(f"  {len(outline)} 点, 可直接用于 vehicle JSON 的 rear_window.outline 字段")


if __name__ == "__main__":
    main()
