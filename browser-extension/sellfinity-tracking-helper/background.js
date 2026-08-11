const PENDING_KEY = "pendingTrackingRequests";
const MAX_REQUEST_AGE_MS = 10 * 60 * 1000;

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

  if ((message?.type === "TRACKING_FOUND" || message?.type === "TRACKING_NOT_FOUND") && sender.tab?.id) {
    (async () => {
      const requests = await pendingRequests();
      const openerId = sender.tab?.openerTabId;
      const matching = requests
        .filter((request) => request.destinationTabId === sender.tab.id || (openerId && request.sourceTabId === openerId))
        .sort((left, right) => right.createdAt - left.createdAt)[0];
      if (!matching) return sendResponse({ ok: false });

      await notifySource(matching, message.type === "TRACKING_FOUND"
        ? { type: "FILL_TRACKING", trackingNumber: message.trackingNumber, carrier: message.carrier }
        : { type: "TRACKING_LOOKUP_FAILED", reason: message.reason });
      await savePending(requests.filter((request) => request.requestId !== matching.requestId));
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
