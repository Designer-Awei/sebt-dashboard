# 设置控制台编码为UTF-8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
chcp 65001 | Out-Null

Write-Host "Starting SEBT Dashboard..." -ForegroundColor Green

# 启动应用
npm run dev
