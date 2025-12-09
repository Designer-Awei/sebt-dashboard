// 最简单的ESP32测试代码
// 只测试基本功能，不包含任何复杂逻辑

void setup() {
  // 初始化串口
  Serial.begin(115200);

  // 等待串口稳定
  delay(1000);

  // 基本输出测试
  Serial.println();
  Serial.println("===============================");
  Serial.println("ESP32 Simple Test Started!");
  Serial.println("===============================");

  // GPIO测试
  pinMode(5, OUTPUT);
  digitalWrite(5, HIGH); // 点亮LED
  Serial.println("LED ON (GPIO 5 HIGH)");

  // 延时测试
  Serial.println("Waiting 2 seconds...");
  delay(2000);
  Serial.println("Wait complete!");

  Serial.println("Setup complete - entering loop");
}

void loop() {
  // 每秒输出一次时间戳
  static unsigned long lastPrint = 0;
  if (millis() - lastPrint >= 1000) {
    Serial.printf("Loop running - Time: %lu ms\n", millis());
    lastPrint = millis();

    // 闪烁LED
    static bool ledState = false;
    digitalWrite(5, ledState ? HIGH : LOW);
    ledState = !ledState;
  }

  // 短延时避免占用太多CPU
  delay(100);
}
