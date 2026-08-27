"""
STEP 拓扑解析 — 识别镜面反射区边界曲线
==========================================
通过 ADVANCED_FACE('镜面lens', ...) → FACE_OUTER_BOUND → EDGE_LOOP →
ORIENTED_EDGE → EDGE_CURVE → 几何曲线 的拓扑链路, 确定性找到反射区边界
(不靠长度猜)。

链路:
  ADVANCED_FACE(name, (bound_ref), surface_ref, sense)
    → FACE_OUTER_BOUND('', loop_ref, .T.)  或 FACE_BOUND
      → EDGE_LOOP('', (oe_ref, oe_ref, ...))
        → ORIENTED_EDGE('', *, *, edge_curve_ref, orient)
          → EDGE_CURVE('', v_start, v_end, geom_curve_ref, .T.)
            → 几何曲线 (B_SPLINE / CIRCLE / LINE)

只读。用法: python step_topology.py <step_file>
"""
import re
import sys
import json
import math
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)) if (os := __import__('os')) else '.')
import step_curve_sampler as scs  # noqa: E402
import step_verify  # noqa: E402
import numpy as np  # noqa: E402

try:
    # line_buffering: stdout 接管道时默认块缓冲, 进度行必须按行即时刷出
    sys.stdout.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)
except Exception:
    pass


def _decode_step_name(s):
    """解码 STEP 字符串里的 \\X2\\XXXX\\X0\\ Unicode"""
    def repl(m):
        try:
            return bytes.fromhex(m.group(1).replace(' ', '')).decode('utf-16be')
        except Exception:
            return m.group(0)
    return re.sub(r'\\X2\\([0-9A-Fa-f ]+)\\X0\\', repl, s)


def find_mirror_faces(entities):
    """找名字含 '镜面'/'lens'/'reflective' 的 ADVANCED_FACE"""
    faces = []
    for eid, (etype, args) in entities.items():
        if etype != "ADVANCED_FACE":
            continue
        # ADVANCED_FACE(name, (bounds), surface, sense)
        tokens = scs._split_top_level(args)
        if len(tokens) < 2:
            continue
        name_raw = tokens[0].strip().strip("'")
        name = _decode_step_name(name_raw)
        bounds_ref = scs._parse_ref_list(tokens[1])
        # 名字含镜面/内镜片/lens/reflective
        kw = any(k in name.lower() for k in ['镜面', '内镜片', 'lens', 'reflect', 'mirror'])
        if kw:
            faces.append((eid, name, bounds_ref, tokens))
    return faces


def trace_face_boundary(face_eid, bounds_refs, entities):
    """遍历面的 bounds → loops → oriented_edges → edge_curves → 几何曲线"""
    edges = []
    for bound_ref in bounds_refs:
        if bound_ref not in entities:
            continue
        btype, bargs = entities[bound_ref]
        # FACE_OUTER_BOUND / FACE_BOUND: ('', loop_ref, .T.)
        btokens = scs._split_top_level(bargs)
        if len(btokens) < 2:
            continue
        loop_ref_m = re.match(r'#(\d+)', btokens[1].strip())
        if not loop_ref_m:
            continue
        loop_ref = int(loop_ref_m.group(1))
        if loop_ref not in entities:
            continue
        ltype, largs = entities[loop_ref]
        if ltype != "EDGE_LOOP":
            continue
        # EDGE_LOOP: ('', (oe1, oe2, ...))
        oe_refs = scs._parse_ref_list(largs.split(',', 1)[1] if ',' in largs else largs)
        for oe_ref in oe_refs:
            if oe_ref not in entities:
                continue
            oetype, oeargs = entities[oe_ref]
            # ORIENTED_EDGE: ('', *, *, edge_curve_ref, .T./.F.)
            oetokens = scs._split_top_level(oeargs)
            ec_ref = None
            orient = True  # 默认正向
            for tok in oetokens:
                tok = tok.strip()
                m = re.match(r'#(\d+)', tok)
                if m and ec_ref is None:
                    ec_ref = int(m.group(1))
                elif tok == '.F.':
                    orient = False
            if ec_ref is None or ec_ref not in entities:
                continue
            ec_type, ec_args = entities[ec_ref]
            # EDGE_CURVE: ('', v_start, v_end, geom_curve_ref, .T.)
            ectokens = scs._split_top_level(ec_args)
            geom_ref = None
            v_start = v_end = None
            refs = [int(m.group(1)) for tok in ectokens if (m := re.match(r'#(\d+)', tok.strip()))]
            if len(refs) >= 3:
                v_start, v_end, geom_ref = refs[0], refs[1], refs[2]
            if geom_ref is None or geom_ref not in entities:
                continue
            g_type, g_args = entities[geom_ref]
            edges.append({
                'edge_curve': ec_ref,
                'geom_id': geom_ref,
                'geom_type': g_type,
                'geom_args': g_args,
                'v_start': v_start,
                'v_end': v_end,
                'orient': orient,  # True=正向, False=反向 (采样后需反转点序)
            })
    return edges


