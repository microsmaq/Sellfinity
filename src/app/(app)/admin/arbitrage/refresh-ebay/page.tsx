import { requireAdmin } from "@/lib/auth";
import { EbayMetricsRefreshRunner } from "./refresh-runner";

export default async function EbayMetricsRefreshPage() {
  await requireAdmin();
  return <EbayMetricsRefreshRunner />;
}
