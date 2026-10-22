import type { Harness, HarnessSetupCommands } from "./api";

/** A note command that is one of the harness's setup commands runs through the
 * setup route, which owns install/login/update semantics (telemetry, OpenCode's
 * isolated store, verification); `shell` keeps the terminal open afterwards. */
export function harnessSetupPath(h: Harness, setup: HarnessSetupCommands | undefined, command: string) {
  if (!setup) return undefined;
  // Install notes quote the vendor one-liner (`curl … | bash`) while the shown
  // setup command fetches to a temp file first, so exact equality would drop the
  // play button from every install note. The shared bootstrap URL identifies it.
  const installsSameSource = setup.installUrl !== undefined && command.includes(setup.installUrl);
  const action = command === setup.login ? "login" : command === setup.install ? "install" : command === setup.update ? "update" : installsSameSource ? "install" : null;
  if (!action) return undefined;
  if (action !== "install" && (!h.installed || h.installBroken)) return undefined;
  return `/api/harnesses/setup?${new URLSearchParams({ harness: h.id, action, shell: "true" })}`;
}
