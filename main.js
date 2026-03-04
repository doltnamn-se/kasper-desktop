const { app, BrowserWindow, shell, nativeTheme, Tray, Menu, ipcMain } = require("electron");
const path = require("path");

const { autoUpdater } = require("electron-updater");
const log = require("electron-log");

const APP_NAME = "Kasper";
const APP_ORIGIN = "https://app.joinkasper.com";

const TITLEBAR_HEIGHT_WIN = 42;
const WIN_CONTROLS_SAFE_RIGHT = 140;
const TITLEBAR_HEIGHT_MAC = 28;

let mainWindow;
let tray = null;
let authWindow = null;

log.transports.file.level = "info";
autoUpdater.logger = log;

// single instance
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

function getOverlayColors() {
  const isDark = nativeTheme.shouldUseDarkColors;
  return isDark
    ? { color: "#161618", symbolColor: "#FFFFFF" }
    : { color: "#fafafa", symbolColor: "#111111" };
}

function applyOverlayTheme(theme) {
  if (process.platform !== "win32" || !mainWindow || mainWindow.isDestroyed()) return;

  const isDark = theme === "dark";
  const color = isDark ? "#161618" : "#fafafa";
  const symbolColor = isDark ? "#FFFFFF" : "#111111";

  mainWindow.setTitleBarOverlay({ color, symbolColor, height: TITLEBAR_HEIGHT_WIN });
  mainWindow.setBackgroundColor(color);
}

function isAppUrl(url) {
  return typeof url === "string" && url.startsWith(APP_ORIGIN);
}

function isSupabaseReturn(url) {
  try {
    const u = new URL(url);
    return u.origin === APP_ORIGIN && (u.hash || "").includes("access_token=");
  } catch {
    return false;
  }
}

function isOAuthUrl(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();

    // Google + Supabase auth related
    if (host === "accounts.google.com") return true;
    if (host.endsWith(".supabase.co")) return true;
    if (host === "oauth2.googleapis.com") return true;
    if (host.endsWith(".googleusercontent.com")) return true;
    if (host.endsWith(".gstatic.com")) return true;

    return false;
  } catch {
    return false;
  }
}

function openAuthWindow(startUrl) {
  if (authWindow && !authWindow.isDestroyed()) {
    authWindow.show();
    authWindow.focus();
    authWindow.loadURL(startUrl);
    return;
  }

  authWindow = new BrowserWindow({
    width: 520,
    height: 720,
    title: `${APP_NAME} – Sign in`,
    parent: mainWindow || undefined,
    modal: false,
    show: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  authWindow.setMenuBarVisibility(false);
  authWindow.loadURL(startUrl);

  const maybeFinish = (url) => {
    if (isSupabaseReturn(url)) {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.loadURL(url);
        mainWindow.show();
        mainWindow.focus();
      }
      if (authWindow && !authWindow.isDestroyed()) authWindow.close();
      authWindow = null;
    }
  };

  authWindow.webContents.on("will-redirect", (_e, url) => maybeFinish(url));
  authWindow.webContents.on("did-navigate", (_e, url) => maybeFinish(url));
  authWindow.webContents.on("did-navigate-in-page", (_e, url) => maybeFinish(url));

  authWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isOAuthUrl(url) || isAppUrl(url)) return { action: "allow" };
    shell.openExternal(url);
    return { action: "deny" };
  });

  authWindow.on("closed", () => {
    authWindow = null;
  });
}

async function injectDesktopUI(win) {
  const isWindows = process.platform === "win32";
  const overlayHeight = isWindows ? TITLEBAR_HEIGHT_WIN : TITLEBAR_HEIGHT_MAC;
  const rightSafe = isWindows ? WIN_CONTROLS_SAFE_RIGHT : 0;

  // Minimal + safe CSS, no heavy scanning
  const css = `
    :root { --kasper-titlebar-h: ${overlayHeight}px; --kasper-titlebar-right-safe: ${rightSafe}px; }

    /* Give the app content room under the overlay */
    body { padding-top: var(--kasper-titlebar-h) !important; }

    /* Draggable strip (transparent, doesn't steal clicks) */
    #kasper-drag-strip {
      position: fixed;
      top: 0; left: 0;
      right: var(--kasper-titlebar-right-safe);
      height: var(--kasper-titlebar-h);
      -webkit-app-region: drag;
      background: transparent;
      z-index: 2147483647;
      pointer-events: none;
    }

    /* Make common topbars stick below overlay (cheap selectors only) */
    header, [role="banner"], .topbar, .navbar {
      position: sticky !important;
      top: var(--kasper-titlebar-h) !important;
      z-index: 2147483000 !important;
    }
  `;

  try {
    await win.webContents.insertCSS(css);
    await win.webContents.executeJavaScript(`
      (function () {
        if (!document.getElementById('kasper-drag-strip')) {
          const d = document.createElement('div');
          d.id = 'kasper-drag-strip';
          document.body.appendChild(d);
        }
      })();
    `);
  } catch (e) {
    log.warn("injectDesktopUI failed:", e);
  }
}

