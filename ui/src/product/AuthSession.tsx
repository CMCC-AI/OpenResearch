import { stripAppBase, appHref } from "../appBasePath";
import { Navigate, useRouterState } from "@tanstack/react-router";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { RuntimeInfo } from "../api";
import { Spinner } from "../components/ui";
import { isCloudWorkspace } from "./CloudWorkspace";
import type { StoragePolicy } from "../storagePolicy";

type AccountUser = { id: string; name: string; email: string; isAdmin?: boolean };

type AuthSessionValue = {
  accountUrl: string;
  loading: boolean;
  user: AccountUser | null;
  canAccessResearch: boolean;
  deepLiteratureUrl: string | null;
  storage: StoragePolicy | null;
  login: () => void;
  logout: () => Promise<void>;
};

const AuthSessionContext = createContext<AuthSessionValue | null>(null);
const protectedPrefixes = ["/projects", "/discover", "/literature", "/capabilities", "/cases"];

export function AuthSessionProvider({
  runtime,
  children,
}: {
  runtime: RuntimeInfo;
  children: ReactNode;
}) {
  const pathname = useRouterState({ select: (state) => stripAppBase(state.location.pathname) });
  const cloud = isCloudWorkspace();
  const accountUrl = cloud ? `${location.protocol}//${location.host.replace(/^[0-9a-f-]{36}\./, "")}` : runtime.kind === "local"
    ? runtime.accountUrl || "http://localhost:5300"
    : "";
  const [loading, setLoading] = useState(runtime.kind === "local");
  const [user, setUser] = useState<AccountUser | null>(null);
  const [canAccessResearch, setCanAccessResearch] = useState(false);
  const [deepLiteratureUrl, setDeepLiteratureUrl] = useState<string | null>(null);
  const [storage, setStorage] = useState<StoragePolicy | null>(null);

  useEffect(() => {
    if (!accountUrl) {
      setStorage(null);
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setStorage(null);
    fetch(cloud ? "/_platform/context" : `${accountUrl}/api/platform/catalog-session`, {
      credentials: "include",
      signal: controller.signal,
    })
      .then(async (response) => {
        if (response.status === 401) return null;
        if (!response.ok) throw new Error(`Account service returned ${response.status}`);
        return response.json() as Promise<{
          user: AccountUser;
          canAccessResearch?: boolean;
          deepLiteratureUrl: string | null;
          storage?: StoragePolicy;
        }>;
      })
      .then((session) => {
        if (controller.signal.aborted) return;
        setUser(session?.user ?? null);
        setCanAccessResearch(session?.canAccessResearch ?? Boolean(session));
        setDeepLiteratureUrl(session?.deepLiteratureUrl ?? null);
        setStorage(session?.storage ?? null);
      })
      .catch((error) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setUser(null);
        setCanAccessResearch(false);
        setDeepLiteratureUrl(null);
        setStorage(null);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [accountUrl, cloud]);

  const login = useCallback(() => {
    if (accountUrl) {
      const sharedOrigin = !cloud && new URL(accountUrl, location.href).origin === location.origin;
      window.location.assign(sharedOrigin ? `${accountUrl}/_account/login` : accountUrl);
    }
  }, [accountUrl, cloud]);

  const logout = useCallback(async () => {
    if (accountUrl) {
      await fetch(cloud ? "/_platform/logout" : `${accountUrl}/api/platform/browser-logout`, {
        method: "POST",
        credentials: "include",
      }).catch(() => undefined);
    }
    setUser(null);
    setCanAccessResearch(false);
    setDeepLiteratureUrl(null);
    setStorage(null);
    window.location.assign(cloud ? accountUrl : appHref("/"));
  }, [accountUrl, cloud]);

  const value = useMemo(
    () => ({ accountUrl, loading, user, canAccessResearch, deepLiteratureUrl, storage, login, logout }),
    [accountUrl, deepLiteratureUrl, storage, loading, login, logout, user, canAccessResearch],
  );
  const protectedRoute = protectedPrefixes.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );

  if ((protectedRoute || pathname === "/") && loading)
    return <main className="app flex h-full items-center justify-center bg-background"><Spinner /></main>;
  if (protectedRoute && !user) return <Navigate to="/" replace />;
  if (user && !canAccessResearch && protectedRoute && !pathname.startsWith("/cases")) return <Navigate to="/cases" replace />;
  if (pathname === "/" && user) return <Navigate to={canAccessResearch ? "/projects" : "/cases"} replace />;
  return <AuthSessionContext value={value}>{children}</AuthSessionContext>;
}

export function useAuthSession() {
  const value = useContext(AuthSessionContext);
  if (!value) throw new Error("AuthSessionProvider is missing");
  return value;
}

export function useOptionalAuthSession() {
  return useContext(AuthSessionContext);
}
