const { app, BrowserWindow, shell, nativeTheme, Tray, Menu, ipcMain, Notification } = require("electron");
const path = require("path");
const { autoUpdater } = require("electron-updater");
const log = require("electron-log");
const Store = require("electron-store");

const APP_NAME = "Kasper";
const APP_ORIGIN = "https://app.joinkasper.com";

const TITLEBAR_HEIGHT_WIN = 42;
const WIN_CONTROLS_SAFE_RIGHT = 140;
const TITLEBAR_HEIGHT_MAC = 28;

let mainWindow;
let tray = null;
let authWindow = null;
let isUserLoggedIn = false;

const store = new Store({
  defaults: {
    windowBounds: { width: 1200, height: 800 },
    minimizeToTray: true,
    openAtLogin: true,
  },
});

log.transports.file.level = "info";
autoUpdater.logger = log;

// Safe helper — always shows a window, recreates if destroyed
function showOrCreateWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  } else {
    createWindow();
  }
}

// Locale helper for tray labels
function isSvLocale() {
  try {
    return app.getLocale().startsWith("sv");
  } catch {
    return false;
  }
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
else {
  app.on("second-instance", (_event, argv) => {
    showOrCreateWindow();

    const deepLink = argv.find((arg) => arg.startsWith("kasper://"));
    if (deepLink) handleDeepLink(deepLink);
  });
}

function handleDeepLink(url) {
  showOrCreateWindow();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("kasper:deep-link", url);
  }
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
      contextIsolation: true,
    },
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

  const css = `
    :root { --kasper-titlebar-h: ${overlayHeight}px; --kasper-titlebar-right-safe: ${rightSafe}px; }
    body { padding-top: var(--kasper-titlebar-h) !important; }
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
  const savedBounds = store.get("windowBounds");

  const win = new BrowserWindow({
    width: savedBounds.width || 1200,
    height: savedBounds.height || 800,
    x: savedBounds.x,
    y: savedBounds.y,
    title: APP_NAME,
    icon: windowIcon,
    backgroundColor: overlay.color,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      nodeIntegration: false,
      contextIsolation: true,
    },

    ...(isWindows
      ? {
          titleBarStyle: "hidden",
          titleBarOverlay: { color: overlay.color, symbolColor: overlay.symbolColor, height: TITLEBAR_HEIGHT_WIN },
        }
      : {}),

    ...(isMac ? { titleBarStyle: "hiddenInset" } : {}),
  });

  mainWindow = win;

  win.loadURL(APP_ORIGIN);
  win.setMenuBarVisibility(false);

  win.webContents.on("page-title-updated", (e) => {
    e.preventDefault();
    win.setTitle(APP_NAME);
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isOAuthUrl(url) || isSupabaseReturn(url)) {
      openAuthWindow(url);
      return { action: "deny" };
    }
    if (isAppUrl(url)) return { action: "allow" };
    shell.openExternal(url);
    return { action: "deny" };
  });

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

  const saveBounds = () => {
    if (!win.isMaximized() && !win.isMinimized()) {
      store.set("windowBounds", win.getBounds());
    }
  };
  win.on("resize", saveBounds);
  win.on("move", saveBounds);

  win.on("close", (e) => {
    if (app.isQuiting) return;
    if (store.get("minimizeToTray")) {
      e.preventDefault();
      win.hide();
    }
  });

  nativeTheme.on("updated", () => {
    if (isWindows && mainWindow && !mainWindow.isDestroyed()) {
      const o = getOverlayColors();
      mainWindow.setTitleBarOverlay({ color: o.color, symbolColor: o.symbolColor, height: TITLEBAR_HEIGHT_WIN });
      mainWindow.setBackgroundColor(o.color);
    }
  });

  return win;
}

// ---------- Dynamic tray menu ----------
function rebuildTray() {
  if (!tray) return;

  const sv = isSvLocale();

  const menuItems = [
    {
      label: sv ? "Öppna Kasper" : "Open Kasper",
      click: () => showOrCreateWindow(),
    },
  ];

  menuItems.push({ type: "separator" });
  menuItems.push({
    label: sv ? "Avsluta" : "Quit",
    click: () => {
      app.isQuiting = true;
      app.quit();
    },
  });

  const contextMenu = Menu.buildFromTemplate(menuItems);
  tray.setContextMenu(contextMenu);
}

function setupTray() {
  const iconPath =
    process.platform === "win32"
      ? path.join(__dirname, "assets", "tray.ico")
      : path.join(__dirname, "assets", "trayTemplate.png");

  tray = new Tray(iconPath);
  tray.setToolTip(APP_NAME);
  tray.on("click", () => showOrCreateWindow());

  // Build initial menu (user not logged in yet)
  rebuildTray();
}

function setupAutoLaunch() {
  const openAtLogin = store.get("openAtLogin", true);
  app.setLoginItemSettings({ openAtLogin });
}

function setupAutoUpdates() {
  autoUpdater.checkForUpdatesAndNotify().catch((e) => log.warn("Update check failed:", e));
  setInterval(() => {
    autoUpdater.checkForUpdatesAndNotify().catch((e) => log.warn("Update check failed:", e));
  }, 6 * 60 * 60 * 1000);
}

if (process.defaultApp) {
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient("kasper", process.execPath, [path.resolve(process.argv[1])]);
  }
} else {
  app.setAsDefaultProtocolClient("kasper");
}

app.setName(APP_NAME);

app.setAppUserModelId('com.kasper.desktop');

app.whenReady().then(() => {
  createWindow();
  setupTray();
  setupAutoLaunch();
  setupAutoUpdates();

  autoUpdater.checkForUpdatesAndNotify()

  ipcMain.on("kasper:set-theme", (_evt, theme) => applyOverlayTheme(theme));

  ipcMain.on("kasper:minimize", () => mainWindow?.minimize());
  ipcMain.on("kasper:maximize", () => {
    if (mainWindow?.isMaximized()) mainWindow.unmaximize();
    else mainWindow?.maximize();
  });
  ipcMain.on("kasper:close", () => mainWindow?.close());

  // Auth state from web app → rebuild tray conditionally
  ipcMain.on("kasper:auth-state", (_evt, loggedIn) => {
    isUserLoggedIn = !!loggedIn;
    rebuildTray();
  });

  ipcMain.on('set-title-bar-overlay', (_event, options) => {
  const win = BrowserWindow.getFocusedWindow();
  if (win && process.platform === 'win32') {
    win.setTitleBarOverlay(options);
  }
  });

  ipcMain.on("kasper:show-notification", (_evt, opts) => {
  if (!Notification.isSupported()) return;
  const notif = new Notification({
    title: opts.title || APP_NAME,
    body: opts.body || "",
    icon: path.join(__dirname, "assets", "icon.png"),
    urgency: "critical",
    silent: false,
  });
  notif.on("click", () => {
    showOrCreateWindow();
    if (opts.route && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("kasper:deep-link", `kasper://open${opts.route}`);
    }
  });
  notif.show();
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isFocused()) {
  mainWindow.flashFrame(true);
  }
});


