"""
STEP 曲线采样器 (原型)
=======================
纯 Python + numpy 解析 STEP AP214, 从 B_SPLINE_CURVE_WITH_KNOTS / CIRCLE 实体
按弧长均匀采样 N 点。零重依赖 (numpy 项目已有)。

背景: 3DE COM MeasurableService 不实现 GetPoints (3 轮探测全失败),
      但 STEP 导出完整保留 BRep 参数化曲线定义 (控制点/节点/度)。
      本解析器把 STEP 文本里的曲线转成采样点坐标 (mm, 整车坐标系)。

用法:
    python step_curve_sampler.py <step_file> [--n 20] [--curve-id 38]
    python step_curve_sampler.py <step_file> --list   # 列出所有曲线 + 长度
"""
import re
import sys
import math
import argparse
from pathlib import Path

import numpy as np

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass


# ─── STEP 文本解析 ──────────────────────────────────────────

# 逐行匹配 (STEP 实体一行一条); 贪婪 .* 到行尾 ); (支持 $ 空值标记)
# 单行实体 (完整定义在一行, 以 ); 结尾)
ENTITY_RE = re.compile(r'#(\d+)\s*=\s*([A-Z_0-9]+)\s*\((.*)\)\s*;\s*$')
# 多行实体起始行 (只匹配开头, 不要求 ); 结尾)
ENTITY_START_RE = re.compile(r'#(\d+)\s*=\s*([A-Z_0-9]+)\s*\(')


def parse_step(path):
    """解析 STEP 文件, 返回 (entities, points)。
    entities: {id: (type, raw_args_str)}
    points: {id: np.array([x,y,z])}  CARTESIAN_POINT

    支持多行实体 (B 样条曲线等跨行定义)。单个实体的行缓存到 `);` 结束。
    """
    entities = {}
    points = {}
    with open(path, encoding="utf-8", errors="replace") as f:
        in_data = False
        pending = ""          # 多行实体的累计内容
        pending_eid = None
        pending_etype = None
        for line in f:
            if "DATA;" in line:
                in_data = True
                continue
            if "ENDSEC;" in line and in_data:
                break
            if not in_data:
                continue
            line = line.strip()
            if pending_eid is not None:
                # 延续上一个多行实体
                if ");" in line:
                    pending += line[:line.index(");")]  # 去掉末尾 `);`
                    entities[pending_eid] = (pending_etype, pending)
                    if pending_etype == "CARTESIAN_POINT":
                        pts = _parse_point_args(pending)
                        if pts is not None:
                            points[pending_eid] = pts
                    pending_eid = None
                    pending_etype = None
                    pending = ""
                else:
                    pending += line
                continue
            m = ENTITY_RE.match(line)
            if not m:
                m_start = ENTITY_START_RE.match(line)
                if not m_start:
                    continue
                # 多行实体起始行: 只匹配开头, 缓存内容等 `);`
                eid = int(m_start.group(1))
                etype = m_start.group(2)
                args = line[m_start.end():]  # 开头 `(` 之后的全部内容
                pending_eid = eid
                pending_etype = etype
                pending = args
                continue
            eid = int(m.group(1))
            etype = m.group(2)
            args = m.group(3)
            # 单行实体 (完整在一行)
            entities[eid] = (etype, args)
            if etype == "CARTESIAN_POINT":
                pts = _parse_point_args(args)
                if pts is not None:
                    points[eid] = pts
    return entities, points


def parse_and_merge(paths):
    """解析多个 STEP 文件并合并 (实体/点 ID 重编号), 供多文件上传凑齐参数。

    文件顺序无关: 后解析文件的实体/点 ID 加偏移, 避免与已有 ID 冲突;
    args 内的 #ref 引用同步重编号。合并后一次提取全部参数。
    """
    entities = {}
    points = {}
    for p in paths:
        e, pts = parse_step(p)
        if not e:
            print(f"  ⚠️ 空文件或无 DATA: {p}", file=sys.stderr)
            continue
        offset = max(list(entities.keys()) + list(points.keys()), default=0) + 1
        if offset > 1:
            e = {eid + offset: (etype, re.sub(r'#(\d+)', lambda m: '#' + str(int(m.group(1)) + offset), args))
                 for eid, (etype, args) in e.items()}
            pts = {pid + offset: pt for pid, pt in pts.items()}
        entities.update(e)
        points.update(pts)
    return entities, points


