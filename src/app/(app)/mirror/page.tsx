import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { Badge, PageHeader } from "@/components/ui";
import { MirrorForm } from "./mirror-form";

export const metadata = { title: "Amazon mirroring — SellPilot" };

export default async function MirrorPage() {
  const user = await requireUser();
  const connection = await db.ebayConnection.findUnique({
    where: { userId: user.id },
  });
  const ebayConnected = !!connection && connection.status !== "DISCONNECTED";

  return (
    <>
      <PageHeader
        title="Amazon mirroring"
        subtitle="Paste Amazon product URLs — one per line for bulk — and get eBay-ready listings with SEO-optimized titles, images, and profitable pricing."
        actions={
          <Badge tone={ebayConnected ? "green" : "amber"}>
            {ebayConnected ? "eBay connected (sandbox)" : "eBay not connected"}
          </Badge>
        }
      />
      <MirrorForm ebayConnected={ebayConnected} />
    </>
  );
}
