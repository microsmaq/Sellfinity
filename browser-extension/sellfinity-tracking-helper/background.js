const PENDING_KEY = "pendingTrackingRequests";
const MAX_REQUEST_AGE_MS = 10 * 60 * 1000;
const MAX_BULK_TABS = 4;

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
  const requests = await pendingRequests();
  const active = requests.filter((request) => request.bulk && request.sourceTabId === sourceTabId && request.destinationTabId !== null);
  const waiting = requests.filter((request) => request.bulk && request.sourceTabId === sourceTabId && request.destinationTabId === null);
  const available = Math.max(0, MAX_BULK_TABS - active.length);
  for (const request of waiting.slice(0, available)) {
    try {
      const tab = await chrome.tabs.create({ url: request.amazonUrl, active: false });
      request.destinationTabId = tab.id || null;
    } catch {
      await notifySource(request, { type: "TRACKING_LOOKUP_FAILED", reason: "Amazon tracking could not be opened." });
      const index = requests.findIndex((candidate) => candidate.requestId === request.requestId);
      if (index >= 0) requests.splice(index, 1);
    }
  }
  await savePending(requests);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
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
          createdAt: Date.now()
        });
      }
      await savePending(requests);
      await processBulkQueue(sender.tab.id);
      sendResponse({ ok: true, queued: requests.filter((request) => request.bulk && request.sourceTabId === sender.tab.id).length });
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

      await notifySource(matching, message.type === "TRACKING_FOUND"
        ? { type: "FILL_TRACKING", trackingNumber: message.trackingNumber, carrier: message.carrier, autoSave: !!matching.bulk }
        : { type: "TRACKING_LOOKUP_FAILED", reason: message.reason, autoSave: !!matching.bulk });
      await savePending(requests.filter((request) => request.requestId !== matching.requestId));
      if (matching.bulk) {
        try { await chrome.tabs.remove(sender.tab.id); } catch { /* The tracking tab may already be closed. */ }
        await processBulkQueue(matching.sourceTabId);
      }
      sendResponse({ ok: true });
    })();
    return true;
  }
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
