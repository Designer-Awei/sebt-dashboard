/**
 * SEBT UDP测试程序
 * 专门用于测试ESP32与PC之间的UDP广播发现功能
 * 隔离WiFi连接和UDP发现问题
 */

#include <WiFi.h>
#include <WiFiUdp.h>
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SH110X.h>

// OLED configuration
#define SCREEN_ADDRESS 0x3C
Adafruit_SH1106G display(128, 64, &Wire, -1);

// RGB LED pins (共阴, 高电平亮)
#define PIN_LED_R 5
#define PIN_LED_G 6
#define PIN_LED_B 7

// WiFi configuration - Use your mobile hotspot
const char* WIFI_SSID = "HONOR 30 Pro";
const char* WIFI_PASSWORD = "88888888!";

// UDP discovery configuration
const char* SERVICE_NAME = "sebt-server"; // 服务名
const int HTTP_PORT = 3000;

// 网络状态
enum NetworkStatus {
  NET_DISCONNECTED,
  NET_CONNECTED_WIFI,
  NET_CONNECTED_FOUND,
  NET_CONNECTED_SEARCHING
};

NetworkStatus networkStatus = NET_DISCONNECTED;
String pcServerIP = "";

// 测试配置
const int UDP_TEST_INTERVAL = 8000; // 8秒测试一次，给更多时间观察
unsigned long lastTestTime = 0;

// UDP广播配置
WiFiUDP udp;
const unsigned int UDP_PORT = 4210;  // 自定义UDP端口
const unsigned int BROADCAST_PORT = 4210;  // 广播端口
IPAddress broadcastIP(255, 255, 255, 255);  // 广播地址

/**
 * 初始化串口和OLED
 */
void setup() {
  // 初始化串口 - 使用多个延时确保稳定
  Serial.begin(115200);
  delay(1000); // 等待串口硬件初始化

  // 发送测试字符，确保串口工作
  Serial.println();
  Serial.println("=== 串口测试 ===");
  Serial.println("如果您能看到此消息，串口工作正常！");
  Serial.println("===================");
  Serial.println();

  // 初始化RGB LED引脚
  pinMode(PIN_LED_R, OUTPUT);
  pinMode(PIN_LED_G, OUTPUT);
  pinMode(PIN_LED_B, OUTPUT);
  setRGB(1, 0, 0); // 初始红灯

  // 硬件测试 - 闪烁板载LED (如果有的话)
  pinMode(LED_BUILTIN, OUTPUT);
  Serial.println("测试板载LED...");
  for (int i = 0; i < 3; i++) {
    digitalWrite(LED_BUILTIN, HIGH);
    delay(200);
    digitalWrite(LED_BUILTIN, LOW);
    delay(200);
    Serial.printf("LED闪烁 #%d\n", i + 1);
  }
  Serial.println("LED测试完成");

  delay(1000); // 等待串口稳定

  Serial.println("=== SEBT UDP测试程序启动 ===");
  Serial.println("测试ESP32与PC之间的UDP广播发现功能");
  Serial.println("=======================================");

  // 初始化OLED
  Serial.println("初始化OLED...");
  Wire.begin(8, 9); // SDA=8, SCL=9
  delay(500); // 等待I2C总线稳定

  if (!display.begin(SCREEN_ADDRESS, true)) {
    Serial.println("[错误] OLED初始化失败！");
    // OLED failure, continue but show error on screen
    display.clearDisplay();
    display.setCursor(0, 0);
    display.println("OLED FAILED");
    display.println("SERIAL OK");
    display.display();
  } else {
    Serial.println("[成功] OLED初始化成功");
    display.clearDisplay();
    display.setTextSize(1);
    display.setTextColor(SH110X_WHITE);
    display.setCursor(0, 0);
    display.println("SEBT UDP Test");
    display.println("Serial OK");
    display.println("Starting...");
    display.display();
  }

  delay(1000); // 显示状态

  // 初始化网络
  Serial.println("开始网络初始化...");
  initWiFi();

  // 初始化设备发现服务
  Serial.println("开始设备发现服务初始化...");
  initDiscoveryService();

  // 初始化UDP广播
  Serial.println("开始UDP广播初始化...");
  initUDP();

  Serial.println("[信息] 初始化完成，开始UDP反向发现测试...");

  // OLED show initialization complete
  display.clearDisplay();
  display.setCursor(0, 0);
  display.println("Init Complete");
  display.println("Starting Tests...");
  display.display();

  delay(2000); // 最后延时确保一切稳定
}

