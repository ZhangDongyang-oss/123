# 内外后视镜视野校核系统

## 基本信息

- 模块ID：mirro-fov（用于URL路径 /mirro-fov/）
- 所属分组：smart（智能硬件组）
- 一句话描述：GB 15084-2022 内外后视镜法规视野校核工具，支持 I 类内镜（平面镜五线法）和 III 类外镜（凸球面双眼交集）

## 环境要求

| 依赖 | 版本 | 用途 | 必装 |
|------|------|------|------|
| Node.js | ≥ 18 | 服务器 + 校核引擎 | ✅ 必装 |
| npm 包 | `express` `js-yaml` | 见 package.json，`npm install` 安装 | ✅ 必装 |
| Python | ≥ 3.8 | STEP 轮廓提取（新建向导/一条龙） | ✅ 必装 |
| numpy / pyyaml / pywin32 | 任意 | STEP 提取 + 3DE（`pip install -r python/requirements.txt`） | ✅ 必装 |
| CATIA + pywin32 | — | 3DE 选点读取（/api/catia） | 可选，无则按钮降级灰掉 |

**异地部署注意**：真实车型数据（`data/vehicles/*.json`、`data/exterior/*.json`）为敏感数据**不入库**，需手动拷贝。仓库自带 `template.example.json` 示例车型，可完整跑通校核流程演示。STEP 文件（`data/tmp/`）为上传临时文件，不入库。

---

## 功能说明

### 工作流

- **动作优先**：入口分"校核已有车型"（绿=已有数据）与"新建车型"（蓝=从零创建）
- **新建车型向导**（内外镜统一）：上传一个整车 STEP → 自动提取全部参数 → 预览确认 → 保存并校核
- **供应商 STEP 规范**：按 `docs/supplier-step-annotation-spec.md` 标注点/面命名，即可全自动提取

### 内后视镜（I 类平面镜）

- 整车 STEP 自动提取（镜面轮廓/球铰/镜心/眼点/地面/后挡风 + yaw/pitch）
- 五线法主判据（5/5 → PASS）
- 镜中法规线倒影可视化
- 后挡风穿透参考判据
- 两阶段自动搜角（yaw/pitch）
- 车型CRUD

### 外后视镜（III 类凸球面镜）

- 整车 STEP 自动提取（球面/轮廓/球心/R + 旋转轴 + 6 命名点）
- 球面轮廓拟合（共面/非共面双路径自动检测）
- 供应商球心交叉校核 + 一致性闸门
- 精确球面反射解算（全球面扫描+二分）
- 双眼交集判据（GB 15084）
- 地面三角视野区校核（near + far）
- 二维调节搜索（上下 ψ + 左右 θ 各 ±3°）
- 2D 反射面投影可视化

---

## 管理员操作

### server.js 挂载

```javascript
const mirroFovRoutes = require('./modules/smart/mirro-fov/routes');
app.use('/mirro-fov', moduleAuth('mirro-fov'), mirroFovRoutes);
```

### 需要安装的 npm 包

- express（平台已有）
- js-yaml（3DE 读取用，平台已有则无需安装）

### AI 助手接入

请在 ai-assistant/routes.js 的 SYSTEM_PROMPT 中添加：

【平台模块路径】加一行：
- /mirro-fov/ — 内外后视镜视野校核（GB 15084 I/III 类，五线法 + 球面双眼交集）

### 数据目录

模块自带 data/ 目录，无需额外创建。

---

## 接口文档

### 内镜 API

| 接口 | 方法 | 说明 |
|------|------|------|
| /api/vehicles | GET | 车型列表 |
| /api/config?path= | GET | 车型配置 |
| /api/verify | POST | 单角度校核 |
| /api/optimize | POST | pitch 二分优化 |
| /api/auto-search | POST | 两阶段自动搜角 |
| /api/vehicles/save | POST | 保存车型 |
| /api/vehicles/delete | POST | 删除车型 |
| /api/step/upload | POST | 内镜 STEP 上传提取（流式，需 Python + numpy） |
| /api/interior/extract | POST | 内镜整车 STEP 一键提取 |
| /api/interior/extract/progress | GET | 内镜提取进度轮询 |
| /api/interior/extract/retry | POST | 内镜提取重试（不重传文件） |
| /api/interior/save | POST | 内镜车型保存（原子写） |
| /api/interior/upload-tmp | POST | 内镜多文件上传落盘（不提取） |
| /api/interior/extract-multi | POST | 内镜多文件合并提取 |
| /api/catia | POST | 3DE 读取（遗留，前端已隐藏） |
| /api/catia/available | GET | 3DE 可用性检测 |

### 外镜 API

| 接口 | 方法 | 说明 |
|------|------|------|
| /api/exterior/vehicles | GET | 车型列表 |
| /api/exterior/config?path= | GET | 车型配置 |
| /api/exterior/verify | POST | 双镜合并校核（二维 psi+theta，含 2D 投影 viz） |
| /api/exterior/extract | POST | 外镜整车 STEP 一键提取 |
| /api/exterior/extract/progress | GET | 外镜提取进度轮询 |
| /api/exterior/extract/retry | POST | 外镜提取重试（不重传文件） |
| /api/exterior/upload-tmp | POST | 外镜多文件上传落盘（不提取） |
| /api/exterior/extract-multi | POST | 外镜多文件合并提取 |
| /api/exterior/save | POST | 外镜车型保存（原子写） |
| /api/exterior/delete | POST | 外镜车型删除 |

---

## 目录结构

```
mirro-fov/
  routes.js               ← 后端路由
  README.md               ← 本文件
  HANDOFF.md              ← 开发文档（算法/判据/历史）
  package.json
  _test_server.js          ← 本地测试服务器
  engine/                  ← 纯 JS 计算引擎（零外部依赖）
    shared/                 几何/平面/多边形（公用）
    inner/                  内镜（平面镜 + 五线法）
    exterior/               外镜（凸球面 + 球心拟合 + 三角视野）
  python/                  ← STEP 提取（需 Python + numpy）
    step_curve_sampler.py   STEP 解析器（B-spline 采样）
    step_topology.py        内镜拓扑提取 + 顶点锚定采样/重复描边清理（公共）
    step_rear_window.py     后挡风提取（半模镜像/面名几何降级）
    step_sphere_mirror.py   外镜球面镜提取
    step_verify.py          提取自检闸门（公共: 连续闭合/无飞线/跨度）
    test_step_extraction.py 提取回归测试
  public/                  ← 前端
    index.html              landing + 内镜页 + 外镜页
    style.css               L0 设计系统模板
    app.js                  交互逻辑
  data/                    ← 车型数据（真实数据敏感不入库）
    vehicles/               内镜车型 JSON
    exterior/               外镜车型 JSON
    tmp/                    上传的 STEP 临时文件（gitignore）
  docs/                    ← 规范文档
    DEVELOPMENT_SPEC.md     开发维护规范
```

---

## 本地测试

```bash
cd modules/smart/mirro-fov
npm install
pip install -r python/requirements.txt   # numpy 等 (STEP 提取必需)
npm test             # 170 断言全绿
python python/test_step_extraction.py   # STEP 提取回归 (6 项)
npm start            # → http://localhost:3000
```

---

## 组落地页 MODULES 数组

```javascript
{ id:'mirro-fov', href:'/mirro-fov/', icon:'🪞', tag:'法规校核', title:'内外后视镜视野校核', desc:'GB 15084 I/III 类 · 五线法+球面双眼交集 · 3DE 接入', arrow:'进入' }
```
