import { describe, expect, it } from "vitest";

describe("smoke", () => {
  it("keeps arithmetic honest", () => {
    expect(2 + 2).toBe(4);
  });
});
