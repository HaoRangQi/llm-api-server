/**
 * DeepClaude模型处理模块
 * ==========================
 * 处理DeepClaude混合模型的请求和响应
 * 该模块结合DeepSeek的思考能力和Claude的回答能力
 */

import crypto from 'crypto';
import axios from 'axios';
import fs from 'fs';

// 配置参数，将从主服务器传入
let CLAUDE_API_URL;
let CLAUDE_MODELS;
let CLAUDE_DEFAULT_MODEL;
let CLAUDE_PROVIDER;
let CLAUDE_API_KEY;
let CLAUDE_API_KEY_PATH;
let DEBUG_MODE;
let DEBUG_LEVEL;
let HEADER_TOKEN_CONFIG; // 请求头Token配置

/**
 * 初始化模块
 * 设置模块所需的配置参数
 * 
 * @param {Object} config 配置对象
 */
export function initialize(config) {
  console.log("[INFO] DeepClaude模型初始化中...");
  
  // 从Claude配置中获取参数
  CLAUDE_API_URL = config.claude.api_url;
  CLAUDE_MODELS = config.claude.models;
  CLAUDE_DEFAULT_MODEL = CLAUDE_MODELS[0];
  CLAUDE_PROVIDER = config.claude.provider;
  CLAUDE_API_KEY = config.claude.api_key;
  CLAUDE_API_KEY_PATH = config.claude.api_key_path;
  DEBUG_MODE = config.server.debug_mode;
  DEBUG_LEVEL = config.server.debug_level || 1;
  HEADER_TOKEN_CONFIG = config.claude.header_token_config || "ignore"; // 默认忽略请求头Token
  
  debugLog(3, "DEBUG", "DeepClaude模型配置参数:", {
    CLAUDE_API_URL,
    CLAUDE_DEFAULT_MODEL,
    CLAUDE_PROVIDER,
    DEBUG_MODE,
    DEBUG_LEVEL
  });
  
  console.log("[INFO] DeepClaude模型初始化完成");
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
 * 从请求中获取Token
 * 优先使用请求头中的Token，根据配置处理
 * 如果没有请求头Token，则使用配置中的Token
 * 
 * @param {Object} req Express请求对象
 * @returns {string|null} 处理后的Token或null
 */
function getTokenFromRequest(req) {
  const authHeader = req.headers.authorization;
  
  // 检查请求头中是否有Token
  if (authHeader) {
    debugLog(3, "DEBUG", "从请求头获取到Token");
    
    // 检查是否以"Bearer"开头
    if (authHeader.startsWith("Bearer ")) {
      debugLog(3, "DEBUG", "请求头Token已包含Bearer前缀");
      return authHeader;
    } else {
      // 根据配置决定如何处理
      if (HEADER_TOKEN_CONFIG === "ignore") {
        debugLog(3, "DEBUG", "配置为忽略非Bearer格式的请求头Token，使用默认配置Token");
        return null; // 返回null表示使用默认配置
      } else {
        // 添加Bearer前缀
        debugLog(3, "DEBUG", "为请求头Token添加Bearer前缀");
        return `Bearer ${authHeader}`;
      }
    }
  }
  
  debugLog(3, "DEBUG", "请求头中无Token，使用配置Token");
  return null;
}

/**
 * 获取Claude API密钥
 * 优先使用配置直接提供的API密钥
 * 如果未配置直接密钥或为空，则尝试从文件读取
 * 
 * @param {Object} req Express请求对象，可选
 * @returns {string|null} API密钥或null（获取失败）
 */
async function getClaudeApiKey(req) {
  // 如果提供了请求对象，尝试从请求头获取Token
  if (req) {
    const reqToken = getTokenFromRequest(req);
    if (reqToken) {
      debugLog(3, "DEBUG", "使用请求头中的Token");
      return reqToken;
    }
  }

  // 优先使用直接配置的API密钥（确保不为空字符串）
  if (CLAUDE_API_KEY && CLAUDE_API_KEY.trim() !== '') {
    debugLog(3, "DEBUG", "使用配置中的API密钥");
    const apiKey = CLAUDE_API_KEY.trim();
    
    // 确保API密钥有Bearer前缀
    if (!apiKey.startsWith("Bearer ")) {
      debugLog(3, "DEBUG", "为配置中的API密钥添加Bearer前缀");
      return `Bearer ${apiKey}`;
    }
    return apiKey;
  }
  
  // 其次尝试从文件读取
  try {
    const tokenPath = CLAUDE_API_KEY_PATH;
    debugLog(3, "DEBUG", `尝试从文件读取API密钥: ${tokenPath}`);
    
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
    
    debugLog(3, "DEBUG", "成功从文件读取API密钥");
    
    // 确保API密钥有Bearer前缀
    if (!apiKey.startsWith("Bearer ")) {
      debugLog(3, "DEBUG", "为文件中的API密钥添加Bearer前缀");
      return `Bearer ${apiKey}`;
    }
    return apiKey;
  } catch (error) {
    console.error('[ERROR] 无法获取Claude API密钥:', error.message);
    return null;
  }
}

/**
 * 处理DeepClaude请求 - 混合模式
 * 该函数先从DeepSeek获取思考过程，然后使用Claude生成回复
 * 
 * @param {Object} req Express请求对象
 * @param {Object} res Express响应对象
 * @param {String} message 用户消息
 * @param {Boolean} stream 是否使用流式响应
 * @param {Object} claudeModel Claude模型模块
 * @param {Object} deepseekModel DeepSeek模型模块
 * @param {Object} debugOptions 调试选项
 */
export async function handleDeepClaudeRequest(req, res, message, stream, claudeModel, deepseekModel, debugOptions = {}) {
  try {
    console.log("[INFO] 开始处理DeepClaude请求");
    
    // 获取请求参数
    const { temperature = 0.7, max_tokens = 8192 } = req.body || {};
    
    // 如果使用流式输出，设置响应头
    if (stream) {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
    }
    
    // 获取Claude API KEY，传入请求对象以支持从请求头获取Token
    let claudeApiKey = await getClaudeApiKey(req);
    if (!claudeApiKey) {
      console.error("[ERROR] 无法获取Claude API密钥");
      if (stream) {
        res.write("event: error\ndata: {\"error\":\"无法获取Claude API密钥\"}\n\n");
        res.end();
      } else {
        res.status(500).json({ error: "无法获取Claude API密钥" });
      }
      return;
    }
    
    // 再次确保claudeApiKey包含Bearer前缀
    if (!claudeApiKey.startsWith("Bearer ")) {
      claudeApiKey = `Bearer ${claudeApiKey}`;
      console.log("[INFO] 最终调用前添加Bearer前缀到claudeApiKey");
    }
    
    console.log("[DEBUG] 最终Authorization头:", claudeApiKey.substring(0, 15) + "...");
    
    // 生成唯一设备ID
    const deviceId = deepseekModel.generateDeviceId();
    
    // 创建会话
    console.log("[INFO] 创建DeepSeek会话...");
    const conversationId = await deepseekModel.createConversation(deviceId);
    if (!conversationId) {
      console.error("[ERROR] 创建DeepSeek会话失败");
      if (stream) {
        res.write("event: error\ndata: {\"error\":\"创建DeepSeek会话失败\"}\n\n");
        res.end();
      } else {
        res.status(500).json({ error: "创建DeepSeek会话失败" });
      }
      return;
    }
    console.log("[INFO] 成功创建会话ID:", conversationId);
    
    // 生成会话ID和时间戳，供所有SSE事件使用
    const id = crypto.randomUUID();
    const created = Math.floor(Date.now() / 1000);
    
    // 如果使用流式输出，发送初始 SSE 事件
    if (stream) {
      res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: "deepclaude", choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] })}\n\n`);
      if (res.flush) res.flush();
    }
    
    try {
      // 准备DeepSeek请求参数
      const timestamp = Math.floor(Date.now() / 1000).toString();
      const nonce = deepseekModel.generateNanoId(20);
      
      // 设定模型和用户操作
      const userAction = ["deep"]; // 使用deep模式获取思考过程
      
      // 检查是否需要添加online功能
      if (message.toLowerCase().includes("search") || message.toLowerCase().includes("查询") || 
          message.toLowerCase().includes("find") || message.toLowerCase().includes("搜索")) {
        userAction.push("online");
        console.log("[INFO] 检测到搜索相关关键词，启用online功能");
      }
      
      // 检查请求中的模型ID
      if (req.body && req.body.model) {
        const modelId = req.body.model.split(".").pop();
        if (modelId.endsWith("-search")) {
          // 如果模型ID以-search结尾，且userAction中还没有online
          if (!userAction.includes("online")) {
            userAction.push("online");
            console.log("[INFO] 根据模型ID启用online功能");
          }
        }
      }
      
      // 构建请求体
      const payload = {
        stream: true, // DeepSeek请求总是使用流式
        botCode: "AI_SEARCH",
        userAction: userAction.join(","),
        model: "deepseek",
        conversationId: conversationId,
        question: message
      };
      
      // 使用DeepSeek的签名生成函数
      let sign;
      try {
        sign = deepseekModel.generateSign(timestamp, payload, nonce);
      } catch (error) {
        // 如果无法访问DeepSeek的签名函数，使用本地实现
        sign = generateSignature(timestamp, payload, nonce);
      }
      
      // 获取API域名和User-Agent
      let DS_API_DOMAIN, DS_USER_AGENT;
      try {
        // 尝试从deepseekModel获取
        DS_API_DOMAIN = deepseekModel.getApiDomain();
        DS_USER_AGENT = deepseekModel.getUserAgent();
      } catch (error) {
        // 如果无法获取，使用环境变量或默认值
        DS_API_DOMAIN = process.env.DS_API_DOMAIN || "https://api-sh.dangbei.net";
        DS_USER_AGENT = process.env.DS_USER_AGENT || "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)";
      }
      
      // 构建API URL和请求头
      const apiUrl = `${DS_API_DOMAIN}/ai-search/chatApi/v1/chat`;
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
      
      console.log("[DEBUG] 发送DeepSeek思考请求...");
      
      // 处理非流式模式
      if (!stream) {
        // 创建空结果对象
        let result = {
          id: id,
          object: "chat.completion",
          created: created,
          model: "deepclaude",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: ""
              },
              finish_reason: "stop"
            }
          ],
          usage: {
            prompt_tokens: message.length,
            completion_tokens: 0,
            total_tokens: message.length
          }
        };
        
        // 收集完整的思考和回答内容
        let completeThinking = "";
        let completeAnswer = "";
        
        // 发送DeepSeek请求
        const dsResponse = await fetch(apiUrl, {
          method: "POST",
          headers: headers,
          body: JSON.stringify(payload),
        });
        
        if (!dsResponse.ok) {
          const errorText = await dsResponse.text();
          console.error("[ERROR] DeepSeek API错误:", dsResponse.status, errorText);
          res.status(500).json({ error: `DeepSeek API错误: ${dsResponse.status}` });
          return;
        }
        
        // 处理DeepSeek响应，收集完整思考内容
        const reader = dsResponse.body;
        const decoder = new TextDecoder("utf-8");
        const dataPrefix = "data:";
        
        let buffer = "";
        let thinkingFinished = false;
        
        console.log("[INFO] 开始接收思考内容...");
        
        // 收集思考内容
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
                completeThinking += data.content;
              }
              // 检测到非思考内容，表示思考已结束
              else if (data.type === "answer" && data.content_type !== "thinking") {
                thinkingFinished = true;
                break;
              }
            } catch (error) {
              console.warn("[WARN] 解析DeepSeek响应出错:", error.message);
            }
          }
          
          // 如果思考已结束，退出读取循环
          if (thinkingFinished) break;
        }
        
        console.log(`[INFO] 思考内容收集完成，总长度: ${completeThinking.length} 字符`);
        
        // 使用Claude处理思考内容
        if (completeThinking.length > 0) {
          console.log("[INFO] 开始调用Claude处理完整思考内容");
          
          // 构建带有思考内容的提示
          const prompt = `Here's my original input:
