import { useState } from "react";
import { AtomicIcon } from "./AtomicIcon";
import { ChatDrawer } from "./ChatDrawer";

type StudentHeaderAssistantProps = { studentName?: string; grade?: string; studentToken?: string; apiBaseUrl?: string };

export function StudentHeaderAssistant({ studentName, grade, studentToken, apiBaseUrl }: StudentHeaderAssistantProps) {
  const [open, setOpen] = useState(false);
  const [mobilePromptVisible, setMobilePromptVisible] = useState(true);
  return <>
    <button className="student-assistant-trigger student-assistant-trigger-desktop" type="button" onClick={() => setOpen(true)} aria-label="فتح المساعد الذكي"><AtomicIcon size="sm" /><span><strong>المساعد الذكي ✨</strong><small>متاح للمساعدة <i aria-hidden="true">●</i></small></span></button>
    <div className="student-assistant-mobile-wrap" dir="rtl">
      {mobilePromptVisible ? <div className="student-assistant-mobile-tooltip" role="status"><span>اسأل المساعد الذكي 👋</span><i className="student-assistant-tooltip-arrow" aria-hidden="true">←</i><button type="button" onClick={() => setMobilePromptVisible(false)} aria-label="إغلاق التلميح">×</button></div> : null}
      <button className="student-assistant-trigger student-assistant-trigger-mobile" type="button" onClick={() => { setMobilePromptVisible(false); setOpen(true); }} aria-label="فتح المساعد الذكي"><AtomicIcon size="md" /></button>
    </div>
    <ChatDrawer isOpen={open} onClose={() => setOpen(false)} sessionType="student" studentContext={{ name: studentName, grade }} authToken={studentToken} apiBaseUrl={apiBaseUrl} />
  </>;
}
