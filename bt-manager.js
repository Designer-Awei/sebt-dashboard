/*
 * SEBT 经典蓝牙管理器 (BT Manager)
 * 基于HC-05经典蓝牙SPP串口通信，连接ESP32-C3主机设备
 * 
 * 数据格式: [时间戳(4字节)] [最小方向(1字节)] [最小距离(2字节)] [8方向距离(16字节)]
 * 总长度: 23字节
 * 发送间隔: 300ms
 */

const { SerialPort } = require('serialport');
const { exec } = require('child_process');
const { promisify } = require('util');

const execAsync = promisify(exec);

// --- 配置 ---
const BT_BAUD_RATE = 9600;
const DEVICE_NAME = 'SEBT-Host-001';
const DATA_PACKET_SIZE = 23; // 23字节数据包

/**
 * 经典蓝牙管理器类
 * 负责扫描、连接HC-05蓝牙串口，并接收ESP32-C3发送的传感器数据
 */
class BTManager {
  /**
   * @param {Object} options 配置项
   * @param {import('electron').BrowserWindow} options.mainWindow 主窗口实例
   */
  constructor({ mainWindow }) {
    this.mainWindow = mainWindow;
    this.port = null;
    this.isConnected = false;
    this.isScanning = false;
    this.dataBuffer = Buffer.alloc(0);
    this.packetCount = 0;
    this.currentPort = null;
    this.scanInterval = null;
    this.reconnectTimeout = null;
  }

