import { z } from "zod";

export interface GradeItem {
  id: string;
  title: string;
  stage: "primary" | "prep" | "secondary" | "special";
  badge: string;
  comingSoon: boolean;
  sortOrder: number;
}

export interface FeatureItem {
  id: string;
  num: string;
  title: string;
  desc: string;
}

export interface StatItem {
  id: string;
  value: string;
  label: string;
}

export interface LandingPageContent {
  hero: {
    badge: string;
    title: string;
    subtitle: string;
    primaryCtaText: string;
    secondaryCtaText: string;
  };
  grades: GradeItem[];
  features: FeatureItem[];
  stats: StatItem[];
}

export declare const GradeItemSchema: z.ZodType<GradeItem>;
export declare const FeatureItemSchema: z.ZodType<FeatureItem>;
export declare const StatItemSchema: z.ZodType<StatItem>;
export declare const LandingPageContentSchema: z.ZodType<LandingPageContent>;

export type LandingPageLocale = "ar" | "en";
export type LocalizedLandingPageContent = Readonly<Record<LandingPageLocale, LandingPageContent>>;
export declare const DEFAULT_HOME_CONTENT: LocalizedLandingPageContent;
