# SEBT 平衡测试系统

一个基于 Electron 的现代化桌面平衡测试仪表板应用，支持Wi-Fi无线和USB有线双通信模式。

## 📋 最新版本: v2.0 - 多通信模式完整实现

### 🚀 新功能特性
- ✅ **USB串口通信**: 有线备份通信，完全替代Wi-Fi
- ✅ **手动测距功能**: UI直接触发任意方向测量
- ✅ **BLE可选模式**: 支持无从机独立工作
- ✅ **UI界面优化**: 状态标签纵向排列，手动测距悬浮按钮
- ✅ **通信稳定性**: 完善的错误处理和自动重连机制

## 项目简介

SEBT Dashboard 是专为 "SEBT v4.0 平衡测试系统" 打造的现代化桌面仪表板应用，支持Wi-Fi无线和USB有线双通信模式，提供实时的传感器数据显示、设备控制和日志记录功能。

## 核心功能

- 🎯 **3x3 网格布局**：8个方向的平衡测试传感器实时显示
- 📊 **多通信模式**：Wi-Fi HTTP + USB串口双备份通信
- 🎮 **手动测距控制**：点击任意方向卡片进行即时测量
- 🔍 **UDP设备发现**：自动发现和连接ESP32设备
- 📡 **实时数据可视化**：动态距离显示和锁定状态高亮
- 📝 **完整日志系统**：传感器数据、设备连接、命令交互记录
- 🔄 **模拟数据测试**：内置开发控制台，支持数据模拟
- 🎨 **现代化UI**：优化布局，状态标签纵向排列，手动测距悬浮按钮

## 界面布局

### 3x3 网格布局
应用采用3x3网格布局，对应平衡测试系统的8个方向：

```
FL  F   FR
L  LOGO R
BL  B   BR
```

- **FL/FR/BL/BR**: 四个斜方向传感器
- **F/B**: 前后方向传感器
- **L/R**: 左右方向传感器
- **中间区域**: SEBT Logo和系统状态

### 方位数据结构
使用以下映射关系构建组件，对应硬件的I2C通道：

```javascript
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
```

### 数据可视化
- **默认状态**: 灰色显示 "--- mm"
- **数据接收**: 绿色高亮显示距离数值
- **动画效果**: 数据更新时有视觉反馈

### 侧边栏日志
- 实时显示传感器数据接收记录
- 包含时间戳、方向和距离数值
- 自动滚动到最新记录
- 支持日志清理功能

## ⚠️ 重要提醒

**在使用SEBT软件之前，请务必关闭 Arduino IDE 的串口监视器！**

串口监视器会独占串口端口，导致SEBT软件无法连接到ESP32设备。

### 关闭串口监视器的步骤：
1. 在Arduino IDE中，如果串口监视器正在运行
2. 点击 **"工具" → "串口监视器"** 或按 `Ctrl+Shift+M`
3. **关闭串口监视器窗口**
4. 然后启动SEBT软件

## 安装依赖

```bash
npm install
```

## 运行应用

### 生产模式

```bash
npm start
```

### 开发模式

```bash
npm run dev
```

**开发模式特性：**
- ✅ **智能热重载**：监控文件变化自动重启应用
- ✅ **多文件监控**：同时监控 main.js、app.js、index.html 等关键文件
- ✅ **防抖重启**：文件变化后500ms防抖，避免频繁重启
- ✅ **进程管理**：自动停止旧进程，启动新进程
- ✅ **开发者工具**：可通过环境变量控制打开Chrome DevTools
- ✅ **模拟数据**：内置开发控制台，可模拟传感器数据

**开发者工具控制：**
```bash
# 默认不打开开发者工具
npm run dev

# 如需打开开发者工具，设置环境变量
DEVTOOLS=1 npm run dev
```

## 使用说明

### 界面操作
1. **查看传感器数据**: 观察3x3网格中各个方位的实时距离数据
2. **手动测距**: 点击任意方向卡片，出现测距按钮后点击进行即时测量
3. **查看日志**: 在右侧边栏查看详细的数据接收和命令交互记录
4. **模拟数据**: 点击"模拟8方向数据"按钮同时更新所有方向的测试数据
5. **清空日志**: 点击"清空日志"按钮清除所有日志记录

### 通信模式
应用支持两种通信模式，自动检测和切换：

#### 无线模式 (Wi-Fi + BLE)
- ESP32通过Wi-Fi连接到PC网络
- UDP广播自动发现设备
- HTTP POST实时数据传输
- BLE连接FSR从机 (可选)

#### 有线模式 (USB串口)
- ESP32直接通过USB连接PC
- 自动检测串口设备
- 自定义协议数据传输
- 支持手动测距命令
- BLE连接可选，支持无从机独立工作

