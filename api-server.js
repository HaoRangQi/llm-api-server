#!/usr/bin/env node
/**
 * 多模型API服务器
 * =========================================================
 * 提供兼容OpenAI格式的API，支持Claude和DeepSeek模型调用
 * 
 * 主要功能:
 * - 提供统一的API接口格式
 * - 支持多种AI模型
 * - 支持流式和非流式输出
 * - 包含调试和监控功能
 */

import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import fs from 'fs';
import crypto from 'crypto';
import fetch from 'node-fetch';
import axios from 'axios';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';
import os from 'os';

// 加载环境变量
dotenv.config();

// 获取当前文件的目录路径
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * 加载配置文件
 * 尝试从当前目录下的config.yaml加载配置
 * 如果失败则终止程序
 */
let config;
try {
  const configFile = fs.readFileSync(path.join(__dirname, 'config.yaml'), 'utf8');
  config = yaml.load(configFile);
  console.log('成功加载配置文件');
} catch (e) {
  console.error('加载配置文件失败:', e);
  process.exit(1);
}

// 服务器全局配置
const PORT = process.env.PORT || config.server.port;
const DEBUG_MODE = process.env.DEBUG_MODE === 'true' || config.server.debug_mode;
const DEBUG_LEVEL = config.server.debug_level || 1;

// Claude 配置
const CLAUDE_API_URL = config.claude.api_url;
const CLAUDE_MODELS = config.claude.models;
const CLAUDE_DEFAULT_MODEL = CLAUDE_MODELS[0];
const CLAUDE_PROVIDER = config.claude.provider;
const CLAUDE_API_KEY = config.claude.api_key;
const CLAUDE_API_KEY_PATH = config.claude.api_key_path;

// DeepSeek 配置
const DS_API_DOMAIN = config.deepseek.api_domain;
const DS_USER_AGENT = config.deepseek.user_agent;
const DS_TIMEOUT_MS = config.deepseek.timeout_ms || 30000;

// 创建 Express 应用
const app = express();

// 使用中间件
app.use(cors());
app.use(bodyParser.json());

/**
 * 调试日志函数
 * 根据当前调试级别输出不同详细程度的日志
 * 
 * @param {number} level 日志级别（1-3）
 * @param {string} type 日志类型
 * @param {...any} args 日志内容
 */
function debugLog(level, type, ...args) {
  if (DEBUG_MODE && level <= DEBUG_LEVEL) {
    const typeColors = {
      INFO: "\x1b[36m", // 青色
      DEBUG: "\x1b[33m", // 黄色
      ERROR: "\x1b[31m", // 红色
      API: "\x1b[35m",   // 紫色
      WARN: "\x1b[33m"   // 黄色
    };
    
    const color = typeColors[type] || "\x1b[33m";
    console.log(`${color}[${type}]\x1b[0m`, ...args);
  }
}

/**
 * 获取Claude API密钥
 * 优先使用配置直接提供的API密钥
 * 如果未配置直接密钥或为空，则尝试从文件读取
 * 
 * @returns {string|null} API密钥或null（获取失败）
 */
function getClaudeApiKey() {
  // 优先使用直接配置的API密钥（确保不为空字符串）
  if (CLAUDE_API_KEY && CLAUDE_API_KEY.trim() !== '') {
    debugLog(2, "INFO", "使用配置中的API密钥");
    return CLAUDE_API_KEY.trim();
  }
  
  // 其次尝试从文件读取
  try {
    const tokenPath = CLAUDE_API_KEY_PATH;
    debugLog(2, "INFO", `尝试从文件读取API密钥: ${tokenPath}`);
    
    // 确保文件路径不为空
    if (!tokenPath || tokenPath.trim() === '') {
      throw new Error("API密钥文件路径未配置");
    }
    
    // 检查文件是否存在
    if (!fs.existsSync(tokenPath)) {
      throw new Error(`API密钥文件不存在: ${tokenPath}`);
    }
    
    const content = fs.readFileSync(tokenPath, 'utf8');
    const apiKey = content.trim();
    
    // 确保读取的内容不为空
    if (!apiKey) {
      throw new Error("API密钥文件内容为空");
    }
    
    debugLog(1, "INFO", "成功从文件读取API密钥");
    return apiKey;
  } catch (error) {
    console.error('无法获取Claude API密钥:', error.message);
    return null;
  }
}

// ===== DeepSeek 辅助函数 =====

/**
 * 生成设备ID
 * 为DeepSeek API创建唯一设备标识
 * 
 * @returns {string} 生成的设备ID
 */
function generateDeviceId() {
  // 使用randomBytes代替randomUUID，因为randomUUID在Node.js 15.6.0及以上版本才可用
  const bytes = crypto.randomBytes(16);
  // 设置UUID版本为4（随机）
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  // 设置变体位
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  
  const uuid = bytes.toString('hex').match(/(.{8})(.{4})(.{4})(.{4})(.{12})/).slice(1).join('-');
  const nanoid = generateNanoId(20);
  return `${uuid.replace(/-/g, "")}_${nanoid}`;
}

/**
 * 生成随机ID
 * 用于创建nonce和设备ID组件
 * 
 * @param {number} size ID长度
 * @returns {string} 生成的随机ID
 */
function generateNanoId(size = 21) {
  const urlAlphabet = "useandom-26T198340PX75pxJACKVERYMINDBUSHWOLF_GQZbfghjklqvwyzrict";
  let id = "";
  const bytes = crypto.randomBytes(size);
  for (let i = 0; i < size; i++) {
    id += urlAlphabet[bytes[i] & 63];
  }
  return id;
}

/**
 * 生成签名
 * DeepSeek API请求需要的签名生成
 * 
 * @param {string} timestamp 时间戳
 * @param {object} payload 请求负载
 * @param {string} nonce 随机数
 * @returns {string} 生成的签名
 */
