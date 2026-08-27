const express = require('express');
const path = require('path');
const fs = require('fs');
const router = express.Router();

// ── 平台能力引入 ──
const { aiChat } = require('./shared/ai-proxy');

const DATA_DIR = path.join(__dirname, '..', '..', '..', 'data', 'headlight-eval');
fs.mkdirSync(DATA_DIR, { recursive: true });

// 安全：记录 id 仅允许字母/数字/_-，防止路径穿越
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

// ──────────────────────────────────────────────
// 系统提示词（评分标准 v2026.07 最新版 · 11项指标 · 1~5分制）
// ──────────────────────────────────────────────
const EVAL_SYSTEM_PROMPT = `你是一个专业的汽车前照灯主观评价AI。你的任务是根据用户提供的图片，严格按照评分标准进行打分。

## 你必须严格遵守的输出格式

请只输出一个 JSON 对象，不要输出任何其他文字、解释、markdown标记。格式如下：

{"score":N,"reason":"简短中文原因（30字以内）","confidence":M}

其中 N 为 1~5 的整数（5=优秀，4=良好，3=合格，2=差，1=极差）。
confidence 为你对本次评分的确信程度（1~100 的整数）：
- 80~100：非常确信，图片清晰、指标特征明确
- 50~79：比较确信，图片质量一般或指标特征不够突出
- 1~49：不太确信，图片模糊/拍摄角度不佳/指标难以判断

用户会提供具体的评分标准文本（criteria），请严格依据该标准打分。如果没有提供 criteria，则使用以下默认标准：

## 近光灯评价指标（10项）

### 均匀性（近光20%）
5分：两区完全一致，中心到边缘连续递减，零暗区零亮斑
4分：整体均匀，分区检查发现极轻微明暗差异，不影响整体感
3分：存在可见暗区，面积约 ≤ 光型面积1/8，对驾驶有轻微影响
2分：暗区明显，面积约1/4，左右亮度差异明显，影响局部照明
1分：大面积暗区或左右严重不对称，照明功能基本丧失

### 下边界整齐度（近光5%）
5分：截止线全程笔直如刀切，无拐角痕迹，下方边界绝对干净
4分：截止线整体笔直，拐角处有轻微痕迹但不突兀，下方边界整洁
3分：截止线有可见波浪起伏，拐角处痕迹较明显，下方有轻微晕染
2分：截止线弯曲或变形，拐角明显圆弧化，下方有明显向上晕染
1分：截止线不可辨，拐角完全圆弧化，下方大面积晕染

### 杂散光（近光10%）
5分：截止线上方完全纯黑，车头前方路面零泛白
4分：极微弱光晕（<1°），仔细观察才可察觉，路面基本干净
3分：可辨光晕带（1°~3°），路面有轻微泛白
2分：光晕带较宽（3°~5°），路面泛白发雾，致眩风险
1分：严重漏光，大面积光晕（>5°），致眩

### 眩目安全（近光8%）
5分：截止线高度控制极佳，上溢光线极微，对向驾驶员零致眩风险
4分：截止线高度控制良好，有极轻微上溢但不影响对向来车
3分：截止线高度略有偏高，上溢光线可辨，对向来车有轻微不适
2分：截止线高度明显偏高，上溢光线较宽，致眩风险较大
1分：截止线高度失控，大面积上溢光，严重致眩

### 近场暗区（近光5%）
5分：车头前均匀充足照明，零暗区，近场照度极佳
4分：近场整体可接受，有极轻微暗区
3分：暗区明显，近场照明偏弱，约2~5m区域偏暗
2分：明显暗区，近处看不清路面，存在安全隐患
1分：大面积死黑，近场照明严重缺失，安全隐患极大

### 左侧宽度（近光10%）
5分：路左侧远处清晰可辨，可视距离极远
4分：左侧可视基本充足
3分：左侧可视偏短，远处辨识度降低，有盲区
2分：路左侧几乎无可视，存在安全隐患
1分：路左侧无照明，严重安全隐患

### 右侧宽度（近光10%）
5分：50m外右侧充足，清晰可见，可视距离极远
4分：右侧可视基本充足
3分：右侧可视偏暗/不足，远处辨识度降低
2分：路右侧几乎无可视
1分：路右侧无照明，严重隐患

### 左侧照度（近光10%）
5分：5-50m左侧照度极高，清晰检测一切障碍物
4分：左侧基本覆盖，检测正常
3分：左侧偏暗，检测较困难
2分：左侧照度不足，检测困难
1分：左侧路面无照明

### 右侧照度（近光10%）
5分：5-50m右侧照度极高，检测能力优秀
4分：右侧基本覆盖，检测正常
3分：右侧偏暗，检测较困难
2分：右侧照度不足
1分：右侧路面无照明

### 光照度（近光12%）
5分：路面最大照度极高，光量充沛，强烈光明感
4分：照度足够，满足驾驶需求
3分：照度不足，光量偏暗
2分：照度明显不足，路面偏暗
1分：照度近乎为零，照明功能丧失

## 远光灯评价指标（6项）

### 均匀性（远光15%）—— 同近光标准

### 下边界整齐度（远光5%）
5分：截止线全程笔直如刀切，无拐角痕迹
4分：截止线整体笔直，拐角处有轻微痕迹但不突兀
3分：截止线有可见波浪起伏，拐角处痕迹较明显
2分：截止线弯曲或变形，拐角明显圆弧化
1分：截止线不可辨，拐角完全圆弧化

### 左侧照度（远光15%）
5分：90m内左侧照度极高，行人检测能力优秀
4分：左侧基本覆盖，检测正常
3分：左侧偏暗，检测能力下降
2分：左侧照度明显不足
1分：左侧路面无照明

### 右侧照度（远光15%）
5分：90m内右侧照度极高，行人检测能力优秀
4分：右侧基本覆盖，检测正常
3分：右侧偏暗，检测能力下降
2分：右侧照度明显不足
1分：右侧路面无照明

### 远度（远光40%）
5分：截止线远端扎实锐利，远处亮度无衰减，远近场梯度完美平滑
4分：远端略有软化但亮度充足，远近场梯度略陡但可接受
3分：远端偏暗，有轻微断尾，梯度偏陡
2分：远端消失/断裂，远处融入黑暗
1分：远端完全消失，光型严重缩短

### 远近光一致性（远光10%）
5分：90m处过渡极其平滑自然，远近光衔接无感
4分：基本自然，略有梯度但可接受
3分：梯度不均，近亮远暗较明显
2分：严重割裂，亮暗突兀
1分：完全割裂，远近光形同两个独立光型`;

