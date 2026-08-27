# ECE R43 型式批准证书 - 字段提取指南

## 证书识别特征

满足以下任意2条即可识别为ECE R43证书：
- 文档包含 "Approval number" 字样
- 包含 "E*43R*" 格式编号（如 `E4*43R01/11*1289*36`）
- 文档含 "RDW" 字样（荷兰车辆监管局）或E4/E1/E2/E3国代号圆圈
- 含 "Regulation number 43" 或 "ECE-R43" 字样
- 含 "Type-approval" 字样

## 提取字段（2个）

### 字段1：产品名称

**提取位置**：
- **优先**：P1 "Class of safety glazing material" 字段（如 `Ordinary laminated-glass windscreen`）
- **补充**：P5 "Nominal thickness of the windscreen"（如 `4.76 mm`）

**字段名变体**（按优先级匹配）：
- `Class of safety glazing material`
- `Description of the type of glazing`
- `Nominal thickness of the windscreen`

**输出格式**：`<Class>，<厚度>mm`（如 `Ordinary laminated-glass windscreen，4.76 mm`）

---

### 字段2：证书签发日

**提取位置**：P4 "Date" 字段（第14项）

**字段名变体**：
- `Date`
- `Date of approval`

**注意区分**：
- **证书签发日**（Date，第14项）→ 校核用
- 最新测试日（P13 Test date最后一行）→ **不校核**，但可备注
- 历次展期日（P2-P3的日期列表）→ **不校核**

**日期格式**：英文月份格式（如 `01 January 2025`），需转为 `YYYY-MM-DD`（如 `2025-01-01`）。

---

## ECE证书结构图（参考）

```
P1: 证书首页（识别证书类型 + 提取Class）
P2-P3: 历次展期日期列表（不提取）
P4: 证书签发日（Date，第14项）
P5-P7: Principal Characteristics（产品参数，不校核）
P8-...: 测试报告详情（不校核）
```

**核心校核只需读 P1 + P4 即可**，其余页面可跳过以节省token。

---

## 典型ECE证书样本（已验证）

DRE工作流中的样本：
- `samples/E4-43R01-11-1289-36（P011）.pdf` — 荷兰RDW签发的ECE R43型式批准证书
