/*
 * SEBT 经典蓝牙客户端测试脚本
 * 连接HC-05蓝牙模块，接收ESP32-C3发送的8方向TOF传感器数据
 * 
 * 数据格式: [时间戳(4字节)] [最小方向(1字节)] [最小距离(2字节)] [8方向距离(16字节)]
 * 总长度: 23字节
 * 发送间隔: 300ms
 * 
 * HC-05配置:
 * - 设备名称: SEBT-Host-001
 * - 配对密码: 1234
 * - 通信波特率: 9600
 */

const { SerialPort } = require('serialport');
const { exec } = require('child_process');
const { promisify } = require('util');

const execAsync = promisify(exec);

// --- 配置 ---
const BT_BAUD_RATE = 9600;
const DEVICE_NAME = 'SEBT-Host-001';
const DATA_PACKET_SIZE = 23; // 23字节数据包

// --- 全局变量 ---
let port = null;
let isConnected = false;
let dataBuffer = Buffer.alloc(0);
let packetCount = 0;

// --- 解析传感器数据 ---
function parseSensorData(buffer) {
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

// --- 检查蓝牙配对状态 ---
async function checkBluetoothPaired() {
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

// --- 扫描并连接串口 ---
async function scanAndConnect() {
  console.log('🔍 SEBT 经典蓝牙客户端测试脚本');
  console.log('=====================================');
  console.log(`连接HC-05: ${DEVICE_NAME}`);
  console.log(`数据格式: 23字节二进制数据包`);
  console.log(`波特率: ${BT_BAUD_RATE}`);
  console.log('');

  // 检查配对状态
  console.log('🔍 检查蓝牙配对状态...');
  const pairedDevice = await checkBluetoothPaired();
  
  if (pairedDevice) {
    console.log(`✅ 找到已配对的设备: ${pairedDevice}`);
  } else {
    console.log('⚠️  设备未配对');
    console.log('📱 请在Windows蓝牙设置中配对HC-05:');
    console.log(`   设备名: ${DEVICE_NAME}`);
    console.log('   配对码: 1234');
    console.log('');
    console.log('🔄 10秒后重试...');
    setTimeout(scanAndConnect, 10000);
    return;
  }

  console.log('');
  console.log('🚀 开始扫描串口...');

  try {
    const ports = await SerialPort.list();
    
    if (ports.length === 0) {
      console.log('❌ 未找到任何串口设备');
      setTimeout(scanAndConnect, 5000);
      return;
    }

    console.log(`📋 发现 ${ports.length} 个串口设备:`);
    
    const bluetoothPorts = [];
    const candidatePorts = [];
    
    ports.forEach((p, i) => {
      const isBluetooth = (p.pnpId && p.pnpId.toLowerCase().includes('bthenum')) ||
                         (p.manufacturer && p.manufacturer.toLowerCase().includes('bluetooth')) ||
                         (p.pnpId && p.pnpId.toLowerCase().includes('bth'));
      
      const isESP32USB = p.path && (p.path.toLowerCase().includes('com4') || 
                                    (p.vendorId === '303A' && p.productId === '1001'));
      
      // 检查是否是SPP传出端口（优先使用）
      // COM9通常是传出端口，COM8是传入端口
      // 设备ID中包含'_00000002'或'_C00000000'通常是传出端口
      const isOutgoing = (p.path && p.path.includes('COM9')) ||
                        (p.pnpId && (p.pnpId.includes('_00000002') || p.pnpId.includes('_C00000000')));
      
      // 检查是否是传入端口（COM8通常是传入）
      const isIncoming = (p.path && p.path.includes('COM8')) ||
                        (p.pnpId && p.pnpId.includes('_00000000') && !p.pnpId.includes('_C00000000'));
      
      if (isBluetooth && !isESP32USB) {
        // 标记端口类型
        // 实际测试：COM9（传出端口）可以接收ESP32发送的数据
        let portType = '🔵 蓝牙';
        if (isOutgoing) {
          portType = '📤 传出(SPP Dev) - 推荐（实际测试可用）';
        } else if (isIncoming) {
          portType = '📥 传入';
        }
        
        bluetoothPorts.push({ ...p, portType, isOutgoing: !!isOutgoing });
        console.log(`   ${i + 1}. ${p.path} - ${portType}`);
        console.log(`      设备ID: ${p.pnpId || '未知'}`);
        console.log(`      厂商: ${p.manufacturer || '未知'}`);
      } else if (!isESP32USB) {
        // 也尝试其他串口（可能是Windows没有正确标识的蓝牙串口）
        candidatePorts.push(p);
        console.log(`   ${i + 1}. ${p.path} - ⚪ 其他串口`);
        console.log(`      设备ID: ${p.pnpId || '未知'}`);
        console.log(`      厂商: ${p.manufacturer || '未知'}`);
      }
    });
    
    console.log('');

    // 如果没有找到蓝牙串口，尝试所有非ESP32的串口
    const portsToTry = bluetoothPorts.length > 0 ? bluetoothPorts : candidatePorts;

    if (portsToTry.length === 0) {
      console.log('⚠️  未发现可用串口');
      console.log('💡 请确保:');
      console.log('   1. HC-05已配对到Windows');
      console.log('   2. 配对后等待几秒让Windows创建串口');
      console.log('   3. 检查设备管理器 > 端口(COM和LPT)');
      console.log('   4. 在Windows蓝牙设置中，点击HC-05设备，确保"串行端口服务"已连接');
      console.log('');
      console.log('🔄 5秒后重试...');
      setTimeout(scanAndConnect, 5000);
      return;
    }

    // 排序：优先尝试传出端口（实际测试：COM9可以接收ESP32发送的数据）
    if (bluetoothPorts.length > 0) {
      bluetoothPorts.sort((a, b) => {
        // 传出端口优先（实际测试：COM9可以接收数据）
        if (a.isOutgoing && !b.isOutgoing) return -1;
        if (!a.isOutgoing && b.isOutgoing) return 1;
        return 0;
      });
      console.log(`✅ 发现 ${bluetoothPorts.length} 个蓝牙串口，优先尝试传出端口(COM9)接收数据...\n`);
      console.log(`💡 注意：实际测试显示COM9（传出端口）可以接收ESP32-C3发送的数据\n`);
    } else {
      console.log(`⚠️  未发现明确标识的蓝牙串口，将尝试 ${candidatePorts.length} 个其他串口...\n`);
    }

    // 尝试连接每个串口（已按优先级排序）
    for (const portInfo of portsToTry) {
      const portPath = portInfo.path;
      console.log(`🔗 尝试连接: ${portPath}...`);

      try {
        await connectToPort(portPath);
        
        if (isConnected) {
          console.log(`✅ 成功连接到: ${portPath}`);
          console.log('📡 等待接收数据...\n');
          return;
        }
      } catch (error) {
        if (error.message.includes('被占用')) {
          console.log(`   ⚠️  ${portPath} 被占用: ${error.message}`);
        } else if (error.message.includes('超时')) {
          console.log(`   ⏱️  ${portPath} 超时: ${error.message}`);
        } else {
          console.log(`   ❌ ${portPath} 连接失败: ${error.message}`);
        }
        continue;
      }
    }

    // 所有端口都失败
    console.log('\n❌ 所有串口连接失败');
    console.log('💡 请检查:');
    console.log('   1. ESP32-C3是否正在发送数据（查看串口监视器）');
    console.log('   2. HC-05是否正确连接到ESP32-C3');
    console.log('   3. 是否关闭了Arduino IDE串口监视器');
    console.log('   4. ⚠️  重要：在Windows蓝牙设置中，点击HC-05设备，确保"串行端口服务"已连接');
    console.log('      - 打开"设置" > "蓝牙和其他设备"');
    console.log('      - 找到"SEBT-Host-001"设备');
    console.log('      - 点击"更多蓝牙选项"或设备详情');
    console.log('      - 确保"串行端口(SPP)"服务已连接');
    console.log('');
    console.log('🔄 5秒后重试...');
    setTimeout(scanAndConnect, 5000);

  } catch (error) {
    console.error('❌ 扫描串口失败:', error.message);
    setTimeout(scanAndConnect, 5000);
  }
}

// --- 连接到指定串口 ---
function connectToPort(portPath) {
  return new Promise((resolve, reject) => {
    // 关闭已有连接
    if (port && port.isOpen) {
      port.close();
    }

    port = new SerialPort({
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
    let firstDataTime = null;

    // 数据接收处理
    port.on('data', (data) => {
      // 记录第一次收到数据的时间
      if (firstDataTime === null) {
        firstDataTime = Date.now();
        console.log(`📥 首次收到数据！长度: ${data.length} 字节`);
        console.log(`   十六进制: ${data.toString('hex')}`);
        console.log(`   前20字节: ${data.slice(0, Math.min(20, data.length)).toString('hex')}`);
        console.log(`   原始字节: ${Array.from(data.slice(0, Math.min(20, data.length))).join(' ')}`);
        console.log('');
      }
      
      totalBytesReceived += data.length;

      // 累积数据
      dataBuffer = Buffer.concat([dataBuffer, data]);

      // 如果缓冲区有足够数据，尝试解析
      if (dataBuffer.length >= DATA_PACKET_SIZE) {
        // 尝试找到数据包的起始位置（通过查找有效的时间戳）
        let foundPacket = false;
        
        for (let start = 0; start <= dataBuffer.length - DATA_PACKET_SIZE; start++) {
          const packet = dataBuffer.slice(start, start + DATA_PACKET_SIZE);
          const sensorData = parseSensorData(packet);
          
          if (sensorData) {
            // 验证数据有效性（放宽条件，先看看能否收到数据）
            if (sensorData.minDistance >= 0 && sensorData.minDistance <= 5000) {
              // 检查时间戳是否合理（应该在millis()范围内）
              if (sensorData.timestamp > 0 && sensorData.timestamp < 0xFFFFFFFF) {
                foundPacket = true;
                dataBuffer = dataBuffer.slice(start + DATA_PACKET_SIZE);
                
                dataReceived = true;
                if (timeoutId) clearTimeout(timeoutId);
                
                isConnected = true;
                setupPortHandlers(portPath);
                
                // 显示第一个数据包
                packetCount++;
                const now = new Date();
                const timeStr = now.toLocaleTimeString();
                const dirStr = sensorData.distances.map((d, i) => `${i}:${d}`).join(' ');
                const minDirDisplay = sensorData.minDirection >= 0 ? sensorData.minDirection : 'N/A';
                
                console.log(`✅ 成功解析数据包！`);
                console.log(`📊 [${timeStr}] 方向${minDirDisplay}:${sensorData.minDistance}mm | ${dirStr}mm`);
                
                resolve();
                return;
              }
            }
          }
        }
        
        // 如果没有找到有效数据包，但缓冲区太大，清理一下
        if (dataBuffer.length > DATA_PACKET_SIZE * 2) {
          // 保留最后一部分数据，可能包含下一个包的开始
          dataBuffer = dataBuffer.slice(-DATA_PACKET_SIZE);
        }
      }
    });

    // 串口打开事件
    port.on('open', () => {
      console.log(`   ✅ ${portPath} 已打开`);
      console.log(`   ⏳ 等待数据（最多15秒，ESP32每300ms发送一次）...`);
      
      // 定期检查是否收到任何数据
      const checkInterval = setInterval(() => {
        if (totalBytesReceived > 0 && !dataReceived) {
          console.log(`   📊 已收到 ${totalBytesReceived} 字节数据，正在解析...`);
        }
      }, 2000);
      
      timeoutId = setTimeout(() => {
        clearInterval(checkInterval);
        if (!dataReceived) {
          port.close();
          if (totalBytesReceived > 0) {
            console.log(`   ⚠️  超时：收到 ${totalBytesReceived} 字节数据，但无法解析为有效数据包`);
            console.log(`   💡 可能原因:`);
            console.log(`      1. 数据格式不匹配（检查ESP32代码的数据格式）`);
            console.log(`      2. 波特率不匹配（当前: ${BT_BAUD_RATE}）`);
            console.log(`      3. 数据包对齐问题`);
          } else {
            console.log(`   ⚠️  超时：未收到任何数据`);
            console.log(`   💡 可能原因:`);
            console.log(`      1. 这不是正确的蓝牙串口`);
            console.log(`      2. HC-05的SPP服务未连接（在Windows蓝牙设置中手动连接）`);
            console.log(`      3. ESP32-C3未发送数据`);
            console.log(`      4. 端口方向错误（尝试另一个端口）`);
          }
          reject(new Error('超时：未收到有效数据'));
        }
      }, 15000); // 15秒
      
      // 清理定时器
      port.on('close', () => {
        clearInterval(checkInterval);
      });
    });

    // 错误处理
    port.on('error', (error) => {
      if (timeoutId) clearTimeout(timeoutId);
      reject(error);
    });

    // 打开串口
    port.open((error) => {
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

// --- 设置串口事件处理器 ---
function setupPortHandlers(portPath) {
  port.removeAllListeners('data');
  port.removeAllListeners('error');
  port.removeAllListeners('close');

  port.on('data', (data) => {
    dataBuffer = Buffer.concat([dataBuffer, data]);

    // 尝试找到并解析数据包
    while (dataBuffer.length >= DATA_PACKET_SIZE) {
      let foundPacket = false;
      
      for (let start = 0; start <= dataBuffer.length - DATA_PACKET_SIZE; start++) {
        const packet = dataBuffer.slice(start, start + DATA_PACKET_SIZE);
        const sensorData = parseSensorData(packet);
        
        if (sensorData && sensorData.minDistance >= 0 && sensorData.minDistance <= 5000) {
          if (sensorData.timestamp > 0 && sensorData.timestamp < 0xFFFFFFFF) {
            dataBuffer = dataBuffer.slice(start + DATA_PACKET_SIZE);
            foundPacket = true;
            
            packetCount++;
            const now = new Date();
            const timeStr = now.toLocaleTimeString();
            const dirStr = sensorData.distances.map((d, i) => `${i}:${d}`).join(' ');
            const minDirDisplay = sensorData.minDirection >= 0 ? sensorData.minDirection : 'N/A';
            
            console.log(`📊 [${timeStr}] 方向${minDirDisplay}:${sensorData.minDistance}mm | ${dirStr}mm`);
            break;
          }
        }
      }
      
      if (!foundPacket) {
        // 如果没有找到有效数据包，清理缓冲区
        if (dataBuffer.length > DATA_PACKET_SIZE * 2) {
          dataBuffer = dataBuffer.slice(-DATA_PACKET_SIZE);
        }
        break;
      }
    }
  });

  port.on('error', (error) => {
    console.error('❌ 串口错误:', error.message);
    isConnected = false;
    console.log('🔄 5秒后重新扫描...');
    setTimeout(scanAndConnect, 5000);
  });

  port.on('close', () => {
    console.log('🔌 串口已断开');
    isConnected = false;
    console.log('🔄 5秒后重新扫描...');
    setTimeout(scanAndConnect, 5000);
  });
}

// --- 优雅关闭 ---
function gracefulShutdown() {
  console.log('\n🛑 正在关闭...');

  if (port && port.isOpen) {
    port.close((error) => {
      if (error) {
        console.error('❌ 关闭串口错误:', error.message);
      } else {
        console.log('✅ 已关闭');
      }
      process.exit(0);
    });
  } else {
    process.exit(0);
  }
}

// --- 主函数 ---
function main() {
  console.log('🔧 HC-05配置信息:');
  console.log(`   设备名称: ${DEVICE_NAME}`);
  console.log('   配对密码: 1234');
  console.log(`   通信波特率: ${BT_BAUD_RATE}`);
  console.log('');
  console.log('📋 使用说明:');
  console.log('   1. 确保HC-05已配对到Windows');
  console.log('   2. 确保ESP32-C3正在发送数据');
  console.log('   3. 关闭Arduino IDE串口监视器');
  console.log('   4. 脚本会自动扫描并连接蓝牙串口');
  console.log('');
  console.log('按 Ctrl+C 退出\n');

  process.on('SIGINT', gracefulShutdown);
  process.on('SIGTERM', gracefulShutdown);

  scanAndConnect();
}

main();

