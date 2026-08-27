# Ruisearch

Ruisearch 是面向 Claude Code 的智能调研技能模块（Skill），基于 [Agent Reach](https://github.com/Panniantong/Agent-Reach) 构建。提供 **17 平台搜索、市场调研、技术分析、竞品追踪、专利检索、股票行情、文档格式化** 七位一体的自动化调研能力。

## 致谢

Ruisearch v3.0 融合了 [Agent Reach](https://github.com/Panniantong/Agent-Reach) 的 17 平台搜索架构（小红书、抖音、微博、推特、B站、V2EX、Reddit、LinkedIn、GitHub、YouTube 等），感谢 [@Panniantong](https://github.com/Panniantong) 的开源贡献。

Agent Reach 是一个出色的 AI Agent 互联网访问能力层项目（56.9k Stars，MIT License），负责工具的选型、安装、体检和路由。Ruisearch 在此基础上补充了调研报告流水线、专利检索、股票行情、多格式文档输出等产出能力。

> **引用声明**：`references/` 目录下的 search.md、social.md、web.md、video.md、career.md、dev.md 源自 Agent Reach v1.5.0（MIT License），README.md 中保留原作者信息。

## 核心能力

| 模块 | 能力 | 触发场景示例 |
|------|------|-------------|
| 17 平台搜索 | Exa、小红书、抖音、微博、推特、B站、V2EX、Reddit、LinkedIn、GitHub、YouTube 等 | "搜一下小红书XX""推特搜XX""B站搜XX" |
| 市场调研 | 规模、增速、竞争格局分析 | "中国储能市场规模 2025" |
| 技术调研 | 技术路线、量产进展、壁垒分析 | "固态电池量产进展" |
| 竞品分析 | 多维对比 + 专利矩阵 | "特斯拉 vs 小鹏 智驾方案对比" |
| 专利检索 | 专利详情、法律状态、同族 | "DMS 驾驶员监测 麦格纳 专利" |
| 股票行情 | A 股 / 港股实时数据 | "小米港股现在多少钱" |
| 文档格式化 | 飞书紧凑 / 标准 MD / Word 友好 | "转成 Word 格式""飞书排版" |

## 搜索架构

```
用户意图
    │
    ├─ Exa 语义搜索（首选，via mcporter）
    │   └─ 失败 → WebSearch（自动降级）
    │
    ├─ 社交媒体 → xhs / twitter / rdt / bili / douyin CLI
    ├─ 技术/竞品类 → 自动触发专利检索
    │   ├─ 专利号 → Google Patents 详情页
    │   └─ 关键词 → WebSearch site:patents.google.com
    │
    ├─ 股票 → 腾讯行情 API（零配置，无鉴权）
    ├─ 视频/播客 → yt-dlp / 小宇宙 transcribe
    └─ 深度分析 → Jina Reader 全文抓取
```

## 快速开始

```bash
git clone https://github.com/Gyepcrchance5/ruisearch.git ~/.claude/skills/ruisearch
```

安装后重启 Claude Code 会话即可生效。

### 环境搭建

Ruisearch 以 Exa 语义搜索为首选引擎。不配置也能用（降级到 WebSearch），但质量会下降。

**前置条件**：Node.js ≥ 18

```bash
npm install -g mcporter
mcporter config add exa --url https://mcp.exa.ai/mcp
mcporter auth exa
mcporter call 'exa.web_search_exa(query: "test", numResults: 1)'
```

### 可选平台 CLI

社交媒体平台需要额外安装对应 CLI：

```bash
pipx install xiaohongshu-cli    # 小红书
pipx install twitter-cli        # Twitter/X
pipx install rdt-cli            # Reddit
pipx install bilibili-cli       # B站
```

详见各 `references/*.md` 中的安装说明。

## 路由规则

| 优先级 | 场景 | 路由目标 |
|------|------|---------|
| 1 | 专利交底书撰写 / 权利要求起草 | patent-disclosure-forge |
| 2 | 调研报告 / 竞品分析 / 技术路线 | ruisearch research 模块 |
| 3 | 股票行情 / 基金查询 | ruisearch → 腾讯行情 API |
| 4 | 社交媒体搜索 | ruisearch → references/social.md |
| 5 | 通用搜索 / 事实查询 | ruisearch → Exa / WebSearch |

模糊场景默认走 ruisearch。

## 输出规范

| 维度 | 规则 |
|------|------|
| 文件命名 | `{MMDD}-{主题}-v{N}.md` |
| 输出目录 | `./outputs/` |
| 报告骨架 | 市场概况 / 竞争格局 / 技术趋势 / 关键结论 |
| 表格约束 | ≤ 4 列，每格 ≤ 30 字 |
| 置信度 | 高 / 中 / 低三级 |
| 来源标注 | 每条关键数据标注出处 |

## 目录结构

```
ruisearch/
├── SKILL.md                     # Skill 入口（路由表、触发条件、环境自检）
├── README.md                    # 本文档
├── references/                  # 平台工具文档（源自 Agent Reach，MIT License）
│   ├── search.md                # Exa AI 搜索
│   ├── social.md                # 小红书/抖音/微博/推特/B站/V2EX/Reddit
│   ├── web.md                   # Jina/web-reader/公众号/RSS
│   ├── video.md                 # YouTube/B站字幕/小宇宙/抖音视频
│   ├── career.md                # LinkedIn
│   └── dev.md                   # GitHub CLI
└── modules/
    ├── research/
    │   └── rules.md             # 调研规则（搜索工具链、专利检索、股票API、关键词模板、启发式）
    └── document/
        ├── feishu_compact.md    # 飞书紧凑 Markdown 格式规范
        ├── standard_markdown.md # 标准 Markdown 格式规范
        └── word_friendly.md     # Word 友好格式规范
```

## 版本历史

| 版本 | 日期 | 变更 |
|------|------|------|
| v3.0.0 | 2026-07 | 融合 Agent Reach 17 平台搜索架构；移除 agent-reach 外部依赖；新增 references/ 目录 |
| v2.2.0 | 2026-07 | 自包含化：合并 Exa 说明，新增三级环境自检，股票行情模块 |
| v2.1.0 | 2026-06 | 新增专利检索能力 |
| v2.0.0 | 2026-06 | 初始发布：Exa + 多格式输出 + 调研流水线 |

## License

MIT。`references/` 目录下的平台工具文档源自 [Agent Reach](https://github.com/Panniantong/Agent-Reach)（MIT License），版权归原作者 [@Panniantong](https://github.com/Panniantong) 所有。
