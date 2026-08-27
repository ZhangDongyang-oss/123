# 外后视镜 (GB 15084 II/III 类) 数据采集清单

> **用途**: 外后视镜视野校核引擎的人工输入采集表单。引擎已实现 (`engine/exterior/`), 缺真实数据。
> **状态**: **供应商数据请求已发出** (2026-08-05) 🔴 等待交付 | 车型待定, 定点后按此模板交付
> **坐标系**: 整车坐标系 (X+=后方, Y+=乘客右, Z+=向上), 长度 m (供应商给 mm, 入库前转 m)
> **采集原则**: **全部点坐标** — 不读法线/朝向等复合特征; 球心/帽心/朝向全部由点推导

---

## 0. 核心认知 (先读, 避免误解)

外后视镜是**凸球面镜**, 与内后视镜 (平面镜) 建模本质不同:

| | 内后视镜 (平面镜) | 外后视镜 (凸球面镜) |
|--|--|--|
| 形状 | 平面 + 球铰 | 球面上切下的"帽" |
| 调节 | yaw/pitch 两角 | 绕转向器轴线旋转 |
| 球心 | 无 | **有** (球面反射法线全靠它) |

**球心不直接采信**: 由轮廓点拟合求出 (`engine/exterior/sphere-fit.js`), 供应商若提供球心**仅作交叉校核**。
**镜面朝向不手量**: `朝向 = normalize(帽面中心 − 球心)`。
**供应商球心不能直接用的原因**: 它对应设计 SR, 而校核用 SR 上限 (更平), 两者模型不一致; 拟合值才是与轮廓自洽的球心。

---

## 1. 已发出的供应商请求 (2026-08-05)

> 原文 (车型待定, 定点后按此模板交付):

```
请提供以下数据 (整车坐标系, 单位 mm; 请注明坐标系原点及 X/Y/Z 正方向、左/右驾):

1. 车门最外点: 左右各 1 点
2. 反射面轮廓点: 左右各 5 点 (在镜面反光面上、沿外沿分散; 请确认镜片为单球面)
3. 镜片曲率半径 SR: 设计值 + 制造公差 (如 1260±60)
4. 转向器轴线点: 左右各 2 点 (两点尽量沿轴向拉开)
5. 驾驶员左、右眼点: 请注明定义依据 (GB 15084/ECE R46)
6. 地面点 2 个 (或说明坐标系 Z=0 即为地面)
7. 镜面球心 (可选): 如有请一并提供, 我方用作轮廓拟合的交叉校核
```

**各项说明**:

| # | 数据 | 引擎字段 | 说明 |
|---|------|---------|------|
| 1 | 车门最外点 (左右各1) | `door_panel.door_outer_Y` | 只用其 **Y 坐标**; 口径=车门蒙皮主面最外点 (已确认 2026-08-13, 供应商确认; 非车身包络/含凸出) |
| 2 | 轮廓点 (左右各5) | `outline` | **在反光面上** (不是壳体)、沿外沿分散; 4 点最少, 5 点超定拟合更稳 |
| 3 | SR 设计值+公差 | `radius` 推导 | **关键**: 拟合用设计值; 校核用 `设计值+公差上限` (最平=视野最小的最坏情况)。车型A 曾假设 1260±60, 新车型以供应商答复为准 |
| 4 | 轴线 2 点 (左右各2) | `turret_axis_p1/p2` | 两点定线, 距离拉开方向才准; 左右镜各有一条轴线 |
| 5 | 左右眼点 | `driver.eye_center/ipd` | `eye_center = 中点`, `ipd = 两点距离`; 需注明定义依据 + 左/右驾 |
| 6 | 地面 2 点 | `ground.front_mid/rear_mid` | 建立地平面 (车型A 原点不在地面, Z≈0.19, 不能假设 Z=0); 若供应商确认 Z=0 即地面则免 |
| 7 | 球心 (可选→**强烈建议**) | — | **不进引擎**, 只作交叉校核 (`crossCheck`, 容差 5mm); 是 planar-cut 盲区 (SR 错→球心静默平移, 残差恒0) 的**唯一防线** |

**另需供应商确认**: 镜片为**单球面** (非双曲率/非球面, 否则单球模型不成立)。

---

## 2. 球心拟合 — 两条路径 (已实现 `engine/exterior/sphere-fit.js`)

轮廓是球面帽的边界曲线, 工程上有两种形态, `fitSphereFromOutline(points, {srDesign, eye})` 自动检测分支:

### A. 轮廓非共面 (点到最佳平面 RMS > 0.5mm)
- 代数球拟合: 等距关系定球心, **与 SR 无关** (SR 只做一致性核对)
- 4 点唯一解, 5 点超定; 无球前/球背二义性

### B. 轮廓共面 (帽由平面切割 — 常见!)
- 等距方程组秩亏, 朴素线性解法**奇异无解**, 必须走:
  面内圆拟合 (O, r) → `h = √(srDesign² − r²)` → `球心 = O − h·n̂_eye`
- `n̂_eye` = 指向眼点一侧的平面法线 (凸球球心在镜面背面, 与眼点异侧)
- **必需 srDesign (设计值) + 眼点**; r ≥ SR 时抛错 (数据/坐标系有误)

### SR 约定 (勿混淆)
```
srDesign  = 供应商设计值          → 拟合用 (轮廓点物理上在设计曲面上)
srVerify  = srDesign + 公差上限    → 校核用 (最平 = 视野最小, 如 1260+60=1320)
拟合得球心 C 后: projectToSphere(outline, C, srVerify)
  = 轮廓点沿径向投到 srVerify 球面 (角范围不变, 只改曲率)
```

