@echo off
rem ---------------------------------------------------------------
rem  Uninstaller for the WorkBuddy status panel.
rem
rem  This file is deliberately pure ASCII: cmd.exe parses .bat files
rem  using the *console* code page, so any non-ASCII byte here can
rem  shift the parser and break the script on machines with a
rem  different locale. All Chinese text is printed by the exe itself
rem  (it writes UTF-8 to a console switched to code page 65001).
rem
rem  The exe name contains Chinese characters, so it is never spelled
rem  out here -- it is picked up from the folder with a wildcard.
rem ---------------------------------------------------------------
chcp 65001 >nul
setlocal
cd /d "%~dp0"

set "EXE="
set "EXEN="
for %%F in ("%~dp0*.exe") do if not defined EXE set "EXE=%%~fF" & set "EXEN=%%~nxF"
if not defined EXE goto noexe

rem Close a running panel first, otherwise its open files block the cleanup.
taskkill /f /im "%EXEN%" >nul 2>&1

"%EXE%" --uninstall
echo.
pause
exit /b 0

:noexe
echo.
echo   [ERROR] No .exe found in this folder.
echo           Please extract the whole zip again and run this file
echo           from the extracted folder.
echo.
pause
exit /b 1
