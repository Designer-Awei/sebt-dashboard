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
    // 硬件发送间隔：300ms（固定）
    this.HARDWARE_SEND_INTERVAL_MS = 300;
    // 锁定连续次数：默认10次（对应3秒）
    this.LOCK_REQUIRED_COUNT = 10;
    // 计算锁定时间（毫秒）
    this.AUTO_LOCK_TIME_MS = this.LOCK_REQUIRED_COUNT * this.HARDWARE_SEND_INTERVAL_MS;
    
    // 无效值常量
    this.INVALID_DISTANCE = 'invalid'; // 无效距离标记
    this.MAX_VALID_DISTANCE = 2000; // 最大有效距离（与硬件端FILTER_MAX_MM一致）

    this.sensorData = new Map();
    this.logs = [];
    this.gridElements = new Map();
    this.waitingForManualResult = null;
    this.bluetoothMeasurementCollection = null; // 蓝牙测距数据收集状态
    this.lockedDirections = new Set(); // 已锁定的方向集合
    this.completedDirections = new Set(); // 已完成测距的方向集合
    this.lastSequence = -1; // 最后处理的序号，避免重复处理
    this.bleConnected = false; // 主机BLE连接状态
    this.slaveDeviceConnected = false; // 从机连接状态
    this.hostDevice = null;
    this.slaveDevice = null;
    this.bleTarget = 'host'; // 当前弹窗目标：host|slave
    this.bleIPCHandlersSetup = false; // BLE IPC监听器是否已设置
    this.bleDiagnosing = false; // 是否正在进行BLE诊断
    this.simulatedMinDirection = -1; // 模拟数据的最近方向

    // 自动锁定相关变量
    this.currentMinDirection = -1; // 当前连续最短的方向
    this.minDirectionStartTime = 0; // 当前最短方向开始的时间
    this.minDirectionConsecutiveCount = 0; // 当前最短方向连续出现的次数
    this.lockFeatureEnabled = false; // 锁定功能开关（默认关闭）

    this.initializeApp();
    this.setupEventListeners();
    this.setupGlobalClickListener();
    this.setupIPCListeners();
    this.updateMockDataButtonState(); // 初始化模拟按钮状态
    this.updateBluetoothStatus({ connected: false, text: '📡 主机BT: 未连接', class: 'disconnected' });
    this.updateSlaveBLEStatus({ connected: false, text: '🦶 从机BT: 未连接', class: 'disconnected' });
    
    // 初始化锁定时长显示（延迟执行，确保DOM已加载）
    setTimeout(() => {
      this.updateLockTimeDisplay();
    }, 100);
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
    console.log(`🎯 执行手动测距: ${direction.displayName} (通道: ${channel})`);

    // 设置标志，表示正在等待手动测距结果
    this.waitingForManualResult = { channel, direction };

    // 隐藏测距按钮，显示正在测距
    const measureBtn = document.getElementById(`measure-${direction.code}`);
    if (measureBtn) {
      measureBtn.textContent = '测距中...';
      measureBtn.disabled = true;
    }

    // 添加日志
    this.addLog(`📏 手动测距: ${direction.displayName}`, 'info');

    // 检查蓝牙连接状态
    if (this.bleConnected) {
      // 蓝牙连接模式：收集最近3次对应方向的距离数据并计算平均值
      console.log('📊 蓝牙测距模式 - 收集最近3次距离数据计算平均值');

      // 开始收集距离数据
      this.startBluetoothMeasurementCollection(channel, direction);

    } else {
      // 模拟模式：直接模拟测距结果
      console.log('🎲 模拟测距模式');

      setTimeout(() => {
        if (this.waitingForManualResult && this.waitingForManualResult.channel === channel) {
          // 模拟测距结果
          const mockDistance = Math.floor(Math.random() * 100) + 30; // 30-130mm
          console.log(`🎲 模拟测距完成: ${direction.displayName} = ${mockDistance}mm`);

          this.handleManualMeasurementResult(channel, mockDistance, direction);
        }
      }, 1000);
    }
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

    // 如果蓝牙已连接，发送测距完成命令给硬件端
    if (this.bleConnected) {
      const command = `MEASURE:${channel}`;
      console.log(`📡 发送测距完成命令给硬件端: ${command}`);
      this.sendBluetoothCommand(command);
    }

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

    // 主机BLE按钮
    const hostBtn = document.getElementById('bluetooth-status');
    if (hostBtn) {
      hostBtn.addEventListener('click', () => {
        this.bleTarget = 'host';
        this.showBluetoothDeviceModal();
      });
    }

    // 从机BLE按钮（复用样式）
    const slaveBtn = document.getElementById('slave-status');
    if (slaveBtn) {
      slaveBtn.addEventListener('click', () => {
        this.bleTarget = 'slave';
        this.showBluetoothDeviceModal();
      });
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

    // 锁定时长滑动条
    const lockTimeSlider = document.getElementById('lock-time-slider');
    if (lockTimeSlider) {
      // 初始化显示
      this.updateLockTimeDisplay();
      
      // 监听滑动条变化
      lockTimeSlider.addEventListener('input', (e) => {
        const count = parseInt(e.target.value);
        this.LOCK_REQUIRED_COUNT = count;
        this.AUTO_LOCK_TIME_MS = count * this.HARDWARE_SEND_INTERVAL_MS;
        this.updateLockTimeDisplay();
        // 重置当前锁定计数，让新设置立即生效
        this.minDirectionConsecutiveCount = 0;
      });
    }

    // 锁定功能开关
    const lockFeatureToggle = document.getElementById('lock-feature-toggle');
    if (lockFeatureToggle) {
      lockFeatureToggle.addEventListener('change', (e) => {
        this.lockFeatureEnabled = e.target.checked;
        console.log(`🔒 锁定功能: ${this.lockFeatureEnabled ? '已开启' : '已关闭'}`);
        
        // 如果关闭锁定功能，清除所有锁定状态
        if (!this.lockFeatureEnabled) {
          this.lockedDirections.clear();
          this.minDirectionConsecutiveCount = 0;
          this.currentMinDirection = -1;
          this.minDirectionStartTime = 0;
          // 清除锁定状态的UI
          this.gridElements.forEach((element, channel) => {
            element.classList.remove('locked');
            const measureBtn = element.querySelector('.manual-measure-btn');
            if (measureBtn) {
              measureBtn.style.display = 'none';
            }
          });
          this.updateMinDistanceHighlight();
        }
      });
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

    // 监听蓝牙连接状态（用于区分主机/从机）
    ipcRenderer.on('bluetooth-status', (event, status) => {
      console.log('📱 BLE状态更新:', status);
      const name = status?.device?.name || '';
      const upper = name.toUpperCase();
      const role = upper.includes('SLAVE') || upper.includes('FSR') ? 'slave' : 'host';
      if (role === 'slave') {
        this.updateSlaveBLEStatus(status);
      } else {
        this.updateBluetoothStatus(status);
      }
    });

    // 监听蓝牙数据
    ipcRenderer.on('bluetooth-data-received', (event, data) => {
      console.log('📊 蓝牙数据:', data);
      this.handleBluetoothData(data);
    });

    // 监听蓝牙设备发现（实时）
    ipcRenderer.on('bluetooth-device-discovered', (event, device) => {
      console.log('🔍 IPC收到蓝牙设备发现:', device);
      this.handleBluetoothDeviceDiscovered(device);
    });

    // 监听蓝牙设备扫描完成
    ipcRenderer.on('bluetooth-devices-found', (event, devices) => {
      this.handleBluetoothDevicesFound(devices);
    });

    // 监听蓝牙扫描停止
    ipcRenderer.on('bluetooth-scan-stopped', (event, data) => {
      console.log('🛑 蓝牙扫描已停止');
    });

    // 初始化蓝牙事件
    this.initBluetoothEvents();
  }


  /**
   * 处理模拟传感器数据
   */
  handleMockData(data) {
    const { sequence, timestamp, distances, currentMinDirection, currentMinDistance, isLocked } = data;

    // 检查序号，避免重复处理
    if (sequence <= this.lastSequence) {
      console.log(`📊 跳过重复模拟数据包 #${sequence}`);
      return;
    }
    this.lastSequence = sequence;

    console.log(`📊 处理模拟数据包 #${sequence}:`, {
      currentMinDirection,
      currentMinDistance,
      isLocked,
      distances: distances.slice(0, 8)
    });

    // 更新所有8个方向的距离数据（跳过已锁定和已完成的方向）
    for (let channel = 0; channel < 8; channel++) {
      const shouldUpdate = !this.lockedDirections.has(channel) &&
                          !this.completedDirections.has(channel);

      if (shouldUpdate) {
        const distance = distances[channel];
        if (this.isValidDistance(distance)) { // 有效距离
          this.updateSensorData(channel, distance, timestamp);
        }
      }
    }

    // 处理锁定状态（模拟数据默认不锁定）
    if (isLocked) {
      // 锁定当前最小距离的方向
      if (!this.lockedDirections.has(currentMinDirection)) {
        this.lockDirection(currentMinDirection, currentMinDistance);
        console.log(`🔒 模拟锁定: ${directionMap[currentMinDirection].displayName} - ${currentMinDistance}mm`);
        this.addLog(`🔒 模拟锁定: ${directionMap[currentMinDirection].displayName} - ${currentMinDistance}mm`, 'success');
      }
    }

    // 高亮当前最近方向（排除已完成测距的方向）
    this.highlightClosestDirection(distances);
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
    let minDistance = Infinity;
    let minDirection = -1;

    // 为所有8个方向生成距离（包括已完成的方向，但已完成的方向使用固定值）
    for (let channel = 0; channel < 8; channel++) {
      let distance;

      if (this.completedDirections.has(channel)) {
        // 已完成的方向使用固定的历史读数
        const sensorData = this.sensorData.get(channel);
        distance = sensorData && this.isValidDistance(sensorData.distance) ? sensorData.distance : this.INVALID_DISTANCE;
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
      minDistance = distances[0] && this.isValidDistance(distances[0]) ? distances[0] : Infinity;
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

    // 直接处理模拟数据（不再通过串口处理流程）
    this.handleMockData(mockData);

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
    if (!gridElement) {
      console.warn(`⚠️ UI元素未找到: 方向${channel}`);
      return;
    }

    const distanceElement = gridElement.querySelector('.distance-display');
    if (!distanceElement) {
      console.warn(`⚠️ 距离显示元素未找到: 方向${channel}`);
      return;
    }

    // 更新距离显示（将2000视为无效值）
    const distance = sensorData.distance;
    if (distance === this.MAX_VALID_DISTANCE || !this.isValidDistance(distance)) {
      distanceElement.textContent = this.INVALID_DISTANCE;
    } else {
      distanceElement.textContent = this.formatDistance(distance);
    }

    // 移除所有高亮类
    gridElement.classList.remove('active', 'min-distance');

    // 设置实时数据显示样式 (浅蓝色)
    distanceElement.style.color = '#3b82f6';

    // 如果是当前最小距离，高亮显示
    if (isMinDistance && this.isValidDistance(distance)) {
      gridElement.classList.add('min-distance');
      distanceElement.style.color = '#059669'; // 绿色高亮最小距离
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
      if (this.isValidDistance(data.distance) && data.distance < minDistance) {
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
   * 检查距离值是否有效
   * @param {number|string} distance 距离值
   * @returns {boolean} 是否有效
   */
  isValidDistance(distance) {
    if (distance === this.INVALID_DISTANCE || distance === 'invalid') {
      return false;
    }
    if (typeof distance === 'number') {
      return distance > 0 && distance <= this.MAX_VALID_DISTANCE;
    }
    return false;
  }

  /**
   * 格式化距离显示
   * @param {number|string} distance 距离值
   * @returns {string} 格式化后的显示文本
   */
  formatDistance(distance) {
    if (!this.isValidDistance(distance)) {
      return this.INVALID_DISTANCE;
    }
    return `${distance} mm`;
  }

  /**
   * 更新传感器显示 (保留原有的锁定数据显示)
   */
  updateSensorDisplay(channel, sensorData) {
    const gridElement = this.gridElements.get(channel);
    if (!gridElement) return;

    const distanceElement = gridElement.querySelector('.distance-display');
    if (!distanceElement) return;

    // 更新距离显示（将2000视为无效值）
    const distance = sensorData.distance;
    if (distance === this.MAX_VALID_DISTANCE || !this.isValidDistance(distance)) {
      distanceElement.textContent = this.INVALID_DISTANCE;
    } else {
      distanceElement.textContent = this.formatDistance(distance);
    }

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
   * 处理蓝牙设备发现（实时单个设备）
   */
  handleBluetoothDeviceDiscovered(device) {
    // 添加到设备列表UI
    this.addBluetoothDeviceToList(device);
  }

  /**
   * 处理蓝牙设备扫描完成
   */
  handleBluetoothDevicesFound(devices) {
    // 更新设备列表UI
    this.updateBluetoothDeviceList(devices);
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
   * 更新蓝牙连接状态
   */
  updateBluetoothStatus(status) {
    const bluetoothElement = document.getElementById('bluetooth-status');
    if (!bluetoothElement || !status) return;

    this.bleConnected = !!status.connected;
    this.connectedDevice = status.device || this.connectedDevice;

    bluetoothElement.classList.remove('connected', 'searching', 'disconnected');

    const connected = !!status.connected;
    bluetoothElement.textContent = status.text ||
      (connected ? `📡 主机BT: 已连接` : '📡 主机BT: 未连接');

    if (status.class) {
      const classes = status.class.split(' ');
      classes.forEach(cls => {
        if (cls.trim()) bluetoothElement.classList.add(cls.trim());
      });
    } else {
      bluetoothElement.classList.add(connected ? 'connected' : 'disconnected');
    }

    if (!status.noClickable) {
      bluetoothElement.classList.add('bluetooth-clickable');
    }

    bluetoothElement.classList.add('bluetooth-status');
  }

  /**
   * 更新从机BLE连接状态
   */
  updateSlaveBLEStatus(status) {
    const slaveElement = document.getElementById('slave-status');
    if (!slaveElement || !status) return;

    this.slaveDeviceConnected = !!status.connected;
    this.slaveDevice = status.device || this.slaveDevice;

    slaveElement.classList.remove('connected', 'searching', 'disconnected');

    const connected = !!status.connected;
    const name = status?.device?.name || '从机';
    slaveElement.textContent = status.text ||
      (connected ? `🦶 从机BT: 已连接 (${name})` : '🦶 从机BT: 未连接');

    if (status.class) {
      const classes = status.class.split(' ');
      classes.forEach(cls => cls.trim() && slaveElement.classList.add(cls.trim()));
    } else {
      slaveElement.classList.add(connected ? 'connected' : 'disconnected');
    }

    slaveElement.classList.add('bluetooth-status');
    slaveElement.classList.add('bluetooth-clickable');
  }

  /**
   * 处理蓝牙数据
   */
  handleBluetoothData(data) {
    // 解析蓝牙JSON数据
    try {
      const jsonData = JSON.parse(data.data);

      // 处理8方向距离数据
      if (jsonData.distances && Array.isArray(jsonData.distances)) {
        jsonData.distances.forEach(([direction, distance]) => {
          // 将无效值（2000）转换为invalid标记
          const processedDistance = (distance === this.MAX_VALID_DISTANCE || !this.isValidDistance(distance)) 
            ? this.INVALID_DISTANCE 
            : distance;
          
          const sensorData = {
            channel: direction,
            direction: direction,
            distance: processedDistance,
            timestamp: jsonData.timestamp,
            source: 'bluetooth',
            type: 'realtime',
            active: false
          };

          // 更新传感器数据
          this.sensorData.set(direction, sensorData);
          
          // 更新显示
          this.updateSensorDisplay(direction, sensorData);

          // 如果是最小距离方向，更新高亮
          if (direction === jsonData.minDir && this.isValidDistance(processedDistance)) {
            this.updateMinDistanceHighlight();
          }
        });
        
        // 更新最小距离高亮
        this.updateMinDistanceHighlight();
      }
    } catch (error) {
      console.error('解析蓝牙数据失败:', error);
    }
  }

  /**
   * 开始蓝牙测距数据收集
   */
  startBluetoothMeasurementCollection(channel, direction) {
    console.log('📊 开始蓝牙测距数据收集:', direction.displayName, '方向', channel);

    // 初始化收集状态
    this.bluetoothMeasurementCollection = {
      channel: channel,
      direction: direction,
      distances: [],
      maxSamples: 3,
      timeout: 15000, // 15秒超时
      startTime: Date.now()
    };

    // 设置超时
    this.bluetoothMeasurementCollection.timeoutId = setTimeout(() => {
      console.warn('⚠️ 蓝牙测距数据收集超时');
      this.cancelBluetoothMeasurementCollection();
      this.addLog('⚠️ 蓝牙测距数据收集超时，请检查主机连接', 'warning');
    }, this.bluetoothMeasurementCollection.timeout);

    console.log(`📊 开始收集 ${this.bluetoothMeasurementCollection.maxSamples} 个距离样本`);
  }

  /**
   * 发送蓝牙命令
   */
  sendBluetoothCommand(command) {
    console.log('[Bluetooth] 发送命令:', command);
    const { ipcRenderer } = require('electron');
    ipcRenderer.send('bluetooth-send-command', command);
  }


  /**
   * 解析蓝牙扫描数据 (兼容旧格式)
   */
  parseBluetoothScanLegacyData(dataString) {
    // 解析格式类似："[45,25.3],[90,28.7],[135,22.1],..."
    const distances = [];
    const directions = [0, 45, 90, 135, 180, 225, 270, 315];

    try {
      // 移除可能的方括号和引号
      let cleanData = dataString.replace(/[\[\]"]/g, '');

      // 按逗号分割每个方向的数据
      const parts = cleanData.split('],[');

      parts.forEach((part, index) => {
        const values = part.split(',');
        if (values.length >= 2) {
          const direction = directions[index] || 0;
          const distance = parseFloat(values[1]);

          if (!isNaN(distance)) {
            distances.push({
              direction: direction,
              distance: distance,
              timestamp: new Date().toISOString(),
              source: 'ble',
              type: 'scan'
            });
          }
        }
      });

    } catch (error) {
      console.warn('BLE扫描数据解析警告:', error);
    }

    return distances;
  }

  /**
   * 处理BLE锁定数据
   */
  handleBLELockData(data) {
    console.log('🔒 处理BLE锁定数据:', data);

    try {
      // 解析主机发送的JSON格式锁定数据
      const lockData = this.parseBLELockJsonData(data.data);

      if (lockData && lockData.locked) {
        // 将BLE锁定数据转换为与硬件相同的格式
        const sensorData = {
          direction: lockData.directionIndex, // 使用方向索引 (0-7)
          distance: lockData.distance,
          timestamp: data.timestamp || new Date().toISOString(),
          source: 'ble',
          type: 'lock'
        };

        // 处理锁定事件
        this.handleLockEvent(sensorData);

        // 添加BLE数据日志
        const directionName = directionMap[lockData.directionIndex]?.displayName || '未知';
        this.addBLEDataLog(`锁定事件: ${directionName} ${lockData.distance}mm`, 'success');

        // 添加BLE特有的日志
        this.addLog({
          id: Date.now(),
          timestamp: data.timestamp,
          channel: lockData.directionIndex,
          code: 'BLE',
          displayName: 'BLE锁定',
          distance: lockData.distance,
          source: 'hardware',
          message: `🔒 主机锁定: ${lockData.directionName} - ${lockData.distance}mm`,
          type: 'ble-lock'
        });
      }

    } catch (error) {
      console.error('❌ 处理BLE锁定数据失败:', error);
      this.addLog({
        id: Date.now(),
        timestamp: new Date().toISOString(),
        channel: 'ERROR',
        code: 'BLE',
        displayName: 'BLE错误',
        distance: null,
        message: `锁定数据解析失败: ${error.message}`,
        type: 'error'
      });
    }
  }

  /**
   * 开始BLE测距数据收集
   */
  startBLEMeasurementCollection(channel, direction) {
    console.log(`📊 开始收集BLE测距数据: ${direction.displayName} (通道: ${channel})`);

    // 初始化收集状态
    this.bleMeasurementCollection = {
      channel: channel,
      direction: direction,
      distances: [], // 存储最近的距离数据
      maxSamples: 3, // 收集3个样本
      timeout: 5000, // 5秒超时
      startTime: Date.now()
    };

    // 设置超时
    this.bleMeasurementCollection.timeoutId = setTimeout(() => {
      if (this.bleMeasurementCollection && this.bleMeasurementCollection.channel === channel) {
        console.warn('⚠️ BLE测距数据收集超时');
        this.cancelBLEMeasurementCollection();
        this.addLog('⚠️ BLE测距数据收集超时，请检查主机连接', 'warning');
      }
    }, this.bleMeasurementCollection.timeout);
  }

  /**
   * 处理BLE测距数据收集
   */
  handleBLEMeasurementData(scanData) {
    if (!this.bleMeasurementCollection) return;

    const { channel, direction, distances, maxSamples } = this.bleMeasurementCollection;

    try {
      // 从扫描数据中提取对应方向的距离
      const parsedData = this.parseBLEScanJsonData(scanData.data);

      if (parsedData && parsedData.directionIndex === channel && parsedData.distance > 0) {
        // 添加有效的距离数据
        distances.push(parsedData.distance);
        console.log(`📊 BLE测距样本 ${distances.length}/${maxSamples}: ${parsedData.distance}mm`);

        // 检查是否收集够了样本
        if (distances.length >= maxSamples) {
          // 计算平均值
          const averageDistance = Math.round(distances.reduce((sum, dist) => sum + dist, 0) / distances.length);
          console.log(`📊 BLE测距完成: 平均值 ${averageDistance}mm (样本: [${distances.join(', ')}])`);

          // 完成测距
          this.completeBLEMeasurement(averageDistance, direction);

          // 清理收集状态
          this.clearBLEMeasurementCollection();
        }
      }
    } catch (error) {
      console.error('❌ 处理BLE测距数据失败:', error);
    }
  }

  /**
   * 完成BLE测距
   */
  completeBLEMeasurement(averageDistance, direction) {
    // 找到对应的通道
    const channel = Object.values(directionMap).findIndex(dir => dir.code === direction.code);

    if (channel !== -1) {
      console.log(`📐 BLE测距完成: ${direction.displayName} = ${averageDistance}mm`);
      this.handleManualMeasurementResult(channel, averageDistance, direction);
    }
  }

  /**
   * 取消BLE测距数据收集
   */
  cancelBLEMeasurementCollection() {
    if (this.bleMeasurementCollection) {
      if (this.bleMeasurementCollection.timeoutId) {
        clearTimeout(this.bleMeasurementCollection.timeoutId);
      }

      // 恢复测距按钮状态
      if (this.waitingForManualResult) {
        const { direction } = this.waitingForManualResult;
        const measureBtn = document.getElementById(`measure-${direction.code}`);
        if (measureBtn) {
          measureBtn.textContent = '开始测距';
          measureBtn.disabled = false;
        }
      }

      this.bleMeasurementCollection = null;
      this.waitingForManualResult = null;
    }
  }

  /**
   * 清理BLE测距数据收集状态
   */
  clearBLEMeasurementCollection() {
    if (this.bleMeasurementCollection) {
      if (this.bleMeasurementCollection.timeoutId) {
        clearTimeout(this.bleMeasurementCollection.timeoutId);
      }
      this.bleMeasurementCollection = null;
    }
  }

  /**
   * 解析BLE锁定数据 (JSON格式)
   */
  parseBLELockJsonData(dataString) {
    try {
      console.log('🔒 解析BLE锁定JSON数据:', dataString);

      // 尝试解析JSON数据
      const jsonData = JSON.parse(dataString.trim());

      // 提取锁定数据
      const locked = jsonData.locked || false;
      const directionIndex = jsonData.direction || 0;
      const directionName = jsonData.directionName || `方向${directionIndex}`;
      const distance = jsonData.distance || 0;

      return {
        locked: locked,
        directionIndex: directionIndex,
        directionName: directionName,
        distance: distance
      };

    } catch (error) {
      console.warn('BLE锁定JSON数据解析失败:', error, '原始数据:', dataString);
      return null;
    }
  }

  /**
   * 初始化BLE事件监听
   */
  async initBLEEvents() {
    console.log('🔄 初始化BLE事件...');

    // 初始化BLE IPC监听器（在DOM加载后立即设置，避免错过设备发现事件）
    this.setupBLEIPCHandlers();

    // BLE设备选择对话框将在模态框打开时初始化

    // 绑定BLE状态标签点击事件
    const bleStatus = document.getElementById('ble-status');
    if (bleStatus) {
      bleStatus.addEventListener('click', async (event) => {
        // 无论连接状态如何都允许点击，连接状态下用于查看设备信息和管理
        // 检查是否是Ctrl+点击，用于诊断模式
        if (event.ctrlKey) {
          console.log('🔧 进入BLE诊断模式...');
        }

        this.showBLEDeviceModal();
      });

      // 添加右键菜单用于诊断
      bleStatus.addEventListener('contextmenu', async (event) => {
        event.preventDefault();
        console.log('🔧 右键触发BLE诊断...');
      });

      console.log('✅ BLE状态标签点击事件已绑定 (Ctrl+点击或右键进行诊断)');
    } else {
      console.error('❌ 未找到BLE状态标签');
    }


    // 添加双击刷新功能 (用于调试)
    if (bleStatus) {
      bleStatus.addEventListener('dblclick', () => {
        console.log('🔄 双击刷新BLE状态');
        if (!this.bleConnected) {
          this.updateBLEStatus({
            text: '📱 主机BT: 未连接',
            class: 'disconnected'
          });
        }
      });
    }
  }

  /**
   * 初始化主页BLE状态显示
   */
  initBLEStatusDisplay() {
    const statusElement = document.getElementById('bluetooth-status');
    if (statusElement) {
      // 设置初始状态
      this.updateBLEStatus({
        text: '📱 主机BLE: 未连接',
        class: 'disconnected',
        clickable: true
      });

      // 注意：点击事件在initBluetoothEvents中统一绑定，避免重复绑定
    }
  }

  /**
   * 初始化蓝牙事件
   */
  async initBluetoothEvents() {
    console.log('🔄 初始化蓝牙事件...');

  // 初始化主页BLE状态显示
  this.initBLEStatusDisplay();

  // 初始化蓝牙设备选择对话框
  this.initBluetoothDeviceModal();

    // 绑定蓝牙状态标签点击事件
    const bluetoothStatus = document.getElementById('bluetooth-status');
    if (bluetoothStatus) {
      bluetoothStatus.addEventListener('click', async (event) => {
        // 无论连接状态如何都允许点击，连接状态下用于查看设备信息和管理
        // 检查是否是Ctrl+点击，用于诊断模式
        if (event.ctrlKey) {
          console.log('🔧 进入蓝牙诊断模式...');
        }

        this.showBluetoothDeviceModal();
      });

      // 添加右键菜单用于诊断
      bluetoothStatus.addEventListener('contextmenu', async (event) => {
        event.preventDefault();
        console.log('🔧 右键触发蓝牙诊断...');
      });

      console.log('✅ 蓝牙状态标签点击事件已绑定 (Ctrl+点击或右键进行诊断)');
    } else {
      console.error('❌ 未找到蓝牙状态标签');
    }

    // 添加双击刷新功能 (用于调试)
    if (bluetoothStatus) {
      bluetoothStatus.addEventListener('dblclick', () => {
        console.log('🔄 双击刷新蓝牙状态');
        if (!this.bleConnected) {
          this.updateBluetoothStatus({
            text: '📱 蓝牙: 未连接',
            class: 'disconnected'
          });
        }
      });
    }
  }

  /**
   * 初始化蓝牙设备选择对话框
   */
  initBluetoothDeviceModal() {
    this.bluetoothDeviceModal = document.getElementById('bluetooth-device-modal');
    this.bluetoothDeviceList = document.getElementById('bluetooth-device-list');
    // 统一使用bleDeviceList变量名
    this.bleDeviceList = this.bluetoothDeviceList;

    this.foundDevices = [];

    // 绑定设备列表点击事件（使用事件委托）
    if (this.bleDeviceList) {
      // 处理连接按钮点击
      this.bleDeviceList.addEventListener('click', (event) => {
        if (event.target.classList.contains('bluetooth-connect-action-btn')) {
          event.stopPropagation();
          const deviceId = event.target.dataset.deviceId;
          if (deviceId) {
            this.connectToSelectedBluetoothDeviceDirect(deviceId);
          }
        }
      });

      // 处理设备项悬停效果
      this.bleDeviceList.addEventListener('mouseenter', (event) => {
        const deviceItem = event.target.closest('.bluetooth-device-item');
        if (deviceItem) {
          deviceItem.classList.add('active');
        }
      }, true);

      this.bleDeviceList.addEventListener('mouseleave', (event) => {
        const deviceItem = event.target.closest('.bluetooth-device-item');
        if (deviceItem) {
          deviceItem.classList.remove('active');
        }
      }, true);
    }

    // 绑定模态框关闭事件
    const bluetoothModalClose = document.getElementById('bluetooth-modal-close');
    if (bluetoothModalClose) {
      bluetoothModalClose.addEventListener('click', () => {
        this.hideBluetoothDeviceModal();
      });
    }

    // 点击模态框背景关闭
    if (this.bluetoothDeviceModal) {
      this.bluetoothDeviceModal.addEventListener('click', (event) => {
        if (event.target === this.bluetoothDeviceModal) {
          this.hideBluetoothDeviceModal();
        }
      });
    }

    // 绑定扫描控制按钮
    this.bindBluetoothScanControls();

    console.log('✅ 蓝牙设备模态框已初始化');
  }

  /**
   * 绑定蓝牙扫描控制按钮
   */
  bindBluetoothScanControls() {
    const disconnectBtn = document.getElementById('bluetooth-disconnect-btn');
    const clearDataLogBtn = document.getElementById('bluetooth-clear-data-log-btn');

    if (disconnectBtn) {
      disconnectBtn.addEventListener('click', () => {
        this.disconnectBluetoothDevice();
      });
    }

    if (clearDataLogBtn) {
      clearDataLogBtn.addEventListener('click', () => {
        this.clearBluetoothDataLogs();
      });
    }
  }

  /**
   * 显示蓝牙设备选择对话框
   */
  showBluetoothDeviceModal() {
    if (this.bluetoothDeviceModal) {
      // 更新模态框标题
      const titleElement = document.getElementById('bluetooth-modal-title');
      if (titleElement) {
        const isHost = this.bleTarget !== 'slave';
        const prefix = isHost ? '📡 主机BT' : '🦶 从机BT';
        titleElement.textContent = this.bleConnected ?
          `${prefix} - 已连接` : `${prefix} - 数据日志`;
      }

      // 更新连接状态区域显示
      // 初始化模态框元素（只初始化一次）
      if (!this.bleModalInitialized) {
        this.initializeBLEModalElements();
      }

      // 显示模态框
      this.bluetoothDeviceModal.classList.add('show');
    } else {
      console.error('❌ 蓝牙模态框元素不存在!');
    }
  }

  /**
   * 隐藏蓝牙设备选择对话框
   */
  hideBluetoothDeviceModal() {
    if (this.bluetoothDeviceModal) {
      this.bluetoothDeviceModal.classList.remove('show');
      console.log('📱 隐藏蓝牙设备对话框');

      // 重置扫描按钮状态，避免状态残留
      this.updateBluetoothScanButtons(false);
    }
  }

  /**
   * 更新锁定时长显示
   */
  updateLockTimeDisplay() {
    const countDisplay = document.getElementById('lock-count-display');
    const timeDisplay = document.getElementById('lock-time-display');
    const slider = document.getElementById('lock-time-slider');

    if (countDisplay) {
      countDisplay.textContent = this.LOCK_REQUIRED_COUNT;
    }
    if (timeDisplay) {
      const timeInSeconds = (this.AUTO_LOCK_TIME_MS / 1000).toFixed(1);
      timeDisplay.textContent = timeInSeconds;
    }
    if (slider) {
      slider.value = this.LOCK_REQUIRED_COUNT;
    }
  }

  /**
   * 开始蓝牙设备扫描
   */
  startBluetoothScan() {
    console.log('🔍 开始蓝牙设备扫描...');

    const { ipcRenderer } = require('electron');

    // 清空之前的设备列表
    this.clearBluetoothDeviceList();
    this.updateBLEDeviceList('正在扫描附近设备...');

    // 发送扫描请求到主进程
    ipcRenderer.send('bluetooth-start-scan');

    // 5秒后自动停止扫描，避免长时间占用
    setTimeout(() => {
      this.stopBluetoothScan();
    }, 5000);
  }

  /**
   * 停止蓝牙设备扫描
   */
  stopBluetoothScan() {
    console.log('🛑 停止蓝牙设备扫描...');

    const { ipcRenderer } = require('electron');

    // 发送停止扫描请求到主进程
    ipcRenderer.send('bluetooth-stop-scan');
  }

  /**
   * 直接连接到选定的蓝牙设备
   */
  connectToSelectedBluetoothDeviceDirect(deviceId) {
    console.log('🔗 标记设备为已连接状态:', deviceId);

    // 防止重复连接
    if (this.bleConnected) {
      console.warn('⚠️ 已经连接到设备，忽略连接请求');
      return;
    }

    // 在单向广播模式下，只需要标记设备为已连接状态
    // 找到对应的设备信息
    const device = this.foundDevices.find(d => d.id === deviceId || d.address === deviceId);
    if (device) {
      // 更新连接状态
      this.handleBLEConnectionChange(true, device);
      this.addBLELog(`已连接到SEBT设备: ${device.name}`, 'success');

      // 发送状态更新到主进程（用于保持状态同步）
      const { ipcRenderer } = require('electron');
      ipcRenderer.send('ble-status-update', { connected: true, device });
    } else {
      console.error('❌ 未找到设备信息:', deviceId);
      this.addBLELog(`连接失败：未找到设备 ${deviceId}`, 'error');
    }
  }

  /**
   * 断开蓝牙设备连接
   */
  disconnectBluetoothDevice() {
    console.log('🔌 断开蓝牙设备连接');

    const { ipcRenderer } = require('electron');

    if (!this.bleConnected) {
      console.warn('⚠️ 当前未连接到设备');
      return;
    }

    // 发送断开连接请求到主进程
    ipcRenderer.send('bluetooth-disconnect');

    // 更新UI状态
    this.addBluetoothLog('正在断开连接...', 'info');
  }

  /**
   * 清空蓝牙设备列表显示
   */
  clearBluetoothDeviceList() {
    if (this.bleDeviceList) {
      // 保留表头，清除设备项
      const items = this.bleDeviceList.querySelectorAll('.ble-device-item:not(.header)');
      items.forEach(item => item.remove());
    }
    this.foundDevices = [];
  }

  /**
   * 添加单个蓝牙设备到列表UI
   */
  addBluetoothDeviceToList(device) {
    console.log(`[Bluetooth] 开始处理设备: ${device.name}, 列表元素:`, this.bleDeviceList);

    if (!this.bleDeviceList) {
      console.error('[Bluetooth] bleDeviceList不存在');
      return;
    }

    // 过滤目标设备（区分主机/从机）
    const deviceName = (device.name || '').toLowerCase().trim();
    const upperName = deviceName.toUpperCase();
    const wantHost = this.bleTarget === 'host';
    const matchHost = upperName.includes('HOST');
    const matchSlave = upperName.includes('SLAVE') || upperName.includes('FSR');
    const matchSEBT = upperName.includes('SEBT');

    // 如果是主机模式，允许SEBT设备通过（包括没有明确名称的）
    if (wantHost && !(matchHost || matchSEBT || (!deviceName && device.id))) {
      console.log(`[Bluetooth] 跳过非主机设备: "${device.name}" (ID: ${device.id})`);
      return;
    }
    if (!wantHost && !(matchSlave || (matchSEBT && !matchHost))) {
      console.log(`[Bluetooth] 跳过非从机设备: ${device.name}`);
      return;
    }

    console.log(`[Bluetooth] 添加设备到UI: ${device.name}, ID: ${device.id}`);

    // 移除默认的占位符（如果存在）
    const placeholderItem = this.bleDeviceList.querySelector('.ble-device-item:not([data-device-id])');
    if (placeholderItem) {
      placeholderItem.remove();
      console.log('[Bluetooth] 已移除占位符');
    }

    // 检查设备是否已在foundDevices数组中
    const existingDeviceIndex = this.foundDevices.findIndex(d => d.id === device.id);
    if (existingDeviceIndex >= 0) {
      console.log(`[Bluetooth] 设备已在foundDevices中，更新信息: ${device.name}`);
      // 更新设备信息
      this.foundDevices[existingDeviceIndex] = device;
      // 不需要更新UI，直接返回
      return;
    }

    // 检查设备是否已在DOM中
    const existingItem = this.bleDeviceList.querySelector(`[data-device-id="${device.id}"]`);
    if (existingItem) {
      console.log(`[Bluetooth] 设备已在DOM中，跳过添加: ${device.name}`);
      // 更新foundDevices数组
      this.foundDevices.push(device);
      return;
    }

    // 创建新的设备项
    const deviceItem = document.createElement('div');
    deviceItem.className = 'ble-device-item';
    deviceItem.setAttribute('data-device-id', device.id);

    deviceItem.innerHTML = `
      <div class="ble-device-content">
        <div class="ble-device-info">
          <div class="ble-device-name">${device.name || '未知设备'}</div>
        </div>
        <div class="ble-device-actions">
          <button class="ble-connect-action-btn" data-device-id="${device.id}">连接</button>
        </div>
      </div>
    `;

    // 添加连接按钮事件
    const connectBtn = deviceItem.querySelector('.ble-connect-action-btn');
    if (connectBtn) {
      connectBtn.addEventListener('click', () => {
        console.log(`🔗 连接BLE设备: ${device.name || device.id}`);
        this.connectToSelectedBluetoothDeviceDirect(device.id);
      });
    }

    this.bleDeviceList.appendChild(deviceItem);
    this.foundDevices.push(device);
  }

  /**
   * 更新蓝牙设备列表UI（扫描完成后）
   */
  updateBluetoothDeviceList(devices) {
    console.log('[Bluetooth] 更新设备列表，设备数量:', devices.length);

    if (!this.bleDeviceList) {
      console.error('[Bluetooth] bleDeviceList不存在，无法更新');
      return;
    }

    // 清空现有设备列表
    this.clearBluetoothDeviceList();
    console.log('[Bluetooth] 已清空设备列表');

    // 添加所有设备
    devices.forEach(device => {
      console.log(`[Bluetooth] 处理设备: ${device.name}`);
      this.addBluetoothDeviceToList(device);
    });

    console.log('[Bluetooth] 设备列表更新完成，最终子元素数量:', this.bleDeviceList.children.length);
  }

  /**
   * 更新蓝牙扫描按钮状态
   */
  updateBluetoothScanButtons(_isScanning) {
    // 按钮已移除，保持空实现以兼容旧调用
  }

  /**
   * 添加蓝牙日志
   */
  addBluetoothLog(message, type = 'info') {
    const logContainer = document.getElementById('bluetooth-log-container');
    if (logContainer) {
      const logEntry = document.createElement('div');
      logEntry.className = `bluetooth-log-entry ${type}`;
      logEntry.innerHTML = `<span class="timestamp">[${new Date().toLocaleTimeString()}]</span> ${message}`;
      logContainer.appendChild(logEntry);
      logContainer.scrollTop = logContainer.scrollHeight;
    }
  }

  /**
   * 清空蓝牙日志
   */
  clearBluetoothLogs() {
    const logContainer = document.getElementById('bluetooth-log-container');
    if (logContainer) {
      logContainer.innerHTML = '<div class="bluetooth-log-entry">蓝牙管理器已初始化</div>';
    }
  }

  /**
   * 清空蓝牙数据日志
   */
  clearBluetoothDataLogs() {
    const dataLogContainer = document.getElementById('bluetooth-data-log-container');
    if (dataLogContainer) {
      dataLogContainer.innerHTML = '<div class="bluetooth-log-entry info">等待主机连接...</div>';
    }
  }

  /**
   * 添加蓝牙数据日志
   */
  addBluetoothDataLog(message, type = 'info') {
    const dataLogContainer = document.getElementById('bluetooth-data-log-container');
    if (dataLogContainer) {
      const logEntry = document.createElement('div');
      logEntry.className = `bluetooth-log-entry ${type}`;
      logEntry.innerHTML = `<span class="timestamp">[${new Date().toLocaleTimeString()}]</span> ${message}`;
      dataLogContainer.appendChild(logEntry);
      dataLogContainer.scrollTop = dataLogContainer.scrollHeight;
    }
  }


  /**
   * 禁用BLE按钮
   */
  disableBLEButton(reason) {
    // 不再使用独立的按钮，现在使用状态标签
    this.updateBLEStatus({
      text: `📱 BLE: ${reason}`,
      class: 'disconnected'
    });
  }


  /**
   * 打开浏览器BLE页面
   */

  /**
   * 初始化BLE设备选择对话框
   */
  initBLEDeviceModal() {
    this.bleDeviceModal = document.getElementById('bluetooth-device-modal');
    this.bleDeviceList = document.getElementById('bluetooth-device-list');

    this.foundDevices = [];

    // 绑定设备列表点击事件（使用事件委托）
    if (this.bleDeviceList) {
      // 处理连接按钮点击
      this.bleDeviceList.addEventListener('click', (event) => {
        if (event.target.classList.contains('ble-connect-action-btn')) {
          event.stopPropagation();
          const deviceId = event.target.dataset.deviceId;
          console.log('🔗 点击连接按钮，设备ID:', deviceId);
          if (deviceId) {
            this.connectToSelectedBLEDeviceDirect(deviceId);
          }
        }
      });

      // 处理设备项悬停效果
      this.bleDeviceList.addEventListener('mouseenter', (event) => {
        const deviceItem = event.target.closest('.ble-device-item');
        if (deviceItem) {
          deviceItem.classList.add('active');
        }
      }, true);

      this.bleDeviceList.addEventListener('mouseleave', (event) => {
        const deviceItem = event.target.closest('.ble-device-item');
        if (deviceItem) {
          deviceItem.classList.remove('active');
        }
      }, true);
    }

    // 设置IPC监听器
    this.setupBLEIPCHandlers();

    console.log('✅ BLE设备选择对话框已初始化');
  }

  /**
   * 设置BLE IPC监听器
   */

  /**
   * 显示BLE设备管理对话框
   */
  showBLEDeviceModal() {
    if (!this.bleDeviceModal) return;

    console.log('📱 显示BLE设备管理对话框');

    // 根据连接状态显示不同界面
    if (this.bleConnected && this.connectedDevice) {
      // 连接状态：显示设备信息和管理界面
      this.showBLEConnectedModal();
    } else {
      // 未连接状态：显示扫描界面
      this.showBLEConnectModal();
    }

    // 显示对话框
    this.bleDeviceModal.classList.add('show');

    // 初始化对话框元素
    this.initializeBLEModalElements();

    // 添加日志
    this.addBLELog('BLE设备管理对话框已打开', 'info');
  }

  /**
   * 显示BLE连接界面（未连接状态）
   */
  showBLEConnectModal() {
    console.log('📱 显示BLE连接界面');

    // 重置对话框状态
    this.resetBLEModal();

    // 更新模态框标题
    const titleElement = document.getElementById('ble-modal-title');
    if (titleElement) {
      titleElement.textContent = this.bleTarget === 'slave' ? '🦶 从机BLE设备连接' : '🔵 主机BLE设备连接';
    }

    // 显示扫描相关的元素
    this.showBLEScanElements();
  }

  /**
   * 显示BLE设备管理界面（已连接状态）
   */
  showBLEConnectedModal() {
    console.log('📱 显示BLE设备管理界面');

    // 更新模态框标题
    const titleElement = document.getElementById('ble-modal-title');
    if (titleElement) {
      const name = this.bleTarget === 'slave'
        ? (this.slaveDevice?.name || '已连接从机')
        : (this.connectedDevice?.name || '已连接主机');
      titleElement.textContent = `🔗 BLE设备管理 - ${name}`;
    }

    // 显示已连接设备的信息
    this.showBLEConnectedElements();
  }

  /**
   * 显示BLE扫描相关元素
   */
  showBLEScanElements() {
    // 隐藏连接状态相关元素
    if (this.bleConnectedDeviceName) this.bleConnectedDeviceName.style.display = 'none';
    if (this.bleConnectionIndicator) this.bleConnectionIndicator.style.display = 'none';
    if (this.bleDisconnectBtn) this.bleDisconnectBtn.style.display = 'none';

    // 显示扫描相关元素
    if (this.bleScanSection) this.bleScanSection.style.display = 'block';
  }

  /**
   * 显示BLE连接状态相关元素
   */
  showBLEConnectedElements() {
    // 显示连接状态相关元素
    if (this.bleConnectedDeviceName) {
      this.bleConnectedDeviceName.textContent = this.connectedDevice.name || '未知设备';
      this.bleConnectedDeviceName.style.display = 'inline';
    }
    if (this.bleConnectionIndicator) {
      this.bleConnectionIndicator.className = 'ble-indicator connected';
      this.bleConnectionIndicator.style.display = 'inline';
    }
    if (this.bleDisconnectBtn) this.bleDisconnectBtn.style.display = 'inline';

    // 隐藏扫描相关元素
    if (this.bleScanSection) this.bleScanSection.style.display = 'none';

    // 清空设备列表
    this.foundDevices = [];
    this.updateBLEDeviceList();
  }

  /**
   * 隐藏BLE设备管理对话框
   */
  hideBLEDeviceModal() {
    if (!this.bleDeviceModal) return;

    console.log('📱 隐藏BT设备管理对话框');
    this.bleDeviceModal.classList.remove('show');

    // BT管理器自动管理连接，不需要手动停止扫描
  }

  /**
   * 设置BT IPC监听器
   */
  setupBLEIPCHandlers() {
    // 防止重复设置监听器
    if (this.bleIPCHandlersSetup) {
      return;
    }
    this.bleIPCHandlersSetup = true;

    const { ipcRenderer } = require('electron');

    // 监听BT连接成功
    ipcRenderer.on('bluetooth-connected', (event, data) => {
      const device = data?.device || data;
      console.log('🔗 BT连接成功:', device?.name || '未知设备');
      this.handleBLEConnectionChange(true, device);
      this.addBLELog(`已连接到: ${device?.name || 'HC-05'}`, 'success');
    });

    // 监听断开连接
    ipcRenderer.on('bluetooth-disconnected', (event) => {
      console.log('🔌 BT连接已断开');
      this.handleBLEConnectionChange(false, null);
      this.addBLELog('BT连接已断开', 'info');
    });

    // 监听BT数据接收
    ipcRenderer.on('bluetooth-data-received', (event, data) => {
      this.handleBLEData(data);
    });

    // 监听BT错误
    ipcRenderer.on('bluetooth-error', (event, error) => {
      console.error('❌ BT错误:', error);
      const message = error?.message || '未知错误';
      this.addBLELog(`BT错误: ${message}`, 'error');
    });

    console.log('✅ BT IPC监听器已设置');
  }

  /**
   * 初始化BLE对话框元素
   */
  initializeBLEModalElements() {
    // 防止重复初始化
    if (this.bleModalInitialized) {
      this.updateBLEConnectionStatus();
      return;
    }

    // 获取元素引用
    // 获取元素引用
    this.bleModalTitle = document.getElementById('ble-modal-title');
    this.bleModalClose = document.getElementById('ble-modal-close');
    this.bleConnectionStatus = document.getElementById('ble-connection-status');
    this.bleConnectedDeviceName = document.getElementById('ble-connected-device-name');
    this.bleConnectionIndicator = document.getElementById('ble-connection-indicator');
    this.bleDisconnectBtn = document.getElementById('ble-disconnect-btn');
    this.bleScanSection = document.getElementById('ble-scan-section');
    this.bleDeviceList = document.getElementById('bluetooth-device-list');
    this.bleLogContainer = document.getElementById('ble-log-container');
    this.bleClearLogBtn = document.getElementById('ble-clear-log-btn');
    this.bleDataLogContainer = document.getElementById('bluetooth-data-log-container');
    this.bleClearDataLogBtn = document.getElementById('ble-clear-data-log-btn');

    // 设置BT IPC监听器（在元素初始化后立即设置，避免竞态条件）
    this.setupBLEIPCHandlers();

    // BT管理器自动连接，不需要设备列表事件

    // 绑定其他事件（只绑定一次）
    if (this.bleModalClose && !this.bleModalClose.hasBoundEvents) {
      this.bleModalClose.addEventListener('click', () => this.hideBLEDeviceModal());
      this.bleModalClose.hasBoundEvents = true;
    }
    if (this.bleDisconnectBtn && !this.bleDisconnectBtn.hasBoundEvents) {
      this.bleDisconnectBtn.addEventListener('click', () => this.disconnectBLE());
      this.bleDisconnectBtn.hasBoundEvents = true;
    }
    if (this.bleClearLogBtn && !this.bleClearLogBtn.hasBoundEvents) {
      this.bleClearLogBtn.addEventListener('click', () => this.clearBLELog());
      this.bleClearLogBtn.hasBoundEvents = true;
    }
    if (this.bleClearDataLogBtn && !this.bleClearDataLogBtn.hasBoundEvents) {
      this.bleClearDataLogBtn.addEventListener('click', () => this.clearBLEDataLog());
      this.bleClearDataLogBtn.hasBoundEvents = true;
    }

    // 标记为已初始化
    this.bleModalInitialized = true;

    // 更新连接状态显示
    this.updateBLEConnectionStatus();
  }

  /**
   * 绑定BLE设备列表事件监听器
   */
  bindBLEDeviceListEvents() {
    // BT管理器自动连接，不需要设备列表事件监听器
    // 此方法保留以兼容现有代码，但不执行任何操作
  }

  /**
   * 重置BLE对话框状态
   */
  resetBLEModal() {
    this.foundDevices = [];
    this.updateBLEDeviceList();
    this.clearBLELog();
  }

  /**
   * 开始BLE扫描
   */
  // BT管理器自动连接，不需要手动扫描方法

  /**
   * 刷新BLE扫描（停止当前扫描并重新开始）
   */

  /**
   * 断开BT连接
   */
  disconnectBLE() {
    console.log('🔌 断开BT连接');
    const { ipcRenderer } = require('electron');
    ipcRenderer.send('bt-disconnect');
    this.addBLELog('正在断开BT连接...', 'info');
  }

  /**
   * 更新BLE适配器状态
   */
  updateBLEAdapterState(state) {
    this.bleAdapterState = state;
    // 无论蓝牙状态如何，都显示"未连接"状态（因为还没有建立BLE连接）
    this.updateBLEStatus({
      text: '📱 BLE: 未连接',
      class: 'disconnected'
    });
  }

  /**
   * 更新主页BLE状态显示
   */
  updateBLEStatus(status) {
    const statusElement = document.getElementById('bluetooth-status');
    if (statusElement) {
      statusElement.textContent = status.text;
      statusElement.className = 'bluetooth-status';
      if (status.class) {
        statusElement.classList.add(status.class);
      }
      if (status.clickable) {
        statusElement.classList.add('bluetooth-clickable');
      }
    }
  }

  /**
   * 更新BLE连接状态显示
   */
  updateBLEConnectionStatus() {
    if (!this.bleConnectionStatus || !this.bleConnectedDeviceName) return;

    if (this.bleConnected) {
      this.bleConnectionStatus.style.display = 'flex';
      this.bleScanSection.style.display = 'none';
      this.bleConnectedDeviceName.textContent = this.connectedDevice?.name || 'SEBT设备';
      this.bleConnectionIndicator.className = 'ble-indicator connected';
      this.bleModalTitle.textContent = '🔗 BLE设备管理 (已连接)';
    } else {
      this.bleConnectionStatus.style.display = 'none';
      this.bleScanSection.style.display = 'block';
      this.bleModalTitle.textContent = '🔵 BLE设备管理';
    }
  }


  /**
   * 添加BLE数据日志
   */
  addBLEDataLog(message, type = 'info') {
    if (!this.bleDataLogContainer) return;

    const logEntry = document.createElement('div');
    logEntry.className = `ble-log-entry ${type}`;
    logEntry.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;

    this.bleDataLogContainer.appendChild(logEntry);
    this.bleDataLogContainer.scrollTop = this.bleDataLogContainer.scrollHeight;
  }

  /**
   * 清空BLE数据日志
   */
  /**
   * 添加BLE日志
   */
  addBLELog(message, type = 'info') {
    if (!this.bleLogContainer) return;

    const logEntry = document.createElement('div');
    logEntry.className = `ble-log-entry ${type}`;
    logEntry.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;

    this.bleLogContainer.appendChild(logEntry);

    // 限制日志数量
    const entries = this.bleLogContainer.children;
    if (entries.length > 20) {
      this.bleLogContainer.removeChild(entries[0]);
    }

    // 自动滚动到底部
    this.bleLogContainer.scrollTop = this.bleLogContainer.scrollHeight;
  }


  /**
   * 清空BLE日志
   */
  clearBLELog() {
    if (this.bleLogContainer) {
      this.bleLogContainer.innerHTML = '';
    }
  }

  clearBLEDataLog() {
    if (this.bleDataLogContainer) {
      this.bleDataLogContainer.innerHTML = '<div class="ble-log-entry info">等待主机连接...</div>';
    }
  }

  /**
   * 完全清除BLE数据日志（用于连接成功时）
   */
  clearBLEDataLogCompletely() {
    if (this.bleDataLogContainer) {
      this.bleDataLogContainer.innerHTML = '';
    }
  }


  /**
   * 添加发现的BLE设备到列表
   */
  addBLEDeviceToList(device) {
    // 检查是否已存在
    const existingIndex = this.foundDevices.findIndex(d => d.id === device.id || d.address === device.address);
    if (existingIndex === -1) {
      this.foundDevices.push(device);
      console.log(`📱 添加BLE设备到列表: ${device.name} (${device.address})`);
    } else {
      // 更新现有设备信息
      this.foundDevices[existingIndex] = device;
    }

    this.updateBLEDeviceList();
  }

  /**
   * 更新BLE设备列表显示（BT模式下不再需要设备列表）
   */
  updateBLEDeviceList(scanningMessage = null) {
    // BT管理器自动连接，不需要显示设备列表
    // 此方法保留以兼容现有代码，但不执行任何操作
  }

  /**
   * 直接连接BLE设备（点击连接按钮）
   */
  connectToSelectedBLEDeviceDirect(deviceId) {
    console.log('🔗 广播模式：标记BLE设备为已连接:', deviceId);

    // 检查是否已经连接，避免重复连接
    if (this.bleConnected) {
      console.log('⚠️ BLE已经连接，无需重复连接');
      this.addBLELog('BLE设备已连接，无需重复连接', 'warning');
      return;
    }

    // 在广播模式下，不需要实际连接BLE设备
    // 只需要标记为已连接状态，并开始监听广播数据
    const device = this.foundDevices.find(d => d.address === deviceId || d.id === deviceId);
    if (!device) {
      console.error('❌ 未找到要连接的设备:', deviceId);
      this.addBLELog('未找到要连接的设备', 'error');
      return;
    }

    // 标记为已连接状态
    this.bleConnected = true;
    this.bleConnectedDevice = device;

    this.addBLELog(`已连接到 ${device.name}，等待广播数据...`, 'success');

    // 隐藏对话框，显示连接状态
    this.hideBLEDeviceModal();
    this.updateBLEStatus({ text: `📱 BLE: 已连接 ${device.name}`, class: 'connected' });

    // 更新连接状态显示
    this.updateBLEConnectionStatus();

    console.log('✅ 广播模式连接完成，等待接收广播数据');

    // 注意：广播模式下不需要发送IPC消息到主进程
    // 主进程会在设备发现时自动处理数据接收
  }


  /**
   * 处理BLE连接状态变化
   */
  handleBLEConnectionChange(connected, device) {
    const name = device?.name || '';
    const upper = name.toUpperCase();
    const role = upper.includes('SLAVE') || upper.includes('FSR') ? 'slave' : 'host';

    if (role === 'slave') {
      this.slaveDeviceConnected = connected;
      this.slaveDevice = connected ? device : null;
      this.updateSlaveBLEStatus({
        text: connected ? `🦶 从机BLE: 已连接 (${device?.name || 'SEBT-Slave'})` : '🦶 从机BLE: 未连接',
        class: connected ? 'connected' : 'disconnected'
      });
    } else {
      this.bleConnected = connected;
      this.connectedDevice = connected ? device : null;
      this.updateBluetoothStatus({
        text: connected ? `📱 主机BLE: 已连接 (${device?.name || 'SEBT-Host'})` : '📱 主机BLE: 未连接',
        class: connected ? 'connected' : 'disconnected'
      });
    }

    if (connected) {
      // 连接成功时清除所有日志并添加连接成功消息
      this.clearBLEDataLogCompletely();
      this.addBLEDataLog(`已连接到 ${device?.name || 'SEBT-Host-001'}，等待数据...`, 'success');
    } else {
      this.cancelBLEMeasurementCollection();
      this.addBLEDataLog('连接已断开，BT管理器将自动重连...', 'warning');
      // BT管理器会自动重连，不需要手动操作
    }

    this.updateBLEConnectionStatus();
  }

  /**
   * 处理BLE设备发现
   */
  // BT管理器自动连接，不需要设备发现和手动连接方法

  /**
   * 处理BLE数据接收
   */
  handleBLEData(data) {
    try {
      if (data.type === 'scan_data') {
        const payload = JSON.parse(data.data);
        if (payload.source === 'host') {
          this.handleHostBroadcast(payload);
          return;
        }
        if (payload.source === 'slave') {
          this.addBLEDataLog(`从机压力: ${payload.pressure} (raw=${payload.pressureRaw || 0})`, 'info');
          return;
        }
        // 兼容旧格式
        this.handleBLERealtimeData(payload);
        return;
      }
      if (data.type === 'lock_data') {
        const lockData = JSON.parse(data.data);
        this.handleBLELockData(lockData);
      }
    } catch (error) {
      console.error('❌ 处理BLE数据失败:', error, data);
    }
  }

  /**
   * 处理BLE实时扫描数据
   */
  handleBLERealtimeData(data) {
    // 更新主页8方向数据显示
    if (data.distances && Array.isArray(data.distances)) {
      console.log(`📊 BLE数据: 收到${data.distances.length}个方向数据，最小方向${data.currentMinDirection}:${data.currentMinDistance}mm`);

      data.distances.forEach(([direction, distance]) => {
        // 创建传感器数据对象
        const sensorData = {
          distance: distance,
          direction: direction,
          timestamp: data.timestamp || Date.now(),
          active: true,
          source: 'ble',
          isMinDistance: data.currentMinDirection === direction
        };

        this.sensorData.set(direction, sensorData);

        // 更新UI显示
        this.updateRealtimeSensorDisplay(direction, sensorData, sensorData.isMinDistance);
      });

      // 高亮最小距离方向
      this.highlightClosestDirection();

      // 更新BLE数据日志
      this.addBLEDataLog(`方向${data.currentMinDirection}: ${data.currentMinDistance}mm`, 'info');
    }

    // 处理方向锁定状态
    if (data.lockedDirection !== undefined && data.lockedDirection !== this.lockedDirection) {
      this.lockedDirection = data.lockedDirection;
      if (data.lockedDirection >= 0) {
        this.addBLELog(`🎯 方向已锁定: ${data.lockedDirection}`, 'success');
        this.addBLEDataLog(`方向锁定成功: ${data.lockedDirection} (${data.currentMinDistance}mm)`, 'success');
      } else {
        this.addBLELog('🔓 方向已解锁', 'info');
        this.addBLEDataLog('方向解锁', 'info');
      }
    }
  }

  /**
   * 处理主机广播的8方向数据
   * @param {Object} payload
   */
  handleHostBroadcast(payload) {
    const timestamp = payload.timestamp || Date.now();
    const distancesArray = new Array(8).fill(this.INVALID_DISTANCE);

    if (Array.isArray(payload.distances)) {
      payload.distances.forEach(([dir, dist]) => {
        if (typeof dir === 'number' && dir >= 0 && dir < 8 && typeof dist === 'number') {
          // 将无效值（2000）转换为invalid标记
          const processedDist = (dist === this.MAX_VALID_DISTANCE || !this.isValidDistance(dist)) 
            ? this.INVALID_DISTANCE 
            : dist;
          distancesArray[dir] = processedDist;
          this.updateSensorData(dir, processedDist, 'hardware');
          const sensorData = this.sensorData.get(dir);
          if (sensorData) {
            sensorData.timestamp = timestamp;
            this.updateSensorDisplay(dir, sensorData);
          }
        }
      });
    }

    // 高亮最近方向
    this.highlightClosestDirection(distancesArray);

    // 计算最小方向
    let minDir = payload.currentMinDirection;
    let minDist = payload.currentMinDistance;
    if (minDir === undefined || minDir === -1) {
      let calcMin = Infinity;
      let calcDir = -1;
      distancesArray.forEach((d, idx) => {
        if (this.isValidDistance(d) && d < calcMin) {
          calcMin = d;
          calcDir = idx;
        }
      });
      minDir = calcDir;
      minDist = calcMin;
    }

    // 检查并执行自动锁定（基于连续次数）
    if (minDir >= 0 && this.isValidDistance(minDist)) {
      this.checkAutoLock(minDir, minDist);
    }

    // 记录主机数据日志
    this.addBLEDataLog(
      `主机广播: 方向${minDir} 距离 ${minDist}mm`,
      'success'
    );
  }

  /**
   * 处理BLE诊断结果
   */
  handleBLEDiagnosis(diagnosis) {
    console.log('🔍 处理BLE诊断结果:', diagnosis);

    try {
      let logMessage = 'BLE诊断结果:\n';

      // 防御性编程：确保所有属性都存在
      const safeDiagnosis = {
        implementation: diagnosis.implementation || 'unknown',
        nobleLoaded: diagnosis.nobleLoaded !== undefined ? diagnosis.nobleLoaded : false,
        nobleScanning: diagnosis.nobleScanning !== undefined ? diagnosis.nobleScanning : false,
        discoveredDevicesCount: diagnosis.discoveredDevicesCount || 0,
        connectedPeripheral: diagnosis.connectedPeripheral || false,
        bleStatusAvailable: diagnosis.bleStatusAvailable !== undefined ? diagnosis.bleStatusAvailable : false,
        bleStatus: diagnosis.bleStatus || null,
        platform: diagnosis.platform || 'unknown',
        arch: diagnosis.arch || 'unknown',
        error: diagnosis.error || null
      };

      // 根据实现方式显示不同的信息
      if (safeDiagnosis.implementation === 'powershell') {
        logMessage += `- BLE实现方式: PowerShell脚本 ✅\n`;
        logMessage += `- 脚本状态: ${safeDiagnosis.nobleLoaded ? '✅' : '❌'}\n`;
        logMessage += `- BLE硬件状态: ${safeDiagnosis.bleStatusAvailable ? '✅' : '❌'}\n`;
        if (safeDiagnosis.bleStatus) {
          logMessage += `- 蓝牙适配器: ${safeDiagnosis.bleStatus.adapterCount || 0} 个\n`;
          logMessage += `- 蓝牙可用: ${safeDiagnosis.bleStatus.bluetoothAvailable ? '✅' : '❌'}\n`;
        }
      } else if (safeDiagnosis.implementation === 'noble-direct') {
        logMessage += `- BLE实现方式: @stoprocent/noble 直接调用 ✅\n`;
        logMessage += `- noble库加载: ${safeDiagnosis.nobleLoaded ? '✅' : '❌'}\n`;
        logMessage += `- BLE适配器状态: ${safeDiagnosis.bleStatus || 'unknown'}\n`;
        if (safeDiagnosis.libraryVersion) {
          logMessage += `- noble版本: ${safeDiagnosis.libraryVersion}\n`;
        }
      } else {
        logMessage += `- BLE库加载: ${safeDiagnosis.nobleLoaded ? '✅' : '❌'}\n`;
        logMessage += `- BLE状态: ${diagnosis.nobleState || 'unknown'}\n`;
      }

      logMessage += `- 正在扫描: ${safeDiagnosis.nobleScanning}\n`;
      logMessage += `- 已发现设备: ${safeDiagnosis.discoveredDevicesCount}\n`;
      logMessage += `- 已连接设备: ${safeDiagnosis.connectedPeripheral ? '✅' : '❌'}\n`;
      logMessage += `- 平台: ${safeDiagnosis.platform} ${safeDiagnosis.arch}\n`;

      if (safeDiagnosis.error) {
        logMessage += `- 错误: ${safeDiagnosis.error}\n`;
      }

      this.addBLELog(logMessage, safeDiagnosis.nobleLoaded ? 'success' : 'error');

      // 根据实现方式检查状态
      if (safeDiagnosis.implementation === 'powershell') {
        if (!safeDiagnosis.nobleLoaded) {
          this.addBLELog('❌ PowerShell脚本状态异常', 'error');
        } else if (!safeDiagnosis.bleStatusAvailable) {
          this.addBLELog('⚠️ 无法检查BLE硬件状态，请确保蓝牙已启用', 'warning');
        } else {
          this.addBLELog('✅ BLE PowerShell实现正常', 'success');
        }
      } else if (safeDiagnosis.implementation === 'noble-direct') {
        // @stoprocent/noble 直接调用实现
        if (!safeDiagnosis.nobleLoaded) {
          this.addBLELog('❌ @stoprocent/noble库未正确加载', 'error');
          alert('BLE库加载失败！\n\n请尝试重新安装依赖：\nnpm install @stoprocent/noble\n然后重启应用');
        } else if (safeDiagnosis.bleStatus !== 'poweredOn') {
          this.addBLELog(`⚠️ BLE适配器状态: ${safeDiagnosis.bleStatus}，请确保蓝牙已启用`, 'warning');
        } else {
          this.addBLELog('✅ BLE @stoprocent/noble实现正常', 'success');
        }
      } else {
        // 传统BLE库检查
        if (!safeDiagnosis.nobleLoaded) {
          this.addBLELog('❌ BLE库未正确加载，请检查依赖安装', 'error');
          alert('BLE库加载失败！\n\n请尝试重新安装依赖：\n1. 删除 node_modules\n2. 运行 npm install\n3. 重启应用');
        }
      }
    } catch (error) {
      console.error('❌ 处理BLE诊断结果时出错:', error);
      this.addBLELog(`处理诊断结果失败: ${error.message}`, 'error');
    }
  }

  /**
   * 处理BLE错误
   */
  handleBLEError(error) {
    console.error('❌ BLE错误:', error);

    // 防御性编程：确保error是一个对象
    const safeError = typeof error === 'object' && error !== null ? error : { message: String(error) };

    // 显示错误状态（简化为未连接状态）
    this.updateBLEStatus({
      text: '📱 BLE: 未连接',
      class: 'disconnected'
    });

    // 显示错误提示
    setTimeout(() => {
      alert(`BLE错误: ${safeError.message || '未知错误'}\n\n请检查ESP32是否正常运行。`);
    }, 500);
  }

  /**
   * 检查BLE状态
   */





  /**
   * 处理BLE断开连接
   */
  handleBLEDisconnect() {
    console.log('📱 BLE连接已断开');

    // 更新状态
    this.bleConnected = false;
    this.deviceConnected = false; // 同步设备连接状态
    this.bleDevice = null;
    this.bleServer = null;
    this.scanCharacteristic = null;
    this.lockCharacteristic = null;
    this.commandCharacteristic = null;

    // 更新UI状态 - 断开连接后可以重新点击连接
    this.updateBLEStatus({
      text: '📱 BLE: 未连接',
      class: 'disconnected'
    });
  }

  /**
   * 发送BLE命令
   */
  async sendBLECommand(command) {
    if (!this.bleConnected) {
      console.warn('⚠️ BLE未连接，无法发送命令');
      return false;
    }

    try {
      console.log('📤 发送BLE命令:', command);

      // 通过IPC发送命令到主进程
      const { ipcRenderer } = require('electron');
      const result = await new Promise((resolve) => {
        ipcRenderer.once('ble-command-sent', (event, result) => {
          resolve(result);
        });
        ipcRenderer.once('ble-error', (event, error) => {
          resolve({ success: false, error: error.message });
        });
        ipcRenderer.send('ble-send-command', command);
      });

      if (result.success) {
        console.log('📤 BLE命令发送成功:', command);
        return true;
      } else {
        console.error('❌ BLE命令发送失败:', result.error);
        return false;
      }

    } catch (error) {
      console.error('❌ BLE命令发送异常:', error);
      return false;
    }
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
   * 检查并执行自动锁定（基于连续次数）
   */
  checkAutoLock(currentMinDirection, currentMinDistance) {
    // 如果锁定功能未开启，不执行锁定检查
    if (!this.lockFeatureEnabled) {
      return;
    }

    // 检查方向是否改变
    if (this.currentMinDirection !== currentMinDirection) {
      // 方向改变，重置连续计数
      this.currentMinDirection = currentMinDirection;
      this.minDirectionConsecutiveCount = 1;
      this.minDirectionStartTime = Date.now();
      console.log(`🔄 最短方向改变为: ${directionMap[currentMinDirection].displayName}，开始计数`);
      return;
    }

    // 检查是否已经锁定或已完成
    if (this.lockedDirections.has(currentMinDirection) || this.completedDirections.has(currentMinDirection)) {
      return;
    }

    // 增加连续计数
    this.minDirectionConsecutiveCount++;

    // 检查是否达到锁定所需的连续次数
    if (this.minDirectionConsecutiveCount >= this.LOCK_REQUIRED_COUNT) {
      // 自动锁定
      this.lockDirection(currentMinDirection, currentMinDistance);
      const duration = Date.now() - this.minDirectionStartTime;
      console.log(`🔒 前端自动锁定: ${directionMap[currentMinDirection].displayName} - ${currentMinDistance}mm (连续${this.minDirectionConsecutiveCount}次，持续${duration}ms)`);
      this.addLog(`🔒 前端自动锁定: ${directionMap[currentMinDirection].displayName} - ${currentMinDistance}mm`, 'success');
      this.minDirectionConsecutiveCount = 0; // 重置计数
    } else {
      const progress = (this.minDirectionConsecutiveCount / this.LOCK_REQUIRED_COUNT * 100).toFixed(0);
      console.log(`⏱️ 方向锁定进度: ${directionMap[currentMinDirection].displayName} (${this.minDirectionConsecutiveCount}/${this.LOCK_REQUIRED_COUNT}次, ${progress}%)`);
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
    let closestDistance = Infinity;

    for (let channel = 0; channel < 8; channel++) {
      // 只考虑未完成测距的方向
      if (!this.completedDirections.has(channel)) {
        const distance = distances[channel];
        if (this.isValidDistance(distance) && distance < closestDistance) {
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
    this.minDirectionConsecutiveCount = 0;

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
