/**
 * DeepSeek模型处理模块
 * ==========================
 * 处理DeepSeek模型的请求和响应
 */

import crypto from 'crypto';
import fetch from 'node-fetch';

// 配置参数，将从主服务器传入
let DS_API_DOMAIN;
let DS_USER_AGENT;
let DS_TIMEOUT_MS;
let DEBUG_MODE;
let DEBUG_LEVEL;

/**
 * 初始化模块
 * 设置模块所需的配置参数
 * 
 * @param {Object} config 配置对象
 */
export function initialize(config) {
  console.log("DeepSeek模型初始化开始，接收到配置对象:", JSON.stringify(config.deepseek, null, 2));
  
  if (!config.deepseek) {
    throw new Error("缺少DeepSeek配置，请检查config.yaml文件中的deepseek部分");
  }
  
  DS_API_DOMAIN = config.deepseek.api_domain;
  DS_USER_AGENT = config.deepseek.user_agent;
  DS_TIMEOUT_MS = config.deepseek.timeout_ms || 30000;
  DEBUG_MODE = config.server.debug_mode;
  DEBUG_LEVEL = config.server.debug_level || 1;
  
  // 检查必要参数
  if (!DS_API_DOMAIN) {
    throw new Error("DeepSeek API域名未配置，请在config.yaml中设置deepseek.api_domain");
  }
  
  if (!DS_USER_AGENT) {
    throw new Error("DeepSeek User-Agent未配置，请在config.yaml中设置deepseek.user_agent");
  }
  
  console.log("DeepSeek模型初始化完成，配置参数:", {
    DS_API_DOMAIN,
    DS_USER_AGENT,
    DS_TIMEOUT_MS,
    DEBUG_MODE,
    DEBUG_LEVEL
  });
  
  console.log("DeepSeek模型将始终使用原有配置Token，不处理请求头中的Token");
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
 * 生成设备ID
 * 为DeepSeek API创建唯一设备标识
 * 
 * @returns {string} 生成的设备ID
 */
export function generateDeviceId() {
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
 * 用于DeepSeek API请求的唯一ID
 * 
 * @param {number} size ID长度
 * @returns {string} 生成的随机ID
 */
export function generateNanoId(size = 21) {
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
export function generateSign(timestamp, payload, nonce) {
  // 创建一个干净的对象副本，防止循环引用
  const cleanPayload = { ...payload };
  
  // 确保没有循环引用
  if (cleanPayload.req) delete cleanPayload.req;
  if (cleanPayload.res) delete cleanPayload.res;
  
  const payloadStr = JSON.stringify(cleanPayload, null, 0);
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
export async function createConversation(deviceId) {
  const payload = { botCode: "AI_SEARCH" };
  // 确保时间戳格式为字符串
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
  
  // 更详细的调试日志
  console.log(`[INFO] 创建DeepSeek对话: ${apiUrl}`);
  console.log(`[DEBUG] 配置参数检查: API_DOMAIN=${DS_API_DOMAIN}, USER_AGENT=${DS_USER_AGENT}`);
  console.log(`[DEBUG] 请求头: ${JSON.stringify(headers)}`);
  console.log(`[DEBUG] 请求体: ${JSON.stringify(payload)}`);
  
  try {
    // 创建对话请求，延长超时时间
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), DS_TIMEOUT_MS || 60000);
    
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

    // 如果响应不是200，记录错误并返回null
    if (!response.ok) {
      console.error(`创建对话失败: HTTP ${response.status}`, responseText);
      return null;
    }

    try {
      const jsonResponse = JSON.parse(responseText);
      console.log(`[DEBUG] API响应: ${JSON.stringify(jsonResponse)}`);
      
      if (!jsonResponse.success) {
        console.error("创建对话API返回失败:", jsonResponse.errMessage || "未知错误");
        return null;
      }

      const conversationId = jsonResponse.data?.conversationId;
      if (!conversationId) {
        console.error("创建对话返回的会话ID为空");
        return null;
      }

      debugLog(1, "INFO", `成功创建会话: ${conversationId}`);
      console.log(`[INFO] 成功创建会话: ${conversationId}`);
      return conversationId;
    } catch (parseError) {
      console.error("解析创建对话响应失败:", parseError, responseText);
      return null;
    }
  } catch (error) {
    console.error("创建对话请求失败:", error);
    return null;
  }
}

/**
 * 处理DeepSeek非流式响应，提取思考内容
 */
async function handleDeepSeekNonStreamResponseWithThinking(fetchResponse) {
  const reader = fetchResponse.body;
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
          
          // 处理思考内容
          if (data.content_type === "thinking" && data.content) {
            thinkingText += data.content;
          }
          // 处理回答内容
          else if (data.type === "answer" && data.content && data.content_type !== "thinking") {
            responseText += data.content;
          }
        } catch (e) {
          debugLog(2, "ERROR", "Error parsing line:", e, line);
        }
      }
    }
    
    return { responseText, thinkingText };
  } catch (err) {
    console.error("Error in non-stream response handling:", err);
    throw err;
  }
}

