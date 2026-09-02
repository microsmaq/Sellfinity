const modes = {
  PRICE: { prefix: "price", idle: "No price check is running." },
  TRACKING: { prefix: "tracking", idle: "No tracking check is running." }
};

document.getElementById("version").textContent = `Version ${chrome.runtime.getManifest().version}`;

function renderMode(mode, response) {
  const meta = modes[mode];
  const status = response.statuses.find((candidate) => candidate.mode === mode);
  const remaining = response.remaining?.[mode] || 0;
  const open = response.open?.[mode] || 0;
  const statusElement = document.getElementById(`${meta.prefix}-status`);
  const detailElement = document.getElementById(`${meta.prefix}-detail`);
  const bar = document.getElementById(`${meta.prefix}-bar`);
  const button = document.getElementById(`stop-${meta.prefix}`);
  const state = status?.status || "idle";
  statusElement.textContent = state;
  statusElement.className = `status ${state}`;
  if (!status) {
    detailElement.textContent = meta.idle;
    bar.style.width = "0%";
    button.disabled = true;
    return;
  }
  const percentage = status.total ? Math.round(status.completed / status.total * 100) : 0;
  bar.style.width = `${percentage}%`;
  detailElement.textContent = `${status.completed}/${status.total} processed · ${status.found} found · ${status.errors} errors · ${remaining} remaining · ${open} open`;
  button.disabled = state !== "running" && remaining === 0;
}

async function refreshStatus() {
  try {
    const response = await chrome.runtime.sendMessage({ type: "GET_HELPER_STATUS" });
    if (!response?.ok) return;
    renderMode("PRICE", response);
    renderMode("TRACKING", response);
  } catch {
    document.querySelectorAll(".detail").forEach((element) => { element.textContent = "Helper status is temporarily unavailable."; });
  }
}

async function stop(mode) {
  const button = document.getElementById(`stop-${modes[mode].prefix}`);
  button.disabled = true;
  button.textContent = "Stopping…";
  try { await chrome.runtime.sendMessage({ type: "CANCEL_BULK_REQUESTS", mode }); }
  finally {
    button.textContent = mode === "PRICE" ? "Stop price check" : "Stop tracking check";
    await refreshStatus();
  }
}

document.getElementById("stop-price").addEventListener("click", () => stop("PRICE"));
document.getElementById("stop-tracking").addEventListener("click", () => stop("TRACKING"));
void refreshStatus();
setInterval(refreshStatus, 1000);