def _parse_point_args(args):
    """CARTESIAN_POINT( '', #ref, (x,y,z) )  或  (x,y,z) 内联"""
    # 找最后一个 (a,b,c) 三元组
    m = re.findall(r"\(([^()]*)\)", args)
    for coord_str in reversed(m):
        parts = [p.strip() for p in coord_str.split(",")]
        if len(parts) == 3:
            try:
                return np.array([float(parts[0]), float(parts[1]), float(parts[2])])
            except ValueError:
                continue
    # 也许坐标引用自其他点 (DIRECTION 等), 跳过
    return None


def parse_bspline_curve(eid, args, entities, points):
    """解析 B_SPLINE_CURVE_WITH_KNOTS, 返回 dict(degree, ctrl_pts, knots, mults)"""
    # 格式: ('name', degree, (#p1,#p2,...), .UNSPECIFIED., .F., .U.,
    #        (mult...), (knot...), .UNSPECIFIED.)
    # 用括号层级分割
    tokens = _split_top_level(args)
    if len(tokens) < 7:
        return None
    try:
        degree = int(tokens[1])
    except (ValueError, IndexError):
        return None
    # 控制点引用: tokens[2] = (#p1,#p2,...)
    ctrl_refs = _parse_ref_list(tokens[2])
    ctrl_pts = []
    for ref in ctrl_refs:
        if ref in points:
            ctrl_pts.append(points[ref])
        else:
            # 可能是 DIRECTION 或其他, 跳过该曲线
            return None
    # mults: tokens[6], knots: tokens[7]  (索引取决于格式, 试探)
    mults = _parse_float_list(tokens[6]) if len(tokens) > 6 else None
    knots = _parse_float_list(tokens[7]) if len(tokens) > 7 else None
    if mults is None or knots is None:
        # 尝试其他位置
        for i in range(6, len(tokens)):
            v = _parse_float_list(tokens[i])
            if v and len(v) >= 2 and v[0] == 0.0:
                knots = v
                mults = _parse_float_list(tokens[i - 1]) if i > 0 else None
                break
    if not ctrl_pts or not knots or not mults:
        return None
    return {
        "degree": degree,
        "ctrl_pts": np.array(ctrl_pts),
        "knots": np.array(knots),
        "mults": np.array(mults, dtype=int),
        "length": knots[-1],  # 弧长参数化时, 末 knot = 曲线长度
    }


def _split_top_level(s):
    """按逗号分割顶层 (忽略括号内逗号)"""
    tokens = []
    depth = 0
    cur = ""
    for ch in s:
        if ch == "(":
            depth += 1
            cur += ch
        elif ch == ")":
            depth -= 1
            cur += ch
        elif ch == "," and depth == 0:
            tokens.append(cur.strip())
            cur = ""
        else:
            cur += ch
    if cur.strip():
        tokens.append(cur.strip())
    return tokens


def _parse_ref_list(s):
    """(#a,#b,#c) -> [a, b, c]"""
    s = s.strip().strip("()")
    refs = []
    for part in s.split(","):
        part = part.strip()
        if part.startswith("#"):
            try:
                refs.append(int(part[1:]))
            except ValueError:
                pass
    return refs


def _parse_float_list(s):
    """(1.0, 2.0, 3.0) -> [1.0, 2.0, 3.0]"""
    s = s.strip().strip("()")
    vals = []
    for part in s.split(","):
        part = part.strip()
        if part == "" or part == "$" or part.startswith("."):
            continue
        try:
            vals.append(float(part))
        except ValueError:
            pass
    return vals


# ─── B-spline de Boor 求值 ──────────────────────────────────

def find_knot_span(n_ctrl, degree, u, knots):
    """找参数 u 所在的 knot span 索引 (clamped B-spline)"""
    # n_ctrl = 控制点数; knots 长度 = n_ctrl + degree + 1
    if u >= knots[n_ctrl]:  # 末尾
        return n_ctrl - degree - 1
    low = degree
    high = n_ctrl
    mid = (low + high) // 2
    while u < knots[mid] or u >= knots[mid + 1]:
        if u < knots[mid]:
            high = mid
        else:
            low = mid
        mid = (low + high) // 2
    return mid


