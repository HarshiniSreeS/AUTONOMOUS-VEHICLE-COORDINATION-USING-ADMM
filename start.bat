@echo off
echo ============================================
echo   AV Coordination Simulation - Startup
echo ============================================
echo.

REM Check Python is available
python --version >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Python is not installed or not in PATH.
    echo         Install Python 3.10+ from https://python.org
    pause
    exit /b 1
)

REM Install dependencies if missing
echo [1/3] Checking dependencies...
pip show fastapi >nul 2>&1 || pip install fastapi
pip show uvicorn >nul 2>&1 || pip install uvicorn
pip show numpy   >nul 2>&1 || pip install numpy
echo       Done.
echo.

REM Check that trajectories.txt exists
if not exist "%~dp0trajectories.txt" (
    echo [ERROR] trajectories.txt not found in project folder!
    echo         Place the NGSIM trajectory data file here:
    echo         %~dp0trajectories.txt
    pause
    exit /b 1
)

REM Start the server
echo [2/3] Starting server on http://localhost:8000 ...
echo.
echo ============================================
echo   Open your browser and go to:
echo   http://localhost:8000
echo ============================================
echo.
echo   Press Ctrl+C to stop the server.
echo.

cd /d "%~dp0simulation"
python -m uvicorn server:app --host 0.0.0.0 --port 8000 --reload
