const { app, BrowserWindow, ipcMain } = require('electron');
const { BTManager } = require('./bt-manager');

let mainWindow;
let btManager;

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
  });

  if (process.env.NODE_ENV === 'development') {
    window.webContents.openDevTools();
  }

  return window;
}

/**
 * 注册IPC事件，兼容旧事件名称
 */
function registerIPC() {
  // 扫描相关事件（兼容BLE和BT）
  const startScanChannels = ['bt-start-scan', 'ble-start-scan', 'bluetooth-start-scan', 'start-ble-scan', 'start-bt-scan'];
  startScanChannels.forEach((channel) => {
    ipcMain.on(channel, () => {
      console.log(`📡 主进程收到扫描请求: ${channel}`);
      btManager?.startScanning();
    });
  });

  const stopScanChannels = ['bt-stop-scan', 'ble-stop-scan', 'bluetooth-stop-scan'];
  stopScanChannels.forEach((channel) => {
    ipcMain.on(channel, () => {
      btManager?.stopScanning();
    });
  });

  // 连接相关事件
  const connectChannels = ['bt-connect', 'ble-connect', 'bluetooth-connect', 'connect-to-ble-device', 'connect-to-bt-device'];
  connectChannels.forEach((channel) => {
    ipcMain.on(channel, (_event, deviceId) => {
      console.log(`📡 主进程收到连接请求: ${channel}, 设备ID: ${deviceId}`);
      btManager?.connect(deviceId);
    });
  });

  // 断开连接事件
  const disconnectChannels = ['bt-disconnect', 'ble-disconnect', 'bluetooth-disconnect'];
  disconnectChannels.forEach((channel) => {
    ipcMain.on(channel, () => {
      btManager?.disconnect();
    });
  });

  // 诊断和状态查询
  ipcMain.on('bt-diagnose', (event) => {
    const report = btManager?.diagnose() || {};
    event.reply('bt-diagnosis-result', report);
  });

  ipcMain.on('ble-diagnose', (event) => {
    // 兼容旧事件名称
    const report = btManager?.diagnose() || {};
    event.reply('ble-diagnosis-result', report);
  });

  ipcMain.on('bluetooth-get-status', (event) => {
    const status = btManager?.getStatus() || { connected: false, device: null };
    event.reply('bluetooth-status', status);
  });

  // 命令发送（经典蓝牙模式下不支持命令发送）
  ipcMain.on('bt-send-command', (event, command) => {
    console.warn('[BT] 经典蓝牙SPP模式不支持命令发送:', command);
    event.reply?.('bt-command-sent', { success: false, error: 'command-not-supported' });
  });

  ipcMain.on('ble-send-command', (event, command) => {
    // 兼容旧事件名称
    console.warn('[BT] 经典蓝牙SPP模式不支持命令发送:', command);
    event.reply?.('ble-command-sent', { success: false, error: 'command-not-supported' });
  });
}

app.whenReady().then(() => {
  mainWindow = createWindow();
  btManager = new BTManager({
    mainWindow
  });

  registerIPC();
  
  // 自动开始扫描
  console.log('🚀 启动BT管理器，开始扫描HC-05蓝牙串口...');
  btManager.startScanning();
});

app.on('window-all-closed', () => {
  btManager?.dispose();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  btManager?.dispose();
});