def de_boor(degree, ctrl_pts, knots, mults, u):
    """de Boor 算法求 B-spline 上参数 u 处的点"""
    # 构建完整 knot 向量 (展开 multiplicity)
    full_knots = []
    for k, m in zip(knots, mults):
        full_knots.extend([k] * m)
    full_knots = np.array(full_knots)

    n_ctrl = len(ctrl_pts)
    if len(full_knots) != n_ctrl + degree + 1:
        # 维度不匹配, 退化为线性插值控制点
        return None

    span = find_knot_span(n_ctrl, degree, u, full_knots)
    if span < 0:
        return ctrl_pts[0]

    # de Boor: 复制相关控制点, 逐层插值
    d = [ctrl_pts[span - degree + j].copy() for j in range(degree + 1)]
    for r in range(1, degree + 1):
        for j in range(degree, r - 1, -1):
            denom = full_knots[span + j] - full_knots[span - degree + j]
            if denom == 0:
                alpha = 0.0
            else:
                alpha = (u - full_knots[span - degree + j]) / denom
            d[j - r] = (1 - alpha) * d[j - r] + alpha * d[j]
    return d[0]


def sample_bspline(curve, n):
    """按弧长均匀采样 B-spline 上 n 个点 (返回 n×3 数组, mm)"""
    degree = curve["degree"]
    ctrl_pts = curve["ctrl_pts"]
    knots = curve["knots"]
    mults = curve["mults"]
    u_min, u_max = knots[0], knots[-1]
    params = np.linspace(u_min, u_max, n)
    pts = []
    for u in params:
        p = de_boor(degree, ctrl_pts, knots, mults, u)
        if p is not None:
            pts.append(p)
    return np.array(pts) if pts else np.empty((0, 3))


# ─── CIRCLE 解析 + 采样 ─────────────────────────────────────

def parse_circle(eid, args, entities, points):
    """CIRCLE('name', #axis_placement, radius) — 需从 axis_placement 拿原点+法线"""
    tokens = _split_top_level(args)
    if len(tokens) < 3:
        return None
    try:
        radius = float(tokens[2])
    except ValueError:
        return None
    # axis_placement 引用
    ref_m = re.match(r"#(\d+)", tokens[1].strip())
    if not ref_m:
        return None
    axis_id = int(ref_m.group(1))
    # AXIS2_PLACEMENT_3D('name', #origin_point, #axis_dir, #ref_dir)
    if axis_id not in entities:
        return None
    atype, aargs = entities[axis_id]
    atokens = _split_top_level(aargs)
    if len(atokens) < 3:
        return None
    origin_ref = re.match(r"#(\d+)", atokens[1].strip())
    axis_ref = re.match(r"#(\d+)", atokens[2].strip())
    if not origin_ref or not axis_ref:
        return None
    origin_id = int(origin_ref.group(1))
    axis_id2 = int(axis_ref.group(1))
    if origin_id not in points:
        return None
    origin = points[origin_id]
    # 法线方向 (DIRECTION 实体)
    if axis_id2 not in entities:
        return None
    dtype, dargs = entities[axis_id2]
    if dtype != "DIRECTION":
        return None
    dcoords = _parse_float_list(dargs)
    # DIRECTION 格式 ('', (x,y,z)) 或 (x,y,z)
    if len(dcoords) != 3:
        dcoords = _parse_float_list(dargs.split("(", 1)[1] if "(" in dargs else dargs)
    if len(dcoords) != 3:
        return None
    normal = np.array(dcoords)
    normal = normal / np.linalg.norm(normal)
    return {"origin": origin, "normal": normal, "radius": radius}


def sample_circle(circ, n):
    """采样圆上 n 个点 (整圆, 均匀分布)"""
    origin = circ["origin"]
    normal = circ["normal"]
    r = circ["radius"]
    # 构造圆所在平面的两个正交基向量
    # 选一个不平行于 normal 的向量
    if abs(normal[2]) < 0.9:
        ref = np.array([0, 0, 1.0])
    else:
        ref = np.array([1.0, 0, 0])
    u_axis = np.cross(normal, ref)
    u_axis = u_axis / np.linalg.norm(u_axis)
    v_axis = np.cross(normal, u_axis)
    angles = np.linspace(0, 2 * math.pi, n, endpoint=False)
    pts = origin + r * (np.outer(np.cos(angles), u_axis) + np.outer(np.sin(angles), v_axis))
    return pts


