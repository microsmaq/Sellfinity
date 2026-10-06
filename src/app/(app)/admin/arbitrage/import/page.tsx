import { requireAdmin } from "@/lib/auth";
import { PageHeader } from "@/components/ui";
import { CatalogImporter } from "./catalog-importer";
export const metadata = { title: "Import Amazon products — Sellfinity" };
export default async function CatalogImportPage() {
  await requireAdmin();
  return <><PageHeader title="Import Amazon products" subtitle="Save product information without paid research. New products enter Pending review." /><CatalogImporter /></>;
}
