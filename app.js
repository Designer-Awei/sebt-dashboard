/**
 * SEBT 平衡测试系统应用逻辑
 */

// 方位映射关系 (对应硬件I2C通道)
const directionMap = {
  0: { code: "L", name: "Left", displayName: "左" },
  1: { code: "BL", name: "Back-Left", displayName: "左后" },
  2: { code: "FL", name: "Front-Left", displayName: "左前" },
  3: { code: "F", name: "Front", displayName: "前" },
  4: { code: "B", name: "Back", displayName: "后" },
  5: { code: "BR", name: "Back-Right", displayName: "右后" },
  6: { code: "FR", name: "Front-Right", displayName: "右前" },
  7: { code: "R", name: "Right", displayName: "右" }
};

// 网格位置到方位的映射 (3x3布局)
// 第一排: FL(2), F(3), FR(6)
// 第二排: L(0), 中心, R(7)
// 第三排: BL(1), B(4), BR(5)
const gridPositions = [
  { row: 0, col: 0, channel: 2 }, // FL - 左前
  { row: 0, col: 1, channel: 3 }, // F - 前
  { row: 0, col: 2, channel: 6 }, // FR - 右前
  { row: 1, col: 0, channel: 0 }, // L - 左
  { row: 1, col: 1, channel: -1 }, // 中心 LOGO
  { row: 1, col: 2, channel: 7 }, // R - 右
  { row: 2, col: 0, channel: 1 }, // BL - 左后
  { row: 2, col: 1, channel: 4 }, // B - 后
  { row: 2, col: 2, channel: 5 }  // BR - 右后
];

class SEBTApp {
  constructor() {
    this.sensorData = new Map();
    this.logs = [];
    this.gridElements = new Map();
    this.localIP = '获取中...';
    this.waitingForManualResult = null;

    this.initializeApp();
    this.setupEventListeners();
    this.setupGlobalClickListener();
    this.setupIPCListeners();
  }

  /**
   * 初始化应用
   */
  initializeApp() {
    this.createGrid();
    this.initializeSensorData();
  }

  /**
   * 创建3x3网格布局
   */
  createGrid() {
    const grid = document.getElementById('sensor-grid');
    if (!grid) return;

    // 清空现有内容
    grid.innerHTML = '';

    // 创建9个网格项
    gridPositions.forEach((pos, index) => {
      const gridItem = document.createElement('div');
      gridItem.className = 'grid-item';
      gridItem.dataset.index = index.toString();
      gridItem.dataset.channel = pos.channel.toString();

      if (pos.channel === -1) {
        // 中心位置 - LOGO
        gridItem.classList.add('center');
        gridItem.innerHTML = this.createLogoContent();
      } else {
        // 传感器位置
        const direction = directionMap[pos.channel];
        gridItem.innerHTML = this.createSensorCard(direction);
        this.gridElements.set(pos.channel, gridItem);

        // 添加点击事件监听器
        gridItem.addEventListener('click', () => {
          this.onDirectionCardClick(pos.channel, direction);
        });
      }

      grid.appendChild(gridItem);
    });
  }

  /**
   * 创建传感器卡片内容
   */
  createSensorCard(direction) {
    return `
      <div class="direction-label">${direction.displayName}</div>
      <div class="distance-display" id="distance-${direction.code}">--- mm</div>
      <button class="manual-measure-btn" id="measure-${direction.code}" style="display: none;">
      手动测距
      </button>
    `;
  }

  /**
   * 处理方向卡片点击事件
   */
  onDirectionCardClick(channel, direction) {
    console.log(`📍 点击方向: ${direction.displayName} (通道: ${channel})`);

    // 隐藏所有手动测距按钮
    document.querySelectorAll('.manual-measure-btn').forEach(btn => {
      btn.style.display = 'none';
    });

    // 移除所有选中状态
    document.querySelectorAll('.grid-item').forEach(item => {
      item.classList.remove('selected');
    });

    // 显示当前卡片的测距按钮
    const measureBtn = document.getElementById(`measure-${direction.code}`);
    if (measureBtn) {
      measureBtn.style.display = 'block';

      // 添加点击事件监听器
      measureBtn.onclick = (e) => {
        e.stopPropagation(); // 防止触发卡片点击事件
        this.performManualMeasurement(channel, direction);
      };
    }

    // 添加视觉反馈
    const gridItem = this.gridElements.get(channel);
    if (gridItem) {
      gridItem.classList.add('selected');
    }
  }