### 硬件连接
1. **启动应用**: 运行 `npm start`
2. **检查IP**: 查看界面右上角显示的本机IP地址
3. **配置ESP32**: 在ESP32代码中使用以下地址发送数据：
   - `http://sebt-server.local:3000/upload` (自动发现)
   - `http://[显示的IP]:3000/upload` (直接连接)
4. **发送数据**: 使用POST请求发送JSON格式的传感器数据

### 数据格式示例
```javascript
// ESP32 Arduino代码示例
#include <HTTPClient.h>
#include <WiFi.h>

void sendSensorData(String direction, int distance) {
  HTTPClient http;
  http.begin("http://sebt-server.local:3000/upload");
  http.addHeader("Content-Type", "application/json");

  String jsonData = "{";
  jsonData += "\"direction\":\"" + direction + "\",";
  jsonData += "\"distance\":" + String(distance) + ",";
  jsonData += "\"ip\":\"" + WiFi.localIP().toString() + "\"";
  jsonData += "}";

  int httpResponseCode = http.POST(jsonData);
  if (httpResponseCode > 0) {
    Serial.println("数据发送成功");
  }
  http.end();
}
```

### 开发调试
- 打开开发者工具查看控制台输出
- 使用全局变量 `window.sebtApp` 访问应用实例
- 调用 `sebtApp.simulateSensorData()` 手动触发8方向模拟数据
- API接口会返回详细的错误信息便于调试

## 项目结构

```
sebt-dashboard/
├── main.js              # Electron 主进程文件
├── app.js               # 渲染进程主应用逻辑
├── index.html           # 主界面HTML
├── package.json         # 项目配置
└── README.md           # 项目文档
```

## 硬件连接

### ⚠️ 串口连接注意事项

在使用有线USB模式时，请确保：

1. **关闭Arduino IDE串口监视器** - 它是导致连接失败的最常见原因
2. **检查串口权限** - 确保用户有访问串口的权限
3. **避免端口冲突** - 不要同时运行多个串口程序

### 服务器功能
- **Express服务器**: 监听3000端口，接收HTTP数据
- **UDP设备发现**: 监听4210端口，实现Wi-Fi设备自动发现
- **USB串口通信**: 自动检测ESP32串口设备，建立有线通信
- **API接口**: `POST /upload` 接收JSON数据 `{direction, distance, ip}`
- **串口命令**: 支持手动测距命令 `MEASURE:[channel]`

### 连接方式
支持两种连接方式，系统自动检测和选择最优通信方式：

#### 方式1：Wi-Fi无线连接 (推荐)
```
UDP广播: 端口4210
消息格式: "SEBT_HOST;3000;ESP32-C3"
```
ESP32通过Wi-Fi连接，UDP广播发现，HTTP数据传输。

#### 方式2：USB有线连接 (备份)
```
串口通信: 115200波特率
数据包格式: [TYPE][LENGTH][DATA...][CHECKSUM]
```
ESP32直接USB连接PC，自定义协议通信，支持BLE可选。

#### 连接机制
1. **自动检测**: 启动时同时监听UDP和扫描串口设备
2. **Wi-Fi优先**: 检测到UDP广播时建立Wi-Fi连接
3. **有线备份**: 未检测到Wi-Fi时自动切换到USB串口
4. **状态同步**: OLED显示当前连接状态和模式
5. **无缝切换**: 支持运行时通信模式切换

#### 故障排除
- **串口连接失败**: 确认Arduino IDE串口监视器已关闭
- **端口被占用**: 检查是否有其他程序正在使用该串口
- **权限问题**: 以管理员身份运行或检查串口权限设置

### 数据格式
```json
{
  "direction": "F",
  "distance": 800,
  "ip": "192.168.1.100"
}
```

#### 支持的方向代码
- `"L"`: 左
- `"R"`: 右
- `"F"`: 前
- `"B"`: 后
- `"FL"`: 左前
- `"FR"`: 右前
- `"BL"`: 左后
- `"BR"`: 右后

### 测试接口
```bash
# 测试数据上传
curl -X POST http://localhost:3000/upload \
  -H "Content-Type: application/json" \
  -d '{"direction":"F","distance":750,"ip":"192.168.1.100"}'

# 检查服务器状态
curl http://localhost:3000/status
```

## 技术栈

- **Electron**: 跨平台桌面应用框架 + IPC进程通信
- **Express**: HTTP服务器框架 + RESTful API
- **UDP套接字**: 设备自动发现和广播通信
- **SerialPort**: USB串口通信和设备控制
- **HTML/CSS/JavaScript**: 现代化响应式前端界面
- **Node.js**: 后端运行环境 + 多协议支持
- **Arduino**: ESP32固件开发框架
- **BLE GATT**: 低功耗蓝牙通信协议

## 许可证

ISC License
