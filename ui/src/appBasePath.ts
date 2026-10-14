export function stripAppBase(pathname: string): string {
  return pathname === "/mobilesci" ? "/" : pathname.startsWith("/mobilesci/") ? pathname.slice("/mobilesci".length) : pathname;
}
export function appBaseFor(pathname: string): string {
  return pathname === "/mobilesci" || pathname.startsWith("/mobilesci/") ? "/mobilesci" : "";
}
export const appBasePath = typeof window === "undefined" ? "" : appBaseFor(window.location.pathname);
export const appHref = (path: string) => `${appBasePath}${path}`;