function generateSign(timestamp, payload, nonce) {
  const payloadStr = JSON.stringify(payload, null, 0);
  const signStr = `${timestamp}${payloadStr}${nonce}`;
  const sign = crypto.createHash("md5").update(signStr).digest("hex").toUpperCase();
  debugLog(3, "DEBUG", "Sign Generation:", { timestamp, nonce, payloadStr, signStr, sign });
  return sign;
}

/**
 * 创建DeepSeek对话
 * 在获取回答前需要先创建会话
 * 
 * @param {string} deviceId 设备ID
 * @returns {string} 会话ID或空字符串（失败时）
 */
async function createConversation(deviceId) {
  const payload = { botCode: "AI_SEARCH" };
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = generateNanoId(21);
  const sign = generateSign(timestamp, payload, nonce);

  const headers = {
    Origin: "https://ai.dangbei.com",
    Referer: "https://ai.dangbei.com/",
    "User-Agent": DS_USER_AGENT,
    deviceId: deviceId,
    nonce: nonce,
    sign: sign,
    timestamp: timestamp,
    "Content-Type": "application/json",
  };

  const apiUrl = `${DS_API_DOMAIN}/ai-search/conversationApi/v1/create`;
  
  debugLog(1, "INFO", `创建DeepSeek对话: ${apiUrl}`);
  debugLog(3, "API", "Create Conversation Request:", {
    url: apiUrl,
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });

  try {
    // 创建对话请求
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), DS_TIMEOUT_MS);
    
    const response = await fetch(apiUrl, {
      method: "POST",
      headers: headers,
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    
    clearTimeout(timeoutId);

    const responseText = await response.text();
    debugLog(3, "API", "Create Conversation Response:", {
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      body: responseText,
    });

    if (!response.ok) {
      console.error(`Error: ${response.status}`);
      console.error(responseText);
      debugLog(1, "ERROR", `创建对话失败: ${response.status}`, responseText);
      debugLog(1, "ERROR", `请求详情: URL=${apiUrl}, Headers=${JSON.stringify(headers)}, Body=${JSON.stringify(payload)}`);
      return "";
    }

    try {
      const data = JSON.parse(responseText);
      if (data.success) {
        return data.data.conversationId;
      } else {
        console.error("Failed to create conversation:", data);
        return "";
      }
    } catch (e) {
      console.error("Error parsing JSON response:", e);
      console.error("Raw response:", responseText);
      return "";
    }
  } catch (error) {
    console.error("Error creating conversation:", error);
    return "";
  }
}

// ===== API 实现 =====

/**
 * 健康检查端点
 * 用于监控服务可用性
 */
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok',
    version: '1.0.0',
    timestamp: new Date().toISOString()
  });
});

/**
 * 模型列表端点
 * 返回可用的模型列表
 */
app.get('/v1/models', (req, res) => {
  // 为每个模型添加创建时间
  const modelsWithDates = config.models.map(model => ({
    ...model,
    created: Date.now()
  }));
  
  res.json({
    object: 'list',
    data: modelsWithDates
  });
});

/**
 * 聊天完成端点
 * 处理各种模型的聊天请求
 */
app.post('/v1/chat/completions', async (req, res) => {
  try {
    const { model, messages, stream = false, temperature = 1.0, max_tokens } = req.body;

    // 请求参数验证
    if (!model || !messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({
        error: {
          message: "请求格式不正确，需要提供 model 和 messages 参数",
          type: "invalid_request_error"
        }
      });
    }

    // 提取用户消息
    const userMessage = messages[messages.length - 1];
    if (userMessage.role !== 'user') {
      return res.status(400).json({
        error: {
          message: "最后一条消息必须是用户消息",
          type: "invalid_request_error"
        }
      });
    }

    // 处理消息内容，支持字符串或对象数组格式
    const userContent = typeof userMessage.content === 'string' 
      ? userMessage.content 
      : userMessage.content.map(item => item.type === 'text' ? item.text : '').join(' ');

    // 根据模型选择不同的处理方式
    const modelId = model.toLowerCase();

    // 设置正确的内容类型
    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
    } else {
      res.setHeader('Content-Type', 'application/json');
    }

    // 路由到对应模型处理
    if (modelId.includes('claude')) {
      // 使用 Claude 处理
      if (modelId === 'deepclaude') {
        await handleDeepClaudeRequest(userContent, stream, res, temperature, max_tokens, modelId);
      } else {
        await handleClaudeRequest(userContent, stream, res, temperature, max_tokens, modelId);
      }
    } else if (modelId.includes('deepseek')) {
      // 使用 DeepSeek 处理
      await handleDeepSeekRequest(userContent, stream, res);
    } else {
      return res.status(400).json({
        error: {
          message: `不支持的模型: ${model}`,
          type: "invalid_request_error"
        }
      });
    }
  } catch (error) {
    console.error("API处理错误:", error);
    res.status(500).json({
      error: {
        message: "服务器内部错误",
        type: "server_error",
        details: error.message
      }
    });
  }
});

/**
 * 处理Claude请求
 * 支持流式和非流式响应，支持不同Claude模型版本
 * 
 * @param {string} userInput 用户输入
 * @param {boolean} stream 是否使用流式响应
 * @param {object} res Express响应对象
 * @param {number} temperature 温度参数
 * @param {number} max_tokens 最大令牌数
 * @param {string} modelId 请求的模型ID
 */
