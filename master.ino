/*
 * SEBT Host Hardware Test (v5.0 - WiFi UDP Connection)
 * 硬件：ESP32-C3, TCA9548A, 8x VL53L1X, SH1106 OLED
 * 功能：距离测量 + 3秒锁定 + WiFi UDP双向连接
 */

#include <Wire.h>
#include <SPI.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SH110X.h>
#include <Adafruit_VL53L1X.h>
#include <WiFi.h>
#include <WiFiUdp.h>
#include <HTTPClient.h>

// --- 前向声明 ---
void initDiscoveryService();
void initUDP();

// --- 1. 硬件引脚定义 ---
#define SDA_PIN 8
#define SCL_PIN 9
#define MUX_ADDR 0x70

// RGB LED (共阴, 高电平亮)
#define PIN_LED_R 5
#define PIN_LED_G 6
#define PIN_LED_B 7

// 按键 (低电平触发)
#define PIN_BTN 2

// OLED 设置
#define SCREEN_ADDRESS 0x3C
Adafruit_SH1106G display = Adafruit_SH1106G(128, 64, &Wire, -1);

// ToF 传感器对象
Adafruit_VL53L1X vl53 = Adafruit_VL53L1X();

// --- 2. WiFi网络配置 ---
const char* WIFI_SSID = "HONOR 30 Pro";
const char* WIFI_PASSWORD = "88888888!";

// --- 3. UDP通信配置 ---
WiFiUDP udp;
const unsigned int UDP_PORT = 4210;
const unsigned int BROADCAST_PORT = 4210;
const unsigned int HTTP_PORT = 3000;
IPAddress broadcastIP;

// --- 4. 逻辑参数 ---
const int STABLE_TIME_MS = 3000;  // 锁定时间3秒
const int FILTER_MAX_MM = 2000;   // 超过这个距离忽略
const int FILTER_MIN_MM = 30;     // 小于这个距离忽略(噪音)

// --- 5. 方向映射 ---
const char* DIR_NAMES[8] = {
  "Left",         // 0
  "BackLeft",    // 1
  "FrontLeft",   // 2
  "Front",        // 3
  "Back",         // 4
  "BackRight",   // 5
  "FrontRight",  // 6
  "Right"         // 7
};

// --- 6. 网络状态枚举 ---
enum NetworkStatus {
  NET_DISCONNECTED,      // 未连接
  NET_CONNECTED_WIFI,    // WiFi已连接，等待PC
  NET_CONNECTED_FOUND    // PC已找到，可以通信
};

// --- 7. 全局变量 ---
int distances[8];
int minIndex = -1;
int minDistance = 9999;

// 状态控制
bool isLocked = false;
int lastCandidateIndex = -1;
unsigned long stableStartTime = 0;

// 网络状态
NetworkStatus networkStatus = NET_DISCONNECTED;
String pcServerIP = "";

// 数据发送控制
unsigned long lastDataSendTime = 0;
const unsigned long DATA_SEND_INTERVAL = 1000; // 1秒发送一次

// --- 辅助函数：切换Mux通道 ---
void tcaSelect(uint8_t i) {
  if (i > 7) return;
  Wire.beginTransmission(MUX_ADDR);
  Wire.write(1 << i);
  Wire.endTransmission();
}

// --- 辅助函数：设置RGB ---
void setRGB(bool r, bool g, bool b) {
  digitalWrite(PIN_LED_R, r);
  digitalWrite(PIN_LED_G, g);
  digitalWrite(PIN_LED_B, b);
}

// --- WiFi连接初始化 ---
bool initWiFi() {
  Serial.println("Connecting to WiFi...");
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  int attempts = 0;
  while (WiFi.status() != WL_CONNECTED && attempts < 20) {
    delay(500);
    Serial.print(".");
    attempts++;
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("\nWiFi connected!");
    Serial.print("IP: ");
    Serial.println(WiFi.localIP());

    // 计算广播地址
    IPAddress localIP = WiFi.localIP();
    IPAddress subnet = WiFi.subnetMask();
    broadcastIP = IPAddress(localIP[0] | (~subnet[0] & 0xFF),
                            localIP[1] | (~subnet[1] & 0xFF),
                            localIP[2] | (~subnet[2] & 0xFF),
                            localIP[3] | (~subnet[3] & 0xFF));

    // 初始化UDP
    udp.begin(UDP_PORT);

    networkStatus = NET_CONNECTED_WIFI;
    return true;
  } else {
    Serial.println("\nWiFi connection failed!");
    networkStatus = NET_DISCONNECTED;
    return false;
  }
}

