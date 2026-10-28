; Установщик «День» для своего компьютера (без автозапуска и без прав администратора), собирается на Linux:
;   bash deploy/windows/nsis/build.sh   →   build/den-setup-<версия>-pc.exe
; Программа — %LOCALAPPDATA%\Programs\Den (встроенный Python, библиотеки, сервер, экраны), данные — %LOCALAPPDATA%\Den\data
; (при удалении программы остаются, как и den.env). Сервер слушает только 127.0.0.1:8787: снаружи компьютера его не видно.
; Тихая установка: den-setup-N-pc.exe /S /ADMINEMAIL=you@mail.ru /ADMINPASSWORD=пароль
Unicode true
!include MUI2.nsh
!include nsDialogs.nsh
!include LogicLib.nsh
!include FileFunc.nsh

!ifndef VERSION
  !define VERSION "dev"
!endif
!ifndef STAGE
  !define STAGE "..\..\..\build\pc-stage"
!endif
!ifndef OUTDIR
  !define OUTDIR "..\..\..\build"
!endif

Name "День — сервер"
OutFile "${OUTDIR}\den-setup-${VERSION}-pc.exe"
InstallDir "$LOCALAPPDATA\Programs\Den"
RequestExecutionLevel user
SetCompressor /SOLID lzma
BrandingText "День ${VERSION}"
!define UNINST "Software\Microsoft\Windows\CurrentVersion\Uninstall\DenServerPC"

Var Email
Var Password
Var EmailBox
Var PasswordBox

!define MUI_ICON "${STAGE}\den.ico"
!define MUI_UNICON "${STAGE}\den.ico"
!define MUI_WELCOMEPAGE_TITLE "Установка сервера «День»"
!define MUI_WELCOMEPAGE_TEXT "Сервер «День» будет работать на этом компьютере. Интернет и GitHub не нужны.$\r$\n$\r$\nПосле установки на рабочем столе появится значок «День — запустить сервер»."
!insertmacro MUI_PAGE_WELCOME
Page custom AdminPage AdminLeave
!insertmacro MUI_PAGE_INSTFILES
!define MUI_FINISHPAGE_RUN
!define MUI_FINISHPAGE_RUN_TEXT "Запустить «День» сейчас"
!define MUI_FINISHPAGE_RUN_FUNCTION StartNow
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "Russian"

Function .onInit
  ${GetParameters} $0
  ${GetOptions} $0 "/ADMINEMAIL=" $Email
  ${GetOptions} $0 "/ADMINPASSWORD=" $Password
FunctionEnd

; Первый вход — только при первой установке (при обновлении den.env уже есть, администратор тоже).
Function AdminPage
  ${If} ${FileExists} "$INSTDIR\den.env"
    Abort
  ${EndIf}
  !insertmacro MUI_HEADER_TEXT "Администратор" "Первый вход в «День»"
  nsDialogs::Create 1018
  Pop $0
  ${NSD_CreateLabel} 0 0 100% 24u "Email и пароль администратора (пароль не короче 8 символов). С ними вы войдёте в «День» и будете добавлять людей."
  Pop $0
  ${NSD_CreateLabel} 0 32u 100% 10u "Email:"
  Pop $0
  ${NSD_CreateText} 0 44u 100% 12u $Email
  Pop $EmailBox
  ${NSD_CreateLabel} 0 64u 100% 10u "Пароль:"
  Pop $0
  ${NSD_CreatePassword} 0 76u 100% 12u $Password
  Pop $PasswordBox
  nsDialogs::Show
FunctionEnd

Function AdminLeave
  ${NSD_GetText} $EmailBox $Email
  ${NSD_GetText} $PasswordBox $Password
  StrLen $1 $Password
  ${If} $1 < 8
    MessageBox MB_ICONEXCLAMATION "Пароль — не короче 8 символов."
    Abort
  ${EndIf}
  Push $Email
  Push "@"
  Call StrHas
  Pop $1
  ${If} $1 == 0
    MessageBox MB_ICONEXCLAMATION "Укажите email (с @)."
    Abort
  ${EndIf}
FunctionEnd

; 1, если в строке есть подстрока.
Function StrHas
  Exch $R1 ; что искать
  Exch
  Exch $R2 ; где
  Push $R3
  Push $R4
  StrLen $R3 $R1
  StrCpy $R4 0
  loop:
    StrCpy $0 $R2 $R3 $R4
    StrCmp $0 "" no
    StrCmp $0 $R1 yes
    IntOp $R4 $R4 + 1
    Goto loop
  yes:
    StrCpy $R1 1
    Goto done
  no:
    StrCpy $R1 0
  done:
  Pop $R4
  Pop $R3
  Pop $R2
  Exch $R1
