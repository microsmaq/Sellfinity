import { EBAY_TITLE_MAX } from "@/lib/listings/generate";
import type { ScrapedProduct } from "./scraper";

export type ImprovedListingContent = {
  title: string;
  bulletPoints: string[];
  description: string;
};

export type ListingContentImprovement =
  | { ok: true; content: ImprovedListingContent }
  | { ok: false; error: string };

function responseText(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const data = payload as {
    output_text?: unknown;
    output?: Array<{ content?: Array<{ text?: unknown }> }>;
    choices?: Array<{ message?: { content?: unknown } }>;
  };
  if (typeof data.output_text === "string") return data.output_text;
  const responseParts = data.output
    ?.flatMap((item) => item.content ?? [])
    .map((part) => part.text)
    .filter((part): part is string => typeof part === "string");
  if (responseParts?.length) return responseParts.join("");
  const chat = data.choices?.[0]?.message?.content;
  return typeof chat === "string" ? chat : null;
}

function cleanText(value: unknown, max: number): string {
  return typeof value === "string"
    ? value.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim().slice(0, max)
    : "";
}

function parseContent(text: string): ImprovedListingContent | null {
  try {
    const parsed = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? "") as {
      title?: unknown;
      bulletPoints?: unknown;
      description?: unknown;
    };
    const title = cleanText(parsed.title, EBAY_TITLE_MAX);
    const bulletPoints = Array.isArray(parsed.bulletPoints)
      ? parsed.bulletPoints.map((item) => cleanText(item, 260)).filter(Boolean).slice(0, 8)
      : [];
    const description = cleanText(parsed.description, 1200);
    if (!title || bulletPoints.length === 0) return null;
    return { title, bulletPoints, description };
  } catch {
    return null;
  }
}

/** Improve copy only from verified supplier facts. The caller always renders
 * this result through Sellfinity's existing HTML template. */
export async function improveListingContent(
  source: Pick<ScrapedProduct, "title" | "brand" | "bulletPoints" | "description" | "category">,
): Promise<ListingContentImprovement> {
  const openRouterKey = process.env.OPENROUTER_API_KEY?.trim();
  const openAiKey = process.env.OPENAI_API_KEY?.trim();
  const apiKey = openRouterKey || openAiKey;
  if (!apiKey) return { ok: false, error: "No AI text provider is configured." };

  const prompt = [
    "You are an expert eBay SEO copywriter. Return JSON only.",
    "Rewrite this exact Amazon product into truthful, high-converting eBay copy.",
    "Never invent or alter brand, model, size, color, quantity, material, compatibility, accessories, specifications, condition, or claims.",
    "Do not mention Amazon, suppliers, dropshipping, guarantees, shipping, returns, price, badges, or HTML.",
    "Title: natural keyword order, no keyword spam, no all-caps, maximum 80 characters.",
    "bulletPoints: 3 to 8 concise factual buyer benefits. description: concise factual summary.",
    "Use exactly this JSON shape: {\"title\":string,\"bulletPoints\":string[],\"description\":string}.",
    `Source title: ${source.title.slice(0, 800)}`,
    `Brand: ${(source.brand || "Not provided").slice(0, 200)}`,
    `Category: ${(source.category || "Not provided").slice(0, 200)}`,
    `Source bullets: ${(source.bulletPoints.join(" | ") || "Not provided").slice(0, 3500)}`,
    `Source description: ${(source.description || "Not provided").slice(0, 4000)}`,
  ].join("\n");

  try {
    const isOpenRouter = !!openRouterKey;
    const response = await fetch(
      isOpenRouter
        ? "https://openrouter.ai/api/v1/chat/completions"
        : "https://api.openai.com/v1/responses",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          ...(isOpenRouter && {
            "HTTP-Referer": "https://www.sellfinity.app",
            "X-OpenRouter-Title": "Sellfinity",
          }),
        },
        body: JSON.stringify(
          isOpenRouter
            ? {
                model: process.env.OPENROUTER_TEXT_MODEL || "google/gemini-2.5-flash-lite",
                messages: [{ role: "user", content: prompt }],
                response_format: { type: "json_object" },
                temperature: 0.2,
                max_tokens: 700,
              }
            : {
                model: process.env.OPENAI_TEXT_MODEL || "gpt-5-mini",
                input: prompt,
                text: {
                  format: {
                    type: "json_schema",
                    name: "ebay_listing_copy",
                    strict: true,
                    schema: {
                      type: "object",
                      additionalProperties: false,
                      required: ["title", "bulletPoints", "description"],
                      properties: {
                        title: { type: "string" },
                        bulletPoints: {
                          type: "array",
                          minItems: 3,
                          maxItems: 8,
                          items: { type: "string" },
                        },
                        description: { type: "string" },
                      },
                    },
                  },
                },
                max_output_tokens: 700,
              },
        ),
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (!response.ok) {
      return { ok: false, error: `AI copy request failed (${response.status}).` };
    }
    const text = responseText(await response.json());
    const content = text ? parseContent(text) : null;
    return content
      ? { ok: true, content }
      : { ok: false, error: "AI returned unusable listing copy." };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message.slice(0, 180) : "AI copy request failed.",
    };
  }
}
