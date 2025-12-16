/*
 * SEBT Host Classic Bluetooth (ESP32-C3 Version)
 * ESP32-C3 + HC-05作为经典蓝牙主机，通过TCA9548A读取8方向TOF传感器数据
 * 经典蓝牙串口通信模式，客户端通过蓝牙串口连接直接接收数据
 * 数据范围: 0-2000mm（仅过滤超出范围的值），发送间隔: 300ms
 * 
 * 硬件配置:
 * - ESP32-C3
 * - TCA9548A I2C多路复用器
 * - 8x VL53L1X TOF传感器
 * - HC-05蓝牙模块
 * 
 * ESP32-C3引脚定义:
 * - I2C SDA: GPIO 8
 * - I2C SCL: GPIO 9
 * - HC-05 RX: GPIO 3 (ESP32接收，HC-05发送)
 * - HC-05 TX: GPIO 4 (ESP32发送，HC-05接收)
 * - LED: GPIO 10 (可选，用于状态指示)
 * 
 * 注意：HC-05已通过Arduino Nano手动配置，不需要EN引脚
 * 配置参数：名称=SEBT-Host-001, 密码=1234, 波特率=9600
 */

#include <Arduino.h>
#include <Wire.h>
#include <VL53L1X.h>

// --- HC-05配置 ---
#define HC05_RX_PIN         3   // HC-05 RXD连接到ESP32的GPIO 3 (ESP32接收)
#define HC05_TX_PIN         4   // HC-05 TXD连接到ESP32的GPIO 4 (ESP32发送)
#define HC05_BAUD_RATE      9600   // 正常通信波特率（HC-05已配置为9600）

// ESP32-C3使用硬件串口Serial1，可以配置自定义引脚
HardwareSerial bluetoothSerial(1); // 使用UART1

// --- TCA9548A配置 ---
#define TCA9548A_ADDR       0x70

// --- TOF传感器配置 ---
#define NUM_SENSORS         8
VL53L1X sensors[8];  // ESP32-C3有足够内存，可以使用对象数组

// --- I2C配置 ---
#define SDA_PIN             8   // ESP32-C3 I2C SDA
#define SCL_PIN             9   // ESP32-C3 I2C SCL

// --- LED配置 ---
#define LED_PIN             10  // ESP32-C3内置LED（如果GPIO10不可用，尝试GPIO8）

// --- 数据过滤参数 ---
// 注意：已取消最小距离限制，避免TOF传感器20mm误差导致的频繁跳变
// 只过滤超出最大范围的值，所有0-2000mm范围内的读数都会发送
#define FILTER_MAX_MM       2000 // 超过这个距离视为无效

// --- 方向映射 ---
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

// --- 全局变量 ---
unsigned long lastSendTime = 0;
unsigned long currentSendInterval = 300; // 当前发送间隔（动态调整）
const unsigned long BASE_SEND_INTERVAL = 300; // 基础发送间隔300ms
const unsigned long MAX_SEND_INTERVAL = 1000; // 最大发送间隔1000ms（缓冲区满时延长）
bool sensorInitialized[8] = {false, false, false, false, false, false, false, false};

// --- 1. TCA9548A控制函数 ---
/**
 * 选择TCA9548A的通道
 * @param channel 通道号 (0-7)
 */
void tcaSelect(uint8_t channel) {
  if (channel > 7) return;
  Wire.beginTransmission(TCA9548A_ADDR);
  Wire.write(1 << channel);
  Wire.endTransmission();
}

// --- 2. HC-05初始化函数 ---
/**
 * 初始化HC-05蓝牙模块
 * 注意：HC-05已通过Arduino Nano手动配置，不需要AT命令
 */
void initHC05() {
  Serial.println(F("HC-05: Initializing..."));
  Serial.println(F("HC-05: Using pre-configured settings (configured via Arduino Nano)"));
  Serial.println(F("HC-05: Expected name: SEBT-Host-001, Password: 1234, Baud: 9600"));

  // 直接初始化串口为正常通信波特率（HC-05已配置为9600）
  Serial.println(F("HC-05: Initializing serial at 9600 baud..."));
  bluetoothSerial.begin(HC05_BAUD_RATE, SERIAL_8N1, HC05_RX_PIN, HC05_TX_PIN);
          delay(500);

  // 清空串口接收缓冲区
  while (bluetoothSerial.available()) {
    bluetoothSerial.read();
  }
  
  Serial.println(F("HC-05: Serial initialized with non-blocking mode"));

  Serial.println(F("HC-05: Serial initialized"));
  Serial.println(F("HC-05: Ready for data transmission"));
  Serial.println(F("HC-05: Device should be paired in Windows Bluetooth settings"));
          }

