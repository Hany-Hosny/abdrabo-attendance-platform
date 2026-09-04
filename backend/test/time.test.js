import assert from "node:assert/strict";
import test from "node:test";
import { cairoDateString } from "../src/utils/time.js";

test("cairoDateString uses the Cairo calendar date instead of UTC date", () => {
  assert.equal(cairoDateString(new Date("2026-09-03T22:29:00.000Z")), "2026-09-04");
});
