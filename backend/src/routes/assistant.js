  import express from "express";
  import { GoogleGenAI } from "@google/genai";
  import { createRateLimiter } from "../middleware/rateLimit.js";
  import { ipKeyGenerator } from "express-rate-limit";
  import { GEMINI_MODELS, getGeminiConfig } from "../services/geminiConfig.js";

  export const assistantRouter = express.Router();

  const assistantRateLimit = createRateLimiter({
    windowMs: 15 * 60_000,
    max: 20,
    key: (req) => `assistant:${ipKeyGenerator(req.ip || "unknown")}`
  });

  const MAX_MESSAGES = 20;
  const MAX_MESSAGE_LENGTH = 2_000;
  const DEFAULT_ASSISTANT_MODEL = "gemini-1.5-flash"; 

  function cleanText(value, maxLength = MAX_MESSAGE_LENGTH) {
    return String(value || "").replace(/\u0000/g, "").trim().slice(0, maxLength);
  }

  function parseChatRequest(body) {
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("invalid_request");
    if (body.sessionType !== "public" && body.sessionType !== "student") throw new Error("invalid_session_type");
    if (!Array.isArray(body.messages) || !body.messages.length || body.messages.length > MAX_MESSAGES) throw new Error("invalid_messages");
    const messages = body.messages.map((message) => {
      if (!message || typeof message !== "object" || (message.role !== "user" && message.role !== "assistant")) throw new Error("invalid_messages");
      const content = cleanText(message.content);
      if (!content) throw new Error("invalid_messages");
      return { role: message.role, content };
    });
    const studentContext = body.studentContext && typeof body.studentContext === "object" && !Array.isArray(body.studentContext)
      ? { name: cleanText(body.studentContext.name, 80), grade: cleanText(body.studentContext.grade, 80) }
      : {};
    return { messages, sessionType: body.sessionType, studentContext };
  }

  function systemInstruction(sessionType, studentContext) {
    const platformKnowledgeBase = `
  [مواعيد مجموعات مستر أحمد عبدربه الحالية]:
  * المرحلة الابتدائية:
  - الصف الخامس الابتدائي: السبت (الساعة 5) - الأربعاء (الساعة 4).
  - الصف السادس الابتدائي: السبت (الساعة 9) - الأربعاء (الساعة 6).

  * المرحلة الإعدادية:
  - الصف الأول الإعدادي: السبت (الساعة 2 و 3 و 4) - الإثنين (الساعة 2 و 3 و 5) - الأربعاء (الساعة 2 و 3 و 7).
  - الصف الثاني الإعدادي: أيام الأحد والثلاثاء والأربعاء (الساعة 3 و 4 و 5).
  - الصف الثالث الإعدادي: أيام السبت والإثنين والأربعاء (الساعة 12 و 1).

  * المرحلة الثانوية:
  - الصف الأول الثانوي (المجموعة الأولى): أيام الأحد والثلاثاء والخميس (الساعة 6 و 7).
  - الصف الأول الثانوي (المجموعة الثانية): السبت (الساعة 10) - الإثنين (الساعة 4) - الأربعاء (الساعة 5).

  [روابط التابات الحقيقية في الموقع - abdrabo.online]:
  - الرئيسية: https://abdrabo.online/
  - عن المحاضر: https://abdrabo.online/about-teacher
  - التواصل والدعم وأماكن السناتر: https://abdrabo.online/contact
  - دخول الطلاب: https://abdrabo.online/student/login
  `;

    const persona = `أنت المساعد الذكي الرسمي لمنصة مستر أحمد عبدربه (Mr. Ahmed Abdrabo).
  تلتزم بهذه الهوية التزاماً تاماً:
  - تحدث بلهجة مصرية راقية، مهذبة، وودودة جداً.
  - تخصصك مادة 'العلوم' فقط.
  - استخدم ألقاب تشجيعية للطلاب مثل: 'يا بطل'، 'يا دكتور'، 'يا بشمهندس'.
  - عندما يسألك أحد عن تفاصيل التواصل، أرقام السكرتارية، أو أماكن السناتر، وجهه مباشرة لرابط التواصل: https://abdrabo.online/contact

  ${platformKnowledgeBase}`;

    if (sessionType === "student") {
      return `${persona}

  [سياق جلسة الطالب]:
  تخاطب الطالب \({studentContext.name || "يا بطل"} المقيد في\){studentContext.grade || "مرحلته الدراسية"}. رد باختصار وبشكل مشجع.`;
    }

    return `${persona}

  [سياق جلسة الزائر]:
  تخاطب الزائر بترحيب راقٍ وتساعده بناءً على المواعيد وروابط الموقع المتاحة فقط.`;
  }

  function geminiContents(messages) {
    return messages.map((message) => ({
      role: message.role === "assistant" ? "model" : "user",
      parts: [{ text: message.content }]
    }));
  }

  function normalizeModel(value) {
    const candidate = String(value || "").trim();
    return GEMINI_MODELS.includes(candidate) ? candidate : DEFAULT_ASSISTANT_MODEL;
  }

  async function resolveAssistantConfig() {
    const environmentKey = String(process.env.GEMINI_API_KEY || "").trim();
    let storedConfig = null;
    try {
      storedConfig = await getGeminiConfig();
    } catch (error) {
      if (!environmentKey) {
        const configurationError = new Error("assistant_configuration_unavailable");
        configurationError.cause = error;
        throw configurationError;
      }
    }

    const apiKey = String(storedConfig?.apiKey || environmentKey).trim();
    if (!apiKey) throw new Error("assistant_not_configured");
    return { apiKey, model: normalizeModel(storedConfig?.model) };
  }

  function providerFailure(error) {
    const status = Number(error?.status || error?.statusCode || 0);
    if (status === 401 || status === 403) return { httpStatus: 502, status: "provider_auth_failed", message: "The configured Gemini API key was rejected." };
    if (status === 429) return { httpStatus: 429, status: "provider_rate_limited", message: "The AI service is temporarily rate limited. Please try again shortly." };
    if (status === 400 || status === 404) return { httpStatus: 502, status: "provider_model_unavailable", message: "The configured Gemini model is unavailable. Select a supported model in AI Settings." };
    return { httpStatus: 502, status: "provider_unavailable", message: "The AI service is temporarily unavailable. Please try again." };
  }

  assistantRouter.post("/assistant/chat", assistantRateLimit, async (req, res) => {
    let request;
    try {
      request = parseChatRequest(req.body);
    } catch (error) {
      return res.status(400).json({ ok: false, status: error.message || "invalid_request" });
    }

    try {
      const { apiKey, model } = await resolveAssistantConfig();
      const client = new GoogleGenAI({ apiKey });
      const response = await client.models.generateContent({
        model,
        contents: geminiContents(request.messages),
        config: {
          systemInstruction: systemInstruction(request.sessionType, request.studentContext),
          temperature: 0.55,
          maxOutputTokens: 700
        }
      });
      const content = String(response.text || "").trim();
      if (!content) return res.status(502).json({ ok: false, status: "empty_assistant_response", message: "The AI assistant did not return a response." });
      return res.status(200).json({ ok: true, model, message: { role: "assistant", content } });
    } catch (error) {
      console.error("Gemini Error Details:", error);
      
      if (error?.message === "assistant_not_configured") {
        return res.status(500).json({ ok: false, status: "assistant_not_configured", message: "AI settings are missing an API key. Configure Gemini in System Settings or GEMINI_API_KEY." });
      }
      if (error?.message === "assistant_configuration_unavailable") {
        return res.status(500).json({ ok: false, status: "assistant_configuration_unavailable", message: "The AI settings could not be read. Check database and secret-storage configuration." });
      }
      const failure = providerFailure(error);
      return res.status(failure.httpStatus).json({ ok: false, ...failure });
    }
  });