  /**
   * 执行手动测距
   */
  performManualMeasurement(channel, direction) {
    console.log(`🎯 执行手动测距: ${direction.displayName}`);

    // 发送测距命令到ESP32
    const command = `MEASURE:${channel}`;
    this.sendCommandToESP32(command);

    // 添加日志
    this.addLog(`📏 手动测距: ${direction.displayName}`, 'info');

    // 设置标志，表示正在等待手动测距结果
    this.waitingForManualResult = { channel, direction };

    // 3秒后如果还没收到结果，清除等待状态
    setTimeout(() => {
      if (this.waitingForManualResult && this.waitingForManualResult.channel === channel) {
        console.log('手动测距超时');
        this.addLog(`⏰ 手动测距超时: ${direction.displayName}`, 'warning');
        this.waitingForManualResult = null;
      }
    }, 3000);
  }

  /**
   * 处理手动测距结果
   */
  handleManualMeasurementResult(channel, distance, direction) {
    console.log(`📊 手动测距结果: ${direction.displayName} = ${distance}mm`);

    // 更新界面显示
    this.updateSensorData(channel, distance, Date.now());

    // 添加日志
    this.addLog(`📐 测距完成: ${direction.displayName} - ${distance}mm`, 'success');

    // 高亮显示结果
    this.highlightClosestDirection(channel);
  }

  /**
   * 发送命令到ESP32
   */
  sendCommandToESP32(command) {
    const { ipcRenderer } = require('electron');
    ipcRenderer.send('serial-command', command);
  }

  /**
   * 创建中心LOGO内容
   */
  createLogoContent() {
    return `
      <div class="logo-area">
        <div class="logo-text">SEBT</div>
        <div class="logo-subtitle">平衡测试系统</div>
      </div>
    `;
  }

  /**
   * 初始化所有传感器的默认数据
   */
  initializeSensorData() {
    Object.keys(directionMap).forEach(channel => {
      const channelNum = parseInt(channel);
      this.sensorData.set(channelNum, {
        channel: channelNum,
        code: directionMap[channelNum].code,
        name: directionMap[channelNum].name,
        displayName: directionMap[channelNum].displayName,
        distance: 0,
        timestamp: Date.now(),
        active: false
      });
    });
  }

  /**
   * 设置全局点击监听器，用于取消选中
   */
  setupGlobalClickListener() {
    document.addEventListener('click', (e) => {
      // 检查点击的元素是否是方向卡片或其子元素
      const isGridItem = e.target.closest('.grid-item');

      if (!isGridItem) {
        // 点击的是卡片外部，隐藏所有手动测距按钮并移除选中状态
        document.querySelectorAll('.manual-measure-btn').forEach(btn => {
          btn.style.display = 'none';
        });

        document.querySelectorAll('.grid-item').forEach(item => {
          item.classList.remove('selected');
        });

        // 清除等待状态
        if (this.waitingForManualResult) {
          console.log('取消手动测距等待');
          this.waitingForManualResult = null;
        }
      }
    });
  }

  /**
   * 设置事件监听器
   */
  setupEventListeners() {
    // 模拟数据按钮
    const mockDataBtn = document.getElementById('mock-data-btn');
    if (mockDataBtn) {
      mockDataBtn.addEventListener('click', () => this.simulateSensorData());
    }

    // 清空日志按钮
    const clearLogsBtn = document.getElementById('clear-logs-btn');
    if (clearLogsBtn) {
      clearLogsBtn.addEventListener('click', () => this.clearLogs());
    }
  }

  /**
   * 设置IPC监听器
   */
  setupIPCListeners() {
    const { ipcRenderer } = require('electron');

    // 监听传感器数据 (来自硬件 - 锁定事件)
    ipcRenderer.on('sensor-data', (event, data) => {
      console.log('🎯 收到锁定数据:', data);
      this.handleHardwareData(data);
    });

    // 监听实时传感器数据 (来自硬件 - 实时扫描)
    ipcRenderer.on('realtime-sensor-data', (event, data) => {
      // 实时数据不打印到控制台，避免刷屏
      this.handleRealtimeData(data);
    });

    // 监听本地IP地址
    ipcRenderer.on('local-ip', (event, ip) => {
      console.log('🏠 本机IP:', ip);
      this.localIP = ip;
      this.updateIPDisplay();
    });

    // 监听UDP连接状态
    ipcRenderer.on('udp-status', (event, status) => {
      console.log('📡 UDP状态更新:', status);
      this.updateUDPStatus(status);
    });

    // 监听UDP设备发现
    ipcRenderer.on('device-discovered', (event, device) => {
      console.log('🔍 UDP设备发现:', device);
      this.handleDeviceDiscovered(device);
    });

    // 监听串口连接状态
    ipcRenderer.on('serial-connected', (event, info) => {
      console.log('🔌 串口已连接:', info);
      this.updateSerialStatus(true, info);
    });

    ipcRenderer.on('serial-disconnected', (event) => {
      console.log('🔌 串口已断开');
      this.updateSerialStatus(false);
    });

    // 监听串口传感器数据
    ipcRenderer.on('serial-sensor-data', (event, data) => {
      console.log('📊 串口传感器数据:', data);
      this.handleSerialData(data);
    });
  }

