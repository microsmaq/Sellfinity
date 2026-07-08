"use client";

import Link from "next/link";
import { useActionState } from "react";
import { Button, Card, Input, Label } from "@/components/ui";
import type { AuthFormState } from "@/lib/actions/auth";

type Field = {
  name: string;
  label: string;
  type: string;
  autoComplete?: string;
};

export function AuthForm({
  title,
  action,
  fields,
  submitLabel,
  footer,
}: {
  title: string;
  action: (prev: AuthFormState, formData: FormData) => Promise<AuthFormState>;
  fields: Field[];
  submitLabel: string;
  footer: { text: string; linkText: string; href: string };
}) {
  const [state, formAction, pending] = useActionState(action, null);

  return (
    <main className="flex flex-1 items-center justify-center px-6 py-16">
      <div className="w-full max-w-sm">
        <Link href="/" className="mb-8 block text-center text-xl font-semibold">
          Sell<span className="text-indigo-600">finity</span>
        </Link>
        <Card className="p-6">
          <h1 className="mb-5 text-lg font-semibold text-slate-900">{title}</h1>
          <form action={formAction} className="space-y-4">
            {fields.map((f) => (
              <div key={f.name} className="space-y-1.5">
                <Label htmlFor={f.name}>{f.label}</Label>
                <Input
                  id={f.name}
                  name={f.name}
                  type={f.type}
                  autoComplete={f.autoComplete}
                  required
                />
              </div>
            ))}
            {state?.error && (
              <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
                {state.error}
              </p>
            )}
            <Button type="submit" disabled={pending} className="w-full">
              {pending ? "Please wait…" : submitLabel}
            </Button>
          </form>
        </Card>
        <p className="mt-4 text-center text-sm text-slate-500">
          {footer.text}{" "}
          <Link
            href={footer.href}
            className="font-medium text-indigo-600 hover:text-indigo-500"
          >
            {footer.linkText}
          </Link>
        </p>
      </div>
    </main>
  );
}