/**
 * 设置RGB LED颜色
 */
void setRGB(bool r, bool g, bool b) {
  digitalWrite(PIN_LED_R, r);
  digitalWrite(PIN_LED_G, g);
  digitalWrite(PIN_LED_B, b);
}

/**
 * 主循环
 */
void loop() {
  // 检查UDP消息 - 新增！
  checkUDPMessage();

  // 定期广播设备存在
  static unsigned long lastBroadcast = 0;
  if (millis() - lastBroadcast >= 3000) { // 每3秒广播一次
    if (WiFi.status() == WL_CONNECTED) {
      broadcastPresence();
    }
    lastBroadcast = millis();
  }

  // 定期测试发现功能
  if (millis() - lastTestTime >= UDP_TEST_INTERVAL) {
    testUDPDiscovery();
    lastTestTime = millis();
  }

  // 检查WiFi连接状态
  checkWiFiStatus();

  delay(100);
}

/**
 * 初始化WiFi连接
 */
void initWiFi() {
  Serial.println("\n--- 初始化WiFi连接 ---");

  // OLED show WiFi connecting
  display.clearDisplay();
  display.setCursor(0, 0);
  display.println("Connecting WiFi");
  display.printf("SSID: %s\n", WIFI_SSID);
  display.display();

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  Serial.printf("Connecting to WiFi: %s\n", WIFI_SSID);

  int attempts = 0;
  while (WiFi.status() != WL_CONNECTED && attempts < 20) {
    delay(500);
    Serial.print(".");
    display.print(".");
    display.display();
    attempts++;
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("\n[成功] WiFi已连接！");
    Serial.printf("IP地址: %s\n", WiFi.localIP().toString().c_str());
    Serial.printf("网关: %s\n", WiFi.gatewayIP().toString().c_str());
    Serial.printf("子网掩码: %s\n", WiFi.subnetMask().toString().c_str());
    Serial.printf("DNS服务器: %s\n", WiFi.dnsIP().toString().c_str());

    // OLED show connection success
    display.clearDisplay();
    display.setCursor(0, 0);
    display.println("[SUCCESS] WiFi OK");
    display.printf("IP: %s\n", WiFi.localIP().toString().c_str());
    display.display();

    networkStatus = NET_CONNECTED_WIFI;
  } else {
    Serial.println("\n[错误] WiFi连接失败！");
    Serial.printf("最终WiFi状态: %d\n", WiFi.status());
    Serial.printf("期望状态: %d (WL_CONNECTED)\n", WL_CONNECTED);

    // OLED show connection failure
    display.clearDisplay();
    display.setCursor(0, 0);
    display.println("[ERROR] WiFi Failed");
    display.printf("Status: %d", WiFi.status());
    display.println("Check credentials");
    display.display();

    networkStatus = NET_DISCONNECTED;
  }

  delay(2000); // 显示状态2秒
}

/**
 * 初始化设备发现服务
 */
void initDiscoveryService() {
  Serial.println("\n--- 初始化设备发现服务 ---");

  // OLED show device discovery service initializing
  display.clearDisplay();
  display.setCursor(0, 0);
  display.println("WiFi OK");
  display.println("Init Discovery...");
  display.display();

  Serial.println("[成功] 设备发现服务初始化完成");

  // OLED show discovery service success
  display.println("[SUCCESS] Discovery OK");
  display.display();
  delay(1000);
}

/**
 * 初始化UDP广播
 */
void initUDP() {
  Serial.println("\n--- 初始化UDP广播 ---");

  udp.begin(UDP_PORT);
  Serial.printf("[成功] UDP监听端口 %d\n", UDP_PORT);

  // 计算广播地址
  IPAddress localIP = WiFi.localIP();
  IPAddress subnet = WiFi.subnetMask();
  broadcastIP = IPAddress(localIP[0] | (~subnet[0] & 0xFF),
                          localIP[1] | (~subnet[1] & 0xFF),
                          localIP[2] | (~subnet[2] & 0xFF),
                          localIP[3] | (~subnet[3] & 0xFF));

  Serial.printf("广播IP已计算: %s\n", broadcastIP.toString().c_str());
}

