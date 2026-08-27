---
name: fc-feasibility-analyzer
description: |-
  FC 可行性分析 Skill — 灯具领域 FC 问题智能分析与 VIIM 工单提报。
  一句话描述现象 → AI 自动抽取字段 + 匹配历史案例 + 生成可行性分析报告与工程师建议 → 三栏智能核对 → 一键提交 VIIM（含附件）。
version: 0.3.2
status: ✅ 可用 · 持续迭代
owner: 张东杨
domain: 灯具（前灯/尾灯/雾灯/转向灯/牌照灯等）
---

# FC 可行性分析 Skill（灯具）

## 功能

1. **实体抽取**：一句话 → 24 字段结构化（纯规则；配置 LLM 后增强，未配置自动降级）；关键词字典 v2.1.2（942 条，6 大维度：区域/零件/故障/触发/法规/严重度）
2. **历史案例检索**：TF-IDF + 八维加权打分（症状/零件/区域/条件/关系/光学/法规/文本覆盖）+ 注意力机制；VIIM 实时与本地 116 条案例库**双路检索**，各按本路上限归一化到 0~1 后按分数合并去重（吻合度不超 100%，breakdown 分项和=总分）；本地案例带真实 VIIM 链接（url），无链接的点击弹本地详情；patterns 根因模板按 area+problem_type 匹配，三级降级（patterns→关键词聚合→root_cause 聚合）
3. **可行性分析报告**：根因聚类 / 工程修改方向（动词归类）/ 量化数值线索 / 一句话总结
4. **工程师建议**：规则生成四块（根因带级别 / 方向带例句 / 边界带范围来源 / 操作建议分档话术），永不空白
5. **三栏智能核对页**：左 AI 字段表单（下拉/日期/置信度/责任人/附件上传）+ 中推荐方案案例流（采纳为对策）+ 右工程师建议；改动字段橙色高亮计数
6. **VIIM 建单**：核对 → 确认提交（附件随单上传）；draft 草稿库可删可存
7. **鉴权图片代理**：VIIM 附件 / 飞书云盘图服务端代理（防 SSRF，限同源）
8. **问题预警与跟踪**：新工单通知 / S 级紧急 / 截期催办 / 趋势预警 / 根因预警
9. **工单分析**：状态清点 / 时长排行 / 6 周趋势 / 晨会五分类推送（🔴🟠🔵🟢）
10. **反馈学习**：用户纠正 → 自动更新关键词库 / 案例矩阵 / patterns；Web 与 CLI 共用单一反馈存储

## 使用方式

### Web UI（推荐）
```bash
pip install flask jieba
# 可选：cp .env.example .env 填写 FEISHU_APP_ID/SECRET（问题图代理）、FLASK_SECRET_KEY（固定 session）、TOKEN_ENCRYPTION_KEY（Token 加密）
python webapp/main.py --port 8080
# 首次使用在「账号」页设置 VIIM Token
```

页面：
- **导引页** `/landing` — 车灯视频背景 + 玻璃入口卡片（免登录）
- **问一下** `/` — 居中舞台输入 → 两栏报告（推荐方案 + 工程师建议）
- **提 FC 工单** `/new` — 「智能核对 →」进入三栏核对页；或生成草稿
- **智能核对** `/review` — POST 描述进入；字段核对/责任人/附件/确认提交 VIIM
- **FC 工作台** `/history` — 统计卡 + 工具条 + 分页列表 + 草稿删除
- **提醒** `/reminders` · **反馈学习** `/feedback` · **账号** `/account`

### 完整流水线（命令行）
```bash
python scripts/fc_submit.py report "前灯起雾，洗车后灯罩内凝露"
python scripts/fc_submit.py dryrun "前灯起雾"
python scripts/fc_submit.py submit "前灯起雾" --token YOUR_VIIM_TOKEN --confirm
```

### 单步调用
```bash
python scripts/lighting_extractor.py "尾灯色差" --json
python scripts/lighting_search.py "前灯起雾" --area EXT-Front End --top 10 --json
python scripts/viim_analytics.py --push        # 晨会五分类推送
python scripts/viim_analytics.py --viim        # VIIM 实时优先
```

## 反馈学习