// --- 3. 读取TOF传感器数据函数 ---
/**
 * 读取所有TOF传感器的距离数据
 * @param distances 输出数组，存储8个方向的距离值
 * @param minDir 输出参数，最小距离的方向索引
 * @param minDist 输出参数，最小距离值
 * @return 是否至少有一个传感器读取成功
 */
bool readTOFSensors(uint16_t* distances, int* minDir, uint16_t* minDist) {
  uint16_t minDistance = FILTER_MAX_MM;
  int minDirection = -1;
  bool anySuccess = false;

  for (int i = 0; i < NUM_SENSORS; i++) {
    if (!sensorInitialized[i]) {
      distances[i] = FILTER_MAX_MM;
      continue;
    }

    // 选择TCA9548A通道
    tcaSelect(i);
    delay(2);

    // 读取距离数据
    uint16_t distance = sensors[i].read();
    distances[i] = distance;

    // 检查数据有效性（只检查最大值，不检查最小值，避免20mm误差导致的频繁跳变）
    // 0值通常表示传感器错误或超出范围，但我们也发送真实值
    if (distance > 0 && distance <= FILTER_MAX_MM) {
      anySuccess = true;
      if (distance < minDistance) {
        minDistance = distance;
        minDirection = i;
    }
  } else {
      // 超出范围或为0，设置为无效值
      distances[i] = FILTER_MAX_MM;
  }
}

  *minDir = minDirection;
  *minDist = (minDirection >= 0) ? minDistance : FILTER_MAX_MM;

  return anySuccess;
}

// --- 4. 初始化TOF传感器 ---
/**
 * 初始化所有8个TOF传感器
 * @return 是否至少有一个传感器初始化成功
 */
bool initTOFSensors() {
  Serial.println(F("TOF: Initializing 8 sensors..."));

  // 测试TCA9548A
  Wire.beginTransmission(TCA9548A_ADDR);
  byte error = Wire.endTransmission();
  if (error != 0) {
    Serial.print(F("ERROR: TCA9548A not found at 0x"));
    Serial.println(TCA9548A_ADDR, HEX);
    return false;
  }
  Serial.println(F("TCA9548A OK"));

  int successCount = 0;
  for (int i = 0; i < NUM_SENSORS; i++) {
    Serial.print(F("TOF Sensor "));
    Serial.print(i);
    Serial.print(F(" ("));
    Serial.print(DIR_NAMES[i]);
    Serial.print(F(")..."));
    
    // 选择TCA9548A通道
    tcaSelect(i);
    delay(20);

    // 初始化传感器
    unsigned long initStart = millis();
    bool initSuccess = false;
    
    while (millis() - initStart < 2000) {
      if (sensors[i].init()) {
        initSuccess = true;
        break;
      }
      delay(50);
    }
    
    if (!initSuccess) {
      Serial.print(F("WARN: Sensor "));
      Serial.print(i);
      Serial.print(F(" ("));
      Serial.print(DIR_NAMES[i]);
      Serial.println(F(") timeout"));
      continue;
    }

    // 设置测量模式
    sensors[i].setDistanceMode(VL53L1X::Short);
    sensors[i].setMeasurementTimingBudget(20000);
    sensors[i].startContinuous(50);

    Serial.print(F("OK: Sensor "));
    Serial.print(i);
    Serial.print(F(" ("));
    Serial.print(DIR_NAMES[i]);
    Serial.println(F(")"));
    sensorInitialized[i] = true;
    successCount++;
    delay(30);
  }

  Serial.print(successCount);
  Serial.print(F("/"));
  Serial.print(NUM_SENSORS);
  Serial.println(F(" sensors OK"));

  if (successCount == 0) {
    Serial.println(F("ERROR: No sensors initialized!"));
    return false;
  }
  
  return true;
}

// --- 5. 发送数据到蓝牙串口 ---
/**
 * 读取传感器数据并发送到蓝牙串口
 * 数据格式: [时间戳(4字节)] [最小方向(1字节)] [最小距离(2字节)] [8方向距离(16字节)]
 * 总长度: 23字节
 */
