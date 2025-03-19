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
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';
import os from 'os';

// 导入模型处理模块
import * as claudeModel from './models/claude-model.js';
import * as deepseekModel from './models/deepseek-model.js';
import * as deepclaudeModel from './models/deepclaude-model.js';

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

// 初始化各模型模块
console.log("开始初始化模型模块...");
try {
  console.log("初始化Claude模型");
  claudeModel.initialize(config);
  console.log("初始化DeepSeek模型");
  deepseekModel.initialize(config);
  console.log("初始化DeepClaude模型");
  deepclaudeModel.initialize(config);
  console.log("所有模型初始化完成");
} catch (error) {
  console.error("模型初始化失败:", error);
  process.exit(1);
}

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
 * 健康检查端点
 * 用于检查服务器是否正常运行
 */
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

/**
 * 模型列表端点
 * 返回所有支持的模型
 */
app.get('/v1/models', (req, res) => {
  const supportedModels = [
    { id: 'claude-3-sonnet-latest', name: 'Claude 3 Sonnet', provider: 'anthropic' },
    { id: 'deepseek-r1', name: 'DeepSeek R1', provider: 'deepseek' },
    { id: 'deepclaude', name: 'DeepClaude (混合模型)', provider: 'hybrid' },
  ];
  
  // 添加时间戳，与OpenAI API兼容
  const modelsWithDates = supportedModels.map(model => ({
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
    console.log("收到聊天完成请求");
    
    // 获取请求参数
    const { model, messages, stream = true, temperature = 0.7, max_tokens = 8192 } = req.body;
    
    // 确保消息数组存在
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({
        error: {
          message: "消息数组不能为空",
          type: "invalid_request_error",
          param: "messages",
          code: "invalid_messages"
        }
      });
    }

    // 提取用户消息
    const lastMessage = messages[messages.length - 1];
    if (lastMessage.role !== "user") {
      return res.status(400).json({
        error: {
          message: "最后一条消息必须是用户消息",
          type: "invalid_request_error",
          param: "messages",
          code: "invalid_message_role"
        }
      });
    }

    const userMessage = lastMessage.content;
    if (typeof userMessage !== "string" || userMessage.trim() === "") {
      return res.status(400).json({
        error: {
          message: "用户消息不能为空",
          type: "invalid_request_error",
          param: "messages",
          code: "invalid_message_content"
        }
      });
    }
    
    // 调试选项
    const debugOptions = {
      debugLevel: config.debugLevel || 1,
      debugMode: config.debugMode || false
    };
    
    console.log(`处理模型请求: ${model}, 用户消息: ${userMessage.substring(0, 50)}${userMessage.length > 50 ? '...' : ''}`);
    console.log(`流式响应: ${stream}, 温度: ${temperature}, 最大令牌数: ${max_tokens}`);
    
    // 根据模型类型路由请求
    if (model.toLowerCase().includes("deepseek")) {
      await deepseekModel.handleDeepSeekRequest(req, res, userMessage, stream, debugOptions);
    } else if (model.toLowerCase().includes("deepclaude")) {
      await deepclaudeModel.handleDeepClaudeRequest(req, res, userMessage, stream, claudeModel, deepseekModel, debugOptions);
    } else if (model.toLowerCase().includes("claude")) {
      await claudeModel.handleClaudeRequest(req, res, userMessage, stream, debugOptions);
    } else {
      res.status(400).json({
          error: {
          message: `不支持的模型: ${model}`,
          type: "invalid_request_error",
          param: "model",
          code: "model_not_found"
        }
      });
    }
  } catch (error) {
    console.error("处理请求时出错:", error);
    
    // 检查是否已发送响应头
        if (!res.headersSent) {
          res.status(500).json({
            error: {
          message: "服务器内部错误",
          type: "server_error",
          details: error.message
        }
      });
    }
  }
});

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
        message: "请求格式不正确，需要提供tokens数组",
        type: "invalid_request_error",
        code: "invalid_request_body"
      }
    });
  }
  
  // 更新令牌文件
  try {
    // 创建令牌目录(如果不存在)
    const tokenDir = path.join(__dirname, 'tokens');
    if (!fs.existsSync(tokenDir)) {
      fs.mkdirSync(tokenDir, { recursive: true });
    }
    
    // 处理每个令牌
    const results = [];
    
    for (const token of tokens) {
      const { name, value } = token;
      
      if (!name || !value) {
        results.push({
          name: name || "[未命名]",
          success: false,
          error: "令牌名称和值都是必需的"
        });
        continue;
      }
      
      // 格式化文件名，避免路径遍历
      const safeFileName = name.replace(/[^a-zA-Z0-9-_]/g, '_');
      const tokenPath = path.join(tokenDir, `${safeFileName}.token`);
      
      try {
        fs.writeFileSync(tokenPath, value.trim());
        debugLog(1, "INFO", `令牌已更新: ${safeFileName}`);
        results.push({
          name: name,
          success: true,
          path: tokenPath
        });
      } catch (writeError) {
        console.error(`写入令牌文件失败: ${writeError.message}`);
        results.push({
          name: name,
          success: false,
          error: `写入令牌文件失败: ${writeError.message}`
        });
      }
    }
    
    res.json({
      status: "success",
      results: results
    });
  } catch (error) {
    console.error("更新令牌时出错:", error);
    res.status(500).json({
      error: {
        message: "处理令牌更新请求失败",
        type: "server_error",
        details: error.message
      }
    });
  }
});

/**
 * 获取本地IPv4地址
 * 用于显示启动信息
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