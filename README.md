# SEBT 平衡测试系统

一个基于 Electron 的桌面平衡测试数据看板应用。

## 项目简介

SEBT Dashboard 是专为 "SEBT v4.0 平衡测试系统" 打造的现代化桌面仪表板应用，提供实时的传感器数据显示和日志记录功能。

## 核心功能

- 🎯 **3x3 网格布局**：模拟8个方向的平衡测试传感器
- 📊 **实时数据可视化**：动态显示距离数据，支持颜色编码
- 📝 **实时日志记录**：完整的传感器数据接收日志
- 🔄 **模拟数据测试**：内置开发控制台，可模拟传感器数据
- 🎨 **现代化UI**：基于CSS的明亮主题设计

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
1. **查看传感器数据**: 观察3x3网格中各个方位的实时数据
2. **查看日志**: 在右侧边栏查看详细的数据接收记录
3. **模拟数据**: 点击"模拟8方向数据"按钮同时更新所有方向的测试数据
4. **清空日志**: 点击"清空日志"按钮清除所有日志记录

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

### 服务器功能
- **Express服务器**: 监听3000端口，接收硬件数据
- **UDP设备发现**: 监听4210端口，实现设备自动发现
- **API接口**: `POST /upload` 接收JSON数据 `{direction, distance, ip}`
- **状态接口**: `GET /status` 检查服务器运行状态

### 连接方式
ESP32硬件通过UDP广播方式连接：

#### 方式1：UDP广播发现（推荐）
```
UDP广播: 端口4210
消息格式: "SEBT_HOST;IP;PORT;DEVICE_INFO"
```
ESP32主动广播自身信息，PC监听并自动发现设备。

#### 连接机制
1. **ESP32广播**：ESP32每3秒通过UDP广播自身IP和端口信息
2. **PC监听**：PC监听4210端口，接收ESP32广播
3. **自动验证**：PC通过HTTP请求验证ESP32设备可用性
4. **连接建立**：验证成功后建立数据通信连接

无需手动配置IP地址，系统自动发现和连接设备。

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

- **Electron**: 跨平台桌面应用框架
- **Express**: HTTP服务器框架
- **UDP广播**: 设备自动发现协议
- **HTML/CSS/JavaScript**: 前端界面
- **Node.js**: 后端运行环境

## 许可证

ISC License
