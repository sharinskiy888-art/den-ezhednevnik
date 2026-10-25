# Сборка установщика «День» для Windows: den-server.exe (Nuitka) + den-setup-<версия>.exe (Inno Setup 6).
#   powershell -ExecutionPolicy Bypass -File deploy\windows\build.ps1
# Нужны: Python 3.12+, Inno Setup 6 (ISCC.exe), компилятор C (Visual Studio Build Tools; Nuitka предложит скачать сам).
# Nuitka нужна только для сборки и в программу не входит.
# Ошибки внешних программ (pip, Nuitka, ISCC) проверяются по коду выхода: их сообщения в stderr — не сбой.
$ErrorActionPreference = 'Continue'
$root = (Resolve-Path "$PSScriptRoot\..\..").Path
Set-Location $root
$ver = (Get-Content version.json -Raw -Encoding UTF8 | ConvertFrom-Json).version
Write-Host "Сборка версии $ver"
if (-not (Test-Path .build-venv)) { python -m venv .build-venv }
$py = "$root\.build-venv\Scripts\python.exe"
& $py -m pip install -q --disable-pip-version-check -r server\requirements.txt "nuitka>=2.6,<3"
if ($LASTEXITCODE) { throw 'pip' }
& $py -m nuitka --standalone --assume-yes-for-downloads --output-dir=build --output-filename=den-server.exe `
  --include-package=server --include-package=uvicorn --nofollow-import-to=server.tests --nofollow-import-to=pytest `
  deploy\windows\den_server.py
if ($LASTEXITCODE) { throw 'nuitka' }
$dist = "$root\build\den_server.dist"
foreach ($f in 'index.html', 'app.js', 'crm.js', 'sync.js', 'sync-config.js', 'i18n-en.js', 'styles.css', 'sw.js', 'version.js', 'version.json', 'manifest.webmanifest', 'install.html', 'qr-iphone.svg') {
  if (Test-Path $f) { Copy-Item $f $dist -Force }
}
Copy-Item assets $dist -Recurse -Force
Copy-Item deploy\windows\task.ps1 $dist -Force
& "$dist\den-server.exe" version
if ($LASTEXITCODE) { throw 'den-server.exe не запускается' }
$iscc = (Get-Command ISCC.exe -ErrorAction SilentlyContinue).Source
if (-not $iscc) { $iscc = "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe" }
& $iscc /Qp "/DAppVersion=$ver" "/DSourceDir=$dist" "/O$root\build" deploy\windows\den.iss
if ($LASTEXITCODE) { throw 'ISCC' }
Write-Host "Готово: build\den-setup-$ver.exe"
