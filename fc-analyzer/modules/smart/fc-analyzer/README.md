# FC 可行性分析工具

## 基本信息

- **模块ID**: `fc-analyzer`（用于URL路径 `/fc-analyzer/`）
- **所属分组**: smart（智能硬件组）
- **一句话描述**: 灯具FC问题智能分析工具 — AI字段提取 + 历史案例检索 + VIIM工单管理

## 功能概述

| 功能 | 说明 |
|------|------|
| AI字段提取 | 输入一句话FC描述，自动提取区域、严重度、开发阶段、车型等结构化字段 |
| 历史案例检索 | 基于TF-IDF+多维度关键词加权的相似案例搜索 |
| 可行性分析报告 | 自动聚类根因、提取修改方向、数值边界，生成分析报告 |
| VIIM工单提交 | 一键将分析结果提交为VIIM工单 |
| 报告状态检查 | 跟踪所有FC工单状态，检测逾期、缺失字段 |
| 跟进提醒 | 基于5条告警规则的自动提醒（逾期、S级、趋势等） |
| 反馈学习 | 用户修正系统提取结果，系统持续学习优化 |

## 管理员操作

### server.js 挂载

```javascript
const fcAnalyzerRoutes = require('./modules/exterior/fc-analyzer/routes');
app.use('/fc-analyzer', moduleAuth('fc-analyzer'), fcAnalyzerRoutes);
```

### 需要安装的 npm 包

无需额外安装。本模块仅使用 Node.js 内置模块（`fs`, `path`, `https`, `http`）和平台提供的 `shared/` 模块。

### 环境变量

以下环境变量需在服务器端配置（`.env` 或系统环境变量）：

| 变量名 | 必填 | 说明 |
|--------|------|------|
| `VIIM_URL` | 是 | VIIM Jira 实例地址，如 `https://viim.example.com` |
| `VIIM_API_TOKEN` | 是 | VIIM API Bearer Token |
| `VIIM_PROJECT_KEY` | 否 | VIIM项目Key，默认 `DEMODIR` |
| `FEISHU_APP_ID` | 否 | 飞书应用ID（用于图片代理等功能） |
| `FEISHU_APP_SECRET` | 否 | 飞书应用密钥 |

### 数据目录

模块在首次运行时自动创建 `data/` 目录。如需从 Python 版本迁移数据，可将以下文件复制到 `modules/exterior/fc-analyzer/data/`：

| 文件 | 来源 | 说明 |
|------|------|------|
| `cases.json` | `database/lighting_issues.json` 或 `database/issues.json` | 历史案例库 |
| `lighting_keywords.json` | `database/lighting_keywords.json` | 关键词词库 |
| `lighting_patterns.json` | `database/lighting_patterns.json` | 根因模板 |
| `feedback.json` | `database/feedback.json` | 历史反馈数据 |

> 模块也支持从项目根目录的 `database/` 目录读取这些文件（自动查找），所以如果不复制文件，只要根目录的 `database/` 存在也能工作。

### AI 助手接入

请在 ai-assistant/routes.js 的 SYSTEM_PROMPT 中添加：

**【平台模块路径】加一行：**
- /fc-analyzer/ — 灯具FC问题可行性分析工具（AI提取+案例检索+VIIM提报）

**【新增 action】：**
- action名：`analyze_fc`
- 参数：
  - text: FC问题描述文本（必填）
  - auto_run: 是否自动执行分析（true/false，可选）
- 触发场景：用户说"分析这个FC"、"帮我查FC案例"、"远光灯配光问题"、"提交FC工单"等

**【前端已自行注册 `window.__aiActions['analyze_fc']`，无需改 ai-widget.js】**

## 模块结构

