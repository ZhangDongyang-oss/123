#!/usr/bin/env python3
"""
外镜数据一条龙提取 — 从完整校核 STEP 自动生成外镜数据 JSON
========================================================
从供应商完整外镜校核模型 (一个 STEP) 全自动提取全部 7 类参数:
  ✅ 镜面轮廓 (左右, SPHERICAL_SURFACE + 顶点链式)
  ✅ 球心 + 曲率半径 R (SPHERICAL_SURFACE)
  ✅ 旋转轴 + turret p1 (AXIS2_PLACEMENT_3D, 自动判定 Z×X)
  ✅ 左右眼点 (命名 眼点左/眼点右 > EYE_LEFT/RIGHT > 几何泛化)
  ✅ 地面 (命名 地面前/地面后 > GROUND_FRONT/REAR > 中心线最低点)
  ✅ 车门最外 Y (命名 车门左/车门右 > DOOR_OUTER_LEFT/RIGHT > |Y| 高百分位)
  命名缺失时回退坐标启发式 (stderr 提示), 轴线缺失时回退默认 [0,1,0]。

用法: python step_exterior_extract.py <step_file> [--output out.json] [--json 现有数据.json]
  --json: 提供现有数据时, 车门/轴线/SR 等未提取字段沿用现有值 (同车型验证用)
"""
import re
import sys
import json
import numpy as np
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import step_curve_sampler as scs
import step_topology as st

try:
    # line_buffering: stdout 接管道时默认块缓冲, STEP_PROGRESS 进度行必须按行即时刷出
    sys.stdout.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)
except Exception:
    pass


def find_spheres(entities, points):
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
    return [eid for eid, (t, args) in entities.items()
            if t == "ADVANCED_FACE" and f'#{sphere_id}' in args]


def extract_outline(face_id, entities, points, n=30):
    """从面提取镜面帽轮廓 (顶点锚定采样, 复用 step_topology 公共函数)。

    n=30 与 step_sphere_mirror 生成 draft 时的采样密度一致, 保证自动提取
    与已验证的手动 draft 几何逐点吻合 (退化 B 样条边对采样密度敏感, 见 stage0-report)。
    """
    _, fargs = entities[face_id]
    ftoks = scs._split_top_level(fargs)
    bounds = scs._parse_ref_list(ftoks[1])
    edges = st.trace_face_boundary(face_id, bounds, entities)
    outline = []
    for e in edges:
        v_start, interior, v_end = st.sample_edge_vertex_chained(e, entities, points, n)
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
    # 删除退化环的重复描边段 (CAD 导出常见: 路径出去又沿原路折回) — 对齐内镜/后挡风
    if outline:
        outline = st.strip_doubled_paths(np.array(outline), tol_mm=2.0).tolist()

    # 闭合 (strip_doubled_paths 可能删掉闭合点, 重新闭合)
    if outline and np.linalg.norm(np.array(outline[0]) - np.array(outline[-1])) > 1.0:
        outline.append(outline[0])
    return outline


def find_point_by_coord(points, target, tol=50):
    pts_arr = np.array([p for p in points.values() if len(p) == 3])
    if not len(pts_arr):
        return None, None
    d = np.linalg.norm(pts_arr - np.array(target), axis=1)
    idx = np.argmin(d)
    if d[idx] < tol:
        return pts_arr[idx], d[idx]
    return None, d[idx]


def _points_array(points):
    return np.array([p for p in points.values() if len(p) == 3])


def find_door_outer_Y(points, spheres, z_band=(None, None), pct=99.5):
    """车门最外 Y (mm, 正值绝对值): 车身侧壁 |Y| 高百分位, 排除镜面。

    - 镜面 (球面玻璃 + 附近壳体) 是车身外侧的凸起, 会抬高 |Y| 百分位, 必须剔除:
      剔除到任一球心距离满足 |dist - R| < 100mm 的点。
    - 球心本身 (|Y|≈1500/1680mm) 是孤立参考点, 用 |Y|<1400mm 剔除。
    - 车门最宽处在车门中段 (Z≈360~520mm), 不限 Z 更稳; 全量 |Y| 的 99.5 百分位
      对车门皮肤 (密集簇) 稳健, 对凸起 (镜壳体/门把手, 少量点) 不敏感。
    返回 (left_mm, right_mm); 失败返回 (None, None)。
    """
    arr = _points_array(points)
    if not len(arr):
        return None, None
    mask = np.zeros(len(arr), bool)
    for s in spheres:
        d = np.linalg.norm(arr - np.array(s['center']), axis=1)
        mask |= (np.abs(d - s['radius']) < 100.0)
    body = arr[~mask]
    if z_band[0] is not None:
        body = body[(body[:, 2] >= z_band[0]) & (body[:, 2] <= z_band[1])]
    yabs = np.abs(body[:, 1])
    yabs = yabs[yabs < 1400.0]  # 剔除球心孤立参考点
    if not len(yabs):
        return None, None
    left = np.abs(body[body[:, 1] < 0][:, 1])
    right = np.abs(body[body[:, 1] > 0][:, 1])
    if not len(left) or not len(right):
        return None, None
    return float(np.percentile(left, pct)), float(np.percentile(right, pct))