// --- UDP初始化函数 ---
void initUDP() {
  Serial.println("Initializing UDP broadcast...");
  udp.begin(UDP_PORT);
  Serial.printf("UDP listening started on port %d\n", UDP_PORT);

  // 计算广播地址
  IPAddress localIP = WiFi.localIP();
  IPAddress subnet = WiFi.subnetMask();
  broadcastIP = IPAddress(localIP[0] | (~subnet[0] & 0xFF),
                          localIP[1] | (~subnet[1] & 0xFF),
                          localIP[2] | (~subnet[2] & 0xFF),
                          localIP[3] | (~subnet[3] & 0xFF));

  Serial.printf("Broadcast IP calculated: %s\n", broadcastIP.toString().c_str());
}

// --- 设备发现服务初始化 ---
void initDiscoveryService() {
  Serial.println("Starting device discovery...");

  // 广播设备存在
  Serial.println("Broadcasting device presence...");
  broadcastPresence();

  // 等待PC确认消息，最多等待5秒
  Serial.println("Waiting for PC confirmation (5 seconds)...");
  Serial.printf("ESP32 IP: %s, listening on UDP port %d\n", WiFi.localIP().toString().c_str(), UDP_PORT);
  unsigned long waitStart = millis();

  bool pcConfirmed = false;
  while (millis() - waitStart < 5000 && !pcConfirmed) {
    checkUDPMessage();

    if (networkStatus == NET_CONNECTED_FOUND) {
      pcConfirmed = true;
      Serial.println("PC confirmed via UDP!");
      break;
    }

    // 每秒打印一次等待状态
    if ((millis() - waitStart) % 1000 == 0) {
      Serial.printf("Waiting for UDP confirmation... (%d/%d seconds)\n",
                   (millis() - waitStart) / 1000, 5);
    }

    delay(100);
  }

  if (!pcConfirmed) {
    Serial.println("UDP confirmation timeout, trying fallback HTTP test...");

    // Fallback: 尝试连接到可能的PC IP
    IPAddress localIP = WiFi.localIP();
    IPAddress subnet = WiFi.subnetMask();

    // 尝试几个常见的IP地址
    IPAddress possiblePCs[] = {
      IPAddress(localIP[0], localIP[1], localIP[2], 1),   // .1
      IPAddress(localIP[0], localIP[1], localIP[2], 100), // .100
      IPAddress(localIP[0], localIP[1], localIP[2], 138), // .138 (从日志看到的PC IP)
    };

    for (int i = 0; i < 3; i++) {
      Serial.printf("Testing PC at %s:3000...\n", possiblePCs[i].toString().c_str());

      WiFiClient testClient;
      testClient.setTimeout(3000);

      if (testClient.connect(possiblePCs[i], 3000)) {
        testClient.println("GET /status HTTP/1.0");
        testClient.println("Host: sebt-server.local");
        testClient.println("Connection: close");
        testClient.println();

        unsigned long startTime = millis();
        String response = "";
        bool gotResponse = false;

        while (testClient.connected() && (millis() - startTime) < 3000) {
          if (testClient.available()) {
            char c = testClient.read();
            response += c;
            gotResponse = true;
          }
          delay(1);
        }

        testClient.stop();

        if (gotResponse && (response.indexOf("SEBT") >= 0 || response.indexOf("200 OK") >= 0)) {
          pcServerIP = possiblePCs[i].toString();
          networkStatus = NET_CONNECTED_FOUND;
          Serial.printf("PC found via HTTP fallback at %s!\n", pcServerIP.c_str());
          pcConfirmed = true;
          break;
        }
      }
    }

    if (!pcConfirmed) {
      Serial.println("Fallback HTTP test also failed, staying in search mode");
      networkStatus = NET_CONNECTED_WIFI;
    }
  }
}