async function handleClaudeRequest(userInput, stream, res, temperature, max_tokens = 8192, modelId = CLAUDE_DEFAULT_MODEL) {
  try {
    // 获取API密钥
    const API_KEY = getClaudeApiKey();
    if (!API_KEY) {
      return res.status(500).json({
        error: {
          message: "无法获取Claude API密钥，请检查配置",
          type: "server_error",
          param: null,
          code: "invalid_api_key"
        }
      });
    }

    // 确定使用的Claude模型版本
    let claudeModel = CLAUDE_DEFAULT_MODEL;
    
    // 如果请求的模型在配置的可用模型列表中，则使用该模型
    if (CLAUDE_MODELS.includes(modelId)) {
      claudeModel = modelId;
    } else if (modelId.includes('3-5')) {
      // 如果请求的是3.5系列模型但不完全匹配，使用配置的3.5模型
      const claude35Model = CLAUDE_MODELS.find(m => m.includes('3-5'));
      if (claude35Model) {
        claudeModel = claude35Model;
      }
    }
    
    debugLog(1, "INFO", `使用Claude模型: ${claudeModel}`);

    // 构建请求数据
    const requestData = {
      provider: CLAUDE_PROVIDER,
      model: claudeModel,
      provider_request: {
        model: claudeModel,
        max_tokens: max_tokens,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: userInput,
              },
            ],
          },
        ],
        system: "",
        temperature: temperature,
      },
    };

    // 在发送Claude请求之前添加
    if (DEBUG_MODE && DEBUG_LEVEL >= 3) {
      console.log("====== Claude API请求详情 ======");
      console.log("URL:", CLAUDE_API_URL);
      console.log("Authorization Header:", API_KEY ? "已设置 (前10位): " + API_KEY.substring(0, 10) + "..." : "未设置");
      console.log("请求体:", JSON.stringify(requestData, null, 2));
      console.log("================================");
    }

    if (stream) {
      // 流式响应处理
      const response = await axios({
        method: "post",
        url: CLAUDE_API_URL,
        headers: {
          "Content-Type": "application/json",
          Authorization: `${API_KEY}`,
        },
        data: requestData,
        responseType: "stream",
      });

      let responseText = "";
      let id = crypto.randomUUID();
      let created = Math.floor(Date.now() / 1000);

      // 发送初始 SSE 事件
      res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: claudeModel, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] })}\n\n`);

      response.data.on("data", (chunk) => {
        const chunkStr = chunk.toString();
        const lines = chunkStr.split("\n").filter((line) => line.trim());

        for (const line of lines) {
          try {
            const data = JSON.parse(line);

            if (data.type === "content_block_delta" && data.delta.type === "text_delta") {
              const textChunk = data.delta.text;
              responseText += textChunk;
              
              // 发送文本块作为 SSE 事件
              const sseEvent = {
                id,
                object: "chat.completion.chunk",
                created,
                model: claudeModel,
                choices: [
                  {
                    index: 0,
                    delta: { content: textChunk },
                    finish_reason: null
                  }
                ]
              };
              
              res.write(`data: ${JSON.stringify(sseEvent)}\n\n`);
            }
          } catch (error) {
            debugLog(2, "ERROR", "JSON解析错误:", error.message, "行内容:", line);
          }
        }
      });

      response.data.on("end", () => {
        // 发送结束 SSE 事件
        const finalEvent = {
          id,
          object: "chat.completion.chunk",
          created,
          model: claudeModel,
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: "stop"
            }
          ]
        };
        
        res.write(`data: ${JSON.stringify(finalEvent)}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      });

      response.data.on("error", (err) => {
        console.error("流数据接收错误:", err);
        res.end();
      });
    } else {
      // 非流式响应处理
      const response = await axios({
        method: "post",
        url: CLAUDE_API_URL,
        headers: {
          "Content-Type": "application/json",
          Authorization: `${API_KEY}`,
        },
        data: requestData,
      });

      // 解析响应数据
      let fullContent = "";
      
      // 解析响应数据（字符串）
      const lines = response.data.split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        
        try {
          const eventData = JSON.parse(line);
          
          // 提取文本增量
          if (eventData.type === "content_block_delta" && 
              eventData.delta && 
              eventData.delta.type === "text_delta") {
            fullContent += eventData.delta.text;
          }
        } catch (error) {
          debugLog(2, "ERROR", "JSON解析错误:", error.message, "行内容:", line);
        }
      }
      
      if (!fullContent) {
        return res.status(500).json({
          error: {
            message: "Claude 响应格式异常",
            type: "server_error",
            details: response.data
          }
        });
      }

      // 构建最终响应
      const result = {
        id: crypto.randomUUID(),
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: claudeModel,
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: fullContent
            },
            finish_reason: "stop"
          }
        ],
        usage: {
          prompt_tokens: userInput.length,
          completion_tokens: fullContent.length,
          total_tokens: userInput.length + fullContent.length
        }
      };

      res.json(result);
    }
  } catch (error) {
    console.error("Claude API 错误:", error);
    if (!res.headersSent) {
      res.status(500).json({
        error: {
          message: "调用 Claude API 失败",
          type: "server_error",
          details: error.message
        }
      });
    }
  }
}

