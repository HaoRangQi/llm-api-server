#!/usr/bin/env node
/**
 * 多模型API服务器测试脚本
 * =========================================================
 * 这个脚本测试服务器上的所有可用模型，包括:
 * - Claude 3.5/3.7
 * - DeepSeek R1
 * - DeepClaude 混合模型
 * 
 * 仅包含流式模式的测试
 */

import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';
import readline from 'readline';

// 加载配置文件以获取服务器地址和端口
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 测试配置
const CONFIG = {
  apiUrl: 'http://localhost:3000',
  timeout: 60000, // 60秒超时
  testPrompt: '用10个字简短介绍一下你自己'
};

// ANSI颜色代码
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  bgRed: '\x1b[41m',
  bgGreen: '\x1b[42m',
  bgYellow: '\x1b[43m'
};

/**
 * 加载配置文件
 */
function loadConfig() {
  try {
    const configFile = fs.readFileSync(path.join(__dirname, 'config.yaml'), 'utf8');
    return yaml.load(configFile);
  } catch (e) {
    console.error(`${colors.red}无法加载配置文件:${colors.reset}`, e.message);
    return null;
  }
}

/**
 * 格式化日志消息
 */
function formatLog(model, type, message, isError = false) {
  const modelColor = {
    'claude-3-7-sonnet-latest': colors.cyan,
    'claude-3-5-sonnet-latest': colors.blue,
    'deepseek-r1': colors.yellow,
    'deepclaude': colors.magenta
  };
  
  const color = modelColor[model] || colors.white;
  const typeColor = isError ? colors.red : colors.green;
  
  return `${color}[${model}]${colors.reset} ${typeColor}${type}${colors.reset}: ${message}`;
}

/**
 * 清除控制台
 */
function clearConsole() {
  const blank = '\n'.repeat(process.stdout.rows);
  console.log(blank);
  readline.cursorTo(process.stdout, 0, 0);
  readline.clearScreenDown(process.stdout);
}

/**
 * 打印测试标题
 */
function printTestHeader() {
  clearConsole();
  console.log(`${colors.bright}${colors.cyan}======================================${colors.reset}`);
  console.log(`${colors.bright}      多模型 API 服务器测试脚本      ${colors.reset}`);
  console.log(`${colors.bright}${colors.cyan}======================================${colors.reset}\n`);
  console.log(`${colors.yellow}API URL:${colors.reset} ${CONFIG.apiUrl}`);
  console.log(`${colors.yellow}测试提示语:${colors.reset} "${CONFIG.testPrompt}"`);
  console.log(`${colors.yellow}超时时间:${colors.reset} ${CONFIG.timeout / 1000} 秒\n`);
}

/**
 * 获取可用模型列表
 */
async function getAvailableModels() {
  try {
    const response = await fetch(`${CONFIG.apiUrl}/v1/models`);
    if (!response.ok) {
      throw new Error(`HTTP错误 ${response.status}`);
    }
    const data = await response.json();
    return data.data || [];
  } catch (error) {
    console.error(`${colors.red}获取模型列表失败:${colors.reset}`, error.message);
    return [];
  }
}

/**
 * 测试流式模式
 */
async function testStreamMode(model) {
  console.log(formatLog(model, '流式模式测试', '开始...'));
  
  const startTime = Date.now();
  let fullResponse = '';
  
  try {
    const response = await fetch(`${CONFIG.apiUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: model,
        messages: [
          { role: 'user', content: CONFIG.testPrompt }
        ],
        stream: true
      })
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`HTTP错误 ${response.status}: ${errorText}`);
    }
    
    // 流式响应
    const reader = response.body;
    const decoder = new TextDecoder();
    
    for await (const chunk of reader) {
      const text = decoder.decode(chunk);
      const lines = text.split('\n');
      
      for (const line of lines) {
        if (line.trim() === '' || !line.startsWith('data:')) continue;
        if (line.includes('[DONE]')) continue;
        
        try {
          const jsonStr = line.substring('data:'.length).trim();
          const data = JSON.parse(jsonStr);
          
          if (data.choices && data.choices[0] && data.choices[0].delta && data.choices[0].delta.content) {
            fullResponse += data.choices[0].delta.content;
            process.stdout.write('.');
          }
        } catch (e) {
          // 忽略解析错误，某些流式响应可能包含非JSON数据
        }
      }
    }
    
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(''); // 换行
    console.log(formatLog(model, `流式响应 (${duration}秒)`, `"${fullResponse.trim()}"`));
    return true;
  } catch (error) {
    console.log(''); // 换行
    console.error(formatLog(model, '流式模式失败', error.message, true));
    return false;
  }
}

/**
 * 主测试函数
 */
async function runTests() {
  printTestHeader();
  
  // 加载配置文件
  const config = loadConfig();
  if (!config) {
    console.error(`${colors.red}无法继续测试，配置文件加载失败${colors.reset}`);
    return;
  }
  
  // 验证Claude API配置
  if ((!config.claude.api_key || config.claude.api_key.trim() === '') && 
      (!config.claude.api_key_path || config.claude.api_key_path.trim() === '')) {
    console.error(`${colors.red}Claude API密钥配置无效：既未直接提供API密钥，也未提供有效的密钥文件路径${colors.reset}`);
  }
  
  // 验证密钥文件是否存在
  if (!config.claude.api_key && config.claude.api_key_path) {
    try {
      fs.accessSync(config.claude.api_key_path, fs.constants.R_OK);
      console.log(`${colors.green}Claude API密钥文件可访问${colors.reset}`);
    } catch (err) {
      console.error(`${colors.red}Claude API密钥文件不可访问: ${config.claude.api_key_path}${colors.reset}`);
    }
  }
  
  // 获取模型列表
  console.log(`${colors.yellow}正在获取可用模型...${colors.reset}`);
  const models = await getAvailableModels();
  
  if (models.length === 0) {
    console.error(`${colors.red}无法获取模型列表，请确保服务器正在运行${colors.reset}`);
    return;
  }
  
  console.log(`${colors.green}发现 ${models.length} 个模型${colors.reset}`);
  
  // 测试结果
  const results = {
    stream: { success: 0, fail: 0 }
  };
  
  // 运行测试
  for (const model of models) {
    console.log(`\n${colors.bright}${colors.cyan}正在测试模型:${colors.reset} ${model.id}`);
    
    // 测试流式模式
    const streamResult = await testStreamMode(model.id);
    if (streamResult) results.stream.success++;
    else results.stream.fail++;
  }
  
  // 打印测试结果摘要
  console.log(`\n${colors.bright}${colors.cyan}======================================${colors.reset}`);
  console.log(`${colors.bright}              测试结果摘要              ${colors.reset}`);
  console.log(`${colors.bright}${colors.cyan}======================================${colors.reset}\n`);
  
  console.log(`${colors.yellow}流式模式:${colors.reset} ${colors.green}成功: ${results.stream.success}${colors.reset}, ${colors.red}失败: ${results.stream.fail}${colors.reset}`);
  
  // 总体测试结果
  const allSuccess = results.stream.fail === 0;
  if (allSuccess) {
    console.log(`\n${colors.bgGreen}${colors.bright} 所有测试通过! ${colors.reset}`);
  } else {
    console.log(`\n${colors.bgRed}${colors.bright} 测试失败! ${colors.reset} 请检查错误日志`);
  }
}

// 执行测试
runTests().catch(error => {
  console.error(`${colors.red}测试过程中发生错误:${colors.reset}`, error);
}); 