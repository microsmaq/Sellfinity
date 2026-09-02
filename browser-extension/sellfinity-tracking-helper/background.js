const PENDING_KEY = "pendingTrackingRequests";
const STATUS_KEY = "bulkRunStatuses";
const MAX_REQUEST_AGE_MS = 45 * 60 * 1000;
const MAX_BULK_TABS = 4;

async function runStatuses() {
  const stored = await chrome.storage.session.get(STATUS_KEY);
  const now = Date.now();
  return (stored[STATUS_KEY] || []).filter((status) => now - status.startedAt < MAX_REQUEST_AGE_MS);
}

async function saveRunStatuses(statuses) {
  await chrome.storage.session.set({ [STATUS_KEY]: statuses });
}

function requestMode(request) {
  return request.mode === "PRICE" ? "PRICE" : "TRACKING";
}

async function startRun(sourceTabId, mode, total) {
  const statuses = (await runStatuses()).filter((status) => !(status.sourceTabId === sourceTabId && status.mode === mode));
  statuses.push({ sourceTabId, mode, total, completed: 0, found: 0, errors: 0, status: "running", startedAt: Date.now() });
  await saveRunStatuses(statuses);
}

async function advanceRun(sourceTabId, mode, found) {
  const statuses = await runStatuses();
  const status = statuses.find((candidate) => candidate.sourceTabId === sourceTabId && candidate.mode === mode);
  if (!status || status.status !== "running") return;
  status.completed = Math.min(status.total, status.completed + 1);
  if (found) status.found += 1;
  else status.errors += 1;
  if (status.completed >= status.total) status.status = "complete";
  await saveRunStatuses(statuses);
}

async function cancelRuns(sourceTabId, mode) {
  const requests = await pendingRequests();
  const cancelled = requests.filter((request) => request.bulk && (!sourceTabId || request.sourceTabId === sourceTabId) && (!mode || requestMode(request) === mode));
  const cancelledIds = new Set(cancelled.map((request) => request.requestId));
  await savePending(requests.filter((request) => !cancelledIds.has(request.requestId)));
  const tabIds = [...new Set(cancelled.map((request) => request.destinationTabId).filter(Boolean))];
  if (tabIds.length) {
    try { await chrome.tabs.remove(tabIds); } catch { /* Some helper tabs may already be closed. */ }
  }
  const statuses = await runStatuses();
  for (const status of statuses) {
    if ((!sourceTabId || status.sourceTabId === sourceTabId) && (!mode || status.mode === mode) && status.status === "running") {
      status.status = "cancelled";
    }
  }
  await saveRunStatuses(statuses);
  for (const tabId of new Set(cancelled.map((request) => request.sourceTabId))) {
    try { await chrome.tabs.sendMessage(tabId, { type: "BULK_RUN_CANCELLED", mode }); } catch { /* The Sellfinity tab may have closed. */ }
  }
  return cancelled.length;
}

async function pendingRequests() {
  const stored = await chrome.storage.session.get(PENDING_KEY);
  const now = Date.now();
  return (stored[PENDING_KEY] || []).filter((request) => now - request.createdAt < MAX_REQUEST_AGE_MS);
}

async function savePending(requests) {
  await chrome.storage.session.set({ [PENDING_KEY]: requests });
}

async function notifySource(request, message) {
  try {
    await chrome.tabs.sendMessage(request.sourceTabId, {
      ...message,
      inputLabel: request.inputLabel,
      orderId: request.orderId,
      requestId: request.requestId
    });
    await chrome.tabs.update(request.sourceTabId, { active: true });
  } catch {
    // The originating Sellfinity tab may have been closed or reloaded.
  }
}

