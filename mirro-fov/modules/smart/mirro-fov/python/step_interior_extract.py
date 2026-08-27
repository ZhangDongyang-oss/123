#!/usr/bin/env python3
"""
内镜数据一条龙提取 — 从整车 STEP 全自动提取内后视镜 (GB 15084 I 类, 平面镜) 全部参数
==============================================================================
与外镜 step_exterior_extract.py 平行: 一个 STEP 出全部内镜校核参数, 无需人工选点/3DE。

命名规范见 docs/interior-step-supplier-spec.md (我方定义, 供应商按此提供; 中文新名 + 旧名兼容):
  ✅ 眼点/IPD    : 命名点 `眼点左`/`眼点右` (中点+IPD); 兜底 `眼椭圆` (车型C legacy)
  ✅ pivot       : 命名点 `球铰` (旧 `MIRROR_PIVOT`, 球铰中心, 必须补)
  ✅ center_zero : 命名点 `镜心` (旧 `MIRROR_CENTER_ZERO`, 镜面零位中心, 必须补)
  ✅ 地面        : 命名点 `地面前`/`地面后` (旧 `GROUND_FRONT`/`GROUND_REAR`; 兜底 `curb0 ground line`)
  ✅ 镜面轮廓    : 命名面 `镜片` (旧 `INNER_MIRROR_GLASS`; 兜底 镜座区域最大平面)
  ✅ 后挡风      : 命名面 `后挡风` (旧 `REAR_WINDOW`) + `透光区` (旧 `REAR_WINDOW_TZ`)
  ✅ yaw/pitch   : 镜面法向 + pivot/center_zero 几何推导 (对照 车型C -23.5/5 已验证)

边界: 缺命名 → stderr 提示哪个缺, 该字段置 null, 不崩。

用法: python step_interior_extract.py <step_file> [--output out.json] [--name 车型名]
"""
import re
import sys
import json
import math
import numpy as np
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import step_curve_sampler as scs
import step_topology as st
import step_rear_window as srw

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)
except Exception:
    pass

# ─── 命名别名 (阶段 10: 简洁中文新名 + 旧名兼容) ─────────────────────
# 每个参数命中别名列表任一即认; 提取器解码 \X2\UTF16BE\X0\ + 容忍裸 UTF-8。
# 通用 (内外镜同套): 眼点左/眼点右/地面前/地面后; 内镜额外: 眼椭圆 (eye_center legacy)。
ALIAS_EYE_LEFT = ['眼点左', 'EYE_LEFT', '左侧眼椭圆中心点']
ALIAS_EYE_RIGHT = ['眼点右', 'EYE_RIGHT', '右侧眼椭圆中心点']
ALIAS_EYE_CENTER = ['眼椭圆']  # 车型C legacy: 眼椭圆 = eye_center 直接用
ALIAS_GROUND_FRONT = ['地面前', 'GROUND_FRONT']
ALIAS_GROUND_REAR = ['地面后', 'GROUND_REAR']
ALIAS_PIVOT = ['球铰', 'MIRROR_PIVOT']
ALIAS_CENTER_ZERO = ['镜心', 'MIRROR_CENTER_ZERO']

ALIAS_FACE_GLASS = ['镜片', 'INNER_MIRROR_GLASS']
ALIAS_FACE_REAR_WINDOW = ['后挡风', 'REAR_WINDOW']
ALIAS_FACE_REAR_WINDOW_TZ = ['透光区', 'REAR_WINDOW_TZ']

# 镜片面兜底: 面名含这些关键词 (车型C 全车 STEP 无 镜片/INNER_MIRROR_GLASS, 但独立镜面 STEP 用 "车型F内镜片")
# 注意: 不含 '内后视镜镜座' — 那是镜座总成 (151 面小面), 不是镜片本身; 镜座仅用于定位镜面区域 (见 mount bbox anchor)
GLASS_NAME_KEYWORDS = ['内镜片', '镜片', '镜面', 'lens', 'reflect', 'mirror']


