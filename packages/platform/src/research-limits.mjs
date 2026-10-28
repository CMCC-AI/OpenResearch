// Streaming summary refreshes must not consume the budget for decisions or
// session navigation, including clients that still have an older UI open.
export function researchLimit(method, path) {
  if (method === "GET" && path === "/api/projects/activity")
    return { bucket: "activity", maximum: 120 };
  if (["GET", "HEAD"].includes(method)) return { bucket: "read", maximum: 600 };
  return { bucket: "write", maximum: 600 };
}
