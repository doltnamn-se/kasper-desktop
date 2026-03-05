const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("kasperDesktop", {
  // Theme sync
  setTheme: (theme) => ipcRenderer.send("kasper:set-theme", theme),

  // Window controls
  minimize: () => ipcRenderer.send("kasper:minimize"),
  maximize: () => ipcRenderer.send("kasper:maximize"),
  close: () => ipcRenderer.send("kasper:close"),

  // Preferences (launch on startup, minimize to tray, etc.)
  setPreference: (key, value) => ipcRenderer.send("kasper:set-preference", key, value),

  // Deep link handling
  onDeepLink: (callback) => ipcRenderer.on("kasper:deep-link", (_event, url) => callback(url)),
  offDeepLink: (callback) => ipcRenderer.removeListener("kasper:deep-link", (_event, url) => callback(url)),

  // Auth state → Electron (for conditional tray menu)
  sendAuthState: (isLoggedIn) => ipcRenderer.send("kasper:auth-state", isLoggedIn),

  // Notifications & badge
  setBadgeCount: (count) => ipcRenderer.send("kasper:set-badge", count),
  showNotification: (opts) => ipcRenderer.send("kasper:show-notification", opts),
});
