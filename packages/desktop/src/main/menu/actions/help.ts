import { ipcMain } from 'electron'

// MoMark opens a dedicated about window (PHASE2-SPEC §9) instead of an
// in-editor dialog, so this action only forwards to the main controller.
export const showAboutDialog = (): void => {
  ipcMain.emit('app-create-about-window')
}