/**
 * 处理DeepSeek请求
 * 支持流式和非流式响应
 * 
 * @param {object} req Express请求对象
 * @param {object} res Express响应对象
 * @param {string} userInput 用户输入
 * @param {boolean} stream 是否使用流式响应
 * @param {object} debugOptions 调试选项
 */
export async function handleDeepSeekRequest(req, res, userInput, stream = true, debugOptions = {}) {
  try {
    // 检查初始化状态
    if (!DS_API_DOMAIN || !DS_USER_AGENT) {
      console.error("[ERROR] DeepSeek 模块未正确初始化，参数缺失:", { 
        DS_API_DOMAIN, 
        DS_USER_AGENT, 
        DS_TIMEOUT_MS 
      });
      
      if (stream) {
        res.write("event: error\ndata: {\"error\":\"DeepSeek 模块配置错误，请检查服务器配置\"}\n\n");
        res.end();
      } else {
        res.status(500).json({
          error: {
            message: "DeepSeek 模块配置错误，请检查服务器配置",
            type: "server_error"
          }
        });
      }
      return;
    }

    // 确保响应头设置正确
    if (stream) {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
    } else {
      res.setHeader("Content-Type", "application/json");
    }

    // 生成设备ID
    const deviceId = generateDeviceId();
    console.log("[INFO] Generated Device ID:", deviceId);
    
    // 创建对话
    console.log("[INFO] 开始创建DeepSeek会话...");
    const conversationId = await createConversation(deviceId);
    console.log("[INFO] 创建会话结果:", conversationId);
    
    if (!conversationId) {
      console.error("[ERROR] 创建 DeepSeek 会话失败，返回null");
      
      if (stream) {
        res.write("event: error\ndata: {\"error\":\"创建 DeepSeek 会话失败\"}\n\n");
        res.end();
      } else {
        res.status(500).json({
          error: {
            message: "创建 DeepSeek 会话失败",
            type: "server_error"
          }
        });
      }
      return;
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

    console.log("[DEBUG] Chat API请求参数:", { 
      url: `${DS_API_DOMAIN}/ai-search/chatApi/v1/chat`,
      deviceId,
      conversationId,
      timestamp,
      nonce
    });

    const fetchResponse = await fetch(`${DS_API_DOMAIN}/ai-search/chatApi/v1/chat`, {
      method: "POST",
      headers: headers,
      body: JSON.stringify(payload),
    });

    if (!fetchResponse.ok) {
      const errorText = await fetchResponse.text();
      console.error("[ERROR] DeepSeek API错误响应:", fetchResponse.status, errorText);
      
      if (stream) {
        res.write(`event: error\ndata: {\"error\":\"DeepSeek API 错误: ${fetchResponse.status}\"}\n\n`);
        res.end();
      } else {
        res.status(fetchResponse.status).json({
          error: {
            message: `DeepSeek API 错误: ${fetchResponse.status}`,
            type: "api_error",
            details: errorText
          }
        });
      }
      return;
    }

    // 处理流式和非流式响应的代码保持不变
    if (stream) {
      // 流式响应处理
      const reader = fetchResponse.body;
      const decoder = new TextDecoder("utf-8");
      const dataPrefix = "data:";
      
      let buffer = "";
      let fullResponse = "";
      let id = crypto.randomUUID();
      let created = Math.floor(Date.now() / 1000);
      let isFirstThinking = true; // 标记是否是第一个思考内容
      let isInThinking = false; // 标记当前是否在输出思考内容
      
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
              
              // 处理思考内容 - 流式输出
              if (data.content_type === "thinking" && data.content) {
                // 第一次收到思考内容时，先输出思考开始标签
                if (isFirstThinking) {
                  isFirstThinking = false;
                  isInThinking = true;
                  
                  // 发送思考开始标签
                  const thinkingStartEvent = {
                    id,
                    object: "chat.completion.chunk",
                    created,
                    model: "deepseek-r1",
                    choices: [
                      {
                        index: 0,
                        delta: { content: "<思考过程>\n" },
                        finish_reason: null
                      }
                    ]
                  };
                  
                  res.write(`data: ${JSON.stringify(thinkingStartEvent)}\n\n`);
                }
                
                // 实时发送每一块思考内容
                const thinkingChunkEvent = {
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
                
                res.write(`data: ${JSON.stringify(thinkingChunkEvent)}\n\n`);
              }
              // 处理回答内容
              else if (data.type === "answer" && data.content && data.content_type !== "thinking") {
                // 如果刚从思考模式切换到回答模式，先发送思考结束标签
                if (isInThinking) {
                  isInThinking = false;
                  
                  // 发送思考结束标签和分隔符
                  const thinkingEndEvent = {
                    id,
                    object: "chat.completion.chunk",
                    created,
                    model: "deepseek-r1",
                    choices: [
                      {
                        index: 0,
                        delta: { content: "\n</思考过程>\n\n" },
                        finish_reason: null
                      }
                    ]
                  };
                  
                  res.write(`data: ${JSON.stringify(thinkingEndEvent)}\n\n`);
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
              console.error("[ERROR] Error parsing line:", e, line);
            }
          }
          
          // 刷新缓冲区，确保内容立即发送
          if (res.flush && typeof res.flush === 'function') {
            res.flush();
          }
        }
        
        // 如果结束时仍在思考模式，需要关闭思考标签
        if (isInThinking) {
          const thinkingEndEvent = {
            id,
            object: "chat.completion.chunk",
            created,
            model: "deepseek-r1",
            choices: [
              {
                index: 0,
                delta: { content: "\n</思考过程>\n\n" },
                finish_reason: null
              }
            ]
          };
          
          res.write(`data: ${JSON.stringify(thinkingEndEvent)}\n\n`);
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
        console.error("[ERROR] Error in stream handling:", err);
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
      // 非流式响应处理
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
    console.error("[ERROR] DeepSeek API 错误:", error);
    if (!res.headersSent) {
      if (stream) {
        res.write(`event: error\ndata: ${JSON.stringify({ error: "调用 DeepSeek API 失败: " + error.message })}\n\n`);
        res.end();
      } else {
        res.status(500).json({
          error: {
            message: "调用 DeepSeek API 失败",
            type: "server_error",
            details: error.message
          }
        });
      }
    }
  }
}

/**
 * 获取DeepSeek思考内容
 * 用于DeepClaude混合模式
 * 
 * @param {string} deviceId 设备ID
 * @param {string} existingConversationId 现有会话ID（可选）
 * @param {string} message 用户消息
 * @returns {string} 思考内容
 */
export async function getDeepSeekThinking(deviceId, existingConversationId, message) {
  try {
    console.log("[INFO] 开始获取DeepSeek思考内容");
    
    // 先创建会话（如果没有提供现有会话ID）
    let conversationId = existingConversationId;
    if (!conversationId || conversationId.trim() === "") {
      console.log("[INFO] 创建新的DeepSeek会话");
      conversationId = await createConversation(deviceId);
      if (!conversationId) {
        console.error("[ERROR] 创建DeepSeek会话失败");
        return null;
      }
      console.log("[INFO] 成功创建会话:", conversationId);
      
      // 如果消息是"初始化会话"，则直接返回会话ID
      if (message === "初始化会话") {
        return conversationId;
      }
    }
    
    // 获取发送消息所需的参数
    const timestamp = Math.floor(Date.now() / 1000).toString();
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
    
    console.log("[DEBUG] DeepSeek思考内容请求参数:", { 
      deviceId, 
      conversationId, 
      message, 
      timestamp 
    });
    
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
      timestamp: timestamp,
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    };
    
    try {
      const response = await fetch(apiUrl, {
        method: "POST",
        headers: headers,
        body: JSON.stringify(payload),
      });
      
      if (!response.ok) {
        const errorText = await response.text();
        console.error("[ERROR] DeepSeek API错误响应:", response.status, errorText);
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
        console.warn("[WARN] 获取思考内容超时");
      }, 30000); // 延长到30秒超时
      
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
                // 打印进度日志，但不要过于频繁
                if (thinkingResponse.length % 500 === 0) {
                  console.log("[INFO] 思考内容收集中，当前长度:", thinkingResponse.length);
                }
              } else if (data.type === "answer" && data.content_type !== "thinking") {
                // 一旦开始接收实际回答，就中断处理
                if (thinkingResponse) {
                  console.log("[INFO] 开始接收回答，思考内容收集完成，长度:", thinkingResponse.length);
                  shouldExit = true;
                  break;
                }
              }
            } catch (e) {
              // 忽略解析错误
              console.log("[WARN] 解析错误:", e.message);
            }
          }
        }
      } finally {
        clearTimeout(readTimeout);
      }
      
      console.log("[INFO] 成功获取思考内容，长度:", thinkingResponse.length);
      return thinkingResponse;
    } catch (apiError) {
      console.error("[ERROR] 调用DeepSeek API错误:", apiError.message);
      throw apiError; // 重新抛出以便上层处理
    }
  } catch (error) {
    console.error("[ERROR] 获取DeepSeek思考内容失败:", error.message);
    return null;
  }
}

/**
 * 获取API域名
 * @returns {string} DeepSeek API域名
 */
export function getApiDomain() {
  return DS_API_DOMAIN;
}

/**
 * 获取User-Agent
 * @returns {string} 请求使用的User-Agent
 */
export function getUserAgent() {
  return DS_USER_AGENT;
} 