${message}

Here's the reasoning from another model:
${completeThinking.trim()}

Based on this reasoning, please provide your response:`;
          
          // 打印Claude的输入内容到控制台
          console.log("[DEBUG] Claude输入内容：\n", prompt);
          
          // 构建Claude请求体
          const requestData = {
            provider: CLAUDE_PROVIDER,
            model: CLAUDE_DEFAULT_MODEL,
            provider_request: {
              model: CLAUDE_DEFAULT_MODEL,
              max_tokens: max_tokens,
              messages: [
                {
                  role: "user",
                  content: [
                    {
                      type: "text",
                      text: prompt,
                    },
                  ],
                },
              ],
              system: "",
              temperature: temperature,
            },
          };
          
          // 确保API密钥包含Bearer前缀
          if (!claudeApiKey.startsWith("Bearer ")) {
            claudeApiKey = `Bearer ${claudeApiKey}`;
            console.log("[INFO] 调用Claude API前添加Bearer前缀");
          }
          
          try {
            // 发送Claude请求
            const claudeResponse = await axios({
              method: "post",
              url: CLAUDE_API_URL,
              headers: {
                "Content-Type": "application/json",
                Authorization: `${claudeApiKey}`,
              },
              data: requestData,
              timeout: 120000, // 2分钟超时
            });
            
            // 处理Claude响应
            if (claudeResponse.data && 
                claudeResponse.data.output && 
                claudeResponse.data.output.content) {
              
              completeAnswer = claudeResponse.data.output.content;
              
              // 更新结果
              result.choices[0].message.content = 
                `<思考过程>\n${completeThinking.trim()}\n</思考过程>\n\n${completeAnswer}`;
              
              // 更新token计数
              result.usage.completion_tokens = completeAnswer.length;
              result.usage.total_tokens = result.usage.prompt_tokens + result.usage.completion_tokens;
              
              // 返回完整结果
              res.json(result);
            } else {
              console.error("[ERROR] Claude响应格式不正确");
              res.status(500).json({ error: "Claude响应格式不正确" });
            }
          } catch (claudeError) {
            console.error("[ERROR] Claude API错误:", claudeError.message);
            res.status(500).json({ error: `Claude API错误: ${claudeError.message}` });
          }
        } else {
          console.error("[ERROR] 未收集到有效思考内容");
          res.status(500).json({ error: "未收集到有效思考内容" });
        }
        
        return;
      }
      
      // 处理流式响应模式
      // 发送DeepSeek请求
      const dsResponse = await fetch(apiUrl, {
        method: "POST",
        headers: headers,
        body: JSON.stringify(payload),
      });
      
      if (!dsResponse.ok) {
        const errorText = await dsResponse.text();
        console.error("[ERROR] DeepSeek API错误:", dsResponse.status, errorText);
        res.write(`event: error\ndata: {\"error\":\"DeepSeek API错误: ${dsResponse.status}\"}\n\n`);
        res.end();
        return;
      }
      
      // 处理DeepSeek响应，收集完整思考内容
      const reader = dsResponse.body;
      const decoder = new TextDecoder("utf-8");
      const dataPrefix = "data:";
      
      let buffer = "";
      let completeThinking = ""; // 完整思考内容
      let thinkingFinished = false;
      let isInThinking = false; // 标记是否已发送思考开始标签
      
      console.log("[INFO] 开始接收思考内容...");
      
      // 第一步：完整收集思考内容，同时实时流式输出
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
                completeThinking += data.content;
                
                // 首次收到思考内容，发送思考开始标签
                if (!isInThinking) {
                  isInThinking = true;
                  
                  // 与DeepSeek格式一致的思考开始标签
                  const thinkingStartEvent = {
                    id,
                    object: "chat.completion.chunk",
                    created,
                    model: "deepclaude",
                    choices: [
                      {
                        index: 0,
                        delta: { content: "<思考过程>\n" },
                        finish_reason: null
                      }
                    ]
                  };
                  
                  res.write(`data: ${JSON.stringify(thinkingStartEvent)}\n\n`);
                  if (res.flush) res.flush();
                }
                
                // 流式发送思考内容，与DeepSeek格式一致
                const thinkingChunkEvent = {
                  id,
                  object: "chat.completion.chunk",
                  created,
                  model: "deepclaude",
                  choices: [
                    {
                      index: 0,
                      delta: { content: data.content },
                      finish_reason: null
                    }
                  ]
                };
                
                res.write(`data: ${JSON.stringify(thinkingChunkEvent)}\n\n`);
                if (res.flush) res.flush();
                
                // 定期记录进度
                if (completeThinking.length % 1000 === 0) {
                  console.log(`[INFO] 已收集思考内容 ${completeThinking.length} 字符`);
                }
              }
              // 检测到非思考内容，表示思考已结束
              else if (data.type === "answer" && data.content_type !== "thinking") {
                thinkingFinished = true;
                console.log("[INFO] 检测到思考内容结束标记");
                break;
              }
            } catch (error) {
              console.warn("[WARN] 解析DeepSeek响应出错:", error.message);
            }
          }
          
          // 如果思考已结束，退出读取循环
          if (thinkingFinished) break;
        }
        
        // 发送思考结束事件，与DeepSeek格式一致
        console.log(`[INFO] 思考内容收集完成，总长度: ${completeThinking.length} 字符`);
        
        if (isInThinking) {
          const thinkingEndEvent = {
            id,
            object: "chat.completion.chunk",
            created,
            model: "deepclaude",
            choices: [
              {
                index: 0,
                delta: { content: "\n</思考过程>\n\n" },
                finish_reason: null
              }
            ]
          };
          
          res.write(`data: ${JSON.stringify(thinkingEndEvent)}\n\n`);
          if (res.flush) res.flush();
        }
        
        // 添加短暂的处理延迟，让用户感知到阶段转换
        await new Promise(resolve => setTimeout(resolve, 500));
        
        // 第二步：使用Claude处理完整思考内容
        if (completeThinking.length > 0) {
          console.log("[INFO] 开始调用Claude处理完整思考内容");
          
          // 构建带有思考内容的提示
          const prompt = `Here's my original input:
${message}

Here's the reasoning from another model:
${completeThinking.trim()}

Based on this reasoning, please provide your response:`;
          
          // 打印Claude的输入内容到控制台
          console.log("[DEBUG] Claude输入内容：\n", prompt);
          
          // 构建Claude请求体
          const requestData = {
            provider: CLAUDE_PROVIDER,
            model: CLAUDE_DEFAULT_MODEL,
            provider_request: {
              model: CLAUDE_DEFAULT_MODEL,
              max_tokens: max_tokens,
              messages: [
                {
                  role: "user",
                  content: [
                    {
                      type: "text",
                      text: prompt,
                    },
                  ],
                },
              ],
              system: "",
              temperature: temperature,
            },
          };
          
          // 确保API密钥包含Bearer前缀
          if (!claudeApiKey.startsWith("Bearer ")) {
            claudeApiKey = `Bearer ${claudeApiKey}`;
            console.log("[INFO] 调用Claude API前添加Bearer前缀");
          }
          
          // 发送Claude请求
          const claudeResponse = await axios({
            method: "post",
            url: CLAUDE_API_URL,
            headers: {
              "Content-Type": "application/json",
              Authorization: `${claudeApiKey}`,
            },
            data: requestData,
            responseType: "stream",
            timeout: 120000, // 2分钟超时
          });
          
          // 处理Claude流式响应
          claudeResponse.data.on("data", (chunk) => {
            const chunkStr = chunk.toString();
            const lines = chunkStr.split("\n").filter((line) => line.trim());
            
            for (const line of lines) {
              try {
                const data = JSON.parse(line);
                
                if (data.type === "content_block_delta" && data.delta.type === "text_delta") {
                  const textChunk = data.delta.text;
                  
                  // 发送文本块作为SSE事件，与DeepSeek格式一致
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
                  if (res.flush) res.flush();
                }
              } catch (error) {
                console.warn("[WARN] 解析Claude响应出错:", error.message);
              }
            }
          });
          
          // Claude响应结束处理
          claudeResponse.data.on("end", () => {
            // 发送结束SSE事件
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
            
            console.log("[INFO] Claude响应处理完成");
          });
          
          // Claude响应错误处理
          claudeResponse.data.on("error", (err) => {
            console.error("[ERROR] Claude流数据接收错误:", err.message);
            res.write(`event: error\ndata: ${JSON.stringify({ error: "Claude流数据接收错误: " + err.message })}\n\n`);
            res.end();
          });
        } else {
          console.error("[ERROR] 未收集到有效思考内容");
          res.write(`event: error\ndata: {\"error\":\"未收集到有效思考内容\"}\n\n`);
          res.end();
        }
      } catch (streamError) {
        console.error("[ERROR] 处理思考内容流错误:", streamError.message);
        res.write(`event: error\ndata: ${JSON.stringify({ error: "处理思考内容失败: " + streamError.message })}\n\n`);
        res.end();
      }
    } catch (error) {
      console.error("[ERROR] DeepClaude请求处理错误:", error.message);
      if (stream) {
        res.write(`event: error\ndata: ${JSON.stringify({ error: "处理请求失败: " + error.message })}\n\n`);
        res.end();
      } else {
        res.status(500).json({ error: "处理请求失败: " + error.message });
      }
    }
  } catch (error) {
    console.error("[ERROR] 处理DeepClaude请求失败:", error.message);
    if (stream) {
      res.write(`event: error\ndata: ${JSON.stringify({ error: "处理请求失败: " + error.message })}\n\n`);
      res.end();
    } else {
      res.status(500).json({ error: "处理请求失败: " + error.message });
    }
  }
}

/**
 * 生成随机字符串
 * @param {number} length 字符串长度
 * @returns {string} 随机字符串
 */
function generateRandomString(length) {
  const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  const charactersLength = characters.length;
  
  for (let i = 0; i < length; i++) {
    result += characters.charAt(Math.floor(Math.random() * charactersLength));
  }
  
  return result;
}

/**
 * 生成签名
 * @param {string} timestamp 时间戳
 * @param {object} payload 请求体
 * @param {string} nonce 随机字符串
 * @returns {string} 签名
 */
function generateSignature(timestamp, payload, nonce) {
  // 创建一个干净的对象副本，防止循环引用
  const cleanPayload = { ...payload };
  
  // 确保没有循环引用
  if (cleanPayload.req) delete cleanPayload.req;
  if (cleanPayload.res) delete cleanPayload.res;
  
  const payloadStr = JSON.stringify(cleanPayload, null, 0);
  const signStr = `${timestamp}${payloadStr}${nonce}`;
  const sign = crypto.createHash("md5").update(signStr).digest("hex").toUpperCase();
  return sign;
}