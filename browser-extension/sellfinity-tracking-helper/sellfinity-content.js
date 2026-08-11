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
      const input = inputs.find((candidate) => candidate.getAttribute("aria-label") === message.inputLabel);
      if (!(input instanceof HTMLInputElement)) {
        toast("Tracking was found, but the original fulfillment row is no longer visible.", "error");
        return;
      }
      setReactInputValue(input, message.trackingNumber);
      document.dispatchEvent(new CustomEvent("sellfinity:tracking-filled", { detail: {
        orderId: message.orderId || input.dataset.orderId,
        trackingNumber: message.trackingNumber,
        carrier: message.carrier
      } }));
      input.scrollIntoView({ behavior: "smooth", block: "center" });
      input.focus();
      input.style.outline = "3px solid #34d399";
      setTimeout(() => { input.style.outline = ""; }, 5_000);
      toast(`${message.carrier || "Carrier"} tracking ${message.trackingNumber} filled. Review it, then click Save & mark shipped.`, "success");
    }
    if (message?.type === "TRACKING_LOOKUP_FAILED") {
      toast(message.reason || "No supported tracking number was found.", "error");
    }
  });
})();
