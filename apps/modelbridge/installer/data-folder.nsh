; Data folder page. The choice is recorded in HKCU and in data-location.txt
; beside ModelBridge.exe. The app reads only the file, so it never has to start
; reg.exe on its main thread; the registry copy survives updates, which replace
; everything in the install folder, and is written back to the file each time.

!include "LogicLib.nsh"
!include "FileFunc.nsh"
!include "WordFunc.nsh"

!ifndef MB_DATA_REGISTRY_KEY
  !define MB_DATA_REGISTRY_KEY "Software\ModelBridge"
!endif

Var MBDataDir
Var MBPreviousDataDir
Var MBDataField
Var MBDataNotice

; Pushes 1 when $R8 is $R9 or a folder inside it (case-insensitive), else 0.
Function MBIsInside
  StrLen $R7 $R9
  StrCpy $R6 $R8 $R7
  ${If} $R6 != $R9
    Push 0
    Return
  ${EndIf}
  StrCpy $R6 $R8 1 $R7
  ${If} $R6 == ""
  ${OrIf} $R6 == "\"
    Push 1
  ${Else}
    Push 0
  ${EndIf}
FunctionEnd

Function MBTrimDataDir
  ${Do}
    StrLen $R7 $MBDataDir
    ${If} $R7 <= 3
      ${ExitDo}
    ${EndIf}
    StrCpy $R6 $MBDataDir 1 -1
    ${If} $R6 != "\"
    ${AndIf} $R6 != "/"
    ${AndIf} $R6 != " "
      ${ExitDo}
    ${EndIf}
    StrCpy $MBDataDir $MBDataDir -1
  ${Loop}
FunctionEnd

Function MBLoadDataDir
  ReadRegStr $MBPreviousDataDir HKCU "${MB_DATA_REGISTRY_KEY}" "DataDir"
  ${If} $MBPreviousDataDir == ""
    StrCpy $MBPreviousDataDir "$APPDATA\ModelBridge"
  ${EndIf}
  ${If} $MBDataDir == ""
    StrCpy $MBDataDir $MBPreviousDataDir
  ${EndIf}
FunctionEnd

; Sets $R5 to an error message, or "" when $MBDataDir is usable.
Function MBValidateDataDir
  StrCpy $R5 ""
  Call MBTrimDataDir
  ${If} $MBDataDir == ""
    StrCpy $R5 "Choose a folder for ModelBridge's data."
    Return
  ${EndIf}
  System::Call 'shlwapi::PathIsRelative(t "$MBDataDir") i .r0'
  ${If} $0 != 0
    StrCpy $R5 "Enter a full folder path, such as D:\ModelBridge\Data."
    Return
  ${EndIf}
  StrLen $R7 $MBDataDir
  StrCpy $R6 $MBDataDir 1 1
  ${If} $R7 <= 3
  ${AndIf} $R6 == ":"
    StrCpy $R5 "Choose a folder, not the root of a drive."
    Return
  ${EndIf}
  ${If} $INSTDIR != ""
    StrCpy $R8 $MBDataDir
    StrCpy $R9 $INSTDIR
    Call MBIsInside
    Pop $0
    ${If} $0 == 1
      StrCpy $R5 "Choose a data folder outside the install folder ($INSTDIR). Updates replace everything in the install folder."
      Return
    ${EndIf}
  ${EndIf}
  ${If} $MBDataDir != $MBPreviousDataDir
  ${AndIf} ${FileExists} "$MBPreviousDataDir\state.json"
    StrCpy $R8 $MBDataDir
    StrCpy $R9 $MBPreviousDataDir
    Call MBIsInside
    Pop $0
    StrCpy $R8 $MBPreviousDataDir
    StrCpy $R9 $MBDataDir
    Call MBIsInside
    Pop $1
    ${If} $0 == 1
    ${OrIf} $1 == 1
      StrCpy $R5 "The new data folder cannot be inside the current one ($MBPreviousDataDir), or contain it."
      Return
    ${EndIf}
  ${EndIf}
FunctionEnd

Function MBUpdateDataNotice
  ${If} $MBDataDir == $MBPreviousDataDir
    ${If} ${FileExists} "$MBDataDir\state.json"
      ${NSD_SetText} $MBDataNotice "Your existing ModelBridge data in this folder will be kept."
    ${Else}
      ${NSD_SetText} $MBDataNotice "ModelBridge will create its data here on first start."
    ${EndIf}
  ${ElseIf} ${FileExists} "$MBDataDir\state.json"
    ${NSD_SetText} $MBDataNotice "This folder already has ModelBridge data. It will be used as it is."
  ${ElseIf} ${FileExists} "$MBPreviousDataDir\state.json"
    ${NSD_SetText} $MBDataNotice "Your existing data will be copied here from $MBPreviousDataDir. The original folder is kept."
  ${Else}
    ${NSD_SetText} $MBDataNotice "ModelBridge will create its data here on first start."
  ${EndIf}
