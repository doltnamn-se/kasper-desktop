const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("kasperDesktop", {
  setTheme: (theme) => ipcRenderer.send("kasper:set-theme", theme)
});
