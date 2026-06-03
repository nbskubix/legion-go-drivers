const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  platform: process.platform,
  fetchDrivers: () => ipcRenderer.invoke('fetch-drivers'),
  fetchDriverVersions: (docId) => ipcRenderer.invoke('fetch-driver-versions', docId),
  chooseDownloadDir: () => ipcRenderer.invoke('choose-download-dir'),
  downloadDriver: (args) => ipcRenderer.invoke('download-driver', args),
  installDriver: (args) => ipcRenderer.invoke('install-driver', args),
  openFolder: (folderPath) => ipcRenderer.invoke('open-folder', folderPath),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (data) => ipcRenderer.invoke('save-settings', data),
  checkDownloads: (args) => ipcRenderer.invoke('check-downloads', args),
  deleteDownload: (filePath) => ipcRenderer.invoke('delete-download', filePath),
  checkOutdated: (args) => ipcRenderer.invoke('check-outdated', args),
  onDownloadProgress: (callback) => {
    ipcRenderer.on('download-progress', (_event, data) => callback(data));
  },
  removeDownloadProgressListener: () => {
    ipcRenderer.removeAllListeners('download-progress');
  },
});