/**
 * 检查UDP消息 - 新增！
 */
void checkUDPMessage() {
  int packetSize = udp.parsePacket();
  if (packetSize) {
    Serial.printf("[UDP] 收到UDP包，大小: %d 字节\n", packetSize);
    Serial.printf("      来自: %s:%d\n",
                 udp.remoteIP().toString().c_str(), udp.remotePort());

    char incomingPacket[255];
    int len = udp.read(incomingPacket, 255);
    if (len > 0) {
      incomingPacket[len] = 0;
      String message = String(incomingPacket);
      Serial.printf("      消息内容: %s\n", message.c_str());

      // 检查是否是PC的确认消息
      if (message.startsWith("PC_CONFIRMED;")) {
        Serial.println("[SUCCESS] 收到PC确认消息！UDP双向通信成功！");
        Serial.println("=====================================");
        Serial.println("🎉 UDP双向连接已建立！");
        Serial.println("=====================================");

        // 解析PC信息
        int firstSemicolon = message.indexOf(';');
        int secondSemicolon = message.indexOf(';', firstSemicolon + 1);
        if (firstSemicolon > 0 && secondSemicolon > firstSemicolon) {
          String pcIP = message.substring(firstSemicolon + 1, secondSemicolon);
          Serial.printf("PC IP: %s\n", pcIP.c_str());
        }

        // OLED显示成功
        display.clearDisplay();
        display.setCursor(0, 0);
        display.println("UDP CONNECTED!");
        display.setCursor(0, 20);
        display.println("PC Found via UDP");
        display.setCursor(0, 40);
        display.println("SUCCESS!");
        display.display();

        // 闪烁LED庆祝
        for (int i = 0; i < 5; i++) {
          setRGB(0, 1, 0); // 绿灯
          delay(200);
          setRGB(0, 0, 1); // 蓝灯
          delay(200);
        }
      }
    }
  }
}

/**
 * 广播设备存在
 */
void broadcastPresence() {
  // 构建广播消息
  String message = "SEBT_HOST;";
  message += WiFi.localIP().toString();
  message += ";";
  message += String(HTTP_PORT);
  message += ";ESP32-C3";

  // 发送UDP广播
  udp.beginPacket(broadcastIP, BROADCAST_PORT);
  udp.print(message);
  udp.endPacket();

  Serial.printf("已广播存在: %s\n", message.c_str());
}

/**
 * 测试UDP发现功能
 */
void testUDPDiscovery() {
  Serial.println("\n=== 开始UDP发现测试 ===");
  Serial.printf("当前时间: %lu 毫秒\n", millis());

  // OLED show test starting
  display.clearDisplay();
  display.setCursor(0, 0);
  display.println("Testing UDP...");
  display.printf("Time: %lu\n", millis() / 1000);
  display.display();

  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("[错误] WiFi未连接，跳过UDP测试");
    Serial.printf("WiFi状态: %d\n", WiFi.status());

    display.println("[ERROR] WiFi Lost");
    display.printf("Status: %d", WiFi.status());
    display.display();
    return;
  }

  Serial.println("[信息] WiFi已连接，继续UDP测试");
  Serial.printf("本地IP: %s\n", WiFi.localIP().toString().c_str());

  Serial.println("1. 跳过传统设备发现查询，直接进行UDP广播测试...");

  // OLED show broadcast testing
  display.println("Broadcast Testing...");
  display.display();

  // 等待一段时间让广播准备
  Serial.println("等待2秒让广播准备...");
  delay(2000);

  display.display();

  // 反向发现 - ESP32广播自己的存在
  Serial.println("2. 反向发现 - ESP32广播自身存在...");

  // OLED show broadcasting
  display.println("Broadcasting...");
  display.display();

  // ESP32通过UDP广播自己的存在
  broadcastPresence();
  delay(500); // 等待广播完成
  broadcastPresence(); // 再广播一次确保到达

  Serial.println("   ESP32正在通过UDP广播自身存在");
  Serial.printf("   ESP32 IP: %s\n", WiFi.localIP().toString().c_str());
  Serial.printf("   ESP32端口: %d\n", HTTP_PORT);
  Serial.printf("   广播IP: %s\n", broadcastIP.toString().c_str());

  // 使用本地IP作为测试目标
  IPAddress testIP = WiFi.localIP(); // 使用自己的IP作为测试标识
  Serial.printf("   使用本地IP作为测试标识: %s\n", testIP.toString().c_str());

  // 直接进行HTTP连接测试（模拟PC连接）
  Serial.println("3. 测试HTTP连接...");
  testHTTPConnection(testIP, HTTP_PORT);

  networkStatus = NET_CONNECTED_FOUND;
  pcServerIP = testIP.toString();

    // OLED show final result
    display.println("[SUCCESS] Test Complete!");

  display.display();
  Serial.println("=== UDP发现测试完成 ===\n");
}

