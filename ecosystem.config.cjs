/**
 * PM2配置文件
 * =========================================================
 * 此文件配置PM2进程管理器如何运行应用
 */
module.exports = {
  apps: [{
    name: "multi-model-api",
    script: "api-server.js",
    instances: 2,        // 使用最大核心数量
    exec_mode: "cluster",    // 使用集群模式实现负载均衡
    watch: false,            // 不自动重启
    max_memory_restart: "500M", // 内存超过1G时重启
    log_date_format: "YYYY-MM-DD HH:mm:ss",
    
    // 开发环境配置
    env: {
      NODE_ENV: "development",
      PORT: 3000,
      DEBUG_MODE: "true"
    },
    
    // 生产环境配置 (使用 --env production 启动)
    env_production: {
      NODE_ENV: "production",
      PORT: 3000,
      DEBUG_MODE: "false"
    }
  }]
}; 