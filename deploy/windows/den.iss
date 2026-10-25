; Установщик сервера «День» для Windows (Inno Setup 6). Собирается из build.ps1.
; Программа — C:\Program Files\Den, данные и копии — C:\ProgramData\Den\data (при удалении программы остаются).
; Тихая установка: den-setup-N.exe /VERYSILENT /ADMINEMAIL=you@mail.ru /ADMINPASSWORD=пароль
#ifndef AppVersion
  #define AppVersion "dev"
#endif
#ifndef SourceDir
  #define SourceDir "..\..\build\den_server.dist"
#endif

[Setup]
AppId={{6F1D4C2A-9B7E-4E51-A3D0-DE0000000001}
AppName=День — сервер
AppVersion={#AppVersion}
AppPublisher=День
DefaultDirName={autopf}\Den
DisableDirPage=yes
DisableProgramGroupPage=yes
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputBaseFilename=den-setup-{#AppVersion}
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
UninstallDisplayName=День — сервер
CloseApplications=no

[Languages]
Name: "ru"; MessagesFile: "compiler:Languages\Russian.isl"

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Dirs]
Name: "{commonappdata}\Den\data"

[INI]
Filename: "{autodesktop}\День (сервер).url"; Section: "InternetShortcut"; Key: "URL"; String: "http://localhost:8787/"

[UninstallDelete]
Type: files; Name: "{autodesktop}\День (сервер).url"

[UninstallRun]
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\task.ps1"" -Action remove"; Flags: runhidden; RunOnceId: "RemoveTask"

[Code]
var
  AdminPage: TInputQueryWizardPage;

function DataDir: String;
begin
  Result := ExpandConstant('{commonappdata}\Den\data');
end;

function FirstInstall: Boolean;
begin
  Result := not FileExists(ExpandConstant('{autopf}\Den\den.env'));
end;

procedure InitializeWizard;
begin
  AdminPage := CreateInputQueryPage(wpWelcome, 'Администратор', 'Первый вход в «День»',
    'Email и пароль администратора (не короче 8 символов). Им вы войдёте в приложение и будете добавлять людей.');
  AdminPage.Add('Email:', False);
  AdminPage.Add('Пароль:', True);
  AdminPage.Values[0] := ExpandConstant('{param:ADMINEMAIL|}');
  AdminPage.Values[1] := ExpandConstant('{param:ADMINPASSWORD|}');
end;

function ShouldSkipPage(PageID: Integer): Boolean;
begin
  Result := (PageID = AdminPage.ID) and not FirstInstall;
end;

function NextButtonClick(CurPageID: Integer): Boolean;
begin
  Result := True;
  if (CurPageID = AdminPage.ID) and ((Pos('@', AdminPage.Values[0]) = 0) or (Length(AdminPage.Values[1]) < 8)) then
  begin
    MsgBox('Укажите email и пароль не короче 8 символов.', mbError, MB_OK);
    Result := False;
  end;
end;

function Run(const Exe, Params: String): Integer;
begin
  if not Exec(Exe, Params, ExpandConstant('{app}'), SW_HIDE, ewWaitUntilTerminated, Result) then
    Result := -1;
end;

function PowerShell(const Params: String): Integer;
begin
  Result := Run('powershell.exe', '-NoProfile -ExecutionPolicy Bypass ' + Params);
end;

// Перед обновлением: остановить сервер и сделать копию базы прежней версией программы.
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  App: String;
  Code: Integer;
begin
  Result := '';
  App := ExpandConstant('{autopf}\Den');
  if FileExists(App + '\task.ps1') then
    PowerShell('-File "' + App + '\task.ps1" -Action stop');
  if FileExists(App + '\den-server.exe') and FileExists(App + '\den.env') then
    Exec(App + '\den-server.exe', 'admin backup', App, SW_HIDE, ewWaitUntilTerminated, Code);
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  App, Exe: String;
  Code: Integer;
begin
  if CurStep <> ssPostInstall then Exit;
  App := ExpandConstant('{app}');
  Exe := App + '\den-server.exe';
  if not FileExists(App + '\den.env') then
  begin
    Run(Exe, 'init-env "' + DataDir + '"');
    // Секрет и база — только для SYSTEM и администраторов.
    Run('icacls.exe', '"' + App + '\den.env" /inheritance:r /grant:r *S-1-5-18:F *S-1-5-32-544:F');
    Run('icacls.exe', '"' + ExpandConstant('{commonappdata}\Den') + '" /inheritance:r /grant:r *S-1-5-18:(OI)(CI)F *S-1-5-32-544:(OI)(CI)F');
    if AdminPage.Values[0] <> '' then
    begin
      Code := Run(Exe, 'admin add "' + AdminPage.Values[0] + '" "' + AdminPage.Values[1] + '" admin');
      if (Code <> 0) and not WizardSilent then
        MsgBox('Администратора добавить не удалось (код ' + IntToStr(Code) + '). Добавьте позже: den-server.exe admin add <email> <пароль> admin', mbError, MB_OK);
    end;
  end;
  PowerShell('-File "' + App + '\task.ps1" -Action install -Exe "' + Exe + '"');
end;
