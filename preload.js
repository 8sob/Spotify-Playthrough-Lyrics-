'use strict'

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('overlay', {
  onState(fn) {
    const h = (_e, s) => fn(s)
    ipcRenderer.on('overlay-state', h)
    return () => ipcRenderer.removeListener('overlay-state', h)
  },
  getTheme() {
    return ipcRenderer.invoke('overlay-theme')
  },
  enterFS() {
    return ipcRenderer.invoke('overlay-fs', 'enter')
  },
  exitFS() {
    return ipcRenderer.invoke('overlay-fs', 'exit')
  },
  onMode(fn) {
    const h = (_e, on) => fn(on)
    ipcRenderer.on('overlay-mode', h)
    return () => ipcRenderer.removeListener('overlay-mode', h)
  },
  getMode() {
    return ipcRenderer.invoke('overlay-mode-get')
  },
  cmd(action, value) {
    return ipcRenderer.invoke('overlay-cmd', action, value)
  }
})
