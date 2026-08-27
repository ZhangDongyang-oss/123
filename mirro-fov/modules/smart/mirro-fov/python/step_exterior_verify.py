#!/usr/bin/env python3
"""
外镜 STEP 自动提取 vs 现有数据 验证
===================================
从完整外镜校核 STEP 自动提取几何, 与 data/exterior/exterior-vehicle-draft.json
(人工提取) 逐项对比, 验证自动提取正确性。

自动提取项:
  1. 镜面轮廓 (SPHERICAL_SURFACE + 顶点链式)     → outline_raw
  2. 球心 (SPHERICAL_SURFACE)                   → supplier_sphere_center
  3. 左右眼点 (CARTESIAN_POINT 精确坐标)          → eye_left_raw / eye_right_raw
  4. 地面 (CARTESIAN_POINT 精确坐标)              → ground.front_mid / rear_mid

验证: 自动 vs 人工 偏差报告

用法: python step_exterior_verify.py <step_file> [--json <外镜数据.json>]
"""
import re
import sys
import json
import numpy as np
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import step_curve_sampler as scs
import step_topology as st

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass


def find_spheres(entities, points):
    """找所有 SPHERICAL_SURFACE (外镜)"""
    spheres = []
    for eid, (t, args) in entities.items():
        if t != "SPHERICAL_SURFACE":
            continue
        toks = scs._split_top_level(args)
        if len(toks) < 3:
            continue
        radius = float(toks[-1])
        axis_ref = int(re.search(r'#(\d+)', toks[1]).group(1))
        _, aargs = entities[axis_ref]
        atoks = scs._split_top_level(aargs)
        loc_ref = int(re.search(r'#(\d+)', atoks[1]).group(1))
        center = points.get(loc_ref)
        if center is not None:
            spheres.append({'id': eid, 'radius': radius,
                            'center': center.tolist()})
    return spheres


def find_sphere_faces(sphere_id, entities):
    """找引用球面的 ADVANCED_FACE"""
    faces = []
    for eid, (t, args) in entities.items():
        if t == "ADVANCED_FACE" and f'#{sphere_id}' in args:
            faces.append(eid)
    return faces


def sample_edge_vertex_chained(edge, entities, points, n=40):
    """采样边, 用 VERTEX_POINT 定端点 (精度保证方法)"""
    pts, length = st.sample_edge_curve(edge, entities, points, n)
    if pts is None or len(pts) < 2:
        return None, None, None
    arr = np.array(pts)
    v_start = st._resolve_vertex(edge.get('v_start'), entities, points)
    v_end = st._resolve_vertex(edge.get('v_end'), entities, points)
    if v_start is None or v_end is None:
        return None, None, None
    ds = np.linalg.norm(arr - v_start, axis=1)
    de = np.linalg.norm(arr - v_end, axis=1)
    is_ = np.argmin(ds)
    ie = np.argmin(de)
    lo, hi = min(is_, ie), max(is_, ie)
    interior = arr[lo:hi + 1]
    if np.linalg.norm(interior[0] - v_start) > np.linalg.norm(interior[-1] - v_start):
        interior = interior[::-1]
    return v_start, interior, v_end


def extract_outline(face_id, entities, points, n=40):
    """顶点链式提取镜面轮廓"""
    _, fargs = entities[face_id]
    ftoks = scs._split_top_level(fargs)
    bounds = scs._parse_ref_list(ftoks[1])
    edges = st.trace_face_boundary(face_id, bounds, entities)
    outline = []
    for e in edges:
        v_start, interior, v_end = sample_edge_vertex_chained(e, entities, points, n)
        if v_start is None or v_end is None or len(interior) < 2:
            continue
        if outline:
            if np.linalg.norm(v_start - np.array(outline[-1])) > 5:
                outline.append([float(v_start[0]), float(v_start[1]), float(v_start[2])])
        else:
            outline.append([float(v_start[0]), float(v_start[1]), float(v_start[2])])
        for p in interior[1:-1]:
            outline.append([float(p[0]), float(p[1]), float(p[2])])
        outline.append([float(v_end[0]), float(v_end[1]), float(v_end[2])])
    if outline and np.linalg.norm(np.array(outline[0]) - np.array(outline[-1])) > 8:
        outline.append(outline[0])
    return outline


