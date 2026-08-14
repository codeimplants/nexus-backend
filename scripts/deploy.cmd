@echo off
setlocal enabledelayedexpansion

REM ============================================================================
REM  Double-clickable deploy for nexus-backend.
REM
REM  Exists so deploying does not require opening a terminal or remembering any
REM  flags: double-click this file, answer the questions, read the result.
REM
REM  All the real work is in deploy.sh. This only asks the questions and calls
REM  it, so there is no second implementation to drift out of sync.
REM
REM  Differs from the sonebill version in two ways, both deliberate:
REM    - nexus deploy.sh has no --branch flag, so there is no branch prompt.
REM    - prod migrations are a separate question, because on this project a
REM      migration is NOT included by default and is not undone by redeploying
REM      older code.
REM
REM  The `pause` at the end is not decoration: a double-clicked console window
REM  closes the instant the script exits, so without it a failure would flash
REM  past unread and the deploy would look like it did nothing.
REM ============================================================================

cd /d "%~dp0.."

echo.
echo  ============================================
echo   Nexus backend deploy
echo  ============================================
echo.

REM --- Locate Git Bash --------------------------------------------------------
REM Not `where bash`: that can resolve to the WSL shim, which has its own
REM filesystem and SSH config, and would fail with a confusing "cannot SSH".
set "BASH_EXE="
if exist "%ProgramFiles%\Git\bin\bash.exe" set "BASH_EXE=%ProgramFiles%\Git\bin\bash.exe"
if not defined BASH_EXE if exist "%ProgramFiles(x86)%\Git\bin\bash.exe" set "BASH_EXE=%ProgramFiles(x86)%\Git\bin\bash.exe"
if not defined BASH_EXE if exist "%LOCALAPPDATA%\Programs\Git\bin\bash.exe" set "BASH_EXE=%LOCALAPPDATA%\Programs\Git\bin\bash.exe"

if not defined BASH_EXE (
    echo  ERROR: Git Bash not found.
    echo  Install Git for Windows: https://git-scm.com/download/win
    echo.
    pause
    exit /b 1
)

REM --- Environment ------------------------------------------------------------
echo  Which environment?
echo.
echo    1^) dev       ^(port 6001^)  - safe to break
echo    2^) preprod   ^(port 6002^)  - rehearsal for prod
echo    3^) prod      ^(port 6003^)  - LIVE APPS depend on this
echo    4^) inspect   - just show what each server is running, change nothing
echo    5^) restart prod only - no pull, no build, no migration
echo.
set "ENVCHOICE="
set /p "ENVCHOICE=  Enter 1-5 [1]: "
if "!ENVCHOICE!"=="" set "ENVCHOICE=1"

if "!ENVCHOICE!"=="4" (
    echo.
    "%BASH_EXE%" scripts/deploy.sh --inspect
    echo.
    pause
    exit /b 0
)

if "!ENVCHOICE!"=="5" (
    echo.
    echo  Restarting prod without changing any code.
    set "GO="
    set /p "GO=  Continue? [y/N]: "
    if /i not "!GO!"=="y" (
        echo.
        echo  Cancelled. Nothing was changed.
        echo.
        pause
        exit /b 0
    )
    echo.
    "%BASH_EXE%" scripts/deploy.sh --env prod --restart-only --yes
    set "RESULT=!ERRORLEVEL!"
    goto :report
)

if "!ENVCHOICE!"=="1" set "ENVNAME=dev"
if "!ENVCHOICE!"=="2" set "ENVNAME=preprod"
if "!ENVCHOICE!"=="3" set "ENVNAME=prod"

if not defined ENVNAME (
    echo.
    echo  ERROR: "!ENVCHOICE!" is not a valid choice.
    echo.
    pause
    exit /b 1
)

REM --- Migrations -------------------------------------------------------------
REM dev and preprod always migrate - that is where a migration gets rehearsed.
REM prod only migrates when asked, because `migrate deploy` alters a live
REM database and redeploying an older commit does NOT roll it back.
set "MIGRATEFLAG="
if "!ENVNAME!"=="prod" (
    echo.
    echo  Does this deploy include a database schema change?
    echo.
    echo    Answer y only if new files were added under prisma/migrations.
    echo    Answering n on a deploy that needs one leaves the app running
    echo    against the old schema, and it will error.
    echo.
    echo    A migration CANNOT be undone by redeploying older code.
    echo.
    set "DOMIGRATE="
    set /p "DOMIGRATE=  Run migrations on PROD? [y/N]: "
    if /i "!DOMIGRATE!"=="y" set "MIGRATEFLAG=--migrate"
)

REM --- Confirm ----------------------------------------------------------------
echo.
echo  ------------------------------------------------
echo   Environment : !ENVNAME!
if "!ENVNAME!"=="prod" (
    if defined MIGRATEFLAG (
        echo   Migrations  : YES  ^<-- will alter the live database
    ) else (
        echo   Migrations  : no
    )
) else (
    echo   Migrations  : yes ^(automatic on !ENVNAME!^)
)
echo  ------------------------------------------------
echo.

if "!ENVNAME!"=="prod" (
    echo  *** This is PRODUCTION. Published apps call this backend for ***
    echo  *** version checks, force-update and the kill switch.        ***
    echo.
    set "GO="
    set /p "GO=  Type 'deploy' to continue: "
    if /i not "!GO!"=="deploy" (
        echo.
        echo  Cancelled. Nothing was changed.
        echo.
        pause
        exit /b 0
    )
) else (
    set "GO="
    set /p "GO=  Continue? [y/N]: "
    if /i not "!GO!"=="y" (
        echo.
        echo  Cancelled. Nothing was changed.
        echo.
        pause
        exit /b 0
    )
)

REM --- Deploy -----------------------------------------------------------------
REM --yes because this script has already confirmed. Without it deploy.sh waits
REM on its own stdin prompt, which a double-clicked window handles badly.
echo.
"%BASH_EXE%" scripts/deploy.sh --env !ENVNAME! --yes !MIGRATEFLAG!
set "RESULT=!ERRORLEVEL!"

:report
echo.
if "!RESULT!"=="0" (
    echo  ============================================
    echo   Deploy finished OK.
    echo  ============================================
    echo.
    echo   Check the line above that starts "now at:" - it should
    echo   show the commit you expected to ship.
) else (
    echo  ============================================
    echo   DEPLOY FAILED ^(exit code !RESULT!^)
    echo   Nothing above said "Deployed" - read the
    echo   error and fix it before trying again.
    echo  ============================================
)
echo.
pause
exit /b !RESULT!
