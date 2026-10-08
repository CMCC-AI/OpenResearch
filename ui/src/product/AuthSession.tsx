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

type AccountUser = { id: string; name: string; email: string };

type AuthSessionValue = {
  accountUrl: string;
  loading: boolean;
  user: AccountUser | null;
  deepLiteratureUrl: string | null;
  login: () => void;
  logout: () => Promise<void>;
};

const AuthSessionContext = createContext<AuthSessionValue | null>(null);
const protectedPrefixes = ["/projects", "/discover", "/literature", "/capabilities"];

export function AuthSessionProvider({
  runtime,
  children,
}: {
  runtime: RuntimeInfo;
  children: ReactNode;
}) {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const cloud = isCloudWorkspace();
  const accountUrl = cloud ? `${location.protocol}//${location.host.replace(/^[0-9a-f-]{36}\./, "")}` : runtime.kind === "local"
    ? runtime.accountUrl || "http://localhost:5300"
    : "";
  const [loading, setLoading] = useState(runtime.kind === "local");
  const [user, setUser] = useState<AccountUser | null>(null);
  const [deepLiteratureUrl, setDeepLiteratureUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!accountUrl) {
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    fetch(cloud ? "/_platform/context" : `${accountUrl}/api/platform/browser-session`, {
      credentials: "include",
      signal: controller.signal,
    })
      .then(async (response) => {
        if (response.status === 401) return null;
        if (!response.ok) throw new Error(`Account service returned ${response.status}`);
        return response.json() as Promise<{
          user: AccountUser;
          deepLiteratureUrl: string | null;
        }>;
      })
      .then((session) => {
        setUser(session?.user ?? null);
        setDeepLiteratureUrl(session?.deepLiteratureUrl ?? null);
      })
      .catch((error) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setUser(null);
        setDeepLiteratureUrl(null);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [accountUrl, cloud]);

  const login = useCallback(() => {
    if (accountUrl) window.location.assign(accountUrl);
  }, [accountUrl]);

  const logout = useCallback(async () => {
    if (accountUrl) {
      await fetch(cloud ? "/_platform/logout" : `${accountUrl}/api/platform/browser-logout`, {
        method: "POST",
        credentials: "include",
      }).catch(() => undefined);
    }
    setUser(null);
    setDeepLiteratureUrl(null);
    window.location.assign(cloud ? accountUrl : "/");
  }, [accountUrl, cloud]);

  const value = useMemo(
    () => ({ accountUrl, loading, user, deepLiteratureUrl, login, logout }),
    [accountUrl, deepLiteratureUrl, loading, login, logout, user],
  );
  const protectedRoute = protectedPrefixes.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );

  if (protectedRoute && loading)
    return <main className="app flex h-full items-center justify-center bg-background"><Spinner /></main>;
  if (protectedRoute && !user) return <Navigate to="/" replace />;
  return <AuthSessionContext value={value}>{children}</AuthSessionContext>;
}

export function useAuthSession() {
  const value = useContext(AuthSessionContext);
  if (!value) throw new Error("AuthSessionProvider is missing");
  return value;
}
