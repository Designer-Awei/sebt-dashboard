const { app, BrowserWindow, ipcMain, shell } = require('electron');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');
const { BLEManager } = require('./ble-manager');

let mainWindow;
let btManager;
let httpServer;
let wss;

/**
 * 创建主窗口
 * @returns {BrowserWindow}
 */
function createWindow() {
  const window = new BrowserWindow({
    width: 1400,
    height: 900,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    },
    title: 'SEBT 平衡测试系统',
    show: false
  });

  window.loadFile('index.html');

  window.once('ready-to-show', () => {
    window.show();
  });

  window.on('closed', () => {
    mainWindow = null;
    // 通知浏览器关闭BLE驱动页面
    notifyBrowserCloseBLEDriver();
    // 窗口关闭时清理WebSocket服务器
    cleanupWebSocketServer();
  });

  if (process.env.NODE_ENV === 'development') {
    window.webContents.openDevTools();
  }

  return window;
}

/**
 * 创建WebSocket服务器
 */
function createWebSocketServer() {
  const PORT = 3000;

  // 检查是否已经创建了服务器
  if (httpServer || wss) {
    console.log('📡 WebSocket服务器已在运行');
    return Promise.resolve();
  }

  // 检查端口是否被占用
  const net = require('net');
  const testServer = net.createServer();

  return new Promise((resolve, reject) => {
    testServer.listen(PORT, (err) => {
      testServer.close((closeErr) => {
        if (err) {
          console.error(`❌ 端口${PORT}已被占用:`, err.message);
          reject(new Error(`端口${PORT}已被占用`));
          return;
        }

        console.log(`✅ 端口${PORT}可用，开始创建WebSocket服务器`);

        // 创建HTTP服务器用于提供静态文件
        httpServer = http.createServer((req, res) => {
          if (req.url === '/' || req.url === '/ble-driver.html') {
            const filePath = path.join(__dirname, 'public', 'ble-driver.html');
            fs.readFile(filePath, (err, data) => {
              if (err) {
                res.writeHead(404);
                res.end('File not found');
                return;
              }
              res.writeHead(200, { 'Content-Type': 'text/html' });
              res.end(data);
            });
          } else if (req.url === '/favicon.ico') {
            // 返回空的favicon.ico以避免404错误
            res.writeHead(200, { 'Content-Type': 'image/x-icon' });
            res.end();
          } else {
            res.writeHead(404);
            res.end('Not found');
          }
        });

        // 处理服务器错误
        httpServer.on('error', (error) => {
          console.error('❌ HTTP服务器错误:', error);
          cleanupWebSocketServer();
        });

        // 启动HTTP服务器
        httpServer.listen(PORT, () => {
          console.log(`📡 WebSocket服务器已启动: http://localhost:${PORT}`);
        });

        // 创建WebSocket服务器
        wss = new WebSocket.Server({ server: httpServer });

        // 处理WebSocket服务器错误
        wss.on('error', (error) => {
          console.error('❌ WebSocket服务器错误:', error);
          cleanupWebSocketServer();
        });

        // 存储所有连接的WebSocket客户端
        const wsClients = new Set();

        wss.on('connection', (ws) => {
          console.log('🔗 浏览器BLE驱动已连接');
          wsClients.add(ws);

          // 心跳保活
          const pingInterval = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.ping();
            }
          }, 30000); // 每30秒发送一次ping

          ws.on('message', (message) => {
            try {
              const data = JSON.parse(message.toString());
              console.log('📨 收到BLE驱动消息:', data.type);

              // 统一通过 ble-manager.js 处理传感器数据，确保格式统一为 [[dir, dist], ...]
              if (btManager && data.type === 'sensor_data') {
                btManager.handleWebSocketData(data);
              } else {
                // 非传感器数据直接转发（如连接状态等）
              if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('bluetooth-data-received', {
                  type: 'scan_data',
                  data: JSON.stringify(data)
                });
                }
              }
            } catch (error) {
              console.error('❌ 解析BLE驱动消息失败:', error);
            }
          });

          ws.on('close', () => {
            console.log('🔌 浏览器BLE驱动连接已断开');
            wsClients.delete(ws);
            clearInterval(pingInterval);
          });

          ws.on('error', (error) => {
            console.error('❌ WebSocket连接错误:', error);
            wsClients.delete(ws);
            clearInterval(pingInterval);
          });

          // 发送连接确认
          ws.send(JSON.stringify({ type: 'connected', message: 'WebSocket连接成功' }));
        });

        // 广播消息到所有WebSocket客户端
        function broadcastToWSClients(data) {
          const message = JSON.stringify(data);
          wsClients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
              client.send(message);
            }
          });
        }

        // 将broadcastToWSClients函数暴露给全局，供BLE管理器使用
        global.broadcastToWSClients = broadcastToWSClients;

        resolve();
      });
    });

    testServer.on('error', (err) => {
      console.error(`❌ 检查端口${PORT}时出错:`, err.message);
      reject(err);
    });
  });
}

