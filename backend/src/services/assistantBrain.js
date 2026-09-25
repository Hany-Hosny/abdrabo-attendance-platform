import { normalizeAssistantInput, normalizeForMatching } from "./assistantInputNormalization.js";

export const ENTITY_CONFIDENCE = Object.freeze({
  HIGH: "HIGH",
  MEDIUM: "MEDIUM",
  AMBIGUOUS: "AMBIGUOUS",
  NONE: "NONE"
});

export const AssistantBrainConfig = Object.freeze({
  identity: { name: "Abdrabo educational assistant", subject: "science" },
  languagePolicy: { arabic: "Egyptian-friendly Arabic", english: "English", mixed: "dominant-language response" },
  conversationPolicy: { preserveRawText: true, pendingStateTtlMs: 10 * 60_000 },
  operationalPolicy: { deterministicFirst: true, authoritativeSource: "application data" },
  teachingPolicy: { useProviderRouter: true, noDirectProviderSelection: true },
  groundingPolicy: { includeOnlyRelevantFacts: true, noDatabaseDump: true },
  safetyPolicy: { preserveAuthorization: true, noSensitiveTraceData: true },
  responseStyle: { concise: true, plainText: true }
});

export const ARBITER_DECISIONS = Object.freeze({
  CONTINUE_PENDING: "CONTINUE_PENDING",
  SWITCH_INTENT: "SWITCH_INTENT",
  CLARIFY: "CLARIFY",
  NEW_CONVERSATION_BRANCH: "NEW_CONVERSATION_BRANCH"
});

const STAGE_PATTERNS = [
  ["primary", /(?:ابتدائي|ابتداي)/],
  ["preparatory", /(?:اعدادي|إعدادي)/],
  ["secondary", /(?:ثانوي|ثانوى)/]
];

const ORDINAL_PATTERNS = [
  [1, /(?:اول|اولي|اولى|الاول|الأول|first|1)/],
  [2, /(?:تاني|تانيه|تانية|ثاني|ثانيه|ثانية|التاني|الثاني|second|2)/],
  [3, /(?:تالت|تالته|تالتة|ثالث|ثالثه|ثالثة|التالت|الثالث|third|3)/],
  [5, /(?:خامس|الخامس|fifth|5)/],
  [6, /(?:سادس|السادس|sixth|6)/]
];

const ACTION_INTENTS = Object.freeze({
  center_location_and_schedule: "location_lookup",
  registration_info: "registration_info",
  curriculum_first_secondary: "curriculum_info",
  schedule_lookup: "schedule_lookup",
  teacher_info: "teacher_info"
});

function detectGradeParts(value) {
  const text = normalizeForMatching(value).replace(/\bthe\b/g, "");
  const ordinal = ORDINAL_PATTERNS.find(([, pattern]) => pattern.test(text))?.[0] || null;
  const stage = STAGE_PATTERNS.find(([name, pattern]) => pattern.test(text))?.[0] || null;
  return { ordinal, stage };
}

function catalogEntity(group) {
  return {
    type: "grade",
    id: group?.groupId ?? null,
    groupIds: group?.groupId == null ? [] : [group.groupId],
    canonicalLabel: String(group?.grade || group?.gradeLevel || group?.displayName || "").trim(),
    source: group
  };
}

function groupMatches(group, parts) {
  const values = [group?.displayName, group?.grade, group?.gradeLevel].filter(Boolean).join(" ");
  const candidate = detectGradeParts(values);
  return (!parts.ordinal || candidate.ordinal === parts.ordinal) && (!parts.stage || candidate.stage === parts.stage);
}

function detectLanguage(text) {
  return /[\u0600-\u06FF]/.test(text) ? "ar" : "en";
}

