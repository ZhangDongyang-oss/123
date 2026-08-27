# FC Feasibility Analyzer — 灯具领域专用

> **说明**：本仓库为脱敏演示版本——内部工单系统地址/凭据/真实案例数据均已移除或替换为占位内容；
> LLM 增强抽取默认走本地 [Ollama](https://ollama.com)（如 `qwen2.5:7b`），未启动时自动降级为纯规则抽取。
> 快速开始：`pip install -r requirements.txt && python webapp/main.py`；Node 模块版见 `modules/smart/fc-analyzer/`。

> FC（工程变更）可行性分析工具。纯规则驱动、离线可跑；配置 LLM 后可增强抽取。
> 一句话描述 → 字段抽取 + 历史案例检索 + 可行性报告 + 工程师建议 → 三栏智能核对 → 一键提交 VIIM（含附件）。

## 🏗️ 架构

```
fc-feasibility-analyzer/
├── webapp/                    # Flask Web 应用
│   ├── main.py                # 入口 + 页面/核心 API（双路合并检索/草稿/提交/反馈管理）
│   ├── infra.py               # 路径常量 / JSON 存储 / 会话与 Token / .env 加载
│   ├── bp_proxy.py            # Blueprint：图片上传、飞书图代理、VIIM 附件代理
│   ├── bp_reminders.py        # Blueprint：提醒增删改查
│   ├── viim_search.py         # VIIM 实时检索：JQL + 四维打分
│   ├── static/                # style.css（Aurora Glass 设计系统）+ login-gate.js
│   └── templates/             # 13 个在用 Jinja2 模板
├── scripts/                   # 纯规则引擎（离线可跑）
│   ├── lighting_extractor.py  # 一句话 → 24 字段抽取
│   ├── lighting_search.py     # 本地检索：TF-IDF + 八维加分 + 注意力 + 质量门
│   ├── lighting_analyzer.py   # 报告 + 根因聚类 + 动词归类 + 工程师建议
│   ├── viim_client.py         # VIIM Jira REST 客户端（唯一副本）
│   ├── viim_analytics.py      # 状态清点 / 时长排行 / 趋势 / 晨会五分类推送
│   ├── report_checker.py      # 报告模板检查：字段完整性 + 流程状态（VIIM 实时优先 + 本地兜底）
│   ├── fc_submit.py           # CLI 全流程编排
│   ├── alerts.py              # 预警系统 + 管理看板
│   ├── feedback.py            # 反馈学习
│   └── import_from_bitable.py # 飞书多维表格导入案例库
├── database/                  # 知识库 + 运行时数据
├── references/                # 字段规范 / VIIM 映射 / 同义词等 6 个 .md
├── tests/test_pipeline.py     # 单元测试（缺依赖自动跳过）
└── SKILL.md                   # Claude 技能描述
```

## 🔍 检索逻辑（双路合并）

一次分析跑两路检索，分数都归一化到 0~1 后合并去重取 top 6：

**本地案例库**（`scripts/lighting_search.py`，必跑）— jieba 分词 → TF-IDF 余弦相似度 → 八维特征加分 → 归一化：

| 维度 | 权重 | 维度 | 权重 |
|---|---|---|---|
| 文本 TF-IDF | 0.20 | 结构关系 | 0.10 |
| 症状 | 0.35 | 光学 | 0.15 |
| 零件 | 0.25 | 法规 | 0.08 |
| 区域 | 0.10 | 条件 | 0.05 |

- 轻量注意力：按 query 各维度命中词数动态调权（关系 +0.25/个、法规 +0.30/个、光学 +0.20/个…），短句（≤6 词）×1.08、长句（≥18 词）×0.95
- 质量门：只召回人工撰写的方案（`QUALITY_WEIGHT={"human": 1.0}`）
- 归一化除以理论上限 `max_bonus`，防止吻合度显示超 100%；breakdown 明细同步除以 `max_bonus`，分项和 = 总分
- 归一化后包含关系（问题一模一样）→ 直接判 95%

**VIIM 实时**（`webapp/viim_search.py`，有 Token 时跑）— 同义词/区域词提取 → JQL（取最长 3 个中文词 `summary ~ "词"` OR）→ 四维打分：症状 0.30 + 零件 0.25 + 区域 0.15 + 字符覆盖度 0.30；近似精确 → 95%。

**合并**（`main.py:_merge_hits`）— 按 score 降序、归一化文本去重，取 top 6。分档阈值（`lighting_analyzer.build_solution_backfill`）：≥0.4 直引方案 / 0.2~0.4 参考 / <0.2 待写，只回填 human 方案并带工单 key 出处。

点击行为：命中带真实 VIIM 链接（`url`）→ 跳 VIIM 工单；本地案例无链接（74 条，飞书总表未登记）→ 弹本地详情（`openLocalDetail`，展示方案/根因/负责人/关键词/图片）。

## 🚀 快速启动

```bash
# 安装依赖
pip install flask jieba

# 可选：配置凭据（复制 .env.example 为 .env 后填写）
#   FEISHU_APP_ID / FEISHU_APP_SECRET   → 本地案例的问题图代理
#   VIIM_URL / VIIM_API_TOKEN           → 也可放 .viim.env

# 启动（webapp 会自动把 scripts 挂进 sys.path）
python webapp/main.py --port 8080
# 浏览器打开 http://localhost:8080（首次需在「账号」页设置 VIIM Token）
```

> 同事首次部署见 [ONBOARDING.md](ONBOARDING.md)（首用配置清单，约 5 分钟）。

## 📄 页面

| 路径 | 功能 |
|------|------|
| `/landing` | **导引页**：车灯视频背景 + 玻璃入口卡片（免登录） |
| `/` | **问一下**：居中舞台输入 → 两栏报告（推荐方案 + 工程师建议） |
| `/new` | **提 FC 工单**：描述 → 「智能核对」进入三栏核对页，或生成草稿 |
| `/review` | **智能核对**（POST 描述进入）：左 AI 字段表单/置信度/附件，中推荐方案案例流，右工程师建议；底部确认提交 |
| `/history` | **FC 工作台**：统计卡 + 报告状态检查（按模板查缺项/状态，可筛「我负责的」「超期未闭」）+ 搜索/筛选工具条 + 分页列表 + 草稿删除 |
| `/reminders` | 问题提醒与跟踪 |
| `/feedback` | 反馈学习 + 各字段准确率 |
| `/account` | VIIM Token 管理 |

## 📡 API 路由（48 个）

| 分组 | 路由 |
|------|------|
| 分析 | `POST /api/analyze`、`POST /api/dryrun`、`POST /api/review` |
| 报告检查 | `GET /api/report-check?filter=all\|mine\|overdue`（按模板查字段完整性 + 流程状态） |
| 建单 | `POST /api/submit`（支持附件随单上传）、`POST /api/draft`、`POST /api/draft/<id>/submit`（草稿直提）、`POST /api/save-draft`、`POST /api/load-draft` |
| 历史 | `GET /api/history/list?page=N`、`POST /api/history/delete`、`GET /api/submissions/list`、`POST /api/submissions` |
| VIIM | `GET /api/viim-detail/<key>`、`GET /api/viim-attachment`（鉴权代理）、`GET /api/feishu-image/<token>`（鉴权代理） |
| 提醒 | `POST /api/reminders`、`GET /api/reminders/list`、`POST /api/reminders/<rid>/done`、`POST /api/reminders/<rid>/delete` |
| 反馈 | `POST /api/feedback`、`POST /api/learn`、`POST /api/stats`、`GET /api/feedback/cases`、`POST /api/feedback/cases/delete`、`GET /api/feedback/keywords`、`POST /api/feedback/keywords/delete`（学习案例/关键词管理） |
| 账号 | `GET/POST /api/account`、`POST /api/set-token`、`POST /api/clear-token` |
| 预警 | `POST /api/alerts`、`POST /api/alerts/reminders`、`POST /api/dashboard`、`POST /api/tracking`、`POST /api/track` |
| 上传 | `POST /api/upload-image`、`GET /api/uploads/<filename>` |

## 🔧 环境变量（.env 自动加载，不覆盖已有）

| 变量 | 说明 |
|------|------|
| `FLASK_SECRET_KEY` | 固定 Flask session 密钥（不设置则每次启动随机生成） |
| `TOKEN_ENCRYPTION_KEY` | Token 落盘加密（Fernet；不设置则明文存储） |
| `FEISHU_APP_ID` / `FEISHU_APP_SECRET` | 本地案例问题图的飞书代理 |
| `VIIM_URL` / `VIIM_API_TOKEN` | VIIM 地址与离线 Token（也可 .viim.env） |
| `LLM_API_URL` / `LLM_API_KEY` / `LLM_MODEL` | 预留：LLM 增强抽取（当前版本纯规则，暂未启用） |

## 🧪 测试与分析

```bash
python -m unittest discover -s tests -v      # 9 用例：抽取/检索/breakdown求和/报告/建议/置信度/payload/分页/核对
python scripts/viim_analytics.py             # 状态清点 / 时长 TOP5 / 6 周趋势
python scripts/viim_analytics.py --push      # 晨会五分类推送（🔴🟠🔵🟢）
python scripts/viim_analytics.py --viim      # VIIM 实时优先，本地兜底
```

## 📊 数据文件

| 文件 | 说明 |
|------|------|
| `database/lighting_issues.json` | 116 条灯具历史工单（2026-08-18 按飞书总表重建并按 DIR 去重合并，含问题/整改图；与 VIIM 重复条目以 VIIM 为准；旧库备份 `.bak-20260818`） |
| `database/lighting_keywords.json` | 灯具关键词字典 v2.1.2 — 942 条，6 大维度（区域 6 类 / 零件 5 类 / 故障 6 类 / 触发 5 类 / 法规+测试 / 严重度 4 级） |
| `database/lighting_patterns.json` | 28 个根因模板（按区域+问题类型聚合，含常见根因/方案/经验教训） |
| `database/report_templates.json` | 报告模板（必含字段清单，`report_checker` 按此查报告完整性） |
| `database/feedback.json` | 反馈记录（Web 与 CLI 共用单一存储） |
| `database/learning_log.json` | 学习日志 |
| `webapp/database/` | 运行时：草稿 / 提交记录 / 会话 Token / 提醒 |

## 🎨 设计系统

Aurora Glass 玻璃拟态主题：
- 固定极光渐变氛围背景（亮色瓷白极光 / 暗色深空星雾），玻璃表面 backdrop-filter 折射
- 半透明磨砂卡片 + 高光描边 + 层叠柔影
- 按钮八级层次：渐变 CTA / 深色胶囊 / 蓝实心 / 绿成功 / 描边 / 玻璃次级 / 幽灵 / 危险
- 三栏核对布局（1680px 画布，窄屏自动折栏）、响应式顶栏
- 深浅色一键切换（记忆偏好）