async function processBulkQueue(sourceTabId) {
  const initialRequests = await pendingRequests();
  const active = initialRequests.filter((request) => request.bulk && request.sourceTabId === sourceTabId && request.destinationTabId !== null);
  const waiting = initialRequests.filter((request) => request.bulk && request.sourceTabId === sourceTabId && request.destinationTabId === null);
  const available = Math.max(0, MAX_BULK_TABS - active.length);
  for (const request of waiting.slice(0, available)) {
    let openedTabId = null;
    try {
      // Register the destination before loading Amazon. A fast cached page can
      // report tracking immediately; previously that response raced the final
      // storage write and was discarded because its tab was still unknown.
      const tab = await chrome.tabs.create({ url: "about:blank", active: false });
      openedTabId = tab.id || null;
      const latest = await pendingRequests();
      const liveRequest = latest.find((candidate) => candidate.requestId === request.requestId);
      // Stop can be clicked while this tab is being created. Do not restore a
      // cancelled request or continue its Amazon navigation.
      if (!liveRequest) {
        if (openedTabId) await chrome.tabs.remove(openedTabId);
        continue;
      }
      liveRequest.destinationTabId = openedTabId;
      await savePending(latest);
      if (tab.id) await chrome.tabs.update(tab.id, { url: request.amazonUrl });
    } catch {
      const isPrice = requestMode(request) === "PRICE";
      await notifySource(request, isPrice
        ? { type: "AMAZON_PRICE_LOOKUP_FAILED", reason: "The Amazon product page could not be opened.", orderIds: request.orderIds }
        : { type: "TRACKING_LOOKUP_FAILED", reason: "Amazon tracking could not be opened." });
      await advanceRun(request.sourceTabId, requestMode(request), false);
      const latest = await pendingRequests();
      await savePending(latest.filter((candidate) => candidate.requestId !== request.requestId));
      if (openedTabId) {
        try { await chrome.tabs.remove(openedTabId); } catch { /* The helper tab may already be closed. */ }
      }
    }
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "GET_HELPER_STATUS") {
    (async () => {
      const requests = await pendingRequests();
      const statuses = await runStatuses();
      sendResponse({
        ok: true,
        statuses: statuses.sort((left, right) => right.startedAt - left.startedAt),
        remaining: {
          PRICE: requests.filter((request) => request.bulk && requestMode(request) === "PRICE").length,
          TRACKING: requests.filter((request) => request.bulk && requestMode(request) === "TRACKING").length
        },
        open: {
          PRICE: requests.filter((request) => request.bulk && requestMode(request) === "PRICE" && request.destinationTabId !== null).length,
          TRACKING: requests.filter((request) => request.bulk && requestMode(request) === "TRACKING" && request.destinationTabId !== null).length
        }
      });
    })();
    return true;
  }

  if (message?.type === "CANCEL_BULK_REQUESTS") {
    (async () => {
      const mode = ["PRICE", "TRACKING"].includes(message.mode) ? message.mode : null;
      const cancelled = await cancelRuns(sender.tab?.id || null, mode);
      sendResponse({ ok: true, cancelled });
    })();
    return true;
  }

  if (message?.type === "BEGIN_TRACKING_REQUEST" && sender.tab?.id) {
    (async () => {
      const requests = await pendingRequests();
      requests.push({
        requestId: message.requestId,
        sourceTabId: sender.tab.id,
        inputLabel: message.inputLabel,
        orderId: message.orderId,
        amazonUrl: message.amazonUrl,
        destinationTabId: null,
        createdAt: Date.now()
      });
      await savePending(requests);
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (message?.type === "BEGIN_BULK_TRACKING_REQUEST" && sender.tab?.id) {
    (async () => {
      const requests = await pendingRequests();
      const existingOrderIds = new Set(requests.map((request) => request.orderId));
      for (const item of message.requests || []) {
        if (!item.orderId || !item.amazonUrl || existingOrderIds.has(item.orderId)) continue;
        requests.push({
          requestId: crypto.randomUUID(),
          sourceTabId: sender.tab.id,
          inputLabel: item.inputLabel,
          orderId: item.orderId,
          amazonUrl: item.amazonUrl,
          destinationTabId: null,
          bulk: true,
          mode: "TRACKING",
          createdAt: Date.now()
        });
      }
      await savePending(requests);
      const queued = requests.filter((request) => request.bulk && request.mode !== "PRICE" && request.sourceTabId === sender.tab.id).length;
      await startRun(sender.tab.id, "TRACKING", queued);
      sendResponse({ ok: true, queued });
      await processBulkQueue(sender.tab.id);
    })();
    return true;
  }

  if (message?.type === "BEGIN_BULK_AMAZON_PRICE_CHECK" && sender.tab?.id) {
    (async () => {
      const requests = await pendingRequests();
      const existingKeys = new Set(requests.filter((request) => request.mode === "PRICE").map((request) => request.requestKey));
      for (const item of message.requests || []) {
        let url;
        try { url = new URL(item.amazonUrl); } catch { continue; }
        const isAmazon = url.protocol === "https:" && (url.hostname === "amazon.com" || url.hostname.endsWith(".amazon.com"));
        if (!isAmazon || !item.requestKey || !item.orderIds?.length || existingKeys.has(item.requestKey)) continue;
        requests.push({
          requestId: crypto.randomUUID(),
          requestKey: item.requestKey,
          sourceTabId: sender.tab.id,
          orderIds: item.orderIds,
          amazonUrl: item.amazonUrl,
          destinationTabId: null,
          bulk: true,
          mode: "PRICE",
          createdAt: Date.now()
        });
      }
      await savePending(requests);
      const queued = requests.filter((request) => request.bulk && request.mode === "PRICE" && request.sourceTabId === sender.tab.id).length;
      await startRun(sender.tab.id, "PRICE", queued);
      sendResponse({ ok: true, queued });
      await processBulkQueue(sender.tab.id);
    })();
    return true;
  }

  if ((message?.type === "TRACKING_FOUND" || message?.type === "TRACKING_NOT_FOUND") && sender.tab?.id) {
    (async () => {
      const requests = await pendingRequests();
      const openerId = sender.tab?.openerTabId;
      const matching = requests
        .filter((request) => request.destinationTabId === sender.tab.id || (openerId && request.sourceTabId === openerId))
        .sort((left, right) => right.createdAt - left.createdAt)[0];
      if (!matching) return sendResponse({ ok: false });
      if (matching.mode === "PRICE") return sendResponse({ ok: false });

      await notifySource(matching, message.type === "TRACKING_FOUND"
        ? { type: "FILL_TRACKING", trackingNumber: message.trackingNumber, carrier: message.carrier, autoSave: !!matching.bulk }
        : { type: "TRACKING_LOOKUP_FAILED", reason: message.reason, autoSave: !!matching.bulk });
      if (matching.bulk) await advanceRun(matching.sourceTabId, "TRACKING", message.type === "TRACKING_FOUND");
      await savePending(requests.filter((request) => request.requestId !== matching.requestId));
      if (matching.bulk) {
        try { await chrome.tabs.remove(sender.tab.id); } catch { /* The tracking tab may already be closed. */ }
        await processBulkQueue(matching.sourceTabId);
      }
      sendResponse({ ok: true });
    })();
    return true;
  }

  if ((message?.type === "AMAZON_PRICE_FOUND" || message?.type === "AMAZON_PRICE_NOT_FOUND") && sender.tab?.id) {
    (async () => {
      const requests = await pendingRequests();
      const matching = requests
        .filter((request) => request.mode === "PRICE" && request.destinationTabId === sender.tab.id)
        .sort((left, right) => right.createdAt - left.createdAt)[0];
      if (!matching) return sendResponse({ ok: false });
      await notifySource(matching, message.type === "AMAZON_PRICE_FOUND"
        ? { type: "FILL_AMAZON_PRICE", unitPriceCents: message.unitPriceCents, shippingCents: message.shippingCents, orderIds: matching.orderIds }
        : { type: "AMAZON_PRICE_LOOKUP_FAILED", reason: message.reason, orderIds: matching.orderIds });
      await advanceRun(matching.sourceTabId, "PRICE", message.type === "AMAZON_PRICE_FOUND");
      await savePending(requests.filter((request) => request.requestId !== matching.requestId));
      try { await chrome.tabs.remove(sender.tab.id); } catch { /* The product tab may already be closed. */ }
      await processBulkQueue(matching.sourceTabId);
      sendResponse({ ok: true });
    })();
    return true;
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete") return;
  (async () => {
    const requests = await pendingRequests();
    const request = requests.find((candidate) => candidate.mode === "PRICE" && candidate.destinationTabId === tabId);
    if (!request) return;
    // chrome.tabs.create("about:blank") can emit a completed event after the
    // request is registered but before navigation reaches Amazon. Never treat
    // that temporary page as a failed Amazon read.
    let pageUrl;
    try { pageUrl = new URL(tab.url || changeInfo.url || ""); } catch { return; }
    if (!(pageUrl.protocol === "https:" && (pageUrl.hostname === "amazon.com" || pageUrl.hostname.endsWith(".amazon.com")))) return;
    for (let attempt = 0; attempt < 12; attempt++) {
      try {
        await chrome.tabs.sendMessage(tabId, { type: "INSPECT_AMAZON_PRICE" });
        return;
      } catch {
        // document_idle content scripts can start just after the completed
        // navigation event. Retry briefly instead of dropping the check.
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    const latest = await pendingRequests();
    const failed = latest.find((candidate) => candidate.mode === "PRICE" && candidate.destinationTabId === tabId);
    if (!failed) return;
    await notifySource(failed, {
      type: "AMAZON_PRICE_LOOKUP_FAILED",
      reason: "Amazon opened, but its page reader did not start. Check for an Amazon sign-in or CAPTCHA page, then retry.",
      orderIds: failed.orderIds
    });
    await advanceRun(failed.sourceTabId, "PRICE", false);
    await savePending(latest.filter((candidate) => candidate.requestId !== failed.requestId));
    try { await chrome.tabs.remove(tabId); } catch { /* The product tab may already be closed. */ }
    await processBulkQueue(failed.sourceTabId);
  })();
});

chrome.tabs.onCreated.addListener((tab) => {
  if (!tab.id || !tab.openerTabId) return;
  (async () => {
    const requests = await pendingRequests();
    const request = requests
      .filter((candidate) => candidate.sourceTabId === tab.openerTabId && candidate.destinationTabId === null)
      .sort((left, right) => right.createdAt - left.createdAt)[0];
    if (!request) return;
    request.destinationTabId = tab.id;
    await savePending(requests);
  })();
});
