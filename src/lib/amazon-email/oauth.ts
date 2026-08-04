import "server-only";

export type GoogleEmailConfig = { clientId: string; clientSecret: string; redirectUri: string };

export function googleEmailConfig(): GoogleEmailConfig | null {
  const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return null;
  const origin = (process.env.APP_URL || "http://localhost:3000").replace(/\/$/, "");
  return { clientId, clientSecret, redirectUri: `${origin}/api/amazon-email/callback` };
}

export function googleAuthorizationUrl(state: string): string {
  const config = googleEmailConfig();
  if (!config) throw new Error("Google email connection is not configured");
  const query = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: "code",
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    scope: "openid email https://www.googleapis.com/auth/gmail.readonly",
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${query}`;
}

export async function exchangeGoogleCode(code: string) {
  const config = googleEmailConfig();
  if (!config) throw new Error("Google email connection is not configured");
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code, client_id: config.clientId, client_secret: config.clientSecret, redirect_uri: config.redirectUri, grant_type: "authorization_code" }),
  });
  if (!response.ok) throw new Error(`Google token exchange failed (${response.status})`);
  return response.json() as Promise<{ access_token: string; refresh_token?: string; expires_in: number }>;
}