/**
 * 清理WebSocket服务器资源
 */
function cleanupWebSocketServer() {
  if (wss) {
    wss.close(() => {
      console.log('📡 WebSocket服务器已关闭');
      wss = null;
    });
  }

  if (httpServer) {
    httpServer.close(() => {
      console.log('🌐 HTTP服务器已关闭');
      httpServer = null;
    });
  }
}

/**
 * 打开BLE驱动浏览器
 */
function openBLEDriverBrowser() {
  const url = 'http://localhost:3000';
  console.log(`🌐 打开BLE驱动浏览器: ${url}`);
  shell.openExternal(url);
}

/**
 * 注册IPC事件
 */
function registerIPC() {
  // 扫描相关事件
  ipcMain.on('bt-start-scan', () => {
    console.log('📡 主进程收到BT扫描请求');
    btManager?.startScanning();
  });

  ipcMain.on('bt-stop-scan', () => {
    btManager?.stopScanning();
  });

  // 连接相关事件
  ipcMain.on('bt-connect', (_event, deviceId) => {
    console.log(`📡 主进程收到BT连接请求, 设备ID: ${deviceId}`);
    btManager?.connect(deviceId);
  });

  // 断开连接事件
  ipcMain.on('bt-disconnect', () => {
    btManager?.disconnect();
  });

  // 诊断和状态查询
  ipcMain.on('bt-diagnose', (event) => {
    const report = btManager?.diagnose() || {};
    event.reply('bt-diagnosis-result', report);
  });

  ipcMain.on('bluetooth-get-status', (event) => {
    const status = btManager?.getStatus() || { connected: false, device: null };
    event.reply('bluetooth-status', status);
  });

  // 命令发送（经典蓝牙模式下不支持命令发送）
  ipcMain.on('bt-send-command', (event, command) => {
    console.warn('[BLE] BLE模式不支持命令发送:', command);
    event.reply?.('bt-command-sent', { success: false, error: 'command-not-supported' });
  });
}

app.whenReady().then(async () => {
  mainWindow = createWindow();

  try {
    // 创建WebSocket服务器（带端口检查）
    await createWebSocketServer();
  } catch (error) {
    console.error('❌ 无法启动WebSocket服务器:', error.message);
    // 即使WebSocket服务器启动失败，应用仍可继续运行
  }

  // 延迟启动BT管理器，给WebSocket服务器启动时间
  setTimeout(() => {
    btManager = new BLEManager({
    mainWindow
  });

  registerIPC();
  
    // 自动开始监听
    console.log('🚀 启动BLE管理器，开始监听WebSocket数据...');
  btManager.startScanning();
  }, 100);
});

app.on('window-all-closed', () => {
  btManager?.dispose();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  btManager?.dispose();

  // 清理WebSocket服务器
  cleanupWebSocketServer();
});

// 监听窗口关闭事件，通知浏览器关闭BLE驱动页面
function notifyBrowserCloseBLEDriver() {
  if (global.broadcastToWSClients) {
    global.broadcastToWSClients({
      type: 'close_ble_driver',
      message: 'Electron主窗口已关闭，请关闭BLE驱动页面'
    });
  }
}