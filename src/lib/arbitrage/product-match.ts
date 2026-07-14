import { titleTokens } from "@/lib/mirror/match";

export type ProductMatchVerdict = "MATCH" | "LIKELY" | "REVIEW" | "REJECTED";
export type ProductMatchMethod = "RULES" | "AI";

export type ProductMatchAssessment = {
  verdict: ProductMatchVerdict;
  confidence: number;
  reason: string;
  method: ProductMatchMethod;
};

type ProductIdentity = {
  title: string;
  imageUrl?: string | null;
};

const MODEL_TOKEN = /\b(?=[a-z0-9-]*[a-z])(?=[a-z0-9-]*\d)[a-z0-9]+(?:-[a-z0-9]+)*\b/gi;
const QUANTITY = /\b(\d+)\s*(?:pack|pk|count|ct|pcs?|pieces?|units?)\b/i;
const MEASUREMENT = /\b(\d+(?:\.\d+)?)\s*(inches?|inch|in|feet|foot|ft|cm|mm|oz|ounces?|lb|lbs|pounds?|qt|quarts?|gal|gallons?|ml|liters?|litres?|w|watts?)\b/gi;

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.toLowerCase()))];
}

function modelTokens(title: string): string[] {
  return unique(title.match(MODEL_TOKEN) ?? []).filter((token) => token.length >= 4);
}

function quantity(title: string): number | null {
  const match = title.match(QUANTITY);
  return match ? Number(match[1]) : null;
}

function measurements(title: string): string[] {
  const matches = [...title.matchAll(MEASUREMENT)];
  return unique(matches.map((match) => `${match[1]}${match[2].toLowerCase()}`));
}

/** Strict, explainable product-identity gate used even when no AI key exists. */
export function assessProductMatchRules(
  ebayTitle: string,
  amazonTitle: string,
): ProductMatchAssessment {
  const ebay = unique(titleTokens(ebayTitle));
  const amazon = unique(titleTokens(amazonTitle));
  const amazonSet = new Set(amazon);
  const shared = ebay.filter((token) => amazonSet.has(token));
  const precision = shared.length / Math.max(1, amazon.length);
  const recall = shared.length / Math.max(1, ebay.length);
  const similarity =
    precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);

  const ebayModels = modelTokens(ebayTitle);
  const amazonModels = modelTokens(amazonTitle);
  if (
    ebayModels.length > 0 &&
    amazonModels.length > 0 &&
    !ebayModels.some((model) => amazonModels.includes(model))
  ) {
    return {
      verdict: "REJECTED",
      confidence: 98,
      reason: `Conflicting model identifiers (${ebayModels[0]} vs ${amazonModels[0]}).`,
      method: "RULES",
    };
  }

  const ebayQty = quantity(ebayTitle);
  const amazonQty = quantity(amazonTitle);
  if (ebayQty !== null && amazonQty !== null && ebayQty !== amazonQty) {
    return {
      verdict: "REJECTED",
      confidence: 97,
      reason: `Different package quantities (${ebayQty} vs ${amazonQty}).`,
      method: "RULES",
    };
  }

  const ebayMeasurements = measurements(ebayTitle);
  const amazonMeasurements = measurements(amazonTitle);
  if (
    ebayMeasurements.length > 0 &&
    amazonMeasurements.length > 0 &&
    !ebayMeasurements.some((value) => amazonMeasurements.includes(value))
  ) {
    return {
      verdict: "REJECTED",
      confidence: 95,
      reason: `Conflicting size or capacity (${ebayMeasurements[0]} vs ${amazonMeasurements[0]}).`,
      method: "RULES",
    };
  }

  if (shared.length < 2 || similarity < 0.3) {
    return {
      verdict: "REJECTED",
      confidence: Math.round(90 + (0.3 - Math.min(similarity, 0.3)) * 30),
      reason: "The titles do not share enough defining product details.",
      method: "RULES",
    };
  }

  if (similarity >= 0.68 || (similarity >= 0.58 && shared.length >= 5)) {
    return {
      verdict: "LIKELY",
      confidence: Math.min(94, Math.round(62 + similarity * 40)),
      reason: "Strong agreement on the product type and defining attributes.",
      method: "RULES",
    };
  }

  return {
    verdict: "REVIEW",
    confidence: Math.max(35, Math.round(similarity * 100)),
    reason: "Some details overlap, but the titles alone do not prove the same sellable item.",
    method: "RULES",
  };
}

function responseText(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const output = (payload as { output?: unknown[] }).output;
  if (!Array.isArray(output)) return null;
  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    const content = (item as { content?: unknown[] }).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") {
        return (part as { text: string }).text;
      }
    }
  }
  return null;
}

