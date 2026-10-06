const CATALOG_JOB_KEY = "catalogImportJob";
const DISCOVERY_KEY = "catalogDiscoverySchedule";
let catalogWorkerActive = false;

async function catalogJob() { return (await chrome.storage.local.get(CATALOG_JOB_KEY))[CATALOG_JOB_KEY]; }
async function saveCatalogJob(job, resume = false) {
  const current = await catalogJob();
  if (!resume && current?.startedAt === job.startedAt && current.status === "cancelled" && job.status !== "cancelled") return;
  await chrome.storage.local.set({ [CATALOG_JOB_KEY]: { ...job, updatedAt: Date.now() } });
}

function validBestsellerUrl(value) {
  try { const url = new URL(value); return url.protocol === "https:" && /^(www\.)?amazon\.com$/.test(url.hostname) && /\/zgbs(?:\/|$)|\/Best-Sellers/i.test(url.pathname); } catch { return false; }
}

async function catalogRpc(tabId, payload) {
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const response = await chrome.tabs.sendMessage(tabId, { type: "CATALOG_IMPORT_RPC", payload });
      if (response?.ok) return response.result;
      if (response && !response.notReady) throw new Error(response.error || "Catalog request failed.");
    } catch (error) {
      if (!/receiving end|connection|message port/i.test(error.message)) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error("Sign in to Sellfinity as an administrator and open the import page.");
}

