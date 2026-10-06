const DAILY_KEY = "dailyAdminPriceCheck";
const DAILY_ALARM = "daily-admin-price-check";
let dailyStarting = false;

async function dailySettings() {
  return (await chrome.storage.local.get(DAILY_KEY))[DAILY_KEY] || { enabled: false, time: "02:00" };
}

async function updateDaily(patch) {
  const settings = { ...(await dailySettings()), ...patch };
  await chrome.storage.local.set({ [DAILY_KEY]: settings });
  return settings;
}

function localDay(date) {
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

async function runDailyCheck(force = false, resume = false) {
  if (dailyStarting) return;
  dailyStarting = true;
  try {
    const settings = await dailySettings();
    if (typeof workloadState === "function" && (await workloadState()).paused) return;
    const userSync = settings.mode === "USER";
    if ((await catalogJob())?.status === "running") return;
    const now = new Date();
    const [hours, minutes] = settings.time.split(":").map(Number);
    if (!force && (!settings.enabled || settings.lastDay === localDay(now) || now.getHours() * 60 + now.getMinutes() < hours * 60 + minutes)) return;
    if (!resume && ["running", "starting"].includes(settings.status)) return;
    if ((await runStatuses()).some((run) => run.mode === "PRICE" && run.status === "running")) return;
    await updateDaily({ status: "starting", detail: userSync ? "Opening user listings…" : "Opening admin catalog…" });
    const tab = await chrome.tabs.create({ url: userSync ? "https://www.sellfinity.app/listings" : "https://www.sellfinity.app/admin/arbitrage", active: false });
    await updateDaily({ sourceTabId: tab.id, lastDay: localDay(now), status: "running", startedAt: Date.now() });
    for (let attempt = 0; attempt < 60; attempt++) {
      try {
        const response = await chrome.tabs.sendMessage(tab.id, { type: userSync ? "START_DAILY_USER_SYNC" : "START_DAILY_ADMIN_CHECK", resume });
        if (response?.ok) {
          return;
        }
      } catch { /* The admin page and helper need to finish loading. */ }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    await updateDaily({ status: "error", lastDay: localDay(now), detail: "Daily check could not start. Sign in to the correct Sellfinity account, then click Run now." });
  } catch {
    await updateDaily({ status: "error", lastDay: localDay(new Date()), detail: "Daily task could not open or connect. Check Chrome and your connection, then Run now." });
  } finally {
    dailyStarting = false;
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "CANCEL_BULK_REQUESTS" && (!message.mode || message.mode === "PRICE")) {
    void dailySettings().then((settings) => {
      if (settings.status === "running" && (!sender.tab || sender.tab.id === settings.sourceTabId)) {
        return updateDaily({ status: "cancelled", detail: "Daily scan stopped. Completed updates were kept." });
      }
    });
  }
  if (message?.type === "GET_DAILY_SETTINGS") {
    dailySettings().then((settings) => sendResponse({ ok: true, settings }));
    return true;
  }
  if (message?.type === "SAVE_DAILY_SETTINGS") {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(message.time)) { sendResponse({ ok: false }); return; }
    updateDaily({ enabled: Boolean(message.enabled), time: message.time, mode: message.mode === "USER" ? "USER" : "ADMIN" }).then((settings) => sendResponse({ ok: true, settings }));
    return true;
  }
  if (message?.type === "RUN_DAILY_NOW") {
    void runDailyCheck(true);
    sendResponse({ ok: true });
  }
  if (message?.type === "DAILY_CHECK_COMPLETE") {
    void (async () => {
      const settings = await dailySettings();
      if (sender.tab?.id !== settings.sourceTabId) return;
      await updateDaily({ status: message.failed ? "error" : "complete", finishedAt: Date.now(), detail: message.detail || "Daily catalog check complete" });
    })();
  }
  if (message?.type === "DAILY_USER_PROGRESS") {
    void dailySettings().then((settings) => {
      if (sender.tab?.id !== settings.sourceTabId) return;
      return updateDaily({ detail: message.detail, updatedAt: Date.now() });
    });
  }
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === DAILY_ALARM) void runDailyCheck();
});
chrome.runtime.onStartup.addListener(() => {
  void (async () => {
    const settings = await dailySettings();
    // Session queues disappear when Chrome exits. Start a fresh catalog scan
    // and skip saved fresh records to recover unfinished work on restart.
    if (settings.enabled && ["starting", "running"].includes(settings.status)) await runDailyCheck(true, true);
    else await runDailyCheck();
  })();
});
void chrome.alarms.create(DAILY_ALARM, { periodInMinutes: 1 });
