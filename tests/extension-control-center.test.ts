import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function extensionFile(name: string) {
  return readFileSync(resolve(process.cwd(), "browser-extension/sellfinity-tracking-helper", name), "utf8");
}

describe("Chrome helper control center", () => {
  it("exposes live run status and cancellation controls", () => {
    const background = extensionFile("background.js");
    const popup = extensionFile("popup.js");

    expect(background).toContain('message?.type === "GET_HELPER_STATUS"');
    expect(background).toContain('message?.type === "CANCEL_BULK_REQUESTS"');
    expect(popup).toContain('stop("PRICE")');
    expect(popup).toContain('stop("TRACKING")');
  });

  it("waits for an Amazon URL instead of inspecting the temporary blank tab", () => {
    const background = extensionFile("background.js");

    expect(background).toContain('pageUrl.hostname.endsWith(".amazon.com")');
    expect(background).toContain('chrome.tabs.create({ url: "about:blank"');
    expect(background).toContain("for (let attempt = 0; attempt < 12; attempt++)");
  });

  it("acknowledges price scans before waiting for the background queue", () => {
    const content = extensionFile("sellfinity-content.js");
    const immediateProgress = content.indexOf("reportAmazonPriceProgress();");
    const backgroundRequest = content.indexOf('chrome.runtime.sendMessage({ type: "BEGIN_BULK_AMAZON_PRICE_CHECK"');

    expect(immediateProgress).toBeGreaterThan(-1);
    expect(immediateProgress).toBeLessThan(backgroundRequest);
  });

  it("ships the popup script in helper version 1.6.7", () => {
    const manifest = JSON.parse(extensionFile("manifest.json")) as { version: string };
    const popup = extensionFile("popup.html");

    expect(manifest.version).toBe("1.6.7");
    expect(popup).toContain('<script src="popup.js"></script>');
  });

  it("retries tracking extraction after the Amazon page and request association are ready", () => {
    const background = extensionFile("background.js");
    const amazonContent = extensionFile("amazon-content.js");

    expect(background).toContain('type: "INSPECT_AMAZON_TRACKING"');
    expect(amazonContent).toContain('message?.type === "INSPECT_AMAZON_TRACKING"');
    expect(amazonContent).toContain("if (!response?.ok) return;");
  });

  it("keeps multi-thousand-product price runs alive beyond 45 minutes", () => {
    const background = extensionFile("background.js");
    expect(background).toContain("7 * 24 * 60 * 60 * 1000");
    expect(background).toContain("status.updatedAt = Date.now()");
  });

  it("runs on Admin Product Intelligence", () => {
    const manifest = extensionFile("manifest.json");
    expect(manifest).toContain("https://www.sellfinity.app/admin/arbitrage*");
  });
});