def find_eyes(points):
    """眼点对几何泛化: 在驾驶员区找一对 X 同 (≤20mm)、Z 同 (≤20mm)、|ΔY|∈[55,75]mm 的点对。

    候选很多 (车身网格点), 选 X/Z 最对齐 (|ΔX|+|ΔZ| 最小) 的那对作为左右眼;
    该对即「同一高度/同一纵向位置、左右间距 55~75mm」最干净的双眼点。
    返回 (eye_l_m, eye_r_m) (整车坐标 m); 失败返回 (None, None)。
    """
    arr = _points_array(points)
    if not len(arr):
        return None, None
    # 驾驶员区: 眼高 0.8~1.3m, 前排纵向 0.5~3.0m, |Y| ≤ 1m (LHD/RHD 皆可)
    zone = arr[(arr[:, 2] >= 800) & (arr[:, 2] <= 1300)
               & (arr[:, 0] >= 500) & (arr[:, 0] <= 3000)
               & (np.abs(arr[:, 1]) <= 1000)]
    if not len(zone):
        return None, None
    groups = defaultdict(list)
    for p in zone:
        groups[(round(float(p[0]) / 20), round(float(p[2]) / 20))].append(p)
    best = None
    for pts in groups.values():
        if len(pts) < 2:
            continue
        ys = sorted(pts, key=lambda p: p[1])
        for a in range(len(ys)):
            for b in range(a + 1, len(ys)):
                dy = ys[b][1] - ys[a][1]
                if 55 <= dy <= 75:
                    score = abs(ys[a][0] - ys[b][0]) + abs(ys[a][2] - ys[b][2])
                    if best is None or score < best[0]:
                        best = (score, ys[a], ys[b])
    if best is None:
        return None, None
    _, lo, hi = best  # lo = 更负 Y (左眼), hi = 更不负 Y (右眼)
    eye_l = [round(float(lo[0]) / 1000, 6), round(float(lo[1]) / 1000, 6), round(float(lo[2]) / 1000, 6)]
    eye_r = [round(float(hi[0]) / 1000, 6), round(float(hi[1]) / 1000, 6), round(float(hi[2]) / 1000, 6)]
    return eye_l, eye_r


def find_ground(points):
    """地面两点: 中心线 (|Y|<30mm) 中 Z 最低附近的 min-X (前) / max-X (后) 点。

    返回 (front_m, rear_m) (整车坐标 m); 失败返回 (None, None)。
    """
    arr = _points_array(points)
    if not len(arr):
        return None, None
    g = arr[np.abs(arr[:, 1]) < 30]
    if not len(g):
        return None, None
    zmin = float(g[:, 2].min())
    near = g[g[:, 2] <= zmin + 30.0]  # 地面近似平面, 取最低点 ±30mm 内
    if not len(near):
        return None, None
    front = near[np.argmin(near[:, 0])]
    rear = near[np.argmax(near[:, 0])]
    front_m = [round(float(front[0]) / 1000, 6), round(float(front[1]) / 1000, 6), round(float(front[2]) / 1000, 6)]
    rear_m = [round(float(rear[0]) / 1000, 6), round(float(rear[1]) / 1000, 6), round(float(rear[2]) / 1000, 6)]
    return front_m, rear_m


