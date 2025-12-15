/*
 * SEBT Host Hardware Test
 * 硬件：ESP32-C3, TCA9548A, 8x VL53L1X, SH1106 OLED
 * 修改：锁定时间改为3秒，扫描期间实时刷新最近方向
 */

 #include <Wire.h>
 #include <SPI.h>
 #include <Adafruit_GFX.h>
 #include <Adafruit_SH110X.h>
 #include <Adafruit_VL53L1X.h>
 
 // --- 1. 引脚定义 ---
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
 
 // --- 2. 逻辑参数 (已修改) ---
 const int STABLE_TIME_MS = 3000;  // 【修改】锁定时间改为 3000ms (3秒)
 const int FILTER_MAX_MM = 2000;   // 超过这个距离忽略
 const int FILTER_MIN_MM = 30;     // 小于这个距离忽略(噪音)
 
 // --- 3. 方向映射 ---
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
 
 // --- 4. 全局变量 ---
 int distances[8];       
 int minIndex = -1;      
 int minDistance = 9999; 
 
 // 状态控制
 bool isLocked = false;
 int lastCandidateIndex = -1;
 unsigned long stableStartTime = 0;
 
 // --- 辅助函数：切换 Mux 通道 ---
 void tcaSelect(uint8_t i) {
   if (i > 7) return;
   Wire.beginTransmission(MUX_ADDR);
   Wire.write(1 << i);
   Wire.endTransmission();
 }
 
 // --- 辅助函数：设置 RGB ---
 void setRGB(bool r, bool g, bool b) {
   digitalWrite(PIN_LED_R, r);
   digitalWrite(PIN_LED_G, g);
   digitalWrite(PIN_LED_B, b);
 }
 
 void setup() {
   Serial.begin(115200);
   
   pinMode(PIN_LED_R, OUTPUT);
   pinMode(PIN_LED_G, OUTPUT);
   pinMode(PIN_LED_B, OUTPUT);
   pinMode(PIN_BTN, INPUT_PULLUP);
   
   setRGB(1, 0, 0); // 红灯亮
 
   Wire.begin(SDA_PIN, SCL_PIN);
 
   // OLED 初始化
   if (!display.begin(SCREEN_ADDRESS, true)) {
     Serial.println("OLED init failed");
     // 报错闪烁
     for(int i=0; i<5; i++) { setRGB(0,0,0); delay(100); setRGB(1,0,0); delay(100); }
   }
   
   display.clearDisplay();
   display.setTextSize(1);
   display.setTextColor(SH110X_WHITE);
   display.setCursor(0,0);
   display.println("System Booting...");
   display.display();
 
   // 传感器初始化
   for (int i = 0; i < 8; i++) {
     tcaSelect(i);
     display.print("S"); display.print(i);
     if (!vl53.begin(0x29, &Wire)) {
       display.print("X ");
     } else {
       vl53.startRanging(); 
       vl53.setTimingBudget(50); // 高速模式
       display.print("O ");
     }
     display.display();
   }
   delay(1000); 
 }
 
 void loop() {
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
 
   // --- 2. 扫描所有传感器 ---
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
 
   // --- 3. 锁定判断逻辑 ---
   if (!isLocked) {
     setRGB(1, 0, 0); // 红灯 (扫描中)
     
     if (minIndex != -1) {
       // 如果当前的最小值索引 等于 上一次记录的候选索引
       if (minIndex == lastCandidateIndex) {
         // 检查持续时间是否超过 3000ms
         if (millis() - stableStartTime > STABLE_TIME_MS) {
           isLocked = true; 
           setRGB(0, 0, 1); // 蓝灯 (锁定!)
         }
       } else {
         // 目标变了（比如从 Front 变成了 FrontRight），重置计时器
         lastCandidateIndex = minIndex;
         stableStartTime = millis();
       }
     } else {
       // 没有有效目标
       lastCandidateIndex = -1; 
     }
   }
 
   // --- 4. OLED 显示逻辑 ---
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
     display.print(distances[lastCandidateIndex]); // 这里会继续实时更新距离
     display.setTextSize(1);
     display.print(" mm");
     
   } else {
     // === 扫描状态 (实时显示最近端) ===
     display.setCursor(0, 0);
     display.setTextSize(1);
     display.println("Scanning...");
     
     if (minIndex != -1) {
       // 实时显示当前的最近方向和距离
       display.setCursor(0, 20);
       display.print("Nearest: ");
       display.println(DIR_NAMES[minIndex]); // 实时更新方向
       
       display.setCursor(0, 35);
       display.setTextSize(2);
       display.print(minDistance); display.print(" mm"); // 实时更新数值
       
       // 显示进度条 (可视化 3秒 倒计时)
       // 只有当持续对准同一方向时，进度条才会增长
       if (lastCandidateIndex != -1 && minIndex == lastCandidateIndex) {
         long elapsed = millis() - stableStartTime;
         int barWidth = map(elapsed, 0, STABLE_TIME_MS, 0, 128); // 映射到 0-128像素宽度
         if (barWidth > 128) barWidth = 128;
         
         // 绘制空心框
         display.drawRect(0, 55, 128, 6, SH110X_WHITE);
         // 绘制实心进度
         display.fillRect(0, 55, barWidth, 6, SH110X_WHITE);
       }
     } else {
       display.setCursor(0, 25);
       display.println("No Object");
     }
   }
   
   display.display(); // 刷新屏幕
 }