async function readCatalogPage(url, type, job) {
  const permit = await reserveAmazonPage();
  if (!permit.ok) { const error = new Error(permit.reason); error.workloadPause = true; throw error; }
  const tab = await chrome.tabs.create({ url, active: false });
  await saveCatalogJob({ ...job, productTabId: tab.id });
  let preserveTab = false;
  try {
    let reason = "Amazon page could not be read.";
    for (let attempt = 0; attempt < 30; attempt++) {
      if ((await catalogJob())?.status !== "running") throw new Error("Import stopped.");
      try {
        const response = await chrome.tabs.sendMessage(tab.id, { type });
        if (response?.ok) return response.result;
        reason = response?.error || reason;
        if (/CAPTCHA/i.test(reason)) throw new Error(reason);
      } catch (error) { if (/CAPTCHA|Import stopped/i.test(error.message)) throw error; }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error(reason);
  } catch (error) {
    preserveTab = /CAPTCHA|verification|access denied|sign.in/i.test(error.message);
    if (preserveTab) { await pauseAmazonWork("Amazon verification required for catalog import. Complete it manually, then resume.", true); error.workloadPause = true; }
    throw error;
  } finally { if (!preserveTab) try { await chrome.tabs.remove(tab.id); } catch { /* Already closed. */ } }
}

async function beginCatalogImport(candidates = [], pages = [], limit = 100, product = null) {
  const current = await catalogJob();
  if (current?.status === "running") throw new Error("A catalog import is already running. Stop it before starting another.");
  if ((await runStatuses()).some((run) => run.status === "running" && run.mode === "PRICE")) throw new Error("Finish or stop the live price check before importing products.");
  const adminTab = await chrome.tabs.create({ url: "https://www.sellfinity.app/admin/arbitrage/import", active: false });
  await saveCatalogJob({ status: "running", adminTabId: adminTab.id, candidates, pages, pageCursor: 0, cursor: 0, limit, added: 0, skipped: 0, failed: 0, errors: [], product, startedAt: Date.now() });
  void processCatalogImport();
}

async function processCatalogImport() {
  if (catalogWorkerActive) return;
  catalogWorkerActive = true;
  try {
    let job = await catalogJob();
    if (job?.status !== "running") return;
    if (job.productTabId) {
      try { await chrome.tabs.remove(job.productTabId); } catch { /* Previous browser session ended. */ }
      job.productTabId = null;
    }
    try { await chrome.tabs.get(job.adminTabId); }
    catch {
      const tab = await chrome.tabs.create({ url: "https://www.sellfinity.app/admin/arbitrage/import", active: false });
      job.adminTabId = tab.id;
    }
    await catalogRpc(job.adminTabId, { operation: "filter", asins: [] });
    if (job.product) {
      const saved = await catalogRpc(job.adminTabId, { operation: "save", rows: [job.product] });
      await saveCatalogJob({ ...job, status: "complete", added: saved.added, skipped: saved.skipped, product: null });
      return;
    }
    while (job.status === "running" && job.added < job.limit) {
      if (job.cursor >= job.candidates.length) {
        if (job.pageCursor >= job.pages.length) break;
        const page = job.pages[job.pageCursor];
        const found = await readCatalogPage(page, "CAPTURE_BESTSELLER_PAGE", job);
        const seen = new Set(job.candidates.map((row) => row.asin));
        job.candidates.push(...found.filter((row) => !seen.has(row.asin)));
        job.pageCursor++;
        await saveCatalogJob(job);
        continue;
      }
      // Filter a page-sized group before opening product tabs. Existing ASINs
      // never trigger redundant product reads or paid provider requests.
      const next = job.candidates.slice(job.cursor, job.cursor + 50);
      const result = await catalogRpc(job.adminTabId, { operation: "filter", asins: next.map((row) => row.asin) });
      const existing = new Set(result.existing);
      for (const candidate of next) {
        if ((await catalogJob())?.status !== "running") return;
        if (job.added >= job.limit) break;
        if (existing.has(candidate.asin)) { job.skipped++; job.cursor++; await saveCatalogJob(job); continue; }
        try {
          const product = await readCatalogPage(candidate.amazonUrl, "CAPTURE_CATALOG_PRODUCT", job);
          // A redirected variant cannot inherit another ASIN's bestseller rank.
          if (product.asin !== candidate.asin) throw new Error("Amazon redirected to a different ASIN. Review this product manually.");
          const saved = await catalogRpc(job.adminTabId, { operation: "save", rows: [{ ...product, source: "BESTSELLER_BROWSER", bestsellerRank: candidate.bestsellerRank, bestsellerCategory: candidate.bestsellerCategory, bestsellerUrl: candidate.bestsellerUrl }] });
          job.added += saved.added; job.skipped += saved.skipped;
        } catch (error) {
          if (error.workloadPause || /CAPTCHA|administrator|Catalog save|Catalog request|Import stopped/i.test(error.message)) throw error;
          job.failed++; job.errors = [...job.errors, `${candidate.asin}: ${error.message}`].slice(-20);
        }
        if ((await catalogJob())?.status !== "running") return;
        job.cursor++; job.productTabId = null;
        await saveCatalogJob(job);
      }
    }
    await saveCatalogJob({ ...job, status: "complete", detail: job.added >= job.limit ? "Target reached" : "Selected pages exhausted" });
  } catch (error) {
    const job = await catalogJob();
    if (job?.status === "running") await saveCatalogJob({ ...job, status: error.workloadPause ? "paused" : "error", detail: error.message });
  } finally { catalogWorkerActive = false; }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!["GET_CATALOG_IMPORT_STATUS", "IMPORT_CURRENT_AMAZON", "IMPORT_CURRENT_BESTSELLERS", "STOP_CATALOG_IMPORT", "SAVE_DISCOVERY_SCHEDULE", "RESUME_CATALOG_IMPORT"].includes(message?.type)) return;
  void (async () => {
    try {
      if (message.type === "GET_CATALOG_IMPORT_STATUS") {
        sendResponse({ ok: true, job: await catalogJob(), schedule: (await chrome.storage.local.get(DISCOVERY_KEY))[DISCOVERY_KEY] }); return;
      }
      if (message.type === "STOP_CATALOG_IMPORT") {
        const job = await catalogJob();
        if (job) {
          await saveCatalogJob({ ...job, status: "cancelled" });
          if (job.productTabId) try { await chrome.tabs.remove(job.productTabId); } catch { /* Already closed. */ }
        }
      } else if (message.type === "RESUME_CATALOG_IMPORT") {
        const job = await catalogJob();
        if (job && job.status !== "running") { await saveCatalogJob({ ...job, status: "running" }, true); void processCatalogImport(); }
      } else if (message.type === "SAVE_DISCOVERY_SCHEDULE") {
        const pages = (message.pages || []).filter(Boolean);
        if (!pages.length || pages.length > 20 || pages.some((url) => !validBestsellerUrl(url))) throw new Error("Enter 1–20 Amazon Best Sellers category/page URLs.");
        if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(message.time)) throw new Error("Choose a valid time.");
        await chrome.storage.local.set({ [DISCOVERY_KEY]: { enabled: Boolean(message.enabled), time: message.time, pages, limit: Math.max(1, Math.min(1000, Number(message.limit) || 100)) } });
      } else {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab?.url || !/^https:\/\/(www\.)?amazon\.com\//.test(tab.url)) throw new Error("Open an Amazon product or Best Sellers page first.");
        const response = await chrome.tabs.sendMessage(tab.id, { type: message.type === "IMPORT_CURRENT_AMAZON" ? "CAPTURE_CATALOG_PRODUCT" : "CAPTURE_BESTSELLER_PAGE" });
        if (!response?.ok) throw new Error(response?.error || "Reload the Amazon tab after reloading the extension.");
        await beginCatalogImport(message.type === "IMPORT_CURRENT_BESTSELLERS" ? response.result : [], [], 1000, message.type === "IMPORT_CURRENT_AMAZON" ? response.result : null);
      }
      sendResponse({ ok: true });
    } catch (error) { sendResponse({ ok: false, error: error.message }); }
  })();
  return true;
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== "catalog-discovery") return;
  void (async () => {
    const job = await catalogJob();
    if (job?.status === "paused" || (await workloadState()).paused) return;
    if (job?.status === "running") { await processCatalogImport(); return; }
    const settings = (await chrome.storage.local.get(DISCOVERY_KEY))[DISCOVERY_KEY];
    const now = new Date();
    if (!settings?.enabled || settings.lastDay === localDay(now)) return;
    const [hours, minutes] = settings.time.split(":").map(Number);
    if (now.getHours() * 60 + now.getMinutes() < hours * 60 + minutes) return;
    try {
      await beginCatalogImport([], settings.pages, settings.limit);
      await chrome.storage.local.set({ [DISCOVERY_KEY]: { ...settings, lastDay: localDay(now) } });
    } catch { /* Wait until any existing price-check run finishes. */ }
  })();
});
void chrome.alarms.create("catalog-discovery", { periodInMinutes: 1 });
