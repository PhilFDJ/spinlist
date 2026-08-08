'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('spinlist', {
  login: (email, password, remember) => ipcRenderer.invoke('login', { email, password, remember }),
  restoreSession: () => ipcRenderer.invoke('restore-session'),
  logout: () => ipcRenderer.invoke('logout'),
  listGigs: () => ipcRenderer.invoke('list-gigs'),
  openGig: (kind, id, title) => ipcRenderer.invoke('open-gig', { kind, id, title }),
  setOnTop: (on) => ipcRenderer.invoke('set-on-top', on),

  // Serato watching + diagnostics
  seratoStatus: () => ipcRenderer.invoke('serato-status'),
  setSeratoFolder: (folder) => ipcRenderer.invoke('set-serato-folder', folder),
  refreshBanList: () => ipcRenderer.invoke('refresh-ban-list'),
  testTrack: (title, artist) => ipcRenderer.invoke('test-track', { title, artist }),
  onSeratoEvent: (fn) => ipcRenderer.on('serato-event', (_e, data) => fn(data)),
  onSeratoStatus: (fn) => ipcRenderer.on('serato-status', (_e, data) => fn(data)),
});
