import type { ReactNode } from "react";
import { PublicHeader, type PublicHeaderLabels, type PublicLanguage, type PublicTheme } from "./PublicHeader";

export interface PublicLayoutProps {
  children: ReactNode;
  background: ReactNode;
  currentPath: string;
  language: PublicLanguage;
  theme: PublicTheme;
  labels: PublicHeaderLabels;
  downloadUrl: string;
  onLanguageChange: (language: PublicLanguage) => void;
  onToggleTheme: () => void;
  onNavigate?: (path: string) => void;
  variant?: "landing" | "content" | "auth";
}

export function PublicLayout({
  children,
  background,
  currentPath,
  language,
  theme,
  labels,
  downloadUrl,
  onLanguageChange,
  onToggleTheme,
  onNavigate,
  variant = "content"
}: PublicLayoutProps) {
  const footerText = "© 2026 Mr. Ahmed Abdrabo · Designed & Developed by Eng. Hany Hosny";

  const noScrollPage = currentPath === "/about-teacher" || currentPath === "/login";

  return (
    <div className={`landing-shell public-layout public-layout-${variant} ${noScrollPage ? "public-layout-no-scroll" : ""} landing-theme-${theme}`} dir={language} lang={language}>
      {background}
      <div className="landing-overlay public-layout-overlay">
        <PublicHeader
          currentPath={currentPath}
          language={language}
          theme={theme}
          labels={labels}
          downloadUrl={downloadUrl}
          onLanguageChange={onLanguageChange}
          onToggleTheme={onToggleTheme}
          onNavigate={onNavigate}
        />
        {children}
        <footer className="landing-footer public-footer" dir="ltr" lang="en">{footerText}</footer>
      </div>
    </div>
  );
}
