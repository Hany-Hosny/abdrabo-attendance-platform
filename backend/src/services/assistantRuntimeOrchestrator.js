import { assembleBrainSystemContext, resolveAssistantUnderstanding, validateAssistantText } from "./assistantBrain.js";
import { arbitrateConversationContext, buildClarificationResponse } from "./conversationContextArbiter.js";

export async function handleAssistantMessage({
  rawText,
  messages,
  catalog,
  actionId = null,
  baseSystemInstruction,
  deterministicHandler,
  generate
}) {
  const understanding = resolveAssistantUnderstanding({ rawText, messages, catalog, actionId });
  const arbitration = arbitrateConversationContext({
    pendingIntent: understanding.context.pendingIntent,
    currentTurn: understanding.currentTurn,
    currentIntent: understanding.intent
  });
  understanding.arbitration = arbitration;
  if (arbitration.decision === "CLARIFY") {
    return { kind: "deterministic", content: buildClarificationResponse({ currentTurn: understanding.currentTurn, pendingIntent: understanding.context.pendingIntent }), understanding, trace: { intent: understanding.intent, pendingIntent: understanding.context.pendingIntent, arbiterDecision: arbitration.decision, deterministic: true, llmUsed: false } };
  }
  const deterministic = await deterministicHandler?.(understanding);
  if (deterministic) {
    return {
      kind: "deterministic",
      content: validateAssistantText(deterministic) || deterministic,
      understanding,
      trace: { intent: understanding.intent, deterministic: true, llmUsed: false }
    };
  }

  const systemInstruction = assembleBrainSystemContext({ understanding, baseInstruction: baseSystemInstruction });
  const generation = await generate({ systemInstruction, understanding });
  if (!generation?.ok) return { kind: "failure", generation, understanding, trace: { intent: understanding.intent, deterministic: false, llmUsed: true } };
  return {
    kind: "llm",
    model: generation.model,
    content: validateAssistantText(generation.content),
    understanding,
    trace: { intent: understanding.intent, deterministic: false, llmUsed: true, providerRouterRequestId: generation.requestId || null }
  };
}