### 防御 (数据到达时自动检查)
- 点共线 → 抛错 "请沿外沿分散取点"
- r ≥ SR / 拟合半径偏离 SR>10mm / 球面度残差>1mm → 警告 (疑选到壳体或 SR 错误)
- 眼点距轮廓平面 <10mm → 定侧不可靠警告

### 数据自洽性: "轮廓点在不在球心定义的球面上?"
- **一致性闸门** `validateOutlineOnSphere(outline, center, radius)`: 逐点偏差 |P−C|−R,
  maxDev > 1mm → 拦截 (常见原因: 轮廓选到壳体 / 球心与轮廓不同版本 / 坐标系或单位错)
- **供应商球心交叉校核** `fitSphereFromOutline(..., {supplierCenter})` →
  `crossCheck = {devMm, impliedRadius, srDevMm, ok}`: 球心偏差 ≤5mm 且隐含半径与 SR 差 ≤10mm。
  不过 → 警告但仍**以轮廓拟合为准** (轮廓才定义镜面范围), 提示核查供应商数据
- ⚠️ **planar-cut 盲区**: 共面轮廓下 SR 错了残差也恒为 0 — 点恰在 (C_fit, srDesign) 球面上,
  球心只是沿面法线静默平移 Δh (SR 错 60mm → 平移 ~60mm), 闸门也放行。
  **此盲区唯一防线 = 供应商球心交叉校核** (这就是请求单里"球心(可选)"的实际作用, 务必拿到)

**测试**: `node engine/exterior/test-sphere-fit.js` (51 断言: 两路径回推已知球心误差 <1e-8m,
σ=0.05mm 噪声下 <1mm, 一致性闸门, planar-cut 盲区双信号报警)

---

## 3. 数据 JSON schema (供应商数据到达后填入)

```json
{
  "driver":  { "eye_center": [0,0,0], "interpupillary_distance": 0.065 },
  "ground":  { "front_mid": [0,0,0], "rear_mid": [0,0,0] },
  "door_panel": { "door_outer_Y": 0 },

  "exterior_mirror_left": {
    "sr_design": 1.260,        // 供应商设计值 (拟合用)
    "sr_tolerance": 0.060,     // 公差 → radius = sr_design + sr_tolerance (校核上限)
    "outline_raw": [[0,0,0], [0,0,0], [0,0,0], [0,0,0], [0,0,0]],  // 5 轮廓点 (mm→m)
    "turret_axis_p1": [0, 0, 0],
    "turret_axis_p2": [0, 0, 0],
    "supplier_sphere_center": [0, 0, 0]   // 可选, 仅交叉校核
  },

  "regulation": {
    "mirror_class": "III",      // 本车 III 类; 引擎按此字段语义工作 (参数化, II 类亦可切换)
    "width_near": 1.0, "width_far": 4.0,
    "dist_near": 4.0,  "dist_far": 20.0,
    "margin_mm": 3.0,  "adjust_deg": 3.0
  }
}
```

> **引擎读取**: `buildTriangles` 直接读 `dist_near/width_near/dist_far/width_far` 构造地面三角形
> (缺省即 III 类: 近 1m 宽 @ 眼后 4m / 远 4m 宽 @ 眼后 20m, 与 GB 15084-2022 III 类一致)。
> 基准 Y = `door_panel.door_outer_Y` (口径=车门蒙皮主面最外点, 已确认 2026-08-13)。

**引擎推导 (采集后自动算, 不手填)**:
- `sphere_center` = `fitSphereFromOutline(outline_raw, {srDesign: sr_design, eye: eye_center}).center`
- `radius` = `sr_design + sr_tolerance` (= srVerify)
- `outline` = `projectToSphere(outline_raw, sphere_center, radius)`
- 帽心/朝向 = ExteriorMirror 构造器内由球心+轮廓推出
- `turret_axis_dir` = `normalize(p2 − p1)`; `turret_axis_point` = `p1`

> 右镜 (`exterior_mirror_right`) 同结构; 范围上先做左镜 (LHD, Y−)。

---

## 4. 供应商数据到达后的流程

```
1. 核对坐标系 (原点/X+方向/单位) — 引擎用 X+=后方, 若供应商 X+=前方需整体翻转 X
2. mm → m
3. 眼点: 左右眼 → eye_center=中点, ipd=距离
4. 地面: 2 点 → ground.front_mid/rear_mid (或确认 Z=0 即地面)
5. 拟合: fitSphereFromOutline(轮廓, {srDesign, eye, supplierCenter}) → 看 method/warnings/残差/crossCheck
6. 一致性闸门: validateOutlineOnSphere(轮廓, 球心, SR) — 进引擎前最后一道关
7. 填 JSON → verifyExterior / searchExteriorAngles (API 路由待做)
```

> crossCheck 未通过不阻塞拟合 (以轮廓为准), 但**必须人工核查供应商数据**后再入库。

---

## 5. 待办 (按优先级)

- 🔴 **等供应商数据** + 车型定点 (含左/右驾)
- 🟡 三角形顶点 T = 镜面 Z 最高点沿 X 投影 — 法规判读确认
- 🟢 API: `/api/exterior-verify` + `/api/exterior-search` 路由
- 🟢 前端: landing 外镜卡片启用 + 外镜参数页
- 🟢 3DE: 扩展 `catia_extract` 读外镜参数 (若后续改自测)
- 🟢 真实车型数据下的 PASS 验证
