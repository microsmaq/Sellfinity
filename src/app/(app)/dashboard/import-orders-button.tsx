"use client";

import { useState, useTransition } from "react";
import { importOrdersNow } from "@/lib/actions/orders";
import { Button } from "@/components/ui";

export function ImportOrdersButton() {
  const [pending, startTransition] = useTransition();
  const [notice, setNotice] = useState<string | null>(null);

  return (
    <div className="flex w-full flex-col items-stretch gap-2 sm:w-auto sm:items-end">
      {notice && <p className="text-sm text-slate-500">{notice}</p>}
      <Button
        variant="secondary"
        className="w-full rounded-xl bg-white sm:w-auto"
        disabled={pending}
        onClick={() => {
          setNotice(null);
          startTransition(async () => {
            const result = await importOrdersNow();
            if ("error" in result) {
              setNotice(result.error);
              return;
            }
            setNotice(
              result.imported === 0
                ? "No new orders"
                : `Imported ${result.imported} new order${result.imported === 1 ? "" : "s"}`,
            );
          });
        }}
      >
        {pending ? "Importing…" : "Import eBay orders"}
      </Button>
    </div>
  );
}