ipcMain.on("kasper:set-badge", (_evt, count) => {
  if (process.platform === "darwin") {
    app.dock.setBadge(count > 0 ? String(count) : "");
  }

  if (process.platform === "win32" && mainWindow && !mainWindow.isDestroyed()) {
    if (count > 0) {
      const size = 16;
      const buffer = Buffer.alloc(size * size * 4, 0);

      const cx = 12, cy = 4, r = 3;
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const dx = x - cx, dy = y - cy;
          if (dx * dx + dy * dy <= r * r) {
            const i = (y * size + x) * 4;
            buffer[i] = 255;
            buffer[i + 1] = 0;
            buffer[i + 2] = 0;
            buffer[i + 3] = 255;
          }
        }
      }

      const { nativeImage } = require("electron");
      const badge = nativeImage.createFromBuffer(buffer, { width: size, height: size });
      mainWindow.setOverlayIcon(badge, `${count} unread`);
    } else {
      mainWindow.setOverlayIcon(null, "");
    }
  }

  if (tray) {
    tray.setToolTip(count > 0 ? `${APP_NAME} (${count} unread)` : APP_NAME);
  }
});



  ipcMain.on("kasper:set-preference", (_evt, key, value) => {
    log.info(`Preference set: ${key} = ${value}`);
    if (key === "openAtLogin" || key === "autoLaunch") {
      store.set("openAtLogin", value);
      app.setLoginItemSettings({ openAtLogin: !!value });
    } else if (key === "minimizeToTray") {
      store.set("minimizeToTray", value);
    }
  });

  ipcMain.handle("kasper:get-preference", (_evt, key) => {
    if (key === "autoLaunch" || key === "openAtLogin") {
      return app.getLoginItemSettings().openAtLogin;
    }
    if (key === "minimizeToTray") {
      return store.get("minimizeToTray", true);
    }
    return null;
  });

  app.on("open-url", (event, url) => {
    event.preventDefault();
    handleDeepLink(url);
  });

  const deepLinkArg = process.argv.find((arg) => arg.startsWith("kasper://"));
  if (deepLinkArg) handleDeepLink(deepLinkArg);

  app.on("activate", () => {
    showOrCreateWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform === "darwin") return;
  if (store.get("minimizeToTray")) return;
  app.isQuiting = true;
  app.quit();
});

app.on("before-quit", () => {
  app.isQuiting = true;
});
