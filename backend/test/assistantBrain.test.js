import test from "node:test";
import assert from "node:assert/strict";
import { AssistantBrainConfig, ARBITER_DECISIONS, ENTITY_CONFIDENCE, analyzeCurrentTurn, resolveAssistantUnderstanding, resolveGradeEntity, resolveIntent } from "../src/services/assistantBrain.js";
import { arbitrateConversationContext, buildClarificationResponse } from "../src/services/conversationContextArbiter.js";
import { composeScheduleResponse, formatDisplayTime } from "../src/services/assistantResponseComposer.js";
import { normalizeArabicText, normalizeAssistantInput } from "../src/services/assistantInputNormalization.js";

const catalog = [
  { groupId: 301, displayName: "مجموعة تالتة إعدادي", grade: "الصف الثالث الإعدادي", gradeLevel: "ثالثة إعدادي" },
  { groupId: 302, displayName: "مجموعة تالتة ثانوي", grade: "الصف الثالث الثانوي", gradeLevel: "ثالثة ثانوي" },
  { groupId: 101, displayName: "مجموعة أولى إعدادي", grade: "الصف الأول الإعدادي", gradeLevel: "أولى إعدادي" },
  { groupId: 201, displayName: "مجموعة تانية إعدادي", grade: "الصف الثاني الإعدادي", gradeLevel: "ثانية إعدادي" }
];

test("input normalization preserves raw text and normalizes punctuation, digits, and whitespace", () => {
  const input = normalizeAssistantInput("  تالتة   إعدادي؟ ٣  ");
  assert.equal(input.rawText, "  تالتة   إعدادي؟ ٣  ");
  assert.equal(input.normalizedText, "تالتة اعدادي 3");
  assert.equal(normalizeArabicText("أإآ ١"), "ااا 1");
});

test("all supported third-preparatory variants resolve to one real catalog entity", () => {
  const variants = [
    "تالتة إعدادي",
    "ثالثة إعدادي",
    "ثالثه اعدادي",
    "الصف الثالث الإعدادي",
    "3 اعدادي",
    "٣ اعدادي"
  ];
  const resolutions = variants.map((variant) => resolveGradeEntity(variant, catalog));
  assert.deepEqual(resolutions.map((resolution) => resolution.entity?.id), [301, 301, 301, 301, 301, 301]);
  assert.ok(resolutions.every((resolution) => resolution.confidence === ENTITY_CONFIDENCE.HIGH));
});

test("an ordinal without a stage remains ambiguous when multiple stages exist", () => {
  const resolution = resolveGradeEntity("تالتة", catalog, { requireStage: true });
  assert.equal(resolution.confidence, ENTITY_CONFIDENCE.AMBIGUOUS);
  assert.deepEqual(resolution.candidates.map((candidate) => candidate.id), [301, 302]);
});

test("Egyptian dialect signals resolve operational intents without an LLM", () => {
  assert.equal(resolveIntent("هو الميعاد امتى؟", {}), "schedule_lookup");
  assert.equal(resolveIntent("أنا دفعت الشهر ده؟", {}), "payment_status");
  assert.equal(resolveIntent("غيبت كام مرة؟", {}), "attendance_lookup");
  assert.equal(resolveIntent("الامتحان امتى؟", {}), "exam_lookup");
  assert.equal(resolveIntent("اشرحلي قانون نيوتن التاني", {}), "teaching_question");
});

test("a short reply completes the pending schedule workflow", () => {
  const understanding = resolveAssistantUnderstanding({
    rawText: "تالتة إعدادي",
    catalog,
    messages: [
      { role: "assistant", content: "تحب أعرفك مواعيد أنهي صف أو مجموعة؟" },
      { role: "user", content: "تالتة إعدادي" }
    ]
  });
  assert.equal(understanding.context.pendingIntent, "schedule_lookup");
  assert.equal(understanding.intent, "schedule_lookup");
  assert.equal(understanding.gradeResolution.entity.id, 301);
});

