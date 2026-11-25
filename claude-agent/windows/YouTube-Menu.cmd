@echo off
rem Menu do YouTube: enviar (privado), publicar, agendar (Open Generative AI)
rem Duplo clique para abrir. Nao precisa de administrador.
cd /d "%~dp0..\.."
powershell.exe -NoProfile -STA -ExecutionPolicy Bypass -File "%~dp0youtube-menu.ps1" %*
echo.
pause
