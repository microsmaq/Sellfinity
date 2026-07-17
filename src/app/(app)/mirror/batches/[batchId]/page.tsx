import { notFound } from "next/navigation";
import { getMirrorBatch } from "@/lib/actions/mirror-batches";
import { PageHeader } from "@/components/ui";
import { BatchProgress } from "./batch-progress";

export const metadata = { title: "Listing activity — Sellfinity" };

export default async function MirrorBatchPage({
  params,
}: {
  params: Promise<{ batchId: string }>;
}) {
  const { batchId } = await params;
  const batch = await getMirrorBatch(batchId);
  if (!batch) notFound();

  return (
    <>
      <PageHeader
        title="eBay listing activity"
        subtitle="Item-level progress and results retained in your permanent publishing history."
      />
      <BatchProgress initial={batch} />
    </>
  );
}