```
fc-analyzer/
  routes.js              ← Express 路由（所有API端点）
  lib/
    constants.js         ← 字段映射、严重度/阶段常量
    viim-client.js       ← VIIM Jira REST API 客户端
    search-engine.js     ← TF-IDF 搜索引擎（字符n-gram分词）
    analyzer.js          ← AI 字段提取 + 报告生成
    storage.js           ← JSON 文件存储（原子写入）
    tracker.js           ← 工单跟踪、告警规则、提醒
  public/
    index.html           ← SPA 前端页面
  data/                  ← 模块私有数据（运行时自动创建）
  README.md              ← 本文件
```

## API 端点一览

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/me` | 当前用户信息 |
| POST | `/api/analyze` | 核心分析（AI提取+检索+报告） |
| POST | `/api/dryrun` | 快速预览（仅本地检索） |
| POST | `/api/submit` | 提交工单到VIIM |
| GET | `/api/search?q=关键词` | 搜索历史案例 |
| GET | `/api/cases/stats` | 案例库统计 |
| GET | `/api/issue/:key` | 查询工单详情 |
| POST | `/api/track` | 添加跟踪 |
| GET | `/api/tracking` | 跟踪列表 |
| POST | `/api/track/:id/status` | 更新跟踪状态 |
| GET | `/api/reminders` | 跟进提醒 |
| GET | `/api/alerts` | 检查新告警 |
| GET | `/api/dashboard` | 管理看板 |
| GET | `/api/report-check` | 报告完整性检查 |
| POST | `/api/draft` | 保存草稿 |
| GET | `/api/drafts` | 草稿列表 |
| DELETE | `/api/draft/:id` | 删除草稿 |
| GET | `/api/history` | 历史记录 |
| POST | `/api/feedback` | 提交反馈 |
| GET | `/api/feedback/cases` | 反馈列表 |
| GET | `/api/stats` | 反馈统计 |
| POST | `/api/import` | 导入数据 |

## 从 Python 版本迁移

本模块是 `fc-lighting-fc-analyzer` Python Flask 系统的 Node.js 平台适配版本。主要变化：

| 原 Python 组件 | Node.js 对应 | 说明 |
|----------------|-------------|------|
| `lighting_extractor.py` (regex) | `analyzer.js` (aiChat) | 改用平台AI提取字段，保留regex兜底 |
| `lighting_search.py` (jieba+TF-IDF) | `search-engine.js` (n-gram+TF-IDF) | 用字符n-gram替代jieba分词 |
| `lighting_analyzer.py` | `analyzer.js` | 报告生成逻辑完整移植 |
| `viim_client.py` (urllib) | `viim-client.js` (http) | API逻辑完整移植 |
| `alerts.py` | `tracker.js` | 跟踪+5条告警规则完整移植 |
| `feedback.py` | `routes.js` (feedback routes) | 反馈收集完整移植 |
| `report_checker.py` | `routes.js` (report-check route) | 状态检查完整移植 |
| Flask login_gate | 平台 `req.user` + `moduleAuth` | 认证交由平台处理 |
| Jinja2 模板 | SPA `index.html` | 改为客户端渲染单页应用 |

## 本地测试

```bash
# 确保 Node.js v16+
cd modules/exterior/fc-analyzer

# 创建临时测试文件（测试完后删除）
cat > _test_server.js << 'EOF'
const express = require('express');
const path = require('path');
const app = express();

app.use(express.json());

// Mock platform modules
const mockRouter = express.Router();
app.use((req, res, next) => {
  req.user = { open_id: 'test_user', name: '测试用户', department: '外饰组' };
  next();
});

const routes = require('./routes');
app.use('/', routes);

app.listen(3000, () => console.log('测试服务: http://localhost:3000'));
EOF

# 安装 express（如果还没有）
npm install express

# 启动
node _test_server.js

# 浏览器打开 http://localhost:3000
# 测试完成后删除 _test_server.js
```

## 测试检查清单

- [ ] 页面正常渲染，无白屏
- [ ] 控制台无报错（F12 查看）
- [ ] 输入FC描述后点击"分析"返回结果
- [ ] 示例案例可点击填入
- [ ] 各Tab切换正常
- [ ] 手机端适配正常（F12 切换设备模式）
- [ ] `/ai-widget.js` 脚本正常加载
