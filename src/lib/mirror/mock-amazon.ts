// Sandbox Amazon scraper: fabricates a realistic, deterministic product from
// the ASIN so any amazon.com/dp/<ASIN> URL "scrapes" the same product every
// time. Also models daily price/stock drift for inventory sync, mirroring how
// the MegaSupply mock behaves.

import type { ProductPageScraper, ScrapedProduct } from "./scraper";
import { extractAsin } from "./scraper";
import type { SupplierProductState } from "@/lib/sourcing/provider";

export const AMAZON_SUPPLIER_NAME = "Amazon (sandbox scraper)";

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rand: () => number, arr: T[]): T {
  return arr[Math.floor(rand() * arr.length)];
}

const BRANDS = [
  "VonHaus", "Kootek", "Bellemain", "TrailBlaze", "NuvoMed", "HomiCasa",
  "ZensuTech", "AeroGrip", "LumenPeak", "CosyNest", "PrimeVia", "Orbislab",
];

const ARCHETYPES: {
  category: string;
  noun: string;
  attribute: string[];
  bullets: string[];
  priceBand: [number, number]; // dollars
}[] = [
  { category: "Home & Kitchen", noun: "Air Fryer Silicone Liners, 8 Inch Reusable Set of 2", attribute: ["BPA-Free", "Dishwasher Safe", "Food Grade"], bullets: ["Replaces parchment liners forever — wipe clean or toss in the dishwasher", "Heat safe to 450°F with raised ridges for crispy results", "Fits most 4-7QT square and round baskets"], priceBand: [9, 18] },
  { category: "Home & Kitchen", noun: "Over-The-Sink Dish Drying Rack, 2-Tier Stainless", attribute: ["Adjustable 26-34\"", "Rustproof", "Large Capacity"], bullets: ["Frees up counter space by drying dishes over the sink", "Adjustable length fits single and double sinks", "Includes utensil cups, cutting board holder, and hooks"], priceBand: [28, 55] },
  { category: "Electronics", noun: "Wireless Earbuds Bluetooth 5.3 with Charging Case", attribute: ["48H Playtime", "IPX7 Waterproof", "Deep Bass"], bullets: ["One-step pairing and touch controls", "LED battery display on the case", "Snug fit with three ear-tip sizes for workouts"], priceBand: [19, 40] },
  { category: "Electronics", noun: "Digital Kitchen Scale with USB Rechargeable Battery", attribute: ["0.1g Precision", "5 Units", "Tare Function"], bullets: ["Weighs up to 22lb/10kg with 0.1oz precision", "Tempered glass surface wipes clean", "Recharges over USB-C — no coin batteries"], priceBand: [12, 24] },
  { category: "Pet Supplies", noun: "Dog Nail Grinder, Quiet 2-Speed Rechargeable", attribute: ["Low Noise", "3 Ports", "Painless"], bullets: ["Whisper-quiet motor won't spook anxious pets", "Diamond bit grinder is safer than clippers", "USB rechargeable, 10-hour runtime"], priceBand: [14, 26] },
  { category: "Pet Supplies", noun: "Cat Scratcher Cardboard Lounge Bed, Reversible", attribute: ["Extra Thick", "Catnip Included", "Double-Sided"], bullets: ["Reversible design doubles the scratching life", "High-density corrugated cardboard sheds less", "Wide enough for large cats to lounge"], priceBand: [11, 22] },
  { category: "Fitness & Outdoors", noun: "Adjustable Dumbbell Set 25lb Pair with Rack", attribute: ["Non-Slip Grip", "Space Saving", "Quick-Adjust"], bullets: ["Swap plates in seconds with the locking collars", "Knurled chrome handles for a secure grip", "Compact stand keeps your space tidy"], priceBand: [45, 89] },
  { category: "Fitness & Outdoors", noun: "Running Belt Waist Pack with Water Bottle Holder", attribute: ["Bounce-Free", "Reflective", "Fits All Phones"], bullets: ["No-bounce elastic hugs your waist on long runs", "Holds phone, keys, gels, and a 6oz bottle", "360° reflective strips for night visibility"], priceBand: [10, 19] },
  { category: "Toys & Games", noun: "Kids Camera 1080P Digital Video Recorder, Shockproof", attribute: ["32GB Card Included", "Ages 3-9", "Selfie Lens"], bullets: ["Chunky shockproof shell survives drops", "Games, filters, and time-lapse built in", "USB rechargeable with a 600mAh battery"], priceBand: [17, 34] },
  { category: "Toys & Games", noun: "Pop Tubes Sensory Fidget Toy Mega Pack of 24", attribute: ["Non-Toxic", "Connectable", "Party Favors"], bullets: ["Stretch, pop, bend, and connect endlessly", "Classroom-safe PP plastic, easy to sanitize", "Bright assorted colors kids trade and share"], priceBand: [9, 16] },
  { category: "Garden & Tools", noun: "Solar Ground Lights 8-Pack Outdoor Waterproof Disk", attribute: ["Warm White", "IP65", "Auto On/Off"], bullets: ["Flush disk design mows over cleanly", "8-10 hours of light from a day's charge", "Tool-free stake installation in minutes"], priceBand: [21, 38] },
  { category: "Garden & Tools", noun: "Pruning Shears Set with Holster, SK-5 Steel 3-Piece", attribute: ["Ultra Sharp", "Ergonomic", "Sap Groove"], bullets: ["Razor SK-5 blades cut 3/4\" branches clean", "Locking safety clasp and belt holster", "Cushioned grips reduce hand fatigue"], priceBand: [15, 29] },
];

