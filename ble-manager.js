/*
 * SEBT BLE 管理器 (BLE Manager)
 * 通过 WebSocket Bridge 接收来自浏览器 Web Bluetooth API 的数据
 *
 * 数据格式: [时间戳(4字节)] [最小方向(1字节)] [最小距离(2字节)] [8方向距离(16字节)]
 * 总长度: 23字节
 * 发送间隔: 300ms
 */

// --- 配置 ---
const DEVICE_NAME = 'SEBT-Host';
const DATA_PACKET_SIZE = 23; // 23字节数据包

/**
 * BLE 管理器类
 * 负责接收来自 WebSocket Bridge 的传感器数据
 */
class BLEManager {
  /**
   * @param {Object} options 配置项
   * @param {import('electron').BrowserWindow} options.mainWindow 主窗口实例
   */
  constructor({ mainWindow }) {
    this.mainWindow = mainWindow;
    this.isConnected = false;
    this.isScanning = false;
    this.packetCount = 0;
    this.device = null;
    this.scanInterval = null;
    this.reconnectTimeout = null;
  }

  /**
   * 发送事件到渲染进程
   * @param {string} channel 事件通道
   * @param {any} data 数据
   */
  sendToRenderer(channel, data) {
    try {
      if (!this.mainWindow) {
        console.warn(`[DEBUG] 主窗口不存在，无法发送 ${channel}`);
        return false;
      }
      
      if (this.mainWindow.isDestroyed()) {
        console.warn(`[DEBUG] 主窗口已销毁，无法发送 ${channel}`);
        return false;
      }
      
      this.mainWindow.webContents.send(channel, data);
      return true;
    } catch (error) {
      console.error(`[DEBUG] 发送IPC消息失败 (${channel}):`, error.message);
      return false;
    }
  }

  /**
   * 验证传感器数据
   * @param {Object} data 从 WebSocket 接收的传感器数据
   * @returns {Object|null} 验证后的传感器数据
   */
  validateSensorData(data) {
    try {
      // 验证数据有效性（最大距离2000mm，与硬件端一致）
      const isValid = data.minDistance >= 0 && data.minDistance <= 2000 &&
                     data.timestamp > 0 && data.timestamp < 0xFFFFFFFF &&
                     data.minDirection >= -1 && data.minDirection < 8 &&
                     Array.isArray(data.distances) && data.distances.length === 8;

      if (!isValid) {
        console.log(`[BLE] 数据包验证失败: timestamp=${data.timestamp}, minDir=${data.minDirection}, minDist=${data.minDistance}`);
        return null;
      }

      return data;
    } catch (error) {
      console.error(`[BLE] 数据验证错误: ${error.message}`);
      return null;
    }
  }

  /**
   * 处理来自 WebSocket 的 BLE 数据
   * @param {Object} data 从浏览器 WebSocket 接收的数据
   */
  handleWebSocketData(data) {
    if (data.type === 'sensor_data') {
      const sensorData = this.validateSensorData(data);
      if (sensorData) {
        this.processSensorData(sensorData);
      }
    } else if (data.type === 'connected') {
      this.onBLEConnected(data);
    } else if (data.type === 'disconnected') {
      this.onBLEDisconnected();
    } else {
      console.log(`[BLE] 收到未知数据类型: ${data.type}`);
    }
  }

  /**
   * 广播主机数据到所有WebSocket客户端
   * @param {Object} data 要广播的数据
   */
  broadcastHostData(data) {
    try {
      if (global.broadcastToWSClients) {
        const broadcastData = {
          type: 'host_sensor_data',
          ...data
        };
        global.broadcastToWSClients(broadcastData);
      }
    } catch (error) {
      console.error('[BLE] 广播主机数据失败:', error.message);
    }
  }

  /**
   * 开始 BLE 连接监听
   */
  async startScanning() {
    if (this.isScanning) {
      console.log('⚠️ BLE 监听已在进行中');
      return;
    }

    this.isScanning = true;
    this.sendToRenderer('bluetooth-scan-started');

    console.log('🔍 BLE管理器开始监听 WebSocket 数据...');

    // 发送状态更新
    this.sendToRenderer('bluetooth-status', {
      connected: false,
      device: null,
      scanning: true
    });
  }

  /**
   * 停止 BLE 连接监听
   */
  stopScanning() {
    this.isScanning = false;
    if (this.scanInterval) {
      clearInterval(this.scanInterval);
      this.scanInterval = null;
    }
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    this.sendToRenderer('bluetooth-scan-stopped');
  }

  /**
   * BLE 连接成功处理
   * @param {Object} deviceInfo 设备信息
   */
  onBLEConnected(deviceInfo) {
    this.isConnected = true;
    this.device = {
      id: deviceInfo.address || deviceInfo.id,
      name: deviceInfo.name || DEVICE_NAME,
      address: deviceInfo.address || deviceInfo.id
    };

    console.log(`✅ BLE 设备已连接: ${this.device.name}`);

    this.sendToRenderer('bluetooth-connected', {
      device: this.device
    });

    this.sendToRenderer('bluetooth-status', {
      connected: true,
      device: this.device
    });

    // 广播连接状态到WebSocket客户端
    this.broadcastHostData({
      type: 'host_connected',
      device: this.device
    });
  }

