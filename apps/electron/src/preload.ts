import { contextBridge, ipcRenderer } from "electron";

/**
 * Мост в renderer. Наружу отдаём минимум: настройку адреса сервера
 * (режим тонкого клиента) и признак того, что мы внутри Electron.
 */
contextBridge.exposeInMainWorld("mailsense", {
  isElectron: true,
  getServerConfig: () => ipcRenderer.invoke("server-config:get"),
  setServerUrl: (url: string) => ipcRenderer.invoke("server-config:set", url),
  clearServerUrl: () => ipcRenderer.invoke("server-config:clear"),
  relaunch: () => ipcRenderer.invoke("app:relaunch"),
  openFile: (name: string, base64: string) => ipcRenderer.invoke("shell:open-file", { name, base64 })
});