FunctionEnd

Function MBDataChanged
  Pop $0
  ${NSD_GetText} $MBDataField $MBDataDir
  Call MBUpdateDataNotice
FunctionEnd

Function MBBrowseData
  Pop $0
  ${NSD_GetText} $MBDataField $1
  nsDialogs::SelectFolderDialog "Choose the folder for ModelBridge's data" "$1"
  Pop $1
  ${If} $1 != error
  ${AndIf} $1 != ""
    ${NSD_SetText} $MBDataField $1
  ${EndIf}
FunctionEnd

Function MBDataPage
  ${If} ${Silent}
    Abort
  ${EndIf}
  Call MBLoadDataDir
  !insertmacro MUI_HEADER_TEXT "Choose a data folder" "Where ModelBridge keeps its settings, connections, keys and usage history."
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    MessageBox MB_OK|MB_ICONSTOP "Could not create the data folder page. Installation cannot continue."
    Quit
  ${EndIf}
  ${NSD_CreateLabel} 0 0 100% 34u "ModelBridge saves sign-ins, access keys, connected hosts, usage history and logs in this folder. Keys are stored unencrypted, so choose a folder only you can open. Updates and uninstalling never delete it."
  Pop $0
  ${NSD_CreateLabel} 0 42u 100% 10u "Data folder:"
  Pop $0
  ${NSD_CreateDirRequest} 0 54u 232u 13u "$MBDataDir"
  Pop $MBDataField
  ${NSD_OnChange} $MBDataField MBDataChanged
  ${NSD_CreateBrowseButton} 238u 53u 62u 15u "Browse..."
  Pop $0
  ${NSD_OnClick} $0 MBBrowseData
  ${NSD_CreateLabel} 0 76u 100% 30u ""
  Pop $MBDataNotice
  Call MBUpdateDataNotice
  nsDialogs::Show
FunctionEnd

Function MBDataLeave
  ${NSD_GetText} $MBDataField $MBDataDir
  Call MBValidateDataDir
  ${If} $R5 != ""
    MessageBox MB_OK|MB_ICONEXCLAMATION "$R5"
    Abort
  ${EndIf}
  ${NSD_SetText} $MBDataField $MBDataDir
  ClearErrors
  CreateDirectory "$MBDataDir"
  FileOpen $0 "$MBDataDir\.modelbridge-write-test" w
  ${If} ${Errors}
    MessageBox MB_OK|MB_ICONEXCLAMATION "ModelBridge cannot create or write to $MBDataDir. Choose another folder."
    Abort
  ${EndIf}
  FileClose $0
  Delete "$MBDataDir\.modelbridge-write-test"
FunctionEnd

; Runs in the install section, also for silent updates (no page shown).
Function MBApplyDataFolder
  ${If} $MBDataDir == ""
    ${GetParameters} $0
    ; Launchers quote the whole argument ("/DATADIR=C:\a b"), which GetOptions
    ; cannot read, so I turn it into /DATADIR="C:\a b" first.
    ${WordReplace} "$0" '"/DATADIR=' '/DATADIR="' "+" $0
    ClearErrors
    ${GetOptions} "$0" "/DATADIR=" $1
    ${IfNot} ${Errors}
      StrCpy $MBDataDir $1
    ${EndIf}
  ${EndIf}
  Call MBLoadDataDir
  Call MBValidateDataDir
  ${If} $R5 != ""
    DetailPrint "Ignoring data folder $MBDataDir: $R5"
    StrCpy $MBDataDir $MBPreviousDataDir
  ${EndIf}
  CreateDirectory "$MBDataDir"
  ${If} $MBDataDir != $MBPreviousDataDir
  ${AndIf} ${FileExists} "$MBPreviousDataDir\state.json"
  ${AndIfNot} ${FileExists} "$MBDataDir\state.json"
    DetailPrint "Copying ModelBridge data to $MBDataDir"
    CopyFiles /SILENT "$MBPreviousDataDir\*.*" "$MBDataDir"
  ${EndIf}
  WriteRegStr HKCU "${MB_DATA_REGISTRY_KEY}" "DataDir" "$MBDataDir"
  ClearErrors
  FileOpen $0 "$INSTDIR\data-location.txt" w
  ${If} ${Errors}
    DetailPrint "Could not record the data folder in $INSTDIR"
  ${Else}
    FileWriteUTF16LE /BOM $0 "$MBDataDir"
    FileClose $0
  ${EndIf}
FunctionEnd