def decode_step_name(s):
    """解码 STEP 实体名字符串: \\X2\\UTF16BE hex\\X0\\ → 中文; 无 \\X2\\ (裸 UTF-8) 原样返回。

    复用 step_topology._decode_step_name (阶段 10 共享解码入口)。
    """
    return st._decode_step_name(s)


def _face_name(args):
    """ADVANCED_FACE args → 解码后名字 ('' if unnamed)"""
    toks = scs._split_top_level(args)
    if not toks:
        return ''
    raw = toks[0].strip()
    if len(raw) >= 2 and raw[0] == "'" and raw[-1] == "'":
        return decode_step_name(raw[1:-1]).strip()
    return ''


def _pt_to_m(p):
    return [round(float(p[0]) / 1000, 6), round(float(p[1]) / 1000, 6), round(float(p[2]) / 1000, 6)]


def _points_array(points):
    return np.array([p for p in points.values() if len(p) == 3])


def find_named_points(entities, points):
    """按 STEP 实体名找 CARTESIAN_POINT (中文新名 + 旧英文/车型C 名兼容)。

    返回 {canonical_name: np.array([x,y,z] mm)}; 未命名的点不在内 (供兜底/提示)。
    """
    wanted = {
        'eye_center': ALIAS_EYE_CENTER,
        'eye_left': ALIAS_EYE_LEFT,
        'eye_right': ALIAS_EYE_RIGHT,
        'pivot': ALIAS_PIVOT,
        'center_zero': ALIAS_CENTER_ZERO,
        'ground_front': ALIAS_GROUND_FRONT,
        'ground_rear': ALIAS_GROUND_REAR,
    }
    named = {}
    for eid, (t, args) in entities.items():
        if t != "CARTESIAN_POINT":
            continue
        toks = scs._split_top_level(args)
        if not toks:
            continue
        raw = toks[0].strip()
        if len(raw) < 2 or raw[0] != "'" or raw[-1] != "'":
            continue
        name = decode_step_name(raw[1:-1]).strip()
        for key, aliases in wanted.items():
            if name in aliases and key not in named:
                p = points.get(eid)
                if p is not None and len(p) == 3:
                    named[key] = p
    return named


def trace_face_outline(face_eid, bounds_refs, entities, points, n=20):
    """追踪单个面的完整闭合轮廓 (顶点锚定缝合 + 去重复描边 + 闭合), 返回 [[x,y,z] mm] 或 None。

    复用 step_topology.trace_face_boundary / sample_edge_vertex_chained 公共层。
    """
    edges = st.trace_face_boundary(face_eid, bounds_refs, entities)
    if not edges:
        return None
    all_pts = []
    for edge in edges:
        n_edge = st.edge_adaptive_sample_n(edge, entities, points, n, 3.0)
        chained = st.sample_edge_vertex_chained(edge, entities, points, n_edge)
        if chained is None or chained[1] is None or len(chained[1]) < 2:
            pts, _ = st.sample_edge_curve(edge, entities, points, n_edge)  # 降级: 无顶点可用
            if pts is None or len(pts) < 2:
                continue
            contribution = [[float(p[0]), float(p[1]), float(p[2])] for p in pts]
        else:
            v_start, interior, v_end = chained
            stack = np.vstack([v_start, interior, v_end])
            contribution = [[float(p[0]), float(p[1]), float(p[2])] for p in stack]
        if all_pts:
            last = np.array(all_pts[-1]); first = np.array(contribution[0])
            if np.linalg.norm(last - first) < 1.0:
                contribution = contribution[1:]
        all_pts.extend(contribution)
    if not all_pts:
        return None
    # 删除退化环的重复描边段 (路径出去又沿原路折回)
    all_pts = st.strip_doubled_paths(np.array(all_pts), tol_mm=2.0).tolist()
    if len(all_pts) < 3:
        return None
    # 闭合
    if np.linalg.norm(np.array(all_pts[0]) - np.array(all_pts[-1])) > 1.0:
        all_pts.append(all_pts[0])
    return all_pts


