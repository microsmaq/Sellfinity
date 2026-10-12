// Reset is available only from the extension's own confirmation dialog, never
// from an Amazon/Sellfinity content script or a forwarded webpage message.
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.type !== "RESET_HELPER") return;
  if (sender.id !== chrome.runtime.id || sender.tab || sender.url !== chrome.runtime.getURL("popup.html") || message.confirmed !== true) {
    respond({ ok: false, error: "Confirm the reset in the helper popup first." });
    return;
  }
  void (async () => {
    await chrome.alarms.clearAll();
    await chrome.storage.local.clear();
    respond({ ok: true });
    // Terminate old worker tasks and content-script connections immediately.
    // The new worker recreates its alarms with all schedules disabled/defaults.
    chrome.runtime.reload();
  })().catch(() => respond({ ok: false, error: "The helper could not complete the reset. Try again or reload the extension." }));
  return true;
});