  /**
   * BLE 断开连接处理
   */
  onBLEDisconnected() {
    console.log('🔌 BLE 设备已断开连接');

    this.isConnected = false;
    this.device = null;

    this.sendToRenderer('bluetooth-disconnected');
    this.sendToRenderer('bluetooth-status', {
      connected: false,
      device: null
    });

    // 广播断开状态到WebSocket客户端
    if (global.broadcastToWSClients) {
      global.broadcastToWSClients({
        type: 'host_disconnected'
      });
    }
  }

  /**
   * 处理传感器数据
   * @param {Object} sensorData 传感器数据
   */
  processSensorData(sensorData) {
    this.packetCount++;
    console.log(`[BLE] 处理传感器数据 #${this.packetCount}: dir=${sensorData.minDirection}, dist=${sensorData.minDistance}mm`);

    try {
      // 发送数据到前端（即使窗口不存在也不阻塞）
      this.sendSensorData(sensorData);

      // 广播数据到WebSocket客户端（BLE驱动页面）
      this.broadcastHostData(sensorData);
    } catch (error) {
      console.error(`[BLE] 发送数据到前端失败 #${this.packetCount}:`, error.message);
    }
  }



  /**
   * 发送传感器数据到渲染进程
   * @param {Object} sensorData 传感器数据
   */
  sendSensorData(sensorData) {
    try {
      // 转换为与BLE格式兼容的数据格式
      const distances = sensorData.distances.map((dist, index) => [index, dist]);

      // 主数据格式（用于bluetooth-data-received）
      const payload = {
        source: 'host',
        name: this.device?.name || DEVICE_NAME,
        address: this.device?.address || 'unknown',
        timestamp: sensorData.timestamp,
        distances,
        minDir: sensorData.minDirection, // 兼容app.js中的minDir字段
        minDist: sensorData.minDistance, // 兼容app.js中的minDist字段
        currentMinDirection: sensorData.minDirection,
        currentMinDistance: sensorData.minDistance,
        lockedDirection: -1, // BLE模式下，锁定逻辑在软件端处理
        pressure: null
      };

      // 检查主窗口是否有效
      if (!this.mainWindow || this.mainWindow.isDestroyed()) {
        console.error(`[BLE] 主窗口无效，无法发送数据`);
        return;
      }

      // 发送实时扫描数据（格式兼容app.js的handleBluetoothData）
      try {
        this.sendToRenderer('bluetooth-data-received', {
          type: 'scan_data',
          data: JSON.stringify(payload)
        });
      } catch (error) {
        console.error(`[BLE] 发送bluetooth-data-received失败:`, error.message);
        throw error;
      }

      // 发送实时传感器数据事件（用于updateRealtimeSensorData）
      // 需要转换为方向代码格式
      const directionMap = {
        0: 'L', 1: 'BL', 2: 'FL', 3: 'F',
        4: 'B', 5: 'BR', 6: 'FR', 7: 'R'
      };

      sensorData.distances.forEach((dist, index) => {
        const direction = directionMap[index];
        if (direction) {
          try {
            this.sendToRenderer('realtime-sensor-data', {
              direction: direction,
              distance: dist,
              isMinDistance: index === sensorData.minDirection,
              timestamp: sensorData.timestamp
            });
          } catch (error) {
            console.error(`[BLE] 发送realtime-sensor-data失败 (方向${index}):`, error.message);
          }
        }
      });
    } catch (error) {
      console.error(`[BLE] sendSensorData失败:`, error.message);
      console.error(`[BLE] 错误堆栈:`, error.stack);
    }
  }

  /**
   * 连接指定设备（BLE模式下此方法主要用于兼容性）
   * @param {string} deviceId 设备ID
   */
  async connect(deviceId) {
    console.log(`[BLE] BLE模式下连接由浏览器处理，设备ID: ${deviceId}`);
    // BLE连接由浏览器Web Bluetooth API处理，此处仅记录状态
  }

  /**
   * 断开连接
   */
  disconnect() {
    console.log('[BLE] BLE模式下断开连接由浏览器处理');
    // BLE断开由浏览器Web Bluetooth API处理，此处仅更新状态
    this.isConnected = false;
    this.device = null;
    this.sendToRenderer('bluetooth-disconnected');
    this.sendToRenderer('bluetooth-status', { connected: false, device: null });
  }

  /**
   * 获取连接状态
   * @returns {Object} 状态信息
   */
  getStatus() {
    return {
      connected: this.isConnected,
      device: this.device,
      scanning: this.isScanning,
      packetCount: this.packetCount
    };
  }

  /**
   * 生成诊断信息
   * @returns {Object} 诊断报告
   */
  diagnose() {
    return {
      implementation: 'Web Bluetooth API Bridge',
      deviceName: DEVICE_NAME,
      serviceUUID: '0000AAAA-0000-1000-8000-00805F9B34FB',
      characteristicUUID: '0000BBBB-0000-1000-8000-00805F9B34FB',
      connected: this.isConnected,
      device: this.device,
      scanning: this.isScanning,
      packetCount: this.packetCount
    };
  }

  /**
   * 清理资源
   */
  dispose() {
    this.stopScanning();
    this.disconnect();
  }
}

module.exports = { BLEManager };

