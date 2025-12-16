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
    this.dataProcessInterval = null; // 数据处理定时器
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
   * 解析传感器数据
   * @param {Buffer} buffer 数据缓冲区
   * @returns {Object|null} 解析后的传感器数据
   */
  parseSensorData(buffer) {
    try {
      if (buffer.length < DATA_PACKET_SIZE) {
        console.log(`[DEBUG] 数据包长度不足: ${buffer.length} < ${DATA_PACKET_SIZE}`);
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

      // 验证数据有效性（最大距离2000mm，与硬件端一致）
      const isValid = minDistance >= 0 && minDistance <= 2000 && 
                     timestamp > 0 && timestamp < 0xFFFFFFFF &&
                     minDirection >= -1 && minDirection < 8;

      if (!isValid) {
        console.log(`[DEBUG] 数据包验证失败: timestamp=${timestamp}, minDir=${minDirection}, minDist=${minDistance}`);
        return null;
      }

      return {
        timestamp,
        minDirection,
        minDistance,
        distances
      };
    } catch (error) {
      console.error(`[DEBUG] 数据解析错误: ${error.message}, buffer长度: ${buffer.length}`);
      if (buffer.length >= DATA_PACKET_SIZE) {
        console.error(`[DEBUG] 数据包十六进制: ${buffer.slice(0, Math.min(32, buffer.length)).toString('hex')}`);
      }
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
      console.log(`   端口列表: ${bluetoothPorts.map(p => `${p.path}${p.isOutgoing ? ' (传出-优先)' : p.isIncoming ? ' (传入)' : ''}`).join(', ')}`);

      // 优先尝试传出端口（COM9），如果失败则延迟重试，避免立即尝试其他端口
      const outgoingPort = bluetoothPorts.find(p => p.isOutgoing);
      if (outgoingPort) {
        try {
          await this.connectToPort(outgoingPort.path);
          
          if (this.isConnected) {
            console.log(`✅ 成功连接到: ${outgoingPort.path}`);
            this.sendToRenderer('bluetooth-connected', {
              device: {
                id: outgoingPort.path,
                name: DEVICE_NAME,
                address: outgoingPort.path
              }
            });
            this.sendToRenderer('bluetooth-status', {
              connected: true,
              device: {
                id: outgoingPort.path,
                name: DEVICE_NAME,
                address: outgoingPort.path
              }
            });
            return;
          }
        } catch (error) {
          console.log(`   ❌ ${outgoingPort.path} 连接失败: ${error.message}`);
          
          // 如果是设备忙错误，延迟后重试同一个端口
          if (error.message.includes('设备忙') || error.message.includes('121')) {
            console.log(`   ⏳ ${outgoingPort.path} 设备忙，2秒后重试...`);
            await new Promise(resolve => setTimeout(resolve, 2000));
            
            try {
              await this.connectToPort(outgoingPort.path);
              if (this.isConnected) {
                console.log(`✅ 重试成功，已连接到: ${outgoingPort.path}`);
                this.sendToRenderer('bluetooth-connected', {
                  device: {
                    id: outgoingPort.path,
                    name: DEVICE_NAME,
                    address: outgoingPort.path
                  }
                });
                this.sendToRenderer('bluetooth-status', {
                  connected: true,
                  device: {
                    id: outgoingPort.path,
                    name: DEVICE_NAME,
                    address: outgoingPort.path
                  }
                });
                return;
              }
            } catch (retryError) {
              console.log(`   ❌ ${outgoingPort.path} 重试失败: ${retryError.message}`);
            }
          }
        }
      }

      // 如果传出端口失败，尝试其他端口
      for (const portInfo of bluetoothPorts) {
        if (portInfo.isOutgoing) continue; // 已尝试过
        
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
        try {
          this.port.close();
        } catch (e) {
          // 忽略关闭错误
        }
      }

      // 清空数据缓冲区
      this.dataBuffer = Buffer.alloc(0);

      this.port = new SerialPort({
        path: portPath,
        baudRate: BT_BAUD_RATE,
        dataBits: 8,
        parity: 'none',
        stopBits: 1,
        autoOpen: false,
        // 增加缓冲区大小，确保能及时读取数据
        highWaterMark: 64 * 1024, // 64KB读取缓冲区
        // 禁用硬件流控（RTS/CTS），避免阻塞ESP32-C3
        rtscts: false,
        xon: false,
        xoff: false
      });

      let dataReceived = false;
      let timeoutId = null;
      let totalBytesReceived = 0;
      let connectDataHandler = null;

      // 数据接收处理
      connectDataHandler = (data) => {
        const chunkSize = data.length;
        totalBytesReceived += chunkSize;
        const bufferBefore = this.dataBuffer.length;
        this.dataBuffer = Buffer.concat([this.dataBuffer, data]);
        const bufferAfter = this.dataBuffer.length;
        
        console.log(`[DEBUG] 连接阶段收到数据: ${chunkSize}字节, 缓冲区: ${bufferBefore} → ${bufferAfter}字节, 累计: ${totalBytesReceived}字节`);

        // 处理完整的数据包
        if (this.dataBuffer.length >= DATA_PACKET_SIZE) {
          let foundPacket = false;
          
          for (let start = 0; start <= this.dataBuffer.length - DATA_PACKET_SIZE; start++) {
            const packet = this.dataBuffer.slice(start, start + DATA_PACKET_SIZE);
            const sensorData = this.parseSensorData(packet);
            
            if (sensorData) {
              // 验证数据有效性
              if (sensorData.minDistance >= 0 && sensorData.minDistance <= 2000) {
                if (sensorData.timestamp > 0 && sensorData.timestamp < 0xFFFFFFFF) {
                  foundPacket = true;
                  this.dataBuffer = this.dataBuffer.slice(start + DATA_PACKET_SIZE);
                  
                  console.log(`[DEBUG] 连接阶段找到有效数据包: dir=${sensorData.minDirection}, dist=${sensorData.minDistance}mm, 起始位置=${start}`);
                  
                  dataReceived = true;
                  if (timeoutId) {
                    clearTimeout(timeoutId);
                    console.log(`[DEBUG] 已清除连接超时定时器`);
                  }
                  
                  // 移除连接阶段的监听器，避免与setupPortHandlers冲突
                  this.port.removeListener('data', connectDataHandler);
                  console.log(`[DEBUG] 已移除连接阶段的data监听器`);
                  
                  this.isConnected = true;
                  this.currentPort = portPath;
                  
                  // 设置正式的数据处理器
                  console.log(`[DEBUG] 设置正式的数据处理器...`);
                  this.setupPortHandlers(portPath);
                  
                  // 发送第一个数据包到渲染进程
                  this.packetCount++;
                  console.log(`[DEBUG] 发送第一个数据包到前端...`);
                  try {
                    this.sendSensorData(sensorData);
                    console.log(`✅ ${portPath} 连接成功，已收到第一个数据包`);
                  } catch (sendError) {
                    console.error(`[DEBUG] 发送第一个数据包失败:`, sendError.message);
                  }
                  
                  resolve();
                  return;
                } else {
                  console.log(`[DEBUG] 数据包时间戳无效: ${sensorData.timestamp}`);
                }
              } else {
                console.log(`[DEBUG] 数据包距离无效: ${sensorData.minDistance}`);
              }
            }
          }
          
          // 如果没有找到有效数据包，清理缓冲区（防止无限增长）
          if (this.dataBuffer.length > DATA_PACKET_SIZE * 3) {
            console.log(`⚠️  缓冲区过大 (${this.dataBuffer.length}字节)，清理中...`);
            console.log(`[DEBUG] 缓冲区前32字节: ${this.dataBuffer.slice(0, 32).toString('hex')}`);
            this.dataBuffer = this.dataBuffer.slice(-DATA_PACKET_SIZE);
          } else {
            console.log(`[DEBUG] 未找到有效数据包，继续等待...`);
          }
        } else {
          console.log(`[DEBUG] 缓冲区长度不足，继续等待: ${this.dataBuffer.length}/${DATA_PACKET_SIZE}`);
        }
      };

      this.port.on('data', connectDataHandler);

      // 串口打开事件
      this.port.on('open', () => {
        console.log(`[DEBUG] ✅ ${portPath} 已打开，等待数据...`);
        console.log(`[DEBUG] 串口状态: isOpen=${this.port.isOpen}, baudRate=${this.port.baudRate}`);
        
        timeoutId = setTimeout(() => {
          if (!dataReceived) {
            console.log(`[DEBUG] ⚠️  ${portPath} 连接超时 (15秒)`);
            console.log(`[DEBUG] 超时状态: dataReceived=${dataReceived}, totalBytesReceived=${totalBytesReceived}, bufferSize=${this.dataBuffer.length}`);
            this.port.removeListener('data', connectDataHandler);
            try {
              this.port.close();
            } catch (closeError) {
              console.error(`[DEBUG] 关闭串口失败:`, closeError.message);
            }
            if (totalBytesReceived > 0) {
              console.log(`   ⚠️  ${portPath} 超时：收到 ${totalBytesReceived} 字节数据，但无法解析为有效数据包`);
              console.log(`[DEBUG] 缓冲区内容 (前32字节): ${this.dataBuffer.slice(0, Math.min(32, this.dataBuffer.length)).toString('hex')}`);
              reject(new Error(`超时：收到 ${totalBytesReceived} 字节数据，但无法解析为有效数据包`));
            } else {
              console.log(`   ⚠️  ${portPath} 超时：未收到任何数据`);
              reject(new Error('超时：未收到任何数据'));
            }
          }
        }, 15000);
        console.log(`[DEBUG] 已设置15秒超时定时器`);
      });

      // 错误处理
      this.port.on('error', (error) => {
        if (timeoutId) clearTimeout(timeoutId);
        this.port.removeListener('data', connectDataHandler);
        
        // 错误121通常是设备忙，延迟后重试
        if (error.message.includes('121') || error.message.includes('Unknown error code 121')) {
          console.log(`   ⚠️  ${portPath} 设备忙（错误121），可能需要延迟打开`);
          reject(new Error('设备忙，请稍后重试'));
        } else {
          reject(error);
        }
      });

      // 延迟打开串口，避免错误121
      setTimeout(() => {
        this.port.open((error) => {
          if (error) {
            if (error.message.includes('Access denied') || error.message.includes('cannot open')) {
              reject(new Error('串口被占用 - 请关闭Arduino IDE串口监视器'));
            } else if (error.message.includes('121') || error.message.includes('Unknown error code 121')) {
              reject(new Error('设备忙，请稍后重试'));
            } else {
              reject(error);
            }
          }
        });
      }, 500); // 延迟500ms打开，避免设备忙错误
    });
  }

  /**
   * 处理数据缓冲区
   * 从缓冲区中提取并处理完整的数据包
   */
  processDataBuffer() {
    if (!this.port || !this.isConnected) return;
    
    let processedCount = 0;
    const maxProcessPerCall = 20; // 每次最多处理20个数据包
    
    while (this.dataBuffer.length >= DATA_PACKET_SIZE && processedCount < maxProcessPerCall) {
      let foundPacket = false;
      let bestStart = -1;
      let bestSensorData = null;
      
      // 尝试所有可能的起始位置
      for (let start = 0; start <= this.dataBuffer.length - DATA_PACKET_SIZE; start++) {
        const packet = this.dataBuffer.slice(start, start + DATA_PACKET_SIZE);
        const sensorData = this.parseSensorData(packet);
        
        if (sensorData) {
          bestStart = start;
          bestSensorData = sensorData;
          foundPacket = true;
          break; // 找到第一个有效数据包就退出
        }
      }
      
      if (foundPacket && bestSensorData) {
        this.dataBuffer = this.dataBuffer.slice(bestStart + DATA_PACKET_SIZE);
        processedCount++;
        
        this.packetCount++;
        
        // 只在调试模式下输出详细日志
        if (process.env.DEBUG_BT === '1') {
          console.log(`[DEBUG] 解析成功 #${this.packetCount}: dir=${bestSensorData.minDirection}, dist=${bestSensorData.minDistance}mm, buffer剩余=${this.dataBuffer.length}字节`);
        }
        
        try {
          // 发送数据到前端（即使窗口不存在也不阻塞）
          this.sendSensorData(bestSensorData);
        } catch (error) {
          // 只在非窗口相关错误时输出日志
          if (!error.message.includes('Object has been destroyed') && !error.message.includes('主窗口')) {
            console.error(`[DEBUG] 发送数据到前端失败 #${this.packetCount}:`, error.message);
          }
        }
      } else {
        // 如果没有找到有效数据包，清理缓冲区（防止无限增长）
        if (this.dataBuffer.length > DATA_PACKET_SIZE * 3) {
          console.log(`⚠️  数据包解析失败，缓冲区过大 (${this.dataBuffer.length}字节)，清理中...`);
          if (process.env.DEBUG_BT === '1') {
            console.log(`[DEBUG] 缓冲区前32字节: ${this.dataBuffer.slice(0, 32).toString('hex')}`);
          }
          this.dataBuffer = this.dataBuffer.slice(-DATA_PACKET_SIZE);
        }
        break;
      }
    }
    
    // 每50个数据包输出一次状态（降低日志频率）
    if (this.packetCount > 0 && this.packetCount % 50 === 0) {
      const windowStatus = this.mainWindow && !this.mainWindow.isDestroyed() ? '正常' : '无窗口';
      console.log(`📊 已接收 ${this.packetCount} 个数据包，缓冲区: ${this.dataBuffer.length} 字节，窗口状态: ${windowStatus}`);
    }
  }

  /**
   * 设置串口事件处理器
   * @param {string} portPath 串口路径
   */
  setupPortHandlers(portPath) {
    if (!this.port) return;

    // 清除之前的处理间隔
    if (this.dataProcessInterval) {
      clearInterval(this.dataProcessInterval);
      this.dataProcessInterval = null;
    }

    // 移除所有监听器（确保清理干净）
    this.port.removeAllListeners('data');
    this.port.removeAllListeners('error');
    this.port.removeAllListeners('close');

    this.port.on('data', (data) => {
      const bytesReceived = data.length;
      const bufferBefore = this.dataBuffer.length;
      this.dataBuffer = Buffer.concat([this.dataBuffer, data]);
      const bufferAfter = this.dataBuffer.length;
      
      // 只在调试模式下输出详细日志，避免日志过多
      if (process.env.DEBUG_BT === '1') {
        console.log(`[DEBUG] 收到数据: ${bytesReceived}字节, 缓冲区: ${bufferBefore} → ${bufferAfter}字节`);
      }

      // 处理数据包 - 使用setImmediate确保不阻塞事件循环
      setImmediate(() => {
        this.processDataBuffer();
      });
    });
    
    // 添加定期处理机制，确保即使数据流暂停也能处理缓冲区
    this.dataProcessInterval = setInterval(() => {
      if (this.dataBuffer.length >= DATA_PACKET_SIZE) {
        this.processDataBuffer();
      }
    }, 100); // 每100ms检查一次

    this.port.on('error', (error) => {
      console.error(`[DEBUG] ❌ 串口错误 (${portPath}):`, error.message);
      console.error(`[DEBUG] 错误详情:`, error);
      console.error(`[DEBUG] 错误堆栈:`, error.stack);
      console.error(`[DEBUG] 当前状态: isConnected=${this.isConnected}, packetCount=${this.packetCount}, bufferSize=${this.dataBuffer.length}`);
      
      this.isConnected = false;
      this.dataBuffer = Buffer.alloc(0); // 清空缓冲区
      
      try {
        this.sendToRenderer('bluetooth-error', { message: `串口错误: ${error.message}` });
        this.sendToRenderer('bluetooth-disconnected');
        this.sendToRenderer('bluetooth-status', { connected: false, device: null });
      } catch (sendError) {
        console.error(`[DEBUG] 发送错误事件失败:`, sendError.message);
      }
      
      // 尝试重新连接
      if (this.isScanning) {
        console.log(`[DEBUG] 准备重新连接，当前扫描状态: ${this.isScanning}`);
        if (this.reconnectTimeout) {
          clearTimeout(this.reconnectTimeout);
          console.log(`[DEBUG] 已清除旧的重连超时`);
        }
        this.reconnectTimeout = setTimeout(() => {
          console.log(`[DEBUG] 重连超时触发，isScanning=${this.isScanning}`);
          if (this.isScanning) {
            this.scanAndConnect();
          }
        }, 5000);
        console.log('🔄 5秒后尝试重新连接...');
      } else {
        console.log(`[DEBUG] 未在扫描状态，不重连`);
      }
    });

    this.port.on('close', () => {
      console.log(`[DEBUG] 🔌 串口已断开 (${portPath})`);
      console.log(`[DEBUG] 断开时状态: isConnected=${this.isConnected}, packetCount=${this.packetCount}, bufferSize=${this.dataBuffer.length}`);
      
      // 清除数据处理间隔
      if (this.dataProcessInterval) {
        clearInterval(this.dataProcessInterval);
        this.dataProcessInterval = null;
      }
      
      // 检查是否有未处理的错误
      if (this.port && this.port.isOpen === false) {
        console.log(`[DEBUG] 串口确认已关闭`);
      }
      
      this.isConnected = false;
      this.currentPort = null;
      this.dataBuffer = Buffer.alloc(0); // 清空缓冲区
      
      try {
        this.sendToRenderer('bluetooth-disconnected');
        this.sendToRenderer('bluetooth-status', { connected: false, device: null });
      } catch (sendError) {
        console.error(`[DEBUG] 发送断开事件失败:`, sendError.message);
      }
      
      // 尝试重新连接
      if (this.isScanning) {
        console.log(`[DEBUG] 准备重新连接，当前扫描状态: ${this.isScanning}`);
        if (this.reconnectTimeout) {
          clearTimeout(this.reconnectTimeout);
          console.log(`[DEBUG] 已清除旧的重连超时`);
        }
        this.reconnectTimeout = setTimeout(() => {
          console.log(`[DEBUG] 重连超时触发，isScanning=${this.isScanning}`);
          if (this.isScanning) {
            this.scanAndConnect();
          }
        }, 5000);
        console.log('🔄 5秒后尝试重新连接...');
      } else {
        console.log(`[DEBUG] 未在扫描状态，不重连`);
      }
    });
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

      // 检查主窗口是否有效
      if (!this.mainWindow || this.mainWindow.isDestroyed()) {
        console.error(`[DEBUG] 主窗口无效，无法发送数据`);
        return;
      }

      // 发送实时扫描数据（格式兼容app.js的handleBluetoothData）
      try {
        this.sendToRenderer('bluetooth-data-received', {
          type: 'scan_data',
          data: JSON.stringify(payload)
        });
      } catch (error) {
        console.error(`[DEBUG] 发送bluetooth-data-received失败:`, error.message);
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
            console.error(`[DEBUG] 发送realtime-sensor-data失败 (方向${index}):`, error.message);
          }
        }
      });
    } catch (error) {
      console.error(`[DEBUG] sendSensorData失败:`, error.message);
      console.error(`[DEBUG] 错误堆栈:`, error.stack);
    }
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
    
    // 清除数据处理间隔
    if (this.dataProcessInterval) {
      clearInterval(this.dataProcessInterval);
      this.dataProcessInterval = null;
    }
    
    this.disconnect();
  }
}

module.exports = { BTManager };

