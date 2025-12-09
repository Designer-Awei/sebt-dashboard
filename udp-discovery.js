/**
 * UDP设备发现服务
 * 监听ESP32设备的UDP广播，发现并验证SEBT设备
 */

const dgram = require('dgram');

class UDPDeviceDiscovery {
  constructor() {
    this.server = null;
    this.isRunning = false;
    this.mainWindow = null;
    this.discoveredDevices = new Map();
  }

  /**
   * 启动UDP发现服务
   */
  start() {
    if (this.isRunning) {
      console.log('[INFO] UDP发现服务已在运行');
      return;
    }

    try {
      // 创建UDP服务器
      this.server = dgram.createSocket('udp4');

      // 设置监听端口
      const BROADCAST_PORT = 4210;

      // 绑定端口
      this.server.bind(BROADCAST_PORT, '0.0.0.0', () => {
        console.log(`[INFO] UDP发现服务监听端口: ${BROADCAST_PORT}`);
        this.isRunning = true;

        // 启用广播接收
        this.server.setBroadcast(true);
      });

      // 监听UDP消息
      this.server.on('message', (msg, rinfo) => {
        this.handleUDPMessage(msg, rinfo);
      });

      // 错误处理
      this.server.on('error', (err) => {
        console.error('[ERROR] UDP服务器错误:', err);
        this.stop();
      });

      console.log('[INFO] UDP设备发现服务启动成功');

    } catch (error) {
      console.error('[ERROR] 启动UDP发现服务失败:', error);
    }
  }

  /**
   * 停止UDP发现服务
   */
  stop() {
    if (this.server) {
      this.server.close(() => {
        console.log('[INFO] UDP发现服务已停止');
      });
      this.server = null;
    }
    this.isRunning = false;
  }

  /**
   * 处理接收到的UDP消息
   */
  handleUDPMessage(msg, rinfo) {
    try {
      const message = msg.toString().trim();
      console.log(`[UDP] 收到消息: ${message} 来自 ${rinfo.address}:${rinfo.port}`);

      // 解析SEBT设备广播消息
      // 格式: "SEBT_HOST;<PORT>;<DEVICE_INFO>"
      // ESP32的IP地址从UDP包的源地址(rinfo.address)获取
      const parts = message.split(';');
      if (parts.length >= 3 && parts[0] === 'SEBT_HOST') {
        const deviceIP = rinfo.address;  // 从UDP包源地址获取ESP32的真实IP
        const devicePort = parseInt(parts[1]);
        const deviceInfo = parts[2];

        console.log(`[UDP] 发现SEBT设备: ${deviceIP}:${devicePort} (${deviceInfo})`);

        // 直接处理发现的设备（UDP广播方式）
        this.handleDeviceDiscovered(deviceIP, devicePort, deviceInfo);
      }

    } catch (error) {
      console.error('[ERROR] 处理UDP消息时出错:', error);
    }
  }

  /**
   * 处理发现的设备（UDP广播方式，发送确认消息）
   */
  handleDeviceDiscovered(ip, port, deviceInfo) {
    const deviceKey = `${ip}:${port}`;

    // 如果已经在短时间内发现过，跳过
    if (this.discoveredDevices.has(deviceKey)) {
      const lastDiscovery = this.discoveredDevices.get(deviceKey);
      if (Date.now() - lastDiscovery.timestamp < 5000) { // 5秒内不再重复处理
        return;
      }
    }

    console.log(`[SUCCESS] ESP32设备发现: ${ip}:${port} (${deviceInfo})`);

    // 记录发现的设备
    this.discoveredDevices.set(deviceKey, {
      ip,
      port,
      deviceInfo,
      timestamp: Date.now()
    });

    // 获取PC自己的IP地址
    const pcIP = this.getLocalIP();

    // 发送确认消息给ESP32，告诉它PC的IP地址
    this.sendConfirmationToESP32(ip, port, pcIP);

    // 通知主窗口设备已发现
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send('device-discovered', {
        ip,
        port,
        deviceInfo,
        timestamp: Date.now()
      });
    }

    // 发送UDP连接状态更新为已连接
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send('udp-status', 'connected');
    }
  }

  /**
   * 发送确认消息给ESP32
   */
  sendConfirmationToESP32(esp32IP, esp32Port, pcIP) {
    try {
      // 构建确认消息: PC_CONFIRMED;<PC_IP>;3000;PC-Server
      const confirmMessage = `PC_CONFIRMED;${pcIP};3000;PC-Server`;

      // 创建一个新的UDP socket来发送确认消息，避免端口冲突
      const sendSocket = dgram.createSocket('udp4');

      sendSocket.send(confirmMessage, 0, confirmMessage.length, 4210, esp32IP, (err) => {
        sendSocket.close(); // 发送完成后关闭socket

        if (err) {
          console.error('[ERROR] 发送确认消息失败:', err);
        } else {
          console.log(`[SUCCESS] 发送确认消息给ESP32 ${esp32IP}: ${confirmMessage}`);
        }
      });
    } catch (error) {
      console.error('[ERROR] 发送确认消息时出错:', error);
    }
  }

  /**
   * 获取本地IP地址
   */
  getLocalIP() {
    const os = require('os');
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name]) {
        // 跳过内部地址和非IPv4地址
        if (iface.family === 'IPv4' && !iface.internal) {
          return iface.address;
        }
      }
    }
    return '127.0.0.1';
  }


  /**
   * 设置主窗口引用
   */
  setMainWindow(mainWindow) {
    this.mainWindow = mainWindow;
  }
}

module.exports = new UDPDeviceDiscovery();
