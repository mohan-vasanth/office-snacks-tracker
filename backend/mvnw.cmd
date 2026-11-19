@echo off
setlocal
set "MAVEN_HOME=%~dp0..\.tools\apache-maven-3.10.1"
if not exist "%MAVEN_HOME%\bin\mvn.cmd" (
  echo Project-local Maven is missing. Extract .tools\apache-maven-3.10.1-bin.zip into .tools first.
  exit /b 1
)
call "%MAVEN_HOME%\bin\mvn.cmd" -Dmaven.repo.local="%~dp0..\.tools\m2" %*
exit /b %ERRORLEVEL%
