!ifndef BUILD_UNINSTALLER
!include "MUI2.nsh"
!include "nsDialogs.nsh"
!include "FileFunc.nsh"
!include "LogicLib.nsh"
!include "WordFunc.nsh"

Var MBHost
Var MBDialog
Var MBHostRadio
Var MBClientRadio
Var MBStatus
Var MBNext
Var MBReady
Var MBCli
Var MBDescription
Var MBPaths
Var MBOriginalPath
Var MBCandidate
Var MBRoot
Var MBFind
Var MBEntry

!ifmacrondef ModelBridgeDetectDevTunnel
  !macro ModelBridgeDetectDevTunnel
    Call MBDetectDevTunnel
  !macroend

  Function MBConsiderCandidate
    ${If} $MBCli != ""
      Return
    ${EndIf}
    System::Call 'shlwapi::PathIsRelative(t "$MBCandidate") i .r0'
    ${If} $0 != 0
      Return
    ${EndIf}
    ${If} ${FileExists} "$MBCandidate"
      StrCpy $MBCli $MBCandidate
    ${EndIf}
  FunctionEnd

  Function MBSearchPackages
    FindFirst $MBFind $MBEntry "$MBRoot\Packages\Microsoft.devtunnel_*"
    ${DoWhile} $MBEntry != ""
      StrCpy $MBCandidate "$MBRoot\Packages\$MBEntry\devtunnel.exe"
      Call MBConsiderCandidate
      FindNext $MBFind $MBEntry
    ${Loop}
    FindClose $MBFind
  FunctionEnd

  Function MBDetectDevTunnel
    StrCpy $MBReady "0"
    StrCpy $MBCli ""
    StrCpy $MBDescription "Not found. Install Microsoft's CLI separately, then click Recheck."
    StrCpy $MBPaths $MBOriginalPath
    ReadRegStr $0 HKLM "SYSTEM\CurrentControlSet\Control\Session Manager\Environment" "Path"
    ReadRegStr $1 HKCU "Environment" "Path"
    ExpandEnvStrings $0 $0
    ExpandEnvStrings $1 $1
    StrCpy $MBPaths "$MBPaths;$0;$1"
    System::Call 'kernel32::SetEnvironmentVariable(t "PATH", t "$MBPaths") i .r0'
    ${If} $0 == 0
      StrCpy $MBDescription "Could not refresh this installer's PATH. Restart the installer after installing the CLI."
      Return
    ${EndIf}
    ${DoWhile} $MBPaths != ""
      ${WordFind} "$MBPaths" ";" "+1" $0
      ${WordFind} "$MBPaths" ";" "+1}" $MBPaths
      ExpandEnvStrings $0 $0
      StrCpy $1 $0 1
      ${If} $1 == '$\"'
        StrCpy $0 $0 -1 1
      ${EndIf}
      ${If} $0 != ""
        StrCpy $MBCandidate "$0\devtunnel.exe"
        Call MBConsiderCandidate
      ${EndIf}
    ${Loop}
    ReadEnvStr $MBRoot "LOCALAPPDATA"
    ${If} $MBRoot != ""
      StrCpy $MBCandidate "$MBRoot\Microsoft\WinGet\Links\devtunnel.exe"
      Call MBConsiderCandidate
    ${EndIf}
    ReadEnvStr $MBRoot "ProgramW6432"
    ${If} $MBRoot == ""
      ReadEnvStr $MBRoot "ProgramFiles"
    ${EndIf}
    ${If} $MBRoot != ""
      StrCpy $MBRoot "$MBRoot\WinGet"
      StrCpy $MBCandidate "$MBRoot\Links\devtunnel.exe"
      Call MBConsiderCandidate
    ${EndIf}
    ${If} $MBCli == ""
      ReadEnvStr $MBRoot "LOCALAPPDATA"
      ${If} $MBRoot != ""
        StrCpy $MBRoot "$MBRoot\Microsoft\WinGet"
        Call MBSearchPackages
      ${EndIf}
      ReadEnvStr $MBRoot "ProgramW6432"
      ${If} $MBRoot == ""
        ReadEnvStr $MBRoot "ProgramFiles"
      ${EndIf}
      ${If} $MBRoot != ""
        StrCpy $MBRoot "$MBRoot\WinGet"
        Call MBSearchPackages
      ${EndIf}
    ${EndIf}
    ${If} $MBCli == ""
      Return
    ${EndIf}
    nsExec::ExecToStack /TIMEOUT=10000 '"$MBCli" --help'
    Pop $0
    Pop $1
    ${If} $0 != "0"
      StrCpy $MBDescription "Found but could not run: $MBCli. Repair the CLI using Microsoft's instructions, then Recheck."
      Return
    ${EndIf}
    ${WordFind} "$1" "Dev Tunnels CLI" "E+1}" $0
    ${If} ${Errors}
      StrCpy $MBDescription "Not a valid Dev Tunnels CLI: $MBCli. Check your PATH and Microsoft's instructions."
      Return
    ${EndIf}
    StrCpy $MBReady "1"
    StrCpy $MBDescription "Ready: $MBCli"
  FunctionEnd
