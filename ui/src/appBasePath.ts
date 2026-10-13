export function stripAppBase(pathname: string): string {
  return pathname === "/sona" ? "/" : pathname.startsWith("/sona/") ? pathname.slice(5) : pathname;
}
export function appBaseFor(pathname: string): string {
  return pathname === "/sona" || pathname.startsWith("/sona/") ? "/sona" : "";
}
export const appBasePath = typeof window === "undefined" ? "" : appBaseFor(window.location.pathname);
export const appHref = (path: string) => `${appBasePath}${path}`;
