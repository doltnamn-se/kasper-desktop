const { app, BrowserWindow, shell, nativeTheme, Tray, Menu, ipcMain } = require("electron");
const path = require("path");

// Auto updates
const { autoUpdater } = require("electron-updater");
const log = require("electron-log");

const APP_NAME = "Kasper";
const APP_URL = "https://app.joinkasper.com";

// Titlebar overlay heights / safe zones
const TITLEBAR_HEIGHT_WIN = 42;
const WIN_CONTROLS_SAFE_RIGHT = 140; // space reserved for Windows window buttons
const TITLEBAR_HEIGHT_MAC = 28; // padding only; mac titlebar is handled by titleBarStyle

let mainWindow;
let tray = null;

log.transports.file.level = "info";
autoUpdater.logger = log;

// Single instance lock
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

function getOverlayColorsFromSystem() {
  const isDark = nativeTheme.shouldUseDarkColors;
  return isDark
    ? { color: "#1a1a1a", symbolColor: "#FFFFFF" }
    : { color: "#fafafa", symbolColor: "#111111" };
}

function applyOverlayTheme(theme) {
  if (process.platform !== "win32" || !mainWindow || mainWindow.isDestroyed()) return;

  const isDark = theme === "dark";
  const color = isDark ? "#1a1a1a" : "#fafafa";
  const symbolColor = isDark ? "#FFFFFF" : "#111111";

  mainWindow.setTitleBarOverlay({ color, symbolColor, height: TITLEBAR_HEIGHT_WIN });
  mainWindow.setBackgroundColor(color);
}

/**
 * Inject CSS + drag layer + theme watcher + "pin header" patch
 */
