"""
mirro-fov 3DE 读取子包 (内嵌, 自包含)
=====================================
本 JS 项目仅内嵌 CATIA/3DEXPERIENCE COM 参数提取所需的两个模块:
    catia_conn     — COM 连接 + Measurable 选点/读坐标
    catia_extract  — 交互式提取流程 (内镜 / 外镜 --mode exterior)

内镜/外镜校核引擎的完整 Python 实现在外部 Mirro-fov 项目; 本 JS 项目
不依赖之 (JS engine/ 已是主版本)。JS 端通过 spawn
`python -m mirror_fov.catia_extract` 代理调用 3DE 读取, 故本包只需能导入
catia_conn / catia_extract 两个子模块即可, 不 import 完整引擎。

子模块间用相对导入 (catia_extract `from .catia_conn import ...`), 无需
在此重导出。如需便捷访问:
    from mirror_fov.catia_conn import CATIAConnection
    from mirror_fov.catia_extract import CATIAExtractor
"""