  /**
   * 发送事件到渲染进程
   * @param {string} channel 事件通道
   * @param {any} data 数据
   */
  sendToRenderer(channel, data) {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send(channel, data);
    }
  }

  /**
   * 解析传感器数据
   * @param {Buffer} buffer 数据缓冲区
   * @returns {Object|null} 解析后的传感器数据
   */
  parseSensorData(buffer) {
    try {
      if (buffer.length < DATA_PACKET_SIZE) {
        return null;
      }

      let offset = 0;
      const timestamp = buffer.readUInt32LE(offset);
      offset += 4;

      const minDirectionRaw = buffer.readUInt8(offset);
      const minDirection = minDirectionRaw === 255 ? -1 : minDirectionRaw;
      offset += 1;

      const minDistance = buffer.readUInt16LE(offset);
      offset += 2;

      const distances = [];
      for (let i = 0; i < 8; i++) {
        distances.push(buffer.readUInt16LE(offset));
        offset += 2;
      }

      return {
        timestamp,
        minDirection,
        minDistance,
        distances
      };
    } catch (error) {
      console.error('❌ 数据解析错误:', error.message);
      return null;
    }
  }

  /**
   * 检查蓝牙配对状态
   * @returns {Promise<string|null>} 已配对的设备名称
   */
  async checkBluetoothPaired() {
    try {
      const command = `powershell -Command "Get-PnpDevice -Class Bluetooth | Where-Object { $_.FriendlyName -like '*${DEVICE_NAME}*' -or $_.FriendlyName -like '*SEBT-Host*' } | Select-Object -ExpandProperty FriendlyName"`;
      const { stdout } = await execAsync(command);
      
      if (stdout && stdout.trim().length > 0) {
        const deviceName = stdout.trim().split('\n')[0].trim();
        return deviceName;
      }
      return null;
    } catch (error) {
      return null;
    }
  }

  /**
   * 开始扫描并连接蓝牙串口
   */
  async startScanning() {
    if (this.isScanning) {
      console.log('⚠️  扫描已在进行中');
      return;
    }

    this.isScanning = true;
    this.sendToRenderer('bluetooth-scan-started');

    console.log('🔍 BT管理器开始扫描HC-05蓝牙串口...');
    await this.scanAndConnect();
  }

  /**
   * 停止扫描
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
   * 扫描并连接串口
   */
  async scanAndConnect() {
    if (!this.isScanning) {
      return;
    }

    try {
      // 检查配对状态
      const pairedDevice = await this.checkBluetoothPaired();
      
      if (!pairedDevice) {
        console.log('⚠️  设备未配对');
        this.sendToRenderer('bluetooth-error', { 
          message: `HC-05设备未配对，请在Windows蓝牙设置中配对设备: ${DEVICE_NAME}` 
        });
        
        // 5秒后重试
        this.reconnectTimeout = setTimeout(() => {
          if (this.isScanning) {
            this.scanAndConnect();
          }
        }, 5000);
        return;
      }

      console.log(`✅ 找到已配对的设备: ${pairedDevice}`);

      // 扫描串口
      const { SerialPort } = require('serialport');
      const ports = await SerialPort.list();
      
      const bluetoothPorts = [];
      
      ports.forEach((p) => {
        const isBluetooth = (p.pnpId && p.pnpId.toLowerCase().includes('bthenum')) ||
                           (p.manufacturer && p.manufacturer.toLowerCase().includes('bluetooth')) ||
                           (p.pnpId && p.pnpId.toLowerCase().includes('bth'));
        
        const isESP32USB = p.path && (p.path.toLowerCase().includes('com4') || 
                                      (p.vendorId === '303A' && p.productId === '1001'));
        
        // 检查是否是传出端口（COM9，实际测试可用）
        const isOutgoing = (p.path && p.path.includes('COM9')) ||
                          (p.pnpId && (p.pnpId.includes('_00000002') || p.pnpId.includes('_C00000000')));
        
        // 检查是否是传入端口（COM8）
        const isIncoming = (p.path && p.path.includes('COM8')) ||
                          (p.pnpId && p.pnpId.includes('_00000004'));
        
        if (isBluetooth && !isESP32USB) {
          bluetoothPorts.push({ 
            ...p, 
            isOutgoing: !!isOutgoing,
            isIncoming: !!isIncoming
          });
        }
      });

      if (bluetoothPorts.length === 0) {
        console.log('⚠️  未发现蓝牙串口');
        this.sendToRenderer('bluetooth-error', { 
          message: '未发现蓝牙串口，请确保HC-05已配对且SPP服务已启用' 
        });
        
        this.reconnectTimeout = setTimeout(() => {
          if (this.isScanning) {
            this.scanAndConnect();
          }
        }, 5000);
        return;
      }

      // 排序：优先尝试传出端口（COM9）
      bluetoothPorts.sort((a, b) => {
        if (a.isOutgoing && !b.isOutgoing) return -1;
        if (!a.isOutgoing && b.isOutgoing) return 1;
        return 0;
      });

      console.log(`✅ 发现 ${bluetoothPorts.length} 个蓝牙串口，开始尝试连接...`);

      // 尝试连接每个串口
      for (const portInfo of bluetoothPorts) {
        const portPath = portInfo.path;
        
        try {
          await this.connectToPort(portPath);
          
          if (this.isConnected) {
            console.log(`✅ 成功连接到: ${portPath}`);
            this.sendToRenderer('bluetooth-connected', {
              device: {
                id: portPath,
                name: DEVICE_NAME,
                address: portPath
              }
            });
            this.sendToRenderer('bluetooth-status', {
              connected: true,
              device: {
                id: portPath,
                name: DEVICE_NAME,
                address: portPath
              }
            });
            return;
          }
        } catch (error) {
          console.log(`   ❌ ${portPath} 连接失败: ${error.message}`);
          continue;
        }
      }

      // 所有端口都失败
      console.log('❌ 所有蓝牙串口连接失败');
      this.sendToRenderer('bluetooth-error', { 
        message: '所有蓝牙串口连接失败，请检查SPP服务是否已启用' 
      });
      
      this.reconnectTimeout = setTimeout(() => {
        if (this.isScanning) {
          this.scanAndConnect();
        }
      }, 5000);

    } catch (error) {
      console.error('❌ 扫描串口失败:', error.message);
      this.sendToRenderer('bluetooth-error', { message: `扫描失败: ${error.message}` });
      
      this.reconnectTimeout = setTimeout(() => {
        if (this.isScanning) {
          this.scanAndConnect();
        }
      }, 5000);
    }
  }

  /**
   * 连接到指定串口
   * @param {string} portPath 串口路径
   * @returns {Promise<void>}
   */
  connectToPort(portPath) {
    return new Promise((resolve, reject) => {
      // 关闭已有连接
      if (this.port && this.port.isOpen) {
        this.port.close();
      }

      this.port = new SerialPort({
        path: portPath,
        baudRate: BT_BAUD_RATE,
        dataBits: 8,
        parity: 'none',
        stopBits: 1,
        autoOpen: false
      });

      let dataReceived = false;
      let timeoutId = null;
      let totalBytesReceived = 0;

      // 数据接收处理
      this.port.on('data', (data) => {
        totalBytesReceived += data.length;
        this.dataBuffer = Buffer.concat([this.dataBuffer, data]);

        // 处理完整的数据包
        if (this.dataBuffer.length >= DATA_PACKET_SIZE) {
          let foundPacket = false;
          
          for (let start = 0; start <= this.dataBuffer.length - DATA_PACKET_SIZE; start++) {
            const packet = this.dataBuffer.slice(start, start + DATA_PACKET_SIZE);
            const sensorData = this.parseSensorData(packet);
            
            if (sensorData) {
              // 验证数据有效性
              if (sensorData.minDistance >= 0 && sensorData.minDistance <= 5000) {
                if (sensorData.timestamp > 0 && sensorData.timestamp < 0xFFFFFFFF) {
                  foundPacket = true;
                  this.dataBuffer = this.dataBuffer.slice(start + DATA_PACKET_SIZE);
                  
                  dataReceived = true;
                  if (timeoutId) clearTimeout(timeoutId);
                  
                  this.isConnected = true;
                  this.currentPort = portPath;
                  this.setupPortHandlers(portPath);
                  
                  // 发送数据到渲染进程
                  this.packetCount++;
                  this.sendSensorData(sensorData);
                  
                  resolve();
                  return;
                }
              }
            }
          }
          
          // 如果没有找到有效数据包，清理缓冲区
          if (this.dataBuffer.length > DATA_PACKET_SIZE * 2) {
            this.dataBuffer = this.dataBuffer.slice(-DATA_PACKET_SIZE);
          }
        }
      });

      // 串口打开事件
      this.port.on('open', () => {
        console.log(`   ✅ ${portPath} 已打开`);
        
        timeoutId = setTimeout(() => {
          if (!dataReceived) {
            this.port.close();
            if (totalBytesReceived > 0) {
              reject(new Error(`超时：收到 ${totalBytesReceived} 字节数据，但无法解析为有效数据包`));
            } else {
              reject(new Error('超时：未收到任何数据'));
            }
          }
        }, 15000);
      });

      // 错误处理
      this.port.on('error', (error) => {
        if (timeoutId) clearTimeout(timeoutId);
        reject(error);
      });

      // 打开串口
      this.port.open((error) => {
        if (error) {
          if (error.message.includes('Access denied') || error.message.includes('cannot open')) {
            reject(new Error('串口被占用 - 请关闭Arduino IDE串口监视器'));
          } else {
            reject(error);
          }
        }
      });
    });
  }

  /**
   * 设置串口事件处理器
   * @param {string} portPath 串口路径
   */
  setupPortHandlers(portPath) {
    if (!this.port) return;

    this.port.removeAllListeners('data');
    this.port.removeAllListeners('error');
    this.port.removeAllListeners('close');

    this.port.on('data', (data) => {
      this.dataBuffer = Buffer.concat([this.dataBuffer, data]);

      // 处理数据包
      while (this.dataBuffer.length >= DATA_PACKET_SIZE) {
        let foundPacket = false;
        
        for (let start = 0; start <= this.dataBuffer.length - DATA_PACKET_SIZE; start++) {
          const packet = this.dataBuffer.slice(start, start + DATA_PACKET_SIZE);
          const sensorData = this.parseSensorData(packet);
          
          if (sensorData && sensorData.minDistance >= 0 && sensorData.minDistance <= 5000) {
            if (sensorData.timestamp > 0 && sensorData.timestamp < 0xFFFFFFFF) {
              this.dataBuffer = this.dataBuffer.slice(start + DATA_PACKET_SIZE);
              foundPacket = true;
              
              this.packetCount++;
              this.sendSensorData(sensorData);
              break;
            }
          }
        }
        
        if (!foundPacket) {
          if (this.dataBuffer.length > DATA_PACKET_SIZE * 2) {
            this.dataBuffer = this.dataBuffer.slice(-DATA_PACKET_SIZE);
          }
          break;
        }
      }
    });

    this.port.on('error', (error) => {
      console.error('❌ 串口错误:', error.message);
      this.isConnected = false;
      this.sendToRenderer('bluetooth-error', { message: `串口错误: ${error.message}` });
      this.sendToRenderer('bluetooth-disconnected');
      this.sendToRenderer('bluetooth-status', { connected: false, device: null });
      
      // 尝试重新连接
      if (this.isScanning) {
        this.reconnectTimeout = setTimeout(() => {
          this.scanAndConnect();
        }, 5000);
      }
    });

    this.port.on('close', () => {
      console.log('🔌 串口已断开');
      this.isConnected = false;
      this.currentPort = null;
      this.sendToRenderer('bluetooth-disconnected');
      this.sendToRenderer('bluetooth-status', { connected: false, device: null });
      
      // 尝试重新连接
      if (this.isScanning) {
        this.reconnectTimeout = setTimeout(() => {
          this.scanAndConnect();
        }, 5000);
      }
    });
  }

  /**
   * 发送传感器数据到渲染进程
   * @param {Object} sensorData 传感器数据
   */
  sendSensorData(sensorData) {
    // 转换为与BLE格式兼容的数据格式
    const distances = sensorData.distances.map((dist, index) => [index, dist]);
    
    // 主数据格式（用于bluetooth-data-received）
    const payload = {
      source: 'host',
      name: DEVICE_NAME,
      address: this.currentPort || 'unknown',
      timestamp: sensorData.timestamp,
      distances,
      minDir: sensorData.minDirection, // 兼容app.js中的minDir字段
      minDist: sensorData.minDistance, // 兼容app.js中的minDist字段
      currentMinDirection: sensorData.minDirection,
      currentMinDistance: sensorData.minDistance,
      lockedDirection: -1, // 经典蓝牙模式下，锁定逻辑在软件端处理
      pressure: null
    };

    // 发送实时扫描数据（格式兼容app.js的handleBluetoothData）
    this.sendToRenderer('bluetooth-data-received', {
      type: 'scan_data',
      data: JSON.stringify(payload)
    });

    // 发送实时传感器数据事件（用于updateRealtimeSensorData）
    // 需要转换为方向代码格式
    const directionMap = {
      0: 'L', 1: 'BL', 2: 'FL', 3: 'F',
      4: 'B', 5: 'BR', 6: 'FR', 7: 'R'
    };
    
    sensorData.distances.forEach((dist, index) => {
      const direction = directionMap[index];
      if (direction) {
        this.sendToRenderer('realtime-sensor-data', {
          direction: direction,
          distance: dist,
          isMinDistance: index === sensorData.minDirection,
          timestamp: sensorData.timestamp
        });
      }
    });
  }

  /**
   * 连接指定设备（兼容接口，实际使用自动扫描）
   * @param {string} deviceId 设备ID（串口路径）
   */
  async connect(deviceId) {
    if (this.isConnected && this.currentPort === deviceId) {
      console.log('✅ 已连接到该设备');
      return;
    }

    try {
      await this.connectToPort(deviceId);
      if (this.isConnected) {
        this.sendToRenderer('bluetooth-connected', {
          device: {
            id: deviceId,
            name: DEVICE_NAME,
            address: deviceId
          }
        });
      }
    } catch (error) {
      this.sendToRenderer('bluetooth-error', { message: `连接失败: ${error.message}` });
    }
  }

  /**
   * 断开连接
   */
  disconnect() {
    if (this.port && this.port.isOpen) {
      this.port.close();
    }
    this.isConnected = false;
    this.currentPort = null;
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
      device: this.isConnected ? {
        id: this.currentPort,
        name: DEVICE_NAME,
        address: this.currentPort
      } : null,
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
      implementation: 'HC-05 Classic Bluetooth SPP',
      deviceName: DEVICE_NAME,
      baudRate: BT_BAUD_RATE,
      connected: this.isConnected,
      currentPort: this.currentPort,
      scanning: this.isScanning,
      packetCount: this.packetCount,
      bufferSize: this.dataBuffer.length
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

module.exports = { BTManager };