// ===== DeepSeek 请求处理 =====
async function handleDeepSeekRequest(userInput, stream, res) {
  try {
    // 生成设备ID
    const deviceId = generateDeviceId();
    debugLog(1, "INFO", "Generated Device ID:", deviceId);
    
    // 创建对话
    const conversationId = await createConversation(deviceId);
    if (!conversationId) {
      return res.status(500).json({
        error: {
          message: "创建 DeepSeek 会话失败",
          type: "server_error"
        }
      });
    }

    // 设定模型
    const model = "openai.deepseek-r1";
    const modelId = model.split(".").pop();
    const userAction = [];
    if (modelId.startsWith("deepseek-r1")) {
      userAction.push("deep");
    }
    
    const payload = {
      stream: true,
      botCode: "AI_SEARCH",
      userAction: userAction.join(","),
      model: "deepseek",
      conversationId,
      question: userInput,
    };

    const timestamp = Math.floor(Date.now() / 1000).toString();
    const nonce = generateNanoId(21);
    const sign = generateSign(timestamp, payload, nonce);

    const headers = {
      Origin: "https://ai.dangbei.com",
      Referer: "https://ai.dangbei.com/",
      "User-Agent": DS_USER_AGENT,
      deviceId: deviceId,
      nonce: nonce,
      sign: sign,
      timestamp: timestamp,
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    };

    debugLog(3, "API", "DeepSeek Chat Request:", {
      url: `${DS_API_DOMAIN}/ai-search/chatApi/v1/chat`,
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });

    const fetchResponse = await fetch(`${DS_API_DOMAIN}/ai-search/chatApi/v1/chat`, {
      method: "POST",
      headers: headers,
      body: JSON.stringify(payload),
    });

    if (!fetchResponse.ok) {
      const errorText = await fetchResponse.text();
      return res.status(fetchResponse.status).json({
        error: {
          message: `DeepSeek API 错误: ${fetchResponse.status}`,
          type: "api_error",
          details: errorText
        }
      });
    }

    if (stream) {
      // 流式响应处理
      const reader = fetchResponse.body;
      const decoder = new TextDecoder("utf-8");
      const dataPrefix = "data:";
      
      let buffer = "";
      let fullResponse = "";
      let thinkingContent = "";
      let hasOutputThinking = false; // 标记是否已输出思考过程
      let id = crypto.randomUUID();
      let created = Math.floor(Date.now() / 1000);
      
      // 发送初始 SSE 事件
      res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: "deepseek-r1", choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] })}\n\n`);
      
      try {
        for await (const chunk of reader) {
          const text = decoder.decode(chunk);
          buffer += text;
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";
          
          for (const line of lines) {
            if (line.trim() === "" || !line.startsWith(dataPrefix)) continue;
            
            try {
              const jsonStr = line.substring(dataPrefix.length);
              const data = JSON.parse(jsonStr);
              
              // 处理思考内容
              if (data.content_type === "thinking" && data.content) {
                thinkingContent += data.content;
              }
              // 处理回答内容
              else if (data.type === "answer" && data.content && data.content_type !== "thinking") {
                // 在第一次收到回答内容时，先输出完整的思考内容
                if (!hasOutputThinking && thinkingContent.trim() !== "") {
                  hasOutputThinking = true;
                  
                  // 发送完整的思考内容作为一个 SSE 事件
                  const thinkingEvent = {
                    id,
                    object: "chat.completion.chunk",
                    created,
                    model: "deepseek-r1",
                    choices: [
                      {
                        index: 0,
                        delta: { content: `<思考过程>\n${thinkingContent.trim()}\n</思考过程>\n\n` },
                        finish_reason: null
                      }
                    ]
                  };
                  
                  res.write(`data: ${JSON.stringify(thinkingEvent)}\n\n`);
                }
                
                fullResponse += data.content;
                
                // 发送回答内容作为 SSE 事件
                const sseEvent = {
                  id,
                  object: "chat.completion.chunk",
                  created,
                  model: "deepseek-r1",
                  choices: [
                    {
                      index: 0,
                      delta: { content: data.content },
                      finish_reason: null
                    }
                  ]
                };
                
                res.write(`data: ${JSON.stringify(sseEvent)}\n\n`);
              }
            } catch (e) {
              debugLog(2, "ERROR", "Error parsing line:", e, line);
            }
          }
        }
        
        // 如果结束时仍未输出思考内容但有思考内容，则输出
        if (!hasOutputThinking && thinkingContent.trim() !== "") {
          const thinkingEvent = {
            id,
            object: "chat.completion.chunk",
            created,
            model: "deepseek-r1",
            choices: [
              {
                index: 0,
                delta: { content: `<思考过程>\n${thinkingContent.trim()}\n</思考过程>\n\n` },
                finish_reason: null
              }
            ]
          };
          
          res.write(`data: ${JSON.stringify(thinkingEvent)}\n\n`);
        }
        
        // 发送结束 SSE 事件
        const finalEvent = {
          id,
          object: "chat.completion.chunk",
          created,
          model: "deepseek-r1",
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: "stop"
            }
          ]
        };
        
        res.write(`data: ${JSON.stringify(finalEvent)}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      } catch (err) {
        console.error("Error in stream handling:", err);
        if (!res.headersSent) {
          res.status(500).json({
            error: {
              message: "处理 DeepSeek 流式响应失败",
              type: "server_error",
              details: err.message
            }
          });
        } else {
          res.end();
        }
      }
    } else {
      // 非流式响应处理也需要修改
      const { responseText, thinkingText } = await handleDeepSeekNonStreamResponseWithThinking(fetchResponse);
      
      // 构建包含思考内容的完整响应，只在最外层包裹一次思考标签
      const fullContent = thinkingText ? 
        `<思考过程>\n${thinkingText.trim()}\n</思考过程>\n\n${responseText}` : 
        responseText;
      
      const result = {
        id: crypto.randomUUID(),
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: "deepseek-r1",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: fullContent
            },
            finish_reason: "stop"
          }
        ],
        usage: {
          prompt_tokens: userInput.length,
          completion_tokens: fullContent.length,
          total_tokens: userInput.length + fullContent.length
        }
      };
      
      res.json(result);
    }
  } catch (error) {
    console.error("DeepSeek API 错误:", error);
    if (!res.headersSent) {
      res.status(500).json({
        error: {
          message: "调用 DeepSeek API 失败",
          type: "server_error",
          details: error.message
        }
      });
    } else {
      res.end();
    }
  }
}

