# Check HC-05 SPP Service Connection Status
# Usage: powershell -ExecutionPolicy Bypass -File check-spp-service.ps1

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Write-Host "Checking HC-05 SPP Service Connection..." -ForegroundColor Cyan
Write-Host ""

# Method 1: Check via Registry (more reliable)
Write-Host "Method 1: Checking Registry..." -ForegroundColor Yellow
$regPath = "HKLM:\SYSTEM\CurrentControlSet\Services\BTHPORT\Parameters\Devices"
$devices = Get-ChildItem $regPath -ErrorAction SilentlyContinue

$foundDevice = $false
foreach ($device in $devices) {
    try {
        $deviceProps = Get-ItemProperty $device.PSPath -ErrorAction SilentlyContinue
        if ($deviceProps) {
            $deviceName = $deviceProps.Name
            if ($deviceName -like '*SEBT*' -or $deviceName -like '*HC-05*' -or $deviceName -like '*HC05*') {
                $foundDevice = $true
                Write-Host "   Found device: $deviceName" -ForegroundColor Green
                
                # Check services
                $services = $deviceProps.Services
                if ($services) {
                    Write-Host "   Services: $services" -ForegroundColor Gray
                    if ($services -like '*1101*' -or $services -like '*SPP*') {
                        Write-Host "   ✅ SPP Service (UUID 1101) found in registry" -ForegroundColor Green
                    } else {
                        Write-Host "   ⚠️  SPP Service not found in registry" -ForegroundColor Yellow
                    }
                }
            }
        }
    } catch {
        # Skip devices that can't be accessed
    }
}

if (-not $foundDevice) {
    Write-Host "   ⚠️  Device not found in registry" -ForegroundColor Yellow
}

Write-Host ""

# Method 2: Check via PnP Devices
Write-Host "Method 2: Checking PnP Devices..." -ForegroundColor Yellow
$ports = Get-PnpDevice | Where-Object { 
    $_.Class -eq 'Ports' -and 
    ($_.FriendlyName -like '*Bluetooth*' -or $_.FriendlyName -like '*SEBT*' -or $_.InstanceId -like '*BTHENUM*')
}

if ($ports.Count -eq 0) {
    Write-Host "   ❌ No Bluetooth serial ports found" -ForegroundColor Red
} else {
    Write-Host "   Found $($ports.Count) port(s):" -ForegroundColor Green
    foreach ($port in $ports) {
        $status = $port.Status
        $statusColor = if ($status -eq 'OK') { "Green" } else { "Red" }
        Write-Host "      $($port.FriendlyName): $status" -ForegroundColor $statusColor
        
        # Check if port is actually accessible
        $comMatch = [regex]::Match($port.FriendlyName, 'COM\d+')
        if ($comMatch.Success) {
            $comPort = $comMatch.Value
            Write-Host "         COM Port: $comPort" -ForegroundColor Gray
            
            # Try to check if port is actually connected and can receive data
            try {
                $portObj = New-Object System.IO.Ports.SerialPort($comPort, 9600)
                $portObj.ReadTimeout = 1000
                $portObj.Open()
                
                # Try to read any available data (non-blocking)
                $dataAvailable = $portObj.BytesToRead
                if ($dataAvailable -gt 0) {
                    Write-Host "         ✅ Port is accessible and has $dataAvailable bytes waiting" -ForegroundColor Green
                } else {
                    Write-Host "         ✅ Port is accessible (no data waiting)" -ForegroundColor Green
                }
                
                $portObj.Close()
            } catch {
                $errorMsg = $_.Exception.Message
                if ($errorMsg -like '*被另一个进程*' -or $errorMsg -like '*being used*') {
                    Write-Host "         ⚠️  Port is in use by another application" -ForegroundColor Yellow
                } else {
                    Write-Host "         ⚠️  Port may not be connected: $errorMsg" -ForegroundColor Yellow
                }
            }
        }
    }
}

Write-Host ""
Write-Host "Diagnosis:" -ForegroundColor Cyan
if ($ports.Count -gt 0) {
    Write-Host "✅ Ports are created and accessible" -ForegroundColor Green
    Write-Host "⚠️  But if no data is received, SPP service may not be connected" -ForegroundColor Yellow
} else {
    Write-Host "❌ No Bluetooth serial ports found" -ForegroundColor Red
}

Write-Host ""
Write-Host "Important Notes:" -ForegroundColor Cyan
Write-Host "1. Port creation does NOT guarantee SPP service is connected" -ForegroundColor Yellow
Write-Host "2. You must manually enable SPP service in Windows Bluetooth settings" -ForegroundColor Yellow
Write-Host "3. Steps to enable SPP:" -ForegroundColor White
Write-Host "   a. Open Settings > Bluetooth & devices" -ForegroundColor Gray
Write-Host "   b. Find 'SEBT-Host-001' device" -ForegroundColor Gray
Write-Host "   c. Click device > More Bluetooth options" -ForegroundColor Gray
Write-Host "   d. In 'Services' tab, CHECK 'Serial Port (SPP)'" -ForegroundColor Gray
Write-Host "   e. Wait 5-10 seconds for connection" -ForegroundColor Gray
Write-Host ""
Write-Host "4. Alternative method (Windows 10/11):" -ForegroundColor White
Write-Host "   - Right-click Bluetooth icon in system tray" -ForegroundColor Gray
Write-Host "   - Select 'Open Settings' or 'Show Bluetooth devices'" -ForegroundColor Gray
Write-Host "   - Find 'SEBT-Host-001' > Right-click > Properties" -ForegroundColor Gray
Write-Host "   - Check 'Serial Port (SPP)' service" -ForegroundColor Gray
Write-Host ""