/** Deterministic fabricated product for an ASIN. */
export function productForAsin(asin: string): Omit<ScrapedProduct, "sourceUrl" | "inStock" | "priceCents"> & {
  basePriceCents: number;
} {
  const rand = mulberry32(hashString(`asin:${asin}`));
  const archetype = pick(rand, ARCHETYPES);
  const brand = pick(rand, BRANDS);
  const attribute = pick(rand, archetype.attribute);
  const [lo, hi] = archetype.priceBand;
  const basePriceCents = Math.round((lo + rand() * (hi - lo)) * 100) - 1; // x.99

  return {
    sourceId: asin,
    title: `${brand} ${archetype.noun}, ${attribute}`,
    brand,
    bulletPoints: archetype.bullets,
    description: `${archetype.bullets.join(". ")}.`,
    category: archetype.category,
    imageUrls: [
      `https://picsum.photos/seed/${asin}-1/600/600`,
      `https://picsum.photos/seed/${asin}-2/600/600`,
      `https://picsum.photos/seed/${asin}-3/600/600`,
    ],
    basePriceCents,
  };
}

/** Days since epoch, UTC. */
function currentDayNumber(): number {
  return Math.floor(Date.now() / 86_400_000);
}

/**
 * Daily price/stock drift for a mirrored Amazon product: ~2% vanish, ~5% out
 * of stock, price swings ±8% around base. Deterministic per (ASIN, day).
 */
export function amazonStateForDay(asin: string, dayNumber: number): SupplierProductState {
  const rand = mulberry32(hashString(`asin-state:${asin}:${dayNumber}`));
  if (rand() < 0.02) return null;
  const outOfStock = rand() < 0.05;
  const base = productForAsin(asin).basePriceCents;
  const costCents = Math.round(base * (0.92 + rand() * 0.16));
  // Amazon stock is effectively deep; expose a plausible finite number.
  const stock = outOfStock ? 0 : 25 + Math.floor(rand() * 200);
  return { stock, costCents };
}

export class MockAmazonScraper implements ProductPageScraper {
  constructor(private dayNumber: () => number = currentDayNumber) {}

  async scrape(url: string): Promise<ScrapedProduct | null> {
    const asin = extractAsin(url);
    if (!asin) return null;
    const state = amazonStateForDay(asin, this.dayNumber());
    if (state === null) return null; // page gone today
    const base = productForAsin(asin);
    return {
      sourceId: base.sourceId,
      sourceUrl: `https://www.amazon.com/dp/${asin}`,
      title: base.title,
      brand: base.brand,
      bulletPoints: base.bulletPoints,
      description: base.description,
      category: base.category,
      imageUrls: base.imageUrls,
      priceCents: state.costCents,
      inStock: state.stock > 0,
    };
  }
}