// --- UDP广播自身存在 ---
void broadcastPresence() {
  if (WiFi.status() != WL_CONNECTED) return;

  String message = "SEBT_HOST;";
  message += String(HTTP_PORT);
  message += ";ESP32-C3";

  udp.beginPacket(broadcastIP, BROADCAST_PORT);
  udp.print(message);
  udp.endPacket();

  Serial.printf("[UDP] Broadcast: %s\n", message.c_str());
}

// --- 检查UDP消息 ---
void checkUDPMessage() {
  int packetSize = udp.parsePacket();
  if (packetSize) {
    Serial.printf("[UDP] Received %d bytes from %s:%d\n",
                 packetSize, udp.remoteIP().toString().c_str(), udp.remotePort());

    char incomingPacket[255];
    int len = udp.read(incomingPacket, 255);
    if (len > 0) {
      incomingPacket[len] = 0;
      String message = String(incomingPacket);
      Serial.printf("Message: %s\n", message.c_str());

      // 解析PC确认消息: PC_CONFIRMED;<PC_IP>;<PC_PORT>;PC-Server
      if (message.startsWith("PC_CONFIRMED;")) {
        int firstSemicolon = message.indexOf(';');
        int secondSemicolon = message.indexOf(';', firstSemicolon + 1);

        if (firstSemicolon > 0 && secondSemicolon > firstSemicolon) {
          String pcIP = message.substring(firstSemicolon + 1, secondSemicolon);
          pcServerIP = pcIP;
          networkStatus = NET_CONNECTED_FOUND;

          Serial.printf("[SUCCESS] PC confirmed! IP: %s\n", pcServerIP.c_str());
        }
      }
    }
  }
}

// --- 发送实时数据到PC ---
void sendRealtimeDataToPC(int directionIndex, int distance) {
  if (networkStatus != NET_CONNECTED_FOUND || pcServerIP == "") {
    return;
  }

  HTTPClient http;
  String serverUrl = "http://" + pcServerIP + ":" + String(HTTP_PORT) + "/realtime";

  http.setTimeout(1000);
  http.begin(serverUrl);
  http.addHeader("Content-Type", "application/json");

  // 构建JSON数据
  String jsonData = "{";
  jsonData += "\"direction\":" + String(directionIndex) + ",";
  jsonData += "\"distance\":" + String(distance) + ",";
  jsonData += "\"isLocked\":";
  jsonData += (isLocked ? "true" : "false");
  jsonData += "}";

  int httpResponseCode = http.POST(jsonData);

  if (httpResponseCode > 0) {
    Serial.printf("[DATA] Sent to PC: dir=%d, dist=%dmm\n", directionIndex, distance);
  } else {
    Serial.printf("[ERROR] Send failed: %d\n", httpResponseCode);
  }

  http.end();
}

// --- 发送锁定数据到PC ---
void sendLockDataToPC(int directionIndex, int distance) {
  if (networkStatus != NET_CONNECTED_FOUND || pcServerIP == "") {
    return;
  }

  HTTPClient http;
  String serverUrl = "http://" + pcServerIP + ":" + String(HTTP_PORT) + "/upload";

  http.setTimeout(2000);
  http.begin(serverUrl);
  http.addHeader("Content-Type", "application/json");

  // 构建完整数据
  String jsonData = "{";
  jsonData += "\"locked\":true,";
  jsonData += "\"direction\":" + String(directionIndex) + ",";
  jsonData += "\"directionName\":\"" + String(DIR_NAMES[directionIndex]) + "\",";
  jsonData += "\"distance\":" + String(distance) + ",";
  jsonData += "\"timestamp\":" + String(millis());
  jsonData += "}";

  int httpResponseCode = http.POST(jsonData);

  if (httpResponseCode > 0) {
    Serial.println("[LOCK] Lock data sent to PC!");
  } else {
    Serial.printf("[ERROR] Lock send failed: %d\n", httpResponseCode);
  }

  http.end();
}

