# Автозапуск сервера «День» при включении компьютера (Планировщик заданий, от имени SYSTEM) и правило брандмауэра:
# порт открыт только для своей локальной сети (частная/доменная), из интернета — закрыт.
param([Parameter(Mandatory)][ValidateSet('install', 'stop', 'remove')][string]$Action, [string]$Exe = '', [int]$Port = 8787)
$ErrorActionPreference = 'Stop'
$name = 'Den Server'
if ($Action -in 'stop', 'remove') {
  Stop-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
  Get-Process den-server -ErrorAction SilentlyContinue | Stop-Process -Force
  Start-Sleep -Seconds 1
}
if ($Action -eq 'remove') {
  Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction SilentlyContinue
  Remove-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue
}
if ($Action -eq 'install') {
  $act = New-ScheduledTaskAction -Execute $Exe -WorkingDirectory (Split-Path $Exe)
  $trg = New-ScheduledTaskTrigger -AtStartup
  $who = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
  $set = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
  Register-ScheduledTask -TaskName $name -Action $act -Trigger $trg -Principal $who -Settings $set -Force | Out-Null
  Remove-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue
  New-NetFirewallRule -DisplayName $name -Direction Inbound -Action Allow -Protocol TCP -LocalPort $Port -RemoteAddress LocalSubnet -Profile Private, Domain | Out-Null
  Start-ScheduledTask -TaskName $name
}