# ─── 阶段 6: 轴线 + 命名参考点提取 ─────────────────────────────────
# 阶段 10: 命名中文化 + 别名兼容 (简洁中文新名 + 旧英文名)
ALIAS_EYE_LEFT = ['眼点左', 'EYE_LEFT', '左侧眼椭圆中心点']
ALIAS_EYE_RIGHT = ['眼点右', 'EYE_RIGHT', '右侧眼椭圆中心点']
ALIAS_GROUND_FRONT = ['地面前', 'GROUND_FRONT']
ALIAS_GROUND_REAR = ['地面后', 'GROUND_REAR']
ALIAS_DOOR_LEFT = ['车门左', 'DOOR_OUTER_LEFT']
ALIAS_DOOR_RIGHT = ['车门右', 'DOOR_OUTER_RIGHT']
ALIAS_MIRROR_FACE_LEFT = ['镜片左', 'MIRROR_FACE_LEFT']
ALIAS_MIRROR_FACE_RIGHT = ['镜片右', 'MIRROR_FACE_RIGHT']


def decode_step_name(s):
    """解码 STEP 实体名字符串: \\X2\\UTF16BE hex\\X0\\ → 中文; 无 \\X2\\ (裸 UTF-8) 原样返回。

    复用 step_topology._decode_step_name (阶段 10 共享解码入口)。
    """
    return st._decode_step_name(s)


def _ref_of(tok):
    """'#123' → 123; 其它 → None"""
    m = re.match(r'#(\d+)', tok.strip())
    return int(m.group(1)) if m else None


def _parse_direction(entities, eid):
    """DIRECTION('', (x,y,z)) → 归一化 3 维向量; 失败返回 None。"""
    if eid not in entities:
        return None
    etype, args = entities[eid]
    if etype != "DIRECTION":
        return None
    for coord_str in reversed(re.findall(r"\(([^()]*)\)", args)):
        parts = [p.strip() for p in coord_str.split(",")]
        if len(parts) != 3:
            continue
        try:
            v = np.array([float(parts[0]), float(parts[1]), float(parts[2])])
        except ValueError:
            continue
        n = float(np.linalg.norm(v))
        if n > 1e-12:
            return v / n
    return None


