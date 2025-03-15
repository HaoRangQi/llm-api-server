# 多模型 API 服务器

兼容 OpenAI API 格式的多模型 API 服务器，支持 Claude、DeepSeek-R1 以及混合模式。

## 功能特点

- 支持 Claude 3.5/3.7 Sonnet 模型
- 支持 DeepSeek R1 模型（**包含思考过程输出**）
- 支持 DeepClaude 混合模型（DeepSeek 思考 + Claude 回答）
- 兼容 OpenAI API 格式
- 支持流式输出
- 可配置温度和最大 token 数量
- 全面的配置文件支持

## 安装

1. 安装依赖：
```bash
npm install
```

2. 配置服务器：
   - 修改 `config.yaml` 文件配置服务参数
   - 可以通过环境变量覆盖配置

3. 启动服务器：

```bash
# 开发模式
npm run dev

# 生产模式 (使用PM2)
npm run prod

# 查看日志
npm run logs

# 重新加载
npm run reload

# 停止服务
npm run stop
```

## 配置文件说明

配置文件 `config.yaml` 包含以下主要部分：

```yaml
# 服务器配置
server:
  port: 3000
  debug_mode: false
  debug_level: 2  # 1-简单, 2-详细, 3-全部

# Claude API配置 
claude:
  api_url: "https://llm.zed.dev/completion"
  models:
    - "claude-3-7-sonnet-latest"
    - "claude-3-5-sonnet-latest"
  api_key: ""  # 直接配置API密钥
  api_key_path: "/Users/macos/Downloads/eatworld/cursor/zedproxy/auth/api_tokens.txt"  # 或从文件读取

# DeepSeek API配置
deepseek:
  api_domain: "https://ai-api.dangbei.net"
  timeout_ms: 30000
```

## API 说明

### 1. 获取支持的模型列表
```bash
curl http://localhost:3000/v1/models
```

### 2. 使用 Claude 模型进行聊天
```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-3-7-sonnet-latest",
    "messages": [
      {"role": "user", "content": "你好，介绍一下自己"}
    ]
  }'
```

### 3. 使用 DeepSeek 模型（流式输出，包含思考过程）
```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-r1",
    "messages": [
      {"role": "user", "content": "你好，介绍一下自己，10字"}
    ],
    "stream": true
  }'
```

### 4. 使用混合模型 DeepClaude
```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepclaude",
    "messages": [
      {"role": "user", "content": "你好，介绍一下自己，10字"}
    ]
  }'
```

## DeepSeek-R1 模式说明

DeepSeek-R1 模型现在会显示思考过程，格式为：

```
<思考过程>
[思考内容]
</思考过程>

[最终回答内容]
```

## 部署说明

### 使用PM2部署
项目已集成PM2配置，可直接使用以下命令部署：

```bash
# 安装全局PM2（如果尚未安装）
npm install -g pm2

# 生产环境启动
npm run prod  

# 设置开机自启
pm2 startup
pm2 save
```

### 使用Docker部署
1. 创建Dockerfile
2. 构建并运行容器
3. 可选：使用Docker Compose进行更灵活的配置

### 使用Nginx反向代理
建议在前端配置Nginx反向代理，以提供SSL和负载均衡能力。 