void sendBTData() {
  uint16_t distances[8];
  int currentMinDir;
  uint16_t currentMinDist;
  bool readSuccess = false;

  // 读取TOF传感器数据（如果传感器已初始化）
  bool hasInitializedSensors = false;
  for (int i = 0; i < NUM_SENSORS; i++) {
    if (sensorInitialized[i]) {
      hasInitializedSensors = true;
      break;
    }
  }

  if (hasInitializedSensors) {
    readSuccess = readTOFSensors(distances, &currentMinDir, &currentMinDist);
  } else {
    // 如果没有传感器，发送测试数据
  for (int i = 0; i < 8; i++) {
      distances[i] = 500 + i * 50; // 测试数据：500, 550, 600...
    }
    currentMinDir = 0;
    currentMinDist = 500;
    readSuccess = true;
    Serial.println(F("BT: Using test data (no sensors)"));
  }

  // 构造二进制数据包
  // 格式: [时间戳(4字节)] [最小方向(1字节)] [最小距离(2字节)] [8方向距离(16字节)]
  uint32_t timestamp = millis();
  uint8_t dataPacket[23]; // 4 + 1 + 2 + 16 = 23字节

  // 时间戳 (小端序)
  memcpy(&dataPacket[0], &timestamp, 4);

  // 最小方向 (如果无效则为255)
  dataPacket[4] = (uint8_t)(currentMinDir >= 0 ? currentMinDir : 255);

  // 最小距离 (小端序)
  memcpy(&dataPacket[5], &currentMinDist, 2);

  // 8方向距离 (小端序)
  for (int i = 0; i < 8; i++) {
    memcpy(&dataPacket[7 + i * 2], &distances[i], 2);
  }

  // 检查串口缓冲区可用空间（ESP32-C3 HardwareSerial默认缓冲区大小通常是256字节）
  // 如果缓冲区空间不足，跳过本次发送，避免阻塞导致整个程序卡死
  const size_t PACKET_SIZE = sizeof(dataPacket);
  size_t availableSpace = bluetoothSerial.availableForWrite();
  
  // 需要至少能写入一个完整数据包，加上一些安全余量（避免边界情况）
  const size_t MIN_REQUIRED_SPACE = PACKET_SIZE + 30; // 数据包大小 + 30字节安全余量
  
  // 静态变量：用于跟踪缓冲区状态
  static unsigned long lastWarningTime = 0;
  static int skipCount = 0;
  static int consecutiveSkips = 0;
  
  if (availableSpace < MIN_REQUIRED_SPACE) {
    // 缓冲区空间不足，跳过本次发送并动态调整发送间隔
    skipCount++;
    consecutiveSkips++;
    
    // 如果连续跳过多次，增加发送间隔（减少发送频率）
    if (consecutiveSkips > 5) {
      currentSendInterval = min(currentSendInterval + 50, MAX_SEND_INTERVAL);
      consecutiveSkips = 0; // 重置计数器
    }
    
    // 每2秒输出一次警告，避免日志过多
    if (millis() - lastWarningTime > 2000) {
      Serial.print(F("BT: WARN - Buffer low! Available: "));
      Serial.print(availableSpace);
      Serial.print(F(" bytes, Required: "));
      Serial.print(MIN_REQUIRED_SPACE);
      Serial.print(F(", Skipped: "));
      Serial.print(skipCount);
      Serial.print(F(", Interval: "));
      Serial.print(currentSendInterval);
      Serial.println(F("ms"));
      lastWarningTime = millis();
    }
    
    // 如果缓冲区几乎满了，尝试清空接收缓冲区（可能有未读数据）
    if (availableSpace < PACKET_SIZE) {
      int cleared = 0;
      while (bluetoothSerial.available() && cleared < 10) { // 最多清空10字节
        bluetoothSerial.read();
        cleared++;
      }
    }
    
    return; // 跳过本次发送，避免阻塞
  }
  
  // 缓冲区正常，重置连续跳过计数，恢复发送间隔
  if (consecutiveSkips > 0) {
    consecutiveSkips = 0;
    currentSendInterval = BASE_SEND_INTERVAL; // 恢复基础间隔
  }

  // 发送到蓝牙串口（write()方法在ESP32-C3上默认是非阻塞的）
  size_t bytesWritten = bluetoothSerial.write(dataPacket, PACKET_SIZE);

  // 检查是否成功写入（如果缓冲区满，write可能返回0或部分写入）
  if (bytesWritten != PACKET_SIZE) {
    static unsigned long lastErrorTime = 0;
    if (millis() - lastErrorTime > 5000) { // 每5秒输出一次错误
      Serial.print(F("BT: ERROR - Write incomplete! Expected: "));
      Serial.print(PACKET_SIZE);
      Serial.print(F(", Written: "));
      Serial.print(bytesWritten);
      Serial.print(F(", Available: "));
      Serial.println(availableSpace);
      lastErrorTime = millis();
    }
  }
  
  // 注意：不要调用flush()，因为它会阻塞直到所有数据发送完成
  // ESP32-C3的HardwareSerial会自动在后台发送数据

  // 调试输出到USB串口
  Serial.print(F("BT: "));
  Serial.print(sizeof(dataPacket));
  Serial.print(F("B Dir:"));
  if (currentMinDir >= 0 && currentMinDir < 8) {
    Serial.print(currentMinDir);
    Serial.print(F("("));
    Serial.print(DIR_NAMES[currentMinDir]);
    Serial.print(F(")"));
    } else {
    Serial.print(F("N/A"));
  }
  Serial.print(F(" Dist:"));
  Serial.print(currentMinDist);
  Serial.print(F(" Buffer:"));
  Serial.print(availableSpace);
  Serial.println(readSuccess ? F(" OK") : F(" ERR"));
  
  // 每10次发送显示一次状态
  static int sendCount = 0;
  sendCount++;
  if (sendCount % 10 == 0) {
    Serial.print(F("BT: Sent "));
    Serial.print(sendCount);
    Serial.print(F(", Buffer available: "));
    Serial.println(bluetoothSerial.availableForWrite());
  }
}

