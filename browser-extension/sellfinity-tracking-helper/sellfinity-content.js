(() => {
  const TOAST_ID = "sellfinity-tracking-helper-toast";

  function toast(message, tone = "info") {
    document.getElementById(TOAST_ID)?.remove();
    const element = document.createElement("div");
    element.id = TOAST_ID;
    element.textContent = message;
    Object.assign(element.style, {
      position: "fixed",
      right: "20px",
      bottom: "20px",
      zIndex: "2147483647",
      maxWidth: "390px",
      padding: "12px 16px",
      borderRadius: "10px",
      background: tone === "error" ? "#991b1b" : tone === "success" ? "#047857" : "#3730a3",
      color: "white",
      font: "600 13px/1.45 system-ui, sans-serif",
      boxShadow: "0 12px 30px rgba(15, 23, 42, .25)"
    });
    document.documentElement.appendChild(element);
    setTimeout(() => element.remove(), 8_000);
  }

  function setReactInputValue(input, value) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  const saveQueue = [];
  let savingQueue = false;
  let bulkProgress = null;
  let amazonPriceProgress = null;

  function wait(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }

  async function saveQueuedTracking() {
    if (savingQueue) return;
    savingQueue = true;
    while (saveQueue.length) {
      const orderId = saveQueue.shift();
      for (let attempt = 0; attempt < 120; attempt++) {
        const input = document.querySelector(`input[data-order-id="${CSS.escape(orderId)}"]`);
        const row = input?.closest("tr");
        const button = [...(row?.querySelectorAll("button") || [])]
          .find((candidate) => /save tracking|save & mark shipped/i.test(candidate.textContent || ""));
        if (button && !button.disabled) {
          button.click();
          break;
        }
        await wait(500);
      }
      await wait(1000);
    }
    savingQueue = false;
  }

  function queueAutomaticSave(orderId) {
    if (!orderId || saveQueue.includes(orderId)) return;
    saveQueue.push(orderId);
    saveQueuedTracking();
  }

  function bulkTrackingRequests(suppliedRequests = []) {
    const discovered = [...document.querySelectorAll("a")]
      .filter((anchor) => /open amazon tracking/i.test(anchor.textContent || ""))
      .flatMap((anchor) => {
        const input = anchor.closest("tr")?.querySelector('input[aria-label^="Tracking number for "]');
        if (!(input instanceof HTMLInputElement) || !input.dataset.orderId) return [];
        return [{
          orderId: input.dataset.orderId,
          inputLabel: input.getAttribute("aria-label"),
          amazonUrl: anchor.href
        }];
      });
    const supplied = suppliedRequests.flatMap((request) => {
      if (!request?.orderId || !request.amazonUrl) return [];
      const input = document.querySelector(`input[data-order-id="${CSS.escape(request.orderId)}"]`);
      return [{
        orderId: request.orderId,
        inputLabel: input?.getAttribute("aria-label") || null,
        amazonUrl: request.amazonUrl
      }];
    });
    return [...new Map([...supplied, ...discovered].map((request) => [request.orderId, request])).values()];
  }

  function reportBulkProgress(status = "running") {
    if (!bulkProgress) return;
    document.dispatchEvent(new CustomEvent("sellfinity:tracking-helper-progress", { detail: {
      status,
      total: bulkProgress.total,
      processed: bulkProgress.processed,
      found: bulkProgress.found
    } }));
  }

  function finishBulkItem(found) {
    if (!bulkProgress) return;
    bulkProgress.processed = Math.min(bulkProgress.total, bulkProgress.processed + 1);
    if (found) bulkProgress.found += 1;
    reportBulkProgress(bulkProgress.processed >= bulkProgress.total ? "complete" : "running");
  }

  function reportAmazonPriceProgress(status = "running") {
    if (!amazonPriceProgress) return;
    document.dispatchEvent(new CustomEvent("sellfinity:amazon-price-helper-progress", { detail: {
      status,
      total: amazonPriceProgress.total,
      processed: amazonPriceProgress.processed,
      found: amazonPriceProgress.found
    } }));
  }

  function finishAmazonPriceItem(found) {
    if (!amazonPriceProgress) return;
    amazonPriceProgress.processed = Math.min(amazonPriceProgress.total, amazonPriceProgress.processed + 1);
    if (found) amazonPriceProgress.found += 1;
    reportAmazonPriceProgress(amazonPriceProgress.processed >= amazonPriceProgress.total ? "complete" : "running");
  }

  function amazonPriceRequests(suppliedRequests = []) {
    if (Array.isArray(suppliedRequests) && suppliedRequests.length) return suppliedRequests;
    const grouped = new Map();
    for (const anchor of document.querySelectorAll('a[data-amazon-price-check="true"]')) {
      const orderId = anchor.dataset.orderId;
      const requestKey = anchor.dataset.requestKey;
      if (!orderId || !requestKey || !anchor.href) continue;
      const current = grouped.get(requestKey);
      if (current) current.orderIds.push(orderId);
      else grouped.set(requestKey, { requestKey, amazonUrl: anchor.href, orderIds: [orderId] });
    }
    return [...grouped.values()];
  }

  document.addEventListener("sellfinity:bulk-tracking-refresh", (event) => {
    const requests = bulkTrackingRequests(event.detail?.requests || []);
    if (!requests.length) return;
    chrome.runtime.sendMessage({ type: "BEGIN_BULK_TRACKING_REQUEST", requests })
      .then((result) => {
        if (result?.queued) {
          bulkProgress = { total: result.queued, processed: 0, found: 0 };
          reportBulkProgress();
          toast(`Checking ${result.queued} Amazon tracking page${result.queued === 1 ? "" : "s"}…`);
        }
      })
      .catch(() => toast("The tracking helper could not start the automatic check.", "error"));
  });

  document.addEventListener("sellfinity:bulk-amazon-price-check", (event) => {
    const requests = amazonPriceRequests(event.detail?.requests);
    if (!requests.length) return;
    chrome.runtime.sendMessage({ type: "BEGIN_BULK_AMAZON_PRICE_CHECK", requests })
      .then((result) => {
        if (result?.queued) {
          amazonPriceProgress = { total: result.queued, processed: 0, found: 0 };
          reportAmazonPriceProgress();
          toast(`Checking ${result.queued} unique Amazon product${result.queued === 1 ? "" : "s"} for current price and shipping…`);
        }
      })
      .catch(() => toast("The Amazon price checker could not start.", "error"));
  });

  document.addEventListener("click", (event) => {
    const anchor = event.target instanceof Element
      ? event.target.closest("a")
      : null;
    if (!anchor || !/open amazon tracking/i.test(anchor.textContent || "")) return;
    const row = anchor.closest("tr");
    const input = row?.querySelector('input[aria-label^="Tracking number for "]');
    if (!(input instanceof HTMLInputElement)) {
      toast("Sellfinity could not locate this order's tracking field.", "error");
      return;
    }
    const requestId = crypto.randomUUID();
    chrome.runtime.sendMessage({
      type: "BEGIN_TRACKING_REQUEST",
      requestId,
      inputLabel: input.getAttribute("aria-label"),
      orderId: input.dataset.orderId,
      amazonUrl: anchor.href
    }).then(() => toast("Amazon tracking opened. Waiting for a carrier tracking number…"))
      .catch(() => toast("The tracking helper could not start. Reload this page and try again.", "error"));
  }, true);

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "FILL_TRACKING") {
      const inputs = [...document.querySelectorAll('input[aria-label^="Tracking number for "]')];
      const input = message.orderId
        ? document.querySelector(`input[data-order-id="${CSS.escape(message.orderId)}"]`)
        : inputs.find((candidate) => candidate.getAttribute("aria-label") === message.inputLabel);
      if (!(input instanceof HTMLInputElement)) {
        if (message.autoSave) finishBulkItem(false);
        else toast("Tracking was found, but the original fulfillment row is no longer visible.", "error");
        return;
      }
      setReactInputValue(input, message.trackingNumber);
      document.dispatchEvent(new CustomEvent("sellfinity:tracking-filled", { detail: {
        orderId: message.orderId || input.dataset.orderId,
        trackingNumber: message.trackingNumber,
        carrier: message.carrier
      } }));
      if (message.autoSave) queueAutomaticSave(message.orderId || input.dataset.orderId);
      if (message.autoSave) finishBulkItem(true);
      input.scrollIntoView({ behavior: "smooth", block: "center" });
      input.focus();
      input.style.outline = "3px solid #34d399";
      setTimeout(() => { input.style.outline = ""; }, 5_000);
      toast(message.autoSave
        ? `${message.carrier || "Carrier"} tracking ${message.trackingNumber} found and queued to save.`
        : `${message.carrier || "Carrier"} tracking ${message.trackingNumber} filled. Review it, then save.`, "success");
    }
    if (message?.type === "TRACKING_LOOKUP_FAILED") {
      if (message.autoSave) finishBulkItem(false);
      else toast(message.reason || "No supported tracking number was found.", "error");
    }
    if (message?.type === "FILL_AMAZON_PRICE") {
      document.dispatchEvent(new CustomEvent("sellfinity:amazon-price-found", { detail: {
        orderIds: message.orderIds,
        unitPriceCents: message.unitPriceCents,
        shippingCents: message.shippingCents
      } }));
      finishAmazonPriceItem(true);
      const shipping = message.shippingCents === null || message.shippingCents === undefined
        ? "shipping was not shown and was left unchanged"
        : message.shippingCents === 0 ? "free shipping" : `$${(message.shippingCents / 100).toFixed(2)} shipping`;
      toast(`Amazon price $${(message.unitPriceCents / 100).toFixed(2)} found · ${shipping}.`, "success");
    }
    if (message?.type === "AMAZON_PRICE_LOOKUP_FAILED") {
      finishAmazonPriceItem(false);
      toast(message.reason || "Amazon did not show a current price for this product.", "error");
    }
  });
})();
