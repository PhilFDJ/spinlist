'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('spinlist', {
  pickFolder: () => ipcRenderer.invoke('pick-folder'),
  scanFolder: (folder, prev) => ipcRenderer.invoke('scan-folder', { folder, prev }),
  login: (email, password) => ipcRenderer.invoke('login', { email, password }),
  getLibrary: () => ipcRenderer.invoke('get-library'),
  saveLibrary: (name, lib) => ipcRenderer.invoke('save-library', { name, lib }),
  onScanProgress: (cb) => ipcRenderer.on('scan-progress', (_e, data) => cb(data)),
  onScanTiming: (cb) => ipcRenderer.on('scan-timing', (_e, data) => cb(data)),
  timingNow: () => ipcRenderer.invoke('timing-now'),
  speedTest: (folder) => ipcRenderer.invoke('speed-test', folder),
  appVersion: () => ipcRenderer.invoke('app-version'),
});