function explicitIntentForText(normalizedText) {
  if (/(طريقة الاشتراك|ازاي اشترك|كيف اشترك|التسجيل|الاشتراك|register|registration|subscribe)/.test(normalizedText)) return "registration_info";
  if (/(فين السنتر|مكان السنتر|عنوان السنتر|المركز فين|location|address)/.test(normalizedText)) return "location_lookup";
  if (/(مين المستر|من هو المستر|عن المستر|عن المدرس|معلومات عن المدرس|teacher profile|who is the teacher)/.test(normalizedText)) return "teacher_info";
  if (/(المستر شاطر|المستر كويس|رأيك في المستر|هل المستر|teacher.*good|good teacher)/.test(normalizedText)) return "teacher_opinion";
  if (/(منهج|مقرر|curriculum)/.test(normalizedText)) return "curriculum_info";
  if (/(اشرح|شرح|حللي|قانون|درس|explain|teach|study)/.test(normalizedText)) return "teaching_question";
  if (/(أنا دفعت|دفعت الشهر|مدفوع|عليا|رصيد|payment|paid|balance)/.test(normalizedText)) return "payment_status";
  if (/(غبت|غيبت|غياب|حضوري|حضور|attendance)/.test(normalizedText)) return "attendance_lookup";
  if (/(الامتحان|امتحان|exam)/.test(normalizedText)) return "exam_lookup";
  if (/(درجات|نتيجة|results?|scores?)/.test(normalizedText)) return "results_lookup";
  if (/(مواعيد|ميعاد|جدول|امتى|schedule|when)/.test(normalizedText)) return "schedule_lookup";
  if (/^(اه|اهه|تمام|ماشي|شكرا|شكراً|ok|okay|thanks|thank you)$/.test(normalizedText)) return "acknowledgment";
  if (/^(ازيك|اهلا|أهلا|السلام عليكم|hello|hi)$/.test(normalizedText)) return "greeting";
  return null;
}

function messageShapeFor(text, explicitIntentCandidate, entities) {
  if (explicitIntentCandidate === "acknowledgment") return "acknowledgment";
  if (explicitIntentCandidate) return /^(registration|location|teacher|schedule|payment|attendance|exam|results)_/.test(explicitIntentCandidate) ? "explicit_question" : "explicit_command";
  if (entities.grade || entities.group) return "slot_answer";
  return text.includes("؟") || text.includes("?") ? "explicit_question" : "conversational_reply";
}

export function resolveGroupEntity(rawText, catalog = []) {
  const normalizedText = normalizeForMatching(rawText);
  const queryTokens = normalizedText.replace(/\bمجموعه?\b/g, " ").split(/\s+/).filter((token) => token.length > 1);
  const matches = (Array.isArray(catalog) ? catalog : []).filter((group) => {
    const name = normalizeForMatching(group?.displayName || "");
    if (!name || !normalizedText.includes("مجموع")) return false;
    return normalizedText.includes(name) || (name.includes(normalizedText) && normalizedText.length > 5) || (queryTokens.length > 0 && queryTokens.every((token) => name.includes(token)));
  });
  if (!matches.length) return { entity: null, confidence: ENTITY_CONFIDENCE.NONE, candidates: [] };
  const candidates = matches.map((group) => ({
    type: "group",
    id: group.groupId ?? null,
    canonicalLabel: String(group.displayName || group.grade || "").trim(),
    source: group
  }));
  return { entity: candidates[0], confidence: matches.length === 1 ? ENTITY_CONFIDENCE.HIGH : ENTITY_CONFIDENCE.AMBIGUOUS, candidates };
}

export function resolveGradeEntity(rawText, catalog = [], { requireStage = false } = {}) {
  const input = normalizeAssistantInput(rawText);
  const parts = detectGradeParts(input.normalizedText);
  if (!parts.ordinal) return { entity: null, confidence: ENTITY_CONFIDENCE.NONE, candidates: [] };
  const matches = (Array.isArray(catalog) ? catalog : []).filter((group) => groupMatches(group, parts));
  if (!matches.length) return { entity: null, confidence: ENTITY_CONFIDENCE.NONE, candidates: [] };
  const stageMissing = !parts.stage && requireStage;
  if (stageMissing || (!parts.stage && new Set(matches.map((group) => detectGradeParts(group?.grade || group?.displayName).stage)).size > 1)) {
    return {
      entity: null,
      confidence: ENTITY_CONFIDENCE.AMBIGUOUS,
      candidates: matches.map(catalogEntity)
    };
  }
  const first = catalogEntity(matches[0]);
  first.groupIds = matches.map((group) => group.groupId).filter((id) => id != null);
  return { entity: first, confidence: parts.stage ? ENTITY_CONFIDENCE.HIGH : ENTITY_CONFIDENCE.MEDIUM, candidates: matches.map(catalogEntity) };
}

