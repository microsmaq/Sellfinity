"use server";
import { requireAdmin } from "@/lib/auth";
import { jevConfiguration, screenProductPairWithJev } from "@/lib/ai/jev";
export async function testJevConnection() {
  await requireAdmin();
  const config = jevConfiguration();
  if (!config.configured) return { ok: false, message: "OpenAI authentication is not available. Configure OPENAI_API_KEY with access to the Decisions API." };
  if (!config.enabled) return { ok: false, message: "OpenAI Decisions is disabled by configuration." };
  let failure = "OpenAI Decisions did not return a valid response.";
  const result = await screenProductPairWithJev("Acme AB123 Black Knee Strap 2 Pack", "Acme CD456 Red Knee Strap 10 Pack", true, (reason) => { failure = reason; });
  if (!result) return { ok: false, message: `${failure} Matching continues with the existing AI.` };
  return { ok: true, message: `OpenAI Decisions responded in ${result.durationMs} ms. Test routing: ${result.route}. Conflict probability: ${(result.conflictProbability * 100).toFixed(1)}%.` };
}
