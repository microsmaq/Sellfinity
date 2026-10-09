const CATALOG_JOB_KEY = "catalogImportJob";
const DISCOVERY_KEY = "catalogDiscoverySchedule";
const REPAIR_KEY = "catalogContentRepairSchedule";
let catalogWorkerActive = false;
let continuousStarting = false;
let discoveryWrites = Promise.resolve();
const DISCOVERY_RETRY_MS = 15 * 60_000;
const DISCOVERY_FRESH_MS = 24 * 60 * 60_000;
const DEFAULT_DISCOVERY_PAGES = ["home-garden", "kitchen", "sporting-goods", "tools", "office-products", "pet-supplies", "toys-and-games", "arts-crafts", "beauty", "electronics"].flatMap((category) => [1, 2].map((page) => `https://www.amazon.com/Best-Sellers/zgbs/${category}?pg=${page}`));

function normalizedDiscovery(settings) {
  if (!settings || settings.checksVersion === 1) return settings;
  // Old pageVisits were written before reading a page, so they cannot prove
  // success. Keep their attempt ordering but make these unknown outcomes due.
  const checks = { ...(settings.pageChecks || {}) };
  for (const [page, attemptedAt] of Object.entries(settings.pageVisits || {})) {
    if (!checks[page]) checks[page] = { attemptedAt, status: "unknown" };
  }
  const { pageVisits: _legacy, ...rest } = settings;
  return { ...rest, checksVersion: 1, pageChecks: checks };
}
async function updateDiscovery(change) {
  const write = discoveryWrites.then(async () => {
    const current = normalizedDiscovery((await chrome.storage.local.get(DISCOVERY_KEY))[DISCOVERY_KEY]);
    const next = change(current);
    if (next) await chrome.storage.local.set({ [DISCOVERY_KEY]: next });
    return next;
  });
  discoveryWrites = write.catch(() => {});
  return write;
}
async function discoverySettings() {
  const settings = (await chrome.storage.local.get(DISCOVERY_KEY))[DISCOVERY_KEY];
  return settings && settings.checksVersion !== 1 ? updateDiscovery((latest) => latest) : settings;
}
function categoryDueAt(check) {
  if (!check || check.status === "unknown") return 0;
  if (check.status === "success") return (check.successfulAt || 0) + DISCOVERY_FRESH_MS;
  return check.retryAt || (check.attemptedAt || 0) + DISCOVERY_RETRY_MS;
}
function discoveryQueue(settings, now = Date.now()) {
  return (settings?.pages || []).map((page) => ({ page, check: settings.pageChecks?.[page], dueAt: categoryDueAt(settings.pageChecks?.[page]) }))
    .sort((a, b) => (a.check?.attemptedAt || 0) - (b.check?.attemptedAt || 0))
    .filter((entry) => entry.dueAt <= now);
}
async function recordCategoryCheck(page, status, detail = "", productsFound = 0) {
  await updateDiscovery((settings) => {
    if (!settings?.pages?.includes(page)) return settings;
    const previous = settings.pageChecks?.[page] || {};
    const failures = status === "failed" ? (previous.failures || 0) + 1 : status === "success" ? 0 : previous.failures || 0;
    const check = { ...previous, status, failures, lastError: detail,
      ...(status === "checking" ? { attemptedAt: Date.now(), retryAt: Date.now() + DISCOVERY_RETRY_MS } : {}),
      ...(status === "success" ? { successfulAt: Date.now(), retryAt: 0, productsFound } : {}),
      ...(status === "failed" ? { retryAt: Date.now() + DISCOVERY_RETRY_MS * 2 ** Math.min(failures - 1, 4) } : {}),
    };
    return { ...settings, pageChecks: { ...settings.pageChecks, [page]: check } };
  });
}
function catalogHasRemaining(job) {
  return Boolean(job && (job.product || (job.repair && !job.prepared) || job.cursor < (job.candidates?.length || 0) || job.pageCursor < (job.pages?.length || 0)));
}