# ─── 主流程 ─────────────────────────────────────────────────

def list_curves(path, top_n=30):
    """列出所有曲线, 按长度排序"""
    print(f"解析 STEP: {path}")
    entities, points = parse_step(path)
    print(f"实体总数: {len(entities)}, CARTESIAN_POINT: {len(points)}")

    curves = []
    for eid, (etype, args) in entities.items():
        if etype == "B_SPLINE_CURVE_WITH_KNOTS":
            c = parse_bspline_curve(eid, args, entities, points)
            if c:
                curves.append((eid, "B-spline", c["length"], c["ctrl_pts"].shape[0], c["degree"]))
        elif etype == "CIRCLE":
            c = parse_circle(eid, args, entities, points)
            if c:
                curves.append((eid, "Circle", 2 * math.pi * c["radius"], 0, 0))

    curves.sort(key=lambda x: -x[2])
    print(f"\n曲线总数: {len(curves)} (按长度降序, 前 {top_n}):")
    print(f"{'ID':>8} {'类型':<10} {'长度mm':>10} {'CtrlPts':>8} {'度':>4}")
    for eid, typ, length, nctrl, deg in curves[:top_n]:
        print(f"#{eid:<7} {typ:<10} {length:>10.2f} {nctrl:>8} {deg:>4}")
    return entities, points, curves


def sample_curve_by_id(path, curve_id, n=20):
    """采样指定 ID 的曲线"""
    entities, points = parse_step(path)
    if curve_id not in entities:
        print(f"错误: #{curve_id} 不存在")
        return
    etype, args = entities[curve_id]
    print(f"采样 #{curve_id} ({etype}), n={n}")
    if etype == "B_SPLINE_CURVE_WITH_KNOTS":
        c = parse_bspline_curve(curve_id, args, entities, points)
        if not c:
            print("解析失败")
            return
        pts = sample_bspline(c, n)
    elif etype == "CIRCLE":
        c = parse_circle(curve_id, args, entities, points)
        if not c:
            print("解析失败")
            return
        pts = sample_circle(c, n)
    else:
        print(f"不支持的类型: {etype}")
        return

    print(f"\n采样 {len(pts)} 点 (mm, 整车坐标系):")
    print(f"{'idx':>4} {'X':>12} {'Y':>12} {'Z':>12}")
    for i, p in enumerate(pts):
        print(f"{i:>4} {p[0]:>12.3f} {p[1]:>12.3f} {p[2]:>12.3f}")
    print(f"\n坐标范围:")
    print(f"  X: {pts[:,0].min():.2f} ~ {pts[:,0].max():.2f}  (跨度 {np.ptp(pts[:,0]):.2f}mm)")
    print(f"  Y: {pts[:,1].min():.2f} ~ {pts[:,1].max():.2f}  (跨度 {np.ptp(pts[:,1]):.2f}mm)")
    print(f"  Z: {pts[:,2].min():.2f} ~ {pts[:,2].max():.2f}  (跨度 {np.ptp(pts[:,2]):.2f}mm)")
    return pts


