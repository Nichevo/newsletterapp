# Installs the newsletter app's PC helper on Windows.
#
# Run from the folder you downloaded both files into:
#   powershell -ExecutionPolicy Bypass -File install-helper.ps1
#
# It copies newsletter-helper.mjs to %LOCALAPPDATA%\NewsletterHelper, asks for
# the app address and the Cloudflare Access service token, writes config.json
# there, and adds a scheduled task that starts the helper hidden when you log
# in (and restarts it if it stops). Run it again to change any of these.

$ErrorActionPreference = 'Stop'
$dir = Join-Path $env:LOCALAPPDATA 'NewsletterHelper'
$taskName = 'Newsletter helper'
New-Item -ItemType Directory -Force -Path $dir | Out-Null

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) {
  Write-Host 'Node.js is not installed. Install it with:  winget install OpenJS.NodeJS.LTS' -ForegroundColor Yellow
  Write-Host 'then open a new PowerShell window and run this script again.'
  exit 1
}
$major = [int]((& $node --version).TrimStart('v').Split('.')[0])
if ($major -lt 20) { throw "Node.js 20 or newer is needed (found $(& $node --version))." }

$source = Join-Path $PSScriptRoot 'newsletter-helper.mjs'
if (-not (Test-Path $source)) { throw "newsletter-helper.mjs was not found next to this script." }
Copy-Item $source (Join-Path $dir 'newsletter-helper.mjs') -Force

$configPath = Join-Path $dir 'config.json'
$existing = if (Test-Path $configPath) { Get-Content $configPath -Raw | ConvertFrom-Json } else { $null }

function Ask($prompt, $current) {
  $shown = if ($current) { " [$current]" } else { '' }
  $answer = Read-Host "$prompt$shown"
  if ($answer) { return $answer.Trim() } else { return $current }
}

$appUrl = Ask 'App address' ($(if ($existing) { $existing.appUrl } else { 'https://app.techylearnings.com' }))
$clientId = Ask 'Service token Client ID' ($(if ($existing) { $existing.clientId } else { '' }))
$secure = Read-Host 'Service token Client Secret (leave empty to keep the saved one)' -AsSecureString
$secret = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
if (-not $secret -and $existing) { $secret = $existing.clientSecret }
if (-not $appUrl -or -not $clientId -or -not $secret) { throw 'App address, Client ID and Client Secret are all needed.' }

$config = [ordered]@{
  appUrl            = $appUrl.TrimEnd('/')
  clientId          = $clientId
  clientSecret      = $secret
  ollamaUrl         = $(if ($existing -and $existing.ollamaUrl) { $existing.ollamaUrl } else { 'http://127.0.0.1:11434' })
  openaiCompatible  = $(if ($existing -and $existing.openaiCompatible) { @($existing.openaiCompatible) } else { @() })
  maxChars          = $(if ($existing -and $existing.maxChars) { $existing.maxChars } else { 24000 })
}
if ($existing -and $existing.anthropicApiKey) { $config.anthropicApiKey = $existing.anthropicApiKey }
$config | ConvertTo-Json -Depth 5 | Set-Content -Path $configPath -Encoding UTF8

# Only this Windows user can read the file with the secret.
icacls $configPath /inheritance:r /grant:r "$($env:USERNAME):(R,W)" | Out-Null

Write-Host 'Checking the connection once...'
& $node (Join-Path $dir 'newsletter-helper.mjs') --once
if ($LASTEXITCODE -ne 0) { Write-Host 'The test run reported a problem; see the lines above.' -ForegroundColor Yellow }

$action = New-ScheduledTaskAction -Execute $node -Argument "`"$(Join-Path $dir 'newsletter-helper.mjs')`"" -WorkingDirectory $dir
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -Hidden
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
Start-ScheduledTask -TaskName $taskName

Write-Host ''
Write-Host "Installed. The helper now runs in the background and starts when you log in." -ForegroundColor Green
Write-Host "Log file: $(Join-Path $dir 'helper.log')"
Write-Host "To remove it: Unregister-ScheduledTask -TaskName '$taskName'"
