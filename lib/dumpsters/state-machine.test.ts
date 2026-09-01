import { describe, it, expect } from "vitest";
import {
  ALLOWED_TRANSITIONS,
  canTransition,
  nextStatuses,
  DUMPSTER_STATUSES,
} from "./state-machine";

describe("dumpster state machine (UI mirror)", () => {
  it("matches the intended matrix, verbatim", () => {
    expect(ALLOWED_TRANSITIONS).toEqual({
      available: ["reserved", "out_of_service"],
      reserved: ["available", "deployed", "out_of_service"],
      deployed: ["available", "overdue", "out_of_service"],
      overdue: ["available", "out_of_service"],
      out_of_service: ["available"],
    });
  });

  it("never allows a no-op transition", () => {
    for (const s of DUMPSTER_STATUSES) {
      expect(canTransition(s, s)).toBe(false);
    }
  });

  it("allows the maintenance override from every non-serviced state", () => {
    for (const s of DUMPSTER_STATUSES) {
      if (s === "out_of_service") continue;
      expect(canTransition(s, "out_of_service")).toBe(true);
    }
  });

  it("only lets a serviced unit return to available", () => {
    expect(nextStatuses("out_of_service")).toEqual(["available"]);
  });

  it("blocks skipping straight from available to deployed", () => {
    expect(canTransition("available", "deployed")).toBe(false);
  });

  it("blocks reviving overdue straight back to deployed", () => {
    expect(canTransition("overdue", "deployed")).toBe(false);
  });
});
