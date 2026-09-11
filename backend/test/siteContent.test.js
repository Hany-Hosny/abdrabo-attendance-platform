import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_HOME_CONTENT, LandingPageContentSchema } from "@abdrabo/shared/landingContent.js";

test("shared home content defaults satisfy the runtime contract", () => {
  assert.equal(DEFAULT_HOME_CONTENT.ar.grades.length, 9);
  assert.equal(DEFAULT_HOME_CONTENT.en.features.length, 4);
  assert.equal(LandingPageContentSchema.safeParse(DEFAULT_HOME_CONTENT.ar).success, true);
  assert.equal(LandingPageContentSchema.safeParse(DEFAULT_HOME_CONTENT.en).success, true);
});

test("shared home content schema reports precise feature cardinality errors", () => {
  const invalid = {
    ...DEFAULT_HOME_CONTENT.ar,
    features: DEFAULT_HOME_CONTENT.ar.features.slice(0, 3)
  };
  const result = LandingPageContentSchema.safeParse(invalid);
  assert.equal(result.success, false);
  assert.equal(result.error.issues[0].path.join("."), "features");
});