  /**
   * 处理串口传感器数据
   */
  handleSerialData(data) {
    const { direction, directionName, distance, locked, timestamp } = data;

    // 将方向名称转换为方向代码 (如果有的话)
    let directionCode = direction;
    if (directionName) {
      // 从directionMap中找到对应的代码
      for (const [ch, dir] of Object.entries(directionMap)) {
        if (dir.name === directionName) {
          directionCode = dir.code;
          break;
        }
      }
    }

    // 根据方向代码找到对应的通道号
    let channel = -1;
    for (const [ch, dir] of Object.entries(directionMap)) {
      if (dir.code === directionCode) {
        channel = parseInt(ch);
        break;
      }
    }

    if (channel === -1) {
      console.warn('无法识别的方向:', directionCode);
      return;
    }

    // 检查是否是手动测距的结果
    if (this.waitingForManualResult && this.waitingForManualResult.channel === channel) {
      // 这是手动测距的结果
      this.handleManualMeasurementResult(channel, distance, this.waitingForManualResult.direction);
      this.waitingForManualResult = null;
      return; // 不继续处理常规传感器数据更新
    }

    // 更新传感器数据
    this.updateSensorData(channel, distance, timestamp);

    // 如果是锁定事件，添加特殊标记
    if (locked) {
      console.log(`🎯 串口锁定事件: ${directionName || directionCode} - ${distance}mm`);
      this.addLog(`🔒 串口锁定: ${directionName || directionCode} - ${distance}mm`, 'success');
    }

    // 高亮最近方向
    this.highlightClosestDirection(channel);
  }

  /**
   * 更新串口连接状态显示
   */
  updateSerialStatus(connected, info = null) {
    const statusElement = document.getElementById('serial-status');
    if (statusElement) {
      if (connected) {
        statusElement.textContent = `串口: ${info.port} (${info.baudRate})`;
        statusElement.className = 'status-item status-connected';
      } else {
        statusElement.textContent = '串口: 未连接';
        statusElement.className = 'status-item status-disconnected';
      }
    }

    // 添加到日志
    if (connected) {
      this.addLog(`🔌 串口已连接: ${info.port}`, 'success');
    } else {
      this.addLog('🔌 串口已断开', 'warning');
    }
  }

  /**
   * 模拟传感器数据 (同时更新所有8个方向)
   */
  simulateSensorData() {
    console.log('🎲 模拟所有8个方向的传感器数据');

    // 找到一个随机的最小距离方向
    const channels = Object.keys(directionMap).map(ch => parseInt(ch));
    const minDistanceChannel = channels[Math.floor(Math.random() * channels.length)];

    // 为所有8个方向生成随机距离数据
    channels.forEach(channel => {
      // 生成随机距离 (50-2000mm)
      let randomDistance = Math.floor(Math.random() * 1950) + 50;

      // 确保最小距离方向有最小的读数
      if (channel === minDistanceChannel) {
        randomDistance = Math.floor(Math.random() * 100) + 30; // 30-130mm，更小的距离
      }

      // 模拟实时数据更新
      this.updateRealtimeSensorData(channel, randomDistance, channel === minDistanceChannel);
    });

    // 添加日志记录
    const minDirection = directionMap[minDistanceChannel];
    this.addLog({
      id: Date.now(),
      timestamp: Date.now(),
      channel: minDistanceChannel,
      code: minDirection.code,
      displayName: minDirection.displayName,
      distance: 0, // 模拟数据不显示具体距离
      source: 'simulated',
      message: `🎲 模拟数据更新完成，最小距离: ${minDirection.displayName}`
    });
  }

