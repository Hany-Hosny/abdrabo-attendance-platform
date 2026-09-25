import { ARBITER_DECISIONS, ENTITY_CONFIDENCE } from "./assistantBrain.js";

const SLOT_INTENTS = new Set(["schedule_lookup", "fee_lookup"]);

export function isCompatiblePendingSlot({ pendingIntent, currentTurn }) {
  if (!SLOT_INTENTS.has(pendingIntent)) return false;
  return [currentTurn.gradeResolution, currentTurn.groupResolution].some((resolution) => [ENTITY_CONFIDENCE.HIGH, ENTITY_CONFIDENCE.MEDIUM].includes(resolution?.confidence));
}

export function arbitrateConversationContext({ pendingIntent, currentTurn, currentIntent }) {
  if (!pendingIntent) return { decision: ARBITER_DECISIONS.NEW_CONVERSATION_BRANCH, reason: "no_pending_context" };
  if (currentTurn.explicitIntentCandidate && !["acknowledgment", "greeting"].includes(currentTurn.explicitIntentCandidate)) {
    if (currentTurn.explicitIntentCandidate === pendingIntent) return { decision: ARBITER_DECISIONS.CONTINUE_PENDING, reason: "same_explicit_intent" };
    return { decision: ARBITER_DECISIONS.SWITCH_INTENT, reason: "explicit_current_intent" };
  }
  if (isCompatiblePendingSlot({ pendingIntent, currentTurn }) && ["schedule_lookup", "fee_lookup"].includes(currentIntent)) {
    return { decision: ARBITER_DECISIONS.CONTINUE_PENDING, reason: "compatible_slot" };
  }
  if (currentTurn.messageShape === "acknowledgment") return { decision: ARBITER_DECISIONS.CLARIFY, reason: "acknowledgment_is_not_a_slot" };
  return { decision: ARBITER_DECISIONS.SWITCH_INTENT, reason: "current_turn_not_slot_compatible" };
}

export function buildClarificationResponse({ currentTurn, pendingIntent }) {
  if (currentTurn.messageShape === "acknowledgment") return "تمام، أنا معاك. تحب تسأل عن المواعيد أو عن حاجة تانية؟";
  if (pendingIntent === "schedule_lookup" && currentTurn.gradeResolution?.confidence === ENTITY_CONFIDENCE.AMBIGUOUS) {
    const labels = currentTurn.gradeResolution.candidates.map((candidate) => candidate.canonicalLabel).filter(Boolean).slice(0, 3);
    return labels.length ? `تقصد ${labels.join(" ولا ")}؟` : "تقصد أنهي صف أو مجموعة؟";
  }
  return pendingIntent === "fee_lookup" ? "تحب تعرف سعر أنهي صف أو مجموعة؟" : "تحب تعرف مواعيد أنهي صف أو مجموعة؟";
}
