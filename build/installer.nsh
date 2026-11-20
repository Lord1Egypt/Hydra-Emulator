; Hydra Emulator Customised NSIS scripts
; Activation: Before unloading starts, finish the running process that may still be in the backstage,
; Otherwise, they lock the files in the installed directory, causing the unloading to be imperilled and the third-party shredding tool to be removed.
;
; Hydra Emulator may still leave detached qemu after he quits.),
; So the unloading must be done by itself.

; Installing closing: A further layer of desktop icons.
; CreateDesktopShortcut from eclectron-Builder,
; The individual environment (the desktop is reoriented by OneDrive and the fast way is rolled back by the security software) creates a failure.,
; The user has found nothing on the desktop. Write it again with NSIS original CreateShortcut.:
; $DESKTOP Go SHGetFolderPath to follow the desktop’s redirection path correctly; writing to stubble etc.,
; The repeat execution with electron-Builder is just the same. Ink.
!macro customInstall
  DetailPrint "Creating desktop shortcuts…"
  CreateShortcut "$DESKTOP\Hydra Emulator.lnk" "$INSTDIR\Hydra Emulator.exe" "" "$INSTDIR\Hydra Emulator.exe" 0 \
    SW_SHOWNORMAL "" "Run Android apps on Windows"
  CreateDirectory "$SMPROGRAMS\Hydra Emulator"
  CreateShortcut "$SMPROGRAMS\Hydra Emulator\Hydra Emulator.lnk" "$INSTDIR\Hydra Emulator.exe" "" "$INSTDIR\Hydra Emulator.exe" 0 \
    SW_SHOWNORMAL "" "Run Android apps on Windows"
!macroend

!macro customUnInstall
  ; Deleting your own shortcut entry (no Hydra Emulator installed) should also be left behind)
  Delete "$DESKTOP\Hydra Emulator.lnk"
  Delete "$SMPROGRAMS\Hydra Emulator\Hydra Emulator.lnk"
  RMDir "$SMPROGRAMS\Hydra Emulator"

  DetailPrint "Stopping Hydra Emulator processes…"
  ; /F Strangular / T-band process. When the process does not exist, taskkill returns 128, and ignores it.
  nsExec::Exec 'taskkill.exe /F /T /IM "Hydra Emulator.exe"'
  nsExec::Exec 'taskkill.exe /F /T /IM qemu-system-x86_64.exe'
  nsExec::Exec 'taskkill.exe /F /T /IM qemu-system-i386.exe'
  nsExec::Exec 'taskkill.exe /F /T /IM emulator.exe'
  nsExec::Exec 'taskkill.exe /F /T /IM emulator-check.exe'
  nsExec::Exec 'taskkill.exe /F /T /IM adb.exe'
  nsExec::Exec 'taskkill.exe /F /T /IM netsimd.exe'
  ; Give me a moment to get the process out of the way, and release the document.
  Sleep 1500
!macroend
