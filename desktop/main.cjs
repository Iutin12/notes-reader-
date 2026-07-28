/* eslint-disable @typescript-eslint/no-require-imports */
const { app, BrowserWindow, dialog } = require("electron");
const { spawn, spawnSync } = require("node:child_process");
const http = require("node:http");
const path = require("node:path");
const fs = require("node:fs");

const APP_URL = "http://127.0.0.1:3100";
const SERVER_DIR = app.isPackaged
  ? path.join(process.resourcesPath, "server")
  : path.resolve(__dirname, "..");

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 980,
    minHeight: 680,
    backgroundColor: "#f6f5f0",
    title: "Нотера — тренажёр чтения нот",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.cjs"),
    },
  });
  mainWindow.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(`
    <main style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;display:grid;place-items:center;height:90vh;color:#1b2922;background:#f6f5f0">
      <section style="text-align:center"><h1>Запускаем Нотеру…</h1><p>Подготавливаем локальное распознавание нот.</p></section>
    </main>`));
}

function dockerAvailable() {
  const result = spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], {
    encoding: "utf8",
    timeout: 15000,
  });
  return result.status === 0;
}

function startServices() {
  return new Promise((resolve, reject) => {
    const compose = path.join(SERVER_DIR, "docker-compose.yml");
    if (!fs.existsSync(compose)) {
      reject(new Error("В установщике не найдены файлы локального сервиса."));
      return;
    }
    const child = spawn(
      "docker",
      ["compose", "-f", compose, "up", "-d", "--build"],
      { cwd: SERVER_DIR, stdio: "ignore", windowsHide: true },
    );
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Docker Compose завершился с кодом ${code}.`));
    });
  });
}

function waitForServer(attempt = 0) {
  return new Promise((resolve, reject) => {
    const request = http.get(APP_URL, (response) => {
      response.resume();
      if (response.statusCode && response.statusCode < 500) resolve();
      else retry();
    });
    request.on("error", retry);
    request.setTimeout(2000, () => { request.destroy(); retry(); });
    function retry() {
      if (attempt >= 90) reject(new Error("Локальный сервер не ответил за 3 минуты."));
      else setTimeout(() => waitForServer(attempt + 1).then(resolve, reject), 2000);
    }
  });
}

app.whenReady().then(async () => {
  createWindow();
  if (!dockerAvailable()) {
    await dialog.showMessageBox(mainWindow, {
      type: "error",
      title: "Нужен Docker Desktop",
      message: "Для распознавания PDF Нотере нужен установленный и запущенный Docker Desktop.",
      detail: "Установите Docker Desktop, запустите его и откройте Нотеру повторно. MusicXML и MIDI можно использовать после запуска Docker.",
    });
    return;
  }
  try {
    await startServices();
    await waitForServer();
    await mainWindow.loadURL(APP_URL);
  } catch (error) {
    await dialog.showMessageBox(mainWindow, {
      type: "error",
      title: "Не удалось запустить Нотеру",
      message: error instanceof Error ? error.message : "Не удалось запустить локальный сервис.",
      detail: "Проверьте, что Docker Desktop запущен, затем откройте приложение снова.",
    });
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
