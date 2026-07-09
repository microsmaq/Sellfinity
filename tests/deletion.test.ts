import { describe, expect, it } from "vitest";
import { createHash } from "crypto";
import {
  computeChallengeResponse,
  extractDeletedUser,
} from "@/lib/ebay/deletion";

describe("computeChallengeResponse", () => {
  it("hashes challengeCode + token + endpoint in order, hex-encoded", () => {
    const expected = createHash("sha256")
      .update("abc" + "token123" + "https://sellfinity.app/api/ebay/account-deletion")
      .digest("hex");
    expect(
      computeChallengeResponse(
        "abc",
        "token123",
        "https://sellfinity.app/api/ebay/account-deletion",
      ),
    ).toBe(expected);
    expect(expected).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes with any input", () => {
    const base = computeChallengeResponse("a", "b", "c");
    expect(computeChallengeResponse("x", "b", "c")).not.toBe(base);
    expect(computeChallengeResponse("a", "x", "c")).not.toBe(base);
    expect(computeChallengeResponse("a", "b", "x")).not.toBe(base);
  });
});

describe("extractDeletedUser", () => {
  it("pulls the username from eBay's notification shape", () => {
    expect(
      extractDeletedUser({
        notification: { data: { username: "buyer_1", userId: "u1" } },
      }),
    ).toEqual({ username: "buyer_1", userId: "u1" });
  });

  it("returns null for junk payloads", () => {
    expect(extractDeletedUser(null)).toBeNull();
    expect(extractDeletedUser({})).toBeNull();
    expect(extractDeletedUser({ notification: { data: {} } })).toBeNull();
  });
});