// 修改非流式处理函数
async function handleDeepSeekNonStreamResponseWithThinking(response) {
  const reader = response.body;
  const decoder = new TextDecoder("utf-8");
  const dataPrefix = "data:";
  
  let buffer = "";
  let responseText = "";
  let thinkingText = "";
  
  try {
    for await (const chunk of reader) {
      const text = decoder.decode(chunk);
      buffer += text;
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      
      for (const line of lines) {
        if (line.trim() === "" || !line.startsWith(dataPrefix)) continue;
        
        try {
          const jsonStr = line.substring(dataPrefix.length);
          const data = JSON.parse(jsonStr);
          
          // 收集思考内容
          if (data.content_type === "thinking" && data.content) {
            thinkingText += data.content;
          }
          // 收集回答内容
          else if (data.type === "answer" && data.content && data.content_type !== "thinking") {
            responseText += data.content;
          }
        } catch (e) {
          // 忽略解析错误
          debugLog(2, "WARN", "Error parsing line:", e, line);
        }
      }
    }
    
    return { responseText, thinkingText: thinkingText.trim() };
  } catch (err) {
    console.error("Error in non-stream handling:", err);
    return { responseText, thinkingText: thinkingText.trim() };
  }
}

/**
 * 处理DeepClaude混合模型请求
 * 包含更详细的错误处理和日志
 */
async function handleDeepClaudeRequest(userInput, stream, res, temperature, max_tokens = 8192, modelId) {
  try {
    debugLog(1, "INFO", "DeepClaude请求开始处理");
    
    // 步骤1: 生成设备ID和会话ID用于DeepSeek
    const deviceId = generateDeviceId();
    debugLog(2, "INFO", `生成设备ID: ${deviceId}`);
    
    // 创建一个新的对话会话
    debugLog(2, "INFO", "正在创建DeepSeek对话");
    const conversationId = await createConversation(deviceId);
    if (!conversationId) {
      debugLog(1, "ERROR", "无法创建DeepSeek对话，降级为直接使用Claude");
      return handleDirectClaudeRequest(userInput, stream, res, temperature, max_tokens, modelId);
    }
    
    debugLog(2, "INFO", `成功创建对话，ID: ${conversationId}`);
    
    // 步骤2: 获取DeepSeek的思考内容
    debugLog(2, "INFO", "正在获取DeepSeek思考内容");
    
    // 添加重试机制
    let thinking = null;
    let retryCount = 0;
    const maxRetries = 2;
    
    while (retryCount <= maxRetries && !thinking) {
      if (retryCount > 0) {
        debugLog(1, "INFO", `重试获取思考内容 (${retryCount}/${maxRetries})`);
      }
      
      try {
        thinking = await getDeepSeekThinking(deviceId, conversationId, userInput);
      } catch (error) {
        debugLog(1, "ERROR", `获取思考内容失败 (尝试 ${retryCount+1}/${maxRetries+1}): ${error.message}`);
        
        if (retryCount === maxRetries) {
          debugLog(1, "WARN", "获取思考内容失败，降级为直接使用Claude");
          return handleDirectClaudeRequest(userInput, stream, res, temperature, max_tokens, modelId);
        }
      }
      
      retryCount++;
    }
    
    if (!thinking) {
      debugLog(1, "ERROR", "无法获取DeepSeek思考内容，降级为直接使用Claude");
      return handleDirectClaudeRequest(userInput, stream, res, temperature, max_tokens, modelId);
    }
    
    debugLog(1, "INFO", `成功获取思考内容，长度: ${thinking.length}`);
    
    // 步骤3: 验证Claude API密钥
    const API_KEY = getClaudeApiKey();
    if (!API_KEY) {
      debugLog(1, "ERROR", "无法获取Claude API密钥");
      return res.status(500).json({
        error: {
          message: "无法获取Claude API密钥，请检查配置",
          type: "server_error",
          step: "get_claude_key",
          code: "invalid_api_key"
        }
      });
    }
    
    // 步骤4: 构建发送给Claude的提示
    const claudePrompt = `请根据以下思考过程给出回答：

思考过程：
${thinking}

请直接给出你的回答，不要重复我的问题或思考过程。`;
    
    // 构建Claude请求数据
    const claudeModel = CLAUDE_DEFAULT_MODEL;
    
    // 下面使用try-catch包装对Claude的请求，以便捕获特定的错误
    try {
      debugLog(2, "INFO", "正在发送请求到Claude API");
      
      // 步骤5: 发送请求到Claude API
      const requestData = {
        provider: CLAUDE_PROVIDER,
        model: claudeModel,
        provider_request: {
          model: claudeModel,
          max_tokens: max_tokens,
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: claudePrompt,
                },
              ],
            },
          ],
          system: "",
          temperature: temperature,
        },
      };
      
      // 在发送Claude请求之前添加
      if (DEBUG_MODE && DEBUG_LEVEL >= 3) {
        console.log("====== Claude API请求详情 ======");
        console.log("URL:", CLAUDE_API_URL);
        console.log("Authorization Header:", API_KEY ? "已设置 (前10位): " + API_KEY.substring(0, 10) + "..." : "未设置");
        console.log("请求体:", JSON.stringify(requestData, null, 2));
        console.log("================================");
      }
      
      if (stream) {
        // 流式响应处理
        const response = await axios({
          method: "post",
          url: CLAUDE_API_URL,
          headers: {
            "Content-Type": "application/json",
            Authorization: `${API_KEY}`,
          },
          data: requestData,
          responseType: "stream",
        });

        let responseText = "";
        let id = crypto.randomUUID();
        let created = Math.floor(Date.now() / 1000);

        // 发送初始 SSE 事件
        res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: claudeModel, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] })}\n\n`);

        response.data.on("data", (chunk) => {
          const chunkStr = chunk.toString();
          const lines = chunkStr.split("\n").filter((line) => line.trim());

          for (const line of lines) {
            try {
              const data = JSON.parse(line);

              if (data.type === "content_block_delta" && data.delta.type === "text_delta") {
                const textChunk = data.delta.text;
                responseText += textChunk;
                
                // 发送文本块作为 SSE 事件
                const sseEvent = {
                  id,
                  object: "chat.completion.chunk",
                  created,
                  model: "deepclaude",
                  choices: [
                    {
                      index: 0,
                      delta: { content: textChunk },
                      finish_reason: null
                    }
                  ]
                };
                
                res.write(`data: ${JSON.stringify(sseEvent)}\n\n`);
              }
            } catch (error) {
              debugLog(2, "ERROR", "JSON解析错误:", error.message, "行内容:", line);
            }
          }
        });

        response.data.on("end", () => {
          // 发送结束 SSE 事件
          const finalEvent = {
            id,
            object: "chat.completion.chunk",
            created,
            model: "deepclaude",
            choices: [
              {
                index: 0,
                delta: {},
                finish_reason: "stop"
              }
            ]
          };
          
          res.write(`data: ${JSON.stringify(finalEvent)}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
        });

        response.data.on("error", (err) => {
          console.error("流数据接收错误:", err);
          res.end();
        });
      } else {
        // 非流式响应处理
        const response = await axios({
          method: "post",
          url: CLAUDE_API_URL,
          headers: {
            "Content-Type": "application/json",
            Authorization: `${API_KEY}`,
          },
          data: requestData,
        });

        // 解析响应数据
        let fullContent = "";
        
        // 解析响应数据（字符串）
        const lines = response.data.split('\n');
        for (const line of lines) {
          if (!line.trim()) continue;
          
          try {
            const eventData = JSON.parse(line);
            
            // 提取文本增量
            if (eventData.type === "content_block_delta" && 
                eventData.delta && 
                eventData.delta.type === "text_delta") {
              fullContent += eventData.delta.text;
            }
          } catch (error) {
            debugLog(2, "ERROR", "JSON解析错误:", error.message, "行内容:", line);
          }
        }
        
        if (!fullContent) {
          return res.status(500).json({
            error: {
              message: "Claude 响应格式异常",
              type: "server_error",
              details: response.data
            }
          });
        }

        // 构建最终响应
        const result = {
          id: crypto.randomUUID(),
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: "deepclaude",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: fullContent
              },
              finish_reason: "stop"
            }
          ],
          usage: {
            prompt_tokens: claudePrompt.length,
            completion_tokens: fullContent.length,
            total_tokens: claudePrompt.length + fullContent.length
          }
        };

        res.json(result);
      }
    } catch (claudeError) {
      console.error("Claude API调用错误:", claudeError);
      return res.status(500).json({
        error: {
          message: "调用Claude API失败",
          type: "server_error",
          step: "claude_api_call",
          details: claudeError.message
        }
      });
    }
  } catch (error) {
    console.error("DeepClaude混合模式错误:", error);
    if (!res.headersSent) {
      res.status(500).json({
        error: {
          message: "调用DeepClaude API失败",
          type: "server_error",
          details: error.message
        }
      });
    } else {
      res.end();
    }
  }
}