void setup() {
  Serial.begin(115200);

  // 初始化引脚
  pinMode(PIN_LED_R, OUTPUT);
  pinMode(PIN_LED_G, OUTPUT);
  pinMode(PIN_LED_B, OUTPUT);
  pinMode(PIN_BTN, INPUT_PULLUP);

  setRGB(1, 0, 0); // 红灯亮
  Wire.begin(SDA_PIN, SCL_PIN);

  // OLED 初始化
  if (!display.begin(SCREEN_ADDRESS, true)) {
    Serial.println("OLED init failed");
    for(int i=0; i<5; i++) {
      setRGB(0,0,0); delay(100);
      setRGB(1,0,0); delay(100);
    }
  }

  display.clearDisplay();
  display.setTextSize(1);
  display.setTextColor(SH110X_WHITE);
  display.setCursor(0,0);
  display.println("SEBT Host v5.0");
  display.println("System Booting...");
  display.display();
  delay(1000);

  // WiFi初始化
  if (!initWiFi()) {
    display.println("WiFi FAILED!");
    display.display();
    delay(2000);
  } else {
    // 设备发现服务初始化（UDP连接PC）
    display.println("Init Discovery...");
    display.display();
    initDiscoveryService();

    // UDP广播初始化
    display.println("Init UDP...");
    display.display();
    initUDP();
  }

  // 传感器初始化
  display.println("Init Sensors...");
  display.display();

  for (int i = 0; i < 8; i++) {
    tcaSelect(i);
    display.printf("S%d: ", i);

    if (!vl53.begin(0x29, &Wire)) {
      display.println("FAIL");
      Serial.printf("Sensor %d init failed\n", i);
    } else {
      vl53.startRanging();
      vl53.setTimingBudget(50); // 高速模式
      display.println("OK");
      Serial.printf("Sensor %d ready\n", i);
    }
    display.display();
    delay(100);
  }

  display.println("Ready!");
  display.display();
  delay(1000);
}

