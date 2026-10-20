import { requireAdmin } from "@/lib/auth";
import { PageHeader } from "@/components/ui";
import { keepaDiscoveryStatus } from "@/lib/keepa/discovery";
import { KeepaDiscoveryPanel } from "./keepa-discovery-panel";

export const metadata = { title: "Keepa bestseller import — Sellfinity" };
export const maxDuration = 300;
export default async function KeepaDiscoveryPage() {
  await requireAdmin();
  return <>
    <PageHeader title="Keepa bestseller import" subtitle="Grow the shared Amazon catalog. Fetch bestseller lists once, skip known ASINs, and spend detail tokens only on new products." />
    <KeepaDiscoveryPanel initial={await keepaDiscoveryStatus()} />
  </>;
}
