!ifndef PAYLOAD_DIR
  !error "PAYLOAD_DIR must point to a prepared server payload."
!endif
!ifndef OUTPUT_FILE
  !error "OUTPUT_FILE must be set to a new candidate installer path."
!endif

Unicode true
Name "Business Billing Server"
OutFile "${OUTPUT_FILE}"
InstallDir "$TEMP\MultiBusinessBilling\Server"
RequestExecutionLevel admin
ShowInstDetails show
ShowUninstDetails show

!define UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\MultiBusinessBillingServer"

Function .onInit
  ReadEnvStr $0 "ProgramData"
  StrCmp $0 "" no_program_data
  StrCpy $INSTDIR "$0\MultiBusinessBilling\Server"
  Return
no_program_data:
  MessageBox MB_ICONSTOP|MB_OK "Windows did not provide the ProgramData directory. Server installation cannot continue."
  Abort
FunctionEnd

Section "Install server"
  InitPluginsDir
  StrCmp $PLUGINSDIR "" extraction_failed
  SetOutPath "$PLUGINSDIR\billing-server-payload"
  File /r "${PAYLOAD_DIR}\*.*"

  IfFileExists "$PLUGINSDIR\billing-server-payload\server-payload-manifest.json" payload_manifest_found extraction_failed
payload_manifest_found:
  IfFileExists "$PLUGINSDIR\billing-server-payload\apps\server\scripts\windows\install-server.ps1" installer_script_found extraction_failed
installer_script_found:
  IfFileExists "$PLUGINSDIR\billing-server-payload\apps\server\scripts\windows\run-server-install.ps1" diagnostic_wrapper_found extraction_failed
diagnostic_wrapper_found:
  GetTempFileName $2 "$TEMP"
  FileOpen $3 "$2" a
  FileWrite $3 "Business Billing Server setup started.$\r$\n"
  FileClose $3
  nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -File "$PLUGINSDIR\billing-server-payload\apps\server\scripts\windows\run-server-install.ps1" -InstallerScript "$PLUGINSDIR\billing-server-payload\apps\server\scripts\windows\install-server.ps1" -DiagnosticLog "$2" -PayloadRoot "$PLUGINSDIR\billing-server-payload" -ServerRoot "$INSTDIR"'
  Pop $0
  Pop $1
  StrCmp $0 "0" installation_script_succeeded
  StrCmp $0 "error" installation_process_launch_failed
  StrCmp $0 "timeout" installation_process_launch_failed
  FileOpen $3 "$2" a
  FileWrite $3 "stage=PowerShell script execution; exit_code=$0$\r$\n"
  FileWrite $3 "PowerShell output (stdout/stderr):$\r$\n$1$\r$\n"
  FileClose $3
  SetErrorLevel $0
  MessageBox MB_ICONSTOP|MB_OK "Server installation failed during PowerShell script execution (exit code $0). Newly copied app files were rolled back; existing configuration and database data were preserved. Diagnostic log: $2. If the output reports PSSecurityException or that scripts are disabled, Windows policy blocked the unsigned installer scripts. Do not disable or bypass policy; ask an administrator to approve a compatible policy or sign the scripts with the organization's trusted publisher certificate."
  Quit
installation_process_launch_failed:
  FileOpen $3 "$2" a
  FileWrite $3 "stage=PowerShell process launch; result=$0$\r$\n"
  FileWrite $3 "PowerShell output (stdout/stderr):$\r$\n$1$\r$\n"
  FileClose $3
  SetErrorLevel 1
  MessageBox MB_ICONSTOP|MB_OK "Server installation could not start or timed out. Diagnostic log: $2. No installation success is reported. Do not bypass Windows policy; ask an administrator to review the diagnostic and approve a compatible policy or trusted script signing."
  Quit

installation_script_succeeded:
  IfFileExists "$INSTDIR\server-payload-manifest.json" installed_manifest_found post_install_verification_failed
installed_manifest_found:
  IfFileExists "$INSTDIR\apps\server\dist\src\index.js" installed_backend_found post_install_verification_failed
installed_backend_found:
  WriteUninstaller "$INSTDIR\uninstall.exe"
  IfFileExists "$INSTDIR\uninstall.exe" uninstaller_found post_install_verification_failed
uninstaller_found:
  WriteRegStr HKLM "${UNINSTALL_KEY}" "DisplayName" "Business Billing Server"
  WriteRegStr HKLM "${UNINSTALL_KEY}" "UninstallString" '"$INSTDIR\uninstall.exe"'
  WriteRegStr HKLM "${UNINSTALL_KEY}" "DisplayVersion" "0.1.0"
  ReadRegStr $1 HKLM "${UNINSTALL_KEY}" "DisplayName"
  StrCmp $1 "Business Billing Server" installation_succeeded post_install_verification_failed
post_install_verification_failed:
  SetErrorLevel 1
  MessageBox MB_ICONSTOP|MB_OK "Server installation did not pass post-install verification. Do not use this installation. Review the installer log and have an administrator investigate; no database migrations or data cleanup were performed."
  Quit
extraction_failed:
  SetErrorLevel 1
  MessageBox MB_ICONSTOP|MB_OK "Server installer payload extraction failed or required payload files are missing. Installation has been stopped; no success state will be shown."
  Quit
installation_succeeded:
SectionEnd

Section "Uninstall"
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -File "$INSTDIR\apps\server\scripts\windows\uninstall-server.ps1" -ServerRoot "$INSTDIR"'
  Pop $0
  StrCmp $0 "0" uninstall_succeeded
  SetErrorLevel 1
  MessageBox MB_ICONSTOP|MB_OK "Server removal was stopped (PowerShell exit: $0) because safe cleanup could not be verified. Configuration and database data were preserved. If Windows PowerShell or organizational policy blocked the script, have your administrator review the policy and approve or sign the script through the approved process. This uninstaller does not change policy."
  Quit

uninstall_succeeded:
  DeleteRegKey HKLM "${UNINSTALL_KEY}"
  Delete "$INSTDIR\uninstall.exe"
SectionEnd