def _surface_loc(surf_ref, entities, points):
    """PLANE/B_SPLINE_SURFACE 的 placement 位置点 (mm) 或 None。"""
    if surf_ref not in entities:
        return None
    _, sa = entities[surf_ref]
    toks = scs._split_top_level(sa)
    if not toks:
        return None
    for tok in toks[1:3]:
        m = re.search(r'#(\d+)', tok)
        if not m:
            continue
        rid = int(m.group(1))
        if rid in entities and entities[rid][0] == 'AXIS2_PLACEMENT_3D':
            _, apa = entities[rid]
            atoks = scs._split_top_level(apa)
            if len(atoks) >= 2:
                lm = re.search(r'#(\d+)', atoks[1])
                if lm:
                    lr = int(lm.group(1))
                    if lr in points and len(points[lr]) == 3:
                        return points[lr]
        if rid in points and len(points[rid]) == 3:
            return points[rid]
    return None


def _surface_type(surf_ref, entities):
    return entities[surf_ref][0] if surf_ref in entities else '?'


def find_named_face(entities, names):
    """按面名别名列表匹配 ADVANCED_FACE, 返回 [(face_eid, bounds_refs)]。

    names: 单个名字或名字列表 (命中任一即认)。
    """
    if isinstance(names, str):
        names = [names]
    out = []
    for eid, (t, args) in entities.items():
        if t != "ADVANCED_FACE":
            continue
        if _face_name(args) not in names:
            continue
        toks = scs._split_top_level(args)
        if len(toks) < 2:
            continue
        out.append((eid, scs._parse_ref_list(toks[1])))
    return out


def find_glass_face(entities, points, anchor=None):
    """找镜片面, 返回 (face_eid, outline_mm, face_name) 或 (None, None, None)。

    优先级:
      1. 命名面 `镜片` (旧 `INNER_MIRROR_GLASS`)
      2. 面名含 内镜片/镜片/镜面/lens/reflect/mirror 的最大面 (独立镜面 STEP 命名 "车型F内镜片")
      3. 兜底: anchor (center_zero/pivot) 附近的最大平面面 (车型C 全车 STEP 镜片面未命名, 命名 "Y AXIS")
    """
    # 1. 命名面
    for fid, bounds in find_named_face(entities, ALIAS_FACE_GLASS):
        outline = trace_face_outline(fid, bounds, entities, points)
        if outline and len(outline) >= 3:
            print(f"  ✅ 镜片面: 命名 {ALIAS_FACE_GLASS[0]} #{fid}")
            return fid, outline, ALIAS_FACE_GLASS[0]

    # 2. 关键词面 (取最大)
    cand = []
    for eid, (t, args) in entities.items():
        if t != "ADVANCED_FACE":
            continue
        name = _face_name(args)
        nl = name.lower()
        if not any(k in nl for k in GLASS_NAME_KEYWORDS):
            continue
        toks = scs._split_top_level(args)
        if len(toks) < 2:
            continue
        cand.append((eid, scs._parse_ref_list(toks[1]), name))
    best = None
    for fid, bounds, name in cand:
        outline = trace_face_outline(fid, bounds, entities, points, 12)
        if not outline:
            continue
        arr = np.array(outline)
        area = float(np.ptp(arr[:, 1]) * np.ptp(arr[:, 2]))
        if best is None or area > best[0]:
            best = (area, fid, outline, name)
    if best:
        print(f"  ✅ 镜片面: 关键词 '{best[3]}' #{best[1]} ({best[0]:.0f} mm²)")
        return best[1], best[2], best[3]

    # 3. 兜底: anchor 附近最大平面面
    if anchor is not None:
        a = np.array(anchor, dtype=float)
        best = None
        for eid, (t, args) in entities.items():
            if t != "ADVANCED_FACE":
                continue
            toks = scs._split_top_level(args)
            if len(toks) < 3:
                continue
            m = re.search(r'#(\d+)', toks[2])
            surf_ref = int(m.group(1)) if m else None
            stype = _surface_type(surf_ref, entities)
            if stype not in ('PLANE', 'B_SPLINE_SURFACE_WITH_KNOTS', 'B_SPLINE_SURFACE'):
                continue
            loc = _surface_loc(surf_ref, entities, points)
            if loc is None or np.linalg.norm(np.array(loc) - a) > 200.0:
                continue
            outline = trace_face_outline(eid, scs._parse_ref_list(toks[1]), entities, points, 10)
            if not outline:
                continue
            arr = np.array(outline)
            area = float(np.ptp(arr[:, 1]) * np.ptp(arr[:, 2]))
            if best is None or area > best[0]:
                best = (area, eid, outline)
        if best:
            print(f"  ✅ 镜片面: anchor 附近最大平面 #{best[1]} ({best[0]:.0f} mm²)")
            return best[1], best[2], None
    return None, None, None


