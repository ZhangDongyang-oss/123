"""
CATIA 参数提取流程
===================

基于 Measurable API (路线 R1) 的完整提取流程:
  装配层级选点即读，无需进 Part，无需改点类型

用法::

    from mirror_fov.catia_extract import CATIAExtractor

    ext = CATIAExtractor()
    ext.connect()
    data = ext.extract_all()  # 交互式提取全部参数
    ext.save_yaml(data, "data/vehicles/new_car.yaml")
    ext.disconnect()

命令行::

    python -m mirror_fov.catia_extract                  # 交互式提取
    python -m mirror_fov.catia_extract --output car.yaml  # 指定输出文件
"""

import logging
import math
import os
import sys
from typing import Optional, List

import numpy as np
import yaml

from .catia_conn import (
    CATIAConnection, ConnectionError, CoordinateError,
    MM_TO_M, M_TO_MM,
)

logger = logging.getLogger(__name__)

# ─── 已知参考值 (mm, 整车坐标系) ───────────────────────────

KNOWN_POINTS_MM = {
    "pivot":       [2883.07, 0.0, 1441.017],
    "center_zero": [2909.215, 0.007, 1441.880],
    "eye_center":  [3243.09, -385.0, 1372.0],
}


class CATIAExtractor:
    """CATIA 参数提取器

    属性:
        conn: CATIAConnection 实例
    """

    def __init__(self):
        self.conn = CATIAConnection()

    def connect(self):
        """连接 3DEXPERIENCE"""
        self.conn.connect()
        logger.info(f"已连接: {self.conn.get_version()}")

    def disconnect(self):
        """断开连接"""
        self.conn.disconnect()

    # ─── 单个点提取 ──────────────────────────────────────

    def extract_point(self, prompt: str,
                      known_mm: Optional[list] = None,
                      context: str = "") -> Optional[np.ndarray]:
        """交互式提取一个点的坐标

        Args:
            prompt: CATIA 选择框提示
            known_mm: 已知坐标 [x, y, z] mm (用于校验)
            context: 点名 (用于日志)

        Returns:
            np.ndarray [X, Y, Z] m，或 None (用户取消)
        """
        print(f"\n  {prompt}")
        coords_mm = self.conn.select_point(prompt)

        if coords_mm is None:
            print("  用户取消")
            return None

        x, y, z = coords_mm
        print(f"  ★ 坐标: ({x:.3f}, {y:.3f}, {z:.3f}) mm")

        # 校验范围
        self.conn.validate_coords_mm(coords_mm, context)

        # 与已知值比对
        if known_mm:
            dist = ((x - known_mm[0])**2 +
                    (y - known_mm[1])**2 +
                    (z - known_mm[2])**2) ** 0.5
            if dist < 1:
                print(f"  ✅ 精确匹配 (差 {dist:.3f} mm)")
            elif dist < 50:
                print(f"  ⚠️ 接近 (差 {dist:.3f} mm)")
            else:
                print(f"  ⚠️ 偏差较大 (差 {dist:.1f} mm)")

        # 转换为 m
        return np.array([x * MM_TO_M, y * MM_TO_M, z * MM_TO_M])

    def extract_edge_length(self, prompt: str,
                            expected_mm: Optional[float] = None,
                            context: str = "") -> Optional[float]:
        """交互式提取边长度

        Args:
            prompt: CATIA 选择框提示
            expected_mm: 预期长度 mm (用于校验)
            context: 边名 (用于日志)

        Returns:
            长度 m，或 None (用户取消)
        """
        print(f"\n  {prompt}")
        length_mm = self.conn.select_edge(prompt)

        if length_mm is None:
            print("  用户取消")
            return None

        print(f"  ★ 长度: {length_mm:.3f} mm")

        if expected_mm:
            diff = abs(length_mm - expected_mm)
            if diff < 2:
                print(f"  ✅ 匹配 (差 {diff:.3f} mm)")
            elif diff < 10:
                print(f"  ⚠️ 接近 (差 {diff:.3f} mm)")
            else:
                print(f"  ⚠️ 偏差较大 (差 {diff:.1f} mm)")

        return length_mm * MM_TO_M

    def extract_face_area(self, prompt: str,
                          context: str = "") -> Optional[float]:
        """交互式提取面面积

        Args:
            prompt: CATIA 选择框提示
            context: 面名 (用于日志)

        Returns:
            面积 m²，或 None (用户取消)
        """
        print(f"\n  {prompt}")
        area_m2 = self.conn.select_face(prompt)

        if area_m2 is None:
            print("  用户取消")
            return None

        print(f"  ★ 面积: {area_m2:.6f} m² ({area_m2 * 1e6:.1f} mm²)")
        return area_m2

    # ─── 全参数提取 ──────────────────────────────────────

    def extract_all(self, existing_config: Optional[dict] = None) -> dict:
        """交互式提取全部参数

        Args:
            existing_config: 已有配置 (用于预填已知值)

        Returns:
            config dict (可直接写入 YAML)
        """
        print("\n" + "=" * 60)
        print("内后视镜参数提取")
        print("=" * 60)
        print("\n请在 CATIA 中依次选择以下几何。")
        print("坐标系: 整车坐标系 (X+后方, Y+右侧, Z+上方)")
        print("单位: mm (自动转换为 m)")

        cfg = existing_config or {}

        # ─── 点坐标 ──────────────────────────────────────

        print("\n" + "-" * 40)
        print("一、点坐标")
        print("-" * 40)

        points = {}

        # ① 球铰中心
        pivot = self.extract_point(
            "[1/5] 请选球铰中心 (pivot)",
            known_mm=KNOWN_POINTS_MM.get("pivot"),
            context="pivot"
        )
        if pivot is not None:
            points["pivot"] = pivot.tolist()

        # ② 零位镜面中心
        cz = self.extract_point(
            "[2/5] 请选零位镜面中心 (center_zero)",
            known_mm=KNOWN_POINTS_MM.get("center_zero"),
            context="center_zero"
        )
        if cz is not None:
            points["center_zero"] = cz.tolist()

        # ③ 镜面反射区 4 角 → 推 width/height/yaw/pitch (取消则退回手输)
        print("\n  镜面反射区 4 角 (推宽高 + 当前姿态 yaw/pitch):")
        mc = self.extract_corners(
            "镜面角", 4, labels=["TL 左上", "TR 右上", "BL 左下", "BR 右下"]
        )
        derived = None
        if mc is not None:
            derived = self.derive_mirror_dims(mc)
            w_m, h_m, yaw_v, pitch_v = derived
            print(f"  → width={w_m*1000:.3f}mm  height={h_m*1000:.3f}mm  "
                  f"yaw={yaw_v:.3f}°  pitch={pitch_v:.3f}°")

        # ④ 眼点 (探测结论: 模型直接暴露眼点 Z≈1.372m, 无需 +635)
        ep = self.extract_point(
            "[3/5] 请选眼点",
            known_mm=KNOWN_POINTS_MM.get("eye_center"),
            context="eye_center"
        )
        if ep is not None:
            points["eye_center"] = ep.tolist()
            ec = ep.tolist()
            print(f"  → eye_center: ({ec[0]*1000:.3f}, {ec[1]*1000:.3f}, {ec[2]*1000:.3f}) mm")

        # ④ 地面前端
        gf = self.extract_point(
            "[4/5] 请选地面前端中点 (靠近车头)",
            context="ground_front"
        )
        if gf is not None:
            points["ground_front"] = gf.tolist()

        # ⑤ 地面后端
        gr = self.extract_point(
            "[5/5] 请选地面后端中点 (靠近车尾)",
            context="ground_rear"
        )
        if gr is not None:
            points["ground_rear"] = gr.tolist()

        # ─── 后挡风 (4 角 + 透光区 4 角) ─────────────────

        print("\n" + "-" * 40)
        print("二、后挡风玻璃")
        print("-" * 40)

        rw = {}
        if self._ask_yes_no("提取后挡风玻璃角点? (暂跳过则否)", False):
            outline = self.extract_corners("后挡风 outline", 7)
            if outline:
                rw["outline"] = outline
            if self._ask_yes_no("  提取透光区 transparent_zone? (无则跳过)", False):
                tz = self.extract_corners("透光区 transparent", 4)
                if tz:
                    rw["transparent_zone"] = tz

        # ─── 尺寸/姿态 (4 角已推则用之, 否则手输) ──────────

        print("\n" + "-" * 40)
        print("三、镜面尺寸与姿态")
        print("-" * 40)

        if derived is not None:
            w = derived[0] * M_TO_MM
            h = derived[1] * M_TO_MM
            yaw = derived[2]
            pitch = derived[3]
            print(f"  (由 4 角推出) width={w:.3f}mm height={h:.3f}mm "
                  f"yaw={yaw:.3f}° pitch={pitch:.3f}°")
        else:
            print("  (未选 4 角, 手输尺寸/姿态)")
            w = self._input_float(
                "镜面宽度 (mm)",
                default=cfg.get("mirror", {}).get("width", 0) * M_TO_MM
            )
            h = self._input_float(
                "镜面高度 (mm)",
                default=cfg.get("mirror", {}).get("height", 0) * M_TO_MM
            )
            yaw = self._input_float(
                "当前 yaw 角度 (°, 负=偏左)",
                default=cfg.get("mirror", {}).get("yaw", -23.5)
            )
            pitch = self._input_float(
                "当前 pitch 角度 (°, 正=上仰)",
                default=cfg.get("mirror", {}).get("pitch", 5.0)
            )
            if w <= 0 or h <= 0:
                print("  ⚠️ 镜面宽/高为 0, 校核将无效。建议重选 4 角或带 --config 预填。")

        # ─── 构建 config dict ────────────────────────────

        config = {}

        # mirror (圆角R 为人工取点遗留参数, STEP 时代镜面形状由轮廓定义, 不再采集)
        mirror = {}
        if "pivot" in points:
            mirror["pivot"] = points["pivot"]
        if "center_zero" in points:
            mirror["center_zero"] = points["center_zero"]
        mirror["width"] = round(w * MM_TO_M, 6)
        mirror["height"] = round(h * MM_TO_M, 6)
        mirror["yaw"] = yaw
        mirror["pitch"] = pitch
        config["mirror"] = mirror

        # driver
        if "eye_center" in points:
            config["driver"] = {
                "eye_center": points["eye_center"],
                "interpupillary_distance": 0.065,
            }

        # ground
        if "ground_front" in points and "ground_rear" in points:
            config["ground"] = {
                "front_mid": points["ground_front"],
                "rear_mid": points["ground_rear"],
            }

        # rear_window
        if rw:
            config["rear_window"] = rw

        # vehicle name
        name = input("\n车型名称 (用于文件名): ").strip()
        if name:
            config["vehicle"] = {"name": name}

        return config

    # ─── 外后视镜参数提取 ──────────────────────────────────

    def extract_outline_points(self, label: str) -> Optional[list]:
        """交互式批量提取轮廓点 (选完按取消结束)

        Args:
            label: 镜名 (左/右, 用于提示)

        Returns:
            [[x,y,z], ...] m (至少 4 点), 或 None (用户一开始就取消)
        """
        print(f"\n  {label} 镜面轮廓点 (沿边界依次选, 选完按取消结束)")
        print(f"  建议 ≥6 点, 沿反射面外沿均匀分布")
        corners = []
        idx = 1
        while True:
            prompt = f"{label} 轮廓点 {idx} (取消结束)"
            p = self.extract_point(prompt, context=f"{label}_outline")
            if p is None:
                break
            corners.append(p.tolist())
            idx += 1
        if len(corners) < 4:
            print(f"  ⚠️ 仅 {len(corners)} 点 (< 4), 轮廓无效, 请重选")
            return self.extract_outline_points(label) if self._ask_yes_no("重选?", True) else None
        print(f"  ★ 共选 {len(corners)} 点")
        return corners

    def extract_all_exterior(self, existing_config: Optional[dict] = None) -> dict:
        """交互式提取外后视镜全部参数 (III 类凸球面镜)

        流程:
          通用: 眼点 + 地面2点 + 车门最外点左右
          每侧镜: 轮廓N点(批量) + 轴线p1 + axis_y_point + axis_z_point + 供应商球心(可选)
          手输: SR标称 + 公差 (供应商数据, 3DE 读不到)
        """
        print("\n" + "=" * 60)
        print("外后视镜参数提取 (III 类凸球面镜)")
        print("=" * 60)
        print("\n请在 CATIA 中依次选择以下几何。")
        print("坐标系: 整车坐标系 (X+后方, Y+右侧, Z+上方)")
        print("单位: mm (自动转换为 m)")

        cfg = existing_config or {}

        # ─── 通用: 眼点 + 地面 + 车门最外点 ────────────────
        print("\n" + "-" * 40)
        print("一、通用参数 (眼点 / 地面 / 车门)")
        print("-" * 40)

        ep = self.extract_point("[1/4] 请选眼点中心", context="eye_center")
        eye_m = ep.tolist() if ep is not None else [1.471, -0.395, 1.020]

        gf = self.extract_point("[2/4] 请选地面前端中点", context="ground_front")
        gr = self.extract_point("[3/4] 请选地面后端中点", context="ground_rear")

        print("\n  [4/4] 车门最外点 (左右各 1 点, 只用 Y 值)")
        door_l = self.extract_point("  左侧车门最外点", context="door_left")
        door_r = self.extract_point("  右侧车门最外点", context="door_right")
        door_l_y = door_l[1] if door_l is not None else -1.005
        door_r_y = door_r[1] if door_r is not None else 1.005

        # ─── SR 设计值 (手输, 3DE 读不到) ──────────────────
        print("\n" + "-" * 40)
        print("二、球面曲率半径 SR (供应商数据, 手输)")
        print("-" * 40)
        sr_nominal = self._input_float("SR 设计标称值 (mm)", default=1230.0) / 1000.0
        sr_tol = self._input_float("SR 公差 (mm)", default=30.0) / 1000.0
        sr_fit = (sr_nominal + sr_tol)  # 校核用上限 (worst-case)

        # ─── 左右镜各自提取 ────────────────────────────────
        def extract_one_mirror(side: str) -> dict:
            print("\n" + "-" * 40)
            print(f"三、{side} 外后视镜")
            print("-" * 40)

            outline = self.extract_outline_points(side)
            if outline is None:
                print(f"  ⚠️ {side} 轮廓未提取, 跳过此镜")
                return {}

            print(f"\n  {side} 转向器轴线 (3 点: 原点 + Y向 + Z向)")
            p1 = self.extract_point(f"{side} 轴线原点 p1", context=f"{side}_p1")
            ay = self.extract_point(f"{side} Y向 100mm 点", context=f"{side}_axis_y")
            az = self.extract_point(f"{side} Z向 100mm 点", context=f"{side}_axis_z")

            # 供应商球心 (可选, 交叉校核用)
            sc = None
            if self._ask_yes_no(f"提取 {side} 供应商球心? (可选, 用于交叉校核)", False):
                sc_pt = self.extract_point(f"{side} 供应商球心", context=f"{side}_sphere_center")
                if sc_pt is not None:
                    sc = sc_pt.tolist()

            m = {
                "sr_nominal": round(sr_nominal, 6),
                "sr_tolerance": round(sr_tol, 6),
                "sr_fit": round(sr_fit, 6),
                "radius": round(sr_fit, 6),
                "outline_raw": outline,
            }
            if p1 is not None:
                m["turret_axis_p1"] = p1.tolist()
            if ay is not None:
                m["axis_y_point"] = ay.tolist()
            if az is not None:
                m["axis_z_point"] = az.tolist()
            if sc is not None:
                m["supplier_sphere_center"] = sc
            # rotation_axis_dir 由 axis_y_point - p1 推导
            if p1 is not None and ay is not None:
                import numpy as _np
                d = _np.array(ay) - _np.array(p1)
                n = _np.linalg.norm(d)
                if n > 1e-9:
                    m["rotation_axis_dir"] = (d / n).tolist()
            return m

        left_mirror = extract_one_mirror("左")
        right_mirror = extract_one_mirror("右")

        # ─── 构建 config ───────────────────────────────────
        config = {
            "vehicle": {"name": cfg.get("vehicle", {}).get("name", "TBD")},
            "driver": {
                "eye_center": eye_m,
                "interpupillary_distance": 0.065,
                "eye_left_raw": [eye_m[0], eye_m[1] - 0.0325, eye_m[2]],
                "eye_right_raw": [eye_m[0], eye_m[1] + 0.0325, eye_m[2]],
            },
            "ground": {
                "front_mid": gf.tolist() if gf is not None else [-1.942, 0, -0.389],
                "rear_mid": gr.tolist() if gr is not None else [4.868, 0, -0.405],
            },
            "door_panel": {
                "door_outer_Y_left": door_l_y,
                "door_outer_Y_right": door_r_y,
            },
            "regulation": {
                "standard": "GB 15084",
                "mirror_class": "III",
                "width_near": 1.0,
                "width_far": 4.0,
                "dist_near": 4.0,
                "dist_far": 20.0,
                "margin_mm": 3.0,
                "adjust_deg": 3.0,
            },
        }
        if left_mirror:
            config["exterior_mirror_left"] = left_mirror
        if right_mirror:
            config["exterior_mirror_right"] = right_mirror

        name = input("\n车型名称 (用于文件名, 留空用 'exterior-3de-read'): ").strip()
        if name:
            config["vehicle"]["name"] = name

        return config

    # ─── 保存 ────────────────────────────────────────────

    def save_yaml(self, config: dict, path: str):
        """保存配置 (按扩展名: .json 用 json, 否则 YAML)

        Args:
            config: 配置字典
            path: 输出文件路径
        """
        import json as _json
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)

        with open(path, "w", encoding="utf-8") as f:
            if path.lower().endswith(".json"):
                _json.dump(config, f, ensure_ascii=False, indent=2)
            else:
                f.write("# 自动生成 — CATIA COM 提取\n")
                f.write(f"# 坐标系: 整车坐标系 (X+后方, Y+右侧, Z+上方)\n")
                f.write(f"# 单位: m\n\n")
                yaml.dump(config, f, default_flow_style=False, allow_unicode=True)

        print(f"\n→ 已保存: {path}")
        print(f"→ 运行校核: python main.py --config {path}")

    # ─── 辅助 ────────────────────────────────────────────

    def extract_corners(self, label: str, n: int = 4,
                        labels: Optional[List[str]] = None) -> Optional[list]:
        """交互式提取 n 个角点

        Args:
            label: 角点名 (用于提示/日志)
            n: 角点数 (后挡风 7 角 / 镜面 4 角)
            labels: 可选, 每个角点的自定义标签 (如 ["TL","TR","BL","BR"])

        Returns:
            [[x, y, z], ...] m, 或 None (中途取消)
        """
        corners = []
        for i in range(n):
            prompt = f"{label} {labels[i]}" if labels else f"{label} 角{i+1}/{n}"
            p = self.extract_point(prompt, context=label)
            if p is None:
                return None
            corners.append(p.tolist())
        return corners

    @staticmethod
    def derive_mirror_dims(corners: list):
        """从镜面 4 角 [TL, TR, BL, BR] (m, 整车坐标) 推 width/height/yaw/pitch

        - width  = 左右角距均值 (TR-TL, BR-BL)
        - height = 上下角距均值 (BL-TL, BR-TR)
        - yaw/pitch = 4 角平面法线反推 (与引擎 Rz(yaw)@Ry(pitch)@[1,0,0] 一致)

        Returns:
            (width_m, height_m, yaw_deg, pitch_deg)
        """
        TL, TR, BL, BR = [np.array(c, dtype=float) for c in corners]
        width = (np.linalg.norm(TR - TL) + np.linalg.norm(BR - BL)) / 2.0
        height = (np.linalg.norm(BL - TL) + np.linalg.norm(BR - TR)) / 2.0
        pts = np.array([TL, TR, BL, BR])
        _, _, vh = np.linalg.svd(pts - pts.mean(axis=0))
        n = vh[-1]
        n = n / np.linalg.norm(n)
        if n[0] < 0:
            n = -n   # 朝 +X (车尾), 与引擎零位法线 [1,0,0] 一致
        yaw = math.atan2(n[1], n[0])
        pitch = -math.asin(max(-1.0, min(1.0, n[2])))
        # 转 Python float, 避免 yaml.dump 写成 numpy 标签 (safe_load 解析不了)
        return float(width), float(height), math.degrees(yaw), math.degrees(pitch)

    @staticmethod
    def _ask_yes_no(prompt: str, default_yes: bool = True) -> bool:
        """是/否询问 (回车取默认)"""
        hint = "[Y/n]" if default_yes else "[y/N]"
        while True:
            raw = input(f"  {prompt} {hint}: ").strip().lower()
            if not raw:
                return default_yes
            if raw in ("y", "yes"):
                return True
            if raw in ("n", "no"):
                return False
            print("  请输入 y/n")

    @staticmethod
    def _input_float(prompt: str, default: float = 0.0) -> float:
        """读取浮点输入"""
        while True:
            raw = input(f"  {prompt} [{default:.3f}]: ").strip()
            if not raw:
                return default
            try:
                return float(raw)
            except ValueError:
                print("  请输入数字")


