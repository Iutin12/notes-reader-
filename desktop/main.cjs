/* eslint-disable @typescript-eslint/no-require-imports */
const { app, BrowserWindow, dialog } = require("electron");
const { spawn } = require("node:child_process");
const http = require("node:http");
const path = require("node:path");
const fs = require("node:fs");

const APP_URL = "http://127.0.0.1:3000";
const OMR_URL = "http://127.0.0.1:8000/health";
const PROJECT_DIR = path.resolve(__dirname, "..");
const SERVER_DIR = app.isPackaged
  ? path.join(process.resourcesPath, "server")
  : PROJECT_DIR;
const WEB_MODULES_DIR = app.isPackaged
  ? path.join(process.resourcesPath, "app.asar", "node_modules")
  : path.join(PROJECT_DIR, "node_modules");
const NATIVE_DIR = app.isPackaged
  ? path.join(process.resourcesPath, "native", `${process.platform}-${process.arch}`)
  : path.join(PROJECT_DIR, "desktop", "native", `${process.platform}-${process.arch}`);

let mainWindow;
const childProcesses = [];

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

function startChild(command, args, options) {
  const child = spawn(command, args, {
    windowsHide: true,
    stdio: "ignore",
    ...options,
  });
  childProcesses.push(child);
  child.once("error", () => {});
  return child;
}

function waitForUrl(url, label, attempt = 0) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, (response) => {
      response.resume();
      if (response.statusCode && response.statusCode < 500) resolve();
      else retry();
    });
    request.on("error", retry);
    request.setTimeout(2000, () => { request.destroy(); retry(); });
    function retry() {
      if (attempt >= 90) reject(new Error(`${label} не ответил за 3 минуты.`));
      else setTimeout(() => waitForUrl(url, label, attempt + 1).then(resolve, reject), 2000);
    }
  });
}

function nativePaths() {
  if (process.platform === "darwin") {
    return {
      omr: path.join(NATIVE_DIR, "notera-omr"),
      audiveris: path.join(NATIVE_DIR, "Audiveris.app", "Contents", "MacOS", "Audiveris"),
    };
  }
  if (process.platform === "win32") {
    return {
      omr: path.join(NATIVE_DIR, "notera-omr.exe"),
      audiveris: path.join(NATIVE_DIR, "Audiveris.exe"),
    };
  }
  return { omr: path.join(NATIVE_DIR, "notera-omr"), audiveris: path.join(NATIVE_DIR, "audiveris") };
}

function startWebServer() {
  const cli = path.join(WEB_MODULES_DIR, "vinext", "dist", "cli.js");
  if (!fs.existsSync(cli)) {
    throw new Error("В установщике не найдены файлы локального интерфейса.");
  }
  startChild(process.execPath, [cli, "start", "--port", "3000", "--hostname", "127.0.0.1"], {
    cwd: SERVER_DIR,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", HOST: "127.0.0.1", PORT: "3000" },
  });
}

function startOmrServer() {
  const { omr, audiveris } = nativePaths();
  if (!fs.existsSync(omr) || !fs.existsSync(audiveris)) {
    throw new Error("В установщике не найдены компоненты автономного распознавания Audiveris.");
  }
  const jobsDir = path.join(app.getPath("userData"), "omr-jobs");
  fs.mkdirSync(jobsDir, { recursive: true });
  startChild(omr, [], {
    cwd: path.dirname(omr),
    env: {
      ...process.env,
      AUDIVERIS_BIN: audiveris,
      OMR_DATA_DIR: jobsDir,
      OMR_NATIVE_PORTABLE: "1",
      JAVA_TOOL_OPTIONS: "-Djava.awt.headless=true -Xmx4g",
    },
  });
}

function stopLocalServices() {
  for (const child of childProcesses.splice(0)) {
    if (!child.killed) child.kill();
  }
}

async function startApplication() {
  startWebServer();
  startOmrServer();
  await Promise.all([
    waitForUrl(APP_URL, "Интерфейс Нотеры"),
    waitForUrl(OMR_URL, "Сервис распознавания"),
  ]);
  await mainWindow.loadURL(APP_URL);
}

app.whenReady().then(async () => {
  createWindow();
  try {
    await startApplication();
  } catch (error) {
    stopLocalServices();
    await dialog.showMessageBox(mainWindow, {
      type: "error",
      title: "Не удалось запустить Нотеру",
      message: error instanceof Error ? error.message : "Не удалось запустить локальный сервис.",
      detail: "Docker Desktop не требуется. Переустановите Нотеру, если ошибка повторяется.",
    });
  }
});

app.on("before-quit", stopLocalServices);
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