def fit_plane_normal(outline):
    """SVD 拟合平面法向, 定向朝 +X (镜面反射方向朝后)。返回单位法向或 None。"""
    arr = np.array(outline, dtype=float)
    if len(arr) < 3:
        return None
    c = arr.mean(axis=0)
    u, s, vh = np.linalg.svd(arr - c)
    n = vh[2]
    n = n / np.linalg.norm(n)
    if n[0] < 0:
        n = -n
    return n


def _rotZ(a):
    c, s = math.cos(a), math.sin(a)
    return np.array([[c, -s, 0], [s, c, 0], [0, 0, 1]])


def _rotY(a):
    c, s = math.cos(a), math.sin(a)
    return np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]])


def derive_yaw_pitch(normal):
    """镜面法向 (rotZY 约定: n = Rz(yaw)@Ry(pitch)@[1,0,0]) → yaw/pitch (度)。

    n = [cos(yaw)cos(pitch), sin(yaw)cos(pitch), -sin(pitch)]
    → yaw = atan2(ny, nx), pitch = -asin(nz)
    """
    nx, ny, nz = float(normal[0]), float(normal[1]), float(normal[2])
    yaw = math.degrees(math.atan2(ny, nx))
    pitch = math.degrees(-math.asin(max(-1.0, min(1.0, nz))))
    return yaw, pitch


def find_ground_from_curve(entities, points):
    """兜底: `curb0 ground line` 命名曲线端点 → (front_mm, rear_mm) 整车坐标。

    COMPOSITE_CURVE('curb0 ground line', ...) → 段 → 底层曲线; 取所有引用点中 X 最小 (前) / 最大 (后)。
    失败返回 (None, None)。
    """
    curve_eid = None
    for eid, (t, args) in entities.items():
        if t == "COMPOSITE_CURVE" and 'curb0 ground line' in args.lower():
            curve_eid = eid
            break
    if curve_eid is None:
        return None, None
    # 收集该曲线 (及其下游段) 引用的所有 CARTESIAN_POINT
    visited = set()
    stack = [curve_eid]
    collected = []
    while stack:
        eid = stack.pop()
        if eid in visited or eid not in entities:
            continue
        visited.add(eid)
        t, args = entities[eid]
        if t == "CARTESIAN_POINT":
            p = points.get(eid)
            if p is not None and len(p) == 3:
                collected.append(p)
            continue
        for m in re.findall(r'#(\d+)', args):
            stack.append(int(m))
    if len(collected) < 2:
        return None, None
    arr = np.array(collected)
    front = arr[np.argmin(arr[:, 0])]
    rear = arr[np.argmax(arr[:, 0])]
    return front, rear


