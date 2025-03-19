/**
 * Claude模型处理模块
 * ==========================
 * 处理Claude模型的请求和响应
 */

import crypto from 'crypto';
import axios from 'axios';

// 配置参数，将从主服务器传入
let CLAUDE_API_URL;
let CLAUDE_MODELS;
let CLAUDE_DEFAULT_MODEL;
let CLAUDE_PROVIDER;
let CLAUDE_API_KEY;
let CLAUDE_API_KEY_PATH;
let DEBUG_MODE;
let DEBUG_LEVEL;

// 文件系统模块，用于读取API密钥文件
import fs from 'fs';

/**
 * 初始化模块
 * 设置模块所需的配置参数
 * 
 * @param {Object} config 配置对象
 */
export function initialize(config) {
  CLAUDE_API_URL = config.claude.api_url;
  CLAUDE_MODELS = config.claude.models;
  CLAUDE_DEFAULT_MODEL = CLAUDE_MODELS[0];
  CLAUDE_PROVIDER = config.claude.provider;
  CLAUDE_API_KEY = config.claude.api_key;
  CLAUDE_API_KEY_PATH = config.claude.api_key_path;
  DEBUG_MODE = config.server.debug_mode;
  DEBUG_LEVEL = config.server.debug_level || 1;
}

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

/**
 * 处理Claude请求
 * 
 * @param {object} req Express请求对象
 * @param {object} res Express响应对象
 * @param {string} message 用户消息
 * @param {boolean} stream 是否使用流式响应
 * @param {object} debugOptions 调试选项
 */
export async function handleClaudeRequest(req, res, message, stream, debugOptions = {}) {
  try {
    console.log("[INFO] 开始处理Claude请求，启用流式模式:", stream);
    
    // 强制使用流式输出
    stream = true;
    
    // 获取请求参数
    const { temperature = 0.7, max_tokens = 8192 } = req.body;
    
    // 获取Claude API KEY
    const API_KEY = await getClaudeApiKey();
    if (!API_KEY) {
      console.error("[ERROR] 无法获取Claude API密钥");
      if (stream) {
        res.write("event: error\ndata: {\"error\":\"无法获取Claude API密钥\"}\n\n");
        res.end();
      } else {
        res.status(500).json({
          error: {
            message: "无法获取Claude API密钥",
            type: "server_error",
            step: "get_claude_key",
            code: "invalid_api_key"
          }
        });
      }
      return;
    }
    
    // 设置模型
    const claudeModel = CLAUDE_DEFAULT_MODEL;
    
    // 构建请求体
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
                text: message,
              },
            ],
          },
        ],
        system: "",
        temperature: temperature,
      },
    };
    
    console.log("[DEBUG] Claude请求参数:", {
      model: claudeModel,
      messageLength: message.length,
      temperature,
      max_tokens,
      stream
    });
    
    // 设置响应头
    if (stream) {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
    } else {
      res.setHeader("Content-Type", "application/json");
    }
    
    try {
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
                // 确保数据立即发送
                res.flush && res.flush();
              }
            } catch (error) {
              console.log("[WARN] JSON解析错误:", error.message, "行内容:", line);
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
          console.error("[ERROR] 流数据接收错误:", err.message);
          res.write(`event: error\ndata: ${JSON.stringify({ error: "流数据接收错误: " + err.message })}\n\n`);
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
          timeout: 60000,
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
            console.log("[WARN] JSON解析错误:", error.message, "行内容:", line);
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
            prompt_tokens: message.length,
            completion_tokens: fullContent.length,
            total_tokens: message.length + fullContent.length
          }
        };
        
        res.json(result);
      }
    } catch (apiError) {
      console.error("[ERROR] Claude API调用失败:", apiError.message);
      
      if (stream) {
        res.write(`event: error\ndata: ${JSON.stringify({ error: "Claude API调用失败: " + apiError.message })}\n\n`);
        res.end();
      } else {
        // 检查是否已发送响应头
        if (!res.headersSent) {
          res.status(500).json({
            error: {
              message: "Claude API调用失败",
              type: "server_error",
              details: apiError.message
            }
          });
        }
      }
    }
  } catch (error) {
    console.error("[ERROR] 处理Claude请求失败:", error.message);
    
    // 检查是否已发送响应头
    if (!res.headersSent) {
      if (stream) {
        res.write(`event: error\ndata: ${JSON.stringify({ error: "处理请求失败: " + error.message })}\n\n`);
        res.end();
      } else {
        res.status(500).json({
          error: {
            message: "处理Claude请求失败",
            type: "server_error",
            details: error.message
          }
        });
      }
    }
  }
} 