# FC 可行性分析（灯光）· 文件清单

> 每个文件的作用速查。2026-08-21 更新，共 56 个 active 文件（不含缓存/运行时日志）。

## 根目录（7）

| 文件 | 作用 |
|---|---|
| `README.md` | 项目说明：架构 / 页面 / 48 条 API / 环境变量 / 测试命令 |
| `SKILL.md` | Claude 技能定义（v0.3.0）：功能 / 用法 / 规则 / 开发进度 |
| `FILE-MAP.md` | 本文件：逐文件作用速查 |
| `usage-keynote.html` | 22 页演示 Deck：使用说明 + 规则设定（键盘/滚轮/触摸翻页，F 全屏） |
| `requirements.txt` | 依赖清单：flask + jieba |
| `.env.example` | 凭据模板：飞书 AppID/Secret、LLM、VIIM（复制为 `.env` 使用） |
| `.gitignore` | 排除凭据 / 缓存 / 日志 / 临时数据 |

## webapp/ — Flask 应用（24）

| 文件 | 作用 |
|---|---|
| `main.py` | 入口：页面路由 + 核心 API（分析/核对/建单/历史/反馈/报告检查，双路合并检索 `_merge_hits`），约 900 行 |
| `infra.py` | 基础设施：路径常量、JSON 原子存储、会话 Token、.env 加载 |
| `bp_proxy.py` | Blueprint：图片上传暂存、飞书云盘图代理、VIIM 附件鉴权代理（限同源防 SSRF） |
| `bp_reminders.py` | Blueprint：问题提醒增删改查（HTMX 片段渲染） |
| `viim_search.py` | VIIM 实时检索：JQL 构造 + 四维打分（症状0.30/零件0.25/区域0.15/字符覆盖0.30）+ 归一化包含=同源95% |
| `__init__.py` | 包标记 + 模块清单文档 |
| `static/style.css` | 全部样式：Aurora Glass 主题 + 布局层 + 三栏核对 + 吻合度明细悬浮层，约 4800 行 |
| `static/login-gate.js` | 登录门客户端：无 Token 弹遮罩引导设置 |
| `static/lighting-bg.mp4` | 导引页背景视频（车灯 teaser，循环静音播放） |
| `static/lighting-poster.png` | 视频首帧海报（加载前 / 系统减弱动态时显示） |
| `static/mi-logo.png` | 顶栏 Logo |
| `templates/base.html` | 布局骨架：顶栏导航 + 深浅色切换 + VIIM 详情弹窗 + 本地案例详情弹窗（openLocalDetail）+ 灯箱委托点击 |
| `templates/landing.html` | 导引页：视频背景 + 5 张玻璃入口卡（免登录） |
| `templates/index.html` | 问一下：居中舞台 + composer 输入 + 示例 chips |
| `templates/report.html` | 分析报告片段：左推荐方案（图/吻合度明细悬浮层）右工程师建议四块 |
| `templates/new.html` | 提工单：描述 + 车型/项目/区域/严重度下拉（车型/项目可输入+下拉） + 双栏流程指引 + 「智能核对」入口 |
| `templates/review.html` | 三栏核对页：字段表单/置信度/责任人/附件 + 案例流 + 建议 + 底部确认栏 |
| `templates/history.html` | 工作台：统计卡 + 报告状态检查（按模板查缺项/状态，可筛「我负责的」「超期未闭」）+ 搜索/筛选工具条 + 分页列表 + 草稿删除 |
| `templates/reminders.html` | 提醒页：单行添加表单 + 列表 |
| `templates/reminder_item.html` | 提醒行片段（HTMX 返回用） |
| `templates/feedback.html` | 反馈学习：双栏（提交表单 + 准确率/高频错误） |
| `templates/account.html` | 账号页：VIIM Token 设置/清除 |
| `templates/draft_detail.html` | 草稿详情页 |
| `templates/submissions.html` | 提交记录页 |
| `templates/viim_detail_modal.html` | VIIM 工单详情弹窗（字段/附件/评论） |

## scripts/ — 纯规则引擎（10）

| 文件 | 作用 |
|---|---|
| `lighting_extractor.py` | 一句话 → 24 字段抽取（词典 + 正则 + 车型/项目/CAS 识别，识别不出留空；严重度映射 VIIM 5 档） |
| `lighting_search.py` | 本地检索：TF-IDF + 八维加分 + 注意力 + 质量门（只信人写）+ breakdown 明细（分项和=总分）+ 返回 VIIM url + 归一化包含=同源95% |
| `lighting_analyzer.py` | 报告生成：根因三级优先、工程动词归类、数值边界、build_advice_context 工程师建议 |
| `viim_client.py` | VIIM Jira REST 客户端（唯一副本：建单/搜索/附件上传/用户名解析） |
| `feedback.py` | 反馈收集 + 准确率统计 + ≥3 条批量学习写回词典 |
| `alerts.py` | 预警五规则 + 管理看板 + 问题跟踪 |
| `fc_submit.py` | CLI 编排：report / dryrun / submit / track / alerts / dashboard |
| `viim_analytics.py` | 工单分析：状态清点 / 时长 TOP5 / 6 周趋势 / 晨会五分类推送 |
| `report_checker.py` | 报告模板检查：字段完整性 + 流程状态分类（VIIM 实时优先 + 本地兜底，支持 assignee/overdue 筛选） |
| `import_from_bitable.py` | 从飞书多维表格导入案例库的维护工具 |

## database/ — 知识与学习数据（6）

| 文件 | 作用 |
|---|---|
| `lighting_issues.json` | 116 条历史工单案例库（检索数据源，2026-08-18 按飞书总表重建） |
| `lighting_keywords.json` | 关键词字典 v2.1.2（942 条）：区域 6 类 / 零件 5 类 / 故障 6 类（含电子+工艺）/ 触发 5 类（含制造）/ 法规+测试 / 严重度 4 级 / 因果关系词；学习自动更新 |
| `lighting_patterns.json` | 28 个根因模板（区域+问题类型 → 沉淀根因） |
| `report_templates.json` | 报告模板（必含字段清单，report_checker 按此查完整性） |
| `feedback.json` | 反馈记录（Web 与 CLI 共用单一存储） |
| `learning_log.json` | 学习运行日志 |

## webapp/database/ — 运行时数据

| 文件 | 作用 |
|---|---|
| `drafts.json` | 草稿存储 |
| `session_tokens.json` | 会话 VIIM Token（30 天清理；不打包不入库） |
| （运行时自动建）`submissions.json` / `reminders.json` / `temp_uploads/` | 提交记录 / 提醒 / 上传暂存 |

## references/ — 人工参考文档（6）

| 文件 | 作用 |
|---|---|
| `field-spec.md` | 24 字段规范（取值/默认/必填） |
| `viim-field-mapping.md` | VIIM customfield 号映射 + 责任人策略（默认留空人工指派） |
| `synonyms.md` | 580+ 同义词表 |
| `semantic-rules.md` | 语义规则 |
| `ambiguity-rules.md` | 歧义消解规则 |
| `historical-patterns.md` | 历史问题模式（patterns 的素材源） |

## tests/（1）

| 文件 | 作用 |
|---|---|
| `test_pipeline.py` | 9 个单元测试：抽取 / 检索 / breakdown 求和≈总分 / 报告 / 置信度 / payload / 分页 / 核对上下文（缺依赖自动跳过） |

## 运行时生成（不入库）

| 位置 | 作用 |
|---|---|
| `logs/fc-web.log` | 滚动日志（1MB × 3 份） |
| `webapp/database/temp_uploads/` | 核对页上传的现场图暂存，提交后随单上传 VIIM |
