# 开发规范

本仓库是 **mirro-fov** 内/外后视镜视野法规校核工具的代码仓库。所有代码和文档更新遵循以下规范。

---

## 1. 提交信息规范

格式: `类型: 描述`

| 类型 | 用途 |
|---|---|
| `feat:` | 新功能 |
| `fix:` | 修复 bug |
| `refactor:` | 重构, 不改变行为 |
| `docs:` | 文档改动 |
| `chore:` | 配置/构建/依赖 |
| `test:` | 测试改动 |

示例:
- `feat: 后挡风 STEP 轮廓提取`
- `fix: 后挡风距边连线跳变`

## 2. 提交内容规范

- 一次提交只做一件事（单一职责）
- 每次提交写清楚改了什么（中文描述，body 可选详述）
- 提交前跑 `npm test`（**170 断言**全绿：内镜 51 + 外镜 68 + 球面拟合 51）
- 改 `index.html` / `app.js` / `style.css` 时，递增 `?v=` 缓存版本号
- 代码改动提交前需经确认（不自动提交）；确认后套用本规范提交

## 3. 版本管理规范（核心）

> 目的: 每次功能里程碑都有明确的版本号 + 更新说明，形成可追溯的脉络。

### 3.1 版本号规则 (semver)

格式 `vX.Y.Z`：

| 位 | 含义 | 触发 |
|---|---|---|
| X (major) | 不兼容改动 / 工作流大重构 | 如 v1→v2（手动取点 → 全自动 STEP） |
| Y (minor) | 新功能 / 新能力 | 如新增二维调节、UI 精简 |
| Z (patch) | bug 修复 | 如上传 413、Plotly 不刷新 |

### 3.2 版本更新流程（功能里程碑完成后自动执行）

一个功能里程碑（一个 stage 或多个相关 stage）完成后：

1. **bump 版本号**：更新 `modules/smart/mirro-fov/package.json` 的 `version`
2. **更新 CHANGELOG**：在 `modules/smart/mirro-fov/CHANGELOG.md` 顶部加新版本条目（新增/修复/引擎三节，见下）
3. **打 tag**：`git tag -a vX.Y.Z -m "..."` 并推送
4. **推 main**：合并到 `main` 并推送

### 3.3 CHANGELOG 条目格式

```markdown
## vX.Y.Z (YYYY-MM-DD) — 一句话主题

### 新增
- 功能点

### 修复
- bug 点

### 引擎
- 断言数（如有变化）
```

### 3.4 当前基线

**v2.4.0** — 内外镜全线对齐 + 多文件上传 + SR 交叉验证（最新基线以 CHANGELOG 顶部为准）

## 4. 验收规范

每个功能/修复完成后，独立核验（不是只看执行结果，要实际跑）：

- **引擎改动**：`npm test` 170 断言全绿
- **提取脚本改动**：与人工/参考数据对照（如球心/眼点/轴线逐项差 < 阈值）
- **前端改动**：`node --check public/app.js` 语法 + 浏览器验证功能点（校核/上传/折叠/预览）
- **新增接口**：越界/默认保护/错误处理的安全测试

## 5. 文档维护规范

功能里程碑或接口变更时，同步更新：

- `CHANGELOG.md`：版本条目（必做，见 §3）
- `README.md`（根 + 模块）：功能描述 / 断言数 / 环境要求 / API 表
- `docs/supplier-*.md`：供应商规范（命名/口径变化时）
- 规范文档自身过时也要更新（如断言数、版本基线）

## 6. 远程仓库内容边界

**入库**（可公开）:
- 引擎代码（`engine/`）
- 前端代码（`public/`）
- 后端路由（`routes.js`）
- 模板数据（`*.example.json`）
- 开发框架文档（README / CONTRIBUTING / CHANGELOG / docs/*.md）
- 开发记录文档（`HANDOFF.md` / `docs/DEVELOPMENT_SPEC.md` / `docs/DEVELOPMENT_EXPERIENCE.md` 等）— **必须脱敏**（真实坐标换示例值、车型代号换「车型A/B/C」、供应商数据抽象化）

**不入库**（仅本地，见 .gitignore）:
- 真实车型数据（`data/vehicles/*.json`, `data/exterior/*.json` 及 `.outline.json`）
- 平台落地页（`modules/smart/public/index.html`，含组织名/部署细节）
- 供应商原始 STEP 文件与提取产物（`**/data/tmp/`）

## 7. 分支策略

- `main`：稳定主线，只接收测试通过、验收通过的提交
- 开发在功能分支进行，验证后合并到 `main` + 打 tag + 推送

---

## 附：AI 协作分工（内部开发流程）

> 完整流程见 `docs/DEVELOPMENT_SPEC.md`（内部，不入库）。此处简述：

- **plan/accept 角色**：制定开发计划 + 独立验收（对照数据 + 断言 + 安全测试）
- **execute 角色**：按计划写代码，产出对照数据供验收
- 每个 stage 闭环：计划 → 派执行 → 独立核验 → 提交（套用 §2/§3 规范）