/**
 * 当DeepSeek思考内容获取失败时，直接使用Claude处理原始用户输入
 * 作为DeepClaude模式的降级方案
 */
async function handleDirectClaudeRequest(userInput, stream, res, temperature, max_tokens = 8192, modelId) {
  debugLog(1, "INFO", "启用降级方案：直接使用Claude处理请求");
  
  // 添加前缀，告知用户当前使用的是降级方案
  const prefixMessage = "【注意：DeepSeek思考内容获取失败，以下是Claude直接回答】\n\n";
  
  try {
    // 获取API密钥
    const API_KEY = getClaudeApiKey();
    if (!API_KEY) {
      return res.status(500).json({
        error: {
          message: "无法获取Claude API密钥，请检查配置",
          type: "server_error",
          param: null,
          code: "invalid_api_key"
        }
      });
    }

    // 确定使用的Claude模型版本
    const claudeModel = CLAUDE_DEFAULT_MODEL;
    
    debugLog(1, "INFO", `使用Claude模型: ${claudeModel}`);

    // 构建请求数据
    const requestData = {
      provider: CLAUDE_PROVIDER,
      model: claudeModel,
      provider_request: {
        model: claudeModel,
        max_tokens: max_tokens,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: userInput,
              },
            ],
          },
        ],
        system: "",
        temperature: temperature,
      },
    };

    if (stream) {
      // 流式响应处理
      const response = await axios({
        method: "post",
        url: CLAUDE_API_URL,
        headers: {
          "Content-Type": "application/json",
          Authorization: `${API_KEY}`,
        },
        data: requestData,
        responseType: "stream",
      });

      let responseText = "";
      let id = crypto.randomUUID();
      let created = Math.floor(Date.now() / 1000);
      let prefixSent = false;

      // 发送初始 SSE 事件
      res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: "deepclaude", choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] })}\n\n`);

      // 发送前缀消息
      const prefixEvent = {
        id,
        object: "chat.completion.chunk",
        created,
        model: "deepclaude",
        choices: [
          {
            index: 0,
            delta: { content: prefixMessage },
            finish_reason: null
          }
        ]
      };
      
      res.write(`data: ${JSON.stringify(prefixEvent)}\n\n`);
      prefixSent = true;

      response.data.on("data", (chunk) => {
        const chunkStr = chunk.toString();
        const lines = chunkStr.split("\n").filter((line) => line.trim());

        for (const line of lines) {
          try {
            const data = JSON.parse(line);

            if (data.type === "content_block_delta" && data.delta.type === "text_delta") {
              const textChunk = data.delta.text;
              responseText += textChunk;
              
              // 发送文本块作为 SSE 事件
              const sseEvent = {
                id,
                object: "chat.completion.chunk",
                created,
                model: "deepclaude",
                choices: [
                  {
                    index: 0,
                    delta: { content: textChunk },
                    finish_reason: null
                  }
                ]
              };
              
              res.write(`data: ${JSON.stringify(sseEvent)}\n\n`);
            }
          } catch (error) {
            debugLog(2, "ERROR", "JSON解析错误:", error.message, "行内容:", line);
          }
        }
      });

      response.data.on("end", () => {
        // 发送结束 SSE 事件
        const finalEvent = {
          id,
          object: "chat.completion.chunk",
          created,
          model: "deepclaude",
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: "stop"
            }
          ]
        };
        
        res.write(`data: ${JSON.stringify(finalEvent)}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      });

      response.data.on("error", (err) => {
        console.error("流数据接收错误:", err);
        res.end();
      });
    } else {
      // 非流式响应处理
      const response = await axios({
        method: "post",
        url: CLAUDE_API_URL,
        headers: {
          "Content-Type": "application/json",
          Authorization: `${API_KEY}`,
        },
        data: requestData,
      });

      // 解析响应数据
      let fullContent = "";
      
      // 解析响应数据（字符串）
      const lines = response.data.split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        
        try {
          const eventData = JSON.parse(line);
          
          // 提取文本增量
          if (eventData.type === "content_block_delta" && 
              eventData.delta && 
              eventData.delta.type === "text_delta") {
            fullContent += eventData.delta.text;
          }
        } catch (error) {
          debugLog(2, "ERROR", "JSON解析错误:", error.message, "行内容:", line);
        }
      }
      
      if (!fullContent) {
        return res.status(500).json({
          error: {
            message: "Claude 响应格式异常",
            type: "server_error",
            details: response.data
          }
        });
      }

      // 添加前缀
      fullContent = prefixMessage + fullContent;

      // 构建最终响应
      const result = {
        id: crypto.randomUUID(),
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: "deepclaude",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: fullContent
            },
            finish_reason: "stop"
          }
        ],
        usage: {
          prompt_tokens: userInput.length,
          completion_tokens: fullContent.length,
          total_tokens: userInput.length + fullContent.length
        }
      };

      res.json(result);
    }
  } catch (error) {
    console.error("Claude API 错误:", error);
    if (!res.headersSent) {
      res.status(500).json({
        error: {
          message: "调用 Claude API 失败",
          type: "server_error",
          details: error.message
        }
      });
    }
  }
}

