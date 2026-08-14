import { notFound } from "next/navigation";
import { requireAdmin } from "@/lib/auth";
import { getAsinReport } from "@/lib/analytics/asin-report";
import { AsinReportView } from "@/components/asin-report-view";

export const metadata = { title: "ASIN seller report — Sellfinity" };
export const maxDuration = 120;

export default async function AdminAsinReportPage({ params }: { params: Promise<{ asin: string }> }) {
  await requireAdmin();
  const { asin } = await params;
  const report = await getAsinReport(decodeURIComponent(asin), { days: 30 });
  if (!report) notFound();
  return <AsinReportView report={report} admin />;
}