def extract_interior(entities, points, step_name="step"):
    """核心提取: 从内存 entities/points 全自动提取完整内镜 JSON (对齐 车型C.json 结构)。

    返回 dict (vehicle/mirror/driver/ground/rear_window/regulation/tolerance/visualization + _meta)。
    缺命名字段 → null + stderr 提示, 不崩。
    """
    named = find_named_points(entities, points)
    missing = []

    # ─── 1. 眼点 + IPD ─────────────────────────────────
    # 优先 眼点左/眼点右 (中点=eye_center, 距离=IPD); fallback 眼椭圆 (eye_center 直接用)
    eye_center = None
    eye_left = named.get('eye_left')
    eye_right = named.get('eye_right')
    if eye_left is not None and eye_right is not None:
        eye_center = _pt_to_m((eye_left + eye_right) / 2.0)
    elif 'eye_center' in named:
        eye_center = _pt_to_m(named['eye_center'])
    if eye_center is None:
        missing.append("眼点左/眼点右 (或 眼椭圆)")
    ipd = 0.065
    if eye_left is not None and eye_right is not None:
        ipd = round(float(abs(eye_left[1] - eye_right[1])) / 1000.0, 6)
    else:
        missing.append("眼点左/眼点右 (IPD 用默认 65mm)")

    # ─── 2. pivot / center_zero ───────────────────────
    pivot = _pt_to_m(named['pivot']) if 'pivot' in named else None
    center_zero = _pt_to_m(named['center_zero']) if 'center_zero' in named else None
    if pivot is None:
        missing.append("球铰 (MIRROR_PIVOT)")
    if center_zero is None:
        missing.append("镜心 (MIRROR_CENTER_ZERO)")

    # ─── 3. 地面 ──────────────────────────────────────
    gf = _pt_to_m(named['ground_front']) if 'ground_front' in named else None
    gr = _pt_to_m(named['ground_rear']) if 'ground_rear' in named else None
    if gf is None or gr is None:
        print("  ⚠️ 地面点未命名 (地面前/地面后), 用 curb0 ground line 曲线端点兜底", file=sys.stderr)
        gf_mm, gr_mm = find_ground_from_curve(entities, points)
        if gf is None and gf_mm is not None:
            gf = _pt_to_m(gf_mm)
        if gr is None and gr_mm is not None:
            gr = _pt_to_m(gr_mm)
    if gf is None or gr is None:
        missing.append("地面前/地面后 (或 curb0 ground line)")

    # ─── 4. 镜片面 (anchor = center_zero/pivot, 均 mm) ──
    anchor = None
    if 'center_zero' in named:
        anchor = named['center_zero']
    elif 'pivot' in named:
        anchor = named['pivot']
    else:
        # 无 pivot/center_zero 命名: 用 `内后视镜镜座` 总成的 placement 点包围盒中心定位镜面区域
        mount_locs = []
        for eid, (t, args) in entities.items():
            if t != "ADVANCED_FACE":
                continue
            toks = scs._split_top_level(args)
            if len(toks) < 3 or '内后视镜镜座' not in _face_name(args):
                continue
            m = re.search(r'#(\d+)', toks[2])
            surf_ref = int(m.group(1)) if m else None
            loc = _surface_loc(surf_ref, entities, points)
            if loc is not None:
                mount_locs.append(loc)
        if mount_locs:
            arr = np.array(mount_locs)
            anchor = arr.mean(axis=0)
            print(f"  ⚠️ 无 pivot/center_zero 命名, 用镜座包围盒中心定位镜面 ({len(arr)} 点)", file=sys.stderr)
    print("STEP_PROGRESS|提取镜面轮廓...")
    glass_id, glass_outline, glass_name = find_glass_face(entities, points, anchor)

    mirror = {}
    outline_local_mm = None
    outline_3d_mm = None
    if glass_outline:
        arr = np.array(glass_outline, dtype=float)
        centroid = arr.mean(axis=0)
        normal = fit_plane_normal(glass_outline)

        # yaw/pitch: 先判断镜片在 STEP 中是否处零位 (质心 ≈ center_zero)
        at_zero = False
        if normal is not None and center_zero is not None:
            cz = np.array(named['center_zero'], dtype=float) if 'center_zero' in named else np.array([c * 1000 for c in center_zero])
            if np.linalg.norm(centroid - cz) < 5.0:
                at_zero = True
        if normal is None:
            yaw = pitch = None
            missing.append("镜面法向 (yaw/pitch 无法推导)")
        elif at_zero:
            yaw = 0.0
            pitch = 0.0
            # 镜片处零位: 用质心精修 center_zero
            center_zero = _pt_to_m(centroid)
            print("  ℹ️ 镜片在 STEP 中处零位 (质心≈center_zero), yaw/pitch=0, center_zero=质心")
        else:
            yaw, pitch = derive_yaw_pitch(normal)

        # 局部 2D 轮廓 (rotZY 约定, 与引擎 Mirror 完全一致)
        if yaw is not None and pitch is not None:
            R = _rotZ(math.radians(yaw)) @ _rotY(math.radians(pitch))
            right = R @ np.array([0.0, 1.0, 0.0])
            up = R @ np.array([0.0, 0.0, 1.0])
            cx = centroid
            outline_local_mm = [[round(float(np.dot(np.array(p) - cx, right)), 4),
                                 round(float(np.dot(np.array(p) - cx, up)), 4)] for p in glass_outline]
            lx = np.array([p[0] for p in outline_local_mm])
            ly = np.array([p[1] for p in outline_local_mm])
            width_mm = float(np.ptp(lx))
            height_mm = float(np.ptp(ly))
        else:
            width_mm = height_mm = None

        outline_3d_mm = glass_outline
        mirror = {
            'width': round(width_mm / 1000, 6) if width_mm is not None else None,
            'height': round(height_mm / 1000, 6) if height_mm is not None else None,
            'pivot': pivot,
            'center_zero': center_zero,
            'arm_offset': [round(center_zero[i] - pivot[i], 6) for i in range(3)] if (center_zero and pivot) else None,
            'yaw': round(yaw, 6) if yaw is not None else None,
            'pitch': round(pitch, 6) if pitch is not None else None,
            'outline_local_mm': outline_local_mm,  # inline 轮廓 (对齐外镜 outline_raw 存储规范, 不再依赖 outline_path 文件)
            'outline_path': None,
        }
        if glass_name:
            print(f"  ✅ 镜面 {glass_name}: {len(glass_outline)} 点, "
                  f"width={width_mm if width_mm is None else round(width_mm, 2)}mm "
                  f"height={height_mm if height_mm is None else round(height_mm, 2)}mm, "
                  f"yaw={yaw if yaw is None else round(yaw, 2)}° pitch={pitch if pitch is None else round(pitch, 2)}°")
    else:
        missing.append("镜片 (INNER_MIRROR_GLASS / 内后视镜镜座 区域)")

    # ─── 5. 后挡风 ────────────────────────────────────
    print("STEP_PROGRESS|提取后挡风...")
    rw_outline = None
    rw_tz = None
    rw_faces = find_named_face(entities, ALIAS_FACE_REAR_WINDOW)
    if len(rw_faces) > 1:
        # 多面合并 (供应商可能把后挡风拆成多个 patch)
        faces4 = [(fid, '', bounds, None) for fid, bounds in rw_faces]
        merged = srw.merge_face_outlines(faces4, entities, points, 25)
        if merged:
            rw_outline = [[round(p[0] / 1000, 6), round(p[1] / 1000, 6), round(p[2] / 1000, 6)] for p in merged]
            print(f"  ✅ 后挡风: 合并 {len(rw_faces)} 个面 → {len(rw_outline)} 点")
    elif rw_faces:
        # 取最大面作外框
        best = None
        for fid, bounds in rw_faces:
            ol = trace_face_outline(fid, bounds, entities, points, 20)
            if ol:
                arr = np.array(ol)
                area = float(np.ptp(arr[:, 1]) * np.ptp(arr[:, 2]))
                if best is None or area > best[0]:
                    best = (area, ol)
        if best:
            rw_outline = [[round(p[0] / 1000, 6), round(p[1] / 1000, 6), round(p[2] / 1000, 6)] for p in best[1]]
    tz_faces = find_named_face(entities, ALIAS_FACE_REAR_WINDOW_TZ)
    if tz_faces:
        best = None
        for fid, bounds in tz_faces:
            ol = trace_face_outline(fid, bounds, entities, points, 20)
            if ol:
                arr = np.array(ol)
                area = float(np.ptp(arr[:, 1]) * np.ptp(arr[:, 2]))
                if best is None or area > best[0]:
                    best = (area, ol)
        if best:
            rw_tz = [[round(p[0] / 1000, 6), round(p[1] / 1000, 6), round(p[2] / 1000, 6)] for p in best[1]]
    if rw_outline is None:
        missing.append("后挡风 (REAR_WINDOW)")

    # ─── 6. 组装 (结构 = 车型C.json) ─────────────────
    vehicle_name = step_name
    ground_plane_z = gf[2] if gf is not None else 0.193209

    result = {
        '_meta': {
            'source': 'step_interior_extract',
            'step_file': step_name,
            'glass_face_id': glass_id,
            'glass_face_name': glass_name,
            'outline_local_mm': outline_local_mm,
            'outline_3d_mm': outline_3d_mm,
            'missing_named': missing,
        },
        'vehicle': {'name': vehicle_name},
        'mirror': mirror if mirror else {
            'width': None, 'height': None,
            'pivot': pivot, 'center_zero': center_zero, 'arm_offset': None,
            'yaw': None, 'pitch': None, 'outline_local_mm': None, 'outline_path': None,
        },
        'driver': {
            'eye_center': eye_center,
            'interpupillary_distance': ipd,
        },
        'ground': {'front_mid': gf, 'rear_mid': gr},
        'rear_window': {
            'outline': rw_outline,
            'transparent_zone': rw_tz,
            'outline_path': None,
        },
        'regulation': {
            'standard': 'GB 15084', 'mirror_class': 'I',
            'far_distance': 60.0, 'required_width_at_far': 20.0,
        },
        'tolerance': {'coverage_y': 0.5, 'ground_visible_z': 1.0, 'pitch_convergence': 0.1},
        'visualization': {'ground_plane_z': round(ground_plane_z, 6)},
    }

    # 缺命名汇总提示 (不崩)
    if missing:
        print(f"  ⚠️ 缺命名 ({len(missing)}): " + "; ".join(missing), file=sys.stderr)
    return result


