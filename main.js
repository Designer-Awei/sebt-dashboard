const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const express = require('express');
const os = require('os');
const { SerialPort } = require('serialport');
const { ReadlineParser } = require('@serialport/parser-readline');

let mainWindow;
let expressServer;
let serialPort = null;
let parser = null;

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

  // POST /upload 接口 (锁定数据)
  app.post('/upload', (req, res) => {
    try {
      const { direction, distance, ip } = req.body;

      console.log('🎯 收到锁定数据:', { direction, distance, ip });

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
          source: 'hardware', // 标记为硬件数据
          type: 'lock' // 锁定事件
        });
      }

      res.json({ success: true, message: '锁定数据接收成功' });
    } catch (error) {
      console.error('处理锁定数据时出错:', error);
      res.status(500).json({ error: '服务器内部错误' });
    }
  });

  // POST /realtime 接口 (实时扫描数据)
  app.post('/realtime', (req, res) => {
    try {
      const { direction, distance, isMinDistance } = req.body;

      // 实时数据不打印到控制台，避免刷屏
      // 通过IPC转发给渲染进程
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('realtime-sensor-data', {
          direction,
          distance: parseInt(distance),
          isMinDistance: isMinDistance === true,
          timestamp: Date.now(),
          source: 'hardware', // 标记为硬件数据
          type: 'realtime' // 实时扫描数据
        });
      }

      res.json({ success: true });
    } catch (error) {
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
    console.log(`[INFO] Express服务器启动在端口 ${PORT}`);

    // 启动UDP设备发现服务
    startUDPDeviceDiscovery();
  });

  return expressServer;
}


// === 串口通信功能 ===

// 自动检测和连接串口
async function autoConnectSerialPort() {
  try {
    console.log('[SERIAL] 正在扫描可用的串口...');
    const ports = await SerialPort.list();

    // 查找可能的ESP32串口 (通常是CH340/CH341)
    const esp32Ports = ports.filter(port => {
      return port.manufacturer && (
        port.manufacturer.toLowerCase().includes('wch') || // CH340/CH341
        port.manufacturer.toLowerCase().includes('silicon') || // CP210x
        port.vendorId === '10c4' || // Silicon Labs
        port.vendorId === '1a86'    // QinHeng (CH340)
      );
    });

    if (esp32Ports.length > 0) {
      const portPath = esp32Ports[0].path;
      console.log(`[SERIAL] 发现ESP32串口: ${portPath}, 正在连接...`);

      connectToSerialPort(portPath);
    } else {
      console.log('[SERIAL] 未发现ESP32串口，将定期重试...');
      // 5秒后重试
      setTimeout(autoConnectSerialPort, 5000);
    }
  } catch (error) {
    console.error('[SERIAL] 扫描串口失败:', error);
    setTimeout(autoConnectSerialPort, 5000);
  }
}

// 连接到指定串口
function connectToSerialPort(portPath) {
  try {
    // 断开现有连接
    if (serialPort && serialPort.isOpen) {
      serialPort.close();
    }

    console.log(`[SERIAL] 连接到串口: ${portPath}`);

    // 创建串口连接
    serialPort = new SerialPort({
      path: portPath,
      baudRate: 115200,
      dataBits: 8,
      parity: 'none',
      stopBits: 1,
      autoOpen: false
    });

    // 创建数据解析器 (按行解析)
    parser = serialPort.pipe(new ReadlineParser({ delimiter: '\n' }));

    // 监听串口打开事件
    serialPort.on('open', () => {
      console.log(`[SERIAL] 串口 ${portPath} 已打开`);

      // 通知前端串口已连接
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('serial-connected', {
          port: portPath,
          baudRate: 115200
        });
      }
    });

    // 监听串口关闭事件
    serialPort.on('close', () => {
      console.log(`[SERIAL] 串口 ${portPath} 已关闭`);

      // 通知前端串口已断开
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('serial-disconnected');
      }

      // 清理资源
      serialPort = null;
      parser = null;

      // 重新尝试连接
      setTimeout(autoConnectSerialPort, 2000);
    });

    // 监听串口错误
    serialPort.on('error', (error) => {
      console.error('[SERIAL] 串口错误:', error);
    });

    // 监听解析后的数据
    parser.on('data', (data) => {
      handleSerialData(data.trim());
    });

    // 打开串口
    serialPort.open();

  } catch (error) {
    console.error('[SERIAL] 连接串口失败:', error);
    setTimeout(autoConnectSerialPort, 2000);
  }
}