test("brain config keeps operational truth and provider selection separate", () => {
  assert.equal(AssistantBrainConfig.operationalPolicy.deterministicFirst, true);
  assert.equal(AssistantBrainConfig.teachingPolicy.noDirectProviderSelection, true);
  assert.equal(AssistantBrainConfig.safetyPolicy.preserveAuthorization, true);
});

test("names and free text are preserved instead of globally rewritten", () => {
  const input = normalizeAssistantInput("اسم الطالب هاني يحيى");
  assert.equal(input.rawText, "اسم الطالب هاني يحيى");
  assert.match(input.normalizedText, /هاني/);
  assert.match(input.normalizedText, /يحيى/);
});

test("current explicit intent switches away from stale schedule context", () => {
  const pendingMessages = [{ role: "assistant", content: "تحب أعرفك مواعيد أنهي صف أو مجموعة؟" }];
  for (const [message, intent] of [["طريقة الاشتراك والتسجيل", "registration_info"], ["مين المستر ده؟", "teacher_info"], ["المستر شاطر؟", "teacher_opinion"], ["أنا دفعت الشهر ده؟", "payment_status"]]) {
    const understanding = resolveAssistantUnderstanding({ rawText: message, messages: pendingMessages, catalog });
    const arbitration = arbitrateConversationContext({ pendingIntent: "schedule_lookup", currentTurn: understanding.currentTurn, currentIntent: understanding.intent });
    assert.equal(understanding.currentTurn.explicitIntentCandidate, intent);
    assert.equal(arbitration.decision, ARBITER_DECISIONS.SWITCH_INTENT);
  }
});

test("compatible grade and group replies continue pending schedule", () => {
  const gradeTurn = analyzeCurrentTurn({ rawText: "تالتة إعدادي", catalog });
  const groupTurn = analyzeCurrentTurn({ rawText: "مجموعة تالتة إعدادي", catalog });
  assert.equal(arbitrateConversationContext({ pendingIntent: "schedule_lookup", currentTurn: gradeTurn, currentIntent: "schedule_lookup" }).decision, ARBITER_DECISIONS.CONTINUE_PENDING);
  assert.equal(arbitrateConversationContext({ pendingIntent: "schedule_lookup", currentTurn: groupTurn, currentIntent: "schedule_lookup" }).decision, ARBITER_DECISIONS.CONTINUE_PENDING);
});

test("acknowledgments do not become slot answers or repeat the old question", () => {
  const understanding = resolveAssistantUnderstanding({ rawText: "تمام", messages: [{ role: "assistant", content: "تحب أعرفك مواعيد أنهي صف أو مجموعة؟" }], catalog });
  const arbitration = arbitrateConversationContext({ pendingIntent: "schedule_lookup", currentTurn: understanding.currentTurn, currentIntent: understanding.intent });
  assert.equal(arbitration.decision, ARBITER_DECISIONS.CLARIFY);
  assert.doesNotMatch(buildClarificationResponse({ currentTurn: understanding.currentTurn, pendingIntent: "schedule_lookup" }), /مواعيد أنهي صف أو مجموعة/);
});

test("schedule composition formats times and keeps unrelated groups out", () => {
  const response = composeScheduleResponse({
    gradeLabel: "الصف الثالث الإعدادي",
    groups: [{ displayName: "مجموعة السبت", grade: "الصف الثالث الإعدادي", schedules: [{ dayOfWeek: 6, startTime: "17:00:00", endTime: "18:00:00" }] }]
  });
  assert.match(response.text, /5:00 م/);
  assert.match(response.text, /6:00 م/);
  assert.doesNotMatch(response.text, /17:00:00|18:00:00/);
  assert.equal(formatDisplayTime("08:30:00", "ar"), "8:30 ص");
});

test("structured quick actions resolve to explicit intents", () => {
  const understanding = resolveAssistantUnderstanding({ rawText: "تفاصيل منهج أولى ثانوي", actionId: "curriculum_first_secondary", catalog });
  assert.equal(understanding.intent, "curriculum_info");
  assert.equal(understanding.currentTurn.explicitIntentCandidate, "curriculum_info");
});
