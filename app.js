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

    this.initializeApp();
    this.setupEventListeners();
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
    `;
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

    // 监听传感器数据 (来自硬件)
    ipcRenderer.on('sensor-data', (event, data) => {
      console.log('📡 收到硬件数据:', data);
      this.handleHardwareData(data);
    });

    // 监听本地IP地址
    ipcRenderer.on('local-ip', (event, ip) => {
      console.log('🏠 本机IP:', ip);
      this.localIP = ip;
      this.updateIPDisplay();
    });
  }

  /**
   * 模拟传感器数据
   */
  simulateSensorData() {
    // 随机选择一个传感器
    const channels = Object.keys(directionMap).map(ch => parseInt(ch));
    const randomChannel = channels[Math.floor(Math.random() * channels.length)];

    // 生成随机距离 (50-2000mm)
    const randomDistance = Math.floor(Math.random() * 1950) + 50;

    this.updateSensorData(randomChannel, randomDistance);
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
   * 处理来自硬件的数据
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
   * 更新传感器显示
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

    // 更新样式
    if (sensorData.active) {
      gridElement.classList.add('active');
      distanceElement.style.color = '#10b981'; // 绿色
    } else {
      gridElement.classList.remove('active');
      distanceElement.style.color = '#94a3af'; // 灰色
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