// 获取 DeepSeek 思考内容的辅助函数
async function getDeepSeekThinking(deviceId, conversationId, message) {
  try {
    debugLog(2, "INFO", "开始获取DeepSeek思考内容");
    
    // 获取发送消息所需的参数
    const timestamp = Date.now();
    const nonce = generateNanoId(20);
    
    // 设定模型和用户操作
    const userAction = ["deep"]; // 使用deep模式获取思考过程
    
    // 构建请求体 - 与handleDeepSeekRequest保持一致
    const payload = {
      stream: true,
      botCode: "AI_SEARCH",
      userAction: userAction.join(","),
      model: "deepseek",
      conversationId: conversationId,
      question: message
    };
    
    debugLog(3, "DEBUG", "DeepSeek请求参数:", { deviceId, conversationId, message });
    
    const sign = generateSign(timestamp, payload, nonce);
    
    // 构建API URL和请求头
    const apiUrl = `${DS_API_DOMAIN}/ai-search/chatApi/v1/chat`;
    const headers = {
      Origin: "https://ai.dangbei.com",
      Referer: "https://ai.dangbei.com/",
      "User-Agent": DS_USER_AGENT,
      deviceId: deviceId,
      nonce: nonce,
      sign: sign,
      timestamp: timestamp.toString(),
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    };
    
    // 记录完整请求信息用于调试
    debugLog(1, "INFO", `DeepSeek API请求: ${apiUrl}`);
    debugLog(2, "DEBUG", "请求头:", headers);
    debugLog(2, "DEBUG", "请求体:", payload);
    
    try {
      const response = await fetch(apiUrl, {
        method: "POST",
        headers: headers,
        body: JSON.stringify(payload),
      });
      
      if (!response.ok) {
        const errorText = await response.text();
        debugLog(1, "ERROR", `DeepSeek API错误响应: ${response.status}`, errorText);
        debugLog(1, "ERROR", `请求详情: URL=${apiUrl}, Headers=${JSON.stringify(headers)}, Body=${JSON.stringify(payload)}`);
        throw new Error(`DeepSeek API返回错误状态码: ${response.status}, 错误详情: ${errorText}`);
      }
      
      // 处理流式响应，但只提取思考内容
      const decoder = new TextDecoder("utf-8");
      const dataPrefix = "data:";
      
      let buffer = "";
      let thinkingResponse = "";
      let shouldExit = false;
      
      // 设置读取超时
      const readTimeout = setTimeout(() => {
        shouldExit = true;
        console.warn("获取思考内容超时");
      }, 15000); // 15秒超时
      
      try {
        // 使用Node.js兼容的for-await-of循环处理流
        for await (const chunk of response.body) {
          if (shouldExit) break;
          
          const text = decoder.decode(chunk);
          buffer += text;
          
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";
          
          for (const line of lines) {
            if (line.trim() === "" || !line.startsWith(dataPrefix)) continue;
            
            try {
              const jsonStr = line.substring(dataPrefix.length);
              const data = JSON.parse(jsonStr);
              
              // 只收集思考内容
              if (data.content_type === "thinking" && data.content) {
                thinkingResponse += data.content;
              } else if (data.type === "answer" && data.content_type !== "thinking") {
                // 一旦开始接收实际回答，就中断处理
                if (thinkingResponse) {
                  shouldExit = true;
                  break;
                }
              }
            } catch (e) {
              // 忽略解析错误
              debugLog(2, "WARN", "解析错误:", e);
            }
          }
        }
      } finally {
        clearTimeout(readTimeout);
      }
      
      debugLog(1, "INFO", "成功获取思考内容，长度:", thinkingResponse.length);
      return thinkingResponse;
    } catch (apiError) {
      debugLog(1, "ERROR", "调用DeepSeek API错误:", apiError.message);
      throw apiError; // 重新抛出以便上层处理
    }
  } catch (error) {
    console.error("获取DeepSeek思考内容失败:", error);
    return null;
  }
}

