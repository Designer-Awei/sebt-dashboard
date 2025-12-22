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
    this.bleDriverOpened = false; // BLE驱动页面是否已打开
    this.slaveBleDriverOpened = false; // 从机BLE驱动页面是否已打开
    this.lastClosestDirection = -1; // 上一次绿色实时高亮的方向

    // 自动锁定相关变量
    this.currentMinDirection = -1; // 当前连续最短的方向
    this.minDirectionStartTime = 0; // 当前最短方向开始的时间
    this.minDirectionConsecutiveCount = 0; // 当前最短方向连续出现的次数
    this.lockFeatureEnabled = false; // 锁定功能开关（默认关闭）
    this.experimentRunning = false; // 实验运行状态（默认未运行）
    this.experimentStartTime = 0; // 实验开始时间
    this.experimentTimer = null;
    
    // 实验记录相关变量
    this.measurementResults = new Map(); // 存储8方向的测距结果 {channel: distance}
    this.measurementTableUpdateTimer = null; // 测距数据表格更新定时器
    this.lastTableUpdateValues = new Map(); // 上次表格更新的值，用于减少重复日志
    this.tableUpdateLogCount = 0; // 表格更新日志计数，用于控制日志频率

    // 从机参数设置相关变量
    this.stableRequiredCount = 10; // 稳定时长连续次数（默认10次）
    this.pressureMinThreshold = 500; // 压力最小阈值
    this.pressureMaxThreshold = 3000; // 压力最大阈值
    this.pressureSliderInitialized = false; // 双滑块是否已初始化

    this.initializeApp();
    this.setupEventListeners();
    this.setupGlobalClickListener();
    this.setupIPCListeners();
    this.updateMockDataButtonState(); // 初始化模拟按钮状态
    this.updateBluetoothStatus({ connected: false, class: 'disconnected' });
    this.updateSlaveBLEStatus({ connected: false, class: 'disconnected' });

    // 重置BLE驱动页面状态
    this.bleDriverOpened = false;
    this.slaveBleDriverOpened = false;

    // 记录应用启动事件
    this.addLog('🚀 SEBT平衡测试系统启动', 'success');
    
    // 初始化锁定时长显示（延迟执行，确保DOM已加载）
    setTimeout(() => {
      this.updateLockTimeDisplay();
      this.initializeSlaveParameterSettings();
    }, 100);
  }

  /**
   * 打开BLE驱动页面（主机）
   */
  openBLEDriverPage() {
    // 检查是否已经打开过BLE驱动页面
    if (this.bleDriverOpened) {
      console.log('ℹ️ BLE驱动页面已打开，跳过重复打开');
      // 可以选择重新聚焦已打开的页面，但这里暂时不实现
      return;
    }

    const url = 'http://localhost:3000';
    console.log(`🌐 打开BLE驱动页面: ${url}`);

    // 使用Electron的shell模块打开外部浏览器
    if (window.require) {
      const { shell } = window.require('electron');
      shell.openExternal(url);
      this.bleDriverOpened = true;
    } else {
      // 备用方案：使用window.open
      window.open(url, '_blank');
      this.bleDriverOpened = true;
    }
  }

  /**
   * 打开从机BLE驱动页面
   */
  openSlaveBLEDriverPage() {
    // 检查是否已经打开过从机BLE驱动页面
    if (this.slaveBleDriverOpened) {
      console.log('ℹ️ 从机BLE驱动页面已打开，跳过重复打开');
      return;
    }

    const url = 'http://localhost:3000/slave-ble-driver.html';
    console.log(`🌐 打开从机BLE驱动页面: ${url}`);

    // 使用Electron的shell模块打开外部浏览器
    if (window.require) {
      const { shell } = window.require('electron');
      shell.openExternal(url);
      this.slaveBleDriverOpened = true;
    } else {
      // 备用方案：使用window.open
      window.open(url, '_blank');
      this.slaveBleDriverOpened = true;
    }
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
  /**
   * 点击方向卡片（已简化：现在锁定后直接显示测距按钮，不需要先选择卡片）
   * 如果方向已锁定且按钮已显示，直接触发测距
   */
  onDirectionCardClick(channel, direction) {
    // 如果方向已锁定，直接触发测距（兼容旧逻辑）
    if (this.lockedDirections.has(channel) && !this.completedDirections.has(channel)) {
    const measureBtn = document.getElementById(`measure-${direction.code}`);
      if (measureBtn && measureBtn.style.display !== 'none') {
        // 如果按钮已显示，直接触发测距
        this.performManualMeasurement(channel, direction);
    }
    }
    // 其他情况不做任何操作（锁定后按钮已自动显示，不需要选择卡片）
  }

  /**
   * 执行手动测距
   */
  performManualMeasurement(channel, direction) {
    console.log(`🎯 执行手动测距: ${direction.displayName} (通道: ${channel})`);

    // 立即更新UI显示"计算中"状态（在开始收集数据之前）
    const gridElement = this.gridElements.get(channel);
    if (gridElement) {
      const distanceElement = gridElement.querySelector('.distance-display');
      if (distanceElement) {
        distanceElement.textContent = '计算中...';
        distanceElement.style.color = '#f59e0b'; // 橙色表示计算中
      }
    }

    // 不记录开始测距日志，避免日志冗余

    // 设置标志，表示正在等待手动测距结果
    this.waitingForManualResult = { channel, direction };

    // 隐藏测距按钮，显示正在测距
    const measureBtn = document.getElementById(`measure-${direction.code}`);
    if (measureBtn) {
      measureBtn.textContent = '测距中...';
      measureBtn.disabled = true;
    }

    // 检查蓝牙连接状态
    if (this.bleConnected) {
      // 蓝牙连接模式：收集最近3次对应方向的距离数据并计算平均值
      console.log('📊 蓝牙测距模式 - 收集最近3次距离数据计算平均值');

      // 开始收集距离数据（此时UI已经显示"计算中"）
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

    // 添加日志（统一为"测距完成"，不区分手动/自动）
    this.addLog(`📐 测距完成: ${direction.displayName} - ${distance}mm`, 'success');
  }

  /**
   * 锁定指定方向（等待手动测距）
   */
  lockDirection(channel, distance) {
    if (this.lockedDirections.has(channel) || this.completedDirections.has(channel)) {
      return; // 已经锁定或完成
    }

    // 保证同一时间只有一个锁定方向：清理已有锁定
    if (this.lockedDirections.size > 0) {
      this.lockedDirections.forEach((lockedCh) => {
        const lockedEl = this.gridElements.get(lockedCh);
        if (lockedEl) {
          lockedEl.classList.remove('locked', 'min-distance', 'active');
          const distEl = lockedEl.querySelector('.distance-display');
          if (distEl) distEl.style.color = '#3b82f6';
          const measureBtn = lockedEl.querySelector('.manual-measure-btn');
          if (measureBtn) measureBtn.style.display = 'none';
        }
      });
      this.lockedDirections.clear();
    }

    // 添加到锁定集合
    this.lockedDirections.add(channel);
    // 锁定后重置最近实时高亮记录，避免绿色残留
    this.lastClosestDirection = -1;

    // 立即清除所有绿色高亮（包括当前要锁定的方向），防止绿色高亮残留
    this.gridElements.forEach((element) => {
      element.classList.remove('min-distance');
      const distanceElement = element.querySelector('.distance-display');
      if (distanceElement && !element.classList.contains('locked') && !element.classList.contains('completed')) {
        distanceElement.style.color = '#3b82f6';
      }
    });

    // 立即更新UI显示锁定状态（蓝色高亮，表示等待测距）- 同步执行，确保即时显示
    const gridElement = this.gridElements.get(channel);
    if (gridElement) {
      // 强制移除所有可能的高亮类，确保不会显示绿色
      gridElement.classList.remove('active', 'min-distance');
      gridElement.classList.add('locked');

      // 更新距离显示
      const distanceElement = gridElement.querySelector('.distance-display');
      if (distanceElement) {
        distanceElement.textContent = `${distance} mm`;
        // 强制设置为蓝色，确保不会被后续的highlightClosestDirection覆盖
        distanceElement.style.color = '#3b82f6';
        distanceElement.style.setProperty('color', '#3b82f6', 'important'); // 使用important确保优先级
      }

      // 显示手动测距按钮（因为这是锁定的方向）
      const measureBtn = gridElement.querySelector('.manual-measure-btn');
      if (measureBtn) {
        measureBtn.textContent = '开始测距';
        measureBtn.style.display = 'block';
        measureBtn.style.visibility = 'visible';
        measureBtn.disabled = false;
        
        // 直接绑定点击事件，确保点击一次即可测距
        const direction = directionMap[channel];
        measureBtn.onclick = (e) => {
          e.stopPropagation(); // 防止触发卡片点击事件
          e.preventDefault(); // 防止默认行为
          this.performManualMeasurement(channel, direction);
        };
        
        console.log(`✅ 测距按钮已显示: ${direction.displayName} (通道: ${channel})`);
      } else {
        console.warn(`⚠️ 未找到测距按钮元素: ${directionMap[channel].displayName} (通道: ${channel})`);
      }
    }

    console.log(`🔒 方向已锁定，等待手动测距: ${directionMap[channel].displayName}`);

    // 记录锁定事件（只显示方向，不显示距离）
    this.addLog(`🔒 锁定方向: ${directionMap[channel].displayName}`, 'info');

    // 如果AutoRun开启，自动触发测距
    if (this.lockFeatureEnabled && this.experimentRunning) {
      const direction = directionMap[channel];
      console.log(`🤖 AutoRun已开启，自动触发测距: ${direction.displayName}`);
      // 延迟一小段时间后自动触发测距，给用户视觉反馈
      setTimeout(() => {
        this.performManualMeasurement(channel, direction);
      }, 500);
    }

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

      // 更新距离显示（固定读数，不再更新）
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

      // 添加重置按钮（右上角刷新按钮）
      let resetBtn = gridElement.querySelector('.reset-direction-btn');
      if (!resetBtn) {
        resetBtn = document.createElement('button');
        resetBtn.className = 'reset-direction-btn';
        resetBtn.title = '重测此方向';
        // 使用SVG图标
        const iconImg = document.createElement('img');
        iconImg.src = 'public/refresh-ccw.svg';
        iconImg.alt = '重测此方向';
        iconImg.className = 'reset-icon';
        resetBtn.appendChild(iconImg);
        resetBtn.onclick = (e) => {
          e.stopPropagation();
          this.resetCompletedDirection(channel);
        };
        gridElement.appendChild(resetBtn);
      }
      resetBtn.style.display = 'flex';
    }

    // 存储测距结果到measurementResults（这是测距结果的可靠来源）
    this.measurementResults.set(channel, distance);
    
    // 更新传感器数据，标记为已完成（防止后续数据更新）
    // 确保sensorData存在，如果不存在则创建它
    let sensorData = this.sensorData.get(channel);
    if (!sensorData) {
      // 如果sensorData不存在，创建它
      const direction = directionMap[channel];
      if (direction) {
        sensorData = {
          channel,
          code: direction.code,
          name: direction.name,
          displayName: direction.displayName,
          distance: distance,
          timestamp: Date.now(),
          active: false,
          completed: true,
          source: 'measurement'
        };
        this.sensorData.set(channel, sensorData);
      }
    } else {
      // 更新sensorData的distance和completed标记
      sensorData.distance = distance;
      sensorData.completed = true;
    }

    console.log(`✅ 方向测距完成: ${directionMap[channel].displayName} = ${distance}mm`);

    // 更新按钮状态
    this.updateMockDataButtonState();

    // 检查是否所有方向都已完成
    this.checkExperimentCompletion();

    // 测距完成后，重新高亮最近方向（排除已完成的方向）
    // 需要获取当前距离数组，排除已完成的方向
    const distancesArray = new Array(8).fill(this.INVALID_DISTANCE);
    this.sensorData.forEach((data, ch) => {
      // 只包含未完成测距的方向的数据
      if (data && data.distance !== undefined && !this.completedDirections.has(ch)) {
        distancesArray[ch] = data.distance;
      }
    });
    // 只有在没有锁定方向时才进行绿色高亮
    if (this.lockedDirections.size === 0) {
      this.highlightClosestDirection(distancesArray);
    }
  }

  /**
   * 重置已完成的方向（恢复为初始状态）
   */
  resetCompletedDirection(channel) {
    if (!this.completedDirections.has(channel)) {
      return; // 未完成，无需重置
    }

    const direction = directionMap[channel];
    console.log(`🔄 重置已完成方向: ${direction.displayName}`);

    // 从完成状态移除
    this.completedDirections.delete(channel);

    // 更新传感器数据，清除完成标记
    const sensorData = this.sensorData.get(channel);
    if (sensorData) {
      sensorData.completed = false;
      // 保留距离值，但允许后续更新
    }

    // 更新UI显示，恢复为普通状态
    const gridElement = this.gridElements.get(channel);
    if (gridElement) {
      // 移除完成状态样式
      gridElement.classList.remove('completed');

      // 隐藏重置按钮
      const resetBtn = gridElement.querySelector('.reset-direction-btn');
      if (resetBtn) {
        resetBtn.style.display = 'none';
      }

      // 恢复距离显示为实时更新状态
      const distanceElement = gridElement.querySelector('.distance-display');
      if (distanceElement) {
        // 如果有保存的距离值，显示它；否则显示默认值
        if (sensorData && sensorData.distance !== undefined) {
          const displayText = (typeof sensorData.distance === 'number' && isFinite(sensorData.distance))
            ? this.formatDistance(sensorData.distance)
            : '--';
          distanceElement.textContent = displayText;
        } else {
          distanceElement.textContent = '--- mm';
        }
        distanceElement.style.color = '#3b82f6'; // 恢复默认蓝色
      }
    }

    // 更新按钮状态
    this.updateMockDataButtonState();

    // 重新高亮最近方向（现在这个方向可以参与高亮计算了）
    const distancesArray = new Array(8).fill(Infinity);
    this.sensorData.forEach((data, ch) => {
      if (data && data.distance !== undefined && !this.completedDirections.has(ch)) {
        distancesArray[ch] = data.distance;
      }
    });
    if (this.lockedDirections.size === 0) {
      this.highlightClosestDirection(distancesArray);
    }

    // 记录日志
    this.addLog(`🔄 已重置方向: ${direction.displayName}，可重新测距`, 'info');
  }

  /**
   * 检查实验是否完成
   * 注意：不再显示通知弹窗，因为已有实验记录模态窗
   */
  checkExperimentCompletion() {
    if (this.completedDirections.size === 8) {
      console.log('🎉 实验完成！所有8个方向都已测距完毕');
      this.addLog('🎉 实验完成！所有方向测距完毕', 'success');
      // 不再显示通知弹窗，用户可以通过"结束测试"按钮查看实验记录模态窗
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
      mockDataBtn.addEventListener('click', () => {
        if (this.bleConnected) {
          console.log('❌ BLE已连接，模拟数据功能已被禁用');
          return;
        }
        this.simulateSensorData();
      });
    }

    // 模拟锁定按钮
    const mockLockBtn = document.getElementById('mock-lock-btn');
    if (mockLockBtn) {
      mockLockBtn.addEventListener('click', () => {
        if (this.bleConnected) {
          console.log('❌ BLE已连接，模拟锁定功能已被禁用');
          return;
        }
        this.simulateLock();
      });
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

    // BLE驱动连接按钮
    const bleDriverBtn = document.getElementById('ble-driver-btn');
    if (bleDriverBtn) {
      bleDriverBtn.addEventListener('click', () => {
        this.openBLEDriverPage();
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
        
        // 如果关闭锁定功能，清除所有锁定状态并停止实验
        if (!this.lockFeatureEnabled) {
          // 如果测试正在运行，先停止测试（会自动停止计时器）
          if (this.experimentRunning) {
            this.stopExperiment();
          }
          
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

    // 开始测试按钮
    const startExperimentBtn = document.getElementById('start-experiment-btn');
    if (startExperimentBtn) {
      startExperimentBtn.addEventListener('click', () => {
        if (this.experimentRunning) {
          this.stopExperiment();
        } else {
          this.startExperiment();
        }
      });
    }

    // 实验记录模态窗关闭按钮（恢复测试状态）
    const experimentRecordModalClose = document.getElementById('experiment-record-modal-close');
    if (experimentRecordModalClose) {
      experimentRecordModalClose.addEventListener('click', () => {
        // 关闭模态窗并恢复测试状态（用于误触恢复）
        this.hideExperimentRecordModal(true);
      });
    }

    // 实验记录模态窗背景点击关闭（不恢复测试，正常关闭）
    const experimentRecordModal = document.getElementById('experiment-record-modal');
    if (experimentRecordModal) {
      experimentRecordModal.addEventListener('click', (e) => {
        if (e.target === experimentRecordModal) {
          this.hideExperimentRecordModal(false);
        }
      });
    }

    // 重新测试按钮
    const retestBtn = document.getElementById('retest-btn');
    if (retestBtn) {
      retestBtn.addEventListener('click', () => {
        this.retest();
      });
    }

    // 导出数据按钮
    const exportDataBtn = document.getElementById('export-data-btn');
    if (exportDataBtn) {
      exportDataBtn.addEventListener('click', () => {
        this.exportToCSV();
      });
    }

    // 腿长输入框实时计算测试分数
    const legLengthInput = document.getElementById('test-subject-leg-length');
    if (legLengthInput) {
      legLengthInput.addEventListener('input', () => {
        const legLength = parseFloat(legLengthInput.value);
        const testScoreValue = document.getElementById('test-score-value');
        if (testScoreValue) {
          if (legLength && legLength > 0) {
            const score = this.calculateTestScore(legLength);
            testScoreValue.textContent = score.toFixed(2);
          } else {
            testScoreValue.textContent = '--';
          }
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

    // 监听蓝牙数据（仅BLE，通过WebSocket Bridge）
    ipcRenderer.on('bluetooth-data-received', (event, data) => {
      if (data.type === 'scan_data') {
        // 解析WebSocket传递过来的数据
        const payload = JSON.parse(data.data);
        if (payload.source === 'host') {
          // 主机传感器数据，直接处理（第一手数据）
          // 收到主机数据时，更新连接状态（说明已连接）
          if (!this.bleConnected) {
            this.bleConnected = true;
            this.connectedDevice = {
              name: payload.name || 'SEBT-Host-001',
              address: payload.address || 'unknown'
            };
            this.updateBluetoothStatus({
              connected: true,
              class: 'connected',
              device: this.connectedDevice
            });
          }
          this.handleHostBroadcast(payload);
        } else if (payload.source === 'slave') {
          // 从机压力数据
          this.addBLEDataLog(`从机压力: ${payload.pressure} (raw=${payload.pressureRaw || 0})`, 'info');
        }
      }
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
    let currentDistance = sensorData ? sensorData.distance : Math.floor(Math.random() * 100) + 50;
    
    // 确保距离值是有效数字
    if (typeof currentDistance !== 'number' || !isFinite(currentDistance) || currentDistance <= 0) {
      currentDistance = Math.floor(Math.random() * 100) + 50;
    }

    // 锁定这个方向
    this.lockDirection(directionToLock, currentDistance);

    console.log(`🔒 模拟锁定方向: ${directionMap[directionToLock].displayName} - ${currentDistance}mm`);
    this.addLog(`🔒 模拟锁定: ${directionMap[directionToLock].displayName} - ${currentDistance}mm`, 'success');
    
    // 确保按钮显示（延迟一下，确保DOM更新完成）
    setTimeout(() => {
      const gridElement = this.gridElements.get(directionToLock);
      if (gridElement) {
        const measureBtn = gridElement.querySelector('.manual-measure-btn');
        if (measureBtn) {
          measureBtn.style.display = 'block';
          measureBtn.style.visibility = 'visible';
          console.log(`✅ 模拟锁定后确认按钮显示: ${directionMap[directionToLock].displayName}`);
        } else {
          console.warn(`⚠️ 模拟锁定后未找到按钮: ${directionMap[directionToLock].displayName}`);
        }
      }
    }, 100);
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
    // 直接使用传入的真实数据，只检查是否为有效数字
    if (typeof distance === 'number' && isFinite(distance)) {
    return `${distance} mm`;
    }
    return '--';
  }

  /**
   * 更新传感器显示 (保留原有的锁定数据显示)
   */
  updateSensorDisplay(channel, sensorData) {
    const gridElement = this.gridElements.get(channel);
    if (!gridElement) return;

    const distanceElement = gridElement.querySelector('.distance-display');
    if (!distanceElement) return;

    // 如果正在测距中，不更新显示（保持"计算中"状态）
    if (this.bluetoothMeasurementCollection && this.bluetoothMeasurementCollection.channel === channel) {
      return;
    }

    // 如果已完成测距，不更新显示（保持固定读数）
    if (this.completedDirections.has(channel)) {
      return;
    }

    // 更新距离显示（直接使用传入的真实数据）
    const distance = sensorData.distance;
    const displayText = (typeof distance === 'number' && isFinite(distance))
      ? this.formatDistance(distance)
      : '--';

    // 锁定方向：异步更新读数，避免阻塞其他方向的数据更新
    if (gridElement.classList.contains('locked')) {
      // 使用 requestAnimationFrame 异步更新，不阻塞数据流
      requestAnimationFrame(() => {
        distanceElement.textContent = displayText;
        // 使用important确保蓝色高亮不会被覆盖
        distanceElement.style.setProperty('color', '#3b82f6', 'important');
        // 确保锁定方向的元素永远不会被添加min-distance类
        gridElement.classList.remove('min-distance');
      });
      return;
    }

    // 非锁定方向：同步更新（保持实时性）
    distanceElement.textContent = displayText;

    // 如果已经有min-distance类（绿色实时高亮），保持绿色，不改变
    if (gridElement.classList.contains('min-distance')) {
      return;
    }

    // 普通状态：蓝色显示
    gridElement.classList.remove('active');
      distanceElement.style.color = '#3b82f6'; // 默认蓝色
  }

  /**
   * 添加事件日志条目（只记录关键事件）
   */
  addLog(messageOrData, type = 'info') {
    let logEntry;

    // 支持字符串参数（新方式）
    if (typeof messageOrData === 'string') {
      logEntry = {
      id: Date.now(),
        timestamp: Date.now(),
        message: messageOrData,
        type: type,
        event: true // 标记为事件日志
      };
    } else {
      // 支持sensorData对象参数（向后兼容，但不再记录传感器数据）
      return; // 不再记录传感器详细数据
    }

    // 将新日志添加到数组末尾（新日志显示在底部）
    this.logs.push(logEntry);

    // 限制日志数量（保留最后20条）
    if (this.logs.length > 20) {
      this.logs = this.logs.slice(-20);
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

    const wasConnected = this.bleConnected;
    this.bleConnected = !!status.connected;
    this.connectedDevice = status.device || this.connectedDevice;

    bluetoothElement.classList.remove('connected', 'searching', 'disconnected');

    const connected = !!status.connected;
    // 只显示连接状态，不显示设备名称
    bluetoothElement.textContent = connected ? '📱 主机BLE: 已连接' : '📱 主机BLE: 未连接';

    // 记录连接状态变化
    if (connected && !wasConnected) {
      this.addLog('🔗 主机BLE设备已连接', 'success');
      // BLE连接成功时，禁用模拟按钮
      this.updateMockDataButtonState();
    } else if (!connected && wasConnected) {
      this.addLog('🔌 主机BLE设备已断开', 'error');
      // BLE断开时，恢复模拟按钮状态
      this.updateMockDataButtonState();
    }

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

    const wasConnected = this.slaveDeviceConnected;
    this.slaveDeviceConnected = !!status.connected;
    this.slaveDevice = status.device || this.slaveDevice;

    slaveElement.classList.remove('connected', 'searching', 'disconnected');

    const connected = !!status.connected;
    slaveElement.textContent = connected ? '🦶 从机状态: 已连接' : '🦶 从机状态: 未连接';

    // 记录连接状态变化
    if (connected && !wasConnected) {
      this.addLog('🔗 从机BLE设备已连接', 'success');
    } else if (!connected && wasConnected) {
      this.addLog('🔌 从机BLE设备已断开', 'error');
    }

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
   * 处理WebSocket传递的BLE数据（仅用于连接状态更新）
   * 注意：传感器数据已统一在handleHostBroadcast中处理
   */
  handleWebSocketData(data) {
    try {
      const jsonData = JSON.parse(data.data);

      if (jsonData.type === 'sensor_data') {
        // 仅更新BLE连接状态，数据处理由handleHostBroadcast完成
        const wasConnected = this.bleConnected;
        this.bleConnected = true;
        this.updateBluetoothStatus({ connected: true });
        // 如果之前未连接，现在连接了，需要更新按钮状态
        if (!wasConnected) {
          this.updateMockDataButtonState();
        }
      }
    } catch (error) {
      console.error('❌ 处理WebSocket BLE数据失败:', error);
      this.addLog(`❌ 处理BLE数据失败: ${error.message}`, 'error');
    }
  }

  /**
   * 开始蓝牙测距数据收集
   */
  startBluetoothMeasurementCollection(channel, direction) {
    console.log('📊 开始蓝牙测距数据收集:', direction.displayName, '方向', channel);

    // 初始化收集状态（UI已在performManualMeasurement中设置为"计算中"）
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
   * 取消蓝牙测距数据收集
   */
  cancelBluetoothMeasurementCollection() {
    if (this.bluetoothMeasurementCollection) {
      if (this.bluetoothMeasurementCollection.timeoutId) {
        clearTimeout(this.bluetoothMeasurementCollection.timeoutId);
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

      this.bluetoothMeasurementCollection = null;
      this.waitingForManualResult = null;
          }
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
            connected: false,
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
        const prefix = isHost ? '📡 主机' : '🦶 从机';
        titleElement.textContent = `${prefix} - 参数调整`;
      }

      // 根据目标切换显示内容
      const isHost = this.bleTarget !== 'slave';
      this.toggleModalContent(isHost);

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
   * 切换模态框内容显示（主机/从机模式）
   * @param {boolean} isHost 是否为主机模式
   */
  toggleModalContent(isHost) {
    const hostSettings = document.getElementById('host-lock-time-settings');
    const slaveStableSettings = document.getElementById('slave-stable-time-settings');
    const slavePressureSettings = document.getElementById('slave-pressure-threshold-settings');
    const bluetoothScanSection = document.getElementById('bluetooth-scan-section');
    const dataLogSection = document.querySelector('.bluetooth-data-log-section');

    if (isHost) {
      // 主机模式：显示锁定时长设置，隐藏从机设置
      if (hostSettings) hostSettings.style.display = 'block';
      if (slaveStableSettings) slaveStableSettings.style.display = 'none';
      if (slavePressureSettings) slavePressureSettings.style.display = 'none';
      if (bluetoothScanSection) bluetoothScanSection.style.display = 'none';
      if (dataLogSection) dataLogSection.style.display = 'none';
    } else {
      // 从机模式：显示稳定时长和压力阈值设置，隐藏主机设置
      if (hostSettings) hostSettings.style.display = 'none';
      if (slaveStableSettings) slaveStableSettings.style.display = 'block';
      if (slavePressureSettings) slavePressureSettings.style.display = 'block';
      if (bluetoothScanSection) bluetoothScanSection.style.display = 'none';
      if (dataLogSection) dataLogSection.style.display = 'none';
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
   * 更新稳定时长设置显示
   */
  updateStableTimeSettings() {
    if (!this.stableTimeSlider) return;

    const count = parseInt(this.stableTimeSlider.value);
    this.stableRequiredCount = count;

    const timeInSeconds = ((count * this.HARDWARE_SEND_INTERVAL_MS) / 1000).toFixed(1);

    if (this.stableCountDisplay) {
      this.stableCountDisplay.textContent = count;
    }
    if (this.stableTimeDisplay) {
      this.stableTimeDisplay.textContent = timeInSeconds;
    }

  }

  /**
   * 更新压力阈值设置显示
   */
  updatePressureThresholdSettings() {
    // 更新数值显示
    this.updatePressureDisplay();

    // 更新范围显示条
    this.updatePressureRangeDisplay();
  }

  /**
   * 更新压力阈值范围显示条
   */
  updatePressureRangeDisplay() {
    const rangeElement = document.getElementById('pressure-range');
    if (!rangeElement) return;

    const minPercent = (this.pressureMinThreshold / 4056) * 100;
    const maxPercent = (this.pressureMaxThreshold / 4056) * 100;

    rangeElement.style.left = minPercent + '%';
    rangeElement.style.width = (maxPercent - minPercent) + '%';
  }

  /**
   * 更新压力阈值显示（用于数值显示）
   */
  updatePressureDisplay() {
    const minDisplay = document.getElementById('pressure-min-display');
    const maxDisplay = document.getElementById('pressure-max-display');

    if (minDisplay) {
      minDisplay.textContent = this.pressureMinThreshold;
    }
    if (maxDisplay) {
      maxDisplay.textContent = this.pressureMaxThreshold;
    }
  }

  /**
   * 初始化压力阈值双滑块
   */
  initializePressureSlider() {
    const container = document.getElementById('pressure-slider-container');
    const minHandle = document.getElementById('pressure-min-handle');
    const maxHandle = document.getElementById('pressure-max-handle');
    const minTooltip = document.getElementById('pressure-min-tooltip');
    const maxTooltip = document.getElementById('pressure-max-tooltip');
    const track = container.querySelector('.pressure-threshold-track');

    if (!container || !minHandle || !maxHandle) return;

    let isDragging = false;
    let activeHandle = null;
    let startX = 0;
    let startValue = 0;

    const updateHandlePosition = (handle, value) => {
      const percentage = (value / 4056) * 100;
      handle.style.left = percentage + '%';
      handle.setAttribute('data-value', value);

      // 更新tooltip
      const tooltip = handle.querySelector('.pressure-threshold-handle-tooltip');
      if (tooltip) {
        tooltip.textContent = value;
      }
    };

    const getValueFromPosition = (clientX) => {
      const rect = container.getBoundingClientRect();
      const x = Math.max(0, Math.min(clientX - rect.left, rect.width));
      return Math.round((x / rect.width) * 4056);
    };

    // 初始化位置
    updateHandlePosition(minHandle, this.pressureMinThreshold);
    updateHandlePosition(maxHandle, this.pressureMaxThreshold);
    this.updatePressureRangeDisplay();

    // 鼠标按下事件
    const handleMouseDown = (event, handle) => {
      event.preventDefault();
      isDragging = true;
      activeHandle = handle;
      startX = event.clientX;
      startValue = parseInt(handle.getAttribute('data-value'));

      // 提高z-index
      handle.style.zIndex = '5';
      handle.style.cursor = 'grabbing';

      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
    };

    // 鼠标移动事件
    const handleMouseMove = (event) => {
      if (!isDragging || !activeHandle) return;

      const deltaX = event.clientX - startX;
      const newValue = Math.max(0, Math.min(4056, startValue + Math.round((deltaX / container.getBoundingClientRect().width) * 4056)));

      // 确保最小值不大于最大值
      if (activeHandle === minHandle) {
        const maxValue = parseInt(maxHandle.getAttribute('data-value'));
        this.pressureMinThreshold = Math.min(newValue, maxValue);
      } else {
        const minValue = parseInt(minHandle.getAttribute('data-value'));
        this.pressureMaxThreshold = Math.max(newValue, minValue);
      }

      updateHandlePosition(activeHandle, activeHandle === minHandle ? this.pressureMinThreshold : this.pressureMaxThreshold);
      this.updatePressureThresholdSettings();
    };

    // 鼠标释放事件
    const handleMouseUp = () => {
      if (activeHandle) {
        activeHandle.style.zIndex = '3';
        activeHandle.style.cursor = 'grab';
      }
      isDragging = false;
      activeHandle = null;

      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };

    // 点击轨道事件
    track.addEventListener('click', (event) => {
      if (isDragging) return; // 如果正在拖拽，忽略点击

      const clickValue = getValueFromPosition(event.clientX);
      const minValue = parseInt(minHandle.getAttribute('data-value'));
      const maxValue = parseInt(maxHandle.getAttribute('data-value'));

      // 计算距离
      const distanceToMin = Math.abs(clickValue - minValue);
      const distanceToMax = Math.abs(clickValue - maxValue);

      if (distanceToMin <= distanceToMax) {
        // 设置最小值
        const maxValue = parseInt(maxHandle.getAttribute('data-value'));
        this.pressureMinThreshold = Math.min(clickValue, maxValue);
        updateHandlePosition(minHandle, this.pressureMinThreshold);
      } else {
        // 设置最大值
        const minValue = parseInt(minHandle.getAttribute('data-value'));
        this.pressureMaxThreshold = Math.max(clickValue, minValue);
        updateHandlePosition(maxHandle, this.pressureMaxThreshold);
      }

      this.updatePressureThresholdSettings();
    });

    // 绑定事件
    minHandle.addEventListener('mousedown', (event) => handleMouseDown(event, minHandle));
    maxHandle.addEventListener('mousedown', (event) => handleMouseDown(event, maxHandle));
  }

  /**
   * 初始化从机参数设置显示
   */
  initializeSlaveParameterSettings() {
    // 初始化稳定时长设置
    if (this.stableTimeSlider) {
      this.stableTimeSlider.value = this.stableRequiredCount;
      this.updateStableTimeSettings();
    }

    // 初始化压力阈值设置（现在由自定义滑块处理）
    this.updatePressureThresholdSettings();
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

    // 数据接收已在setupIPCListeners中统一处理，此处不再重复监听

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
    this.bleClearDataLogBtn = document.getElementById('bluetooth-clear-data-log-btn');

    // 从机参数设置元素
    this.stableTimeSlider = document.getElementById('stable-time-slider');
    this.stableCountDisplay = document.getElementById('stable-count-display');
    this.stableTimeDisplay = document.getElementById('stable-time-display');
    this.pressureMinSlider = document.getElementById('pressure-min-slider');
    this.pressureMaxSlider = document.getElementById('pressure-max-slider');
    this.pressureMinDisplay = document.getElementById('pressure-min-display');
    this.pressureMaxDisplay = document.getElementById('pressure-max-display');

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

    // 从机参数设置事件绑定
    if (this.stableTimeSlider && !this.stableTimeSlider.hasBoundEvents) {
      this.stableTimeSlider.addEventListener('input', () => this.updateStableTimeSettings());
      this.stableTimeSlider.hasBoundEvents = true;
    }

    // 自定义双滑块事件绑定
    if (!this.pressureSliderInitialized) {
      this.initializePressureSlider();
      this.pressureSliderInitialized = true;
    }

    // 标记为已初始化
    this.bleModalInitialized = true;

    // 更新连接状态显示
    this.updateBLEConnectionStatus();

    // 初始化从机参数设置显示
    this.updateStableTimeSettings();
    this.updatePressureThresholdSettings();

    // 初始化范围显示条样式
    setTimeout(() => {
      this.updatePressureRangeDisplay();
    }, 100);
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
   * 断开BLE连接
   */
  disconnectBLE() {
    console.log('🔌 断开BLE连接');
    const { ipcRenderer } = require('electron');
    ipcRenderer.send('bt-disconnect');
    this.addBLELog('正在断开BLE连接...', 'info');
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

    // BLE连接成功时立即禁用模拟按钮
    this.updateMockDataButtonState();

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
    // 确保按钮状态与连接状态同步
    this.updateMockDataButtonState();
  }

  /**
   * 处理BLE设备发现
   */
  // BT管理器自动连接，不需要设备发现和手动连接方法

  /**
   * 处理主机广播的8方向数据（统一处理硬件端数据格式）
   * @param {Object} payload - 数据格式：{timestamp, minDirection, minDistance, distances: [[dir, dist], ...]}
   * 注意：所有数据已由 ble-manager.js 统一转换为 [[dir, dist], ...] 格式，此处不再进行格式转换
   */
  handleHostBroadcast(payload) {
    const timestamp = payload.timestamp || Date.now();
    const distancesArray = new Array(8).fill(this.INVALID_DISTANCE);
    const hasLockedDirection = this.lockedDirections.size > 0;
    const hasCompletedDirections = this.completedDirections.size > 0;

    // 统一数据格式：distances 必须是 [[dir, dist], [dir, dist], ...] 格式（由 ble-manager.js 保证）
    // 优化：批量处理数据更新，减少DOM操作
    if (Array.isArray(payload.distances)) {
      const measuringChannel = this.bluetoothMeasurementCollection ? this.bluetoothMeasurementCollection.channel : -1;
      
      payload.distances.forEach((item) => {
        // 验证数据格式
        if (!Array.isArray(item) || item.length !== 2) {
          console.warn('⚠️ 无效的距离数据项格式，期望 [dir, dist]，实际:', item);
          return;
        }

        const [dir, dist] = item;
        if (typeof dir === 'number' && dir >= 0 && dir < 8 && typeof dist === 'number') {
          // 直接使用传入的真实数据，不进行有效性判断
          distancesArray[dir] = dist;
          this.updateSensorData(dir, dist, 'hardware');

          // 如果正在对该方向测距，不刷新UI（保持"计算中"或最终读数）
          if (measuringChannel !== dir && !this.completedDirections.has(dir)) {
          const sensorData = this.sensorData.get(dir);
          if (sensorData) {
            sensorData.timestamp = timestamp;
            this.updateSensorDisplay(dir, sensorData);
            }
          }
        }
      });
    }

    // 构建过滤后的距离数组，排除已完成的方向（用于锁定逻辑）
    // 优化：只在有已完成方向时才构建过滤数组
    const filteredDistancesArray = hasCompletedDirections 
      ? (() => {
          const filtered = new Array(8).fill(Infinity); // 使用Infinity代替INVALID_DISTANCE
          for (let ch = 0; ch < 8; ch++) {
            if (!this.completedDirections.has(ch)) {
              filtered[ch] = distancesArray[ch];
            }
          }
          return filtered;
        })()
      : distancesArray;

    // 高亮最近方向（排除已完成的方向）
    // 如果存在锁定方向，highlightClosestDirection会清除所有绿色高亮并直接返回
    this.highlightClosestDirection(filteredDistancesArray);

    // 计算最小方向（优先使用currentMinDirection，兼容minDir字段）
    // 初始化minDir和minDist，确保在块外也能访问
    let minDir = payload.currentMinDirection !== undefined ? payload.currentMinDirection : payload.minDir;
    let minDist = payload.currentMinDistance !== undefined ? payload.currentMinDistance : payload.minDist;
    
    // 优化：只在没有锁定方向时才计算最小方向（因为锁定后不需要自动锁定）
    if (!hasLockedDirection) {
      // 如果未提供最小方向，从过滤后的距离数组中计算
      if (minDir === undefined || minDir === -1 || minDir === 255) {
      let calcMin = Infinity;
      let calcDir = -1;
        filteredDistancesArray.forEach((d, idx) => {
          // 直接使用传入的数据，只检查是否为有效数字
          if (typeof d === 'number' && isFinite(d) && d >= 0 && d < calcMin) {
          calcMin = d;
          calcDir = idx;
        }
      });
      minDir = calcDir;
      minDist = calcMin;
    }

      // 检查并执行自动锁定（基于连续次数），异步防止阻塞数据更新
      // 双重检查：确保方向有效且不在已完成列表中
      if (minDir >= 0 && minDir < 8 && typeof minDist === 'number' && isFinite(minDist) && !this.completedDirections.has(minDir)) {
        // 使用 requestAnimationFrame 异步执行，不阻塞数据更新流程
        requestAnimationFrame(() => {
      this.checkAutoLock(minDir, minDist);
        });
      }
    }

    // 处理测距数据收集（如果正在收集）
    // 注意：正在测距的方向不会更新显示（在updateSensorDisplay中已处理）
    if (this.bluetoothMeasurementCollection) {
      const { channel, direction, distances, maxSamples } = this.bluetoothMeasurementCollection;
      const collectedDistance = distancesArray[channel];
      
      // 直接使用传入的数据，不进行有效性判断
      if (typeof collectedDistance === 'number' && isFinite(collectedDistance) && collectedDistance > 0) {
        distances.push(collectedDistance);
        console.log(`📊 测距样本 ${distances.length}/${maxSamples}: ${direction.displayName} = ${collectedDistance}mm`);
        
        // 检查是否收集够了样本
        if (distances.length >= maxSamples) {
          // 计算平均值
          const averageDistance = Math.round(distances.reduce((sum, dist) => sum + dist, 0) / distances.length);
          console.log(`📊 测距完成: ${direction.displayName} 平均值 ${averageDistance}mm (样本: [${distances.join(', ')}])`);
          
          // 完成测距（会固定显示读数）
          this.handleManualMeasurementResult(channel, averageDistance, direction);
          
          // 清理收集状态
          this.cancelBluetoothMeasurementCollection();
        }
      }
    }

    // 记录主机数据日志
    // 确保minDir和minDist有值（如果未定义则显示-1和--）
    const logMinDir = (minDir !== undefined && minDir >= 0) ? minDir : -1;
    const logMinDist = (minDist !== undefined && typeof minDist === 'number' && isFinite(minDist)) ? `${minDist}mm` : '--';
    this.addBLEDataLog(
      `主机广播: 方向${logMinDir} 距离 ${logMinDist}`,
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
    // 更新按钮状态，恢复模拟按钮可用
    this.updateMockDataButtonState();
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
      logElement.className = `log-entry ${log.event ? 'event' : (log.source === 'hardware' ? 'hardware' : 'simulated')}`;

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

    // 自动滚动到底部（显示最新日志），使用平滑滚动
    logsContainer.scrollTo({
      top: logsContainer.scrollHeight,
      behavior: 'smooth'
    });
  }

  /**
   * 检查并执行自动锁定（基于连续次数）
   */
  checkAutoLock(currentMinDirection, currentMinDistance) {
    // 如果实验未运行，不执行锁定检查
    if (!this.experimentRunning) {
      return;
    }

    // 如果已经有锁定方向，不执行新的锁定检查（保证同一时间只有一个锁定方向）
    if (this.lockedDirections.size > 0) {
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
      // 自动锁定（lockDirection内部会确保同一时间只有一个锁定方向）
      this.lockDirection(currentMinDirection, currentMinDistance);
      const duration = Date.now() - this.minDirectionStartTime;
      console.log(`🔒 前端自动锁定: ${directionMap[currentMinDirection].displayName} - ${currentMinDistance}mm (连续${this.minDirectionConsecutiveCount}次，持续${duration}ms)`);
      // 不记录日志，因为lockDirection已经记录了锁定方向日志
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
   * 高亮最近方向（排除已完成测距和已锁定的方向）
   */
  highlightClosestDirection(distances) {
    // 如果存在锁定方向：完全禁用绿色高亮，保持锁定为蓝色，不进行任何绿色高亮计算
    if (this.lockedDirections.size > 0) {
      // 立即清除所有绿色高亮（同步执行，确保即时清除）
    this.gridElements.forEach((element) => {
        // 强制移除绿色高亮类
      element.classList.remove('min-distance');
        const distanceElement = element.querySelector('.distance-display');
        if (distanceElement) {
          // 如果是锁定方向，强制设置为蓝色，使用important确保最高优先级，防止被任何后续逻辑覆盖
          if (element.classList.contains('locked')) {
            distanceElement.style.setProperty('color', '#3b82f6', 'important');
            // 确保锁定方向的元素永远不会被添加min-distance类
            element.classList.remove('min-distance');
          } else if (!element.classList.contains('completed')) {
            // 只更新未锁定且未完成的方向的颜色
            distanceElement.style.color = '#3b82f6';
          }
        }
      });
      this.lastClosestDirection = -1;
      return; // 存在锁定方向时，完全禁用绿色高亮计算，直接返回
    }

    // 计算最近方向（排除已完成和已锁定的方向）
    let closestChannel = -1;
    let closestDistance = Infinity;
    for (let channel = 0; channel < 8; channel++) {
      // 排除已锁定和已完成的方向
      if (!this.lockedDirections.has(channel) && !this.completedDirections.has(channel)) {
        const distance = distances[channel];
        // 直接使用传入的数据，只检查是否为有效数字
        if (typeof distance === 'number' && isFinite(distance) && distance >= 0 && distance < closestDistance) {
          closestDistance = distance;
          closestChannel = channel;
        }
      }
    }

    // 如果没有可高亮的方向，清除绿色并重置记录
    if (closestChannel === -1) {
      this.gridElements.forEach((element) => {
        if (!element.classList.contains('locked') && !element.classList.contains('completed')) {
          element.classList.remove('min-distance');
          const distanceElement = element.querySelector('.distance-display');
          if (distanceElement) {
            distanceElement.style.color = '#3b82f6';
          }
        }
      });
      this.lastClosestDirection = -1;
      return;
    }

    // 如果最近方向与上一次相同，则保持现状，避免闪烁
    if (closestChannel === this.lastClosestDirection) {
      return;
    }

    // 清除未锁定且未完成方向的绿色高亮
    this.gridElements.forEach((element) => {
      // 确保锁定方向完全不受影响
      if (element.classList.contains('locked')) {
        // 锁定方向保持蓝色，不进行任何操作
        return;
      }
      if (!element.classList.contains('completed')) {
        element.classList.remove('min-distance');
        const distanceElement = element.querySelector('.distance-display');
        if (distanceElement) {
          distanceElement.style.color = '#3b82f6';
        }
      }
    });

    // 高亮新的最近方向（绿色）
    // 确保不会高亮锁定方向
    if (closestChannel >= 0 && !this.lockedDirections.has(closestChannel)) {
      const targetElement = this.gridElements.get(closestChannel);
      if (targetElement && !targetElement.classList.contains('locked')) {
        targetElement.classList.add('min-distance');
        const distanceElement = targetElement.querySelector('.distance-display');
        if (distanceElement) {
          distanceElement.style.color = '#059669';
        }
      }
    }

    // 记录本次最近方向
    this.lastClosestDirection = closestChannel;
  }

  /**
   * 开始测试
   */
  startExperiment() {
    if (this.experimentRunning) {
      console.log('⚠️ 测试已在运行中');
      return;
    }

    // 检查是否有BLE连接
    if (!this.bleConnected) {
      alert('请先连接BLE设备后再开始测试');
      return;
    }

    // 开始测试
    this.experimentRunning = true;
    this.experimentStartTime = Date.now();
    
    // 重置自动锁定计数状态
    this.currentMinDirection = -1;
    this.minDirectionStartTime = 0;
    this.minDirectionConsecutiveCount = 0;
    
    // 清空之前的测距结果
    this.measurementResults.clear();

    // 更新按钮状态
    const startExperimentBtn = document.getElementById('start-experiment-btn');
    if (startExperimentBtn) {
      startExperimentBtn.textContent = '结束测试';
      startExperimentBtn.classList.add('secondary');
      // 移除margin-top，因为父容器已经有margin-top: 8px，避免重复
      startExperimentBtn.style.marginTop = '0';
    }

    // 显示实验状态组件
    this.showExperimentStatus();

    // 启动计时器
    this.startExperimentTimer();

    // 添加日志
    this.addLog('🚀 测试已开始，开始监测传感器数据', 'success');
    console.log('🚀 测试已开始，开始监测传感器数据');
  }

  /**
   * 停止实验
   */
  stopExperiment() {
    if (!this.experimentRunning) {
      console.log('⚠️ 测试未在运行');
      return;
    }

    // 停止测试
    this.experimentRunning = false;

    // 重置自动锁定计数状态
    this.currentMinDirection = -1;
    this.minDirectionStartTime = 0;
    this.minDirectionConsecutiveCount = 0;

    // 更新按钮状态
    const startExperimentBtn = document.getElementById('start-experiment-btn');
    if (startExperimentBtn) {
      startExperimentBtn.textContent = '开始测试';
      startExperimentBtn.classList.remove('secondary');
      // 移除margin-top样式，恢复默认状态
      startExperimentBtn.style.marginTop = '';
    }

    // 隐藏实验状态组件
    this.hideExperimentStatus();

    // 停止计时器
    this.stopExperimentTimer();

    // 清除绿色实时高亮
    this.gridElements.forEach((element) => {
      element.classList.remove('min-distance');
    });

    // 添加日志
    this.addLog('⏹️ 测试已停止', 'info');
    console.log('⏹️ 测试已停止');
    
    // 弹出实验记录模态窗
    this.showExperimentRecordModal();
  }

  /**
   * 显示实验状态组件
   */
  showExperimentStatus() {
    const statusElement = document.getElementById('experiment-status');
    if (statusElement) {
      statusElement.classList.add('show');
      statusElement.classList.remove('paused');
      const iconElement = statusElement.querySelector('.experiment-status-icon');
      if (iconElement) {
        iconElement.textContent = '▶';
      }
    }
  }

  /**
   * 隐藏实验状态组件
   */
  hideExperimentStatus() {
    const statusElement = document.getElementById('experiment-status');
    if (statusElement) {
      statusElement.classList.remove('show', 'paused');
    }
  }

  /**
   * 启动实验计时器
   */
  startExperimentTimer() {
    // 清除之前的计时器
    if (this.experimentTimer) {
      clearInterval(this.experimentTimer);
    }

    // 立即更新一次时间显示
    this.updateExperimentTime();

    // 每秒更新一次时间显示
    this.experimentTimer = setInterval(() => {
      this.updateExperimentTime();
    }, 1000);
  }

  /**
   * 停止实验计时器
   */
  stopExperimentTimer() {
    if (this.experimentTimer) {
      clearInterval(this.experimentTimer);
      this.experimentTimer = null;
    }
  }

  /**
   * 更新实验时长显示
   */
  updateExperimentTime() {
    if (!this.experimentRunning || !this.experimentStartTime) {
      return;
    }

    const elapsed = Math.floor((Date.now() - this.experimentStartTime) / 1000); // 秒
    const minutes = Math.floor(elapsed / 60);
    const seconds = elapsed % 60;

    const timeString = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
    
    const timeElement = document.getElementById('experiment-time');
    if (timeElement) {
      timeElement.textContent = timeString;
    }
  }

  /**
   * 更新模拟数据按钮状态
   */
  updateMockDataButtonState() {
    const mockDataBtn = document.getElementById('mock-data-btn');
    const mockLockBtn = document.getElementById('mock-lock-btn');

    if (this.bleConnected) {
      // 主机BLE已连接时，禁用所有模拟按钮（防止干扰实验过程和日志污染）
      if (mockDataBtn) {
        mockDataBtn.disabled = true;
        mockDataBtn.textContent = '主机BLE已连接';
        mockDataBtn.style.opacity = ''; // 移除内联样式，让CSS的:disabled样式生效
        mockDataBtn.style.cursor = ''; // 移除内联样式，让CSS的:disabled样式生效
      }
      if (mockLockBtn) {
        mockLockBtn.disabled = true;
        mockLockBtn.textContent = '主机BLE已连接';
        mockLockBtn.style.opacity = ''; // 移除内联样式，让CSS的:disabled样式生效
        mockLockBtn.style.cursor = ''; // 移除内联样式，让CSS的:disabled样式生效
      }
    } else {
      // 设备未连接时，根据锁定状态控制按钮
      const hasLockedDirections = this.lockedDirections.size > 0;

      // 模拟数据按钮：有锁定方向时禁用
      if (mockDataBtn) {
        if (hasLockedDirections) {
          mockDataBtn.disabled = true;
          mockDataBtn.textContent = '请先完成测距';
          mockDataBtn.style.opacity = ''; // 移除内联样式，让CSS的:disabled样式生效
          mockDataBtn.style.cursor = ''; // 移除内联样式，让CSS的:disabled样式生效
        } else {
          mockDataBtn.disabled = false;
          mockDataBtn.textContent = '模拟数据';
          mockDataBtn.style.opacity = ''; // 移除内联样式，恢复默认
          mockDataBtn.style.cursor = ''; // 移除内联样式，恢复默认
        }
      }

      // 模拟锁定按钮：有锁定方向时禁用
      if (mockLockBtn) {
        if (hasLockedDirections) {
          mockLockBtn.disabled = true;
          mockLockBtn.textContent = '已有锁定方向';
          mockLockBtn.style.opacity = ''; // 移除内联样式，让CSS的:disabled样式生效
          mockLockBtn.style.cursor = ''; // 移除内联样式，让CSS的:disabled样式生效
        } else {
          mockLockBtn.disabled = false;
          mockLockBtn.textContent = '模拟锁定';
          mockLockBtn.style.opacity = ''; // 移除内联样式，恢复默认
          mockLockBtn.style.cursor = ''; // 移除内联样式，恢复默认
        }
      }
    }
  }

  /**
   * 重置所有锁定和完成状态
   */
  resetLockedDirections() {
    console.log('🔄 重置所有锁定和完成状态');

    // 如果测试正在运行，先停止测试
    if (this.experimentRunning) {
      this.stopExperiment();
    }

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

      // 隐藏重置按钮
      const resetBtn = element.querySelector('.reset-direction-btn');
      if (resetBtn) {
        resetBtn.style.display = 'none';
      }

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

  /**
   * 显示实验记录模态窗
   */
  showExperimentRecordModal() {
    const modal = document.getElementById('experiment-record-modal');
    if (!modal) return;

    // 填充主机和从机参数（只读显示）
    const lockTimeDisplay = document.getElementById('display-lock-time');
    if (lockTimeDisplay) {
      lockTimeDisplay.textContent = `${this.LOCK_REQUIRED_COUNT}次`;
    }

    const stableTimeDisplay = document.getElementById('display-stable-time');
    if (stableTimeDisplay) {
      stableTimeDisplay.textContent = `${this.stableRequiredCount}次`;
    }

    const pressureRangeDisplay = document.getElementById('display-pressure-range');
    if (pressureRangeDisplay) {
      pressureRangeDisplay.textContent = `${this.pressureMinThreshold}-${this.pressureMaxThreshold}`;
    }

    // 清空输入框
    document.getElementById('test-subject-id').value = '';
    document.getElementById('test-subject-gender').value = '';
    document.getElementById('test-subject-age').value = '';
    document.getElementById('test-subject-leg-length').value = '';
    document.getElementById('test-score-value').textContent = '--';

    // 显示模态窗
    modal.classList.add('show');
    
    // 重置日志状态，确保首次更新时输出日志
    this.tableUpdateLogCount = 0;
    this.lastTableUpdateValues.clear();
    
    // 立即更新表格数据（在显示模态窗后）
    // 先尝试立即更新，确保数据能立即显示
    this.updateMeasurementTable();
    
    // 使用requestAnimationFrame再次更新，确保DOM完全渲染
    // 这样可以避免被主页面的DOM操作阻塞
    requestAnimationFrame(() => {
      // 再次更新表格数据，确保数据正确显示
      this.updateMeasurementTable();
      
      // 启动定时器，实时更新表格数据（每500ms更新一次）
      // 这样在测试过程中打开模态窗时，也能持续更新数据
      this.startMeasurementTableUpdateTimer();
    });
  }
  
  /**
   * 启动测距数据表格更新定时器
   * 使用requestAnimationFrame优化更新，避免被主页面DOM操作阻塞
   */
  startMeasurementTableUpdateTimer() {
    // 清除之前的定时器（如果存在）
    if (this.measurementTableUpdateTimer) {
      clearInterval(this.measurementTableUpdateTimer);
    }
    
    // 每500ms检查一次，但使用requestAnimationFrame来执行更新
    // 这样可以避免被主页面的DOM操作阻塞
    this.measurementTableUpdateTimer = setInterval(() => {
      const modal = document.getElementById('experiment-record-modal');
      if (modal && modal.classList.contains('show')) {
        // 使用requestAnimationFrame异步更新，避免被主页面更新阻塞
        requestAnimationFrame(() => {
          this.updateMeasurementTable();
        });
      } else {
        // 模态窗已关闭，停止定时器
        this.stopMeasurementTableUpdateTimer();
      }
    }, 500);
  }
  
  /**
   * 停止测距数据表格更新定时器
   */
  stopMeasurementTableUpdateTimer() {
    if (this.measurementTableUpdateTimer) {
      clearInterval(this.measurementTableUpdateTimer);
      this.measurementTableUpdateTimer = null;
    }
    // 重置日志计数，确保下次打开模态窗时日志正常
    this.tableUpdateLogCount = 0;
  }

  /**
   * 隐藏实验记录模态窗
   * @param {boolean} restoreTest - 是否恢复测试状态（用于误触恢复）
   */
  hideExperimentRecordModal(restoreTest = false) {
    const modal = document.getElementById('experiment-record-modal');
    if (modal) {
      modal.classList.remove('show');
    }
    
    // 停止表格更新定时器
    this.stopMeasurementTableUpdateTimer();
    
    // 如果用户点击关闭按钮恢复测试
    if (restoreTest) {
      this.restoreTestState();
    }
  }
  
  /**
   * 恢复测试状态（用于误触结束测试后的恢复）
   */
  restoreTestState() {
    // 恢复测试状态
    this.experimentRunning = true;
    
    // 恢复按钮状态
    const startExperimentBtn = document.getElementById('start-experiment-btn');
    if (startExperimentBtn) {
      startExperimentBtn.textContent = '结束测试';
      startExperimentBtn.classList.add('secondary');
      startExperimentBtn.style.marginTop = '0';
    }
    
    // 显示实验状态组件
    this.showExperimentStatus();
    
    // 恢复计时器（从停止的时间继续）
    this.startExperimentTimer();
    
    // 添加日志
    this.addLog('▶️ 测试已恢复（继续测试）', 'success');
    console.log('▶️ 测试已恢复（继续测试）');
  }

  /**
   * 更新测距数据表格
   * 实时读取已完成测距方向的真实读数
   * 直接使用measurementResults作为数据源（与calculateTestScore保持一致）
   */
  updateMeasurementTable() {
    // 方向映射：L(0), BL(1), FL(2), F(3), B(4), BR(5), FR(6), R(7)
    const directionIds = ['L', 'BL', 'FL', 'F', 'B', 'BR', 'FR', 'R'];
    
    // 确保模态窗已显示，并且获取模态窗容器
    const modal = document.getElementById('experiment-record-modal');
    if (!modal || !modal.classList.contains('show')) {
      // 模态窗未显示，不更新
      return;
    }
    
    // 获取模态窗内的表格容器，确保只更新模态窗内的元素
    const tableContainer = modal.querySelector('.experiment-record-table-container');
    if (!tableContainer) {
      console.warn('⚠️ 未找到模态窗表格容器');
      return;
    }
    
    // 批量收集需要更新的数据，减少DOM查询次数
    const updates = [];
    directionIds.forEach((dirCode, index) => {
      const elementId = `distance-${dirCode}`;
      // 在模态窗内查找元素，确保找到的是模态窗中的元素
      const element = tableContainer.querySelector(`#${elementId}`) || document.getElementById(elementId);
      if (!element) {
        console.warn(`⚠️ 未找到表格元素: ${elementId}`);
        return;
      }
      
      // 验证元素是否在模态窗内
      if (!modal.contains(element)) {
        console.warn(`⚠️ 元素 ${elementId} 不在模态窗内，跳过更新`);
        return;
      }
      
      // 直接从measurementResults读取（与calculateTestScore保持一致）
      // measurementResults是测距结果的可靠来源，在completeDirection中设置
      const distance = this.measurementResults.get(index) || 0;
      
      // 收集更新操作
      updates.push({ element, distance, index, dirCode });
    });
    
    // 批量执行DOM更新，减少重排和重绘
    let updateCount = 0;
    const hasChanges = new Map(); // 记录哪些方向有变化
    
    updates.forEach(({ element, distance, index, dirCode }) => {
      const currentValue = element.textContent.trim();
      const newValue = String(distance);
      const lastValue = this.lastTableUpdateValues.get(index);
      
      // 检查值是否有变化
      const valueChanged = currentValue !== newValue;
      const isNewValue = lastValue !== newValue;
      
      // 对于已完成的方向，强制更新（不管当前值是什么）
      // 对于未完成的方向，只在值变化时更新
      const shouldUpdate = valueChanged;
      
      if (shouldUpdate) {
        // 强制更新DOM
        const oldValue = element.textContent;
        element.textContent = newValue;
        updateCount++;
        hasChanges.set(index, { oldValue: oldValue.trim(), newValue, dirCode });
        
        // 更新记录的值
        this.lastTableUpdateValues.set(index, newValue);
        
        // 只在值变化或首次更新时输出详细日志
        if (this.completedDirections.has(index) && isNewValue) {
          // 立即验证更新是否成功（使用同步方式）
          const verifyValue = element.textContent.trim();
          const verifySuccess = verifyValue === newValue;
          
          if (!verifySuccess) {
            console.error(`❌ [${dirCode}] DOM更新验证失败！期望: "${newValue}", 实际: "${verifyValue}"`);
            // 尝试强制设置
            element.textContent = newValue;
            element.innerText = newValue;
            console.log(`🔄 [${dirCode}] 尝试强制设置后: "${element.textContent.trim()}"`);
          } else {
            console.log(`✅ [${dirCode}] DOM已更新: "${oldValue.trim()}" → "${newValue}"`);
          }
        }
      } else {
        // 值没有变化，更新记录的值（用于下次比较）
        if (lastValue !== newValue) {
          this.lastTableUpdateValues.set(index, newValue);
        }
      }
    });
    
    // 只在有变化或每10次更新时输出摘要日志（减少日志频率）
    this.tableUpdateLogCount++;
    const shouldLogSummary = updateCount > 0 || this.tableUpdateLogCount % 10 === 0;
    
    if (this.completedDirections.size > 0 && shouldLogSummary) {
      const completedEntries = Array.from(this.completedDirections).map(idx => {
        const dist = this.measurementResults.get(idx) || 0;
        return `${directionIds[idx]}:${dist}`;
      }).join(', ');
      
      if (updateCount > 0) {
        // 有更新时输出详细信息
        const changedEntries = Array.from(hasChanges.entries()).map(([idx, { dirCode, oldValue, newValue }]) => {
          return `${directionIds[idx]}:${oldValue}→${newValue}`;
        }).join(', ');
        console.log(`📊 表格更新: [${changedEntries}], 已完成方向: [${completedEntries}]`);
      } else if (this.tableUpdateLogCount % 10 === 0) {
        // 每10次输出一次状态（无更新时）
        console.log(`📊 表格状态检查 - 已完成方向: [${completedEntries}], 无更新`);
      }
    }
  }

  /**
   * 计算测试分数
   * @param {number} legLengthCm - 腿长（单位：cm）
   * @returns {number} 测试分数
   */
  calculateTestScore(legLengthCm) {
    if (!legLengthCm || legLengthCm <= 0) {
      return 0;
    }

    // 计算8个方向距离总和（单位：mm）
    let totalDistance = 0;
    for (let i = 0; i < 8; i++) {
      const distance = this.measurementResults.get(i) || 0;
      totalDistance += distance;
    }

    // 单位换算：腿长从cm转换为mm
    const legLengthMm = legLengthCm * 10;

    // 测试分数 = (8个方向距离总和(mm) / (8 × 腿长(cm) × 10)) × 100
    const testScore = (totalDistance / (8 * legLengthMm)) * 100;

    // 返回保留2位小数的数字
    return parseFloat(testScore.toFixed(2));
  }

  /**
   * 导出CSV数据
   */
  async exportToCSV() {
    // 获取基础信息
    const subjectId = document.getElementById('test-subject-id').value.trim();
    const subjectGender = document.getElementById('test-subject-gender').value;
    const subjectAge = document.getElementById('test-subject-age').value;
    const legLength = document.getElementById('test-subject-leg-length').value;

    // 验证必填字段
    if (!subjectId || !subjectGender || !subjectAge || !legLength) {
      alert('请填写完整的基础信息（序号、性别、年龄、腿长）');
      return;
    }

    // 计算测试分数
    const testScore = this.calculateTestScore(parseFloat(legLength));

    // 获取8方向读数（优先从sensorData读取已完成方向的真实读数）
    const distances = [];
    const directionIds = ['L', 'BL', 'FL', 'F', 'B', 'BR', 'FR', 'R'];
    directionIds.forEach((dirCode, index) => {
      let distance = 0;
      
      // 优先从sensorData读取已完成方向的真实读数
      if (this.completedDirections.has(index)) {
        const sensorData = this.sensorData.get(index);
        if (sensorData && sensorData.distance !== undefined && 
            typeof sensorData.distance === 'number' && 
            sensorData.distance > 0) {
          distance = sensorData.distance;
        } else if (this.measurementResults.has(index)) {
          distance = this.measurementResults.get(index);
        }
      } else if (this.measurementResults.has(index)) {
        distance = this.measurementResults.get(index);
      }
      
      distances.push(distance);
    });

    // 构建CSV数据
    const csvHeader = [
      '被测序号',
      '被测性别',
      '被测年龄',
      '被测腿长(cm)',
      '主机参数-锁定时长(次)',
      '从机参数-稳定时长(次)',
      '从机参数-压力最小阈值',
      '从机参数-压力最大阈值',
      '方向L(mm)',
      '方向BL(mm)',
      '方向FL(mm)',
      '方向F(mm)',
      '方向B(mm)',
      '方向BR(mm)',
      '方向FR(mm)',
      '方向R(mm)',
      '测试分数'
    ];

    const csvData = [
      subjectId,
      subjectGender,
      subjectAge,
      legLength,
      this.LOCK_REQUIRED_COUNT,
      this.stableRequiredCount,
      this.pressureMinThreshold,
      this.pressureMaxThreshold,
      ...distances,
      testScore.toFixed(2) // CSV导出时也保留2位小数
    ];

    // 构建CSV字符串
    const csvContent = [
      csvHeader.join(','),
      csvData.join(',')
    ].join('\n');

    // 生成文件名：SEBT-序号-分数-时间（年月日）
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const dateStr = `${year}${month}${day}`;
    const fileName = `SEBT-${subjectId}-${testScore}-${dateStr}.csv`;

    // 使用Electron的dialog API保存文件
    const { ipcRenderer } = require('electron');
    try {
      const result = await ipcRenderer.invoke('save-file-dialog', {
        defaultPath: fileName,
        filters: [
          { name: 'CSV文件', extensions: ['csv'] }
        ]
      });

      if (!result.canceled && result.filePath) {
        // 通过IPC调用主进程写入文件
        const writeResult = await ipcRenderer.invoke('write-file', {
          filePath: result.filePath,
          content: csvContent
        });
        if (writeResult && writeResult.success) {
          alert('数据导出成功！');
          console.log('✅ CSV文件已保存:', result.filePath);
          
          // 导出成功后，自动回到初始状态（类似点击重新测试按钮）
          this.retest();
        } else {
          alert('导出失败：' + (writeResult?.error || '未知错误'));
          console.error('❌ CSV文件保存失败:', writeResult?.error);
        }
      }
    } catch (error) {
      console.error('❌ 导出CSV失败:', error);
      alert('导出失败，请检查文件路径和权限');
    }
  }

  /**
   * 重新测试
   */
  retest() {
    // 关闭模态窗（不恢复测试状态）
    this.hideExperimentRecordModal(false);

    // 重置实验状态
    this.experimentRunning = false;

    // 清空已完成测距数据
    this.completedDirections.clear();
    this.measurementResults.clear();

    // 清空锁定方向
    this.lockedDirections.clear();

    // 重置自动锁定计数状态
    this.currentMinDirection = -1;
    this.minDirectionStartTime = 0;
    this.minDirectionConsecutiveCount = 0;

    // 更新按钮文本
    const startExperimentBtn = document.getElementById('start-experiment-btn');
    if (startExperimentBtn) {
      startExperimentBtn.textContent = '开始测试';
      startExperimentBtn.classList.remove('secondary');
      startExperimentBtn.style.marginTop = '';
    }

    // 隐藏实验状态显示组件
    this.hideExperimentStatus();

    // 停止计时器
    this.stopExperimentTimer();

    // 清除所有高亮
    this.gridElements.forEach((element) => {
      element.classList.remove('min-distance', 'locked', 'active', 'completed', 'selected');
    });

    // 重置传感器显示
    this.sensorData.forEach((data, channel) => {
      if (data) {
        data.completed = false;
        const gridElement = this.gridElements.get(channel);
        if (gridElement) {
          const distanceElement = gridElement.querySelector('.distance-display');
          if (distanceElement) {
            distanceElement.textContent = '--- mm';
          }
        }
      }
    });

    // 添加日志
    this.addLog('🔄 已重置，可以开始新的测试', 'info');
    console.log('🔄 已重置，可以开始新的测试');
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

