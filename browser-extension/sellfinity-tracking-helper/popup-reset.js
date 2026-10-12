const resetDialog = document.getElementById("reset-dialog");
const resetConfirm = document.getElementById("confirm-reset");
const resetCancel = document.getElementById("cancel-reset");
document.getElementById("open-reset").addEventListener("click", () => {
  document.getElementById("reset-feedback").textContent = "";
  resetDialog.showModal();
});
resetCancel.addEventListener("click", () => resetDialog.close());
resetConfirm.addEventListener("click", async () => {
  resetConfirm.disabled = true;
  resetCancel.disabled = true;
  resetConfirm.textContent = "Resetting…";
  document.getElementById("reset-feedback").textContent = "";
  try {
    const response = await chrome.runtime.sendMessage({ type: "RESET_HELPER", confirmed: true });
    if (!response?.ok) throw new Error(response?.error || "Reset could not complete.");
    document.getElementById("reset-feedback").textContent = "Helper reset. Reopen the popup and refresh Amazon and Sellfinity tabs.";
  } catch (error) {
    document.getElementById("reset-feedback").textContent = error.message || "Reset could not complete. Reload the extension and try again.";
    resetConfirm.disabled = false;
    resetCancel.disabled = false;
    resetConfirm.textContent = "Reset extension";
  }
});
