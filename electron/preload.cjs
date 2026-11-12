const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('leadzyDesktop', {
  getLauncherState: () => ipcRenderer.invoke('launcher:get-state'),
  chooseProject: () => ipcRenderer.invoke('launcher:choose-project'),
  createProject: () => ipcRenderer.invoke('launcher:create-project'),
  openProject: (projectDir) => ipcRenderer.invoke('launcher:open-project', projectDir),
  installIntegration: () => ipcRenderer.invoke('launcher:install-integration'),
  copyText: (value) => ipcRenderer.invoke('launcher:copy-text', value),
  chooseDirectory: (options) => ipcRenderer.invoke('settings:choose-directory', options),
  revealExternalPath: (path) => ipcRenderer.invoke('settings:reveal-external-path', path),
  revealUserData: (kind) => ipcRenderer.invoke('settings:reveal-user-data', kind),
  showHome: () => ipcRenderer.invoke('launcher:show-home'),
  onOpenProjectRequest: (listener) => {
    const handler = () => listener();
    ipcRenderer.on('launcher:request-open-project', handler);
    return () => ipcRenderer.removeListener('launcher:request-open-project', handler);
  },
  onShowHomeRequest: (listener) => {
    const handler = () => listener();
    ipcRenderer.on('launcher:request-home', handler);
    return () => ipcRenderer.removeListener('launcher:request-home', handler);
  },
  // The main process asks before an update swaps the bundle. It always
  // replies with the save outcome, so a failed write cannot trigger a restart.
  onFlushSaveRequest: (listener) => {
    const handler = () => {
      Promise.resolve()
        .then(listener)
        .then(
          (saved) => ipcRenderer.send('desktop:flush-save-done', { ok: saved !== false }),
          () => ipcRenderer.send('desktop:flush-save-done', { ok: false }),
        );
    };
    ipcRenderer.on('desktop:flush-save', handler);
    return () => ipcRenderer.removeListener('desktop:flush-save', handler);
  },
});
