// electron/preload.ts

import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';

export type ScrapeData = {
  headers: Record<string, string>;
  apiType: string;
  cookies: any;
  payload: any;
  totalResults: number;
  savePath: string;
};

export type ProgressUpdate = {
  progressPercentage: number;
};

contextBridge.exposeInMainWorld('electronAPI', {
  startScraping: (scrapeData: ScrapeData) =>
    ipcRenderer.send('start-scraping', scrapeData),
  pauseScraping: () => ipcRenderer.send('pause-scraping'),
  resumeScraping: () => ipcRenderer.send('resume-scraping'),
  stopScraping: () => ipcRenderer.send('stop-scraping'),
  updateCookies: (newCookies: any) =>
    ipcRenderer.send('update-cookies', newCookies),
  openFile: (filePath: string) => ipcRenderer.send('open-file', filePath),
  selectSavePath: () => ipcRenderer.invoke('select-save-path'),
  fileExists: (filePath: string) => ipcRenderer.invoke('file-exists', filePath),
  onProgressUpdate: (callback: (data: ProgressUpdate) => void) =>
    ipcRenderer.on('progress-update', (_event: IpcRendererEvent, data: ProgressUpdate) =>
      callback(data)
    ),
  onScrapingFinished: (callback: () => void) =>
    ipcRenderer.on('scraping-finished', () => callback()),
  onScrapingStopped: (callback: () => void) =>
    ipcRenderer.on('scraping-stopped', () => callback()),
  onError: (callback: (error: string) => void) =>
    ipcRenderer.on('error', (_event: IpcRendererEvent, error: string) => callback(error)),
  onRequestNewCookies: (callback: () => void) =>
    ipcRenderer.on('request-new-cookies', () => callback()),
});
