globalThis.sellfinityAmazonPriceFromPage = function amazonPriceFromPage(doc = document) {
  function centsFromText(text) {
    const match = String(text || "").replace(/,/g, "").match(/\$\s*(\d+(?:\.\d{1,2})?)/);
    return match ? Math.round(Number(match[1]) * 100) : null;
  }

  const priceSelectors = [
    "#corePrice_feature_div .priceToPay .a-offscreen",
    "#corePrice_feature_div .a-price .a-offscreen",
    "#apex_desktop .priceToPay .a-offscreen",
    "#apex_desktop .a-price .a-offscreen",
    ".reinventPricePriceToPayMargin .a-offscreen",
    "#price_inside_buybox",
    "#priceblock_dealprice",
    "#priceblock_ourprice"
  ];
  let unitPriceCents = null;
  for (const selector of priceSelectors) {
    for (const element of doc.querySelectorAll(selector)) {
      const parsed = centsFromText(element.textContent);
      if (parsed !== null && parsed > 0) {
        unitPriceCents = parsed;
        break;
      }
    }
    if (unitPriceCents !== null) break;
  }
  if (unitPriceCents === null) return null;

  const shippingSelectors = [
    "#mir-layout-DELIVERY_BLOCK-slot-PRIMARY_DELIVERY_MESSAGE_LARGE",
    "#mir-layout-DELIVERY_BLOCK-slot-SECONDARY_DELIVERY_MESSAGE_LARGE",
    "#deliveryBlockMessage",
    "#ddmDeliveryMessage",
    "#delivery-message",
    "#ourprice_shippingmessage"
  ];
  const shippingText = shippingSelectors
    .flatMap((selector) => [...doc.querySelectorAll(selector)].map((element) => element.textContent || ""))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  let shippingCents = null;
  const thresholdFreeDelivery = /\bfree\s+(?:delivery|shipping)\b[^$]{0,30}\$\s*\d+(?:\.\d{1,2})?\s+(?:of items|minimum|order)/i.test(shippingText);
  const explicitShipping = shippingText.match(/\$\s*(\d+(?:\.\d{1,2})?)\s*(?:delivery|shipping)/i)
    || (!thresholdFreeDelivery && shippingText.match(/(?:delivery|shipping)[^$]{0,30}\$\s*(\d+(?:\.\d{1,2})?)/i));
  if (explicitShipping) shippingCents = Math.round(Number(explicitShipping[1]) * 100);
  else if (/\bfree\s+(?:delivery|shipping)\b/i.test(shippingText) && !thresholdFreeDelivery) shippingCents = 0;

  return { unitPriceCents, shippingCents };
};
