const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('iris', {
  invoke: (method, ...args) => ipcRenderer.invoke('iris:invoke', method, ...args),
  // Absolute path of a dropped or picked file ('' for pasted data).
  pathForFile: file => { try { return webUtils.getPathForFile(file) || ''; } catch { return ''; } },
  subscribe(listener) {
    const handler = (_event, message) => listener(message);
    ipcRenderer.on('iris:event', handler);
    return () => ipcRenderer.removeListener('iris:event', handler);
  },
});
