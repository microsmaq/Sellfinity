"use client";
import { useState, useTransition } from "react";
import { Card, Button } from "@/components/ui";
import { testJevConnection } from "@/lib/actions/jev";
export function JevStatus({ enabled, configured, authMode, fallbackConfigured = false }: { enabled: boolean; configured: boolean; authMode: string; fallbackConfigured?: boolean }) {
  const [message, setMessage] = useState("");
  const [pending, start] = useTransition();
  return <Card className="p-5">
    <h2 className="font-bold text-slate-950">AI Decisions assistant</h2>
    <p className="mt-2 text-sm leading-6 text-slate-600">Screens product mismatches, prioritizes the automatic review queue, suggests next steps for unfamiliar Smart Sync errors, and checks generated listing copy. Automatic match approval still requires image-aware verification and high-confidence identity checks.</p>
    <p className="mt-2 text-xs text-slate-500">{enabled ? configured ? `Authentication available: ${authMode}. Run the test to verify service access.` : "OpenAI authentication is not available in this environment." : "AI Decisions is disabled by configuration."} Uses OpenAI API credits; no Rainforest requests.</p>
    <p className="mt-2 text-xs text-slate-500">{fallbackConfigured ? "Jev fallback configured: if OpenAI credits are exhausted, verification switches to Jev using Vercel AI Gateway credits. Run the connection test to confirm access." : "Jev fallback is not configured or is disabled. Configure AI_GATEWAY_API_KEY in Vercel to enable it."}</p>
    <Button className="mt-3" variant="secondary" disabled={pending || !enabled} onClick={() => start(async () => { try { const result = await testJevConnection(); setMessage(result.message); } catch { setMessage("Decisions test could not complete. Please try again."); } })}>{pending ? "Testing Decisions…" : "Test Decisions connection"}</Button>
    <p role="status" className="mt-3 text-sm text-indigo-800">{message}</p>
  </Card>;
}
