import { contextBridge } from "electron";

contextBridge.exposeInMainWorld("mailsense", {
  version: "0.1.0",
  platform: process.platform
});
