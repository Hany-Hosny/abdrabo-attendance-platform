import { motion } from "framer-motion";
import { useState, type ReactNode, type MouseEvent } from "react";

export type PublicLanguage = "ar" | "en";
export type PublicTheme = "dark" | "light";

export interface NavItem {
  path: string;
  label: string;
  icon?: ReactNode;
}

export interface PublicHeaderLabels {
  brandName: string;
  brandDescription: string;
  teacherLogin: string;
  home: string;
  studentLogin: string;
  aboutTeacher: string;
  contact: string;
  mainNavigation: string;
  languageSelector: string;
  themeToLight: string;
  themeToDark: string;
}

export interface PublicHeaderProps {
  currentPath: string;
  language: PublicLanguage;
  theme: PublicTheme;
  labels: PublicHeaderLabels;
  onLanguageChange: (language: PublicLanguage) => void;
  onToggleTheme: () => void;
  onNavigate?: (path: string) => void;
}

const navPaths = ["/", "/login", "/about-teacher", "/contact", "/teacher/login"] as const;

function normalizePath(path: string) {
  const pathname = path.split("?")[0].split("#")[0];
  const normalizedPath = pathname.length > 1 ? pathname.replace(/\/$/, "") : pathname;
  return normalizedPath === "/student/login" ? "/login" : normalizedPath;
}

function ThemeIcon({ theme }: { theme: PublicTheme }) {
  if (theme === "dark") {
    return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 15.2A8.5 8.5 0 0 1 8.8 4 8.5 8.5 0 1 0 20 15.2Z" /></svg>;
  }
  return <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" /></svg>;
}

export function PublicHeader({
  currentPath,
  language,
  theme,
  labels,
  onLanguageChange,
  onToggleTheme,
  onNavigate
}: PublicHeaderProps) {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const activePath = normalizePath(currentPath);
  const navItems: NavItem[] = [
    { path: "/", label: labels.home },
    { path: "/login", label: labels.studentLogin },
    { path: "/about-teacher", label: labels.aboutTeacher },
    { path: "/contact", label: labels.contact }
  ];

  function handleNavigation(event: MouseEvent<HTMLAnchorElement>, item: NavItem) {
    if (!onNavigate || !navPaths.includes(item.path as (typeof navPaths)[number])) return;
    event.preventDefault();
    onNavigate(item.path);
  }

  function handleMobileNavigation(event: MouseEvent<HTMLAnchorElement>, item: NavItem) {
    handleNavigation(event, item);
    setMobileMenuOpen(false);
  }

  const themeLabel = theme === "dark" ? labels.themeToLight : labels.themeToDark;

  return (
    <header className="landing-header public-header" dir={language}>
      <div className="landing-header-inner">
        <div className="landing-brand">
          <a
            className="public-header-profile-door"
            href="/teacher/login"
            tabIndex={0}
            aria-label={labels.teacherLogin}
            onClick={(event) => handleNavigation(event, { path: "/teacher/login", label: labels.teacherLogin })}
          >
            <img src="/assets/teacher-profile.png" alt="" />
          </a>
          <span>
            <strong>{labels.brandName}</strong>
            <small>{labels.brandDescription}</small>
          </span>
        </div>

        <nav className="landing-nav" aria-label={labels.mainNavigation}>
          {navItems.map((item) => {
            const isActive = normalizePath(item.path) === activePath;
            return (
              <a
                className={isActive ? "is-active" : ""}
                href={item.path}
                key={item.path}
                tabIndex={0}
                aria-current={isActive ? "page" : undefined}
                onClick={(event) => handleNavigation(event, item)}
              >
                {item.icon}
                <span>{item.label}</span>
                {isActive ? (
                  <motion.span
                    className="public-active-tab-indicator"
                    layoutId="activeTabIndicator"
                    transition={{ type: "spring", stiffness: 420, damping: 32, mass: 0.7 }}
                    aria-hidden="true"
                  />
                ) : null}
              </a>
            );
          })}
        </nav>

        <div className="landing-header-actions public-header-actions">
          <div className="landing-language-switcher" aria-label={labels.languageSelector}>
            <button type="button" tabIndex={0} className={language === "ar" ? "is-active" : ""} onClick={() => onLanguageChange("ar")} aria-pressed={language === "ar"}>AR</button>
            <button type="button" tabIndex={0} className={language === "en" ? "is-active" : ""} onClick={() => onLanguageChange("en")} aria-pressed={language === "en"}>EN</button>
          </div>
          <button className="public-theme-toggle" type="button" tabIndex={0} onClick={onToggleTheme} aria-label={themeLabel} title={themeLabel} aria-pressed={theme === "light"}>
            <ThemeIcon theme={theme} />
          </button>
          <button
            className="public-mobile-menu-toggle"
            type="button"
            tabIndex={0}
            aria-label={labels.mainNavigation}
            aria-controls="public-mobile-menu"
            aria-expanded={mobileMenuOpen}
            onClick={() => setMobileMenuOpen((open) => !open)}
          >
            <span aria-hidden="true">☰</span>
          </button>
        </div>
      </div>
      {mobileMenuOpen ? (
        <div className="public-mobile-menu-backdrop" role="presentation" onClick={(event) => { if (event.target === event.currentTarget) setMobileMenuOpen(false); }}>
          <div className="public-mobile-menu" id="public-mobile-menu" role="dialog" aria-modal="true" aria-label={labels.mainNavigation}>
            <div className="public-mobile-menu-heading">
              <strong>{labels.mainNavigation}</strong>
              <button className="public-mobile-menu-close" type="button" aria-label={labels.mainNavigation} onClick={() => setMobileMenuOpen(false)}>×</button>
            </div>
            <nav className="public-mobile-menu-links" aria-label={labels.mainNavigation}>
              {navItems.map((item) => {
                const isActive = normalizePath(item.path) === activePath;
                return (
                  <a
                    className={isActive ? "is-active" : ""}
                    href={item.path}
                    key={item.path}
                    aria-current={isActive ? "page" : undefined}
                    onClick={(event) => handleMobileNavigation(event, item)}
                  >
                    <span>{item.label}</span>
                    <span aria-hidden="true">{language === "ar" ? "←" : "→"}</span>
                  </a>
                );
              })}
              <a href="/teacher/login" onClick={(event) => handleMobileNavigation(event, { path: "/teacher/login", label: labels.teacherLogin })}>
                <span>{labels.teacherLogin}</span>
                <span aria-hidden="true">{language === "ar" ? "←" : "→"}</span>
              </a>
            </nav>
          </div>
        </div>
      ) : null}
    </header>
  );
}