async function injectDesktopPolish(win) {
  const isWindows = process.platform === "win32";
  const overlayHeight = isWindows ? TITLEBAR_HEIGHT_WIN : TITLEBAR_HEIGHT_MAC;
  const rightSafe = isWindows ? WIN_CONTROLS_SAFE_RIGHT : 0;

  const css = `
    :root {
      --kasper-titlebar-h: ${overlayHeight}px;
      --kasper-titlebar-right-safe: ${rightSafe}px;
      --kasper-pinned-header-h: 0px; /* will be set dynamically */
    }

    html, body { height: 100%; }

    /* Reserve space at the top for the overlay titlebar */
    body { padding-top: var(--kasper-titlebar-h) !important; }

    body.kasper-desktop-app { -webkit-font-smoothing: antialiased; }

    /* Full-width overlay layer (does NOT block clicks by default) */
    #kasper-drag-layer {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      height: var(--kasper-titlebar-h);
      z-index: 2147483647;
      background: transparent;
      pointer-events: none;
    }

    /* Draggable region (everything except the right-side window buttons area) */
    #kasper-drag-region {
      position: absolute;
      top: 0;
      left: 0;
      right: var(--kasper-titlebar-right-safe);
      height: 100%;
      -webkit-app-region: drag;
      pointer-events: auto;
    }

    /* No-drag zone on the right where native window buttons live */
    #kasper-no-drag {
      position: absolute;
      top: 0;
      right: 0;
      width: var(--kasper-titlebar-right-safe);
      height: 100%;
      -webkit-app-region: no-drag;
      pointer-events: none;
    }

    /* Nicer scrollbars (Chromium) */
    ::-webkit-scrollbar { width: 10px; height: 10px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb {
      background: rgba(120, 120, 120, 0.35);
      border-radius: 999px;
      border: 3px solid transparent;
      background-clip: padding-box;
    }
    ::-webkit-scrollbar-thumb:hover {
      background: rgba(120, 120, 120, 0.55);
      border: 3px solid transparent;
      background-clip: padding-box;
    }
  `;

  try {
    await win.webContents.insertCSS(css);

    // Drag layer + class
    await win.webContents.executeJavaScript(`
      (function () {
        document.body.classList.add('kasper-desktop-app');

        if (!document.getElementById('kasper-drag-layer')) {
          const layer = document.createElement('div');
          layer.id = 'kasper-drag-layer';

          const drag = document.createElement('div');
          drag.id = 'kasper-drag-region';

          const nodrag = document.createElement('div');
          nodrag.id = 'kasper-no-drag';

          layer.appendChild(drag);
          layer.appendChild(nodrag);
          document.body.appendChild(layer);
        }
      })();
    `);

    /**
     * Theme watcher: detects theme changes inside your app and notifies Electron
     */
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
            ? 'dark'
            : 'light';
        }

        let last = null;

        function tick() {
          const t = detectTheme();
          if (t !== last) {
            last = t;
            if (window.kasperDesktop && window.kasperDesktop.setTheme) {
              window.kasperDesktop.setTheme(t);
            }
          }
        }

        tick();

        const obs = new MutationObserver(tick);
        obs.observe(document.documentElement, { attributes: true, attributeFilter: ['class','data-theme'] });
        obs.observe(document.body, { attributes: true, attributeFilter: ['class','data-theme'] });

        setInterval(tick, 500);
      })();
    `);

    /**
     * Pin the app header (search + icons) so it doesn't scroll away.
     * We detect it by searching for the search input ("Sök...") and pinning its closest container.
     */
    await win.webContents.executeJavaScript(`
      (function () {
        function findHeaderEl() {
          // Primary: the search input in your header
          const search =
            document.querySelector('input[placeholder="Sök..."]') ||
            document.querySelector('input[placeholder^="Sök"]');

          if (search) {
            // Walk up to find a reasonable "header row" container near top
            let el = search;
            for (let i = 0; i < 8; i++) {
              if (!el || !el.parentElement) break;
              el = el.parentElement;

              const r = el.getBoundingClientRect();
              // Something near the top and spanning most of content width
              if (r.top >= 0 && r.top < 220 && r.height > 40 && r.height < 140 && r.width > 400) {
                return el;
              }
            }
          }

          // Fallbacks
          return document.querySelector('header') || null;
        }

        function pinHeader() {
          const header = findHeaderEl();
          if (!header) return;

          // Avoid re-applying
          if (header.dataset.kasperPinned === "1") return;

          header.dataset.kasperPinned = "1";

          // Compute where the content area starts (so we don't cover left sidebar)
          const rect = header.getBoundingClientRect();
          const left = rect.left;
          const width = rect.width;
          const height = rect.height;

          document.documentElement.style.setProperty('--kasper-pinned-header-h', height + 'px');

          // Create a spacer so content below doesn't jump under the pinned header
          const spacer = document.createElement('div');
          spacer.id = 'kasper-header-spacer';
          spacer.style.height = height + 'px';
          spacer.style.width = '1px';
          spacer.style.pointerEvents = 'none';

          // Put spacer right after header in DOM flow (best-effort)
          header.parentElement && header.parentElement.insertBefore(spacer, header.nextSibling);

          // Pin it
          header.style.position = 'fixed';
          header.style.top = 'var(--kasper-titlebar-h)';
          header.style.left = left + 'px';
          header.style.width = width + 'px';
          header.style.zIndex = '2147483646';
          header.style.margin = '0';
          header.style.transform = 'none';

          // Make sure header stays interactive
          header.style.pointerEvents = 'auto';

          // Update on resize
          const update = () => {
            const r = header.getBoundingClientRect();
            // Because it's fixed now, we need to recompute left/width from the layout container.
            // We'll instead measure the spacer's previous sibling layout by temporarily clearing left/width.
            header.style.left = '';
            header.style.width = '';
            const rr = header.getBoundingClientRect();
            header.style.left = rr.left + 'px';
            header.style.width = rr.width + 'px';
          };

          window.addEventListener('resize', () => {
            try { update(); } catch (e) {}
          }, { passive: true });
        }

        // Try now, and retry a few times (SPA apps mount late)
        let tries = 0;
        const t = setInterval(() => {
          tries++;
          pinHeader();
          if (tries > 20) clearInterval(t);
        }, 250);
      })();
    `);
  } catch (e) {
    log.warn("Failed to inject desktop polish:", e);
  }
}

function createWindow() {
  const isWindows = process.platform === "win32";
  const isMac = process.platform === "darwin";

  const windowIcon =
    isWindows
      ? path.join(__dirname, "assets", "icon.ico")
      : path.join(__dirname, "assets", "icon.png");

  const overlay = getOverlayColorsFromSystem();

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
          titleBarOverlay: {
            color: overlay.color,
            symbolColor: overlay.symbolColor,
            height: TITLEBAR_HEIGHT_WIN
          }
        }
      : {}),

    ...(isMac
      ? { titleBarStyle: "hiddenInset" }
      : {})
  });

  mainWindow = win;

  win.loadURL(APP_URL);
  win.setMenuBarVisibility(false);

  // Force desktop title
  win.webContents.on("page-title-updated", (e) => {
    e.preventDefault();
    win.setTitle(APP_NAME);
  });

  // External links open in browser
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(APP_URL)) return { action: "allow" };
    shell.openExternal(url);
    return { action: "deny" };
  });

  win.webContents.on("will-navigate", (e, url) => {
    if (url.startsWith(APP_URL)) return;
    e.preventDefault();
    shell.openExternal(url);
  });

  // Inject polish after load
  win.webContents.on("did-finish-load", () => injectDesktopPolish(win));

  win.once("ready-to-show", () => win.show());

  // Minimize to tray on close
  win.on("close", (e) => {
    if (tray && !app.isQuiting) {
      e.preventDefault();
      win.hide();
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

  const contextMenu = Menu.buildFromTemplate([
    {
      label: "Open Kasper",
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }
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
  ]);

  tray.setToolTip(APP_NAME);
  tray.setContextMenu(contextMenu);

  tray.on("double-click", () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
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

  ipcMain.on("kasper:set-theme", (_evt, theme) => {
    applyOverlayTheme(theme);
  });

  setupTray();
  setupAutoLaunch();
  setupAutoUpdates();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else if (mainWindow) mainWindow.show();
  });
});

app.on("window-all-closed", () => {
  if (process.platform === "darwin") return;
  if (!tray) app.quit();
});

app.on("before-quit", () => {
  app.isQuiting = true;
});
