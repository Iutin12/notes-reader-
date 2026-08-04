$ErrorActionPreference = "Stop"

# Builds the private worker and unpacks the official Audiveris console edition.
# Generated files stay in desktop/native and are deliberately not committed.
$ProjectDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$TargetDir = Join-Path $ProjectDir "desktop\native\win32-x64"
$BuildDir = Join-Path $env:TEMP "notera-native-omr-win32-x64"
$VenvDir = Join-Path $BuildDir "venv"
$MsiPath = Join-Path $BuildDir "Audiveris-5.10.2-windowsConsole-x86_64.msi"
$ExtractDir = Join-Path $BuildDir "audiveris"

New-Item -ItemType Directory -Force -Path $TargetDir, $BuildDir | Out-Null
python -m venv $VenvDir
& "$VenvDir\Scripts\python.exe" -m pip install --disable-pip-version-check -r "$ProjectDir\omr-service\requirements.txt" pyinstaller
& "$VenvDir\Scripts\pyinstaller.exe" --noconfirm --clean --onefile --name notera-omr `
  --collect-all fastapi --collect-all pydantic --collect-all pypdf --collect-all pymupdf --collect-all fitz --collect-all uvicorn `
  --distpath $TargetDir --workpath "$BuildDir\work" --specpath "$BuildDir\spec" `
  "$ProjectDir\omr-service\app\main.py"

Invoke-WebRequest -Uri "https://github.com/Audiveris/audiveris/releases/download/5.10.2/Audiveris-5.10.2-windowsConsole-x86_64.msi" -OutFile $MsiPath
Start-Process msiexec.exe -Wait -ArgumentList "/a", "`"$MsiPath`"", "/qn", "TARGETDIR=`"$ExtractDir`""
$Audiveris = Get-ChildItem -Path $ExtractDir -Filter "Audiveris.exe" -Recurse | Select-Object -First 1
if ($null -eq $Audiveris) { throw "Audiveris.exe was not found in the official MSI." }
Copy-Item -Path (Join-Path $Audiveris.Directory.FullName "*") -Destination $TargetDir -Recurse -Force