### 流程
1. 用户分析后收集纠正 → 存入 `database/feedback.json`（Web/CLI 共用）
2. 积累 ≥3 条 → `feedback.py learn` 批量学习
3. 自动更新：关键词库 / 严重度规则 / 案例矩阵 / patterns

### 命令
```bash
python scripts/feedback.py stats
python scripts/feedback.py learn --min 3
python scripts/feedback.py learn --min 3 --dry-run
python scripts/fc_submit.py collect "前灯起雾" '{"severity": "A", "area": "EXT-Front End"}'
```

### 学习规则
| 纠正类型 | 更新目标 | 触发条件 |
|----------|----------|----------|
| 区域纠正 | lighting_keywords.json areas | ≥3 条同类纠正 |
| 严重度纠正 | lighting_keywords.json severity | ≥3 条同类纠正 |
| 案例补充 | lighting_issues.json | 有 VIIM 工单号 |
| 根因补充 | lighting_patterns.json | 用户提供根因 |

### 准确率追踪
- 每次反馈自动计算字段准确率；高频错误 Top-10；近期趋势（最近 20 条）；学习运行次数

## 目录结构

```
fc-feasibility-analyzer/
├── SKILL.md / README.md
├── .env.example / .gitignore
├── database/
│   ├── lighting_keywords.json        ← 关键词字典 v2.1.2（942 条，6 大维度）
│   ├── lighting_issues.json          ← 116 条历史工单
│   ├── lighting_patterns.json        ← 28 个根因模板
│   ├── feedback.json                 ← 反馈记录（单一存储）
│   └── learning_log.json             ← 学习日志
├── webapp/
│   ├── main.py                       ← Flask 入口（页面+核心API）
│   ├── infra.py                      ← 路径/JSON库/会话Token/.env
│   ├── bp_proxy.py                   ← 上传与鉴权图片代理
│   ├── bp_reminders.py               ← 提醒 CRUD
│   ├── viim_search.py                ← VIIM 实时检索
│   ├── static/style.css              ← Aurora Glass 设计系统
│   └── templates/                    ← 13 个在用模板
├── scripts/
│   ├── lighting_extractor.py / lighting_search.py / lighting_analyzer.py
│   ├── viim_client.py                ← VIIM 客户端（唯一副本）
│   ├── viim_analytics.py             ← 工单分析/晨会推送
│   ├── fc_submit.py / alerts.py / feedback.py / import_from_bitable.py
├── tests/test_pipeline.py            ← 单元测试（9 用例，缺依赖自动跳过）
├── references/                       ← 字段规范/VIIM映射/同义词等 6 个 .md
```

## 数据依赖

| 文件 | 说明 | 状态 |
|------|------|------|
| lighting_keywords.json | 灯具关键词字典 v2.1.2（942 条）：区域 6 类、零件 5 类、故障 6 类（含电子/工艺）、触发 5 类（含制造）、法规+测试、严重度 4 级、因果关系词 | ✅ v2.1.2（2026-08-14 全量补全） |
| lighting_issues.json | 灯具历史工单（案例检索数据源） | ✅ 116 条 |
| lighting_patterns.json | 灯具根因模板（按区域+问题类型聚合） | ✅ 28 个模板 · 81 条记录 |
| feedback.json | 反馈记录（单一存储，≥3 条自动学习回写字典） | ✅ 自动生成 |
| learning_log.json | 学习日志 | ✅ 自动生成 |

## 开发进度

- [x] Phase 1: 关键词字典 / 实体抽取 / 案例检索 / 测试验证
- [x] Phase 2: 报告生成 + 工程师建议
- [x] Phase 3: VIIM 集成（建单/附件/鉴权代理）
- [x] Phase 4: 预警追踪 + 工单分析（晨会推送）
- [x] Phase 5: 反馈学习
- [x] Phase 6: Web 三栏核对页 / Aurora Glass 主题 / 分页 / 草稿删除
- [x] Phase 7: 工程化（blueprint 拆分 / tests / .gitignore / logging）
- [x] Phase 8: 关键词字典全量补全（v1.0→v2.1.2，260→942 条：+电子故障/工艺缺陷/密封件/制造触发/CHMSL/角灯/因果关系词；抽取器适配新区域映射）
- [x] Phase 9: 双路检索文档化 + 本地案例 VIIM 链接/无链接弹本地详情 + breakdown 归一化（分项和=总分）
