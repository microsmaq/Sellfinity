import { notFound } from "next/navigation";
import { getMirrorBatch } from "@/lib/actions/mirror-batches";
import { PageHeader } from "@/components/ui";
import { BatchProgress } from "./batch-progress";

export const metadata = { title: "Publishing batch — Sellfinity" };

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
        title="eBay publishing status"
        subtitle="Live item-by-item progress. This batch remains in your permanent mirroring history."
      />
      <BatchProgress initial={batch} />
    </>
  );
}
