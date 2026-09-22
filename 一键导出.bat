@echo off
chcp 65001 >nul 2>&1
cd /d "%~dp0"
title dsh 配置一键导出

echo.
echo ============================================
echo    dsh 配置一键导出
echo ============================================
echo.
echo   接下来只需要回答两个问题(文件夹放哪、口令是什么),
echo   其余全自动。不想设口令就直接回车,会给你生成一个。
echo.
pause

echo.
node "%~dp0scripts\export-cli.mjs"
if errorlevel 1 goto :err

echo.
echo   上面就是结果。记住口令,然后把那个文件夹整个拷到新电脑。
echo.
goto :end

:err
echo.
echo   导出失败了,把上面的红色文字发给能帮忙看看的人。
echo.

:end
echo.
pause