def find_mirror_frames(entities, points, spheres=None):
    """从 AXIS2_PLACEMENT_3D 提取左右「镜体坐标系」(每镜一个坐标系 = 原点 + 两轴)。

    镜体坐标系 = 放在旋转中心 (turret p1 / 球铰点) 的坐标系:
      AXIS2_PLACEMENT_3D('name', #location, #axis, #ref_dir)
        location = CARTESIAN_POINT — 原点 = 旋转中心 (turret p1 / 球铰点)
        axis     = DIRECTION      — Z 轴 = 折叠轴 (≈整车 Z, 水平折叠方向)
        ref_dir  = DIRECTION      — X 轴 = 镜面右向参考

    三正交轴: X=ref_dir, Z=axis, Y=normalize(Z×X) = 旋转轴 (上下调节所绕, 系统自动算)。
    自动判定 (不依赖供应商 Z/X 标注): fold=三轴中 |z| 最大; tilt=剩余两轴中 |y| 最大;
    right=第三; rotation_axis_dir=tilt。

    筛选 (区分镜体坐标系与 CAD 其它特征坐标系):
      - 排除放置点在原点 [0,0,0]±1mm 的世界系
      - 排除放置点落在球心附近 (球面自身 AXIS2_PLACEMENT_3D 在球心, 非 turret p1)
      - 自检: 折叠轴近竖直 (fold|z|>0.999) 且旋转轴近水平 (tilt|z|<0.05),
        否则 stderr 警告并跳过 (疑似特征坐标系, 非镜体坐标系)

    返回 {side: {turret_axis_p1[m], rotation_axis_dir, fold_axis_dir}}; 无有效坐标系时 {}。
    """
    sphere_centers = [np.array(s['center']) for s in spheres] if spheres else []
    # 命名优先: 供应商命名 左镜体坐标系/右镜体坐标系 (旧名 旋转轴左/右、MIRROR_FRAME_LEFT/RIGHT 兼容)
    # 直接定位, 跳过结构自检阈值 (命名是明确契约, 阈值仅用于未命名猜测)
    FRAME_ALIAS = {'左镜体坐标系': 'left', '右镜体坐标系': 'right',
                   '旋转轴左': 'left', '旋转轴右': 'right',
                   'MIRROR_FRAME_LEFT': 'left', 'MIRROR_FRAME_RIGHT': 'right'}
    candidates = []  # (side, frame)
    for eid, (t, args) in entities.items():
        if t != "AXIS2_PLACEMENT_3D":
            continue
        toks = scs._split_top_level(args)
        if len(toks) < 4:
            continue
        raw_name = toks[0].strip() if toks else ''
        name = decode_step_name(raw_name[1:-1]).strip() if (len(raw_name) >= 2 and raw_name[0] == "'" and raw_name[-1] == "'") else ''
        named_side = FRAME_ALIAS.get(name)
        loc_ref = _ref_of(toks[1])
        axis_ref = _ref_of(toks[2])
        ref_ref = _ref_of(toks[3])
        if loc_ref is None or axis_ref is None or ref_ref is None:
            continue
        loc = points.get(loc_ref)
        Z = _parse_direction(entities, axis_ref)
        X = _parse_direction(entities, ref_ref)
        if loc is None or Z is None or X is None:
            continue
        if np.linalg.norm(loc) < 1.0:  # 排除原点世界系
            continue
        if any(np.linalg.norm(loc - c) < 1.0 for c in sphere_centers):  # 排除球心坐标系
            continue
        Y = np.cross(Z, X)
        yn = float(np.linalg.norm(Y))
        if yn < 1e-12:
            continue
        Y = Y / yn
        axes = {'X': X, 'Y': Y, 'Z': Z}
        fold_key = max(axes, key=lambda k: abs(axes[k][2]))
        fold = axes[fold_key]
        rest = {k: v for k, v in axes.items() if k != fold_key}
        tilt_key = max(rest, key=lambda k: abs(rest[k][1]))
        tilt = rest[tilt_key]
        # 分左右: 命名优先, 否则按放置点 Y
        side = named_side or ('right' if loc[1] > 1.0 else ('left' if loc[1] < -1.0 else None))
        if side is None:  # 无命名且放置点 Y≈0, 无法分左右
            continue
        # 自检: 仅未命名时走结构阈值 (命名信任供应商, 不因 fold/tilt 朝向异常误拒)
        if not named_side and (abs(fold[2]) <= 0.999 or abs(tilt[2]) >= 0.05):
            print(f"  ⚠️ 跳过坐标系 #{eid} ({side}): 朝向异常 "
                  f"(fold|z|={abs(fold[2]):.4f}, tilt|z|={abs(tilt[2]):.4f})", file=sys.stderr)
            continue
        frame = {
            'turret_axis_p1': [round(float(loc[0]) / 1000, 6), round(float(loc[1]) / 1000, 6), round(float(loc[2]) / 1000, 6)],
            'rotation_axis_dir': [round(float(tilt[0]), 6), round(float(tilt[1]), 6), round(float(tilt[2]), 6)],
            'fold_axis_dir': [round(float(fold[0]), 6), round(float(fold[1]), 6), round(float(fold[2]), 6)],
            'named': bool(named_side),
        }
        candidates.append((side, frame))

    frames = {}
    for side in ('left', 'right'):
        c = [f for s, f in candidates if s == side]
        if not c:
            continue
        if len(c) > 1:
            named = [f for f in c if f.get('named')]
            if named:  # 命名候选优先于结构猜测
                c = named
            # 仍多候选: 选折叠轴最竖直、旋转轴最水平者
            c.sort(key=lambda f: abs(f['fold_axis_dir'][2]) - abs(f['rotation_axis_dir'][2]), reverse=True)
            print(f"  ⚠️ {side} 侧 {len(c)} 个候选镜体坐标系, 取折叠轴最竖直者", file=sys.stderr)
        frames[side] = c[0]
    return frames


