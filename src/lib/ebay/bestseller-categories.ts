export const EBAY_BESTSELLER_CATEGORIES = [
  { id: "293", searchTerm: "electronics", label: "Electronics" },
  { id: "11700", searchTerm: "home and garden", label: "Home & garden" },
  { id: "26395", searchTerm: "health and beauty", label: "Health & beauty" },
  { id: "220", searchTerm: "toys and hobbies", label: "Toys & hobbies" },
  { id: "6028", searchTerm: "auto parts", label: "Auto parts" },
  { id: "1281", searchTerm: "pet supplies", label: "Pet supplies" },
  { id: "888", searchTerm: "sporting goods", label: "Sporting goods" },
  { id: "11450", searchTerm: "clothing shoes accessories", label: "Fashion & accessories" },
] as const;

export function ebayBestSellerCategory(categoryId: string) {
  return EBAY_BESTSELLER_CATEGORIES.find((category) => category.id === categoryId)
    ?? EBAY_BESTSELLER_CATEGORIES[0];
}