# ─── CLI 入口 ───────────────────────────────────────────────

def main():
    import argparse

    parser = argparse.ArgumentParser(
        description="CATIA COM 参数提取 — 交互式提取内后视镜校核参数",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
示例:
  python -m mirror_fov.catia_extract
  python -m mirror_fov.catia_extract --output data/vehicles/new_car.yaml
        """
    )
    parser.add_argument("--output", "-o",
                        default="data/vehicles/extracted.json",
                        help="输出文件路径 (默认 .json, 也支持 .yaml)")
    parser.add_argument("--config", "-c",
                        help="已有配置文件 (用于预填默认值)")
    parser.add_argument("--mode", "-m",
                        choices=["inner", "exterior", "step-curve"],
                        default="inner",
                        help="提取模式: inner=内后视镜(默认, COM), exterior=外后视镜(COM), "
                             "step-curve=从 STEP 文件采样曲线(不连 COM)")
    parser.add_argument("--step-file",
                        help="step-curve 模式: STEP 文件路径")
    parser.add_argument("--curve-ids",
                        help="step-curve 模式: 曲线实体 ID 逗号分隔 (拼 outline)")
    parser.add_argument("--n", type=int, default=20,
                        help="step-curve 模式: 每条曲线采样点数 (默认 20)")
    args = parser.parse_args()

    # step-curve 模式: 不连 COM, 直接调 step_curve_sampler
    if args.mode == "step-curve":
        if not args.step_file:
            print("错误: step-curve 模式需要 --step-file <STEP 文件路径>")
            print("用法: python -m mirror_fov.catia_extract -m step-curve --step-file car.stp "
                  "--curve-ids 270368,174205 --n 20 --output outline.json")
            sys.exit(1)
        if not args.curve_ids:
            print("错误: step-curve 模式需要 --curve-ids <ID,ID,...> (曲线实体 ID)")
            print("先用 --curve-ids 0 (或去掉该参数) 列出所有曲线, 再选边界曲线 ID")
            sys.exit(1)
        # step_curve_sampler 在 python/ 根目录, catia_extract 在 mirror_fov/
        import os, sys as _sys
        _sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        import step_curve_sampler as scs
        ids = [int(x.strip()) for x in args.curve_ids.split(",") if x.strip()]
        scs.sample_outline_to_json(args.step_file, ids, args.n, args.output)
        return

    # 加载已有配置
    existing = None
    if args.config:
        with open(args.config, encoding="utf-8") as f:
            existing = yaml.safe_load(f)

    ext = CATIAExtractor()
    try:
        ext.connect()
        if args.mode == "exterior":
            result = ext.extract_all_exterior(existing_config=existing)
        else:
            result = ext.extract_all(existing_config=existing)
        ext.save_yaml(result, args.output)
    except ConnectionError as e:
        print(f"\n连接失败: {e}")
        print("请确认 3DEXPERIENCE 已启动并登录。")
    except KeyboardInterrupt:
        print("\n用户中断")
    finally:
        ext.disconnect()


if __name__ == "__main__":
    main()
