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
    console.warn('[BT] 经典蓝牙SPP模式不支持命令发送:', command);
    event.reply?.('bt-command-sent', { success: false, error: 'command-not-supported' });
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