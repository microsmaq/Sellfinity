import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

function popup(rejectSave = false) {
  const elements = new Map<string, { value: string; min: string; max: string; textContent: string; disabled: boolean; focus: () => void; addEventListener: (_type: string, fn: () => Promise<void>) => void }>();
  let click!: () => Promise<void>;
  for (const [id, value, min, max] of [["interval", "60", "30", "3600"], ["limit", "100", "1", "1000"], ["batch", "20", "1", "100"], ["break", "15", "1", "240"], ["feedback", "", "", ""]]) elements.set(`work-${id}`, { value, min, max, textContent: "", disabled: false, focus: vi.fn(), addEventListener: () => {} });
  elements.set("save-work", { value: "", min: "", max: "", textContent: "Save workload limits", disabled: false, focus: vi.fn(), addEventListener: (_type, fn) => { click = fn; } });
  const send = vi.fn(async () => { if (rejectSave) throw new Error("No worker"); return { ok: true }; });
  const source = readFileSync("browser-extension/sellfinity-tracking-helper/popup.js", "utf8");
  runInNewContext(source.slice(source.indexOf('document.getElementById("save-work").addEventListener'), source.indexOf('document.getElementById("pause-work").addEventListener')), { document: { getElementById: (id: string) => elements.get(id) }, chrome: { runtime: { sendMessage: send } } });
  return { elements, click: () => click(), send };
}
describe("workload settings popup", () => {
  it("saves valid limits and restores the button", async () => {
    const p = popup(); await p.click();
    expect(p.send).toHaveBeenCalledWith({ type: "SAVE_WORKLOAD_SETTINGS", settings: { intervalSeconds: 60, dailyLimit: 100, batchSize: 20, breakMinutes: 15 } });
    expect(p.elements.get("work-feedback")?.textContent).toContain("saved");
    expect(p.elements.get("save-work")?.disabled).toBe(false);
  });
  it("identifies an invalid field without sending a save", async () => {
    const p = popup(); p.elements.get("work-limit")!.value = "2000"; await p.click();
    expect(p.send).not.toHaveBeenCalled();
    expect(p.elements.get("work-feedback")?.textContent).toContain("Maximum pages per day: enter a whole number from 1 to 1000");
  });
  it("handles an unavailable worker without leaving save disabled", async () => {
    const p = popup(true); await p.click();
    expect(p.elements.get("work-feedback")?.textContent).toContain("Reload the extension");
    expect(p.elements.get("save-work")?.disabled).toBe(false);
  });
});
