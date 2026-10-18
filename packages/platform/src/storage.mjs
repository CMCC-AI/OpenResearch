import { check } from "./security.mjs";

export function storageAccess(config, session, workspace = false) {
  return {
    managed: !!(
      workspace ||
      config.researchOwnerEmail ||
      config.managed ||
      config.privateSpaces
    ),
    canInspect: !!(!workspace && config.researchOwnerEmail && session.is_admin),
    readOnly: true,
  };
}

export async function storageSettings(config, session, fetcher = fetch) {
  const access = storageAccess(config, session);
  if (!access.canInspect) return access;
  // The shared deployment's research backend is local. Never forward cookies
  // or accept a caller-supplied host, workspace, or filesystem path here.
  let data;
  try {
    const response = await fetcher(
      "http://127.0.0.1:4791/api/settings/data-dir",
      {
        signal: AbortSignal.timeout(5000),
        redirect: "error",
      },
    );
    check(
      response.ok &&
        response.headers.get("content-type")?.includes("application/json"),
      502,
      "无法读取服务器存储信息，请稍后重试",
    );
    data = await response.json();
    check(
      typeof data.current === "string" &&
        data.current.length <= 4096 &&
        ["env", "config", "xdg", "default"].includes(data.source),
      502,
      "服务器存储信息格式异常",
    );
  } catch {
    check(false, 502, "无法读取服务器存储信息，请稍后重试");
  }
  return { ...access, current: data.current, source: data.source };
}
