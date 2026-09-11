export type PublicRouteKind = "landing" | "login" | "content";
export type PublicPageSlug = "about-teacher" | "about-center" | "contact" | "tips";

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
  { path: "/about-center", kind: "content", slug: "about-center" },
  { path: "/contact", kind: "content", slug: "contact" },
  { path: "/tips", kind: "content", slug: "tips" }
];

export function resolvePublicRoute(pathname: string): PublicRoute | null {
  const normalizedPath = pathname.length > 1 ? pathname.replace(/\/$/, "") : pathname;
  return publicRoutes.find((route) => route.path === normalizedPath) || null;
}
