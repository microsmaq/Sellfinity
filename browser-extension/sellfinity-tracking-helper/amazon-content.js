(() => {
  let finished = false;
  let observer;
  let timer;

  function visibleContent() {
    return document.body?.innerText || document.documentElement?.innerText || "";
  }

  function finish(message) {
    if (finished) return;
    finished = true;
    observer?.disconnect();
    if (timer) clearTimeout(timer);
    chrome.runtime.sendMessage(message).catch(() => {});
  }

  function inspect() {
    const tracking = globalThis.sellfinityTrackingFromPage(location.href, visibleContent());
    if (tracking) finish({ type: "TRACKING_FOUND", ...tracking });
  }

  inspect();
  if (finished) return;
  observer = new MutationObserver(inspect);
  observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true });
  timer = setTimeout(() => finish({
    type: "TRACKING_NOT_FOUND",
    reason: "No supported carrier tracking number appeared on the tracking page. Confirm that Amazon is signed in and the carrier number is available."
  }), 45_000);

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
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
      const result = globalThis.sellfinityAmazonPriceFromPage?.(document);
      if (result) finishPrice({ type: "AMAZON_PRICE_FOUND", ...result });
    };
    inspectPrice();
    if (!priceFinished) {
      priceObserver = new MutationObserver(inspectPrice);
      priceObserver.observe(document.documentElement, { subtree: true, childList: true, characterData: true });
      priceTimer = setTimeout(() => finishPrice({
        type: "AMAZON_PRICE_NOT_FOUND",
        reason: "Amazon did not show a current purchasable price. Confirm the product is available and Amazon is signed in."
      }), 30_000);
    }
    sendResponse({ ok: true });
    return true;
  });
})();
