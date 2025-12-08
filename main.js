const { app, BrowserWindow } = require('electron');
const path = require('path');
const express = require('express');
const os = require('os');

let mainWindow;
let expressServer;

// 获取本机局域网IP地址
function getLocalIPAddress() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      // 跳过内部地址和非IPv4地址
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return '127.0.0.1'; // 如果找不到，返回localhost
}

// 创建Express服务器
function createExpressServer() {
  const app = express();
  const PORT = 3000;

  // 中间件
  app.use(express.json());

  // CORS中间件
  app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    next();
  });

  // POST /upload 接口
  app.post('/upload', (req, res) => {
    try {
      const { direction, distance, ip } = req.body;

      console.log('📡 收到传感器数据:', { direction, distance, ip });

      // 验证数据
      if (!direction || typeof distance !== 'number') {
        return res.status(400).json({ error: '无效的数据格式' });
      }

      // 通过IPC转发给渲染进程
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('sensor-data', {
          direction,
          distance: parseInt(distance),
          ip,
          timestamp: Date.now(),
          source: 'hardware' // 标记为硬件数据
        });
      }

      res.json({ success: true, message: '数据接收成功' });
    } catch (error) {
      console.error('处理上传数据时出错:', error);
      res.status(500).json({ error: '服务器内部错误' });
    }
  });

  // GET /status 接口 - 检查服务器状态
  app.get('/status', (req, res) => {
    res.json({
      status: 'running',
      server: 'SEBT Dashboard',
      version: '1.0.0',
      timestamp: new Date().toISOString()
    });
  });

  // 启动服务器
  expressServer = app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Express服务器启动在端口 ${PORT}`);

    // 启动mDNS广播
    startMDNSService(PORT);
  });

  return expressServer;
}

// 启动mDNS服务发现
function startMDNSService(port) {
  try {
    const mdns = require('multicast-dns')();
    const localIP = getLocalIPAddress();

    console.log(`📡 mDNS服务已启动 - sebt-server.local:${port} (${localIP})`);

    // 响应mDNS查询
    mdns.on('query', (query) => {
      const questions = query.questions || [];

      questions.forEach(question => {
        // 响应对 sebt-server.local 的查询
        if (question.name === 'sebt-server.local' && question.type === 'A') {
          mdns.respond({
            answers: [{
              name: 'sebt-server.local',
              type: 'A',
              ttl: 300,
              data: localIP
            }]
          });
        }

        // 响应服务发现查询
        if (question.name === '_http._tcp.local' && question.type === 'PTR') {
          mdns.respond({
            answers: [{
              name: '_http._tcp.local',
              type: 'PTR',
              ttl: 300,
              data: 'sebt-server._http._tcp.local'
            }]
          });
        }

        // 响应SRV记录查询
        if (question.name === 'sebt-server._http._tcp.local' && question.type === 'SRV') {
          mdns.respond({
            answers: [{
              name: 'sebt-server._http._tcp.local',
              type: 'SRV',
              ttl: 300,
              data: {
                priority: 10,
                weight: 5,
                port: port,
                target: 'sebt-server.local'
              }
            }]
          });
        }
      });
    });

    // 定期广播服务 (每30秒)
    setInterval(() => {
      mdns.respond({
        answers: [{
          name: 'sebt-server.local',
          type: 'A',
          ttl: 300,
          data: localIP
        }]
      });
    }, 30000);

  } catch (error) {
    console.error('mDNS服务启动失败:', error);
  }
}

// 停止服务
function stopServices() {
  if (expressServer) {
    expressServer.close();
    console.log('🛑 Express服务器已停止');
  }
}

function createWindow() {
  // 创建浏览器窗口
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1200,
    minHeight: 800,
    frame: true, // 启用标准窗口框架
    titleBarStyle: 'default', // 使用默认标题栏样式
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    },
    title: 'SEBT 平衡测试系统',
    icon: path.join(__dirname, 'assets', 'icon.png'), // 可选：应用图标
    show: false // 先隐藏窗口，等待加载完成后再显示
  });

  // 加载应用的index.html
  mainWindow.loadFile('index.html');

  // 窗口准备好显示时显示窗口
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();

    // 发送本机IP地址给渲染进程
    const localIP = getLocalIPAddress();
    mainWindow.webContents.send('local-ip', localIP);
  });

  // 开发环境下打开开发者工具
  mainWindow.webContents.openDevTools();

  // 监听窗口关闭事件
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  // 启动Express服务器
  createExpressServer();

  // 创建主窗口
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

// 应用退出前清理服务
app.on('before-quit', () => {
  stopServices();
});

app.on('window-all-closed', () => {
  stopServices();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});