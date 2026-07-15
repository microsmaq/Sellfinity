import "server-only";
import { buildBatchCompletionEmail, type BatchCompletionEmailInput } from "./batch-completion-template";

type SendResult =
  | { ok: true; emailId: string }
  | { ok: false; error: string };

export async function sendBatchCompletionEmail(
  recipient: string,
  input: BatchCompletionEmailInput,
): Promise<SendResult> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM;
  if (!apiKey || !from) {
    return {
      ok: false,
      error: "Batch email is not configured. Set RESEND_API_KEY and EMAIL_FROM.",
    };
  }

  const message = buildBatchCompletionEmail(input);
  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": `mirror-batch-${input.batchId}`,
      },
      body: JSON.stringify({
        from,
        to: [recipient],
        subject: message.subject,
        html: message.html,
        text: message.text,
        tags: [
          { name: "category", value: "mirror_batch_complete" },
          { name: "batch_id", value: input.batchId },
        ],
      }),
    });
    const body = (await response.json().catch(() => null)) as
      | { id?: string; message?: string; error?: string }
      | null;
    if (!response.ok || !body?.id) {
      return {
        ok: false,
        error: body?.message ?? body?.error ?? `Email provider returned HTTP ${response.status}.`,
      };
    }
    return { ok: true, emailId: body.id };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Email provider request failed.",
    };
  }
}