def sample_outline_to_json(step_file, curve_ids, n_per_curve, output_path, close_loop=True):
    """采样多条曲线, 拼成闭合 outline, 输出 exterior JSON。

    Args:
        step_file: STEP 文件路径
        curve_ids: [id1, id2, ...] 曲线实体 ID 列表 (按轮廓顺序)
        n_per_curve: 每条曲线采样点数
        output_path: 输出 JSON 路径
        close_loop: 是否在末尾重复首点闭合轮廓

    Returns:
        outline 点列表 [[x,y,z], ...] m (整车坐标系, 米制 — 与 exterior schema 一致)
    """
    import json
    entities, points = parse_step(step_file)
    outline_mm = []
    for cid in curve_ids:
        if cid not in entities:
            print(f"⚠️ #{cid} 不存在, 跳过")
            continue
        etype, args = entities[cid]
        if etype == "B_SPLINE_CURVE_WITH_KNOTS":
            c = parse_bspline_curve(cid, args, entities, points)
            pts = sample_bspline(c, n_per_curve) if c else np.empty((0, 3))
        elif etype == "CIRCLE":
            c = parse_circle(cid, args, entities, points)
            pts = sample_circle(c, n_per_curve) if c else np.empty((0, 3))
        else:
            print(f"⚠️ #{cid} 类型 {etype} 不支持采样, 跳过")
            continue
        # 去重: 与上一段末点重合的首点跳过 (曲线拼接处)
        if outline_mm and len(pts) > 0:
            last = outline_mm[-1]
            if np.linalg.norm(np.array(last) - pts[0]) < 0.01:
                pts = pts[1:]
        outline_mm.extend([[float(p[0]), float(p[1]), float(p[2])] for p in pts])

    if close_loop and len(outline_mm) > 1:
        # 末点 ≠ 首点时补一个 (闭合)
        if np.linalg.norm(np.array(outline_mm[-1]) - np.array(outline_mm[0])) > 0.01:
            outline_mm.append(outline_mm[0])

    # mm → m (exterior schema 用米制)
    outline_m = [[p[0] * 0.001, p[1] * 0.001, p[2] * 0.001] for p in outline_mm]

    # 输出 JSON (exterior_mirror_* schema 子集 — outline_raw + 元数据)
    result = {
        "source": "step_sampled",
        "step_file": step_file,
        "curve_ids": curve_ids,
        "n_per_curve": n_per_curve,
        "outline_raw": outline_m,
        "outline_count": len(outline_m),
        "coordinate_system": "整车坐标系 (X+后方, Y+右侧, Z+上方)",
        "unit": "m",
        "_note": "由 STEP 曲线采样生成, 非逐点手选。可接入 sphere-fit + verifyExterior。",
    }
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)
    print(f"\n→ 输出: {output_path}")
    print(f"  outline 点数: {len(outline_m)} (来自 {len(curve_ids)} 条曲线, 每条 {n_per_curve} 点)")
    if outline_m:
        arr = np.array(outline_m) * 1000  # 回 mm 显示
        print(f"  坐标范围 (mm): X {arr[:,0].min():.1f}~{arr[:,0].max():.1f}  "
              f"Y {arr[:,1].min():.1f}~{arr[:,1].max():.1f}  "
              f"Z {arr[:,2].min():.1f}~{arr[:,2].max():.1f}")
    return outline_m


def main():
    ap = argparse.ArgumentParser(
        description="STEP 曲线采样器 — 从 STEP 文件按弧长均匀采样曲线点",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
示例:
  python step_curve_sampler.py car.stp --list                  # 列出所有曲线 (按长度排序)
  python step_curve_sampler.py car.stp --curve-id 270368 --n 30  # 采样单条曲线 30 点
  python step_curve_sampler.py car.stp --output-json out.json --curve-ids 270368,174205 --n 20  # 拼轮廓输出 JSON
        """,
    )
    ap.add_argument("step_file", help="STEP 文件路径")
    ap.add_argument("--n", type=int, default=20, help="每条曲线采样点数 (默认 20)")
    ap.add_argument("--curve-id", type=int, help="采样单条曲线 (实体 ID)")
    ap.add_argument("--curve-ids", help="多条曲线 ID 逗号分隔 (拼 outline, 配合 --output-json)")
    ap.add_argument("--output-json", help="输出 JSON 路径 (outline_raw 格式, 米制)")
    ap.add_argument("--list", action="store_true", help="列出所有曲线 + 长度")
    args = ap.parse_args()

    if args.list:
        list_curves(args.step_file)
        return
    if args.output_json:
        if not args.curve_ids:
            print("错误: --output-json 需配合 --curve-ids (曲线 ID 逗号分隔)")
            sys.exit(1)
        ids = [int(x.strip()) for x in args.curve_ids.split(",") if x.strip()]
        sample_outline_to_json(args.step_file, ids, args.n, args.output_json)
        return
    if args.curve_id:
        sample_curve_by_id(args.step_file, args.curve_id, args.n)
        return
    # 默认: 列曲线
    list_curves(args.step_file)


if __name__ == "__main__":
    main()
