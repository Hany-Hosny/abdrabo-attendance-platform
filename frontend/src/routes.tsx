export type PublicRouteKind = "landing" | "login" | "content";
export type PublicPageSlug = "about-teacher" | "contact";

export interface PublicRoute {
  path: string;
  kind: PublicRouteKind;
  slug?: PublicPageSlug;
}

export const publicRoutes: readonly PublicRoute[] = [
  { path: "/", kind: "landing" },
  { path: "/login", kind: "login" },
  { path: "/student/login", kind: "login" },
  { path: "/about-teacher", kind: "content", slug: "about-teacher" },
  { path: "/contact", kind: "content", slug: "contact" }
];

export function resolvePublicRoute(pathname: string): PublicRoute | null {
  const normalizedPath = pathname.length > 1 ? pathname.replace(/\/$/, "") : pathname;
  return publicRoutes.find((route) => route.path === normalizedPath) || null;
}
