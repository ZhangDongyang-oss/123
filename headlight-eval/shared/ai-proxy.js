/**
 * 本地 Ollama 客户端（脱敏版替代原平台 shared/ai-proxy）
 * aiChat({ prompt, imageBase64, model }) -> 模型文本回复
 * 依赖：本地运行 Ollama（默认 http://localhost:11434），视觉任务需视觉模型如 qwen2.5vl
 */
const http = require('http');

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';

function aiChat({ prompt, imageBase64, model = 'qwen2.5vl:7b', system = '' } = {}) {
  const url = new URL(OLLAMA_URL + '/api/chat');
  const message = { role: 'user', content: prompt };
  if (imageBase64) message.images = [imageBase64.replace(/^data:image\/\w+;base64,/, '')];
  const body = JSON.stringify({
    model,
    messages: (system ? [{ role: 'system', content: system }] : []).concat([message]),
    stream: false,
  });
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' } }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try { resolve(JSON.parse(data).message?.content || ''); }
        catch (e) { reject(new Error('Ollama 响应解析失败: ' + data.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.setTimeout(120000, () => req.destroy(new Error('Ollama 请求超时')));
    req.write(body);
    req.end();
  });
}

module.exports = { aiChat };
