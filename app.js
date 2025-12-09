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
    // 自动锁定相关常量
    this.AUTO_LOCK_TIME_MS = 3000; // 3秒自动锁定阈值

    this.sensorData = new Map();
    this.logs = [];
    this.gridElements = new Map();
    this.localIP = '获取中...';
    this.waitingForManualResult = null;
    this.lockedDirections = new Set(); // 已锁定的方向集合
    this.completedDirections = new Set(); // 已完成测距的方向集合
    this.lastSequence = -1; // 最后处理的序号，避免重复处理
    this.deviceConnected = false; // 设备连接状态
    this.simulatedMinDirection = -1; // 模拟数据的最近方向

    // 自动锁定相关变量
    this.currentMinDirection = -1; // 当前连续最短的方向
    this.minDirectionStartTime = 0; // 当前最短方向开始的时间

    this.initializeApp();
    this.setupEventListeners();
    this.setupGlobalClickListener();
    this.setupIPCListeners();
    this.updateMockDataButtonState(); // 初始化模拟按钮状态
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

    // 检查是否已完成测距
    if (this.completedDirections.has(channel)) {
      console.log('方向已完成测距，无需操作');
      return;
    }

    // 检查是否已锁定（只有锁定的方向才能进行手动测距）
    const canMeasure = this.lockedDirections.has(channel);

    if (!canMeasure) {
      console.log('方向未锁定，无法进行手动测距');
      return;
    }

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
      measureBtn.textContent = '开始测距';
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

    // 如果有真实设备连接，发送命令到ESP32
    if (this.deviceConnected) {
      const command = `MEASURE:${channel}`;
      this.sendCommandToESP32(command);
    } else {
      // 模拟模式：直接模拟测距结果
      console.log('🎲 模拟测距模式');
    }

    // 添加日志
    this.addLog(`📏 手动测距: ${direction.displayName}`, 'info');

    // 设置标志，表示正在等待手动测距结果
    this.waitingForManualResult = { channel, direction };

    // 隐藏测距按钮，显示正在测距
    const measureBtn = document.getElementById(`measure-${direction.code}`);
    if (measureBtn) {
      measureBtn.textContent = '测距中...';
      measureBtn.disabled = true;
    }

    // 模拟或真实测距的延迟处理
    const delayTime = this.deviceConnected ? 3000 : 1000; // 模拟模式更快

    setTimeout(() => {
      if (this.waitingForManualResult && this.waitingForManualResult.channel === channel) {
        // 模拟测距结果
        const mockDistance = Math.floor(Math.random() * 100) + 30; // 30-130mm
        console.log(`🎲 模拟测距完成: ${direction.displayName} = ${mockDistance}mm`);

        this.handleManualMeasurementResult(channel, mockDistance, direction);
      }
    }, delayTime);
  }

  /**
   * 处理手动测距结果
   */
  handleManualMeasurementResult(channel, distance, direction) {
    console.log(`📊 手动测距结果: ${direction.displayName} = ${distance}mm`);

    // 完成这个方向的测距
    this.completeDirection(channel, distance);

    // 添加日志
    this.addLog(`📐 手动测距完成: ${direction.displayName} - ${distance}mm`, 'success');
  }

  /**
   * 锁定指定方向（等待手动测距）
   */
  lockDirection(channel, distance) {
    if (this.lockedDirections.has(channel) || this.completedDirections.has(channel)) {
      return; // 已经锁定或完成
    }

    // 添加到锁定集合
    this.lockedDirections.add(channel);

    // 更新UI显示锁定状态（橙色，表示等待测距）
    const gridElement = this.gridElements.get(channel);
    if (gridElement) {
      gridElement.classList.add('locked');
      gridElement.classList.remove('active', 'min-distance');

      // 更新距离显示
      const distanceElement = gridElement.querySelector('.distance-display');
      if (distanceElement) {
        distanceElement.textContent = `${distance} mm`;
        distanceElement.style.color = '#f59e0b'; // 橙色表示锁定等待测距
      }

      // 显示手动测距按钮（因为这是锁定的方向）
      const measureBtn = gridElement.querySelector('.manual-measure-btn');
      if (measureBtn) {
        measureBtn.textContent = '开始测距';
        measureBtn.style.display = 'block';
      }
    }

    console.log(`🔒 方向已锁定，等待手动测距: ${directionMap[channel].displayName}`);

    // 更新按钮状态
    this.updateMockDataButtonState();
  }

  /**
   * 完成指定方向的测距
   */
  completeDirection(channel, distance) {
    if (this.completedDirections.has(channel)) {
      return; // 已经完成
    }

    // 从锁定状态移除，添加到完成状态
    this.lockedDirections.delete(channel);
    this.completedDirections.add(channel);

    // 更新UI显示完成状态（灰色，不可更改）
    const gridElement = this.gridElements.get(channel);
    if (gridElement) {
      gridElement.classList.remove('locked', 'active', 'min-distance', 'selected');
      gridElement.classList.add('completed');

      // 更新距离显示
      const distanceElement = gridElement.querySelector('.distance-display');
      if (distanceElement) {
        distanceElement.textContent = `${distance} mm`;
        distanceElement.style.color = '#6b7280'; // 灰色表示已完成
      }

      // 隐藏手动测距按钮
      const measureBtn = gridElement.querySelector('.manual-measure-btn');
      if (measureBtn) {
        measureBtn.style.display = 'none';
      }
    }

    console.log(`✅ 方向测距完成: ${directionMap[channel].displayName} = ${distance}mm`);

    // 更新按钮状态
    this.updateMockDataButtonState();

    // 检查是否所有方向都已完成
    this.checkExperimentCompletion();
  }

  /**
   * 检查实验是否完成
   */
  checkExperimentCompletion() {
    if (this.completedDirections.size === 8) {
      console.log('🎉 实验完成！所有8个方向都已测距完毕');
      this.addLog('🎉 实验完成！所有方向测距完毕', 'success');

      // 可以在这里添加完成后的处理逻辑
      // 比如显示完成弹窗、保存结果等
      setTimeout(() => {
        alert('🎉 平衡测试实验完成！\n所有8个方向的测距都已完成。');
      }, 500);
    }
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

    // 模拟锁定按钮
    const mockLockBtn = document.getElementById('mock-lock-btn');
    if (mockLockBtn) {
      mockLockBtn.addEventListener('click', () => this.simulateLock());
    }

    // 重置锁定状态按钮
    const resetLockedBtn = document.getElementById('reset-locked-btn');
    if (resetLockedBtn) {
      resetLockedBtn.addEventListener('click', () => this.resetLockedDirections());
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
      this.deviceConnected = true;
      this.updateSerialStatus(true, info);
      this.updateMockDataButtonState();
    });

    ipcRenderer.on('serial-disconnected', (event) => {
      console.log('🔌 串口已断开');
      this.deviceConnected = false;
      this.updateSerialStatus(false);
      this.updateMockDataButtonState();

      // 清除模拟数据和高亮状态
      this.simulatedMinDirection = -1;

      // 重置自动锁定状态
      this.currentMinDirection = -1;
      this.minDirectionStartTime = 0;
      this.clearAllHighlights();
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
    const { sequence, timestamp, distances, currentMinDirection, currentMinDistance, isLocked } = data;

    // 检查序号，避免重复处理
    if (sequence <= this.lastSequence) {
      console.log(`📊 跳过重复数据包 #${sequence}`);
      return; // 跳过已处理的数据包
    }
    this.lastSequence = sequence;

    console.log(`📊 处理数据包 #${sequence}:`, {
      currentMinDirection,
      currentMinDistance,
      isLocked,
      distances: distances.slice(0, 8) // 只显示前8个
    });

    // 更新所有8个方向的距离数据（跳过已锁定和已完成的方向）
    // 对于真实数据，更新所有未完成的方向；对于模拟数据，也更新所有未完成的方向
    for (let channel = 0; channel < 8; channel++) {
      const shouldUpdate = !this.lockedDirections.has(channel) &&
                          !this.completedDirections.has(channel);

      if (shouldUpdate) {
        // 只更新未锁定且未完成的有效方向
        const distance = distances[channel];
        if (distance > 0 && distance < 9999) { // 有效距离
          this.updateSensorData(channel, distance, timestamp);
        }
      }
    }

    // 处理锁定状态（来自ESP32的锁定）
    if (isLocked) {
      // 锁定当前最小距离的方向
      if (!this.lockedDirections.has(currentMinDirection)) {
        this.lockDirection(currentMinDirection, currentMinDistance);
        console.log(`🔒 ESP32锁定: ${directionMap[currentMinDirection].displayName} - ${currentMinDistance}mm`);
        this.addLog(`🔒 ESP32锁定: ${directionMap[currentMinDirection].displayName} - ${currentMinDistance}mm`, 'success');
      }
    } else if (this.deviceConnected) {
      // ESP32未锁定，前端进行自动锁定检查
      this.checkAutoLock(currentMinDirection, currentMinDistance);
    }

    // 高亮当前最近方向（排除已完成测距的方向）
    this.highlightClosestDirection(distances);
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
   * 模拟锁定功能
   */
  simulateLock() {
    console.log('🔒 模拟锁定功能');

    // 只有在设备未连接时才能使用模拟锁定
    if (this.deviceConnected) {
      console.log('❌ 设备已连接，无法使用模拟锁定');
      return;
    }

    // 检查是否已经有锁定方向（模拟模式下只允许锁定一个方向）
    if (this.lockedDirections.size > 0) {
      console.log('❌ 已有方向被锁定，无法重复锁定');
      return;
    }

    // 找到当前高亮的方向，或者随机选择一个未完成的方向
    let directionToLock = -1;

    // 首先检查是否有当前高亮的方向
    for (let channel = 0; channel < 8; channel++) {
      const element = this.gridElements.get(channel);
      if (element && element.classList.contains('min-distance')) {
        directionToLock = channel;
        break;
      }
    }

    // 如果没有高亮方向，随机选择一个未完成的方向
    if (directionToLock === -1) {
      const availableChannels = [];
      for (let channel = 0; channel < 8; channel++) {
        if (!this.completedDirections.has(channel)) {
          availableChannels.push(channel);
        }
      }

      if (availableChannels.length > 0) {
        directionToLock = availableChannels[Math.floor(Math.random() * availableChannels.length)];
      } else {
        console.log('ℹ️ 所有方向都已完成，无法模拟锁定');
        return;
      }
    }

    // 获取当前距离数据
    const sensorData = this.sensorData.get(directionToLock);
    const currentDistance = sensorData ? sensorData.distance : Math.floor(Math.random() * 100) + 50;

    // 锁定这个方向
    this.lockDirection(directionToLock, currentDistance);

    console.log(`🔒 模拟锁定方向: ${directionMap[directionToLock].displayName} - ${currentDistance}mm`);
    this.addLog(`🔒 模拟锁定: ${directionMap[directionToLock].displayName} - ${currentDistance}mm`, 'success');
  }

  /**
   * 模拟传感器数据 (同时更新所有8个方向)
   */
  simulateSensorData() {
    console.log('🎲 生成模拟传感器数据包');

    // 生成8个方向的距离数据
    const distances = [];
    let minDistance = 9999;
    let minDirection = -1;

    // 为所有8个方向生成距离（包括已完成的方向，但已完成的方向使用固定值）
    for (let channel = 0; channel < 8; channel++) {
      let distance;

      if (this.completedDirections.has(channel)) {
        // 已完成的方向使用固定的历史读数
        const sensorData = this.sensorData.get(channel);
        distance = sensorData ? sensorData.distance : 9999;
      } else {
        // 未完成的方向生成随机距离
        distance = Math.floor(Math.random() * 1950) + 50; // 50-2000mm
      }

      distances.push(distance);

      // 找到未完成方向中的最小距离
      if (!this.completedDirections.has(channel) && distance < minDistance) {
        minDistance = distance;
        minDirection = channel;
      }
    }

    // 如果没有找到最小方向（所有方向都已完成），设置默认值
    if (minDirection === -1) {
      minDirection = 0;
      minDistance = distances[0] || 9999;
    }

    // 构造与真实数据相同格式的数据包
    const mockData = {
      sequence: this.lastSequence + 1, // 模拟递增的序列号
      timestamp: Date.now(),
      distances: distances, // 8个方向的距离数组
      currentMinDirection: minDirection,
      currentMinDistance: minDistance,
      isLocked: false // 模拟数据默认不锁定
    };

    console.log('📤 发送模拟数据包:', mockData);

    // 通过相同的处理流程处理模拟数据（就像从端口传入一样）
    this.handleSerialData(mockData);

    // 添加日志记录
    const minDir = directionMap[minDirection];
    this.addLog({
      id: Date.now(),
      type: 'sensor',
      direction: minDir.code,
      distance: minDistance,
      source: 'simulated',
      timestamp: Date.now(),
      message: `模拟数据包 - 最近方向: ${minDir.displayName} (${minDistance}mm)`
    });
  }

  /**
   * 更新传感器数据
   */
  updateSensorData(channel, distance, source = 'simulated') {
    // 已完成测距的方向不应该被更新
    if (this.completedDirections.has(channel)) {
      return;
    }

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

    // 更新UI - 模拟数据不设置为活跃状态，避免虚假的高亮
    if (source === 'hardware') {
      // 只有硬件数据才设置为活跃状态
      sensorData.active = true;

      // 更新UI
      this.updateSensorDisplay(channel, sensorData);

      // 3秒后重置为非活跃状态
      setTimeout(() => {
        sensorData.active = false;
        this.updateSensorDisplay(channel, sensorData);
      }, 3000);
    } else {
      // 模拟数据直接更新UI，不设置活跃状态
      sensorData.active = false;
      this.updateSensorDisplay(channel, sensorData);
    }

    // 添加日志
    this.addLog(sensorData);
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
    // 已完成测距的方向不应该被更新
    if (this.completedDirections.has(channel)) {
      return;
    }

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

    // 高亮逻辑现在由highlightClosestDirection统一管理，不在这里重复调用
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
      // 恢复到默认颜色，具体的方向高亮由highlightClosestDirection统一管理
      distanceElement.style.color = '#3b82f6'; // 默认蓝色
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
   * 检查并执行自动锁定
   */
  checkAutoLock(currentMinDirection, currentMinDistance) {
    const now = Date.now();

    // 检查方向是否改变
    if (this.currentMinDirection !== currentMinDirection) {
      // 方向改变，重置计时器
      this.currentMinDirection = currentMinDirection;
      this.minDirectionStartTime = now;
      console.log(`🔄 最短方向改变为: ${directionMap[currentMinDirection].displayName}，开始计时`);
      return;
    }

    // 检查是否已经锁定或已完成
    if (this.lockedDirections.has(currentMinDirection) || this.completedDirections.has(currentMinDirection)) {
      return;
    }

    // 检查持续时间
    const duration = now - this.minDirectionStartTime;
    if (duration >= this.AUTO_LOCK_TIME_MS) {
      // 自动锁定
      this.lockDirection(currentMinDirection, currentMinDistance);
      console.log(`🔒 前端自动锁定: ${directionMap[currentMinDirection].displayName} - ${currentMinDistance}mm (持续${duration}ms)`);
      this.addLog(`🔒 前端自动锁定: ${directionMap[currentMinDirection].displayName} - ${currentMinDistance}mm`, 'success');
    } else {
      console.log(`⏱️ 方向锁定倒计时: ${directionMap[currentMinDirection].displayName} (${Math.round(duration/1000)}/${this.AUTO_LOCK_TIME_MS/1000}s)`);
    }
  }

  /**
   * 清除所有高亮状态
   */
  clearAllHighlights() {
    this.gridElements.forEach((element) => {
      element.classList.remove('active', 'min-distance');
    });
  }

  /**
   * 高亮最近方向（排除已完成测距的方向）
   */
  highlightClosestDirection(distances) {
    // 清除所有高亮
    this.gridElements.forEach((element) => {
      element.classList.remove('min-distance');
    });

    // 从所有方向中找到未完成测距的方向中距离最短的一个
    let closestChannel = -1;
    let closestDistance = 9999;

    for (let channel = 0; channel < 8; channel++) {
      // 只考虑未完成测距的方向
      if (!this.completedDirections.has(channel)) {
        const distance = distances[channel];
        if (distance > 0 && distance < 9999 && distance < closestDistance) {
          closestDistance = distance;
          closestChannel = channel;
        }
      }
    }

    // 高亮找到的最短距离方向
    if (closestChannel >= 0) {
      const targetElement = this.gridElements.get(closestChannel);
      if (targetElement) {
        targetElement.classList.add('min-distance');
        console.log(`🎯 高亮最近方向: ${directionMap[closestChannel].displayName} (${closestDistance}mm)`);
      }
    } else {
      console.log('ℹ️ 没有可高亮的方向（所有方向都已完成测距）');
    }
  }

  /**
   * 更新模拟数据按钮状态
   */
  updateMockDataButtonState() {
    const mockDataBtn = document.getElementById('mock-data-btn');
    const mockLockBtn = document.getElementById('mock-lock-btn');

    if (this.deviceConnected) {
      // 设备已连接时，禁用所有模拟按钮
      if (mockDataBtn) {
        mockDataBtn.disabled = true;
        mockDataBtn.textContent = '设备已连接';
        mockDataBtn.style.opacity = '0.5';
      }
      if (mockLockBtn) {
        mockLockBtn.disabled = true;
        mockLockBtn.textContent = '设备已连接';
        mockLockBtn.style.opacity = '0.5';
      }
    } else {
      // 设备未连接时，根据锁定状态控制按钮
      const hasLockedDirections = this.lockedDirections.size > 0;

      // 模拟数据按钮：有锁定方向时禁用
      if (mockDataBtn) {
        if (hasLockedDirections) {
          mockDataBtn.disabled = true;
          mockDataBtn.textContent = '请先完成测距';
          mockDataBtn.style.opacity = '0.5';
        } else {
          mockDataBtn.disabled = false;
          mockDataBtn.textContent = '模拟8方向数据';
          mockDataBtn.style.opacity = '1';
        }
      }

      // 模拟锁定按钮：有锁定方向时禁用
      if (mockLockBtn) {
        if (hasLockedDirections) {
          mockLockBtn.disabled = true;
          mockLockBtn.textContent = '已有锁定方向';
          mockLockBtn.style.opacity = '0.5';
        } else {
          mockLockBtn.disabled = false;
          mockLockBtn.textContent = '模拟锁定';
          mockLockBtn.style.opacity = '1';
        }
      }
    }
  }

  /**
   * 重置所有锁定和完成状态
   */
  resetLockedDirections() {
    console.log('🔄 重置所有锁定和完成状态');

    // 清除锁定和完成集合
    this.lockedDirections.clear();
    this.completedDirections.clear();
    this.simulatedMinDirection = -1; // 重置模拟数据状态

    // 重置自动锁定状态
    this.currentMinDirection = -1;
    this.minDirectionStartTime = 0;

    // 重置所有卡片的UI状态
    this.gridElements.forEach((element, channel) => {
      element.classList.remove('locked', 'selected', 'active', 'min-distance', 'completed');

      // 隐藏手动测距按钮
      const measureBtn = element.querySelector('.manual-measure-btn');
      if (measureBtn) {
        measureBtn.style.display = 'none';
        measureBtn.disabled = false;
        measureBtn.textContent = '开始测距';
      }

      // 重置距离显示
      const distanceElement = element.querySelector('.distance-display');
      if (distanceElement) {
        distanceElement.textContent = '--- mm';
        distanceElement.style.color = '#6b7280'; // 默认灰色
      }
    });

    // 清除等待状态
    if (this.waitingForManualResult) {
      this.waitingForManualResult = null;
    }

    // 发送重置命令到ESP32
    this.sendCommandToESP32('RESET');

    // 更新按钮状态
    this.updateMockDataButtonState();

    // 添加日志
    this.addLog('🔄 系统重置，所有锁定和完成状态已清除', 'info');
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
