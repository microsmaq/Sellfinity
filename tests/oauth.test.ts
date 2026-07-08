import { afterEach, describe, expect, it } from "vitest";
import {
  consentUrl,
  ebayEnvConfig,
  parseCallbackUrl,
  EBAY_SCOPES,
} from "@/lib/ebay/oauth";

const KEYS = ["EBAY_ENV", "EBAY_CLIENT_ID", "EBAY_CLIENT_SECRET", "EBAY_RU_NAME"];
const saved = KEYS.map((k) => [k, process.env[k]] as const);

afterEach(() => {
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

function setEnv(env: Record<string, string | undefined>) {
  for (const k of KEYS) delete process.env[k];
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined) process.env[k] = v;
  }
}

describe("ebayEnvConfig", () => {
  it("is null until the full keyset (including RuName) is configured", () => {
    setEnv({ EBAY_CLIENT_ID: "id", EBAY_CLIENT_SECRET: "secret" });
    expect(ebayEnvConfig()).toBeNull();
    setEnv({ EBAY_CLIENT_ID: "id", EBAY_CLIENT_SECRET: "secret", EBAY_RU_NAME: "" });
    expect(ebayEnvConfig()).toBeNull();
  });

  it("defaults to sandbox hosts", () => {
    setEnv({ EBAY_CLIENT_ID: "id", EBAY_CLIENT_SECRET: "secret", EBAY_RU_NAME: "ru" });
    const config = ebayEnvConfig()!;
    expect(config.env).toBe("SANDBOX");
    expect(config.authHost).toBe("https://auth.sandbox.ebay.com");
    expect(config.apiHost).toBe("https://api.sandbox.ebay.com");
  });

  it("uses production hosts when EBAY_ENV=PRODUCTION", () => {
    setEnv({
      EBAY_ENV: "PRODUCTION",
      EBAY_CLIENT_ID: "id",
      EBAY_CLIENT_SECRET: "secret",
      EBAY_RU_NAME: "ru",
    });
    const config = ebayEnvConfig()!;
    expect(config.authHost).toBe("https://auth.ebay.com");
    expect(config.apiHost).toBe("https://api.ebay.com");
  });
});

describe("parseCallbackUrl", () => {
  it("extracts code and state from a pasted redirect URL", () => {
    const parsed = parseCallbackUrl(
      "https://dead.example/cb?code=v%5E1.1%23i%5E1%23abc&state=xyz&expires_in=299",
    );
    expect(parsed).toEqual({ code: "v^1.1#i^1#abc", state: "xyz" });
  });

  it("tolerates a missing state", () => {
    expect(parseCallbackUrl("https://x.example/?code=abc")).toEqual({
      code: "abc",
      state: null,
    });
  });

  it("rejects URLs without a code and non-URLs", () => {
    expect(parseCallbackUrl("https://x.example/?error=access_denied")).toBeNull();
    expect(parseCallbackUrl("not a url")).toBeNull();
  });
});

describe("consentUrl", () => {
  it("builds the authorize URL with client id, RuName, scopes, and state", () => {
    setEnv({ EBAY_CLIENT_ID: "my-id", EBAY_CLIENT_SECRET: "s", EBAY_RU_NAME: "My_RuName" });
    const url = new URL(consentUrl(ebayEnvConfig()!, "state123"));
    expect(url.origin).toBe("https://auth.sandbox.ebay.com");
    expect(url.pathname).toBe("/oauth2/authorize");
    expect(url.searchParams.get("client_id")).toBe("my-id");
    expect(url.searchParams.get("redirect_uri")).toBe("My_RuName");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("state")).toBe("state123");
    for (const scope of EBAY_SCOPES) {
      expect(url.searchParams.get("scope")).toContain(scope);
    }
  });
});