def find_point_by_coord(points, target, tol=50):
    """在 STEP 点里找最接近目标的点"""
    pts_arr = np.array([p for p in points.values() if len(p) == 3])
    if not len(pts_arr):
        return None, None
    d = np.linalg.norm(pts_arr - np.array(target), axis=1)
    idx = np.argmin(d)
    if d[idx] < tol:
        return pts_arr[idx], d[idx]
    return None, d[idx]


def main():
    import argparse
    parser = argparse.ArgumentParser(description="外镜 STEP 提取 vs 现有数据验证")
    parser.add_argument("step_file")
    parser.add_argument("--json", default=None, help="现有外镜数据 JSON (默认 data/exterior/exterior-vehicle-draft.json)")
    args = parser.parse_args()

    print(f"解析 STEP: {args.step_file}")
    entities, points = scs.parse_step(args.step_file)
    print(f"实体: {len(entities)}, 点: {len(points)}")

    # 加载现有数据: python/ → mirro-fov/data/exterior/
    json_path = args.json or str(Path(__file__).parent.parent / 'data' / 'exterior' / 'exterior-vehicle-draft.json')
    manual = json.load(open(json_path, encoding='utf-8'))
    print(f"现有数据: {json_path}")

    spheres = find_spheres(entities, points)
    print(f"\n=== 1. 球面 (外镜) ===")
    for s in spheres:
        print(f"  #{s['id']}: R={s['radius']}mm 球心[{s['center'][0]:.1f},{s['center'][1]:.1f},{s['center'][2]:.1f}]")
        side = "right" if s['center'][1] > 0 else "left"
        mc = manual[f'exterior_mirror_{side}']['supplier_sphere_center']
        dev = np.linalg.norm(np.array(s['center']) / 1000 - np.array(mc)) * 1000
        print(f"    → {side} 现有 {mc} 偏差 {dev:.3f}mm")

    print(f"\n=== 2. 左右眼点 ===")
    eye_l = np.array(manual['driver']['eye_left_raw']) * 1000
    eye_r = np.array(manual['driver']['eye_right_raw']) * 1000
    for name, target in [('左眼', eye_l), ('右眼', eye_r)]:
        found, dist = find_point_by_coord(points, target)
        status = f"✅ 精确 (距{dist:.2f}mm)" if found is not None else f"❌ 未找到 (最近{dist:.1f}mm)"
        print(f"  {name}: 现有{target.tolist()} {status}")
        if found is not None:
            print(f"    STEP点 [{found[0]:.1f},{found[1]:.1f},{found[2]:.1f}]")

    print(f"\n=== 3. 地面 ===")
    for name, key in [('front', 'front_mid'), ('rear', 'rear_mid')]:
        target = np.array(manual['ground'][key]) * 1000
        found, dist = find_point_by_coord(points, target)
        status = f"✅ 精确 (距{dist:.2f}mm)" if found is not None else f"❌ 未找到 (最近{dist:.1f}mm)"
        print(f"  {name}: 现有{target.tolist()} {status}")

    print(f"\n=== 4. 镜面轮廓 ===")
    for s in spheres:
        side = "right" if s['center'][1] > 0 else "left"
        faces = find_sphere_faces(s['id'], entities)
        # 尝试每个面, 取最大的有效轮廓
        best = None
        best_face = None
        for fid in faces:
            outline = extract_outline(fid, entities, points)
            if outline and (best is None or len(outline) > len(best)):
                best = outline
                best_face = fid
        if best:
            mc = manual[f'exterior_mirror_{side}']['supplier_sphere_center']
            sc = np.array(s['center'])
            # 球面度验证
            d = np.linalg.norm(np.array(best) - sc, axis=1)
            print(f"  {side} #{s['id']} (面{best_face}): {len(best)}点, 球面偏差 {abs(d-s['radius']).max():.3f}mm")
            # 与现有轮廓对比 (采样对齐)
            manual_pts = np.array(manual[f'exterior_mirror_{side}']['outline_raw']) * 1000
            print(f"    现有轮廓 {len(manual_pts)}点")
            # 大致对比尺寸
            b_arr = np.array(best)
            m_arr = manual_pts
            print(f"    STEP 尺寸: X跨{np.ptp(b_arr[:,0]):.1f} Y跨{np.ptp(b_arr[:,1]):.1f} Z跨{np.ptp(b_arr[:,2]):.1f}")
            print(f"    人工 尺寸: X跨{np.ptp(m_arr[:,0]):.1f} Y跨{np.ptp(m_arr[:,1]):.1f} Z跨{np.ptp(m_arr[:,2]):.1f}")


if __name__ == "__main__":
    main()
