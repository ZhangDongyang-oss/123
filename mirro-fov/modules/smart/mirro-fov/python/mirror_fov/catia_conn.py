"""
CATIA / 3DEXPERIENCE COM 连接管理
====================================

基于 Measurable API 的坐标读取方案 (路线 R1):
  - 装配层级直接读整车坐标，无需进 Part 编辑模式
  - 不改点类型、不命名、不建标记点
  - 正确调用: spa.GetMeasurable(obj, type_id).GetPoint()

用法::

    from mirror_fov.catia_conn import CATIAConnection

    conn = CATIAConnection()
    conn.connect()

    # 选点读坐标
    coords_mm = conn.select_point("选球铰中心")  # (x, y, z) mm
    coords_m = coords_mm / 1000  # → m

    conn.disconnect()

依赖: pywin32 (仅 Windows)
"""

import logging
from typing import Optional, Tuple

import numpy as np

logger = logging.getLogger(__name__)

# ─── 常量 ────────────────────────────────────────────────────

MM_TO_M = 0.001
M_TO_MM = 1000.0

# MeasurableService type_id 映射
MEASURABLE_AXIS_SYSTEM = 0
MEASURABLE_BETWEEN = 1
MEASURABLE_CIRCLE = 2
MEASURABLE_CONE = 3
MEASURABLE_CURVE = 4      # GetLength
MEASURABLE_CYLINDER = 5
MEASURABLE_LINE = 6
MEASURABLE_PLANE = 7      # GetNormal, GetArea
MEASURABLE_POINT = 8      # GetPoint
MEASURABLE_SPHERE = 9
MEASURABLE_SURFACE = 10   # GetArea, GetNormal
MEASURABLE_VOLUME = 11


class ConnectionError(Exception):
    """COM 连接失败"""
    pass


class CoordinateError(Exception):
    """坐标读取或校验失败"""
    pass


# ─── 连接管理 ────────────────────────────────────────────────

