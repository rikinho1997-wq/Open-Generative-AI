@echo off
rem Assistente de configuracao do YouTube (Open Generative AI)
rem Duplo clique para abrir. Nao precisa de administrador.
cd /d "%~dp0..\.."
powershell.exe -NoProfile -STA -ExecutionPolicy Bypass -File "%~dp0youtube-setup.ps1" %*
echo.
pause
