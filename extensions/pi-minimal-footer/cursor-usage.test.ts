import assert from "node:assert/strict";
import test from "node:test";

import { parseCursorPeriodUsage, parseCursorUsageSummary } from "./cursor-usage.ts";

test("parses Cursor native period percentages and reset", () => {
  assert.deepEqual(
    parseCursorPeriodUsage({
      billingCycleEnd: String(Date.parse("2026-09-01T00:00:00.000Z")),
      planUsage: { totalPercentUsed: 13, autoPercentUsed: 12.5, apiPercentUsed: 14 },
    }),
    {
      billingCycleEnd: "2026-09-01T00:00:00.000Z",
      totalPercentUsed: 13,
      autoPercentUsed: 12.5,
      apiPercentUsed: 14,
    },
  );
});

test("rejects malformed period data and parses session fallback", () => {
  assert.equal(parseCursorPeriodUsage({ billingCycleEnd: "not-a-number" }), undefined);
  assert.deepEqual(
    parseCursorUsageSummary({
      billingCycleEnd: "2026-09-01T00:00:00.000Z",
      individualUsage: { plan: { totalPercentUsed: 27, autoPercentUsed: null } },
    }),
    {
      billingCycleEnd: "2026-09-01T00:00:00.000Z",
      totalPercentUsed: 27,
      autoPercentUsed: undefined,
      apiPercentUsed: undefined,
    },
  );
  assert.equal(
    parseCursorUsageSummary({ individualUsage: { plan: {} }, billingCycleEnd: "invalid" })?.billingCycleEnd,
    undefined,
  );
});