async function continueDiscovery() {
  if (continuousStarting) return;
  continuousStarting = true;
  try {
    const settings = await discoverySettings();
    const job = await catalogJob();
    const workload = await workloadState();
    if (!settings?.enabled || !settings.continuous || ["running", "paused", "error"].includes(job?.status) || workload.paused || (workload.used || 0) >= workload.dailyLimit || (workload.nextAt || 0) > Date.now()) return;
    const page = discoveryQueue(settings)[0]?.page;
    if (!page) return;
    await beginCatalogImport([], [page], 1000, null, false, true);
    await updateDiscovery((latest) => latest ? { ...latest, lastError: "" } : latest);
  } catch (error) {
    await updateDiscovery((settings) => settings?.enabled ? { ...settings, lastError: error.message || "Discovery could not start. Check admin sign-in." } : settings);
    throw error;
  } finally { continuousStarting = false; }
}

async function catalogJob() { return (await chrome.storage.local.get(CATALOG_JOB_KEY))[CATALOG_JOB_KEY]; }
async function catalogActivity() {
  const job = await catalogJob();
  const settings = await discoverySettings();
  const work = await workloadState();
  const enabled = Boolean(settings?.enabled);
  let state = job?.status || (enabled ? "waiting" : "off");
  let reason = job?.stage || job?.detail || "Discovery is off. Start continuous discovery or save a daily schedule.";
  let nextAt = null;
  const tomorrow = () => { const date = new Date(); date.setHours(24, 0, 0, 0); return date.getTime(); };
  if (work.paused && (enabled || ["running", "paused"].includes(job?.status))) { state = "paused"; reason = work.reason || "Browsing is paused. Check workload controls."; nextAt = work.verificationCheckAt || null; }
  else if (job?.status === "error") { state = "error"; reason = job.detail || "Discovery needs attention. Resume after correcting the error."; }
  else if ((enabled || ["running", "paused"].includes(job?.status)) && (work.used || 0) >= work.dailyLimit) { state = "waiting"; reason = "Daily page allowance reached. Resumes tomorrow without changing your limits."; nextAt = tomorrow(); }
  else if (["running", "paused"].includes(job?.status)) {
    if (job.status === "paused" || (!job.productTabId && (work.nextAt || 0) > Date.now())) { state = "waiting"; reason = job.detail || work.reason || "Waiting for the next slow-drip page slot."; nextAt = work.nextAt > Date.now() ? work.nextAt : Date.now() + 60_000; }
  } else if (enabled) {
    state = "waiting";
    if (settings.lastError) { reason = settings.lastError; nextAt = Date.now() + 60_000; }
    else if (settings.continuous) {
      const eligible = discoveryQueue(settings).length > 0;
      const retrying = settings.pages.some((page) => ["failed", "checking", "unknown"].includes(settings.pageChecks?.[page]?.status));
      reason = eligible ? "Categories are ready. Continuing on the next scheduler tick when browsing is available." : retrying ? "Waiting to retry unreadable or interrupted categories after a cooldown." : "All category pages were successfully read recently. Waiting before the next pass.";
      nextAt = eligible ? Math.max(Date.now() + 60_000, work.nextAt || 0) : Math.max(work.nextAt || 0, Math.min(...settings.pages.map((page) => categoryDueAt(settings.pageChecks?.[page]))));
    } else {
      const date = new Date(); const [hour, minute] = settings.time.split(":").map(Number); date.setHours(hour, minute, 0, 0);
      const reachedTarget = settings.addedDay === localDay(new Date()) && (settings.addedToday || 0) >= settings.limit;
      if (reachedTarget) date.setDate(date.getDate() + 1);
      const earliestCategory = discoveryQueue(settings).length ? Date.now() + 60_000 : Math.min(...settings.pages.map((page) => categoryDueAt(settings.pageChecks?.[page])));
      nextAt = Math.max(date.getTime(), earliestCategory, work.nextAt || 0); reason = reachedTarget ? "Daily new-product target reached. Next run is tomorrow." : `Daily discovery enabled at ${settings.time}; failed categories retry after a cooldown.`;
    }
  }
  const categoryChecks = (settings?.pages || []).map((page) => settings.pageChecks?.[page]);
  return { state, reason, nextAt, canResume: ["error", "cancelled"].includes(job?.status) && catalogHasRemaining(job), categoriesSuccessful: categoryChecks.filter((check) => check?.status === "success").length, categoriesRetrying: categoryChecks.filter((check) => ["failed", "checking", "unknown"].includes(check?.status)).length, categoriesUnattempted: categoryChecks.filter((check) => !check).length, continuous: Boolean(enabled && settings.continuous), enabled, currentUrl: job?.currentUrl || "", currentAsin: job?.currentAsin || "", processed: job?.cursor || 0, total: job?.candidates?.length || 0, pagesChecked: job?.pageCursor || 0, pagesTotal: job?.pages?.length || 0, pagesFailed: job?.pagesFailed || 0, added: job?.added || 0, enriched: job?.updated || 0, skipped: job?.skipped || 0, failed: (job?.failed || 0) + (job?.pagesFailed || 0), errors: job?.errors || [], updatedAt: job?.updatedAt || null };
}
async function saveCatalogJob(job, resume = false) {
  const current = await catalogJob();
  if (!resume && current?.startedAt === job.startedAt && current.status === "cancelled" && job.status !== "cancelled") return;
  await chrome.storage.local.set({ [CATALOG_JOB_KEY]: { ...(current?.startedAt === job.startedAt ? current : {}), ...job, updatedAt: Date.now() } });
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
  if (type === "CAPTURE_BESTSELLER_PAGE") await recordCategoryCheck(url, "checking");
  await saveCatalogJob({ ...job, productTabId: tab.id, currentUrl: url, currentAsin: type === "CAPTURE_CATALOG_PRODUCT" ? job.candidates[job.cursor]?.asin || "" : "", stage: type === "CAPTURE_CATALOG_PRODUCT" ? "Reading Amazon product details" : "Scanning bestseller category" });
  let preserveTab = false;
  try {
    if (job.repair) {
      const candidate = job.candidates[job.cursor];
      if (candidate?.id) await catalogRpc(job.adminTabId, { operation: "contentCheck", id: candidate.id });
    }
    let reason = "Amazon page could not be read.";
    for (let attempt = 0; attempt < 90; attempt++) {
      if ((await catalogJob())?.status !== "running") throw new Error("Import stopped.");
      try {
        const response = await chrome.tabs.sendMessage(tab.id, { type });
        if (response?.ok) return response.result;
        reason = response?.error || reason;
        if (response?.blocked === true || response?.code === "VERIFICATION_REQUIRED") throw Object.assign(new Error(reason), { verificationRequired: true });
        if (attempt === 0 || attempt % 10 === 0) await saveCatalogJob({ ...job, productTabId: tab.id, currentUrl: url, currentAsin: type === "CAPTURE_CATALOG_PRODUCT" ? job.candidates[job.cursor]?.asin || "" : "", stage: `Waiting for Amazon page (${attempt + 1}/90 seconds): ${reason}` });
      } catch (error) { if (error.verificationRequired || /Import stopped/i.test(error.message)) throw error; }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw Object.assign(new Error(`Amazon page was not readable after 90 seconds: ${reason}`), { catalogPageFailure: true });
  } catch (error) {
    // Only an explicit page-reader signal proves a verification block. Words
    // in a generic loading/help message must not pause the entire queue.
    preserveTab = error.verificationRequired === true;
    if (preserveTab) { await pauseAmazonWork("Amazon verification required for catalog import. Checking the existing tab hourly; manual verification may still be needed.", true, tab.id); error.workloadPause = true; }
    throw error;
  } finally { if (!preserveTab) try { await chrome.tabs.remove(tab.id); } catch { /* Already closed. */ } }
}

async function beginCatalogImport(candidates = [], pages = [], limit = 100, product = null, repair = false, scheduledDiscovery = false) {
  const current = await catalogJob();
  if (current?.status === "running") throw new Error("A catalog import is already running. Stop it before starting another.");
  if ((await runStatuses()).some((run) => run.status === "running" && run.mode === "PRICE")) throw new Error("Finish or stop the live price check before importing products.");
  let adminTab = null;
  if (current?.adminTabId) {
    try { const previous = await chrome.tabs.get(current.adminTabId); if (previous.url === "https://www.sellfinity.app/admin/arbitrage/import") adminTab = previous; } catch { /* Recreate a closed source tab. */ }
  }
  if (!adminTab) adminTab = await chrome.tabs.create({ url: "https://www.sellfinity.app/admin/arbitrage/import", active: false });
  await saveCatalogJob({ status: "running", adminTabId: adminTab.id, candidates, pages, pageCursor: 0, cursor: 0, limit, added: 0, updated: 0, skipped: 0, failed: 0, errors: [], product, repair, scheduledDiscovery, startedAt: Date.now() });
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
    await saveCatalogJob({ ...job, stage: "Connecting to the admin database" });
    await catalogRpc(job.adminTabId, { operation: "filter", asins: [] });
    if (job.repair && !job.prepared) {
      const queue = await catalogRpc(job.adminTabId, { operation: "repairQueue", limit: job.limit });
      job.candidates = queue.candidates; job.prepared = true;
      await saveCatalogJob(job);
    }
    if (job.product) {
      const saved = await catalogRpc(job.adminTabId, { operation: "save", rows: [job.product] });
      await saveCatalogJob({ ...job, status: "complete", added: saved.added, updated: saved.updated || 0, skipped: saved.skipped, product: null });
      return;
    }
    while (job.status === "running" && (job.repair ? job.cursor < job.limit : job.added < job.limit)) {
      if (job.cursor >= job.candidates.length) {
        if (job.pageCursor >= job.pages.length) break;
        const page = job.pages[job.pageCursor];
        let found;
        try { found = await readCatalogPage(page, "CAPTURE_BESTSELLER_PAGE", job); }
        catch (error) {
          if (!error.catalogPageFailure || error.workloadPause) throw error;
          if ((await catalogJob())?.status !== "running") return;
          job.pagesFailed = (job.pagesFailed || 0) + 1;
          await recordCategoryCheck(page, "failed", error.message);
          job.errors = [...job.errors, `Category ${page}: ${error.message}`].slice(-20);
          job.pageCursor++; job.productTabId = null;
          await saveCatalogJob({ ...job, stage: "Category could not be read; continuing to the next page", currentAsin: "", currentUrl: "" });
          continue;
        }
        await recordCategoryCheck(page, "success", "", found.length);
        const seen = new Set(job.candidates.map((row) => row.asin));
        job.candidates.push(...found.filter((row) => !seen.has(row.asin)));
        job.pageCursor++; job.productTabId = null;
        await saveCatalogJob(job);
        continue;
      }
      // Filter a page-sized group before opening product tabs. Existing ASINs
      // never trigger redundant product reads or paid provider requests.
      const next = job.candidates.slice(job.cursor, job.cursor + 50);
      const result = job.repair ? { existing: [] } : await catalogRpc(job.adminTabId, { operation: "filter", asins: next.map((row) => row.asin) });
      const existing = new Set(result.existing);
      for (const candidate of next) {
        if ((await catalogJob())?.status !== "running") return;
        if (job.repair ? job.cursor >= job.limit : job.added >= job.limit) break;
        if (existing.has(candidate.asin)) { job.skipped++; job.cursor++; await saveCatalogJob(job); continue; }
        try {
          const product = await readCatalogPage(candidate.amazonUrl, "CAPTURE_CATALOG_PRODUCT", job);
          // A redirected variant cannot inherit another ASIN's bestseller rank.
          if (product.asin !== candidate.asin) throw new Error("Amazon redirected to a different ASIN. Review this product manually.");
          await saveCatalogJob({ ...job, stage: "Saving product to admin database", currentAsin: candidate.asin });
          const saved = await catalogRpc(job.adminTabId, { operation: "save", rows: [{ ...product, source: "BESTSELLER_BROWSER", bestsellerRank: candidate.bestsellerRank, bestsellerCategory: candidate.bestsellerCategory, bestsellerUrl: candidate.bestsellerUrl }] });
          job.added += saved.added; job.updated = (job.updated || 0) + (saved.updated || 0); job.skipped += saved.skipped;
        } catch (error) {
          if (error.workloadPause || /administrator|Catalog save|Catalog request|Import stopped/i.test(error.message)) throw error;
          job.failed++; job.errors = [...job.errors, `${candidate.asin}: ${error.message}`].slice(-20);
        }
        if ((await catalogJob())?.status !== "running") return;
        job.cursor++; job.productTabId = null;
        await saveCatalogJob({ ...job, stage: "Preparing next product", currentAsin: "", currentUrl: "" });
      }
    }
    if ((await catalogJob())?.status !== "running") return;
    if (job.scheduledDiscovery) await updateDiscovery((settings) => {
      if (!settings || settings.continuous || settings.lastCountedJob === job.startedAt) return settings;
      const day = localDay(new Date());
      return { ...settings, addedDay: day, addedToday: (settings.addedDay === day ? settings.addedToday || 0 : 0) + job.added, lastCountedJob: job.startedAt };
    });
    await saveCatalogJob({ ...job, status: "complete", stage: job.pagesFailed ? `Batch complete · ${job.pagesFailed} category pages could not be read` : "Batch complete", currentAsin: "", currentUrl: "", detail: job.repair ? `${job.cursor} incomplete products checked. Missing content may still need manual review.` : job.added >= job.limit ? "Target reached" : "Selected pages exhausted" });
  } catch (error) {
    const job = await catalogJob();
    if (job?.status === "running") await saveCatalogJob({ ...job, status: error.workloadPause ? "paused" : "error", detail: error.message });
  } finally { catalogWorkerActive = false; }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!["GET_CATALOG_IMPORT_STATUS", "IMPORT_CURRENT_AMAZON", "IMPORT_CURRENT_BESTSELLERS", "STOP_CATALOG_IMPORT", "SAVE_DISCOVERY_SCHEDULE", "RESUME_CATALOG_IMPORT", "SAVE_CONTENT_REPAIR_SCHEDULE", "REPAIR_CATALOG_CONTENT", "START_CONTINUOUS_DISCOVERY"].includes(message?.type)) return;
  void (async () => {
    try {
      if (message.type === "GET_CATALOG_IMPORT_STATUS") {
        sendResponse({ ok: true, job: await catalogJob(), activity: await catalogActivity(), schedule: await discoverySettings(), repairSchedule: (await chrome.storage.local.get(REPAIR_KEY))[REPAIR_KEY] }); return;
      }
      if (message.type === "STOP_CATALOG_IMPORT") {
        await updateDiscovery((settings) => settings?.continuous ? { ...settings, enabled: false, continuous: false } : settings);
        const job = await catalogJob();
        if (job) {
          await saveCatalogJob({ ...job, status: "cancelled" });
          if (job.productTabId) try { await chrome.tabs.remove(job.productTabId); } catch { /* Already closed. */ }
        }
      } else if (message.type === "START_CONTINUOUS_DISCOVERY") {
        const job = await catalogJob();
        if (["running", "paused", "error"].includes(job?.status)) throw new Error("Finish, stop or resume the current import first. Verification pauses cannot be bypassed.");
        // Random order is for category variety, not an anti-detection mechanism.
        const pages = [...DEFAULT_DISCOVERY_PAGES];
        for (let i = pages.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [pages[i], pages[j]] = [pages[j], pages[i]]; }
        await updateDiscovery((saved) => ({ ...saved, checksVersion: 1, pageChecks: saved?.pageChecks || {}, enabled: true, continuous: true, time: "00:00", pages, limit: 1000, lastError: "" }));
        await continueDiscovery();
      } else if (message.type === "RESUME_CATALOG_IMPORT") {
        const job = await catalogJob();
        if (!catalogHasRemaining(job) || job.status === "complete") throw new Error("This batch is finished. Enabled discovery continues automatically at the next opportunity shown above.");
        if ((await workloadState()).paused) throw new Error("Browsing is paused. Check the Amazon tab and use Resume in workload controls first.");
        if (job.status !== "running") { await saveCatalogJob({ ...job, status: "running", detail: "Resuming unfinished import" }, true); void processCatalogImport(); }
      } else if (message.type === "REPAIR_CATALOG_CONTENT") {
        await beginCatalogImport([], [], Math.max(1, Math.min(1000, Number(message.limit) || 100)), null, true);
      } else if (message.type === "SAVE_CONTENT_REPAIR_SCHEDULE") {
        if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(message.time)) throw new Error("Choose a valid time.");
        await chrome.storage.local.set({ [REPAIR_KEY]: { enabled: Boolean(message.enabled), time: message.time, limit: Math.max(1, Math.min(1000, Number(message.limit) || 100)) } });
      } else if (message.type === "SAVE_DISCOVERY_SCHEDULE") {
        const pages = (message.pages || []).filter(Boolean);
        if (!pages.length || pages.length > 20 || pages.some((url) => !validBestsellerUrl(url))) throw new Error("Enter 1–20 Amazon Best Sellers category/page URLs.");
        if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(message.time)) throw new Error("Choose a valid time.");
        await updateDiscovery((saved) => ({ ...saved, checksVersion: 1, pageChecks: saved?.pageChecks || {}, continuous: false, enabled: Boolean(message.enabled), time: message.time, pages, limit: Math.max(1, Math.min(1000, Number(message.limit) || 100)), lastError: "" }));
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
    if (job?.status === "error") return; // Authentication and save errors need review.
    const repair = (await chrome.storage.local.get(REPAIR_KEY))[REPAIR_KEY];
    const localNow = new Date();
    if (repair?.enabled && repair.lastDay !== localDay(localNow)) {
      const [hour, minute] = repair.time.split(":").map(Number);
      if (localNow.getHours() * 60 + localNow.getMinutes() >= hour * 60 + minute) {
        try {
          await beginCatalogImport([], [], repair.limit, null, true);
          await chrome.storage.local.set({ [REPAIR_KEY]: { ...repair, lastDay: localDay(localNow) } });
        } catch { /* Retry when a price check or import finishes. */ }
        return;
      }
    }
    const settings = await discoverySettings();
    if (settings?.continuous) { await continueDiscovery().catch(() => {}); return; }
    const now = new Date();
    if (!settings?.enabled) return;
    const [hours, minutes] = settings.time.split(":").map(Number);
    if (now.getHours() * 60 + now.getMinutes() < hours * 60 + minutes) return;
    const work = await workloadState();
    if ((work.used || 0) >= work.dailyLimit || (work.nextAt || 0) > Date.now()) return;
    const addedToday = settings.addedDay === localDay(now) ? settings.addedToday || 0 : 0;
    const pages = discoveryQueue(settings).map((entry) => entry.page);
    if (addedToday >= settings.limit || !pages.length) return;
    try {
      await beginCatalogImport([], pages, settings.limit - addedToday, null, false, true);
      await updateDiscovery((latest) => latest ? { ...latest, lastError: "" } : latest);
    } catch (error) {
      await updateDiscovery((latest) => latest?.enabled ? { ...latest, lastError: error.message || "Discovery could not start. Check admin sign-in." } : latest);
    }
  })();
});
void chrome.alarms.create("catalog-discovery", { periodInMinutes: 1 });
