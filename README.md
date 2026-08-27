# 工程作品集 · 车灯领域 AI 工具集

四个围绕汽车灯具工程效率构建的系统，全部为**脱敏版本**（内部凭据/数据/公司信息已移除，大模型统一替换为本地 Ollama）。

| 目录 | 系统 | 技术栈 | 亮点 |
|---|---|---|---|
| [`fc-analyzer/`](fc-analyzer/) | FC 问题智能分析与工单提报系统 | Python/Flask + Node.js/Express | 一句话 → 24 字段抽取 → TF-IDF+8 维特征案例检索 → 分析报告 → 一键建单 |
| [`mirro-fov/`](mirro-fov/) | 内外后视镜视野法规校核系统 | 纯 JS 计算引擎 + Express + Plotly | GB 15084-2022 全量校核，170 项自动化断言 |
| [`headlight-eval/`](headlight-eval/) | 前照灯主观评价系统 | Express + Ollama 视觉模型 | 近光 10 项 / 远光 6 项加权标准 + AI 图片评分 |
| [`starry-tail-light/`](starry-tail-light/) | 星空尾灯数字孪生灯效设计器 | 单文件 HTML/Canvas | 460 LED 实时仿真 + 自然语言生成灯效 + 逐帧亮度矩阵导出 |

## 快速体验

```bash
# 星空尾灯（零依赖）：浏览器直接打开 starry-tail-light/星空尾灯大屏版.html

# FC 分析系统（Python 版）
cd fc-analyzer && pip install -r requirements.txt && python webapp/main.py

# 后视镜校核（需先按 mirro-fov/.../data/README.md 填入车型数据）
cd mirro-fov/modules/smart/mirro-fov && npm install && npm test
```

> AI 功能依赖本地 [Ollama](https://ollama.com)：`ollama pull qwen2.5:7b qwen2.5vl:7b`
