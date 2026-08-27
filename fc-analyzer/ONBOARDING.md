# 新用户首次配置指南

面向第一次在本机跑本工具的同事。全程约 5 分钟：装依赖 →（建议）配 .env → 启动 → 设 Token。

## 1. 安装依赖（必做）

需要 Python 3.9+（`python --version` 检查）。

```bash
pip install flask jieba
pip install cryptography   # 可选，启用 Token 落盘加密
```

## 2. 配置 .env（建议，密钥自己生成）

```bash
copy .env.example .env     # Mac/Linux 用 cp .env.example .env
```

| 项 | 建议 | 说明 / 生成方式 |
|----|------|----------------|
| `FLASK_SECRET_KEY` | 建议配 | `python -c "import secrets; print(secrets.token_hex(32))"` 生成后粘贴。不配则每次重启后需重填 Token |
| `TOKEN_ENCRYPTION_KEY` | 建议配 | `python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"` 生成后粘贴（需已装 cryptography） |
| `FEISHU_APP_ID` / `FEISHU_APP_SECRET` | 按需 | 仅当要看本地案例里的飞书问题图时才需要；团队共用凭据，找工具管理员要 |
| `LLM_*` | 不用配 | 预留项，当前版本纯规则运行，不读取这几项 |

具体改法（行号对应 `.env.example`，复制后的 .env 相同）：

1. 第 3/4 行 `FEISHU_APP_ID=` / `FEISHU_APP_SECRET=`：这两行本来没有 `#`，按需直接在等号后填值，不需要就留空
2. 第 7 行 `# FLASK_SECRET_KEY=`：要启用就删掉行首 `#`，等号后粘贴生成值
3. 第 11 行 `# TOKEN_ENCRYPTION_KEY=`：要启用就删掉行首 `#`，等号后粘贴生成值
4. 第 14–16 行 `# LLM_*`：保持 `#` 不动

注意：两个密钥**各自生成自己的**，不要复制别人的 `.env`（里面是真密钥）；`.env` 不要提交到 git。

## 3. 启动（必做）

```bash
python webapp/main.py --port 8080
```

浏览器打开 http://localhost:8080。

## 4. 设置 VIIM Token（必做，核心功能依赖）

「账号」页粘贴你个人的 VIIM Token 并保存，成功会显示你的姓名。

- Token 获取：登录 ticket.example.com → 个人设置 → Personal Access Token（没有就创建一个复制；入口找不到问工具管理员）
- Token 只存在你本机；装了 cryptography 则加密落盘
- 只用 CLI 脚本的同事可改设环境变量 `VIIM_API_TOKEN` 或 `~/.viim.env`，见 `scripts/viim_client.py` 头部说明

## 不需要配置的

- 知识库（116 条历史工单 / 关键词字典 / 根因模板）随文件夹 `database/` 自带，无需导入
- 草稿 / 提交记录 / Token 各自存在本机的 `webapp/database/`，互不影响，也不会被别人看到

## 症状 → 配置对照

| 症状 | 原因 / 配置 |
|------|------------|
| 重启后要重填 Token | 未设 `FLASK_SECRET_KEY` |
| 提示 Token 明文存储 | 未设 `TOKEN_ENCRYPTION_KEY` 或未装 cryptography |
| 本地案例的问题图不显示 | 未设 `FEISHU_APP_ID` / `FEISHU_APP_SECRET` |
| 打开功能页被带到账号页 | 尚未设置 Token，属正常首用流程 |
