/*
 * SEBT Host Classic Bluetooth (ESP32-C3 Version)
 * ESP32-C3 + HC-05作为经典蓝牙主机，通过TCA9548A读取8方向TOF传感器数据
 * 经典蓝牙串口通信模式，客户端通过蓝牙串口连接直接接收数据
 * 数据范围: 30-4000mm，发送间隔: 300ms
 * 
 * ESP32-C3引脚定义:
 * - I2C SDA: GPIO 8
 * - I2C SCL: GPIO 9
 * - HC-05 RX: GPIO 3 (ESP32接收，HC-05发送)
 * - HC-05 TX: GPIO 4 (ESP32发送，HC-05接收)
 * 
 * 注意：HC-05已通过Arduino Nano手动配置，不需要EN引脚
 */

#include <Arduino.h>
#include <Wire.h>
#include <VL53L1X.h>

// --- HC-05配置 ---
// 注意：HC-05已通过Arduino Nano手动配置，不需要EN引脚控制
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

// --- 全局变量 ---
unsigned long lastSendTime = 0;
const unsigned long SEND_INTERVAL = 300; // 300ms发送一次
bool deviceConnected = false;
bool sensorInitialized[8] = {false, false, false, false, false, false, false, false};

// --- 1. TCA9548A控制函数 ---
void tcaSelect(uint8_t channel) {
  if (channel > 7) return;
  Wire.beginTransmission(TCA9548A_ADDR);
  Wire.write(1 << channel);
  Wire.endTransmission();
}

// --- 2. HC-05初始化函数 ---
void initHC05() {
  Serial.println(F("HC-05: Initializing..."));
  Serial.println(F("HC-05: Using pre-configured settings (configured via Arduino Nano)"));
  Serial.println(F("HC-05: Expected name: SEBT-Host-001, Password: 1234, Baud: 9600"));

  // 直接初始化串口为正常通信波特率（HC-05已配置为9600）
  Serial.println(F("HC-05: Initializing serial at 9600 baud..."));
  bluetoothSerial.begin(HC05_BAUD_RATE, SERIAL_8N1, HC05_RX_PIN, HC05_TX_PIN);
  delay(500);

  // 清空串口缓冲区
  while (bluetoothSerial.available()) {
    bluetoothSerial.read();
  }

  Serial.println(F("HC-05: Serial initialized"));
  Serial.println(F("HC-05: Ready for data transmission"));
  Serial.println(F("HC-05: Device should be paired in Windows Bluetooth settings"));
}

// --- 3. 读取TOF传感器数据函数 ---
bool readTOFSensors(uint16_t* distances, int* minDir, uint16_t* minDist) {
  uint16_t minDistance = 4000;
  int minDirection = -1;
  bool anySuccess = false;

  for (int i = 0; i < NUM_SENSORS; i++) {
    if (!sensorInitialized[i]) {
      distances[i] = 4000;
      continue;
    }

    // 选择TCA9548A通道
    tcaSelect(i);
    delay(2);

    // 读取距离数据
    uint16_t distance = sensors[i].read();
    distances[i] = distance;

    // 检查数据有效性
    if (distance >= 30 && distance <= 4000) {
      anySuccess = true;
      if (distance < minDistance) {
        minDistance = distance;
        minDirection = i;
      }
    } else {
      distances[i] = 4000;
    }
  }

  *minDir = minDirection;
  *minDist = minDistance;

  return anySuccess;
}

// --- 4. 初始化TOF传感器 ---
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
    Serial.println(F("..."));
    
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
      Serial.println(F(" timeout"));
      continue;
    }

    // 设置测量模式
    sensors[i].setDistanceMode(VL53L1X::Short);
    sensors[i].setMeasurementTimingBudget(20000);
    sensors[i].startContinuous(50);

    Serial.print(F("OK: Sensor "));
    Serial.println(i);
    sensorInitialized[i] = true;
    successCount++;
    delay(30);
  }

  Serial.print(successCount);
  Serial.print(F("/"));
  Serial.print(NUM_SENSORS);
  Serial.println(F(" sensors OK"));
  
  if (successCount == 0) {
    Serial.println(F("ERROR: No sensors!"));
    return false;
  }
  
  return true;
}

// --- 5. 发送数据到蓝牙串口 ---
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

  // 时间戳
  memcpy(&dataPacket[0], &timestamp, 4);

  // 最小方向
  dataPacket[4] = (uint8_t)(currentMinDir >= 0 ? currentMinDir : 255);

  // 最小距离
  memcpy(&dataPacket[5], &currentMinDist, 2);

  // 8方向距离
  for (int i = 0; i < 8; i++) {
    memcpy(&dataPacket[7 + i * 2], &distances[i], 2);
  }

  // 发送到蓝牙串口
  bluetoothSerial.write(dataPacket, sizeof(dataPacket));

  // 调试输出到USB串口
  Serial.print(F("BT: "));
  Serial.print(sizeof(dataPacket));
  Serial.print(F("B Dir:"));
  Serial.print(currentMinDir);
  Serial.print(F(" Dist:"));
  Serial.print(currentMinDist);
  Serial.println(readSuccess ? F(" OK") : F(" ERR"));
  
  // 每10次发送显示一次状态
  static int sendCount = 0;
  sendCount++;
  if (sendCount % 10 == 0) {
    Serial.print(F("BT: Sent "));
    Serial.println(sendCount);
  }
}

void setup() {
  // 初始化USB串口
  Serial.begin(115200);
  
  // ESP32-C3的USB串口需要时间初始化，等待更长时间
  delay(2000);
  
  // 发送多个测试消息，确保串口监视器能看到输出
  Serial.println();
  Serial.println(F("========================================"));
  Serial.println(F("SEBT BT Host (ESP32-C3) - Starting..."));
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
  delay(100);
  Serial.println(F("Step 2: I2C initialized"));

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
  // 定时发送数据
  if (millis() - lastSendTime >= SEND_INTERVAL) {
    sendBTData();
    lastSendTime = millis();
    
    // LED闪烁指示数据发送
    digitalWrite(LED_PIN, HIGH);
    delay(10);
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

