const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("api", {
  getInitialFile: () => ipcRenderer.invoke("get-initial-file"),
  readFile: (path) => ipcRenderer.invoke("read-file", path),
  openDialog: () => ipcRenderer.invoke("open-dialog"),
  saveDialog: (defaultPath) => ipcRenderer.invoke("save-dialog", defaultPath),
  writeFile: (path, data) => ipcRenderer.invoke("write-file", path, data),
  confirm: (message, detail, okLabel) => ipcRenderer.invoke("confirm", message, detail, okLabel),
  setDirty: (dirty) => ipcRenderer.send("set-dirty", dirty),
  setTitle: (title) => ipcRenderer.send("set-title", title),
  // Percorso reale di un file trascinato nella finestra.
  pathForFile: (file) => webUtils.getPathForFile(file),
  loadProfiles: () => ipcRenderer.invoke("profiles-load"),
  saveProfiles: (json) => ipcRenderer.invoke("profiles-save", json),
  jevStatus: () => ipcRenderer.invoke("jev-status"),
  getJevSettings: () => ipcRenderer.invoke("jev-settings-get"),
  saveJevSettings: (form) => ipcRenderer.invoke("jev-settings-save", form),
  testJev: (form) => ipcRenderer.invoke("jev-test", form),
  jevDecide: (request) => ipcRenderer.invoke("jev-decide", request),
});
