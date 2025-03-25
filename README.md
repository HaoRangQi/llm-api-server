# 多模型 API 服务器

兼容 OpenAI API 格式的多模型 API 服务器，支持 Claude、DeepSeek-R1 以及混合模式。

## 功能特点

- 支持 Claude 3.5/3.7 Sonnet 模型
- 支持 DeepSeek R1 模型（**包含思考过程流式输出**）
- 支持 DeepClaude 混合模型（DeepSeek 思考 + Claude 回答）
- 兼容 OpenAI API 格式
- 完整的流式输出支持（SSE）
- 模块化代码结构，易于维护和扩展
- 可配置温度和最大 token 数量
- 全面的配置文件支持和详细日志记录
- API令牌管理接口，方便更新模型访问密钥

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
  admin_key: "your-admin-key"  # 管理接口验证密钥

# Claude API配置 
claude:
  api_url: ""
  models:
    - "claude-3-7-sonnet-latest"
    - "claude-3-5-sonnet-latest"
  provider: "anthropic"
  api_key: ""  # 直接配置API密钥
  api_key_path: "/path/to/api_tokens.txt"  # 或从文件读取

# DeepSeek API配置
deepseek:
  api_domain: ""
  user_agent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"
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
    ],
    "stream": true
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
# 流式输出 (默认)
curl http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepclaude",
    "messages": [
      {"role": "user", "content": "你好，介绍一下自己，10字"}
    ],
    "stream": true
  }'

# 非流式输出
curl http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepclaude",
    "messages": [
      {"role": "user", "content": "你好，介绍一下自己，10字"}
    ],
    "stream": false
  }'
```

### 5. 管理接口 - 更新API令牌 (需管理员权限)

此接口用于批量更新API令牌文件，需要提供管理密钥进行身份验证。支持两种请求格式。

#### 简单格式 (推荐)
```bash
curl http://localhost:3000/admin/update-tokens \
  -H "Content-Type: application/json" \
  -H "x-admin-key: your-admin-key" \
  -d '{
    "api_tokens": [
      "your-api-key-value-1", 
      "your-api-key-value-2"
    ]
  }'
```

在简单格式中，只需提供令牌值数组，系统会自动生成唯一的文件名。

#### 详细格式 (自定义文件名)
```bash
curl http://localhost:3000/admin/update-tokens \
  -H "Content-Type: application/json" \
  -H "x-admin-key: your-admin-key" \
  -d '{
    "tokens": [
      {
        "name": "claude_api_key",
        "value": "your-api-key-value"
      },
      {
        "name": "deepseek_api_key",
        "value": "another-api-key-value"
      }
    ]
  }'
```

在详细格式中，可以为每个令牌指定自定义的名称，这将决定保存的文件名。

#### 请求说明:
- 简单格式: `api_tokens` 数组中直接提供令牌值，系统自动生成文件名
- 详细格式: `tokens` 数组中提供 `name`（文件名）和 `value`（令牌值）

#### 响应格式:
```json
{
  "status": "success",
  "results": [
    {
      "name": "claude_api_key",
      "success": true,
      "path": "/path/to/tokens/claude_api_key.token"
    },
    {
      "name": "api_token_1688997654321_a1b2c3",
      "success": true,
      "path": "/path/to/tokens/api_token_1688997654321_a1b2c3.token"
    }
  ]
}
```

#### 安全说明:
- 管理密钥可通过`ADMIN_KEY`环境变量或`config.yaml`中的`server.admin_key`设置
- 当只有一个令牌时，将直接写入到`config.yaml`中`claude.api_key_path`指定的路径
- 当有多个令牌时，将保存在`api_key_path`所在目录的`tokens`子目录下
- 文件名会进行安全处理，移除不安全字符
- 此接口仅供管理员使用，确保管理密钥安全

#### 用途:
此接口主要用于在服务器运行时动态更新API密钥，无需重启服务。这对于以下场景特别有用：
- API密钥轮换
- 多模型支持时批量更新多个密钥
- 通过其他系统自动更新密钥

## 响应格式说明

### 非流式响应格式
```json
{
  "id": "uuid",
  "object": "chat.completion",
  "created": 1698765432,
  "model": "model-name",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "回答内容..."
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 123,
    "completion_tokens": 456,
    "total_tokens": 579
  }
}
```

### 流式响应格式 (SSE)
```
data: {"id":"uuid","object":"chat.completion.chunk","created":1698765432,"model":"model-name","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}

data: {"id":"uuid","object":"chat.completion.chunk","created":1698765432,"model":"model-name","choices":[{"index":0,"delta":{"content":"回答"},"finish_reason":null}]}

data: {"id":"uuid","object":"chat.completion.chunk","created":1698765432,"model":"model-name","choices":[{"index":0,"delta":{"content":"内容"},"finish_reason":null}]}

data: {"id":"uuid","object":"chat.completion.chunk","created":1698765432,"model":"model-name","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

data: [DONE]
```

## 模型特点说明

### DeepSeek-R1 
DeepSeek-R1 模型默认启用思考过程，格式为：

```
<思考过程>
[思考内容详情...]
</思考过程>

[最终回答内容]
```

### DeepClaude 混合模型
DeepClaude 混合模式结合了 DeepSeek 的思考能力和 Claude 的回答能力：

1. 首先完整获取 DeepSeek 的思考内容（流式显示）
2. 思考内容收集完毕后，将完整思考内容传递给 Claude
3. Claude 基于完整思考内容生成最终回答（流式显示）

该模型**同时支持流式和非流式输出**：
- 流式模式下，实时展示思考过程和回答内容
- 非流式模式下，等待完整思考和回答后一次性返回结果

所有模型均支持完整的流式输出，提供更好的用户体验。

## 代码结构

服务器采用模块化设计，主要文件包括：

- `api-server.js` - 主入口文件，处理HTTP请求和路由
- `models/claude-model.js` - Claude模型处理模块
- `models/deepseek-model.js` - DeepSeek模型处理模块
- `models/deepclaude-model.js` - DeepClaude混合模型处理模块

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

## 性能优化

- 所有请求默认启用流式输出，提供更好的用户体验
- 思考内容实时流式显示，无需等待完整内容
- 优化了错误处理和降级策略
- 添加了请求超时设置，避免长时间阻塞

## 常见问题

### 1. 创建DeepSeek会话失败
请检查配置文件中DeepSeek的API域名和User-Agent设置是否正确。

### 2. Claude API密钥无效
请确保提供了有效的Claude API密钥，可以直接在配置文件中设置，或者通过文件路径指定。

### 3. 流式输出不工作
请确保客户端支持SSE（Server-Sent Events）格式，并正确处理流式响应。 