// ──────────────────────────────────────────────
// API: 图片 AI 分析打分
// ──────────────────────────────────────────────
router.post('/api/analyze', express.json({ limit: '50mb' }), async (req, res) => {
  try {
    const { imageBase64, metric, lightType, criteria } = req.body;
    if (!imageBase64 || !metric) return res.status(400).json({ error: '缺少图片或指标类型' });

    const metricDesc = {
      uniformity: '【实物图 — 均匀性】（近光20%/远光15%）：请评估中心亮区明确度、亮度递减连续性、有无暗区或亮斑。必须分区检查左右两区。',
      cutoffLine: '【实物图 — 下边界整齐度】（近光5%/远光5%）：请评估截止线笔直度、拐角明显程度、下方边界整洁度。',
      strayLight: '【实物图 — 杂散光】（近光10%）：请评估截止线上方光晕宽度和亮度，以及车头前方路面是否有泛白发雾现象。',
      nearField: '【伪彩图 — 近场暗区】（近光5%）：请评估车头前2~5m区域的照度是否充足，有无明显暗区。',
      leftWidth: '【伪彩图 — 左侧宽度】（近光10%）：请评估路左侧可视距离和光型覆盖范围。',
      rightWidth: '【伪彩图 — 右侧宽度】（近光10%）：请评估路右侧可视距离和光型覆盖范围。',
      leftIlluminance: '【伪彩图 — 左侧照度】（近光10%/远光15%）：请评估左侧路面照度和障碍物检测能力。',
      rightIlluminance: '【伪彩图 — 右侧照度】（近光10%/远光15%）：请评估右侧路面照度和障碍物检测能力。',
      illuminance: '【伪彩图 — 光照度】（近光12%）：请评估路面最大照度，光量是否充沛。',
      distance: '【伪彩图 — 远度】（远光40%）：请评估截止线远端状态和远近场亮度梯度，观察伪彩图中光型的纵向延伸。',
      farNearConsistency: '【实物图 — 远近光一致性】（远光10%）：请评估90m处远近光过渡是否平滑自然，有无割裂感。',
      glare: '【实物图 — 眩目安全】（近光8%）：请评估截止线高度控制精度、上溢光线范围和亮度，判断对向驾驶员的致眩风险。截止线越高、上溢越宽 → 眩目风险越大。'
    };

    // 安全：只接受已知指标，拒绝任意 metric
    if (!metricDesc[metric]) return res.status(400).json({ error: '未知的指标类型' });

    const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, '');
    const isHighBeam = lightType === 'highbeam';

    const userPrompt = `请分析这张图片，针对以下指标打分：

${metricDesc[metric] || '请评估该指标表现。'}
${isHighBeam ? '(当前为远光灯评价)' : '(当前为近光灯评价)'}

${criteria ? '## 评分标准（请严格依据）\n' + criteria : ''}

评分区间：1~5分（5=优秀，4=良好，3=合格，2=差，1=极差）

请只输出 JSON：{"score":N,"reason":"原因","confidence":M}（M=1~100确信度）`;

    const reply = await aiChat({
      // 多模态图片分析须用 qwen2.5vl:7b（本地 Ollama 视觉模型）（规范 3.1，默认 ollama 为文本模型）
      model: 'qwen2.5vl:7b',
      messages: [
        { role: 'system', content: EVAL_SYSTEM_PROMPT },
        { role: 'user', content: [
          { type: 'text', text: userPrompt },
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64Data}` } }
        ]}
      ],
      stream: false
    });

    let result;
    const raw = reply.content || reply;
    try {
      result = typeof raw === 'string' ? JSON.parse(raw.trim()) : raw;
    } catch {
      const match = (typeof raw === 'string' ? raw : JSON.stringify(raw)).match(/\{[^}]*"score"\s*:\s*\d[^}]*\}/);
      if (match) result = JSON.parse(match[0]);
      else return res.json({ error: 'AI 未能返回有效评分，请重试', raw });
    }

    result.metric = metric;
    result.score = Math.max(1, Math.min(5, parseInt(result.score) || 2));
    result.confidence = Math.max(1, Math.min(100, parseInt(result.confidence) || 50));
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ──────────────────────────────────────────────
// API: 保存评价记录
// ──────────────────────────────────────────────
router.post('/api/save', express.json({ limit: '1mb' }), (req, res) => {
  try {
    const b = req.body || {};
    // 字段白名单：只接受评分相关字段，避免任意内容落盘
    const ALLOWED = ['name', 'type', 'scores', 'reasons', 'confidences', 'total', 'rating', 'penalties'];
    const record = {};
    for (const k of ALLOWED) if (k in b) record[k] = b[k];
    record.name = String(record.name || '').slice(0, 100);
    record.id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    record.user = req.user ? req.user.name : 'anonymous';
    record.user_id = req.user ? req.user.open_id : '';
    record.created_at = new Date().toISOString();
    const filePath = path.join(DATA_DIR, `${record.id}.json`);
    fs.writeFileSync(filePath, JSON.stringify(record, null, 2), 'utf-8');
    res.json({ success: true, id: record.id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ──────────────────────────────────────────────
// API: 查询历史记录
// ──────────────────────────────────────────────
router.get('/api/history', (req, res) => {
  try {
    const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.json')).sort().reverse();
    const records = files.slice(0, 50).map(f => {
      const d = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf-8'));
      return { id: d.id, name: d.name, rating: d.rating, created_at: d.created_at, user: d.user };
    });
    res.json(records);
  } catch (err) { res.json([]); }
});

// ──────────────────────────────────────────────
// API: 获取单条记录详情
// ──────────────────────────────────────────────
router.get('/api/record/:id', (req, res) => {
  try {
    if (!SAFE_ID.test(req.params.id)) return res.status(400).json({ error: 'invalid id' });
    const fp = path.join(DATA_DIR, `${req.params.id}.json`);
    if (!fs.existsSync(fp)) return res.status(404).json({ error: 'not found' });
    res.json(JSON.parse(fs.readFileSync(fp, 'utf-8')));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ──────────────────────────────────────────────
// API: 删除记录
// ──────────────────────────────────────────────
router.delete('/api/record/:id', (req, res) => {
  try {
    if (!SAFE_ID.test(req.params.id)) return res.status(400).json({ error: 'invalid id' });
    const fp = path.join(DATA_DIR, `${req.params.id}.json`);
    if (!fs.existsSync(fp)) return res.status(404).json({ error: 'not found' });
    // 归属校验：有属主的记录仅属主本人可删（匿名/无属主记录允许删除）
    const rec = JSON.parse(fs.readFileSync(fp, 'utf-8'));
    const uid = req.user ? req.user.open_id : '';
    if (rec.user_id && rec.user_id !== uid) return res.status(403).json({ error: '无权删除他人记录' });
    fs.unlinkSync(fp);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ──────────────────────────────────────────────
// 静态文件（放最后）
// ──────────────────────────────────────────────
router.use(express.static(path.join(__dirname, 'public')));
router.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'index.html')); });

module.exports = router;
