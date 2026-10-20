import "server-only";
import { asObject, type KeepaObject } from "./catalog";

export async function requestKeepa(path: "category" | "bestsellers" | "product", params: Record<string, string>): Promise<{ status: number; body: KeepaObject }> {
  const key = process.env.KEEPA_API_KEY?.trim();
  if (!key) throw new Error("Keepa is not configured.");
  const url = new URL(`https://api.keepa.com/${path}`);
  url.search = new URLSearchParams({ ...params, domain: "1", key }).toString();
  // No automatic network retries: an interrupted paid request may have succeeded.
  const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(50000) });
  const body = asObject(await response.json());
  return { status: response.status, body };
}
