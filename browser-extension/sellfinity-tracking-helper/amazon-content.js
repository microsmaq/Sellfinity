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
})();
