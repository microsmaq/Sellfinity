export type CategoryKeyword = {
  category: string;
  keyword: string;
};

/**
 * Broad, resale-friendly discovery areas. Consumables, supplements, clothing,
 * and other policy/variant-heavy groups are intentionally excluded.
 */
export const CATEGORY_KEYWORDS: CategoryKeyword[] = [
  { category: "Home & Kitchen", keyword: "kitchen gadgets" },
  { category: "Home & Kitchen", keyword: "coffee accessories" },
  { category: "Home & Kitchen", keyword: "air fryer accessories" },
  { category: "Home & Kitchen", keyword: "home organization" },

  { category: "Pet Supplies", keyword: "dog grooming tools" },
  { category: "Pet Supplies", keyword: "interactive cat toys" },
  { category: "Pet Supplies", keyword: "pet travel accessories" },

  { category: "Sports & Outdoors", keyword: "home workout equipment" },
  { category: "Sports & Outdoors", keyword: "camping accessories" },
  { category: "Sports & Outdoors", keyword: "hiking accessories" },
  { category: "Sports & Outdoors", keyword: "yoga accessories" },

  { category: "Electronics", keyword: "phone accessories" },
  { category: "Electronics", keyword: "portable bluetooth speakers" },
  { category: "Electronics", keyword: "wireless charging accessories" },
  { category: "Electronics", keyword: "smart home accessories" },

  { category: "Patio, Lawn & Garden", keyword: "garden hand tools" },
  { category: "Patio, Lawn & Garden", keyword: "solar outdoor lights" },
  { category: "Patio, Lawn & Garden", keyword: "plant care accessories" },

  { category: "Toys & Games", keyword: "educational toys" },
  { category: "Toys & Games", keyword: "sensory toys" },
  { category: "Toys & Games", keyword: "family party games" },

  { category: "Tools & Home Improvement", keyword: "hand tool sets" },
  { category: "Tools & Home Improvement", keyword: "home repair tools" },
  { category: "Tools & Home Improvement", keyword: "bathroom organization" },

  { category: "Beauty & Personal Care", keyword: "hair styling tools" },
  { category: "Beauty & Personal Care", keyword: "skin care tools" },
  { category: "Beauty & Personal Care", keyword: "manicure tools" },

  { category: "Office Products", keyword: "desk organization" },
  { category: "Office Products", keyword: "office accessories" },
  { category: "Office Products", keyword: "label makers" },

  { category: "Arts, Crafts & Sewing", keyword: "craft tool kits" },
  { category: "Arts, Crafts & Sewing", keyword: "sewing accessories" },
  { category: "Arts, Crafts & Sewing", keyword: "art supply organizers" },

  { category: "Automotive", keyword: "car cleaning accessories" },
  { category: "Automotive", keyword: "car interior organizers" },
  { category: "Automotive", keyword: "automotive hand tools" },

  { category: "Baby", keyword: "baby travel accessories" },
  { category: "Baby", keyword: "nursery organization" },
  { category: "Baby", keyword: "baby safety accessories" },

  { category: "Musical Instruments", keyword: "guitar accessories" },
  { category: "Musical Instruments", keyword: "music stand accessories" },
  { category: "Musical Instruments", keyword: "instrument maintenance tools" },

  { category: "Industrial & Scientific", keyword: "measuring tools" },
  { category: "Industrial & Scientific", keyword: "storage bins" },
  { category: "Industrial & Scientific", keyword: "packing tools" },
];

/**
 * Interleave categories instead of grouping their keywords. The day rotates
 * both category priority and the first keyword used inside each category, so
 * repeated scans do not consistently favor the same departments.
 */
export function balancedCategoryKeywords(
  dayNumber: number,
  entries: CategoryKeyword[] = CATEGORY_KEYWORDS,
): CategoryKeyword[] {
  const groups = new Map<string, CategoryKeyword[]>();
  for (const entry of entries) {
    const group = groups.get(entry.category) ?? [];
    group.push(entry);
    groups.set(entry.category, group);
  }
  const categories = [...groups.keys()];
  if (categories.length === 0) return [];
  const categoryOffset = Math.abs(dayNumber) % categories.length;
  const rotatedCategories = [
    ...categories.slice(categoryOffset),
    ...categories.slice(0, categoryOffset),
  ];
  const rotatedGroups = new Map(
    rotatedCategories.map((category, index) => {
      const group = groups.get(category) ?? [];
      if (group.length === 0) return [category, group] as const;
      const offset = Math.abs(dayNumber + index) % group.length;
      return [category, [...group.slice(offset), ...group.slice(0, offset)]] as const;
    }),
  );
  const rounds = Math.max(...[...rotatedGroups.values()].map((group) => group.length));
  const result: CategoryKeyword[] = [];
  for (let round = 0; round < rounds; round++) {
    for (const category of rotatedCategories) {
      const entry = rotatedGroups.get(category)?.[round];
      if (entry) result.push(entry);
    }
  }
  return result;
}