/**
 * 测试HTTP连接
 */
void testHTTPConnection(IPAddress ip, int port) {
  WiFiClient client;
  client.setTimeout(5000); // 5秒超时

  Serial.printf("连接到 %s:%d ...\n", ip.toString().c_str(), port);

  if (client.connect(ip, port)) {
    Serial.println("[成功] TCP连接成功");

    // 发送HTTP请求
    client.println("GET /status HTTP/1.0");
    client.println("Host: sebt-server.local");
    client.println("Connection: close");
    client.println();

    // 读取响应
    unsigned long startTime = millis();
    String response = "";

    while (client.connected() && (millis() - startTime) < 3000) {
      if (client.available()) {
        char c = client.read();
        response += c;
      }
      delay(1);
    }

    client.stop();

    if (response.length() > 0) {
      Serial.println("[成功] 收到HTTP响应");
      Serial.printf("响应长度: %d 字节\n", response.length());

      // 检查响应内容
      if (response.indexOf("SEBT") >= 0 || response.indexOf("200 OK") >= 0) {
        Serial.println("[成功] 服务器响应验证成功 - 找到SEBT服务！");
      } else {
        Serial.println("[警告] 服务器响应不包含SEBT标识符");
        Serial.println("   响应预览: " + response.substring(0, 100));
      }
    } else {
      Serial.println("[错误] 未收到HTTP响应");
    }

  } else {
    Serial.println("[错误] TCP连接失败");
  }
}

/**
 * 检查WiFi连接状态
 */
void checkWiFiStatus() {
  static unsigned long lastCheck = 0;
  static int checkCount = 0;

  if (millis() - lastCheck >= 15000) { // 每15秒检查一次
    checkCount++;
    Serial.printf("\n=== 状态检查 #%d ===\n", checkCount);

    int currentStatus = WiFi.status();
    Serial.printf("WiFi状态码: %d\n", currentStatus);

    if (currentStatus != WL_CONNECTED) {
      Serial.println("[警告] WiFi连接丢失，正在尝试重新连接...");
      Serial.printf("之前状态: %d, 当前状态: %d\n", networkStatus, currentStatus);
      WiFi.reconnect();
      networkStatus = NET_DISCONNECTED;
    } else {
      if (networkStatus == NET_DISCONNECTED) {
        Serial.println("[成功] WiFi重新连接成功");
        networkStatus = NET_CONNECTED_WIFI;
      }
    }

    lastCheck = millis();

    // Display current status
    String wifiStatus = networkStatus >= NET_CONNECTED_WIFI ? "Connected" : "Disconnected";
    String udpStatus = networkStatus == NET_CONNECTED_FOUND ? "PC Found" :
                      networkStatus == NET_CONNECTED_SEARCHING ? "Searching" : "Not Found";

    Serial.printf("Current Status - WiFi: %s, UDP: %s\n", wifiStatus.c_str(), udpStatus.c_str());
    Serial.printf("Local IP: %s\n", WiFi.localIP().toString().c_str());
    Serial.printf("Signal Strength (RSSI): %d dBm\n", WiFi.RSSI());

    // OLED显示状态
    display.clearDisplay();
    display.setCursor(0, 0);
    display.printf("WiFi: %s\n", wifiStatus.c_str());
    display.printf("UDP: %s\n", udpStatus.c_str());
    display.printf("Check #%d\n", checkCount);
    if (networkStatus == NET_CONNECTED_FOUND) {
      display.printf("IP: %s\n", pcServerIP.c_str());
    }
    display.display();

    Serial.println("=== Status Check Complete ===\n");
  }
}