// 处理串口接收到的数据
function handleSerialData(data) {
  try {
    console.log(`[SERIAL] 收到数据: ${data}`);

    // 检查是否是数据包 (以数字开头表示包类型)
    if (data.length >= 2 && /^\d/.test(data)) {
      // 解析数据包: [TYPE][LENGTH][DATA...][CHECKSUM]
      const packetType = data.charCodeAt(0);
      const dataLength = data.charCodeAt(1);
      const packetData = data.substring(2, 2 + dataLength);

      console.log(`[SERIAL] 解析数据包 - 类型:${packetType}, 长度:${dataLength}, 数据:${packetData}`);

      switch (packetType) {
        case 1: // PACKET_TYPE_SENSOR_DATA (0x01)
          handleSensorData(packetData);
          break;
        case 2: // PACKET_TYPE_STATUS (0x02)
          handleStatusData(packetData);
          break;
        case 3: // PACKET_TYPE_COMMAND (0x03)
          handleCommandData(packetData);
          break;
        default:
          console.log(`[SERIAL] 未知数据包类型: ${packetType}`);
      }
    } else if (data.startsWith('BLE>')) {
      // BLE转发的数据
      const bleData = data.substring(4); // 去掉"BLE>"前缀
      console.log(`[BLE] 从机数据: ${bleData}`);

      // 可以在这里处理BLE从机的数据
      // 例如转发给前端或进行其他处理

    } else if (data.startsWith('PC>')) {
      // 这是我们发送给ESP32的命令的回显，忽略
      return;
    } else {
      // 其他串口输出 (ESP32的调试信息等)
      console.log(`[ESP32] ${data}`);
    }
  } catch (error) {
    console.error('[SERIAL] 处理串口数据时出错:', error);
  }
}

// 处理传感器数据
function handleSensorData(jsonData) {
  try {
    const sensorData = JSON.parse(jsonData);

    console.log('[SENSOR] 收到传感器数据:', sensorData);

    // 通过IPC转发给渲染进程
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('serial-sensor-data', {
        ...sensorData,
        source: 'wired', // 标记为有线连接数据
        timestamp: Date.now()
      });
    }
  } catch (error) {
    console.error('[SENSOR] 解析传感器数据失败:', error);
  }
}

// 处理状态数据
function handleStatusData(statusData) {
  console.log('[STATUS] 收到状态数据:', statusData);

  // 可以在这里处理ESP32的状态信息
  // 例如连接状态、电池信息等
}

// 处理命令数据
function handleCommandData(commandData) {
  console.log('[COMMAND] 收到命令数据:', commandData);

  // 可以在这里处理ESP32发送的命令请求
}

// 发送命令到ESP32
function sendCommandToESP32(command) {
  if (serialPort && serialPort.isOpen) {
    const commandWithPrefix = `PC>${command}\n`;
    serialPort.write(commandWithPrefix, (error) => {
      if (error) {
        console.error('[SERIAL] 发送命令失败:', error);
      } else {
        console.log(`[SERIAL] 发送命令: ${command}`);
      }
    });
  } else {
    console.warn('[SERIAL] 串口未连接，无法发送命令');
  }
}

// === 串口通信功能结束 ===

// 停止服务
function stopServices() {
  // 关闭串口连接
  if (serialPort && serialPort.isOpen) {
    serialPort.close();
    console.log('[SERIAL] 串口连接已关闭');
  }

  if (expressServer) {
    expressServer.close();
    console.log('[INFO] Express服务器已停止');
  }

  stopUDPDeviceDiscovery();
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

  // 如需调试，可手动取消注释下面一行
  // mainWindow.webContents.openDevTools();

  // 监听窗口关闭事件
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // 监听来自渲染进程的串口命令
  ipcMain.on('serial-command', (event, command) => {
    console.log(`[IPC] 收到串口命令: ${command}`);
    sendCommandToESP32(command);
  });
}

app.whenReady().then(() => {
  // 启动Express服务器
  createExpressServer();

  // 启动串口自动连接
  autoConnectSerialPort();

  // 创建主窗口
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

// 启动UDP设备发现服务
let udpDiscovery = null;
function startUDPDeviceDiscovery() {
  try {
    udpDiscovery = require('./udp-discovery');
    udpDiscovery.setMainWindow(mainWindow);
    udpDiscovery.start();

    console.log('[INFO] UDP设备发现服务启动成功');
  } catch (error) {
    console.error('[ERROR] UDP设备发现服务启动失败:', error);
  }
}

// 停止UDP设备发现服务
function stopUDPDeviceDiscovery() {
  if (udpDiscovery) {
    udpDiscovery.stop();
    udpDiscovery = null;
  }
}

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