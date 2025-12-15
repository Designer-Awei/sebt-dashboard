/*
 * HC-05 手动配置工具 (Arduino Nano版本)
 * Arduino Nano作为串口转发器，所有AT命令通过串口监视器手动输入
 * 
 * 硬件连接（HC-05与Nano共用电源，全程保持连接）:
 * - HC-05 VCC -> 5V (与Nano共用)
 * - HC-05 GND -> GND (与Nano共用)
 * - HC-05 TXD -> D3 (Arduino接收，HC-05发送)
 * - HC-05 RXD -> D4 (Arduino发送，HC-05接收)
 * - HC-05 EN  -> D2 (AT模式控制，可选)
 * 
 * 使用方法：
 * 1. 按照上述连接HC-05和Arduino Nano（共用5V电源）
 * 2. 上传此代码到Arduino Nano
 * 3. 打开串口监视器（115200波特率，Both NL & CR）
 * 4. 按照文档说明进入HC-05的AT模式
 * 5. 在串口监视器中手动输入AT命令
 * 6. 观察HC-05的响应
 */

#include <SoftwareSerial.h>

// --- HC-05配置 ---
#define HC05_EN_PIN         2   // HC-05 EN引脚（可选）
#define HC05_RX_PIN         3   // Arduino接收，HC-05发送
#define HC05_TX_PIN         4   // Arduino发送，HC-05接收
#define AT_BAUD_RATE        38400  // AT模式波特率（默认）
#define AT_BAUD_RATE_ALT    9600   // 备用波特率

// Arduino Nano使用SoftwareSerial
SoftwareSerial hc05Serial(HC05_RX_PIN, HC05_TX_PIN);

void setup() {
  // 初始化USB串口（用于调试）
  Serial.begin(115200);
  delay(1000);
  
  Serial.println();
  Serial.println("========================================");
  Serial.println("HC-05 Manual Configuration Tool");
  Serial.println("Arduino Nano Version");
  Serial.println("========================================");
  Serial.println();
  
  // 初始化EN引脚（如果使用）
  pinMode(HC05_EN_PIN, OUTPUT);
  
  Serial.println("Step 1: Setting EN pin HIGH (AT mode)");
  digitalWrite(HC05_EN_PIN, HIGH);
  delay(1000);
  
  Serial.println();
  Serial.println("Step 2: Initializing serial bridge...");
  Serial.println("  - USB Serial (Arduino Nano) <-> HC-05 Serial");
  Serial.println("  - Trying 38400 baud first (default AT mode baud rate)");
  
  // 尝试38400波特率
  hc05Serial.begin(AT_BAUD_RATE);
  delay(1000);
  
  // 清空缓冲区
  while (hc05Serial.available()) {
    hc05Serial.read();
  }
  
  Serial.println();
  Serial.println("========================================");
  Serial.println("Serial Bridge Ready!");
  Serial.println("========================================");
  Serial.println();
  Serial.println("IMPORTANT: Before sending AT commands:");
  Serial.println("1. Disconnect HC-05 power (if connected separately)");
  Serial.println("2. Press and hold HC-05 button");
  Serial.println("3. Power on HC-05 (or reconnect power)");
  Serial.println("4. Release button");
  Serial.println("5. HC-05 LED should blink slowly (AT mode)");
  Serial.println();
  Serial.println("Then type AT commands in Serial Monitor:");
  Serial.println("  AT                    - Test connection");
  Serial.println("  AT+NAME=SEBT-Host     - Set device name");
  Serial.println("  AT+PSWD=\"1234\"        - Set pairing password (USE QUOTES!)");
  Serial.println("  AT+ROLE=0             - Set as Slave mode");
  Serial.println("  AT+UART=9600,0,0      - Set baud rate to 9600");
  Serial.println("  AT+NAME?              - Query device name");
  Serial.println();
  Serial.println("IMPORTANT: Password command requires quotes:");
  Serial.println("  AT+PSWD=\"1234\"  (correct)");
  Serial.println("  AT+PSWD=1234    (will return ERROR:(1D))");
  Serial.println();
  Serial.println("Note: If no response, try 9600 baud:");
  Serial.println("  - Change code: AT_BAUD_RATE to 9600");
  Serial.println("  - Re-upload code");
  Serial.println();
  Serial.println("========================================");
  Serial.println();
}

void loop() {
  // 从USB串口读取命令并发送到HC-05
  if (Serial.available()) {
    String command = Serial.readString();
    command.trim();
    
    if (command.length() > 0) {
      // 显示发送的命令
      Serial.print("> ");
      Serial.println(command);
      
      // 发送到HC-05（自动添加\r\n）
      hc05Serial.print(command);
      if (!command.endsWith("\r\n")) {
        hc05Serial.print("\r\n");
      }
      
      // 等待响应（HC-05通常很快响应）
      delay(300);
      
      // 读取并显示响应
      String response = "";
      unsigned long startTime = millis();
      while (millis() - startTime < 1500) {
        if (hc05Serial.available()) {
          char c = hc05Serial.read();
          response += c;
          // 如果收到换行符，可能响应结束
          if (c == '\n') {
            delay(50); // 再等待一点，看是否有更多数据
          }
        } else {
          delay(10);
        }
      }
      
      if (response.length() > 0) {
        Serial.print("< ");
        Serial.print(response);
        if (!response.endsWith("\n")) {
          Serial.println();
        }
      } else {
        Serial.println("< (no response)");
      }
      Serial.println();
    }
  }
  
  // 从HC-05读取数据并显示（如果有未读数据）
  if (hc05Serial.available()) {
    Serial.print("< ");
    while (hc05Serial.available()) {
      Serial.write(hc05Serial.read());
    }
    Serial.println();
  }
  
  delay(10);
}