def sample_edge_curve(edge, entities, points, n=20):
    """采样一条 EDGE_CURVE 的几何曲线 (按 ORIENTED_EDGE 方向, orient=False 反转)"""
    gtype = edge['geom_type']
    gargs = edge['geom_args']
    gid = edge['geom_id']
    pts = None
    length = None
    if gtype == "B_SPLINE_CURVE_WITH_KNOTS":
        c = scs.parse_bspline_curve(gid, gargs, entities, points)
        if c:
            pts = scs.sample_bspline(c, n)
            length = c.get('length')
    elif gtype == "CIRCLE":
        c = scs.parse_circle(gid, gargs, entities, points)
        if c:
            pts = scs.sample_circle(c, max(n, 8))
            length = 2 * math.pi * c['radius']
    elif gtype == "LINE":
        pts = _parse_line(edge, entities, points)
    if pts is None:
        return None, None
    # orient=False: 反转点序 (EDGE_CURVE 几何方向与 LOOP 行进方向相反)
    if not edge.get('orient', True):
        pts = pts[::-1]
    return pts, length


def _resolve_vertex(vid, entities, points):
    """VERTEX_POINT -> CARTESIAN_POINT 解引用"""
    if vid is None:
        return None
    if vid in points:  # 直接是 CARTESIAN_POINT
        return points[vid]
    if vid not in entities:
        return None
    etype, args = entities[vid]
    if etype != "VERTEX_POINT":
        return None
    tokens = scs._split_top_level(args)
    refs = [int(m.group(1)) for tok in tokens if (m := re.match(r'#(\d+)', tok.strip()))]
    for r in refs:
        if r in points:
            return points[r]
    return None


def sample_edge_vertex_chained(edge, entities, points, n=40):
    """采样边, 用 VERTEX_POINT 作为确定端点, 只取顶点之间部分。

    修复飞线: B 样条参数化采样不一定到达共享顶点, 导致相邻边间隙。
    顶点是模型的真实边界点, 用顶点链式连接保证连续。
    返回 (trav_start, interior_pts, trav_end) — 按 ORIENTED_EDGE 遍历方向
    (orient=True: v_start→v_end; orient=False: v_end→v_start)。
    (公共实现: 外镜球面镜/内镜/后挡风三条路径共用)
    """
    pts, _ = sample_edge_curve(edge, entities, points, n)
    if pts is None or len(pts) < 2:
        return None, None, None
    arr = np.array(pts)
    v_start = _resolve_vertex(edge.get('v_start'), entities, points)
    v_end = _resolve_vertex(edge.get('v_end'), entities, points)
    if v_start is None or v_end is None:
        return None, None, None
    # 采样中找最接近 v_start / v_end 的点
    ds = np.linalg.norm(arr - v_start, axis=1)
    de = np.linalg.norm(arr - v_end, axis=1)
    is_ = int(np.argmin(ds))
    ie = int(np.argmin(de))
    lo, hi = min(is_, ie), max(is_, ie)
    interior = arr[lo:hi + 1]
    # 方向: 按 ORIENTED_EDGE 遍历方向 (pts 已由 sample_edge_curve 按 orient 处理,
    # 这里再保证 interior[0] 是遍历起点侧: orient=True→v_start, False→v_end)
    orient = bool(edge.get('orient', True))
    trav_start = v_start if orient else v_end
    trav_end = v_end if orient else v_start
    if np.linalg.norm(interior[0] - trav_start) > np.linalg.norm(interior[-1] - trav_start):
        interior = interior[::-1]
    return trav_start, interior, trav_end


def edge_adaptive_sample_n(edge, entities, points, base_n=25, spacing_mm=3.0):
    """按边长自适应采样密度: 保证点距 ≈ spacing_mm。
    固定按条数采样会让长边稀疏/短边过密, 破坏闸门的中位间距阈值。"""
    _, length = sample_edge_curve(edge, entities, points, 8)  # 只取曲线长度
    if length and length > 0:
        return max(base_n, int(length / spacing_mm) + 1)
    return base_n