function chatCompletionText(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const choices = (payload as { choices?: unknown[] }).choices;
  if (!Array.isArray(choices)) return null;
  const first = choices[0];
  if (!first || typeof first !== "object") return null;
  const message = (first as { message?: unknown }).message;
  if (!message || typeof message !== "object") return null;
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  return content
    .map((part) =>
      part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
        ? (part as { text: string }).text
        : "",
    )
    .join("") || null;
}

async function assessWithAi(
  ebay: ProductIdentity,
  amazon: ProductIdentity,
): Promise<ProductMatchAssessment | null> {
  const openRouterKey = process.env.OPENROUTER_API_KEY;
  const openAiKey = process.env.OPENAI_API_KEY;
  const apiKey = openRouterKey || openAiKey;
  if (!apiKey) return null;

  const prompt = [
    "Act as a strict ecommerce product identity verifier.",
    "Decide whether the eBay item and Amazon source are the same sellable product or a genuinely interchangeable equivalent.",
    "Reject different product types, incompatible variants, sizes, quantities, models, bundles, genders, ages, colors when material, or an accessory matched to a main product.",
    "Do not approve merely because both items share broad keywords.",
    `EBAY TITLE: ${ebay.title}`,
    `AMAZON TITLE: ${amazon.title}`,
    'Return only JSON: {"verdict":"MATCH"|"LIKELY"|"REVIEW"|"REJECTED","confidence":0-100,"reason":"one short sentence"}.',
  ].join("\n");
  const openAiContent: ({ type: "input_text"; text: string } | { type: "input_image"; image_url: string })[] = [
    {
      type: "input_text",
      text: prompt,
    },
  ];
  if (ebay.imageUrl?.startsWith("https://")) {
    openAiContent.push({ type: "input_image", image_url: ebay.imageUrl });
  }
  if (amazon.imageUrl?.startsWith("https://")) {
    openAiContent.push({ type: "input_image", image_url: amazon.imageUrl });
  }

  try {
    const endpoint = openRouterKey
      ? "https://openrouter.ai/api/v1/chat/completions"
      : "https://api.openai.com/v1/responses";
    const headers: Record<string, string> = {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    };
    if (openRouterKey) {
      headers["HTTP-Referer"] = "https://www.sellfinity.app";
      headers["X-OpenRouter-Title"] = "Sellfinity";
    }
    const openRouterContent: (
      | { type: "text"; text: string }
      | { type: "image_url"; image_url: { url: string } }
    )[] = [{ type: "text", text: prompt }];
    if (ebay.imageUrl?.startsWith("https://")) {
      openRouterContent.push({ type: "image_url", image_url: { url: ebay.imageUrl } });
    }
    if (amazon.imageUrl?.startsWith("https://")) {
      openRouterContent.push({ type: "image_url", image_url: { url: amazon.imageUrl } });
    }
    const response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(
        openRouterKey
          ? {
              model:
                process.env.OPENROUTER_MATCH_MODEL ||
                "google/gemini-2.5-flash-lite",
              messages: [{ role: "user", content: openRouterContent }],
              max_tokens: 180,
              temperature: 0,
            }
          : {
              model: process.env.OPENAI_MATCH_MODEL || "gpt-5.6-luna",
              input: [{ role: "user", content: openAiContent }],
              max_output_tokens: 180,
            },
      ),
      signal: AbortSignal.timeout(12_000),
    });
    if (!response.ok) return null;
    const payload = await response.json();
    const text = openRouterKey
      ? chatCompletionText(payload)
      : responseText(payload);
    if (!text) return null;
    const json = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? "") as {
      verdict?: ProductMatchVerdict;
      confidence?: number;
      reason?: string;
    };
    if (!["MATCH", "LIKELY", "REVIEW", "REJECTED"].includes(json.verdict ?? "")) return null;
    if (typeof json.confidence !== "number" || typeof json.reason !== "string") return null;
    return {
      verdict: json.verdict!,
      confidence: Math.max(0, Math.min(100, Math.round(json.confidence))),
      reason: json.reason.slice(0, 240),
      method: "AI",
    };
  } catch {
    return null;
  }
}

/** AI-enhanced product identity check. Hard rule conflicts can never be
 * overridden; if AI is unavailable, only high-confidence rule matches pass. */
export async function assessProductMatch(
  ebay: ProductIdentity,
  amazon: ProductIdentity,
): Promise<ProductMatchAssessment> {
  const rules = assessProductMatchRules(ebay.title, amazon.title);
  if (rules.verdict === "REJECTED") return rules;
  return (await assessWithAi(ebay, amazon)) ?? rules;
}

export function isApprovedProductMatch(assessment: ProductMatchAssessment): boolean {
  return (
    (assessment.verdict === "MATCH" || assessment.verdict === "LIKELY") &&
    assessment.confidence >= 70
  );
}
