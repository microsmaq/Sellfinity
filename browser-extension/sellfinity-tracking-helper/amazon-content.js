(() => {
  let finished = false;
  let sending = false;
  let observer;
  let timer;

  function visibleContent() {
    return document.body?.innerText || document.documentElement?.innerText || "";
  }

  async function finish(message) {
    if (finished || sending) return;
    sending = true;
    try {
      // A fast Amazon page can report before its request/tab association is
      // ready. Only stop observing after the background worker confirms that
      // it delivered the result to the originating Sellfinity tab.
      const response = await chrome.runtime.sendMessage(message);
      if (!response?.ok) return;
      finished = true;
      observer?.disconnect();
      if (timer) clearTimeout(timer);
    } catch {
      // Keep the reader alive so an explicit post-navigation inspection can
      // retry after a service-worker restart or request-association race.
    } finally {
      sending = false;
    }
  }

  function inspect() {
    if (globalThis.sellfinityAmazonAvailabilityFromPage?.(document) === "BLOCKED") { void finish({ type: "TRACKING_NOT_FOUND", blocked: true, reason: "Amazon verification required." }); return; }
    const tracking = globalThis.sellfinityTrackingFromPage(location.href, visibleContent());
    if (tracking) void finish({ type: "TRACKING_FOUND", ...tracking });
  }

  inspect();
  if (finished) return;
  observer = new MutationObserver(inspect);
  observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true });
  timer = setTimeout(() => void finish({
    type: "TRACKING_NOT_FOUND",
    reason: "No supported carrier tracking number appeared on the tracking page. Confirm that Amazon is signed in and the carrier number is available."
  }), 45_000);

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "CHECK_AMAZON_VERIFICATION") {
      const availability = globalThis.sellfinityAmazonAvailabilityFromPage?.(document);
      const readable = availability !== "BLOCKED" && document.readyState === "complete" && Boolean(
        globalThis.sellfinityAmazonPriceFromPage?.(document) ||
        globalThis.sellfinityTrackingFromPage(location.href, visibleContent()) ||
        availability === "UNAVAILABLE" ||
        (/\/zgbs|\/Best-Sellers/i.test(location.pathname) && document.querySelector('a[href*="/dp/"]'))
      );
      sendResponse({ readable });
      return;
    }
    if (message?.type === "INSPECT_AMAZON_TRACKING") {
      if (finished) {
        finished = false;
        observer?.observe(document.documentElement, { subtree: true, childList: true, characterData: true });
        timer = setTimeout(() => void finish({ type: "TRACKING_NOT_FOUND", reason: "No supported carrier tracking number appeared after resuming." }), 45_000);
      }
      inspect();
      sendResponse({ ok: true });
      return true;
    }
    if (message?.type !== "INSPECT_AMAZON_PRICE") return;
    let priceFinished = false;
    let priceObserver;
    let priceTimer;
    const finishPrice = (result) => {
      if (priceFinished) return;
      priceFinished = true;
      priceObserver?.disconnect();
      if (priceTimer) clearTimeout(priceTimer);
      chrome.runtime.sendMessage(result).catch(() => {});
    };
    const inspectPrice = () => {
      if (globalThis.sellfinityAmazonAvailabilityFromPage?.(document) === "BLOCKED") { finishPrice({ type: "AMAZON_PRICE_NOT_FOUND", blocked: true, unavailable: false, reason: "Amazon verification required." }); return; }
      const result = globalThis.sellfinityAmazonPriceFromPage?.(document);
      if (result) finishPrice({ type: "AMAZON_PRICE_FOUND", ...result });
    };
    inspectPrice();
    if (!priceFinished) {
      priceObserver = new MutationObserver(inspectPrice);
      priceObserver.observe(document.documentElement, { subtree: true, childList: true, characterData: true });
      priceTimer = setTimeout(() => {
        const availability = globalThis.sellfinityAmazonAvailabilityFromPage?.(document) || "UNKNOWN";
        finishPrice({
          type: "AMAZON_PRICE_NOT_FOUND",
          unavailable: availability === "UNAVAILABLE",
          blocked: availability === "BLOCKED",
          reason: availability === "UNAVAILABLE"
            ? "Amazon confirms that this product is unavailable or no longer has a product page."
            : availability === "BLOCKED"
              ? "Amazon requires sign-in or CAPTCHA verification, so availability was not changed."
              : "Amazon did not show a current purchasable price. Availability could not be confirmed."
        });
      }, 30_000);
    }
    sendResponse({ ok: true });
    return true;
  });
})();
