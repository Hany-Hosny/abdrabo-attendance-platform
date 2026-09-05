import { useCallback, useEffect, useRef, useState } from "react";
import { createIdempotencyKey, normalizeScanValue, type ScannerState } from "./scanner";
import { normalizeDigits } from "./normalizeDigits";
import { flashScannerEdge, playScannerTone } from "./scannerAudio";

export type CachedScannerStudent = {
  id: number;
  full_name: string;
  student_code?: string;
  student_serial?: string;
  scan_serial?: string;
  qr_token?: string;
  group_id?: number;
  group_name?: string;
  grade_level?: string;
  is_active?: boolean;
  deleted_at?: string | null;
};

type QueueItem = {
  id: string;
  token: string;
  createdAt: number;
  attempts: number;
  student?: CachedScannerStudent;
};

type ScannerResponse = {
  ok?: boolean;
  status?: string;
  student?: CachedScannerStudent;
};

export type AttendanceScannerMessages = {
  scanRequired: string;
  recorded: string;
  duplicate: string;
  studentNotFound: string;
  networkError: string;
  savedLocally: string;
  serverError: string;
  resolveStatus?: (status: string) => string;
};

type UseAttendanceScannerOptions = {
  apiBaseUrl: string;
  authToken: string;
  messages: AttendanceScannerMessages;
  deviceId?: string;
};

const DATABASE_NAME = "abdrabo-attendance-scanner";
const DATABASE_VERSION = 1;
const STUDENT_STORE = "students";
const OFFLINE_STORE = "offline_attendance";
const MAX_CONCURRENT_REQUESTS = 3;
const DEDUPE_WINDOW_MS = 1_500;
const INPUT_DEBOUNCE_MS = 90;
const RETRY_DELAYS_MS = [1_000, 2_000, 5_000, 15_000, 30_000];

let databasePromise: Promise<IDBDatabase | null> | null = null;

