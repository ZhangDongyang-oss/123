---
name: ruisearch
description: |
  当用户说"搜""查""找""调研""股价""行情""财报""竞品""市场"时自动触发。
  所有网页搜索走 Exa（mcporter），WebSearch 仅作降级。
  覆盖：股票行情(腾讯API)、17平台搜索(小红书/推特/B站/Reddit/GitHub/YouTube等)、调研报告(含专利检索)、飞书/标准MD/Word三种文档格式。
  不自动触发于：纯代码编写、纯聊天、Git 操作、文件编辑。
version: "3.2.0"
user-invocable: true
argument-hint: "[可选：功能名称]"
triggers:
  - search: 搜/查/找/search/搜索/查一下/帮我搜
  - social:
    - 小红书: xiaohongshu/xhs/小红书/红书
    - 抖音: douyin/抖音
    - Twitter: twitter/推特/x.com/推文
    - 微博: weibo/微博
    - B站: bilibili/b站/哔哩哔哩
    - V2EX: v2ex
    - Reddit: reddit
  - career: 招聘/职位/求职/linkedin/领英/找工作
  - dev: github/代码/仓库/gh/issue/pr/分支/commit
  - web: 网页/链接/文章/公众号/微信文章/rss/读一下/打开这个
  - video: youtube/视频/播客/字幕/小宇宙/转录/yt
  - finance: 雪球/股票/stock/xueqiu/行情/股价/基金/财报
  - research: 调研/报告/分析报告/竞品分析/市场分析/行业分析/供应商/技术路线
  - patent: 专利/查新/专利布局/技术壁垒/知识产权/IP
  - format: 飞书格式/排版/Word格式/标准Markdown/整理报告
---

# Ruisearch

多功能通用 skill，提供 17 平台搜索、调研分析、股票行情、文档处理能力。

## 路由表

唯一工具选择来源。所有 Exa 调用不可用时自动降级 WebSearch，非硬性禁令。

| 用户意图 | 路由 | 首选工具 | 详细文档 |
|---------|------|---------|---------|
| 网页搜索/代码搜索 | search | `mcporter` + Exa | [references/search.md](references/search.md) |
| 小红书/抖音/微博/推特/B站/V2EX/Reddit | social | 对应 CLI / Exa | [references/social.md](references/social.md) |
| 招聘/职位/LinkedIn | career | Exa | [references/career.md](references/career.md) |
| GitHub/代码 | dev | `gh` CLI / Exa | [references/dev.md](references/dev.md) |
| 网页/文章/公众号/RSS | web | Jina Reader / Exa | [references/web.md](references/web.md) |
| YouTube/B站/播客字幕 | video | `yt-dlp` / Exa | [references/video.md](references/video.md) |
| 股票查价（多少/涨跌） | finance | 腾讯行情 API | `modules/research/rules.md` |
| 股票查原因（为什么涨/跌） | finance | `mcporter` + Exa | `modules/research/rules.md` |
| 调研/报告/竞品/专利 | research | `mcporter` + Exa | `modules/research/rules.md` |
| 文档格式处理 | format | — | `modules/document/` |

> 路由冲突优先级：调研报告 → 股票行情 → 社交媒体 → 通用搜索。模糊场景默认快速查询。

## 零配置快速命令

```bash
# Exa 网页搜索
mcporter call 'exa.web_search_exa(query: "query", numResults: 5)'

# 通用网页阅读
curl -s "https://r.jina.ai/URL"

# 股票行情（腾讯接口，无鉴权）
curl -s "https://qt.gtimg.cn/q=r_hk01810" | iconv -f GBK -t UTF-8

# GitHub 搜索
gh search repos "query" --sort stars --limit 10

# Twitter 搜索
twitter search "query" --limit 10

# YouTube/B站字幕
yt-dlp --write-sub --skip-download -o "/tmp/%(id)s" "URL"

# Reddit 搜索
rdt search "query" --limit 10

# V2EX 热门
curl -s "https://www.v2ex.com/api/topics/hot.json" -H "User-Agent: agent-reach/1.0"
```

## 环境自检（首次触发时自动执行）

首次触发本 skill 时，**不要只是报告问题——直接修复问题**。按顺序执行以下检查，每个步骤失败时自动执行修复命令，无需询问用户。唯一需要用户参与的步骤是 OAuth 浏览器认证。

### 检查 1：Node.js
```bash
node --version
```
- ✅ 存在 → 继续
- ❌ 不存在 → 告知用户去 https://nodejs.org/ 安装 LTS 版本（≥18），安装后重启终端。暂停后续检查。

