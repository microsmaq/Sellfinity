"use server";
import { requireAdmin } from "@/lib/auth";
import { jevConfiguration, screenProductPairWithJev } from "@/lib/ai/jev";
export async function testJevConnection() {
  await requireAdmin();
  const config = jevConfiguration();
  if (!config.configured) return { ok: false, message: "No Vercel Gateway authentication is available. Configure AI_GATEWAY_API_KEY or enable Vercel OIDC for this project." };
  const result = await screenProductPairWithJev("Acme AB123 Black Knee Strap 2 Pack", "Acme CD456 Red Knee Strap 10 Pack", true);
  if (!result) return { ok: false, message: "Jev did not return a valid response. Check AI Gateway access, balance and authentication in Vercel. Matching continues with the existing AI." };
  return { ok: true, message: `Jev responded in ${result.durationMs} ms. Test routing: ${result.route}. Conflict probability: ${(result.conflictProbability * 100).toFixed(1)}%.` };
}
