/**
 * 本地测试服务器 — 独立运行
 * 启动: node _test_server.js
 * 访问: http://localhost:3000
 *
 * 同时挂载两个路径:
 *   /         — 本地独立开发 (直接访问)
 *   /mirro-fov — 模拟平台挂载 (与生产环境一致)
 */
const express = require('express');
const app = express();

const mirroFovRoutes = require('./routes');

// 挂载到两个路径: 本地开发用 /, 生产环境用 /mirro-fov
app.use('/', mirroFovRoutes);
app.use('/mirro-fov', mirroFovRoutes);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[test-server] mirro-fov 已启动`);
  console.log(`[test-server] 本地访问: http://localhost:${PORT}/`);
  console.log(`[test-server] 平台路径: http://localhost:${PORT}/mirro-fov/`);
  console.log(`[test-server] Ctrl+C 停止`);
});