async function injectThemeWatcher(win) {
  try {
    await win.webContents.executeJavaScript(`
      (function () {
        function detectTheme() {
          const html = document.documentElement;
          const body = document.body;

          const attr = html.getAttribute('data-theme') || body.getAttribute('data-theme');
          if (attr === 'dark' || attr === 'light') return attr;

          if (html.classList.contains('dark') || body.classList.contains('dark')) return 'dark';
          if (html.classList.contains('light') || body.classList.contains('light')) return 'light';

          const ls =
            localStorage.getItem('theme') ||
            localStorage.getItem('kasper-theme') ||
            localStorage.getItem('color-theme');

          if (ls === 'dark' || ls === 'light') return ls;

          return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches
            ? 'dark' : 'light';
        }

        let last = null;
        function tick() {
          const t = detectTheme();
          if (t !== last) {
            last = t;
            window.kasperDesktop?.setTheme?.(t);
          }
        }

        tick();
        setInterval(tick, 500);
      })();
    `);
  } catch (e) {
    log.warn("injectThemeWatcher failed:", e);
  }
}

function createWindow() {
  const isWindows = process.platform === "win32";
  const isMac = process.platform === "darwin";

  const windowIcon =
    isWindows ? path.join(__dirname, "assets", "icon.ico") : path.join(__dirname, "assets", "icon.png");

  const overlay = getOverlayColors();

  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    title: APP_NAME,
    icon: windowIcon,
    backgroundColor: overlay.color,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      nodeIntegration: false,
      contextIsolation: true
    },

    ...(isWindows
      ? {
          titleBarStyle: "hidden",
          titleBarOverlay: { color: overlay.color, symbolColor: overlay.symbolColor, height: TITLEBAR_HEIGHT_WIN }
        }
      : {}),

    ...(isMac ? { titleBarStyle: "hiddenInset" } : {})
  });

  mainWindow = win;

  win.loadURL(APP_ORIGIN);
  win.setMenuBarVisibility(false);

  win.webContents.on("page-title-updated", (e) => {
    e.preventDefault();
    win.setTitle(APP_NAME);
  });

  // popups / window.open
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isOAuthUrl(url) || isSupabaseReturn(url)) {
      openAuthWindow(url);
      return { action: "deny" };
    }
    if (isAppUrl(url)) return { action: "allow" };
    shell.openExternal(url);
    return { action: "deny" };
  });

  // navigations
  win.webContents.on("will-navigate", (e, url) => {
    if (isAppUrl(url)) return;

    if (isOAuthUrl(url)) {
      e.preventDefault();
      openAuthWindow(url);
      return;
    }

    e.preventDefault();
    shell.openExternal(url);
  });

  // redirects (important for oauth)
  win.webContents.on("will-redirect", (e, url) => {
    if (isAppUrl(url)) return;

    if (isOAuthUrl(url)) {
      e.preventDefault();
      openAuthWindow(url);
    }
  });

  win.webContents.on("did-finish-load", async () => {
    await injectDesktopUI(win);
    await injectThemeWatcher(win);
  });

  win.once("ready-to-show", () => win.show());

  nativeTheme.on("updated", () => {
    if (isWindows && mainWindow && !mainWindow.isDestroyed()) {
      const o = getOverlayColors();
      mainWindow.setTitleBarOverlay({ color: o.color, symbolColor: o.symbolColor, height: TITLEBAR_HEIGHT_WIN });
      mainWindow.setBackgroundColor(o.color);
    }
  });

  return win;
}

function setupTray() {
  const iconPath =
    process.platform === "win32"
      ? path.join(__dirname, "assets", "tray.ico")
      : path.join(__dirname, "assets", "trayTemplate.png");

  tray = new Tray(iconPath);

  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: "Open Kasper",
        click: () => {
          mainWindow?.show();
          mainWindow?.focus();
        }
      },
      { type: "separator" },
      {
        label: "Quit",
        click: () => {
          app.isQuiting = true;
          app.quit();
        }
      }
    ])
  );

  tray.setToolTip(APP_NAME);
}

function setupAutoLaunch() {
  app.setLoginItemSettings({ openAtLogin: true });
}

function setupAutoUpdates() {
  autoUpdater.checkForUpdatesAndNotify().catch((e) => log.warn("Update check failed:", e));
  setInterval(() => {
    autoUpdater.checkForUpdatesAndNotify().catch((e) => log.warn("Update check failed:", e));
  }, 6 * 60 * 60 * 1000);
}

app.setName(APP_NAME);

app.whenReady().then(() => {
  createWindow();
  setupTray();
  setupAutoLaunch();
  setupAutoUpdates();

  ipcMain.on("kasper:set-theme", (_evt, theme) => applyOverlayTheme(theme));

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else mainWindow?.show();
  });
});

app.on("window-all-closed", () => {
  if (process.platform === "darwin") return;
  if (!tray) app.quit();
});

app.on("before-quit", () => {
  app.isQuiting = true;
});
