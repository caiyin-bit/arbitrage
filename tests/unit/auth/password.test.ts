import { describe, it, expect } from "vitest";
import { hashPassword, verifyPassword } from "@/server/services/auth/password";

describe("password", () => {
  it("round-trips: verify returns true for the correct password", () => {
    const hash = hashPassword("hunter2");
    expect(verifyPassword("hunter2", hash)).toBe(true);
  });

  it("returns false for wrong password", () => {
    const hash = hashPassword("hunter2");
    expect(verifyPassword("hunter3", hash)).toBe(false);
  });

  it("returns false for malformed stored hash (no separator)", () => {
    expect(verifyPassword("x", "not-a-valid-hash")).toBe(false);
  });

  it("returns false for malformed stored hash (empty halves)", () => {
    expect(verifyPassword("x", "$")).toBe(false);
  });

  it("two hashes of the same password differ (salted)", () => {
    expect(hashPassword("same")).not.toBe(hashPassword("same"));
  });
});