### 检查 2：mcporter
```bash
mcporter --version
```
- ✅ 存在 → 继续
- ❌ 不存在 → **直接执行** `npm install -g mcporter`，安装成功后继续。若安装失败，告知用户检查 Node.js 和 npm 环境。

### 检查 3：Exa MCP 已注册
```bash
mcporter call 'exa.web_search_exa(query: "test", numResults: 1)'
```
- ✅ 返回正常 JSON → 通过，标注 `[Exa]` 可用
- ❌ `Unknown MCP server 'exa'` → Exa 未注册。**直接执行：**
  ```bash
  mcporter config add exa --url https://mcp.exa.ai/mcp
  ```
  然后继续检查 4。
- ❌ 认证错误（401/403）→ Exa 已注册但未认证，继续检查 4。

### 检查 4：Exa MCP 已认证
注册后首次调用如果返回认证错误，**直接执行：**
```bash
mcporter auth exa
```
该命令会打开浏览器引导用户完成 Exa OAuth 认证（免费，无需手动获取 API Key）。认证完成后重新验证：
```bash
mcporter call 'exa.web_search_exa(query: "test", numResults: 1)'
```
- ✅ 返回正常 JSON → 通过，标注 `[Exa]` 可用
- ❌ 仍然失败 → 标注 `[WebSearch]` 降级。告知用户可访问 https://dashboard.exa.ai 手动注册获取 API Key，然后运行 `mcporter auth exa`。

### 检查 5：可选 CLI 工具（不阻塞，按需提醒）
以下工具不是必须的，当用户首次触发对应平台搜索时再提示安装：

| 工具 | 安装命令 | 触发场景 |
|------|---------|---------|
| xhs | `pipx install xiaohongshu-cli` | 搜小红书 |
| twitter | `pipx install twitter-cli` | 搜推特 |
| rdt | `pipx install rdt-cli` | 搜 Reddit |
| bili | `pipx install bilibili-cli` | 搜 B站 |
| douyin | `pipx install douyin-mcp-server` | 搜抖音 |

### 状态标注
每次调研开始前在思考中标注当前搜索链路：`[Exa]` / `[WebSearch]`。

## 调研深度

### 快速查询（默认）
触发词："查一下""帮我搜""XX是什么""XX多少钱""股价"
流程：单次搜索 → chat 内直接回答，标注来源和置信度。不生成文件。

### 完整报告
触发词："调研""分析报告""整理报告""市场分析""竞品对比"
流程：搜索两遍 → 分析一遍 → 输出到 `./outputs/`。
详细规则见 [modules/research/rules.md](modules/research/rules.md)。

意图不明确时默认快速查询，用户可追加"整理成报告"升级。

## 文档格式

未指定格式时默认飞书紧凑。可通过关键词切换：

| 格式 | 触发关键词 | 入口文件 | 备注 |
| --- | --- | --- | --- |
| 飞书紧凑 | 默认 / "飞书格式" | `modules/document/feishu_compact.md` | Markdown 适配飞书渲染器 |
| 飞书原生 | "推送到飞书""飞书文档" | `modules/document/feishu_native.md` | 走 MCP 直接写入飞书，callout 标注结论、lark-table 表格 |
| 标准Markdown | "标准Markdown" | `modules/document/standard_markdown.md` | CommonMark，无平台特殊约束 |
| Word友好 | "Word格式" / "docx" | `modules/document/word_friendly.md` | 面向 pandoc / md_to_docx 转换 |

## 输出规范

### 输出目录
- 项目内：`./outputs/`
- 用户指定路径时按用户路径
- 目录不存在时自动创建

### 文件命名
`{MMDD}-{主题}-v{N}.md`，如 `0615-储能市场调研-v1.md`

### 版本管理
首次 `-v1.md`，迭代 `-v2.md` → `-v3.md`，不覆盖旧稿。

## 工作区规则

**不要在 skill 目录创建文件。** 使用 `/tmp/` 存放临时输出，项目 `./outputs/` 存放正式产出。

## 目录结构

```
.claude/skills/ruisearch/
├── SKILL.md
├── references/                      ← 平台工具文档
│   ├── search.md
│   ├── social.md
│   ├── web.md
│   ├── video.md
│   ├── career.md
│   └── dev.md
└── modules/
    ├── research/
    │   └── rules.md                 ← 调研规则、专利检索、股票API、关键词模板
    └── document/
        ├── feishu_compact.md
        ├── standard_markdown.md
        └── word_friendly.md
```