  /**
   * 更新传感器数据
   */
  updateSensorData(channel, distance, source = 'simulated') {
    if (!directionMap[channel]) {
      console.error(`无效的通道: ${channel}`);
      return;
    }

    const direction = directionMap[channel];
    const sensorData = {
      channel,
      code: direction.code,
      name: direction.name,
      displayName: direction.displayName,
      distance,
      timestamp: Date.now(),
      active: true,
      source // 'simulated' 或 'hardware'
    };

    this.sensorData.set(channel, sensorData);

    // 更新UI
    this.updateSensorDisplay(channel, sensorData);

    // 添加日志
    this.addLog(sensorData);

    // 3秒后重置为非活跃状态
    setTimeout(() => {
      sensorData.active = false;
      this.updateSensorDisplay(channel, sensorData);
    }, 3000);
  }

  /**
   * 处理来自硬件的数据 (锁定事件)
   */
  handleHardwareData(data) {
    const { direction, distance, ip, source } = data;

    // 根据方向代码找到对应的通道号
    let channel = -1;
    for (const [ch, dir] of Object.entries(directionMap)) {
      if (dir.code === direction) {
        channel = parseInt(ch);
        break;
      }
    }

    if (channel === -1) {
      console.error(`未知的方向: ${direction}`);
      return;
    }

    // 更新传感器数据，标记为硬件来源
    this.updateSensorData(channel, distance, source || 'hardware');
  }

  /**
   * 处理来自硬件的实时数据 (扫描数据)
   */
  handleRealtimeData(data) {
    const { direction, distance, isMinDistance } = data;

    // 根据方向代码找到对应的通道号
    let channel = -1;
    for (const [ch, dir] of Object.entries(directionMap)) {
      if (dir.code === direction) {
        channel = parseInt(ch);
        break;
      }
    }

    if (channel === -1) {
      return; // 静默跳过未知方向
    }

    // 更新实时传感器数据
    this.updateRealtimeSensorData(channel, distance, isMinDistance);
  }

  /**
   * 更新实时传感器数据
   */
  updateRealtimeSensorData(channel, distance, isMinDistance) {
    const direction = directionMap[channel];
    if (!direction) return;

    // 更新传感器数据
    const sensorData = {
      channel,
      code: direction.code,
      name: direction.name,
      displayName: direction.displayName,
      distance,
      timestamp: Date.now(),
      active: false, // 实时数据不设为活跃状态
      source: 'hardware',
      isMinDistance // 新增：是否为最小距离
    };

    this.sensorData.set(channel, sensorData);

    // 更新UI显示
    this.updateRealtimeSensorDisplay(channel, sensorData, isMinDistance);

    // 高亮最小距离的方向
    this.updateMinDistanceHighlight();
  }

  /**
   * 更新实时传感器显示
   */
  updateRealtimeSensorDisplay(channel, sensorData, isMinDistance) {
    const gridElement = this.gridElements.get(channel);
    if (!gridElement) return;

    const distanceElement = gridElement.querySelector('.distance-display');
    if (!distanceElement) return;

    // 更新距离显示
    distanceElement.textContent = sensorData.distance > 0
      ? `${sensorData.distance} mm`
      : '--- mm';

    // 移除所有高亮类
    gridElement.classList.remove('active', 'min-distance');

    // 设置实时数据显示样式 (浅蓝色)
    distanceElement.style.color = '#3b82f6';

    // 如果是当前最小距离，高亮显示
    if (isMinDistance && sensorData.distance > 0) {
      gridElement.classList.add('min-distance');
      distanceElement.style.color = '#059669'; // 绿色高亮
    }
  }

  /**
   * 更新最小距离高亮
   */
  updateMinDistanceHighlight() {
    // 清除所有最小距离高亮
    this.gridElements.forEach((element) => {
      element.classList.remove('min-distance');
      const distanceElement = element.querySelector('.distance-display');
      if (distanceElement) {
        distanceElement.style.color = '#3b82f6'; // 恢复实时数据颜色
      }
    });

    // 找到当前最小距离的传感器
    let minDistance = Infinity;
    let minChannel = -1;

    this.sensorData.forEach((data, channel) => {
      if (data.distance > 0 && data.distance < minDistance) {
        minDistance = data.distance;
        minChannel = channel;
      }
    });

    // 高亮最小距离的方向
    if (minChannel !== -1) {
      const minElement = this.gridElements.get(minChannel);
      if (minElement) {
        minElement.classList.add('min-distance');
        const distanceElement = minElement.querySelector('.distance-display');
        if (distanceElement) {
          distanceElement.style.color = '#059669'; // 绿色高亮
        }
      }
    }
  }