function openDatabase() {
  if (typeof window === "undefined" || !("indexedDB" in window)) return Promise.resolve(null);
  if (databasePromise) return databasePromise;
  databasePromise = new Promise((resolve) => {
    const request = window.indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STUDENT_STORE)) database.createObjectStore(STUDENT_STORE, { keyPath: "key" });
      if (!database.objectStoreNames.contains(OFFLINE_STORE)) {
        const store = database.createObjectStore(OFFLINE_STORE, { keyPath: "id" });
        store.createIndex("createdAt", "createdAt", { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
  return databasePromise;
}

function transactionResult<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function saveOfflineItem(item: QueueItem) {
  const database = await openDatabase();
  if (!database) return;
  const transaction = database.transaction(OFFLINE_STORE, "readwrite");
  transaction.objectStore(OFFLINE_STORE).put(item);
  await new Promise<void>((resolve) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => resolve();
    transaction.onabort = () => resolve();
  });
}

async function removeOfflineItem(id: string) {
  const database = await openDatabase();
  if (!database) return;
  const transaction = database.transaction(OFFLINE_STORE, "readwrite");
  transaction.objectStore(OFFLINE_STORE).delete(id);
}

async function loadOfflineItems() {
  const database = await openDatabase();
  if (!database) return [];
  try {
    const request = database.transaction(OFFLINE_STORE, "readonly").objectStore(OFFLINE_STORE).getAll();
    return await transactionResult<QueueItem[]>(request);
  } catch (_error) {
    return [];
  }
}

async function saveStudentCache(students: CachedScannerStudent[]) {
  const database = await openDatabase();
  if (!database) return;
  const transaction = database.transaction(STUDENT_STORE, "readwrite");
  const store = transaction.objectStore(STUDENT_STORE);
  for (const student of students) {
    for (const key of scannerLookupKeys(student)) store.put({ key, student });
  }
}

async function loadStudentCache() {
  const database = await openDatabase();
  if (!database) return [];
  try {
    const request = database.transaction(STUDENT_STORE, "readonly").objectStore(STUDENT_STORE).getAll();
    const rows = await transactionResult<Array<{ key: string; student: CachedScannerStudent }>>(request);
    return rows;
  } catch (_error) {
    return [];
  }
}

function scannerLookupKeys(student: CachedScannerStudent) {
  const keys = new Set<string>();
  for (const value of [student.qr_token, student.scan_serial, student.student_serial, student.student_code]) {
    const normalized = normalizeScanValue(value);
    if (!normalized) continue;
    keys.add(normalized);
    keys.add(normalized.replace(/-/g, ""));
    if (/^A\d{4}$/.test(normalized)) keys.add(`A-${normalized.slice(1)}`);
    if (/^A-\d{4}$/.test(normalized)) keys.add(normalized.replace("-", ""));
  }
  return [...keys];
}

function parseScannerResponse(rawBody: string) {
  try {
    return (rawBody ? JSON.parse(rawBody) : {}) as ScannerResponse;
  } catch (_error) {
    return {} as ScannerResponse;
  }
}

export function useAttendanceScanner({ apiBaseUrl, authToken, messages, deviceId = "" }: UseAttendanceScannerOptions) {
  const inputRef = useRef<HTMLInputElement>(null);
  const inputValueRef = useRef("");
  const inputDebounceRef = useRef<number | null>(null);
  const queueRef = useRef<QueueItem[]>([]);
  const queuedIdsRef = useRef(new Set<string>());
  const retryTimersRef = useRef(new Set<number>());
  const recentScansRef = useRef(new Map<string, number>());
  const studentCacheRef = useRef(new Map<string, CachedScannerStudent>());
  const activeRequestsRef = useRef(0);
  const mountedRef = useRef(true);
  const pumpRef = useRef<() => void>(() => undefined);
  const [inputValue, setInputValue] = useState("");
  const [student, setStudent] = useState<CachedScannerStudent | null>(null);
  const [message, setMessage] = useState("");
  const [scanState, setScanState] = useState<ScannerState>("idle");
  const [pendingCount, setPendingCount] = useState(0);
  const [cacheReady, setCacheReady] = useState(false);

  const updateInput = useCallback((value: string) => {
    const sanitized = normalizeDigits(value).replace(/[^A-Za-z0-9]/g, "");
    inputValueRef.current = sanitized;
    setInputValue(sanitized);
    if (inputDebounceRef.current !== null) window.clearTimeout(inputDebounceRef.current);
    inputDebounceRef.current = null;
    if (!sanitized.trim()) return;
    inputDebounceRef.current = window.setTimeout(() => {
      inputDebounceRef.current = null;
      const bufferedValue = inputValueRef.current;
      if (bufferedValue.trim()) void enqueueScanRef.current(bufferedValue);
    }, INPUT_DEBOUNCE_MS);
  }, []);

  const enqueueScanRef = useRef<(value: string) => Promise<void>>(async () => undefined);

  const publish = useCallback((state: ScannerState, nextMessage: string, nextStudent: CachedScannerStudent | null, tone?: "success" | "duplicate" | "error" | "offline") => {
    if (!mountedRef.current) return;
    setScanState(state);
    setMessage(nextMessage);
    setStudent(nextStudent);
    if (tone) {
      playScannerTone(tone);
      flashScannerEdge(tone);
    }
  }, []);

  const updatePendingCount = useCallback(() => {
    if (mountedRef.current) setPendingCount(queueRef.current.length + activeRequestsRef.current);
  }, []);

  const processItem = useCallback(async (item: QueueItem) => {
    activeRequestsRef.current += 1;
    updatePendingCount();
    try {
      if (typeof navigator !== "undefined" && navigator.onLine === false) throw new Error("offline");
      const response = await fetch(`${apiBaseUrl}/scanner/attendance`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${authToken}`,
          "Idempotency-Key": item.id
        },
        body: JSON.stringify({ value: item.token, device_id: deviceId || undefined, send_whatsapp: true })
      });
      const data = parseScannerResponse(await response.text());
      const status = String(data.status || (response.status === 404 ? "student_not_found" : ""));
      if (status === "ignored_hardware_bounce") {
        await removeOfflineItem(item.id);
        return;
      }
      if (response.ok && data.ok) {
        if (data.student) {
          for (const key of scannerLookupKeys(data.student)) studentCacheRef.current.set(key, data.student);
          void saveStudentCache([data.student]);
        }
        await removeOfflineItem(item.id);
        publish("success", `${data.student?.full_name || item.token} — ${messages.recorded}`, data.student || item.student || null, "success");
      } else if (status === "duplicate_attendance") {
        await removeOfflineItem(item.id);
        publish("error", `${data.student?.full_name ? `${data.student.full_name} — ` : ""}${messages.duplicate}`, data.student || item.student || null, "duplicate");
      } else if (response.status >= 500 || response.status === 429) {
        throw new Error("retryable_server_error");
      } else {
        await removeOfflineItem(item.id);
        const resolvedMessage = status === "student_not_found" ? messages.studentNotFound : messages.resolveStatus?.(status) || messages.serverError;
        publish("error", resolvedMessage, data.student || item.student || null, "error");
      }
    } catch (_error) {
      item.attempts += 1;
      await saveOfflineItem(item);
      publish("loading", messages.savedLocally, null);
      const delay = RETRY_DELAYS_MS[Math.min(item.attempts - 1, RETRY_DELAYS_MS.length - 1)];
      if (item.attempts <= RETRY_DELAYS_MS.length) {
        const timer = window.setTimeout(() => {
          retryTimersRef.current.delete(timer);
          if (!queuedIdsRef.current.has(item.id)) {
            queuedIdsRef.current.add(item.id);
            queueRef.current.push(item);
            updatePendingCount();
            pumpRef.current();
          }
        }, delay);
        retryTimersRef.current.add(timer);
      }
    } finally {
      activeRequestsRef.current = Math.max(0, activeRequestsRef.current - 1);
      queuedIdsRef.current.delete(item.id);
      updatePendingCount();
      pumpRef.current();
    }
  }, [apiBaseUrl, authToken, deviceId, messages, publish, updatePendingCount]);

  const pump = useCallback(() => {
    while (activeRequestsRef.current < MAX_CONCURRENT_REQUESTS && queueRef.current.length) {
      const item = queueRef.current.shift();
      if (item) void processItem(item);
    }
    updatePendingCount();
  }, [processItem, updatePendingCount]);
  pumpRef.current = pump;

  const enqueueScan = useCallback(async (rawValue: string) => {
    const token = normalizeScanValue(rawValue);
    if (!token) {
      publish("error", messages.scanRequired, null, "error");
      inputRef.current?.focus({ preventScroll: true });
      return;
    }
    const now = Date.now();
    const previousScanAt = recentScansRef.current.get(token);
    recentScansRef.current.set(token, now);
    for (const [value, at] of recentScansRef.current) if (now - at > DEDUPE_WINDOW_MS) recentScansRef.current.delete(value);
    if (previousScanAt && now - previousScanAt < DEDUPE_WINDOW_MS) {
      return;
    }
    inputValueRef.current = "";
    setInputValue("");
    const cachedStudent = studentCacheRef.current.get(token) || null;
    const item: QueueItem = { id: createIdempotencyKey(), token, createdAt: now, attempts: 0, student: cachedStudent || undefined };
    queueRef.current.push(item);
    queuedIdsRef.current.add(item.id);
    void saveOfflineItem(item);
    publish("loading", "", null);
    updatePendingCount();
    pumpRef.current();
  }, [messages, publish, updatePendingCount]);
  enqueueScanRef.current = enqueueScan;

  const commitInput = useCallback(() => {
    if (inputDebounceRef.current !== null) window.clearTimeout(inputDebounceRef.current);
    inputDebounceRef.current = null;
    const bufferedValue = inputValueRef.current;
    if (bufferedValue.trim()) void enqueueScan(bufferedValue);
  }, [enqueueScan]);

  const handleInputKeyDown = useCallback((event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    commitInput();
  }, [commitInput]);

  const handleSubmit = useCallback((event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    commitInput();
  }, [commitInput]);

  const restoreOfflineQueue = useCallback(async () => {
    const items = await loadOfflineItems();
    for (const item of items.sort((left, right) => left.createdAt - right.createdAt)) {
      if (queuedIdsRef.current.has(item.id)) continue;
      queuedIdsRef.current.add(item.id);
      queueRef.current.push(item);
    }
    updatePendingCount();
    pumpRef.current();
  }, [updatePendingCount]);

  useEffect(() => {
    mountedRef.current = true;
    inputRef.current?.focus({ preventScroll: true });
    const controller = new AbortController();
    async function syncCache() {
      const storedRows = await loadStudentCache();
      for (const row of storedRows) studentCacheRef.current.set(row.key, row.student);
      try {
        const response = await fetch(`${apiBaseUrl}/scanner/students`, { headers: { Authorization: `Bearer ${authToken}` }, signal: controller.signal });
        const payload = await response.json().catch(() => ({}));
        if (response.ok && Array.isArray(payload.students)) {
          const students = payload.students as CachedScannerStudent[];
          studentCacheRef.current.clear();
          for (const studentValue of students) for (const key of scannerLookupKeys(studentValue)) studentCacheRef.current.set(key, studentValue);
          void saveStudentCache(students);
        }
      } catch (_error) {
        // The persisted cache remains available when the refresh is offline.
      } finally {
        if (!controller.signal.aborted && mountedRef.current) setCacheReady(true);
      }
    }
    void syncCache();
    void restoreOfflineQueue();
    const handleOnline = () => { void restoreOfflineQueue(); };
    window.addEventListener("online", handleOnline);
    return () => {
      mountedRef.current = false;
      controller.abort();
      window.removeEventListener("online", handleOnline);
      if (inputDebounceRef.current !== null) window.clearTimeout(inputDebounceRef.current);
      for (const timer of retryTimersRef.current) window.clearTimeout(timer);
      retryTimersRef.current.clear();
    };
  }, [apiBaseUrl, authToken, restoreOfflineQueue]);

  useEffect(() => {
    const handleGlobalKeyDown = (event: KeyboardEvent) => {
      const rawKey = event.key;
      const normalizedKey = normalizeDigits(rawKey);
      const keyUpper = rawKey.toUpperCase();
      const isFunctionKey = /^F(?:[1-9]|1[0-2])$/.test(rawKey);
      const isDevToolsShortcut =
        isFunctionKey ||
        (event.ctrlKey && event.shiftKey && ["I", "J", "C"].includes(keyUpper)) ||
        (event.metaKey && event.altKey && keyUpper === "I") ||
        (event.ctrlKey && keyUpper === "U");

      if (isDevToolsShortcut) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        return;
      }

      if (event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.target === inputRef.current) return;
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement || (event.target instanceof HTMLElement && event.target.isContentEditable)) return;
      if (rawKey === "Enter") {
        if (!inputValueRef.current.trim()) return;
        event.preventDefault();
        inputRef.current?.focus({ preventScroll: true });
        commitInput();
        return;
      }
      if (!/^[A-Za-z0-9]$/.test(normalizedKey)) return;
      event.preventDefault();
      inputRef.current?.focus({ preventScroll: true });
      updateInput(`${inputValueRef.current}${normalizedKey}`);
    };
    window.addEventListener("keydown", handleGlobalKeyDown, true);
    return () => window.removeEventListener("keydown", handleGlobalKeyDown, true);
  }, [commitInput, updateInput]);

  return {
    inputRef,
    inputValue,
    student,
    message,
    scanState,
    scanning: scanState === "loading",
    pendingCount,
    cacheReady,
    setInputValue: updateInput,
    handleInputKeyDown,
    handleSubmit
  };
}