export function resolveConversationContext(messages = [], now = Date.now()) {
  const recent = messages.slice(-6);
  const assistantQuestion = [...recent].reverse().find((message) => message.role === "assistant" && /مواعيد أنهي صف|مواعيد أنهي مجموعة|سعر أنهي صف|سعر أنهي مجموعة|which grade or group/i.test(message.content || ""));
  if (!assistantQuestion) return { pendingIntent: null, missingSlots: [], resolvedSlots: {}, lastAssistantQuestion: null };
  const createdAt = Number(assistantQuestion.createdAt || now);
  if (now - createdAt > AssistantBrainConfig.conversationPolicy.pendingStateTtlMs) return { pendingIntent: null, missingSlots: [], resolvedSlots: {}, lastAssistantQuestion: null };
  return {
    pendingIntent: /سعر/.test(assistantQuestion.content || "") ? "fee_lookup" : "schedule_lookup",
    missingSlots: ["grade_or_group"],
    resolvedSlots: {},
    lastAssistantQuestion: assistantQuestion.content
  };
}

export function resolveIntent(rawText, { context = {}, gradeResolution = null, explicitIntent = null } = {}) {
  const { normalizedText } = normalizeAssistantInput(rawText);
  const detectedIntent = explicitIntent || explicitIntentForText(normalizedText);
  if (detectedIntent && !["acknowledgment", "greeting"].includes(detectedIntent)) return detectedIntent;
  if (context.pendingIntent && gradeResolution?.confidence === ENTITY_CONFIDENCE.HIGH) return context.pendingIntent;
  if (/(امتحان|exam)/.test(normalizedText)) return "exam_lookup";
  if (/(درجات|نتيجة|result)/.test(normalizedText)) return "result_lookup";
  if (/(مواعيد|ميعاد|جدول|امتى|when|schedule)/.test(normalizedText)) return "schedule_lookup";
  if (/(بكام|سعر|رسوم|اشتراك|دفعت|مدفوع|رصيد|payment|fee)/.test(normalizedText)) return /(دفعت|مدفوع|رصيد)/.test(normalizedText) ? "payment_status" : "fee_lookup";
  if (/(غبت|غيبت|غياب|حضور|حضوري|attendance)/.test(normalizedText)) return "attendance_lookup";
  if (/(اشرح|قانون|يعني ايه|حل|explain|how does)/.test(normalizedText)) return "teaching_question";
  if (!normalizedText) return "clarification";
  return "general_question";
}

export function analyzeCurrentTurn({ rawText, actionId = null, catalog = [] }) {
  const input = normalizeAssistantInput(rawText);
  const explicitIntentCandidate = ACTION_INTENTS[actionId] || actionId || explicitIntentForText(input.normalizedText);
  const gradeResolution = resolveGradeEntity(rawText, catalog);
  const groupResolution = resolveGroupEntity(rawText, catalog);
  const entities = { grade: gradeResolution.entity, group: groupResolution.entity };
  return {
    rawText: input.rawText,
    normalizedText: input.normalizedText,
    language: detectLanguage(input.rawText),
    dialectSignals: input.dialectSignals,
    explicitIntentCandidate,
    entities,
    gradeResolution,
    groupResolution,
    messageShape: messageShapeFor(input.normalizedText, explicitIntentCandidate, entities),
    confidence: gradeResolution.confidence === ENTITY_CONFIDENCE.HIGH || groupResolution.confidence === ENTITY_CONFIDENCE.HIGH ? ENTITY_CONFIDENCE.HIGH : explicitIntentCandidate ? ENTITY_CONFIDENCE.MEDIUM : ENTITY_CONFIDENCE.NONE
  };
}

export function resolveAssistantUnderstanding({ rawText, messages = [], catalog = [], actionId = null }) {
  const input = normalizeAssistantInput(rawText);
  const context = resolveConversationContext(messages);
  const currentTurn = analyzeCurrentTurn({ rawText, actionId, catalog });
  const gradeResolution = resolveGradeEntity(rawText, catalog, { requireStage: !context.pendingIntent });
  return {
    rawText: input.rawText,
    normalizedText: input.normalizedText,
    dialectSignals: input.dialectSignals,
    context,
    currentTurn,
    gradeResolution,
    intent: resolveIntent(rawText, { context, gradeResolution: currentTurn.gradeResolution, explicitIntent: currentTurn.explicitIntentCandidate })
  };
}

export function assembleBrainSystemContext({ understanding, baseInstruction }) {
  const trace = `[ASSISTANT BRAIN CONTEXT]\nintent=${understanding.intent}\nnormalized=${understanding.normalizedText}\nentity_confidence=${understanding.gradeResolution.confidence}\n`;
  return `${trace}${baseInstruction}`;
}

export function validateAssistantText(value) {
  const text = String(value || "").trim();
  if (!text || text.startsWith("{") || text.includes("[provider_error]")) return null;
  return text;
}
