import { useState } from "react";
import { ChatDrawer } from "./ChatDrawer";

type PublicChatWidgetProps = { apiBaseUrl?: string };

export function PublicChatWidget({ apiBaseUrl }: PublicChatWidgetProps) {
  const [open, setOpen] = useState(false);
  const [welcomeVisible, setWelcomeVisible] = useState(true);

  return <>
    <div className="landing-ai-orb-control" dir="rtl">
      {welcomeVisible ? (
        <div className="landing-ai-tooltip" role="status">
          <span>👋 اسأل المساعد الذكي</span>
          <button type="button" onClick={() => setWelcomeVisible(false)} aria-label="إغلاق التلميح">×</button>
        </div>
      ) : null}
      <button
        className="landing-art-core landing-ai-orb-trigger"
        type="button"
        onClick={() => { setWelcomeVisible(false); setOpen(true); }}
        aria-label="فتح المساعد الذكي"
      >
        <span>ع</span>
        <i className="landing-ai-online-dot" aria-hidden="true"><b /></i>
      </button>
    </div>
    <ChatDrawer isOpen={open} onClose={() => setOpen(false)} sessionType="public" apiBaseUrl={apiBaseUrl} />
  </>;
}