def strip_doubled_paths(pts, tol_mm=2.0):
    """删除退化环的重复描边段 (CAD 导出常见: 路径出去又沿原路折回, 或整段描两遍)。

    空间网格哈希记录已保留点; 当前点与已保留的非相邻点重合 (距离 < tol)
    → 视为重复描边, 连续重复段整体删除; 重复段沿原路径折回, 段尾自然衔接。
    所有点 (含末点) 都参与判定; 闭合由调用方负责 (调用方按首尾距补闭合点)。
    """
    arr = np.asarray(pts, dtype=float)
    n = len(arr)
    if n < 8:
        return arr
    cell = max(tol_mm, 0.5)
    grid = {}  # (ix, iy, iz) -> [kept 索引]

    def is_dup(ki):
        kx, ky, kz = (int(arr[ki][k] // cell) for k in range(3))
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for dz in (-1, 0, 1):
                    for j in grid.get((kx + dx, ky + dy, kz + dz), ()):
                        if ki - j > 3 and np.linalg.norm(arr[ki] - arr[j]) < tol_mm:
                            return True
        return False

    kept = [0]
    grid.setdefault(tuple(int(arr[0][k] // cell) for k in range(3)), []).append(0)
    for i in range(1, n):
        if is_dup(i):
            continue  # 重复描边点 → 删除
        kept.append(i)
        grid.setdefault(tuple(int(arr[i][k] // cell) for k in range(3)), []).append(i)
    return arr[kept]


def _parse_line(edge, entities, points):
    """LINE: 两端点 (从 EDGE_CURVE 的 VERTEX_POINT 解引用到 CARTESIAN_POINT)"""
    vs, ve = edge.get('v_start'), edge.get('v_end')
    p_start = _resolve_vertex(vs, entities, points)
    p_end = _resolve_vertex(ve, entities, points)
    if p_start is not None and p_end is not None:
        return np.array([p_start, p_end])
    return None


def main():
    step_file = sys.argv[1] if len(sys.argv) > 1 else \
        r"STEP_FILE_PLACEHOLDER.stp"
    n = int(sys.argv[2]) if len(sys.argv) > 2 else 80

    print(f"解析 STEP: {step_file}")
    print("STEP_PROGRESS|解析 STEP 文件中...")
    entities, points = scs.parse_step(step_file)
    print(f"实体: {len(entities)}, 点: {len(points)}")
    print(f"STEP_PROGRESS|已解析 {len(entities)} 实体, 扫描镜面面")

    # ─── 1. 找反射区面 (名字含 内镜片/镜面/lens) ───────────
    print("\n=== 1. 找镜面 ADVANCED_FACE ===")
    faces = find_mirror_faces(entities)
    if not faces:
        print("未找到镜面面, 退出")
        return

    # ─── 2. 扫面找反射区 (平面 X≈const, Z跨≈50.8, Y跨≈112 半边) ──
    print(f"\n=== 2. 扫 {len(faces)} 个面找反射区 ===")
    target = None
    for fid, name, bounds, _ in faces:
        edges = trace_face_boundary(fid, bounds, entities)
        if not edges:
            continue
        all_pts = []
        for edge in edges:
            pts, _ = sample_edge_curve(edge, entities, points, 10)
            if pts is not None:
                all_pts.extend([[float(p[0]), float(p[1]), float(p[2])] for p in pts])
        if len(all_pts) < 3:
            continue
        arr = np.array(all_pts)
        x_span, y_span, z_span = np.ptp(arr[:, 0]), np.ptp(arr[:, 1]), np.ptp(arr[:, 2])
        # 反射区: 平面 (X<5), Z≈50.8 (高度), Y 半边≈112 或全宽≈225
        if x_span < 5 and abs(z_span - 50.8) < 15 and \
           (abs(y_span - 112.4) < 20 or abs(y_span - 224.8) < 30) and \
           y_span < 200 and z_span < 100:
            target = (fid, name, bounds, edges)
            print(f"  ✅ #{fid} {name!r}: X跨{x_span:.1f} Y跨{y_span:.1f} Z跨{z_span:.1f}")
            break
    if target is None:
        print("  ❌ 未找到反射区面")
        return

    fid, name, bounds, edges = target

    # ─── 3. 选最长非退化边做半边轮廓 ─────────────────────
    # 镜片轮廓边是 U 形 B-spline (顶→侧→底), 单条即半边轮廓;
    # 退化边 (缝, <5mm) 跳过, 取最长的那条
    print("STEP_PROGRESS|提取轮廓边...")
    print(f"\n=== 3. 选最长边做半边轮廓 (面 #{fid}) ===")
    edge_samples = []
    for edge in edges:
        # 顶点锚定采样: 共享顶点是边界真值 (B-spline 采样不落顶点会引入飞线/断点)
        chained = sample_edge_vertex_chained(edge, entities, points, n)
        if chained is None or chained[1] is None or len(chained[1]) < 2:
            pts, length = sample_edge_curve(edge, entities, points, n)  # 降级: 无顶点可用
            if pts is None or len(pts) < 2:
                continue
            edge_samples.append((edge, pts, length or 0))
            print(f"  #{edge['edge_curve']} len={length or 0:.1f}mm {len(pts)}点 (无顶点锚定)")
            continue
        v_start, interior, v_end = chained
        pts = np.vstack([v_start, interior, v_end])
        length = float(np.sum(np.linalg.norm(np.diff(pts, axis=0), axis=1)))  # 弧长近似
        edge_samples.append((edge, pts, length))
        print(f"  #{edge['edge_curve']} len={length:.1f}mm {len(pts)}点 (顶点锚定)")
    if not edge_samples:
        print("  ❌ 无可采样边")
        return
    # 最长边
    edge_samples.sort(key=lambda x: -x[2])
    main_edge, main_pts, main_len = edge_samples[0]
    print(f"\n  选定 #{main_edge['edge_curve']} (最长 {main_len:.1f}mm) 做半边轮廓")

    # ─── 4. 半边轮廓 → 镜像成全宽 ───────────────────────
    half = [[float(p[0]), float(p[1]), float(p[2])] for p in main_pts]
    # 不补飞线闭合: 开边 (U形) 的起终点在镜面中心线两端 (底中心/顶中心), 镜像后自然对接;
    # 若边本身是闭合环 (起终点重合) 则直接使用
    arr = np.array(half)
    y_span = np.ptp(arr[:, 1])
    print(f"\n=== 4. 半边轮廓 ===")
    print(f"  {len(half)} 点, Y:{arr[:,1].min():.1f}~{arr[:,1].max():.1f} (跨{y_span:.1f}), Z跨{np.ptp(arr[:,2]):.1f}")

    needs_mirror = y_span < 180  # 半边<180, 全宽≈225
    if needs_mirror:
        print(f"\n=== 5. 镜像 Y→-Y 成全宽 ===")
        # 半边 (Y≤0) + 镜像反向拼接, 在中心线 (Y≈0) 对接; 不去点 (中心对接点必须保留)
        mirrored = [[p[0], -p[1], p[2]] for p in reversed(half)]
        full = list(half)
        # 对接处若重合 (顶中心), 去掉镜像首点避免重复
        if mirrored and np.linalg.norm(np.array(full[-1]) - np.array(mirrored[0])) < 0.5:
            mirrored = mirrored[1:]
        full.extend(mirrored)
        # 闭合: 底中心短段 (左右半边的起点间, 实际底边在此连续)
        if np.linalg.norm(np.array(full[0]) - np.array(full[-1])) > 0.5:
            full.append(full[0])
        total_outline = full
    else:
        total_outline = half

    arr = np.array(total_outline)
    print(f"  全宽: {len(total_outline)} 点, Y跨{np.ptp(arr[:,1]):.2f} Z跨{np.ptp(arr[:,2]):.2f}")
    y_ok = abs(np.ptp(arr[:, 1]) - 224.8) < 5
    z_ok = abs(np.ptp(arr[:, 2]) - 50.8) < 3
    print(f"  吻合 车型C: Y {'✅' if y_ok else '❌'} Z {'✅' if z_ok else '❌'}")

    # ─── 6. 自检闸门: 连续闭合/无飞线/跨度合理, 不过则失败 ──
    try:
        step_verify.assert_outline_ok(total_outline, f"镜面 #{fid} {name!r}")
        print(f"\n=== 6. 自检闸门 ===")
        print(f"  连续闭合 ✓ 无断点 ✓ 跨度合理 ✓")
    except ValueError as e:
        print(f"\n=== 6. 自检闸门 ===")
        print(f"  ❌ {e}")
        sys.exit(1)

    # ─── 7. 输出 JSON ───────────────────────────────────
    # local: lx=Y-center_y (镜面宽方向), ly=Z-center_z (镜面高方向)
    center_y = float((arr[:, 1].min() + arr[:, 1].max()) / 2)
    center_z = float((arr[:, 2].min() + arr[:, 2].max()) / 2)
    outline_local = [[p[1] - center_y, p[2] - center_z] for p in total_outline]
    out = {
        "source": "step_topology_mirror_face",
        "step_file": step_file,
        "face_id": fid,
        "face_name": name,
        "main_edge_id": main_edge['edge_curve'],
        "main_edge_length_mm": round(main_len, 2),
        "mirrored": bool(needs_mirror),
        "outline_global_mm": total_outline,
        "outline_local_mm": outline_local,
        "outline_count": len(total_outline),
        "center_mm": [float(arr[:, 0].mean()), center_y, center_z],
        "spans_mm": {"x": float(np.ptp(arr[:, 0])), "y": float(np.ptp(arr[:, 1])), "z": float(np.ptp(arr[:, 2]))},
        "note": "outline_local_mm [lx,ly] 供 Mirror.isOnReflectiveSurface point-in-polygon",
    }
    out_path = str(Path(step_file).with_suffix('.mirror-outline.json'))
    with open(out_path, 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
    print(f"\n→ 输出: {out_path}")
    print(f"  outline_local_mm: {len(outline_local)} 点, center={out['center_mm']}")


if __name__ == "__main__":
    main()
