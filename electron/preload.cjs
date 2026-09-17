const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('aepa', Object.freeze({
  bootstrap: () => ipcRenderer.invoke('bootstrap'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
  saveSigner: (plaintext, replace = false) => ipcRenderer.invoke('signer:store', plaintext, replace),
  removeSigner: () => ipcRenderer.invoke('signer:remove'),
  listFleets: () => ipcRenderer.invoke('fleets:list'),
  getFleetSnapshot: () => ipcRenderer.invoke('fleets:snapshot'),
  connect: () => ipcRenderer.invoke('c4:connect'),
  loadAutomationCatalog: () => ipcRenderer.invoke('automation:catalog'),
  getAutomationState: () => ipcRenderer.invoke('automation:state'),
  saveAutomationAssignment: (value) => ipcRenderer.invoke('automation:save', value),
  setAutomationEnabled: (enabled) => ipcRenderer.invoke('automation:set-enabled', enabled),
  clearAutomationPause: () => ipcRenderer.invoke('automation:clear-pause'),
  simulateNextCopperStep: () => ipcRenderer.invoke('automation:simulate-next'),
  clearGameCache: () => ipcRenderer.invoke('game:clear-cache'),
}));
