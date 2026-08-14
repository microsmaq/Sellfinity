import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { getAsinReport } from "@/lib/analytics/asin-report";
import { AsinReportView } from "@/components/asin-report-view";

export const metadata = { title: "ASIN analytics — Sellfinity" };
export const maxDuration = 60;

export default async function SellerAsinReportPage({ params }: { params: Promise<{ asin: string }> }) {
  const user = await requireUser();
  const { asin } = await params;
  const report = await getAsinReport(decodeURIComponent(asin), { userId: user.id, days: 30 });
  if (!report) notFound();
  return <AsinReportView report={report} admin={false} />;
}