void loop() {
  // --- 0. 网络连接状态检查和自动重连 ---
  if (WiFi.status() != WL_CONNECTED) {
    // WiFi断开，尝试重连
    Serial.println("WiFi disconnected, attempting reconnection...");
    networkStatus = NET_DISCONNECTED;

    // 显示重连状态
    display.clearDisplay();
    display.setCursor(0, 0);
    display.println("WiFi Lost");
    display.println("Reconnecting...");
    display.display();

    // 尝试重连WiFi
    if (initWiFi()) {
      // WiFi重连成功，重新初始化设备发现和UDP
      Serial.println("WiFi reconnected, reinitializing discovery service...");

      display.clearDisplay();
      display.setCursor(0, 0);
      display.println("WiFi OK");
      display.println("Init Discovery...");
      display.display();

      initDiscoveryService();
      initUDP();

      display.println("Ready!");
      display.display();
      delay(1000);
    } else {
      // WiFi重连失败
      Serial.println("WiFi reconnection failed");
      display.clearDisplay();
      display.setCursor(0, 0);
      display.println("WiFi FAILED!");
      display.println("Check network");
      display.display();
      delay(2000);
    }
  }

  // --- 1. 检查UDP消息 ---
  checkUDPMessage();

  // --- 1. 按钮复位逻辑 ---
  if (digitalRead(PIN_BTN) == LOW) {
    isLocked = false;
    lastCandidateIndex = -1;
    setRGB(1, 0, 0);
    display.clearDisplay();
    display.setCursor(0, 20);
    display.setTextSize(2);
    display.println("RESET...");
    display.display();
    delay(500);
    return;
  }

  // --- 2. 定期UDP广播 (每5秒) ---
  static unsigned long lastBroadcastTime = 0;
  if (networkStatus >= NET_CONNECTED_WIFI &&
      millis() - lastBroadcastTime >= 5000) {
    broadcastPresence();
    lastBroadcastTime = millis();
  }

  // --- 3. 扫描所有传感器 ---
  minDistance = 9999;
  minIndex = -1;

  for (int i = 0; i < 8; i++) {
    tcaSelect(i);

    if (vl53.dataReady()) {
      int d = vl53.distance();
      if (d == -1) d = 9999;
      distances[i] = d;
      vl53.clearInterrupt();
    }

    if (distances[i] > FILTER_MIN_MM && distances[i] < FILTER_MAX_MM) {
      if (distances[i] < minDistance) {
        minDistance = distances[i];
        minIndex = i;
      }
    }
  }

  // --- 4. 发送实时数据到PC ---
  if (networkStatus == NET_CONNECTED_FOUND &&
      millis() - lastDataSendTime >= DATA_SEND_INTERVAL) {

    if (minIndex != -1) {
      sendRealtimeDataToPC(minIndex, minDistance);
    }
    lastDataSendTime = millis();
  }

  // --- 5. 锁定判断逻辑 ---
  if (!isLocked) {
    // 根据网络状态设置LED
    if (networkStatus == NET_CONNECTED_FOUND) {
      setRGB(1, 0, 0); // 红灯 (扫描中，已连接PC)
    } else {
      setRGB(1, 1, 0); // 黄灯 (等待PC连接)
    }

    if (minIndex != -1) {
      if (minIndex == lastCandidateIndex) {
        if (millis() - stableStartTime > STABLE_TIME_MS) {
          isLocked = true;
          setRGB(0, 0, 1); // 蓝灯 (锁定!)

          // 发送锁定数据到PC
          if (networkStatus == NET_CONNECTED_FOUND) {
            sendLockDataToPC(lastCandidateIndex, distances[lastCandidateIndex]);
          }
        }
      } else {
        lastCandidateIndex = minIndex;
        stableStartTime = millis();
      }
    } else {
      lastCandidateIndex = -1;
    }
  }

  // --- 6. OLED 显示逻辑 (原始逻辑，保持稳定) ---
  display.clearDisplay();

  if (isLocked) {
    // === 锁定状态 ===
    display.setCursor(0, 0);
    display.setTextSize(1);
    display.println("Target Locked:");

    display.setTextSize(2);
    display.setCursor(0, 16);
    display.println(DIR_NAMES[lastCandidateIndex]);

    display.setTextSize(3);
    display.setCursor(0, 40);
    display.print(distances[lastCandidateIndex]);
    display.setTextSize(1);
    display.print(" mm");

    // 显示网络状态
    display.setCursor(80, 0);
    display.setTextSize(1);
    if (networkStatus == NET_CONNECTED_FOUND) {
      display.println("NET:PC");
    } else {
      display.println("NET:--");
    }

  } else {
    // === 扫描状态 ===
    display.setCursor(0, 0);
    display.setTextSize(1);

    if (networkStatus == NET_CONNECTED_FOUND) {
      display.println("Scanning...");
    } else {
      display.println("Waiting for PC...");
    }

    if (minIndex != -1) {
      display.setCursor(0, 20);
      display.print("Nearest: ");
      display.println(DIR_NAMES[minIndex]);

      display.setCursor(0, 35);
      display.setTextSize(2);
      display.print(minDistance);
      display.print(" mm");

      // 显示进度条
      if (lastCandidateIndex != -1 && minIndex == lastCandidateIndex) {
        long elapsed = millis() - stableStartTime;
        int barWidth = map(elapsed, 0, STABLE_TIME_MS, 0, 128);
        if (barWidth > 128) barWidth = 128;

        display.drawRect(0, 55, 128, 6, SH110X_WHITE);
        display.fillRect(0, 55, barWidth, 6, SH110X_WHITE);
      }
    } else {
      display.setCursor(0, 25);
      display.println("No Object");
    }

    // 显示网络状态
    display.setCursor(80, 0);
    display.setTextSize(1);
    if (networkStatus == NET_CONNECTED_FOUND) {
      display.println("NET:PC");
    } else {
      display.println("NET:--");
    }
  }

  display.display(); // 刷新屏幕
}
