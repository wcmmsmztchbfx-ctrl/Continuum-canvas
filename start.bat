@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 goto missing_node
node -e "var v=process.versions.node.split('.').map(Number);process.exit(v[0]>22?0:v[0]===22?v[1]>=18?0:1:1)"
if errorlevel 1 goto missing_node
node scripts\launch.mjs
set "launch_exit=%errorlevel%"
if not "%launch_exit%"=="0" pause
exit /b %launch_exit%
:missing_node
echo Node.js 22.18+ is required. Install a supported LTS version from https://nodejs.org/
echo Restart this script after installation. npm is included with Node.js.
pause
exit /b 1
