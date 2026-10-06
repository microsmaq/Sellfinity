// Workload limits are not anti-detection controls. Verification always needs a human.
const WORKLOAD_KEY = "amazonWorkloadControls";
const WORKLOAD_ALARM = "amazon-workload-wake";
const DEFAULT_WORKLOAD = { intervalSeconds: 60, dailyLimit: 100, batchSize: 20, breakMinutes: 15 };
let queueProcessing = false;

async function workloadState() {
  const saved = (await chrome.storage.local.get(WORKLOAD_KEY))[WORKLOAD_KEY] || {};
  const today = new Date().toDateString();
  return { ...DEFAULT_WORKLOAD, ...saved, ...(saved.day !== today ? { day: today, used: 0, batchCount: 0 } : {}) };
}
async function saveWorkload(patch) {
  const state = { ...(await workloadState()), ...patch };
  await chrome.storage.local.set({ [WORKLOAD_KEY]: state });
  return state;
}
async function pauseAmazonWork(reason, verification = false, verificationTabId = null) {
  await saveWorkload({ paused: true, verification, verificationTabId, verificationCheckAt: verification ? Date.now() + 60 * 60_000 : 0, reason, nextAt: 0 });
  const requests = await pendingRequests();
  for (const sourceTabId of new Set(requests.filter((r) => r.bulk).map((r) => r.sourceTabId))) {
    try { await chrome.tabs.sendMessage(sourceTabId, { type: "AMAZON_WORKLOAD_STATUS", paused: true, reason }); } catch { /* Page closed. */ }
  }
}
async function checkVerificationPause() {
  const state = await workloadState();
  if (!state.paused || !state.verification || !state.verificationTabId || Date.now() < state.verificationCheckAt) return;
  // Inspect the existing page only. Never reload, solve, submit, or bypass a challenge.
  await saveWorkload({ verificationCheckAt: Date.now() + 60 * 60_000 });
  try {
    const result = await chrome.tabs.sendMessage(state.verificationTabId, { type: "CHECK_AMAZON_VERIFICATION" });
    const current = await workloadState();
    if (result?.readable === true && current.paused && current.verification && current.verificationTabId === state.verificationTabId) {
      await saveWorkload({ paused: false, verification: false, verificationTabId: null, failures: 0, reason: "Amazon page is readable again. Continuing saved work." });
      for (const request of (await pendingRequests()).filter((r) => r.destinationTabId === state.verificationTabId)) {
        await chrome.tabs.sendMessage(state.verificationTabId, { type: request.mode === "PRICE" ? "INSPECT_AMAZON_PRICE" : "INSPECT_AMAZON_TRACKING" });
      }
    }
  } catch { /* A missing or unreadable page remains paused for human review. */ }
}
async function reserveAmazonPage() {
  const state = await workloadState();
  if (state.paused) return { ok: false, reason: state.reason || "Paused by user." };
  if ((state.used || 0) >= state.dailyLimit) return { ok: false, reason: "Daily page limit reached. Remaining work will continue tomorrow." };
  if ((state.nextAt || 0) > Date.now()) return { ok: false, reason: `Scheduled wait until ${new Date(state.nextAt).toLocaleTimeString()}.` };
  if ((await pendingRequests()).some((r) => r.bulk && r.destinationTabId !== null)) return { ok: false, reason: "Waiting for the open Amazon page." };
  const batchCount = (state.batchCount || 0) + 1;
  const takingBreak = batchCount >= state.batchSize;
  await saveWorkload({ used: (state.used || 0) + 1, batchCount: takingBreak ? 0 : batchCount, nextAt: Date.now() + (takingBreak ? state.breakMinutes * 60_000 : state.intervalSeconds * 1000), reason: takingBreak ? "Scheduled batch break." : "Waiting between page checks." });
  return { ok: true };
}
async function noteAmazonRead(success, unavailable = false) {
  if (success || unavailable) return saveWorkload({ failures: 0 });
  const failures = ((await workloadState()).failures || 0) + 1;
  const state = await workloadState();
  return saveWorkload({ failures, nextAt: Math.max(state.nextAt || 0, Date.now() + Math.min(15, 2 ** Math.min(failures - 1, 4)) * 60_000), reason: "Temporary read failure. Remaining items will continue automatically after a short wait." });
}
chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  if (!["GET_WORKLOAD_SETTINGS", "SAVE_WORKLOAD_SETTINGS", "PAUSE_AMAZON_WORK", "RESUME_AMAZON_WORK"].includes(message?.type)) return;
  void (async () => {
    if (message.type === "GET_WORKLOAD_SETTINGS") return respond({ ok: true, settings: await workloadState() });
    if (message.type === "SAVE_WORKLOAD_SETTINGS") {
      const input = message.settings || {};
      const bounds = { intervalSeconds: [30, 3600], dailyLimit: [1, 1000], batchSize: [1, 100], breakMinutes: [1, 240] };
      for (const [field, [min, max]] of Object.entries(bounds)) {
        if (!Number.isInteger(input[field]) || input[field] < min || input[field] > max) return respond({ ok: false });
      }
      await saveWorkload(Object.fromEntries(Object.keys(bounds).map((key) => [key, input[key]])));
    }
    if (message.type === "PAUSE_AMAZON_WORK") await pauseAmazonWork("Paused by user.");
    if (message.type === "RESUME_AMAZON_WORK") {
      const state = await workloadState();
      if (state.verification && !message.verificationCompleted) return respond({ ok: false, verificationRequired: true });
      // A confirmation does not solve verification; the open page is inspected again.
      await saveWorkload({ paused: false, verification: false, failures: 0, reason: "Resuming saved work." });
      const requests = await pendingRequests();
      const closed = new Set();
      for (const request of requests.filter((r) => r.destinationTabId !== null)) {
        try { await chrome.tabs.sendMessage(request.destinationTabId, { type: request.mode === "PRICE" ? "INSPECT_AMAZON_PRICE" : "INSPECT_AMAZON_TRACKING" }); } catch { closed.add(request.requestId); }
      }
      if (closed.size) await savePending((await pendingRequests()).map((r) => closed.has(r.requestId) ? { ...r, destinationTabId: null } : r));
      const job = await catalogJob();
      if (job?.status === "paused") { await saveCatalogJob({ ...job, status: "running" }); void processCatalogImport(); }
      for (const source of new Set((await pendingRequests()).filter((r) => r.bulk).map((r) => r.sourceTabId))) void processBulkQueue(source);
    }
    respond({ ok: true });
  })();
  return true;
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== WORKLOAD_ALARM) return;
  void (async () => {
    await checkVerificationPause();
    if ((await workloadState()).paused) return;
    const job = await catalogJob();
    if (job?.status === "paused") { await saveCatalogJob({ ...job, status: "running" }); void processCatalogImport(); }
    for (const source of new Set((await pendingRequests()).filter((r) => r.bulk).map((r) => r.sourceTabId))) await processBulkQueue(source);
  })();
});
void chrome.alarms.create(WORKLOAD_ALARM, { periodInMinutes: 1 });
chrome.runtime.onStartup.addListener(() => {
  // Chrome can discard helper tabs on restart. Release stale destinations but
  // retain queued items and verification pauses; never re-read a completed item.
  void (async () => {
    const missing = new Set();
    for (const r of (await pendingRequests()).filter((r) => r.destinationTabId !== null)) {
      try { await chrome.tabs.get(r.destinationTabId); } catch { missing.add(r.requestId); }
    }
    if (missing.size) await savePending((await pendingRequests()).map((r) => missing.has(r.requestId) ? { ...r, destinationTabId: null } : r));
  })();
});
