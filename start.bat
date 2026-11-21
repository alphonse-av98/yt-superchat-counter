@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
title YouTube Live 課金リアルタイム集計ツール

cd /d "%~dp0"

echo ==========================================================
echo  YouTube Live 課金リアルタイム集計ツール 起動中...
echo ==========================================================
echo.

REM 1. 同梱ポータブル版 Node.js を優先チェック（未導入PCでもそのまま動作）
set "NODE_EXE="
if exist "%~dp0runtime\node\node.exe" (
    set "NODE_EXE=%~dp0runtime\node\node.exe"
    set "PATH=%~dp0runtime\node;%PATH%"
) else (
    where node >nul 2>&1
    if !errorlevel! equ 0 (
        for /f "delims=" %%I in ('where node') do (
            if not defined NODE_EXE set "NODE_EXE=%%I"
        )
    )
)

if not defined NODE_EXE (
    echo [エラー] Node.js が見つかりませんでした。
    echo.
    echo 以下のいずれかの方法で起動してください：
    echo  1. GitHub Releases から「Windows向け配布ZIP（Node.js同梱版）」をダウンロードして使う（おすすめ）
    echo  2. Node.js 公式サイト（https://nodejs.org/）から LTS 版をインストールして再実行する
    echo.
    pause
    exit /b 1
)

REM 2. .env が未作成なら .env.example から自動コピー
if not exist ".env" (
    if exist ".env.example" (
        copy /y ".env.example" ".env" >nul
        echo [初期設定] .env ファイルを自動作成しました。
    )
)

REM 3. ソースコード版で初回起動の場合は依存インストール＆ビルドを自動実行
if not exist "node_modules" (
    echo [初回セットアップ] 必要なパッケージをインストールしています...
    call npm install
    if !errorlevel! neq 0 (
        echo [エラー] パッケージのインストールに失敗しました。
        pause
        exit /b 1
    )
)

if not exist "dist\server.js" (
    echo [初回セットアップ] アプリをビルドしています...
    call npm run build
    if !errorlevel! neq 0 (
        echo [エラー] ビルドに失敗しました。
        pause
        exit /b 1
    )
)

REM 4. .env から HOST / PORT を読み取り（未指定時は 127.0.0.1:3000）
set "APP_HOST=127.0.0.1"
set "APP_PORT=3000"
if exist ".env" (
    for /f "usebackq tokens=1,* delims==" %%A in (".env") do (
        if /i "%%A"=="HOST" if not "%%B"=="" set "APP_HOST=%%B"
        if /i "%%A"=="PORT" if not "%%B"=="" set "APP_PORT=%%B"
    )
)

echo 管理画面を自動でブラウザに開きます: http://!APP_HOST!:!APP_PORT!/
echo ※ このウィンドウを閉じると集計ツールが終了します。配信中は開いたままにしてください。
echo.

REM 5. 2秒後に既定ブラウザで管理ダッシュボードを自動オープン
start "" /b cmd /c "timeout /t 2 /nobreak >nul & start http://!APP_HOST!:!APP_PORT!/"

REM 6. サーバー起動
"%NODE_EXE%" "dist\server.js"
set "EXIT_CODE=%errorlevel%"

if not "%EXIT_CODE%"=="0" (
    echo.
    echo [エラー] サーバーが異常終了しました（終了コード: %EXIT_CODE%）。
    echo すでに同じポート（!APP_PORT!）で別ウィンドウが起動していないか確認してください。
    pause
)

exit /b %EXIT_CODE%
