# 外镜 STEP 全自动提取 — 开发计划

> 角色:本计划由 plan/accept 角色(fable)制定,由 sonnet 执行。每阶段产出对照数据,由 plan 角色据此验收。
> 制定日期:2026-08-13。参考 STEP:`data/tmp/waijingjiaohe.stp`(15MB,外镜校核完整模型)。

## 背景与可行性结论(已实测,勿重复探测)

对 `waijingjiaohe.stp` 的探测事实:

- STEP:187892 实体,163345 点。球面 2 个(#42 右 R=1260 center=[-79.5,1680.4,951.9],#43 左 R=1260 center=[-189.7,-1502.2,899.4])。
- 现有 `python/step_exterior_extract.py` 已能提取:左右镜轮廓(571 点,球面偏差 0.026/0.294mm)、球心、眼点(硬编码坐标命中)、地面(硬编码坐标命中)。
- **轴线(关键卡点)**:手动 3 点 `turret_axis_p1/axis_y_point/axis_z_point` 在 STEP 中**不存在**(最近点距离 42–56mm);球心 200mm 内无其他点;0 个小半径圆柱(<80mm);球面 #43 放置轴方向=(0,0,1)≠旋转轴 [-0.386,0.923,0.005]。**结论:轴线无法从 STEP 自动提取,必须人工补录。**
- 车门最外 Y:draft 值 ±1005.2mm,STEP 中 |Y| 99 百分位≈1001.8mm,可几何逼近。
- 眼点/地面:当前 `find_point_by_coord` 硬编码本车坐标([1471,-427.5,1020] 等),换车型失效。

| 参数 | 全自动? | 说明 |
|---|---|---|
| 镜面轮廓 + 球心 + R | ✅ 已可 | SPHERICAL_SURFACE 几何查找,与名称无关,通用 |
| 眼点 / 地面 | ⚠️ 本车型可 | 硬编码命中,需轻量泛化 |
| 车门最外 Y | ⚠️ 可逼近 | 高百分位法,误差待校验 |
| 轴线 | ❌ 不可 | STEP 无此几何,走人工补录(阶段 3) |

## 约束(执行 agent 必守)

1. **禁止改引擎**:`engine/exterior/*`(155 断言全绿)、`engine/inner/*`、`engine/shared/*` 不动。
2. **提取脚本只改** `python/step_exterior_extract.py`;复用已有公共层 `step_topology.py`/`step_curve_sampler.py`,不另起。
3. **后端只改** `routes.js`(新增 `/api/exterior/extract`、`/api/exterior/save` 等);前端只改 `public/app.js` + `public/index.html`。
4. **不要尝试从 STEP 推导轴线**——已证无此几何,浪费时间。
5. 每阶段产出与 `data/exterior/exterior-vehicle-draft.json` 的数值对照,供验收。
6. 提交前跑 `npm test`(三套断言)必须全绿;`node -c routes.js && node -c public/app.js` 语法检查。

## 关键文件

- 参考车型(手动建):`data/exterior/exterior-vehicle-draft.json`(4412 行,含左右镜 outline_raw 421 点、轴线、supplier_sphere_center、车门 Y、眼点、地面、regulation)
- 提取脚本:`python/step_exterior_extract.py`(已实现轮廓/球心/眼点/地面,缺车门 Y/轴线)
- 球面提取:`python/step_sphere_mirror.py`(可参考其 find_spheres)
- 引擎入口:`engine/exterior/api-verify.js` → `verifyExteriorBoth(path, {psi})`
- 路由:`routes.js`(`/api/exterior/config`、`/api/exterior/verify`、`/api/catia/exterior`)
- 前端:`public/app.js`(`initExterior`、`doExtVerify`、`loadExtConfig`、`doExtCatia`)

## 阶段 0 — 对照验证(只读)

**目的**:证明 STEP 自动提取与手动 draft 几何一致。

执行:
```bash
cd modules/smart/mirro-fov
python python/step_exterior_extract.py data/tmp/waijingjiaohe.stp \
  --json data/exterior/exterior-vehicle-draft.json \
  --output data/tmp/stage0-compare.json
```

对照项(写进 `data/tmp/stage0-report.md`):
- 球心:stage0 输出 vs draft `supplier_sphere_center`,逐轴差 mm。
- 轮廓:571 点 vs draft 421 点。把两者重采样到等点数(或最近点距离),报告 max/mean 最近点距离(应 max<1mm)。
- 眼点/地面:应 0 偏差(硬编码命中)。

**验收**:轮廓 max 偏差 <1mm,球心 <0.1mm,眼点/地面 0 偏差。

## 阶段 1 — 提取器补齐(车门 Y + 泛化 + 输出对齐)

**目的**:无 `--json` 也能输出直接可喂 `verifyExteriorBoth` 的完整 JSON(轴线字段留 null)。

改 `python/step_exterior_extract.py`:

1. **车门 Y 几何逼近**:`find_door_outer_Y(points, side)` — 限定 Z∈[600,1100]mm(车门高度),取该区间内 |Y| 的 99.5 百分位,返回左右两个标量。对照 draft ±1005.2,误差应 <5mm。把值写进 `door_panel.door_outer_Y_left/right`。
2. **眼点泛化**:`find_eyes(points)` — 找一对同 X(±20mm)、同 Z(±20mm)、|ΔY|∈[55,75]mm 的点对作为左右眼;失败则回退现有硬编码。用 draft 校验命中。
3. **地面泛化**:`find_ground(points)` — 在 |Y|<30mm 的点中取 Z 最低的前后两点(min X / max X);失败回退硬编码。
4. **输出对齐**:输出 JSON 顶层结构 = draft 的 `vehicle/driver/ground/door_panel/exterior_mirror_left/right/regulation`。每镜含 `sr_nominal/sr_tolerance/sr_fit/radius/outline_raw/supplier_sphere_center/turret_axis_p1(null)/axis_y_point(null)/axis_z_point(null)/rotation_axis_dir(null)`。`regulation` 用 draft 的 III 类值。
5. **SR**:`sr_fit` 用球面半径(已正确);`sr_nominal=1.23, sr_tolerance=0.03` 沿用 draft 元数据(无 `--json` 时取默认)。

执行(无 --json):
```bash
python python/step_exterior_extract.py data/tmp/waijingjiaohe.stp --output data/exterior/waijing-auto.json
# 然后校核
node -e "const {verifyExteriorBoth}=require('./engine/exterior/api-verify'); console.log(JSON.stringify(verifyExteriorBoth('data/exterior/waijing-auto.json',{psi:0}),null,1))" > data/tmp/stage1-verify.json
```

**验收**:`waijing-auto.json` → verify → 左 mirrorPass=true / 右 mirrorPass=false,与 draft 结论一致;车门 Y 误差 <5mm;眼点/地面命中 draft 值。

## 阶段 2 — 接入 Web(一键上传 STEP → 校核)

**目的**:前端外镜页上传一个 STEP 即出车型并校核,无需 3DE。

后端 `routes.js`:
- 新增 `POST /api/exterior/extract`:接 `express.raw` 二进制 STEP(复用 `/api/step/upload` 模式:filename sanitize、spawn `python step_exterior_extract.py`、进度轮询、落盘 `data/exterior/<safe>.json`)。返回 `{ok, path, vehicles: scanExteriorVehicles()}`。**路径越界闸门**:输出必须落在 `EXTERIOR_DIR` 内(对齐已修的外镜闸门)。
- 新增 `GET /api/exterior/extract/progress?name=`:进度轮询,同 `/api/step/progress`。

前端 `public/app.js` + `index.html`:
- 外镜页顶栏加"上传整车 STEP"按钮(`ext-upload-btn`),与"从 3DE 读取"并列。
- `doExtUpload()`:选文件 → POST `/api/exterior/extract`(raw body, X-Filename 头)→ 成功后 `await loadExtVehicles(); await loadExtConfig(result.path); await doExtVerify();`。
- 上传中显示进度(轮询 `/api/exterior/extract/progress`)。

执行:
```bash
node _test_server.js &  # 手动上传 waijingjiaohe.stp 验证
```

**验收**:浏览器上传 `waijingjiaohe.stp` → 自动出车型 → 双镜校核渲染,左 PASS/右 FAIL 与 draft 一致;无 3DE 环境可用;进度显示正常。

## 阶段 3 — 轴线最小人工补录 + 外镜 CRUD

**目的**:解决轴线不在 STEP 的硬约束;顺带补齐外镜保存/删除(之前 P1 待办)。

前端:
- 外镜页加"轴线补录"卡:每镜一个旋转轴方向 `[x,y,z]`(3 个 number 输入),或 3 点(p1/y/z)让后端算 `normalize(y-p1)`。默认从当前车型 config 预填。
- 轴线为 null 时:`doExtVerify` 前端提示"未补轴线,±3° 搜索以零位进行";补录后存盘再校核。
- 补齐 `ext-save-btn/ext-save-as-btn/ext-delete-btn`(当前是 alert 占位):保存/另存为/删除外镜车型。

后端 `routes.js` + `api-verify.js`:
- 新增 `POST /api/exterior/save`:接收完整外镜 JSON(含轴线),落盘 `data/exterior/<name>.json`,路径越界闸门。
- 新增 `POST /api/exterior/delete`:删除,默认车型保护 + 越界闸门(对齐内镜 `/api/vehicles/delete`)。
- `/api/exterior/config` 返回值已含轴线字段(确认 `sum()` 含 turret_axis_p1/rotation_axis_dir),前端能读回预填。

**验收**:轴线补录后存盘 → 重新校核,左 PASS 窗口 [-0.5°,0°] 复现;外镜保存/另存为/删除闭环;删除默认 draft 被拦截。

## 阶段 4(可选)— 鲁棒性硬化

- 眼点/地面/车门泛化失败时,返回 `null` + 前端提示手填(不静默出错)。
- STEP 无球面 / 多球面(>2)时友好报错。
- 上传非外镜 STEP(如内镜整车)时提示"未找到球面镜"。

**验收**:无球面 STEP → 友好报错;眼点未命中 → 提示而非崩溃。

## 执行顺序

**0 → 1 → 2** 先跑通主链路(轴线暂从 draft 沿用 / 留 null),**3** 随后,**4** 视情况。
每阶段完成后把对照数据(`stage0-report.md` / `stage1-verify.json` 等)留着,供验收。

---

# 阶段 5 — 工作流重构 + 外镜新建向导

> 用户决策(2026-08-13): 完整多步向导 / 预览=2D轮廓+球面偏差+球心 / 轴线手填与3DE并列 / 默认轴允许保存仅警告。
> 目的: 修复工作流混乱——外镜"上传STEP"是新建动作却挂在"校核已有"页顶栏。

## 现状问题

- 外镜"新建车型"(select-exterior-btn + wizardMode='new')只弹 alert"待实现"然后掉进校核页。
- "上传整车STEP"按钮(ext-upload-btn)挂在校核页顶栏,与"校核已有"语义冲突。
- 外镜无轮廓预览(内镜向导有 wiz-mirror-plot 供用户确认提取轮廓)。
- "从3DE读取"(ext-catia-btn)与"上传整车STEP"并列在校核页,STEP 自动后 3DE 对外镜冗余。

## 目标工作流

- **校核已有车型**: landing「进入校核」→ 外镜 → exterior-page(顶栏仅 保存/另存为/删除;隐藏 ext-upload-btn + ext-catia-btn,代码保留)。
- **新建车型**: landing「新建车型」→ 外镜 → **wizard-exterior-page**(新,4 步):
  1. 基本信息(车型名)
  2. 上传整车 STEP → 提取 → **预览左右镜面轮廓 2D + 球面偏差 + 球心**(用户确认提取对不对)
  3. 轴线录入(每镜 [x,y,z] 手填输入 + 「从3DE读取」按钮 **并列**;默认 [0,1,0] 橙色警告,允许默认轴保存)
  4. 保存并校核 → 跳 exterior-page 加载新车型

## 实现细节

### 5.1 后端 routes.js
- **/api/exterior/extract 输出改到 data/tmp**(不再写 exterior 目录): `outPath = path.join(STEP_TMP_DIR, stem+'.json')`,越界闸门改校验 STEP_TMP_DIR。理由:向导中途放弃不留 orphan 车型;旧 doExtUpload 隐藏流程仍能在 tmp 上 verify。返回 `{ok, path, vehicles: scanExteriorVehicles()}`(vehicles 不含 tmp 文件,正常)。
- 其余后端不变(/api/exterior/save、/delete、/verify、/config 已就绪)。

### 5.2 前端 index.html
- 新增 `wizard-exterior-page`(结构对齐 wizard-inner-page):
  - 顶栏: ← 返回 + 标题"新建外后视镜车型"
  - Step 0: 车型名 input
  - Step 1: 文件选择 + 「上传并提取」按钮 + 结果文本 + 预览区(`wiz-ext-plot-left`/`wiz-ext-plot-right` 两个 Plotly div + 球面偏差/球心标注 span)
  - Step 2: 左右轴线方向 [x,y,z] 输入(默认 [0,1,0]) + hint + 「从3DE读取」按钮(左右共用或各一)
  - Step 3: 确认信息摘要 + 「保存并校核」按钮
  - 上一步/下一步按钮同 wizard-inner
- exterior-page 顶栏: ext-upload-btn + ext-catia-btn 加 `style="display:none"`(隐藏不删)。

### 5.3 前端 app.js
- `select-exterior-btn` click: wizardMode==='new' → showPage('wizard-exterior'); else → showPage('exterior')。去掉 alert。
- 新增 `initWizardExterior()`(首次进入调用,绑定按钮/步骤):
  - 步骤导航: wizardExtNext/Prev(同 wizardInner 模式)
  - Step 1 上传: `doWizExtUpload()` — 选文件 → POST /api/exterior/extract(raw body, X-Filename) → 成功后:
    - 存 `wizExtPath = result.path`(tmp 路径)
    - GET /api/exterior/config?path=wizExtPath 拿 raw + mirrors
    - GET /api/exterior/verify?path=wizExtPath 拿 viz(outlineUV + fit 球面偏差/球心) — **预览复用 verify 结果**
    - `renderWizExtPreview()`: 左右两个 Plotly 2D,画 outlineUV 闭合折线 + 标题注 球面偏差(maxDevMm)/球心/点数。风格对齐 wiz-mirror-plot。
    - 进度轮询 /api/exterior/extract/progress(同 doExtUpload)
  - Step 2 轴线:
    - 输入预填 [0,1,0],hint 橙色"使用默认轴,建议补录真轴";手填改值后变灰"已补录真轴"
    - 「从3DE读取」按钮: POST /api/catia/exterior → 成功后读 result.output 的 config,取 exterior_mirror_left/right.rotation_axis_dir 填入输入框(仅取轴线,不替换其他)。注意 3DE 是交互式(终端选点),按钮期间禁用+提示。
  - Step 3 保存: `doWizExtSave()`:
    - 取 step 1 的 raw config(深拷贝),patch 轴线(左右 rotation_axis_dir = 输入值),设 vehicle.name = step 0 车型名
    - POST /api/exterior/save {name, config} → 落盘 data/exterior/<name>.json
    - 成功: 若 exterior-page 未初始化则 initExterior;loadExtVehicles;loadExtConfig(result.path);doExtVerify;showPage('exterior')
- 复用现有 `renderExtMirrorView` 的轮廓绘制逻辑抽取预览版(只画 outline + 标注,不画投影/安全线),或新写轻量 `renderWizExtPreview`。

### 5.4 pages 对象 + showPage
- pages 加 `'wizard-exterior': $('wizard-exterior-page')`。
- showPage 加 wizard-exterior 首次初始化分支(同 wizard-inner)。

## 约束(同前)
1. 禁止改 engine/**。
2. 后端只改 routes.js(extract 输出路径一行 + 闸门);前端只改 app.js + index.html。
3. 隐藏不删:ext-upload-btn/ext-catia-btn 加 display:none,doExtUpload/doExtCatia 函数保留。
4. 完成后 node -c + npm test 全绿。

## 验收门槛
- landing「新建车型」→ 外镜 → 进 wizard-exterior(不再 alert/掉进校核页)。
- 上传 waijingjiaohe.stp → 预览显示左右轮廓 2D + 球面偏差 + 球心,用户可目视确认形状。
- 轴线步:手填真轴 → hint 变灰;点 3DE 按钮(无 CATIA 环境会失败提示,不崩);默认轴保存仅警告不阻止。
- 保存并校核 → 跳校核页,新车型已加载,左 PASS/右 FAIL。
- 校核页顶栏不再有"上传整车STEP"/"从3DE读取"按钮(隐藏)。
- 中途放弃向导:data/exterior 无 orphan(tmp 在 data/tmp,gitignored)。
- npm test 全绿。

## 产出对照文件
- `data/tmp/stage5-report.md`:向导各步操作结果 + 预览截图描述 + 保存后校核结论 + 校核页按钮隐藏确认 + npm test。

---

# 阶段 6 — 合并 STEP 全自动提取 (方案 A)

> 用户决策(2026-08-13): 参考点要求供应商命名 / 轴系自动判定(不依赖供应商Z/X标注习惯) / 现在就实现。
> 目的: 一个 STEP 全自动出全部 7 类参数, 轴线不再人工补。供应商准则见 docs/exterior-step-supplier-spec.md。

## 已验证 ( probes )
- 参数 STEP `外后视镜视野分析参数.stp` 含 3 个 AXIS2_PLACEMENT_3D: 1 个世界原点 + 2 个在 turret p1。
- 旋转轴 = Z×X, 左[-0.38578,0.92258,0.00544]/右[0.54012,0.84157,-0.00546], 与 draft 5 位一致。
- 自动判定 (不依赖 Z/X 标注): fold=argmax(|z|), tilt=剩余中 argmax(|y|)。对左右镜均判出正确旋转轴。
- 参数 STEP 还含 27 个点: 眼点/球心/车门/turret p1/地面 全在 (但当前未命名)。

## 实现

### 6.1 python/step_exterior_extract.py 扩展 (核心)
重构: 核心提取函数改为接收 (entities, points) 而非文件路径, 便于合并测试。
新增三个提取器:
1. **find_mirror_frames(entities, points)** — 找 AXIS2_PLACEMENT_3D:
   - 排除放置点在原点 [0,0,0]±1mm 的世界系
   - 剩余按放置点 Y 正负分左右
   - 每个算三正交轴: X=ref_dir, Z=axis, Y=normalize(Z×X)
   - 自动判定: fold = 三轴中 |z| 最大者; tilt = 剩余两轴中 |y| 最大者; right = 第三
   - 返回 {side: {turret_axis_p1: 放置点, rotation_axis_dir: tilt, fold_axis_dir: fold}}
   - 自检: fold |z| 应 >0.9, tilt |z| 应 <0.1, 否则 stderr 警告"镜体坐标系朝向异常"
2. **find_named_points(entities, points)** — 按 STEP 实体名找 CARTESIAN_POINT:
   - 名单: EYE_LEFT, EYE_RIGHT, GROUND_FRONT, GROUND_REAR, DOOR_OUTER_LEFT, DOOR_OUTER_RIGHT
   - 返回 {eye_left, eye_right, ground_front, ground_rear, door_Y_left, door_Y_right}
   - 命名缺失时回退现有坐标启发式 (眼点Z≈1020等), 并 stderr 提示"未命名, 用启发式"
3. 球面/轮廓提取保留现有 (find_spheres + extract_outline)。
4. 组装输出: 轴线用 find_mirror_frames 填 (非默认[0,1,0]); 眼点/地面/车门用命名优先+启发式兜底; 球心/R/轮廓从球面。
5. 进度行 STEP_PROGRESS|... 不变。

### 6.2 合并测试 (无真实合并 STEP, 用内存合并)
- 写 data/tmp/test_combined_extract.py:
  - parse 玻璃 STEP (waijingjiaohe.stp) → entities_g, points_g
  - parse 参数 STEP (axis-test.stp) → entities_p, points_p
  - 内存合并: 给参数侧实体 ID 加偏移 (如 +100000), 重映射 args 里所有 #ref, 合并 dict
  - 调核心提取 (entities, points) → 输出 JSON
  - 对照 draft: 球心/轮廓/轴线/眼点/地面/车门 逐项差, 写 data/tmp/stage6-report.md
- 验收: 全部 7 参数命中 draft (球心 0, 轴线 5 位, 眼点/地面/车门 命中), verifyExteriorBoth 左PASS/右FAIL。

### 6.3 前端向导调整
- 上传 STEP 后, 轴线自动填入 step2 轴线输入框 (若 STEP 含轴线), hint 显示"已从 STEP 自动提取"; 仍可手改/3DE 覆盖。
- 轴线未提取到 (STEP 无坐标系) 时, 退回默认 [0,1,0] + 橙色警告, 手填/3DE 兜底。
- 单上传流不变 (方案 A 一个 STEP)。

## 约束
1. 禁止改 engine/**。提取脚本核心函数重构为接收 entities/points (不改球面/轮廓逻辑, 只拆签名)。
2. 命名识别大小写敏感, 用下划线 (EYE_LEFT 等)。
3. 自动判定 + 自检, 不硬编码坐标。
4. node -c + npm test 全绿。

## 验收门槛
- 合并内存提取: 7 参数全命中 draft (球心 0.0mm, 轴线 5 位一致, 眼点/地面/车门 命中或误差<5mm)。
- verifyExteriorBoth(合并输出) → 左 mirrorPass=true / 右 false, 左窗口含 [-0.5,0]。
- 仅玻璃 STEP (无轴系) → 轴线默认 [0,1,0] + 提示, 不崩。
- 仅参数 STEP (无球面) → 提示"未找到球面镜片面"。
- npm test 全绿。

---

# 阶段 7 — 内镜工作流重构 + 一 STEP 全自动提取

> 命名规范由我方定义 (2026-08-13), 供应商按 docs/interior-step-supplier-spec.md 提供。
> 目的: 内镜切到与外镜一致的"一个 STEP 全自动"流程, 替换旧的"分类上传+5点手动"。

## 现状 (探针已确认)
- 车型C STEP 已命名: `内后视镜镜座`(151面总成), `眼椭圆`/`左右眼椭圆中心点`(眼点0mm命中), `curb0 ground line` 曲线, `头部包络`。
- 车型C 未命名: pivot, center_zero, 后挡风, 地面前后点。
- 测试策略: 车型C 直接验证 eye/镜片轮廓/yaw-pitch/地面(曲线); pivot/center_zero/地面点 用**内存注入命名点**验证 (parse 车型C → 注入 CARTESIAN_POINT MIRROR_PIVOT 等 at 车型C.json 坐标 → 提取 → 比对)。后挡风无命名, 提取逻辑实现+合成小测, 标注待供应商 STEP。

## 实现

### 7.1 python/step_interior_extract.py (新, 平行 step_exterior_extract.py)
核心 `extract_interior(entities, points)`:
- `find_named_points`: 
  - 眼: `眼椭圆`→eye_center; `左侧眼椭圆中心点`/`右侧眼椭圆中心点`→IPD(ΔY)
  - `MIRROR_PIVOT`→pivot; `MIRROR_CENTER_ZERO`→center_zero
  - `GROUND_FRONT`/`GROUND_REAR`→ground (兜底: `curb0 ground line` 曲线端点)
- `find_glass_face`: 
  - 优先命名面 `INNER_MIRROR_GLASS`; 兜底 `内后视镜镜座` 总成内最大平面
  - 追踪边界得轮廓 (复用 step_topology.trace_face_boundary / sample_edge_vertex_chained) → outline_local_mm (2D, 镜面局部 u-v) + 3D
  - width/height 由轮廓跨度导出 (对齐现有 wizard 逻辑: floor of extents)
- `find_rear_window`: 命名面 `REAR_WINDOW`→外框轮廓; `REAR_WINDOW_TZ`→透光区
- `derive_yaw_pitch`: 镜面法向 (glass plane normal) + pivot + center_zero → yaw/pitch (对照 车型C -23.5/5 验证; 若镜片在 STEP 处零位则 yaw/pitch=0 且 center_zero=质心)
- 输出 JSON 对齐 车型C.json 结构 (mirror/driver/ground/rear_window/regulation/visualization), mm→m
- 边界: 缺命名 → stderr 提示哪个缺, 该字段 null, 不崩
- 进度行 STEP_PROGRESS|...

### 7.2 后端 routes.js
- `POST /api/interior/extract`: raw STEP → spawn step_interior_extract.py → 落盘 data/tmp/<stem>.json (越界闸门 STEP_TMP_DIR, 同 /api/exterior/extract 模式) + 进度轮询 `GET /api/interior/extract/progress`
- 复用现有 `/api/vehicles/save`/`delete` (内镜车型本就走这套) 
- 提取出的 tmp JSON 可直接喂 `/api/verify` (结构对齐)

### 7.3 前端 app.js + index.html
- 新增 `wizard-interior-page` (4步, 结构对齐 wizard-exterior):
  1. 车型名
  2. 上传整车 STEP → 自动提取 → 预览镜面轮廓 2D + 球面(无,平面镜改显 width/height)+ 眼点/地面/pivot/center 摘要
  3. 参数确认 (只读展示提取值, 可改? 默认只读, 顺齐外镜轴线可改)
  4. 保存并校核 → 跳 inner-page
- `select-inner-btn` new 模式 → wizard-interior; verify 模式 → inner-page (去 alert)
- 旧 `wizard-inner-page` (分类上传+5点) 加 display:none, 代码保留 (initWizardInner 不删)
- inner-page 顶栏 `catia-btn` (3DE) 加 display:none (STEP 自动后冗余, 代码保留), 同外镜处理
- pages + showPage 加 wizard-interior 首次初始化

### 7.4 测试 data/tmp/test_interior_extract.py
- parse 车型C STEP (data/tmp/车型C-interior.stp)
- 内存注入命名点: MIRROR_PIVOT=[2883.07,0,1441.017], MIRROR_CENTER_ZERO=[2909.215,0.007,1441.88], GROUND_FRONT=[500,0,193.209], GROUND_REAR=[5900,0,193.209] (验命名点路径)
- 调 extract_interior → 输出 JSON
- 对照 车型C.json (data/vehicles/车型C.json, UTF-8): eye 0mm, pivot 0mm, center_zero 0mm, ground 0mm, 镜面 width/height vs 车型C, yaw/pitch vs -23.5/5
- 写 data/tmp/stage7-report.md

## 约束
1. 禁止改 engine/** (内镜引擎 49 断言不动)。
2. 提取脚本新写 step_interior_extract.py, 复用 step_topology/step_curve_sampler 公共层。
3. 后端只改 routes.js; 前端只改 app.js + index.html。
4. 隐藏不删 (wizard-inner-page, catia-btn 代码保留)。
5. node -c + npm test 全绿。

## 验收门槛
- 内存注入测试: eye/pivot/center_zero/ground 0 偏差 vs 车型C.json; 镜面 width/height 命中 车型C (误差<2mm); yaw/pitch 推导出 -23.5/5 (误差<0.5°) 或确认镜片在 STEP 处零位。
- 输出 JSON → /api/verify → mirrorPass 与 车型C 一致 (五线 5/5 PASS)。
- 仅 STEP 无命名点 → 提示缺哪些, 不崩。
- npm test 全绿; 旧 wizard-inner 隐藏; inner-page 3DE 按钮隐藏。
- 后挡风提取: 合成小测通过, 标注待供应商 STEP 实测。

## 执行顺序
7.1 (提取器) → 7.4 (测试对照 车型C) → 7.2 (后端) → 7.3 (前端) → 验收。

---

# 阶段 8 — 大文件上传鲁棒性

> 目的: 防止大 STEP(141MB+)上传失败/崩溃/解析失败。第一梯队: 流式写盘+上传进度+JSON错误+预检+动态超时+失败重试提取。

## 风险与对策
1. OOM(express.raw 全量缓冲)→ **流式写盘**(req 管道到 fs.createWriteStream, 不经堆内存)
2. 无上传进度(像卡死)→ **XHR upload.onprogress**
3. 413/500 返 HTML → **Express JSON error handler**
4. 超 500mb 限制 → **前端预检 file.size + 服务端 content-length/流式计数双保险**
5. 固定超时误杀大文件 → **动态超时 = 120s + 1s/MB, 上限 1800s**
6. 提取失败要重传 → **重试提取接口**(tmp STEP 已在盘, 不重传)

## 实现

### 8.1 后端 routes.js
- **流式写盘**: 三个上传端点(/api/step/upload, /api/exterior/extract, /api/interior/extract)去掉 express.raw, 改为:
  - 读 content-length, >500MB → 413 JSON
  - req.pipe(fs.createWriteStream(stepPath)), 流中计 received, 超 500MB → 中断+删文件+413 JSON
  - finish 后 spawn Python (同现有逻辑)
  - 抽公共 helper `streamStepToTmp(req, filename, onDone, onError)` 复用三处
- **JSON error handler**: router 末尾加 `router.use((err, req, res, next) => {...})`, err.code==='LIMIT_...'/413 → {ok:false,error:'文件过大'}, 其他 → {ok:false,error:friendlyError(err)}, 统一 JSON 不再 HTML
- **动态超时**: spawn 后 `const sizeMB = fs.statSync(stepPath).size/1048576; const timeout = Math.min(1800000, 120000 + sizeMB*1000);`
- **重试提取**: `POST /api/interior/extract/retry` {name} → 找 data/tmp/<name> STEP 重 spawn; 外镜同理 /api/exterior/extract/retry。返回同 extract。

### 8.2 前端 app.js
- **上传函数改 XHR**(doWizIntUpload, doWizExtUpload, parseStepFile, doExtUpload):
  - `const xhr = new XMLHttpRequest(); xhr.open('POST', url);`
  - `xhr.upload.onprogress = e => { resultDiv.textContent = '上传 '+(e.loaded/e.total*100).toFixed(0)+'%'; };`
  - `xhr.onload = () => { const d = JSON.parse(xhr.responseText).catch?.(...); ... }` (用 try/catch JSON.parse)
  - xhr.setRequestHeader('X-Filename', ...); xhr.send(file);
  - 提取进度轮询保留(上传完后再轮询提取进度)
- **预检**: 上传前 `if (file.size > 500*1024*1024) { alert('文件 '+MB+' 超过 500MB 限制'); return; }`
- **重试按钮**: 提取失败时 resultDiv 旁显示"重试提取"按钮, 调 retry 接口(不重传)

### 8.3 抽公共上传 helper (前端)
- `uploadStep(url, file, {onProgress, onResult, onError, headers})` 统一 XHR 上传逻辑, 四处调用复用

## 约束
1. 禁止改 engine/**。
2. 后端只改 routes.js; 前端只改 app.js (index.html 尽量不动)。
3. 流式写盘必须正确处理: 中断删除临时文件、content-length 缺失时靠流计数、finish 后才 spawn。
4. 保留路径越界闸门 + filename sanitize + 进度轮询。
5. node -c + npm test 全绿。

## 验收门槛
- 车型C(141MB)上传: 显示上传进度%→18s 提取成功→结果正确(镜面轮廓238点/yaw-23.5/pitch5)。
- 流式: 上传期间 Node 堆内存不随文件大小暴涨(观察 process.memoryUsage, 141MB 文件堆 <100MB 增量)。
- 超 500MB: 前端预检拦截 + 服务端 413 返 JSON(非 HTML)。
- JSON error handler: 强制触发一个中间件错误 → 返回 JSON。
- 动态超时: 车型C(141MB)算出 ~260s, 不误杀。
- 重试: 模拟提取超时/失败 → 点"重试提取"→ 不重传, 重新 spawn 出结果。
- npm test 全绿。

## 执行顺序
8.1(后端流式+JSON错误+动态超时)→ 8.2/8.3(前端XHR+预检+重试)→ 验收(车型C 实测)。

---

# 阶段 9 — 内镜存储统一 + save 默认值修复 (parity)

> 目的: 内镜对齐外镜的存储规范 (轮廓 inline + 单接口原子保存), 顺带修 #1 (去掉 车型C 硬编码默认值)。旧 车型C (outline_path) 向后兼容。

## 现状不一致
- 外镜: 轮廓 inline (outline_raw), 单接口 /api/exterior/save 原子写, 无默认值。
- 内镜: 轮廓单独文件 (outline_path), 双接口 (/api/vehicles/save 重建 flat + save-outline), doWizIntSave 有 车型C 硬编码默认值 (224.796/-23.5/5.0/0.065/defaultRw) 静默兜底。

## 目标存储 (内镜对齐外镜模式)
内镜车型 JSON: mirror.outline_local_mm inline (不再用 outline_path 单独文件, 旧车 fallback)。新接口 /api/interior/save 原子写完整 config。字段仍按镜种差异 (yaw/pivot/rear_window 保留, 不与外镜字段强同)。

## 实现

### 9.1 python/step_interior_extract.py
- 提取输出把 outline_local_mm 写进 `mirror.outline_local_mm` (inline), 不再只放 _meta (可保留 _meta 副本供调试)。
- 其余结构不变 (mirror/driver/ground/rear_window/regulation/visualization, 米制 snake_case)。

### 9.2 后端 routes.js
- **新增 /api/interior/save** (平行 /api/exterior/save): 接收 {name, config}, 落盘 data/vehicles/<name>.json。name sanitize + 路径越界闸门 (VEHICLES_DIR) + 默认车型保护 (isDefaultVehicle, 不覆盖 车型C)。原子写 (单次 fs.writeFileSync)。
- **/api/vehicles/save 改合并模式**: 读现有车型 JSON (path 存在则读, 不存在则 {}), 用 body 的 flat 字段更新 mirror/driver/ground/rear_window, **保留现有 mirror.outline_local_mm / outline_path / regulation / visualization 不丢**, 写回。理由: 手动编辑内镜车型时不能丢 inline 轮廓。
- **loadVehicleJson**: outlineLocal 读取改为 `m.outline_local_mm (inline) 优先, fallback m.outline_path 文件`。向后兼容 车型C。

### 9.3 前端 app.js (doWizIntSave 重写, 对齐 doWizExtSave)
- 去掉所有 车型C 硬编码默认值 (224.796/-23.5/5.0/0.065/defaultRw)。
- 关键参数缺失防护: pivot/center_zero/width/height/yaw/pitch/eye_center/ground 任一 null → alert 提示缺哪个 + return (不保存)。**不再兜底默认值**。
- 单次 POST /api/interior/save {name, config: wizIntResult} (深拷贝, 设 vehicle.name)。**去掉 save-outline 第二步** (轮廓已 inline)。
- 成功 → initInnerDOM (若未初始化) + loadVehicles + 选中新车 + showPage('inner') + loadVehicleConfig + doVerify。
- bump app.js 缓存版本号。

### 9.4 验收
- 新提取内镜车型: /api/interior/save 保存 → /api/vehicles/config 读回 → mirror.outline_local_mm inline 存在 → doVerify 五线 5/5 PASS (与 车型C 基线一致)。
- 手动编辑: 内镜页改某参数 → /api/vehicles/save (合并模式) → 读回 inline 轮廓仍在, 五线仍 PASS。
- 车型C (outline_path 旧格式): loadVehicleConfig 仍能读 (fallback), 五线 PASS; 手动编辑 车型C 不丢 outline_path。
- doWizIntSave: 缺 width (模拟) → 阻止保存 + 提示, 不再用 224.796 兜底。
- 默认车型保护: /api/interior/save 覆盖 车型C → 400 拦截。
- npm test 全绿; 未改 engine。

## 约束
1. 禁止改 engine/**。
2. 后端只改 routes.js; 前端只改 app.js + (step_interior_extract.py)。
3. 旧 车型C.json 不动 (靠 fallback 兼容), 不迁移。
4. node -c + npm test 全绿。

## 执行顺序
9.1 (提取器 inline) → 9.2 (后端 save + loadVehicleJson 合并) → 9.3 (前端 doWizIntSave 重写) → 9.4 验收。

---

# 阶段 10 — 命名中文化 + 统一规范

> 用户决策(2026-08-13): 改用简洁中文命名, 内外镜一套规范, 必要处区分。保留旧名(车型C/英文)向后兼容。

## 新命名 (中文) + 别名兼容
每个参数按别名列表匹配, 命中任一即可。提取器解码 \X2\UTF16BE\X0\ + 容忍裸 UTF-8。

**通用(内外镜)**:
- 眼点左: [眼点左, EYE_LEFT, 左侧眼椭圆中心点]
- 眼点右: [眼点右, EYE_RIGHT, 右侧眼椭圆中心点]
  (内镜额外: 眼椭圆 → eye_center 直接用; 有眼点左/右则中点算 center + 距离算 IPD)
- 地面前: [地面前, GROUND_FRONT]
- 地面后: [地面后, GROUND_REAR]

**外镜专属**:
- 车门左: [车门左, DOOR_OUTER_LEFT]
- 车门右: [车门右, DOOR_OUTER_RIGHT]
- 镜体坐标系: AXIS2_PLACEMENT_3D 结构识别 (不变), 可选命名 [镜体左/镜体右]
- 镜面: SPHERICAL_SURFACE 几何识别 (不变)

**内镜专属**:
- 球铰: [球铰, MIRROR_PIVOT]
- 镜心: [镜心, MIRROR_CENTER_ZERO]
- 镜片面: [镜片, INNER_MIRROR_GLASS] + 兜底 内后视镜镜座总成/最大平面
- 后挡风面: [后挡风, REAR_WINDOW]
- 透光区面: [透光区, REAR_WINDOW_TZ]

## 实现

### 10.1 两个提取器 (step_interior_extract.py + step_exterior_extract.py)
- 新增共享 `decode_step_name(s)`: 解码 \X2\...\X0\ (UTF-16BE) → 中文; 容忍裸 UTF-8 (已是中文直接返回)。
- find_named_points / find_named_face 改用别名列表匹配: 名字 decode 后, 命中别名列表任一即认。
- 内镜眼点: 优先 眼点左/眼点右 (中点+IPD); fallback 眼椭圆 (center) + 左/右侧眼椭圆中心点 (IPD)。
- 保留所有现有启发式兜底 (无命名时)。
- 外镜提取器补 \X2\ 解码 (内镜已有, 复用)。

### 10.2 三份规范文档更新
- exterior-step-supplier-spec.md / interior-step-supplier-spec.md / supplier-step-annotation-spec.md
- 命名表改中文新名 (主), 注明旧名(英文/车型C)仍兼容。
- 自检清单用中文新名。

## 约束
1. 禁止改 engine/**。
2. 只改两个提取脚本 + 三份文档 (不改 routes/app/index)。
3. 旧名兼容: 车型C STEP (眼椭圆/内后视镜镜座/curb0 ground line) 仍能提取, 不强制重导。
4. node -c + npm test 全绿。

## 验收门槛
- 车型C 内镜 STEP: 眼点(眼椭圆 legacy)命中 0mm, 镜片面(镜座/最大平面)提取, 五线 5/5 PASS (注入 pivot/center_zero 后)。
- 外镜参数 STEP (data/tmp/axis-test.stp): 轴线 (AXIS2_PLACEMENT_3D) 提取不变, 眼点/地面/车门启发式命中 (该 STEP 无命名点)。
- 合成测试: 构造含中文新名(眼点左/球铰/镜片等, \X2\编码)的小 STEP → 提取命中。
- npm test 全绿。

## 执行顺序
10.1 (提取器别名+\X2\解码) → 10.2 (文档) → 验收 (车型C + axis-test + 合成中文)。

---

# 阶段 11 — 外镜二维调节校核 (上下+左右各 ±3°)

> 法规正确性修复: GB 15084 允许初始位置不满足视野时, 可"上下 + 左右"各 ±3° 调节后校核最佳视野。
> 现状引擎只绕一根轴(rotation_axis_dir, 上下调节)做一维 psi 搜索, 左右调节轴(fold_axis_dir)未建模。
> 这是 engine 层改动 (首次改引擎, 法规要求, 必须做)。

## 现状 (已确认)
- `ExteriorMirror` 只有一根轴 `turretAxisDir`(= rotation_axis_dir, ≈水平倾斜 22.7°/32.7°), `rotated(psi)` 绕单轴。
- `searchExteriorAngles` 一维 psi ∈ [-3,3] 步 0.5。
- `fold_axis_dir` 在 find_mirror_frames 返回里, 但 extract_exterior 输出没存 (只算了 axis_z_point), draft JSON 也没有该字段, 引擎完全没用。
- 两根轴实测: rotation_axis_dir(上下轴,≈Y倾斜) / fold_axis_dir(左右轴,≈整车Z偏0.31°)。

## 目标
绕两根正交轴 (上下轴 rotation_axis_dir + 左右轴 fold_axis_dir) 各 ±3° 做二维搜索, 找使 mirrorPass 的 (psi, theta)。

## 实现

### 11.1 提取器 step_exterior_extract.py
- extract_exterior 输出 `fold_axis_dir` 字段 (对称 rotation_axis_dir), 从 frame['fold_axis_dir'] 写进 mirrors[side]。
- 轴字段: turret_axis_p1 + rotation_axis_dir + fold_axis_dir + axis_y_point(=p1+0.1*rot) + axis_z_point(=p1+0.1*fold)。

### 11.2 引擎 exterior-mirror.js
- `ExteriorMirror` 构造函数加可选 `foldAxisDir` (默认 null), 存 this.foldAxisDir (normalize)。
- 新增 `rotated2D(psiDeg, thetaDeg)`: 先绕 turretAxisDir 转 psi(上下), 再绕 foldAxisDir 转 theta(左右); 两轴都是物理基准不随旋转变。foldAxisDir 为 null 时退化为 rotated(psi)。
- **保持 rotated(psiDeg) 单轴向后兼容** (test-exterior.js 现有 rotated(0)/rotated(90) 断言不能破坏)。
- `searchExteriorAngles`: 二维搜索。若 mirrorBase.foldAxisDir 存在 → psi×theta 各 [-3,3] 步 0.5 (13×13=169 档); 否则退化为现有单轴 psi 搜索 (向后兼容)。返回 {found, bestPsi, bestTheta, results (二维展平)}。

### 11.3 api-verify.js
- verifyOne 传 foldAxisDir = mir.fold_axis_dir (从车型 JSON 读; 缺省 null → 退化为单轴, 向后兼容 draft)。
- summary 的 search 字段加 bestTheta / window 描述。

### 11.4 draft JSON
- exterior_mirror_left/right 加 `fold_axis_dir` (从 _meta.axis_verified_2026_08_06 的 fold_axis_dir 拷贝)。

### 11.5 测试 engine/exterior/test-exterior.js
- 新增: rotated2D 绕两轴正确性 (绕上下轴 psi + 左右轴 theta 的复合)。
- 更新: searchExteriorAngles 二维搜索断言 (大帽面 ±3°×±3° 找到 PASS)。
- 保留: rotated 单轴断言不动。

## 验证 (重点)
1. 左镜: 加了左右调节, 窗口更大, 仍 PASS; bestPsi/bestTheta 记录。
2. **右镜: 加了左右调节, 结论可能翻转 (FAIL → PASS)** — 之前"右镜 FAIL 几何极限"是只考虑上下调节的结论, 左右调节可能覆盖近场 1m 宽地面。必须用 draft 数据验证右镜新结论, 如实报告。
3. 155 断言: test-inner(49) + test-sphere-fit(51) 不变; test-exterior(55) 更新后全绿。
4. npm test 全绿。

## 约束
1. 引擎可改 (法规要求), 但保持 rotated 单轴 + searchExteriorAngles 单轴退化路径向后兼容。
2. 提取器只改 step_exterior_extract.py; 引擎改 exterior-mirror.js + api-verify.js + test-exterior.js。
3. foldAxisDir 缺省 null → 完全向后兼容旧车型/draft。
4. 二维搜索 step 0.5, 169 档, 注意性能 (可接受)。

## 执行顺序
11.1 (提取器 fold_axis_dir) → 11.2 (引擎 rotated2D + 二维搜索) → 11.3 (api-verify 传参) → 11.4 (draft 字段) → 11.5 (测试) → 验证左右镜结论。

---

# 阶段 12 — 外镜自动搜角二维化 (应用 psi + theta)

> stage 11 收尾: 引擎二维搜索已返回 bestPsi+bestTheta, 但应用层仍是单 psi (verifyOne 只 rotated(psi), 前端只有一个 ψ 输入框, doExtAuto 只回填 ψ)。打通二维应用。

## 现状 (已确认)
- api-verify.js verifyOne(88行): `if (psi) mirror = mirror.rotated(psi)` 单轴应用; opts 只解构 psi。
- routes.js /api/exterior/verify(760): 只读 body.psi。
- 前端: index.html 只有 ext-psi 输入框; doExtVerify 只读 psi; doExtAuto 只回填 bestPsi。

## 实现

### 12.1 api-verify.js
- verifyOne 解构加 `theta = 0`; `if (psi || theta) mirror = mirror.rotated2D(psi, theta)` (theta 缺省 0 → rotated2D(psi,0) ≈ rotated(psi), 向后兼容)。
- verifyExteriorBoth 透传 opts (已透传)。

### 12.2 routes.js /api/exterior/verify
- 读 `body.theta` (Number.isFinite ? : 0), 传 verifyExteriorBoth({ psi, theta })。

### 12.3 index.html (外镜"调节角度"卡, ~616 行)
- 加 theta 输入框 ext-theta, 与 ext-psi 并列:
  - ψ 上下 (绕上下调节轴, title 说明) · θ 左右 (绕左右调节轴)
  - step 0.5, min -3, max 3, value 0

### 12.4 app.js
- doExtVerify: 读 ext-psi + ext-theta, verify 传 {psi, theta}。
- doExtAuto: commonSearch 的 bestPsi + bestTheta 都回填到输入框, 重新 verify 传两个; 状态文本显示 `已应用 ψ=..° θ=..°`。
- renderExtVerdict 的搜索窗口显示 (如有) 可含 theta, 不强求。

## 约束
1. 引擎 exterior-mirror.js 不动 (rotated2D 已就绪)。
2. theta 缺省 0 完全向后兼容。
3. 只改 api-verify.js + routes.js + app.js + index.html。

## 验收
- 后端: /api/exterior/verify 传 {psi:-1, theta:-2} vs {psi:-1} (theta=0), 左镜结果不同 (theta 生效); 缺 theta 时行为与改前一致。
- 前端: 两个输入框; doExtVerify 读两个; doExtAuto 回填 bestPsi+bestTheta 并重新 verify。
- 当前 draft 右镜 FAIL → commonSearch.found=false → doExtAuto 显示"无两镜都过的角度" (逻辑正确, 不崩)。
- 左镜手动设 psi=-1/theta=-2 → verify PASS。
- npm test 166 断言全绿。

## 执行顺序
12.1 → 12.2 → 12.3 → 12.4 → 验收。

---

# 阶段 14 — 校核页布局优化 (判据面板 + 角度卡同行)

> 用户反馈: 镜面角度卡(常驻)独占一整列(max-width:320px)右侧空白浪费; 坐标提示条(coord-bar)单独一行是否必要。想法: 把角度卡和 PASS 判据卡放同一行。

## 现状
内镜 inner-page + 外镜 exterior-page 布局一致:
- coord-bar (坐标提示条) 单独一行
- verdict (判据面板 PASS/FAIL) 单独一块
- param-row > col (镜面角度/调节角度卡, max-width:320px) 独占满宽 row, 右侧空白
- 折叠区 + 投影图

## 目标布局
```
顶栏
┌─────────────────────────────────────────────────────┐
│ 判据面板 (PASS/FAIL + 五线/左右徽章)   │ 角度卡      │  ← 同一行
│ flex-grow-1 占主体                    │ ~300px 固定  │
└─────────────────────────────────────────────────────┘
参数详情折叠头 + 折叠区
投影图
```
- 去掉 coord-bar 独立行, 坐标说明合并进判据面板(小字)
- 判据面板 + 角度卡用 flex 同行, 判据面板 flex-grow 占主体, 角度卡右侧固定宽

## 实现

### 14.1 index.html (inner-page + exterior-page)
- **删 coord-bar**: 两个页面的 `<div class="coord-bar">` 整段删除
- **判据面板 + 角度卡合并一行**: 用外层 flex 容器包裹 verdict + 角度卡:
  - 内镜: `<div class="d-flex gap-2 mb-2 align-items-stretch">` 包 `#verdict`(flex-grow-1) + 镜面角度卡(col → 独立 card)
  - 外镜: 同样包 `#ext-verdict` + 调节角度卡
  - 角度卡从 `param-row > col` 里**移出**, 改为独立 `<div class="card" style="width:300px;flex:none">` 放 flex 容器右侧
  - verdict 的 `mb-2` 去掉(现在在 flex 容器里), 角度卡 `h-100` 保证等高
- **坐标说明合并进判据面板**: 在 verdict-title 的 verdict-spec 后追加 `<span class="text-muted small">· 整车坐标系 (X+后 Y+右 Z+上) · mm</span>`(内镜) / 外镜同理
- **param-row 清空**: 原来的 `#param-row` / `#ext-param-row` 只剩角度卡, 移出后该 row 删掉(角度卡已在新 flex 容器)

### 14.2 约束
1. 不改 engine/、routes.js、app.js 的 JS 逻辑(只动 HTML 结构 + 可能 style.css)
2. **所有 input id 不变**(yaw/pitch/ext-psi/ext-theta/verify-btn 等), JS 引用不受影响
3. 判据面板内容(verdict-lines/verdict-failures/ext-verdict-edges 等)不动
4. 折叠区不动

## 验收
- 内镜页: 判据面板 + 镜面角度卡同行, 角度卡右侧固定宽, 无右侧空白; 坐标说明在判据面板内(非独立行)
- 外镜页: 同样
- 校核功能正常(改角度 → 校核 → 判定), 角度卡输入框/按钮都在
- `node -c public/app.js` 通过; npm test 166 全绿(未改引擎, 应不变)
- 浏览器目视: 布局合理, 无空间浪费

## 关键文件
- public/index.html — inner-page + exterior-page 布局重构
- public/style.css — (如需要) 判据面板内坐标小字样式

---

# 阶段 15 — 外镜校核性能优化 (search 分离)

> 用户反馈: 外镜校核页加载慢 + 调角度视图慢一步。根因: /api/exterior/verify 每次做二维搜索 searchExteriorAngles(13×13=169 档), 每档跑一次 verifyExterior, 左+右共 340 次, 总 4 秒。调角度/打开页面都触发这个搜索, 但其实只需要当前角度的校核。

## 现状
- verifyOne 每次都做 searchExteriorAngles(二维 169 档) + verifyExterior(当前角度)
- verifyExteriorBoth 左+右 = 340 次 verifyExterior ≈ 4 秒
- doExtVerify(校核) 和 doExtAuto(自动搜角) 都调 verify, 都触发 search
- 实测: verifyExteriorBoth 4090ms; 仅当前角度校核(不 search)约 24ms(快 170 倍)

## 优化方案
search 从 verify 分离: verify 默认只做当前角度校核(快), 自动搜角时才做二维搜索(慢但主动触发)。

## 实现

### 15.1 api-verify.js
- verifyOne 加 `search = false` 选项:
  - search=false(默认): 不做 searchExteriorAngles, 返回 `search: null`
  - search=true: 做 searchExteriorAngles, 返回 search 结果(现状)
- verifyExteriorBoth 透传 search 选项

### 15.2 routes.js /api/exterior/verify
- 读 `body.search`(bool, 默认 false), 传 verifyExteriorBoth({ psi, theta, search })

### 15.3 app.js
- **doExtVerify**: 传 `search: false`(快, 只做当前角度校核)
- **doExtAuto**: 
  - 第一次 verify 传 `search: true`(做二维搜索拿 commonSearch)
  - 第二次 verify(应用 bestPsi/bestTheta) 传 `search: false`(快)
- **renderExtVerdict**: 处理 search 为 null 的情况:
  - `r.search == null` → 不显示"±3° 有解/无解", 改为显示"自动搜角可查"(或省略)
  - `r.search` 有值 → 保持现状显示
  - 同样处理 ext-verdict-detail 里的 `d.left.search.found`(search 为 null 时不能读 .found)

### 15.4 可选: searchExteriorAngles 步长优化
- step 0.5 → 1.0(169 档 → 49 档), 自动搜角也更快。但会降低搜索精度, 暂不做(先做 search 分离)。

## 约束
1. 不改 engine/exterior-mirror.js(verifyExterior/searchExteriorAngles 逻辑不动)。
2. 改 api-verify.js + routes.js + app.js。
3. search 默认 false 向后兼容: 现有不传 search 的调用变为快(不做 search)。
4. npm test 全绿(verifyExterior/searchExteriorAngles 逻辑未动, 断言应不变)。

## 验收
- verifyExteriorBoth(path, {psi:0, theta:0}) 耗时从 ~4s 降到 ~30ms(search=false 时)
- verifyExteriorBoth(path, {psi:0, theta:0, search:true}) 仍 ~4s(二维搜索保留)
- 打开外镜页 + 调角度: 明显变快(只做当前角度校核)
- 自动搜角: 仍能搜到 bestPsi/bestTheta 并应用(二维搜索只在此时做)
- 判定面板: search 为 null 时不报错, 正常显示
- npm test 全绿

## 关键文件
- engine/exterior/api-verify.js — verifyOne 加 search 选项
- routes.js — /api/exterior/verify 读 body.search
- public/app.js — doExtVerify/doExtAuto 传 search + renderExtVerdict 处理 null