def find_named_points(entities, points):
    """按 STEP 实体名找 CARTESIAN_POINT (中文新名 + 旧英文名兼容)。

    名单 (别名列表, 命中任一即认): 眼点左/眼点右, 地面前/地面后, 车门左/车门右。
    返回 {canonical: np.array([x,y,z] mm)}; 未命名的点不在内 (供启发式兜底)。
    """
    wanted = {
        'eye_left': ALIAS_EYE_LEFT,
        'eye_right': ALIAS_EYE_RIGHT,
        'ground_front': ALIAS_GROUND_FRONT,
        'ground_rear': ALIAS_GROUND_REAR,
        'door_left': ALIAS_DOOR_LEFT,
        'door_right': ALIAS_DOOR_RIGHT,
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


def find_named_mirror_faces(entities):
    """找命名的镜片面 (镜片左/镜片右), 返回 {side: face_eid}。
    命名优先于几何识别 (整车 STEP 多球面时避免误识)。
    """
    named = {}
    for eid, (t, args) in entities.items():
        if t != "ADVANCED_FACE":
            continue
        toks = scs._split_top_level(args)
        if len(toks) < 2:
            continue
        raw = toks[0].strip()
        if len(raw) < 2 or raw[0] != "'" or raw[-1] != "'":
            continue
        name = decode_step_name(raw[1:-1]).strip()
        if name in ALIAS_MIRROR_FACE_LEFT and 'left' not in named:
            named['left'] = eid
        elif name in ALIAS_MIRROR_FACE_RIGHT and 'right' not in named:
            named['right'] = eid
    return named


def _pt_to_m(p):
    return [round(float(p[0]) / 1000, 6), round(float(p[1]) / 1000, 6), round(float(p[2]) / 1000, 6)]


def extract_exterior(entities, points, step_name="step", manual=None):
    """核心提取: 从内存 entities/points 全自动提取完整外镜 JSON (一个 STEP 出 7 类参数)。

    manual: 可选现有 JSON (同车型 --json 模式), 仅补充 SR 元数据/regulation/车型名;
            几何字段 (球心/轮廓/轴线/眼点/地面/车门) 一律从 entities/points 提取。
    无球面时打印提示并返回 None。
    """
    spheres = find_spheres(entities, points)
    if not spheres:
        print("❌ 未找到球面镜片面 (SPHERICAL_SURFACE)")
        return None

    frames = find_mirror_frames(entities, points, spheres)
    named = find_named_points(entities, points)
    named_faces = find_named_mirror_faces(entities)
    if not frames:
        print("  ⚠️ 未找到镜体坐标系 (AXIS2_PLACEMENT_3D), 轴线回退默认 [0,1,0]+轮廓质心", file=sys.stderr)

    # 提取每个镜面的轮廓
    mirrors = {}
    for s in spheres:
        side = "right" if s['center'][1] > 0 else "left"
        if side in named_faces:
            faces = [named_faces[side]]
            print(f"  ℹ️ {side}: 命名镜片面 #{named_faces[side]}")
        else:
            faces = find_sphere_faces(s['id'], entities)
        best, best_face = None, None
        for fid in faces:
            outline = extract_outline(fid, entities, points)
            if outline and (best is None or len(outline) > len(best)):
                best, best_face = outline, fid

        if not best:
            print(f"  ❌ {side}: 无法提取轮廓")
            continue

        # 球面度验证
        d = np.linalg.norm(np.array(best) - np.array(s['center']), axis=1)
        max_dev = abs(d - s['radius']).max()
        print(f"  ✅ {side}: {len(best)}点, 球面偏差 {max_dev:.3f}mm, 面{best_face}")

        # 提取结果 (mm → m)
        outline_m = [[round(p[0]/1000, 6), round(p[1]/1000, 6), round(p[2]/1000, 6)] for p in best]
        sphere_center_m = [round(c/1000, 6) for c in s['center']]
        centroid_m = [round(float(np.mean(best, axis=0)[i])/1000, 6) for i in range(3)]

        # SR 元数据 (标称值图纸提供, 一般 1260±60; STEP 只含几何实测半径, --json 沿用现有标称)
        sr = {'sr_nominal': 1.26, 'sr_tolerance': 0.06}
        if manual and f'exterior_mirror_{side}' in manual:
            mm = manual[f'exterior_mirror_{side}']
            sr['sr_nominal'] = mm.get('sr_nominal', sr['sr_nominal'])
            sr['sr_tolerance'] = mm.get('sr_tolerance', sr['sr_tolerance'])

        # 轴线: STEP 坐标系 > --json 现有 > 默认 [0,1,0]+质心
        axis = {'turret_axis_p1': centroid_m, 'rotation_axis_dir': [0.0, 1.0, 0.0],
                'fold_axis_dir': None, 'axis_y_point': None, 'axis_z_point': None}
        frame = frames.get(side)
        if frame is not None:
            axis['turret_axis_p1'] = frame['turret_axis_p1']
            axis['rotation_axis_dir'] = frame['rotation_axis_dir']
            axis['fold_axis_dir'] = frame['fold_axis_dir']
            # 与 draft 对齐: axis_y_point = p1 + 0.1*rotation, axis_z_point = p1 + 0.1*fold
            p1 = np.array(frame['turret_axis_p1'])
            rot = np.array(frame['rotation_axis_dir'])
            fold = np.array(frame['fold_axis_dir'])
            axis['axis_y_point'] = [round(float(p1[i] + 0.1 * rot[i]), 6) for i in range(3)]
            axis['axis_z_point'] = [round(float(p1[i] + 0.1 * fold[i]), 6) for i in range(3)]
        elif manual and f'exterior_mirror_{side}' in manual and manual[f'exterior_mirror_{side}'].get('turret_axis_p1') is not None:
            mm = manual[f'exterior_mirror_{side}']
            axis['turret_axis_p1'] = mm['turret_axis_p1']
            axis['rotation_axis_dir'] = mm.get('rotation_axis_dir', axis['rotation_axis_dir'])
            axis['fold_axis_dir'] = mm.get('fold_axis_dir', axis['fold_axis_dir'])
            axis['axis_y_point'] = mm.get('axis_y_point')
            axis['axis_z_point'] = mm.get('axis_z_point')

        # SR 交叉验证: STEP 几何实测半径 vs 标称值 (偏差超公差 → 汇报, 不阻断)
        sr_fit = round(s['radius'] / 1000, 6)
        sr_dev = round(sr_fit - sr['sr_nominal'], 6)
        sr_ok = abs(sr_dev) <= sr['sr_tolerance']
        if not sr_ok:
            print(f"  ⚠️ {side}: SR 交叉验证偏差 {sr_dev*1000:+.1f}mm 超公差 ±{sr['sr_tolerance']*1000:.0f}mm "
                  f"(标称 {sr['sr_nominal']*1000:.0f} vs STEP 提取 {sr_fit*1000:.0f})")

        mirrors[side] = {
            'sr_nominal': sr['sr_nominal'],
            'sr_tolerance': sr['sr_tolerance'],
            'sr_fit': sr_fit,
            'radius': round(s['radius']/1000, 6),
            'sr_check': {'nominal': sr['sr_nominal'], 'tolerance': sr['sr_tolerance'],
                         'fit': sr_fit, 'dev_mm': round(sr_dev*1000, 2), 'ok': sr_ok},
            'outline_raw': outline_m,
            'supplier_sphere_center': sphere_center_m,
            'turret_axis_p1': axis['turret_axis_p1'],
            'axis_y_point': axis['axis_y_point'],
            'axis_z_point': axis['axis_z_point'],
            'rotation_axis_dir': axis['rotation_axis_dir'],
            'fold_axis_dir': axis['fold_axis_dir'],
        }

    print("STEP_PROGRESS|提取车门/眼点/地面...")

    # 车门最外 Y: 命名点 (取 Y 分量) > 几何百分位启发式
    door_left = door_right = None
    if 'door_left' in named:
        door_left = round(float(named['door_left'][1]) / 1000, 6)
    if 'door_right' in named:
        door_right = round(float(named['door_right'][1]) / 1000, 6)
    if door_left is None or door_right is None:
        print("  ⚠️ 车门点未命名, 用几何百分位启发式", file=sys.stderr)
        door_left_mm, door_right_mm = find_door_outer_Y(points, spheres)
        if door_left is None and door_left_mm is not None:
            door_left = round(-door_left_mm / 1000, 6)
        if door_right is None and door_right_mm is not None:
            door_right = round(door_right_mm / 1000, 6)
    door = {'door_outer_Y_left': door_left, 'door_outer_Y_right': door_right}

    # 眼点: 命名 > 几何启发式 > 硬编码回退
    eye_l = named.get('eye_left')
    eye_r = named.get('eye_right')
    if eye_l is not None and eye_r is not None:
        eye_l = _pt_to_m(eye_l)
        eye_r = _pt_to_m(eye_r)
    else:
        print("  ⚠️ 眼点未命名, 用几何启发式", file=sys.stderr)
        eye_l, eye_r = find_eyes(points)
        if not eye_l:
            found, _ = find_point_by_coord(points, [1471, -427.5, 1020])
            if found is not None:
                eye_l = _pt_to_m(found)
        if not eye_r:
            found, _ = find_point_by_coord(points, [1471, -362.5, 1020])
            if found is not None:
                eye_r = _pt_to_m(found)
    eye_center = None
    if eye_l and eye_r:
        eye_center = [(eye_l[0]+eye_r[0])/2, (eye_l[1]+eye_r[1])/2, (eye_l[2]+eye_r[2])/2]

    # 地面: 命名 > 几何启发式 > 硬编码回退
    gf = named.get('ground_front')
    gr = named.get('ground_rear')
    if gf is not None and gr is not None:
        gf = _pt_to_m(gf)
        gr = _pt_to_m(gr)
    else:
        print("  ⚠️ 地面点未命名, 用几何启发式", file=sys.stderr)
        gf, gr = find_ground(points)
        if not gf:
            found, _ = find_point_by_coord(points, [-1942.2, 0, -388.6])
            if found is not None:
                gf = _pt_to_m(found)
        if not gr:
            found, _ = find_point_by_coord(points, [4868, 0, -405.2])
            if found is not None:
                gr = _pt_to_m(found)

    # 组装 (顶层结构 = draft: vehicle/driver/ground/door_panel/exterior_mirror_*/regulation)
    vehicle_name = manual.get('vehicle', {}).get('name') if manual else None
    if not vehicle_name or vehicle_name.startswith('TBD'):
        vehicle_name = step_name

    result = {
        '_meta': {
            'source': 'step_exterior_extract',
            'step_file': step_name,
            'spheres': [{'id': s['id'], 'radius': s['radius'], 'center': s['center']} for s in spheres],
            'axes_from_step': bool(frames),
            'note': '轮廓/球心/轴线/眼点/地面/车门 全自动提取 (轴线来自 AXIS2_PLACEMENT_3D, 参考点命名优先+启发式兜底)',
        },
        'vehicle': {'name': vehicle_name},
        'driver': {
            'eye_center': eye_center,
            'interpupillary_distance': 0.065,
            'eye_left_raw': eye_l,
            'eye_right_raw': eye_r,
        },
        'ground': {'front_mid': gf, 'rear_mid': gr},
        'door_panel': door,
        'exterior_mirror_left': mirrors.get('left'),
        'exterior_mirror_right': mirrors.get('right'),
        'regulation': manual.get('regulation') if manual else {
            'standard': 'GB 15084', 'mirror_class': 'III',
            'width_near': 1.0, 'width_far': 4.0, 'dist_near': 4.0, 'dist_far': 20.0,
            'margin_mm': 3.0, 'adjust_deg': 3.0,
        },
    }
    return result


def main():
    import argparse
    parser = argparse.ArgumentParser(description="外镜数据一条龙提取")
    parser.add_argument("step_files", nargs='+', help="一个或多个 STEP 文件 (多文件自动合并)")
    parser.add_argument("--output", "-o", default=None, help="输出 JSON 路径")
    parser.add_argument("--json", default=None, help="现有数据 JSON (同车型, 补充未提取字段)")
    args = parser.parse_args()

    print(f"解析 STEP: {len(args.step_files)} 个文件")
    print("STEP_PROGRESS|解析 STEP 文件中...")
    entities, points = scs.parse_and_merge(args.step_files)
    print(f"实体: {len(entities)}, 点: {len(points)}")
    print(f"STEP_PROGRESS|已解析 {len(entities)} 实体, 提取镜面轮廓")

    manual = None
    if args.json:
        manual = json.load(open(args.json, encoding='utf-8'))

    result = extract_exterior(entities, points, step_name=Path(args.step_files[0]).stem, manual=manual)
    if result is None:
        return

    out_path = args.output or str(Path(args.step_file).with_suffix('.exterior.json'))
    print("STEP_PROGRESS|写入输出文件...")
    with open(out_path, 'w', encoding='utf-8') as f:
        json.dump(result, f, ensure_ascii=False, indent=2)
    print(f"\n→ 输出: {out_path}")
    lm = result.get('exterior_mirror_left') or {}
    rm = result.get('exterior_mirror_right') or {}
    print(f"  左镜: {len(lm.get('outline_raw', []))} 点, 右镜: {len(rm.get('outline_raw', []))} 点")
    print(f"  眼点: {result['driver']['eye_left_raw']} / {result['driver']['eye_right_raw']}, "
          f"地面: {result['ground']['front_mid']} / {result['ground']['rear_mid']}")
    print(f"  车门: {result['door_panel']}")


if __name__ == "__main__":
    main()
