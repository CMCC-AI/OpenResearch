import { useMutation, useQuery } from "@tanstack/react-query";
import { setScopedQueryData } from "../queries/client";
import { getLitSourcesQuery } from "../queries/settings";
import { m } from "../paraglide/messages.js";
// Literature-source toggles shown inline in the composer chat-settings panel:
// which sources discovery and paper reading may use. State lives in settings.json
// (same `/api/settings/lit-sources` endpoint the CLI enforces).

import { setLitSources } from "../api";
import { Database, ExternalLink } from "lucide-react";
import { literatureSources, externalLiteratureSources } from "../literatureSources";
import { LitSourceLogo, type LitSource } from "./LitSourceLogo";
import { MenuItem, SwitchIndicator } from "./ui";

export function LitSourcesList() {
  const options = getLitSourcesQuery();
  const { data: settings } = useQuery(options);
  const mutation = useMutation({
    mutationFn: setLitSources,
    onSuccess: (settings) => setScopedQueryData(options.queryKey, settings),
  });
  const saving = mutation.isPending;
  const toggle = (key: LitSource) => {
    if (settings && !saving) mutation.mutate({ ...settings, [key]: !settings[key] });
  };

  if (!settings) return <div className="py-1.5 px-2 text-muted text-sm">{m.lit_sources_picker_loading()}</div>;

  return (
    <div className="flex flex-col">
      {literatureSources.map(({ id: key, name }) => {
        const on = settings[key];
        return (
          <MenuItem
            key={key}
            type="button"
            role="switch"
            aria-checked={on}

            disabled={saving}
            onClick={() => toggle(key)}
          >
            <span className="inline-flex items-center gap-[9px]">
              <LitSourceLogo source={key} size={16} decorative />
              {name}
            </span>
            <SwitchIndicator checked={on} aria-hidden="true" />
          </MenuItem>
        );
      })}
      <div className="mt-1 flex flex-col border-t border-border pt-1">
        {externalLiteratureSources.map(({ id, name, url }) => <a key={id} href={url} target="_blank" rel="noopener noreferrer" aria-label={`${name} 官网检索（新窗口）`} className="flex items-center justify-between gap-3 rounded-md px-2 py-2 text-sm text-text no-underline hover:bg-surface">
          <span className="inline-flex items-center gap-2"><Database size={16} />{name}</span>
          <span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap text-xs text-subtext">官网检索<ExternalLink size={12} /></span>
        </a>)}
      </div>
    </div>
  );
}
