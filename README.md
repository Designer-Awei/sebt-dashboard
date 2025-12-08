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

## 使用说明

### 界面操作
1. **查看传感器数据**: 观察3x3网格中各个方位的实时数据
2. **查看日志**: 在右侧边栏查看详细的数据接收记录
3. **模拟数据**: 点击"模拟数据"按钮随机生成测试数据
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
- 调用 `sebtApp.simulateSensorData()` 手动触发模拟数据
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
- **mDNS广播**: 服务名 `sebt-server.local`，实现免配置连接
- **API接口**: `POST /upload` 接收JSON数据 `{direction, distance, ip}`
- **状态接口**: `GET /status` 检查服务器运行状态

### 连接方式
ESP32硬件可以通过以下方式连接：

#### 方式1：mDNS自动发现（推荐）
```
http://sebt-server.local:3000/upload
```
无需输入IP地址，系统会自动发现服务。

#### 方式2：直接IP连接
```
http://[本机IP]:3000/upload
```
本机IP会在应用界面右上角显示。

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
- **multicast-dns**: mDNS服务发现协议
- **HTML/CSS/JavaScript**: 前端界面
- **Node.js**: 后端运行环境

## 许可证

ISC License