/**
 * 管理API - 更新API令牌
 * 通过POST请求更新API令牌文件
 * 需要提供管理密钥进行身份验证
 */
app.post('/admin/update-tokens', (req, res) => {
  // 获取请求中的管理密钥
  const adminKey = req.headers['x-admin-key'];
  
  // 验证管理密钥 (从环境变量或配置中获取)
  const validAdminKey = process.env.ADMIN_KEY || config.server.admin_key || 'change-this-admin-key';
  
  if (!adminKey || adminKey !== validAdminKey) {
    debugLog(1, "ERROR", "管理API访问被拒绝: 无效的管理密钥");
    return res.status(401).json({
      error: {
        message: "无效的管理密钥",
        type: "authentication_error",
        code: "invalid_admin_key"
      }
    });
  }
  
  // 获取请求体中的令牌数据
  const { tokens } = req.body;
  
  if (!tokens || !Array.isArray(tokens)) {
    return res.status(400).json({
      error: {
        message: "无效的令牌数据格式，应为令牌数组",
        type: "invalid_request_error",
        code: "invalid_tokens_format"
      }
    });
  }
  
  try {
    // 获取令牌文件路径
    const tokenPath = CLAUDE_API_KEY_PATH;
    
    // 确保文件路径不为空
    if (!tokenPath || tokenPath.trim() === '') {
      throw new Error("API密钥文件路径未配置");
    }
    
    // 确保目录存在
    const tokenDir = path.dirname(tokenPath);
    if (!fs.existsSync(tokenDir)) {
      fs.mkdirSync(tokenDir, { recursive: true });
      debugLog(2, "INFO", `创建令牌文件目录: ${tokenDir}`);
    }
    
    // 将令牌数组写入文件（每行一个令牌）
    fs.writeFileSync(tokenPath, tokens.join('\n'), 'utf8');
    
    debugLog(1, "INFO", `成功更新API令牌文件，共${tokens.length}个令牌`);
    
    return res.status(200).json({
      success: true,
      message: `成功更新API令牌文件，共${tokens.length}个令牌`
    });
  } catch (error) {
    debugLog(1, "ERROR", `更新API令牌文件失败: ${error.message}`);
    
    return res.status(500).json({
      error: {
        message: `更新API令牌文件失败: ${error.message}`,
        type: "server_error",
        code: "token_update_failed"
      }
    });
  }
});

/**
 * 管理API - 获取当前API令牌
 * 通过GET请求获取当前API令牌列表
 * 需要提供管理密钥进行身份验证
 */
app.get('/admin/tokens', (req, res) => {
  // 获取请求中的管理密钥
  const adminKey = req.headers['x-admin-key'];
  
  // 验证管理密钥 (从环境变量或配置中获取)
  const validAdminKey = process.env.ADMIN_KEY || config.server.admin_key || 'change-this-admin-key';
  
  if (!adminKey || adminKey !== validAdminKey) {
    debugLog(1, "ERROR", "管理API访问被拒绝: 无效的管理密钥");
    return res.status(401).json({
      error: {
        message: "无效的管理密钥",
        type: "authentication_error",
        code: "invalid_admin_key"
      }
    });
  }
  
  try {
    // 获取令牌文件路径
    const tokenPath = CLAUDE_API_KEY_PATH;
    
    // 确保文件路径不为空
    if (!tokenPath || tokenPath.trim() === '') {
      throw new Error("API密钥文件路径未配置");
    }
    
    // 检查文件是否存在
    if (!fs.existsSync(tokenPath)) {
      return res.status(200).json({
        tokens: []
      });
    }
    
    // 读取令牌文件
    const content = fs.readFileSync(tokenPath, 'utf8');
    const tokens = content.split('\n').filter(line => line.trim() !== '');
    
    debugLog(2, "INFO", `成功读取API令牌文件，共${tokens.length}个令牌`);
    
    return res.status(200).json({
      tokens: tokens
    });
  } catch (error) {
    debugLog(1, "ERROR", `读取API令牌文件失败: ${error.message}`);
    
    return res.status(500).json({
      error: {
        message: `读取API令牌文件失败: ${error.message}`,
        type: "server_error",
        code: "token_read_failed"
      }
    });
  }
});

/**
 * 获取本机IPv4地址
 * 用于在服务器启动时显示可访问的URL
 * 
 * @returns {string} 本机IPv4地址或localhost
 */
function getLocalIPv4() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      // 跳过非IPv4和内部接口
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return '127.0.0.1'; // 如果没找到，返回localhost
}

// 在服务器启动时显示增强的URL信息
app.listen(PORT, () => {
  const ipv4 = getLocalIPv4();
  
  console.log(`API服务器已启动，监听端口: ${PORT}`);
  console.log(`调试模式: ${DEBUG_MODE ? "开启" : "关闭"}`);
  console.log(`支持的模型: claude-3-sonnet-latest, deepseek-r1, deepclaude`);
  
  console.log("\n=== 本地访问 ===");
  console.log(`健康检查: http://localhost:${PORT}/health`);
  console.log(`模型列表: http://localhost:${PORT}/v1/models`);
  console.log(`聊天接口: http://localhost:${PORT}/v1/chat/completions`);
  
  console.log("\n=== 网络访问 ===");
  console.log(`健康检查: http://${ipv4}:${PORT}/health`);
  console.log(`模型列表: http://${ipv4}:${PORT}/v1/models`);
  console.log(`聊天接口: http://${ipv4}:${PORT}/v1/chat/completions`);
});