def main():
    import argparse
    parser = argparse.ArgumentParser(description="内镜数据一条龙提取")
    parser.add_argument("step_files", nargs='+', help="一个或多个 STEP 文件 (多文件自动合并)")
    parser.add_argument("--output", "-o", default=None, help="输出 JSON 路径")
    parser.add_argument("--name", default=None, help="车型名 (默认用文件名 stem)")
    args = parser.parse_args()

    print(f"解析 STEP: {len(args.step_files)} 个文件")
    print("STEP_PROGRESS|解析 STEP 文件中...")
    entities, points = scs.parse_and_merge(args.step_files)
    print(f"实体: {len(entities)}, 点: {len(points)}")
    print("STEP_PROGRESS|已解析实体, 提取内镜参数")

    step_name = args.name or Path(args.step_files[0]).stem
    result = extract_interior(entities, points, step_name=step_name)

    out_path = args.output or str(Path(args.step_files[0]).with_suffix('.interior.json'))
    print("STEP_PROGRESS|写入输出文件...")
    with open(out_path, 'w', encoding='utf-8') as f:
        json.dump(result, f, ensure_ascii=False, indent=2)
    print(f"\n→ 输出: {out_path}")
    m = result['mirror']
    d = result['driver']
    g = result['ground']
    print(f"  镜面: width={m['width']}m height={m['height']}m yaw={m['yaw']}° pitch={m['pitch']}°")
    print(f"  眼点: {d['eye_center']}, IPD={d['interpupillary_distance']}m")
    print(f"  地面: {g['front_mid']} / {g['rear_mid']}")
    if result['_meta']['missing_named']:
        print(f"  缺命名: {result['_meta']['missing_named']}")


if __name__ == "__main__":
    main()
