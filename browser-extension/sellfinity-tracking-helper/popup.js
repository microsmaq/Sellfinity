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
  const work = response.workload;
  const state = status?.status === "running" && remaining > 0 && work?.paused ? "paused"
    : status?.status === "running" && remaining > 0 && !open && ((work?.nextAt || 0) > Date.now() || (work?.used || 0) >= work?.dailyLimit) ? "waiting"
      : status?.status || "idle";
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
    const workload = await chrome.runtime.sendMessage({ type: "GET_WORKLOAD_SETTINGS" });
    if (workload?.ok) {
      response.workload = workload.settings;
      const state = workload.settings;
      document.getElementById("work-detail").textContent = `${state.used || 0}/${state.dailyLimit} pages today · ${state.paused ? state.reason : (state.nextAt > Date.now() ? `${state.reason} Next check after ${new Date(state.nextAt).toLocaleTimeString()}.` : "Ready")}`;
      document.getElementById("pause-work").disabled = !!state.paused;
      document.getElementById("resume-work").disabled = !state.paused;
    }
    renderMode("PRICE", response);
    renderMode("TRACKING", response);
    const daily = await chrome.runtime.sendMessage({ type: "GET_DAILY_SETTINGS" });
    if (daily?.ok) document.getElementById("daily-detail").textContent = `${daily.settings.status || "Ready"} · ${daily.settings.detail || "Daily scheduling is off until enabled."}`;
    const catalog = await chrome.runtime.sendMessage({ type: "GET_CATALOG_IMPORT_STATUS" });
    if (catalog?.job) {
      const job = catalog.job;
      document.getElementById("catalog-detail").textContent = `${job.status} · ${job.added} added · ${job.updated || 0} enriched · ${job.skipped} skipped · ${job.failed} errors${job.detail ? ` · ${job.detail}` : ""}`;
      document.getElementById("stop-catalog").disabled = job.status !== "running";
      document.getElementById("resume-catalog").disabled = !["error", "cancelled"].includes(job.status);
    }
  } catch {
    document.querySelectorAll(".detail:not(#work-feedback)").forEach((element) => { element.textContent = "Helper status is temporarily unavailable."; });
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

void chrome.runtime.sendMessage({ type: "GET_WORKLOAD_SETTINGS" }).then((response) => {
  if (!response?.ok) return;
  const state = response.settings;
  for (const [id, field] of [["interval", "intervalSeconds"], ["limit", "dailyLimit"], ["batch", "batchSize"], ["break", "breakMinutes"]]) document.getElementById(`work-${id}`).value = state[field];
}).catch(() => { document.getElementById("work-feedback").textContent = "Settings could not load. Reload the extension, then reopen this popup."; });
document.getElementById("save-work").addEventListener("click", async () => {
  const feedback = document.getElementById("work-feedback");
  const button = document.getElementById("save-work");
  const fields = [["interval", "intervalSeconds", "Seconds between pages"], ["limit", "dailyLimit", "Maximum pages per day"], ["batch", "batchSize", "Pages before a break"], ["break", "breakMinutes", "Break length"]];
  const settings = {};
  for (const [id, field, label] of fields) {
    const input = document.getElementById(`work-${id}`);
    const value = Number(input.value);
    if (!input.value.trim() || !Number.isInteger(value) || value < Number(input.min) || value > Number(input.max)) {
      feedback.textContent = `${label}: enter a whole number from ${input.min} to ${input.max}.`;
      input.focus();
      return;
    }
    settings[field] = value;
  }
  button.disabled = true;
  button.textContent = "Saving…";
  try {
    const result = await chrome.runtime.sendMessage({ type: "SAVE_WORKLOAD_SETTINGS", settings });
    feedback.textContent = result?.ok ? "Workload limits saved. Your pause status is unchanged." : result?.error || "The helper did not confirm the save. Reload the extension and try again.";
  } catch {
    feedback.textContent = "Chrome could not reach the helper. Reload the extension, reopen this popup, and try again.";
  } finally {
    button.disabled = false;
    button.textContent = "Save workload limits";
  }
});
document.getElementById("pause-work").addEventListener("click", async () => { await chrome.runtime.sendMessage({ type: "PAUSE_AMAZON_WORK" }); await refreshStatus(); });
document.getElementById("resume-work").addEventListener("click", async () => {
  const { settings } = await chrome.runtime.sendMessage({ type: "GET_WORKLOAD_SETTINGS" });
  if (settings.verification && !confirm("Complete Amazon verification or sign-in manually in the open tab first. Have you completed it?")) return;
  await chrome.runtime.sendMessage({ type: "RESUME_AMAZON_WORK", verificationCompleted: !!settings.verification });
  await refreshStatus();
});

void chrome.runtime.sendMessage({ type: "GET_DAILY_SETTINGS" }).then((response) => {
  if (!response?.ok) return;
  document.getElementById("daily-enabled").checked = response.settings.enabled;
  document.getElementById("daily-time").value = response.settings.time;
  document.getElementById("daily-mode").value = response.settings.mode || "ADMIN";
});
document.getElementById("save-daily").addEventListener("click", async () => {
  const enabled = document.getElementById("daily-enabled").checked;
  const time = document.getElementById("daily-time").value;
  const mode = document.getElementById("daily-mode").value;
  const response = await chrome.runtime.sendMessage({ type: "SAVE_DAILY_SETTINGS", enabled, time, mode });
  document.getElementById("daily-detail").textContent = response?.ok ? (enabled ? `Scheduled daily at ${time} on this computer.` : "Daily schedule disabled.") : "Enter a valid start time.";
});
document.getElementById("run-daily").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "RUN_DAILY_NOW" });
  await refreshStatus();
});

async function catalogCommand(type, payload = {}) {
  try {
    const response = await chrome.runtime.sendMessage({ type, ...payload });
    document.getElementById("catalog-detail").textContent = response?.ok ? "Request accepted." : response?.error || "Import could not start.";
  } catch { document.getElementById("catalog-detail").textContent = "Reload the extension and the Amazon/Sellfinity tabs."; }
}
document.getElementById("capture-product").addEventListener("click", () => catalogCommand("IMPORT_CURRENT_AMAZON"));
document.getElementById("capture-bestsellers").addEventListener("click", () => catalogCommand("IMPORT_CURRENT_BESTSELLERS"));
document.getElementById("stop-catalog").addEventListener("click", () => catalogCommand("STOP_CATALOG_IMPORT"));
document.getElementById("resume-catalog").addEventListener("click", () => catalogCommand("RESUME_CATALOG_IMPORT"));
document.getElementById("save-discovery").addEventListener("click", () => catalogCommand("SAVE_DISCOVERY_SCHEDULE", {
  enabled: document.getElementById("discovery-enabled").checked,
  time: document.getElementById("discovery-time").value,
  limit: Number(document.getElementById("discovery-limit").value),
  pages: document.getElementById("discovery-pages").value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean),
}));
void chrome.runtime.sendMessage({ type: "GET_CATALOG_IMPORT_STATUS" }).then((response) => {
  const schedule = response?.schedule;
  if (!schedule) return;
  document.getElementById("discovery-enabled").checked = schedule.enabled;
  document.getElementById("discovery-time").value = schedule.time;
  document.getElementById("discovery-limit").value = schedule.limit;
  document.getElementById("discovery-pages").value = schedule.pages.join("\n");
});