  /**
   * 更新传感器显示 (保留原有的锁定数据显示)
   */
  updateSensorDisplay(channel, sensorData) {
    const gridElement = this.gridElements.get(channel);
    if (!gridElement) return;

    const distanceElement = gridElement.querySelector('.distance-display');
    if (!distanceElement) return;

    // 更新距离显示
    distanceElement.textContent = sensorData.distance > 0
      ? `${sensorData.distance} mm`
      : '--- mm';

    // 更新样式 - 锁定事件使用原有逻辑
    if (sensorData.active) {
      gridElement.classList.add('active');
      distanceElement.style.color = '#10b981'; // 绿色 (锁定状态)
    } else {
      gridElement.classList.remove('active');
      // 恢复到实时数据状态
      this.updateMinDistanceHighlight();
    }
  }

  /**
   * 添加日志条目
   */
  addLog(sensorData) {
    const sourceText = sensorData.source === 'hardware' ? '🔗 硬件' : '🎲 模拟';
    const logEntry = {
      id: Date.now(),
      timestamp: sensorData.timestamp,
      channel: sensorData.channel,
      code: sensorData.code,
      displayName: sensorData.displayName,
      distance: sensorData.distance,
      source: sensorData.source,
      message: `${sourceText} 通道 ${sensorData.channel} (${sensorData.displayName}): ${sensorData.distance} mm`
    };

    this.logs.unshift(logEntry);

    // 限制日志数量
    if (this.logs.length > 50) {
      this.logs = this.logs.slice(0, 50);
    }

    this.renderLogs();
  }

  /**
   * 更新IP地址显示
   */
  updateIPDisplay() {
    const ipElement = document.getElementById('local-ip');
    if (ipElement) {
      ipElement.textContent = `IP: ${this.localIP}`;
    }
  }

  /**
   * 更新UDP连接状态显示
   */
  updateUDPStatus(status) {
    const udpElement = document.getElementById('udp-status');
    if (udpElement) {
      // 移除所有状态类
      udpElement.classList.remove('connected', 'searching');

      switch (status) {
        case 'connected':
          udpElement.textContent = '📡 UDP: 已连接';
          udpElement.classList.add('connected');
          break;
        case 'searching':
          udpElement.textContent = '📡 UDP: 搜索中';
          udpElement.classList.add('searching');
          break;
        case 'disconnected':
        default:
          udpElement.textContent = '📡 UDP: 未连接';
          break;
      }
    }
  }

  /**
   * 处理UDP发现的设备
   */
  handleDeviceDiscovered(device) {
    console.log('🔍 处理发现的设备:', device);

    // 更新UDP状态为已连接
    this.updateUDPStatus('connected');

    // 添加日志
    this.addLog({
      id: Date.now(),
      timestamp: Date.now(),
      channel: -1, // 系统消息
      code: 'UDP',
      displayName: 'UDP发现',
      distance: 0,
      source: 'discovery',
      message: `🔍 发现SEBT设备: ${device.ip}:${device.port} (${device.deviceInfo})`
    });

    // 可以在这里添加自动连接逻辑
    // 比如自动切换到UDP发现的设备IP
    console.log(`设备已发现并验证: ${device.ip}:${device.port}`);
  }

  /**
   * 渲染日志
   */
  renderLogs() {
    const logsContainer = document.getElementById('logs-container');
    if (!logsContainer) return;

    // 清空现有日志
    logsContainer.innerHTML = '';

    if (this.logs.length === 0) {
      logsContainer.innerHTML = '<div class="log-entry"><div class="log-content">暂无日志记录</div></div>';
      return;
    }

    // 渲染日志条目
    this.logs.forEach(log => {
      const logElement = document.createElement('div');
      logElement.className = `log-entry ${log.source === 'hardware' ? 'hardware' : 'simulated'}`;

      const timeString = new Date(log.timestamp).toLocaleTimeString('zh-CN', {
        hour12: false,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      });

      logElement.innerHTML = `
        <div class="log-time">${timeString}</div>
        <div class="log-content">${log.message}</div>
      `;

      logsContainer.appendChild(logElement);
    });

    // 滚动到底部
    logsContainer.scrollTop = logsContainer.scrollHeight;
  }

  /**
   * 清空日志
   */
  clearLogs() {
    this.logs = [];
    this.renderLogs();
  }

  /**
   * 获取传感器数据 (用于调试)
   */
  getSensorData(channel) {
    return this.sensorData.get(channel);
  }

  /**
   * 获取所有日志
   */
  getLogs() {
    return this.logs;
  }
}

// 应用初始化
document.addEventListener('DOMContentLoaded', () => {
  const app = new SEBTApp();

  // 将应用实例暴露到全局，方便调试
  window.sebtApp = app;

  console.log('SEBT 平衡测试系统已启动');
  console.log('方位映射:', directionMap);
});
