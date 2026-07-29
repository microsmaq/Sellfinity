import { db } from "../src/lib/db";
import { recalculateAllArbitragePricing } from "../src/lib/arbitrage/recalculate-pricing";

async function main() {
  console.log(JSON.stringify(await recalculateAllArbitragePricing()));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$disconnect();
  });