FunctionEnd

Function StartNow
  ExecShell "open" "$INSTDIR\den-start.cmd"
FunctionEnd

Section "День"
  SetShellVarContext current
  ; Обновление: копия базы прежней версией, пока сервер не трогали. Запущенный сервер нужно закрыть самому.
  ${If} ${FileExists} "$INSTDIR\den.env"
    nsExec::Exec '"$INSTDIR\python\python.exe" "$INSTDIR\setup_den.py" backup'
    Pop $0
    Delete "$INSTDIR\start.cmd" ; прежнее имя
  ; старые файлы программы удаляются целиком (данные — в другой папке и не трогаются)
    RMDir /r "$INSTDIR\python"
    RMDir /r "$INSTDIR\server"
    RMDir /r "$INSTDIR\assets"
  ${EndIf}
  SetOutPath "$INSTDIR"
  File /r "${STAGE}\*"
  ${IfNot} ${FileExists} "$INSTDIR\den.env"
    nsExec::ExecToLog '"$INSTDIR\python\python.exe" "$INSTDIR\setup_den.py" env "$LOCALAPPDATA\Den\data"'
    Pop $0
    ${If} $0 != 0
      MessageBox MB_ICONSTOP "Не удалось подготовить сервер (код $0)."
      Abort
    ${EndIf}
    ${If} $Email != ""
      ; пароль — через переменную окружения, а не в командной строке (её видно в списке процессов)
      System::Call 'kernel32::SetEnvironmentVariable(t "DEN_NEW_PASSWORD", t "$Password")i'
      nsExec::ExecToLog '"$INSTDIR\python\python.exe" "$INSTDIR\setup_den.py" admin "$Email"'
      Pop $0
      System::Call 'kernel32::SetEnvironmentVariable(t "DEN_NEW_PASSWORD", t "")i'
      ${If} $0 != 0
        MessageBox MB_ICONEXCLAMATION "Администратора добавить не удалось (код $0). Сообщите об этом, пожалуйста."
      ${EndIf}
    ${EndIf}
  ${EndIf}
  CreateShortcut "$DESKTOP\День — запустить сервер.lnk" "$INSTDIR\den-start.cmd" "" "$INSTDIR\den.ico"
  CreateDirectory "$SMPROGRAMS\День"
  CreateShortcut "$SMPROGRAMS\День\День — запустить сервер.lnk" "$INSTDIR\den-start.cmd" "" "$INSTDIR\den.ico"
  CreateShortcut "$SMPROGRAMS\День\Удалить «День».lnk" "$INSTDIR\uninstall.exe"
  WriteUninstaller "$INSTDIR\uninstall.exe"
  WriteRegStr HKCU "${UNINST}" "DisplayName" "День — сервер"
  WriteRegStr HKCU "${UNINST}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${UNINST}" "Publisher" "День"
  WriteRegStr HKCU "${UNINST}" "DisplayIcon" "$INSTDIR\den.ico"
  WriteRegStr HKCU "${UNINST}" "UninstallString" '"$INSTDIR\uninstall.exe"'
  WriteRegDWORD HKCU "${UNINST}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINST}" "NoRepair" 1
SectionEnd

; Удаление: программа уходит, данные и копии (%LOCALAPPDATA%\Den\data) остаются.
Section "Uninstall"
  SetShellVarContext current
  Delete "$DESKTOP\День — запустить сервер.lnk"
  RMDir /r "$SMPROGRAMS\День"
  RMDir /r "$INSTDIR\python"
  RMDir /r "$INSTDIR\server"
  RMDir /r "$INSTDIR\assets"
  ; den.env (секрет этого сервера) остаётся: после повторной установки прежние входы и данные работают
  Delete "$INSTDIR\uninstall.exe"
  Delete "$INSTDIR\*.py"
  Delete "$INSTDIR\*.cmd"
  Delete "$INSTDIR\*.html"
  Delete "$INSTDIR\*.js"
  Delete "$INSTDIR\*.css"
  Delete "$INSTDIR\*.json"
  Delete "$INSTDIR\*.webmanifest"
  Delete "$INSTDIR\*.svg"
  Delete "$INSTDIR\den.ico"
  RMDir "$INSTDIR"
  DeleteRegKey HKCU "${UNINST}"
SectionEnd