!endif

!macro customInit
  ReadEnvStr $MBOriginalPath "PATH"
  StrCpy $MBHost "1"
  StrCpy $MBReady "0"
  ${If} ${Silent}
    StrCpy $MBHost "0"
  ${EndIf}
  ${GetParameters} $0
  ClearErrors
  ${GetOptions} "$0" "/HOST" $1
  ${IfNot} ${Errors}
    StrCpy $MBHost "1"
    ${If} ${Silent}
      !insertmacro ModelBridgeDetectDevTunnel
      ${If} $MBReady != "1"
        DetailPrint "ModelBridge hosting prerequisite failed: $MBDescription"
        SetErrorLevel 2
        Quit
      ${EndIf}
    ${EndIf}
  ${EndIf}
!macroend

!macro customPageAfterChangeDir
  Page custom MBPrerequisitePage MBPrerequisiteLeave
!macroend

Function MBUpdatePrerequisiteStatus
  ${NSD_SetText} $MBStatus "$MBDescription"
  GetDlgItem $MBNext $HWNDPARENT 1
  ${If} $MBHost == "1"
  ${AndIf} $MBReady != "1"
    EnableWindow $MBNext 0
  ${Else}
    EnableWindow $MBNext 1
  ${EndIf}
FunctionEnd

Function MBRoleChanged
  Pop $0
  ${NSD_GetState} $MBHostRadio $MBHost
  Call MBUpdatePrerequisiteStatus
FunctionEnd

Function MBRecheck
  Pop $0
  !insertmacro ModelBridgeDetectDevTunnel
  Call MBUpdatePrerequisiteStatus
FunctionEnd

Function MBOpenInstructions
  Pop $0
  ClearErrors
  ExecShell "open" "https://learn.microsoft.com/en-us/azure/developer/dev-tunnels/get-started"
  ${If} ${Errors}
    MessageBox MB_OK|MB_ICONEXCLAMATION "Could not open your browser. Visit https://learn.microsoft.com/en-us/azure/developer/dev-tunnels/get-started"
  ${EndIf}
FunctionEnd

Function MBPrerequisitePage
  !insertmacro MUI_HEADER_TEXT "Host or client prerequisites" "The same ModelBridge application supports both roles."
  nsDialogs::Create 1018
  Pop $MBDialog
  ${If} $MBDialog == error
    MessageBox MB_OK|MB_ICONSTOP "Could not create the prerequisite page. Installation cannot continue."
    Quit
  ${EndIf}
  ${NSD_CreateRadioButton} 0 0 100% 12u "Use as a host (requires Microsoft Dev Tunnels CLI)"
  Pop $MBHostRadio
  ${NSD_OnClick} $MBHostRadio MBRoleChanged
  ${NSD_CreateRadioButton} 0 19u 100% 12u "Client-only for now (URL and key; no CLI required)"
  Pop $MBClientRadio
  ${NSD_OnClick} $MBClientRadio MBRoleChanged
  ${If} $MBHost == "1"
    ${NSD_Check} $MBHostRadio
  ${Else}
    ${NSD_Check} $MBClientRadio
  ${EndIf}
  ${NSD_CreateLabel} 0 40u 100% 27u "Hosting requires a separately installed Microsoft CLI. ModelBridge does not download it, install it, or accept Microsoft's terms for you."
  Pop $0
  ${NSD_CreateLink} 0 73u 100% 12u "Open Microsoft's installation instructions"
  Pop $0
  ${NSD_OnClick} $0 MBOpenInstructions
  ${NSD_CreateLabel} 0 93u 100% 32u ""
  Pop $MBStatus
  ${NSD_CreateButton} 0 130u 65u 14u "Recheck"
  Pop $0
  ${NSD_OnClick} $0 MBRecheck
  ${NSD_CreateLabel} 75u 130u 220u 24u "Keep this wizard open while installing the CLI. You can change roles later in the app."
  Pop $0
  !insertmacro ModelBridgeDetectDevTunnel
  Call MBUpdatePrerequisiteStatus
  nsDialogs::Show
FunctionEnd

Function MBPrerequisiteLeave
  ${If} $MBHost == "1"
    !insertmacro ModelBridgeDetectDevTunnel
    ${If} $MBReady != "1"
      Call MBUpdatePrerequisiteStatus
      MessageBox MB_OK|MB_ICONEXCLAMATION "$MBDescription"
      Abort
    ${EndIf}
  ${EndIf}
  EnableWindow $MBNext 1
FunctionEnd
!endif
