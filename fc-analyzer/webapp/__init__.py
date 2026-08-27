"""FC Feasibility Analyzer — 灯具领域 FC 可行性分析 Web 应用。

模块概述:
    main          — Flask 入口：页面路由 + 核心 API（分析/核对/建单/历史/反馈）
    infra         — 路径常量 / JSON 存储 / 会话与 VIIM Token / .env 加载
    bp_proxy      — Blueprint：图片上传暂存、飞书云盘图代理、VIIM 附件鉴权代理
    bp_reminders  — Blueprint：问题提醒增删改查
    viim_search   — VIIM 实时检索与匹配度打分

核心引擎在 scripts/（lighting_extractor / lighting_search / lighting_analyzer /
viim_client / feedback / alerts / viim_analytics / fc_submit）。
旧 FC-copilot-4 移植残留模块已归档至根目录 archive/。
"""
