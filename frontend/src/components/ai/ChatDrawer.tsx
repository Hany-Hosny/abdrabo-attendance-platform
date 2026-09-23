import {
  type FormEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { AtomicIcon } from "./AtomicIcon";

type SessionType = "public" | "student";

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
};

type StudentContext = {
  name?: string;
  grade?: string;
};

type ChatDrawerProps = {
  isOpen: boolean;
  onClose: () => void;
  sessionType: SessionType;
  studentContext?: StudentContext;
  authToken?: string;
  apiBaseUrl?: string;
};

type ApiResponse = {
  ok?: boolean;
  message?:
    | {
        content?: string;
      }
    | string;
};

const publicSuggestions = [
  "مكان السنتر والمواعيد",
  "تفاصيل منهج أولى ثانوي",
  "طريقة الاشتراك والتسجيل",
];

const studentSuggestions = [
  "اشرح لي قانون بقاء المادة",
  "عندي سؤال في الواجب",
  "نصائح للامتحان القادم",
];

export function ChatDrawer({
  isOpen,
  onClose,
  sessionType,
  studentContext,
  authToken,
  apiBaseUrl = "/api",
}: ChatDrawerProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");

  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const messagesRef = useRef<HTMLDivElement | null>(null);

  const suggestions =
    sessionType === "student"
      ? studentSuggestions
      : publicSuggestions;

  const subtitle =
    sessionType === "student"
      ? "مساعدك الأكاديمي لمادة العلوم"
      : "مساعد الزوار والاستفسارات";

  useEffect(() => {
    if (!isOpen) return;

    const frame = window.requestAnimationFrame(() => {
      inputRef.current?.focus();
    });

    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [isOpen]);

  useEffect(() => {
    const container = messagesRef.current;

    if (!container) return;

    container.scrollTo({
      top: container.scrollHeight,
      behavior: "smooth",
    });
  }, [messages, sending, error]);

  useEffect(() => {
    if (!isOpen) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };

    window.addEventListener("keydown", onKeyDown);

    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [isOpen, onClose]);

  async function sendMessage(nextContent = input) {
    const content = nextContent.trim();

    if (!content || sending) {
      return;
    }

    const nextMessages: ChatMessage[] = [
      ...messages,
      {
        role: "user",
        content,
      },
    ];

    setMessages(nextMessages);
    setInput("");
    setError("");
    setSending(true);

    try {
      const baseUrl = apiBaseUrl.replace(/\/+$/, "");
      const endpoint = `${baseUrl}/assistant/chat`;

      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(sessionType === "student" && authToken
            ? { Authorization: `Bearer ${authToken}` }
            : {}),
        },
        body: JSON.stringify({
          messages: nextMessages,
          sessionType,
          studentContext,
        }),
      });

      const payload: ApiResponse = await response
        .json()
        .catch(() => ({}));

      if (!response.ok) {
        const detail =
          typeof payload.message === "string"
            ? payload.message
            : "";

        throw new Error(
          detail ||
            `حدث خطأ في الخادم (${response.status}). يرجى المحاولة مرة أخرى.`,
        );
      }

      const assistantContent =
        typeof payload.message === "object" &&
        payload.message !== null
          ? payload.message.content
          : undefined;

      if (!payload.ok || !assistantContent) {
        throw new Error(
          "تعذر الحصول على رد من المساعد الذكي. يرجى المحاولة مرة أخرى.",
        );
      }

      setMessages((current) => [
        ...current,
        {
          role: "assistant",
          content: String(assistantContent),
        },
      ]);
    } catch (error) {
      const detail =
        error instanceof Error
          ? error.message.trim()
          : "";

      setError(
        detail ||
          "تعذر إرسال الرسالة الآن. يرجى المحاولة مرة أخرى.",
      );
    } finally {
      setSending(false);
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void sendMessage();
  }

  if (!isOpen) {
    return null;
  }

  return createPortal(
    <aside
      className="atomic-chat-drawer"
      dir="rtl"
      role="dialog"
      aria-modal="true"
      aria-labelledby="atomic-chat-title"
    >
      <header className="atomic-chat-header">
        <AtomicIcon size="sm" />

        <div>
          <h2 id="atomic-chat-title">
            مساعد منصة العلوم
          </h2>
          <p>{subtitle}</p>
        </div>

        <button
          className="atomic-chat-close"
          type="button"
          onClick={onClose}
          aria-label="إغلاق المساعد"
        >
          ×
        </button>
      </header>

      <div
        className="atomic-chat-suggestions"
        aria-label="اقتراحات سريعة"
      >
        {suggestions.map((suggestion) => (
          <button
            type="button"
            key={suggestion}
            disabled={sending}
            onClick={() => void sendMessage(suggestion)}
          >
            {suggestion}
          </button>
        ))}
      </div>

      <div
        className="atomic-chat-messages"
        ref={messagesRef}
        aria-live="polite"
      >
        {!messages.length ? (
          <p className="atomic-chat-empty">
            مرحباً بك، كيف يمكنني مساعدتك اليوم؟
          </p>
        ) : null}

        {messages.map((message, index) => (
          <p
            className={`atomic-chat-message is-${message.role}`}
            key={`${message.role}-${index}`}
          >
            {message.content}
          </p>
        ))}

        {sending ? (
          <div className="atomic-chat-typing">
            <i />
            <i />
            <i />
            <span>المساعد يكتب...</span>
          </div>
        ) : null}

        {error ? (
          <p
            className="atomic-chat-error"
            role="alert"
          >
            {error}
          </p>
        ) : null}
      </div>

      <form
        className="atomic-chat-input"
        onSubmit={handleSubmit}
      >
        <textarea
          ref={inputRef}
          value={input}
          onChange={(event) =>
            setInput(event.target.value)
          }
          onKeyDown={(event) => {
            if (
              event.key === "Enter" &&
              !event.shiftKey
            ) {
              event.preventDefault();
              void sendMessage();
            }
          }}
          placeholder="اكتب سؤالك هنا..."
          aria-label="اكتب رسالتك"
          rows={1}
          maxLength={2000}
          disabled={sending}
        />

        <button
          type="submit"
          disabled={sending || !input.trim()}
          aria-label="إرسال الرسالة"
        >
          ←
        </button>
      </form>
    </aside>,
    document.body,
  );
}
