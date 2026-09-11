import {
  DEFAULT_HOME_CONTENT,
  LandingPageContentSchema,
  type LandingPageContent,
  type LandingPageLocale,
  type LocalizedLandingPageContent
} from "@abdrabo/shared/landingContent.js";

export { DEFAULT_HOME_CONTENT, LandingPageContentSchema };
export type { LandingPageContent, LandingPageLocale, LocalizedLandingPageContent };

export function cloneHomeContent(content: LandingPageContent): LandingPageContent {
  return JSON.parse(JSON.stringify(content)) as LandingPageContent;
}

export function normalizeLocalizedHomeContent(value: unknown): LocalizedLandingPageContent {
  const source = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const arabic = LandingPageContentSchema.safeParse(source.ar);
  const english = LandingPageContentSchema.safeParse(source.en);
  return {
    ar: arabic.success ? arabic.data : cloneHomeContent(DEFAULT_HOME_CONTENT.ar),
    en: english.success ? english.data : cloneHomeContent(DEFAULT_HOME_CONTENT.en)
  };
}

export async function fetchHomeContent(apiBaseUrl: string, signal?: AbortSignal): Promise<{ content: LocalizedLandingPageContent; updated_at?: string | null }> {
  const response = await fetch(`${apiBaseUrl}/site-content?page=home`, { signal });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.ok) throw new Error("home_content_load_failed");
  return {
    content: normalizeLocalizedHomeContent(payload.content),
    updated_at: payload.updated_at || null
  };
}