void setup() {
  // 初始化USB串口
  Serial.begin(115200);

  // ESP32-C3的USB串口需要时间初始化，等待更长时间
  delay(2000);
  
  // 发送启动信息
  Serial.println();
  Serial.println(F("========================================"));
  Serial.println(F("SEBT Host BT (ESP32-C3) - Starting..."));
  Serial.println(F("========================================"));
  Serial.println(F("Serial Monitor Test - If you see this, serial is working!"));
  Serial.println(F("Baud Rate: 115200"));
  Serial.println(F("Line Ending: Both NL & CR"));
  Serial.println(F("========================================"));
  Serial.println();
  
  Serial.println(F("Step 1: Serial initialized"));
  
  // 初始化LED
  pinMode(LED_PIN, OUTPUT);
  digitalWrite(LED_PIN, LOW);
  Serial.println(F("LED: Initialized"));
  
  // 初始化传感器状态数组
  for (int i = 0; i < NUM_SENSORS; i++) {
    sensorInitialized[i] = false;
  }

  // 初始化I2C
  Serial.println(F("Step 2: Initializing I2C..."));
  Wire.begin(SDA_PIN, SCL_PIN);
  Wire.setClock(100000); // 100kHz时钟频率
  delay(100);
  Serial.println(F("Step 2: I2C initialized"));
  Serial.printf("I2C: SDA pin %d, SCL pin %d\n", SDA_PIN, SCL_PIN);

  // 初始化TOF传感器
  Serial.println(F("Step 3: Initializing TOF sensors..."));
  bool tofOk = initTOFSensors();
  
  if (!tofOk) {
    Serial.println(F("WARN: Some TOF sensors failed"));
    Serial.println(F("Continuing with available sensors..."));
  } else {
    Serial.println(F("Step 3: TOF sensors initialized"));
    }
  
  delay(500);

  // 初始化HC-05
  Serial.println(F("Step 4: Initializing HC-05..."));
  initHC05();
  Serial.println(F("Step 4: HC-05 initialized"));

  // 初始化完成
  Serial.println(F("========================================"));
  Serial.println(F("SEBT BT Host - Ready!"));
  Serial.println(F("Connect with BT client..."));
  Serial.println(F("========================================"));
}

void loop() {
  // 定时发送数据（使用动态调整的发送间隔）
  if (millis() - lastSendTime >= currentSendInterval) {
    sendBTData();
    lastSendTime = millis();
    
    // LED闪烁指示数据发送（非阻塞方式）
    digitalWrite(LED_PIN, HIGH);
    // 移除delay，避免阻塞主循环
    // delay(10); // 已移除，LED闪烁由心跳控制
    digitalWrite(LED_PIN, LOW);
  }

  // LED心跳闪烁（每秒一次）
  static unsigned long lastHeartbeat = 0;
  if (millis() - lastHeartbeat >= 1000) {
    digitalWrite(LED_PIN, HIGH);
    delay(50);
    digitalWrite(LED_PIN, LOW);
    lastHeartbeat = millis();
    
    // 每5秒输出一次状态
    static int statusCount = 0;
    statusCount++;
    if (statusCount >= 5) {
      Serial.print(F("Status: Running, Uptime: "));
      Serial.print(millis() / 1000);
      Serial.println(F("s"));
      statusCount = 0;
    }
  }
}