class CATIAConnection:
    """3DEXPERIENCE COM 连接管理 (基于 Measurable API)

    属性:
        app: CATIA Application COM 对象
        spa: MeasurableService 对象
        version: 版本标识字符串
    """

    def __init__(self):
        self.app = None
        self.spa = None
        self.version = None

    @staticmethod
    def is_available() -> bool:
        """检测 COM 环境是否可用"""
        try:
            import win32com.client
            win32com.client.dynamic.Dispatch("CATIA.Application")
            return True
        except Exception:
            return False

    def connect(self) -> bool:
        """连接到已运行的 3DEXPERIENCE

        Returns:
            True = 连接成功

        Raises:
            ConnectionError: pywin32 未安装或 3DE 未运行
        """
        try:
            import win32com.client
        except ImportError:
            raise ConnectionError("pywin32 未安装。请运行: pip install pywin32")

        try:
            self.app = win32com.client.dynamic.Dispatch("CATIA.Application")
        except Exception:
            raise ConnectionError(
                "未找到运行中的 3DEXPERIENCE 实例。\n"
                "请确认: 3DE 客户端已启动并登录。"
            )

        # 获取 MeasurableService
        try:
            self.spa = self.app.GetSessionService("MeasurableService")
        except Exception as e:
            raise ConnectionError(f"MeasurableService 获取失败: {e}")

        # 检测版本
        try:
            self.version = self.app.Caption
        except Exception:
            self.version = "Unknown"

        logger.info(f"已连接: {self.version}")
        return True

    def disconnect(self):
        """断开连接"""
        self.app = None
        self.spa = None
        self.version = None
        logger.info("已断开连接")

    # ─── 查询接口 ─────────────────────────────────────────

    def get_version(self) -> str:
        if self.app is None:
            raise ConnectionError("未连接")
        return self.version or "Unknown"

    def get_editor(self):
        if self.app is None:
            raise ConnectionError("未连接")
        return self.app.ActiveEditor

    def get_selection(self):
        return self.get_editor().Selection

    # ─── Measurable 读取 ──────────────────────────────────

    def get_measurable(self, obj, type_id: int):
        """获取 Measurable 对象

        Args:
            obj: CATIA COM 对象 (选中的点/边/面)
            type_id: 几何类型 (MEASURABLE_POINT=8, MEASURABLE_CURVE=4, 等)

        Returns:
            Measurable COM 对象
        """
        if self.spa is None:
            raise ConnectionError("未连接")
        return self.spa.GetMeasurable(obj, type_id)

    def read_point(self, obj) -> Tuple[float, float, float]:
        """读取点坐标

        Args:
            obj: CATIA 点对象 (从 Selection.Item(1).Value 获取)

        Returns:
            (x, y, z) 单位 mm
        """
        meas = self.get_measurable(obj, MEASURABLE_POINT)
        coords = meas.GetPoint()
        return (float(coords[0]), float(coords[1]), float(coords[2]))

    def read_length(self, obj) -> float:
        """读取边/曲线长度

        Args:
            obj: CATIA 边/曲线对象

        Returns:
            长度 mm
        """
        meas = self.get_measurable(obj, MEASURABLE_CURVE)
        return float(meas.GetLength())

    def read_area(self, obj) -> float:
        """读取面面积

        Args:
            obj: CATIA 面对象

        Returns:
            面积 m²
        """
        meas = self.get_measurable(obj, MEASURABLE_SURFACE)
        return float(meas.GetArea())

    def read_normal(self, obj) -> Tuple[float, float, float]:
        """读取面法线

        Args:
            obj: CATIA 面对象

        Returns:
            (nx, ny, nz) 法线向量
        """
        meas = self.get_measurable(obj, MEASURABLE_PLANE)
        normal = meas.GetNormal()
        return (float(normal[0]), float(normal[1]), float(normal[2]))

    # ─── 选点交互 ─────────────────────────────────────────

    def select_point(self, prompt: str = "请选择一个点") -> Optional[Tuple[float, float, float]]:
        """选点并读取坐标 (装配层级，整车坐标)

        Args:
            prompt: CATIA 选择框提示文字

        Returns:
            (x, y, z) mm，或 None (用户取消)
        """
        sel = self.get_selection()
        sel.Clear()

        try:
            status = sel.SelectElement2(["Point"], prompt, False)
        except Exception as e:
            raise CoordinateError(f"选择失败: {e}")

        if status == "Cancel" or sel.Count == 0:
            sel.Clear()
            return None

        try:
            obj = sel.Item(1).Value
            coords = self.read_point(obj)
            sel.Clear()
            return coords
        except Exception as e:
            sel.Clear()
            raise CoordinateError(f"坐标读取失败: {e}")

    def select_edge(self, prompt: str = "请选择一条边") -> Optional[float]:
        """选边并读取长度

        Args:
            prompt: CATIA 选择框提示文字

        Returns:
            长度 mm，或 None (用户取消)
        """
        sel = self.get_selection()
        sel.Clear()

        try:
            status = sel.SelectElement2(["Reference"], prompt, False)
        except Exception as e:
            raise CoordinateError(f"选择失败: {e}")

        if status == "Cancel" or sel.Count == 0:
            sel.Clear()
            return None

        try:
            obj = sel.Item(1).Value
            length = self.read_length(obj)
            sel.Clear()
            return length
        except Exception as e:
            sel.Clear()
            raise CoordinateError(f"长度读取失败: {e}")

    def select_face(self, prompt: str = "请选择一个面") -> Optional[float]:
        """选面并读取面积

        Args:
            prompt: CATIA 选择框提示文字

        Returns:
            面积 m²，或 None (用户取消)
        """
        sel = self.get_selection()
        sel.Clear()

        try:
            status = sel.SelectElement2(["Reference"], prompt, False)
        except Exception as e:
            raise CoordinateError(f"选择失败: {e}")

        if status == "Cancel" or sel.Count == 0:
            sel.Clear()
            return None

        try:
            obj = sel.Item(1).Value
            area = self.read_area(obj)
            sel.Clear()
            return area
        except Exception as e:
            sel.Clear()
            raise CoordinateError(f"面积读取失败: {e}")

    # ─── 校验 ─────────────────────────────────────────────

    def validate_coords_mm(self, coords_mm: Tuple[float, float, float],
                           context: str = "") -> bool:
        """校验坐标是否在整车后视镜合理范围内

        Args:
            coords_mm: (x, y, z) mm
            context: 提示上下文

        Returns:
            True = 合理
        """
        x, y, z = coords_mm
        # 整车坐标系合理范围: 覆盖地面点(x~500, z~185)到后挡风/镜面(x~5900, z~1490)
        # 下限仍能挡住零件局部坐标(各轴 <200)
        reasonable = (200 <= x <= 7000 and
                      -2000 <= y <= 2000 and
                      100 <= z <= 3000)
        if not reasonable:
            prefix = f"[{context}] " if context else ""
            logger.warning(
                f"{prefix}坐标 ({x:.1f}, {y:.1f}, {z:.1f}) mm 超出合理范围。"
                f"请确认是在整车装配层级选择。"
            )
        return reasonable

    def match_known_point(self, coords_mm: Tuple[float, float, float],
                          known_points: dict,
                          tolerance_mm: float = 50.0) -> Optional[str]:
        """与已知坐标比对，返回最接近的点名

        Args:
            coords_mm: 读到的坐标 (x, y, z) mm
            known_points: {"name": [x, y, z] mm, ...}
            tolerance_mm: 容差 mm

        Returns:
            最接近的点名，或 None (超出容差)
        """
        best_name, best_dist = None, float('inf')
        for name, known in known_points.items():
            if not isinstance(known, (list, tuple)) or len(known) < 3:
                continue
            dist = ((coords_mm[0] - known[0])**2 +
                    (coords_mm[1] - known[1])**2 +
                    (coords_mm[2] - known[2])**2) ** 0.5
            if dist < best_dist:
                best_dist = dist
                best_name = name

        if best_dist <= tolerance_mm:
            logger.info(f"匹配 {best_name} (差 {best_dist:.3f} mm)")
            return best_name
        else:
            logger.warning(f"最接近 {best_name} 但差 {best_dist:.1f} mm (超出容差)")
            return None
