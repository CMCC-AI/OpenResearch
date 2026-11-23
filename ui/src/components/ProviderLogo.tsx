import type { HarnessModel } from "../api";
import { cn } from "./ui/cn";

export type ProviderKey =
  | "jiutian"
  | "moonshot"
  | "deepseek"
  | "openai"
  | "anthropic"
  | "zhipuai"
  | "dashscope"
  | "google"
  | "openrouter"
  | "siliconflow"
  | "opencode"
  | "local"
  | "other";

export interface ProviderMeta {
  key: ProviderKey;
  groupId: string;
  label: string;
}

const PROVIDER_META: Record<ProviderKey, Omit<ProviderMeta, "groupId">> = {
  jiutian: { key: "jiutian", label: "九天 Jiutian" },
  moonshot: { key: "moonshot", label: "Kimi / Moonshot" },
  deepseek: { key: "deepseek", label: "DeepSeek" },
  openai: { key: "openai", label: "OpenAI" },
  anthropic: { key: "anthropic", label: "Anthropic" },
  zhipuai: { key: "zhipuai", label: "智谱 GLM" },
  dashscope: { key: "dashscope", label: "通义千问 Qwen" },
  google: { key: "google", label: "Google Gemini" },
  openrouter: { key: "openrouter", label: "OpenRouter" },
  siliconflow: { key: "siliconflow", label: "硅基流动 SiliconFlow" },
  opencode: { key: "opencode", label: "OpenCode" },
  local: { key: "local", label: "本地模型" },
  other: { key: "other", label: "其他模型" },
};

function normalizeProviderKey(rawProvider: string, modelId: string): ProviderKey {
  const p = rawProvider.toLowerCase();
  const id = modelId.toLowerCase();
  if (p.startsWith("orx-local-") || id.startsWith("orx-local-")) return "local";
  if (p === "jt236b" || p === "jiutian" || p.includes("jiutian")) return "jiutian";
  if (p.startsWith("moonshot") || p.includes("kimi")) return "moonshot";
  if (p.includes("deepseek")) return "deepseek";
  if (p === "openai" || p.startsWith("openai-")) return "openai";
  if (p === "anthropic" || p.startsWith("claude")) return "anthropic";
  if (p.startsWith("zhipu") || p === "glm") return "zhipuai";
  if (p === "dashscope" || p.includes("qwen") || p.includes("alibaba")) return "dashscope";
  if (p === "google" || p.includes("gemini")) return "google";
  if (p === "openrouter") return "openrouter";
  if (p === "siliconflow") return "siliconflow";
  if (p === "opencode") return "opencode";
  return "other";
}

function prettifyProviderId(rawProvider: string): string {
  if (!rawProvider) return PROVIDER_META.other.label;
  return rawProvider
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function resolveModelProvider(modelId: string): ProviderMeta {
  const slashIndex = modelId.indexOf("/");
  const rawProvider = slashIndex > 0 ? modelId.slice(0, slashIndex) : "";
  const key = normalizeProviderKey(rawProvider, modelId);
  if (key === "other" && rawProvider) {
    return {
      key: "other",
      groupId: `other:${rawProvider.toLowerCase()}`,
      label: prettifyProviderId(rawProvider),
    };
  }
  const meta = PROVIDER_META[key];
  return { ...meta, groupId: key };
}

export interface ProviderModelGroup {
  groupId: string;
  key: ProviderKey;
  label: string;
  models: HarnessModel[];
}

export function groupModelsByProvider(models: HarnessModel[]): ProviderModelGroup[] {
  const groups: ProviderModelGroup[] = [];
  const byId = new Map<string, ProviderModelGroup>();

  for (const model of models) {
    const meta = resolveModelProvider(model.id);
    let group = byId.get(meta.groupId);
    if (!group) {
      group = {
        groupId: meta.groupId,
        key: meta.key,
        label: meta.label,
        models: [],
      };
      byId.set(meta.groupId, group);
      groups.push(group);
    }
    group.models.push(model);
  }

  return groups;
}

export function ProviderLogo({
  providerKey,
  size = 14,
  className,
}: {
  providerKey: ProviderKey;
  size?: number;
  className?: string;
}) {
  const props = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    xmlns: "http://www.w3.org/2000/svg",
    className: cn("shrink-0", className),
    "aria-hidden": true as const,
  };

  switch (providerKey) {
    case "jiutian":
      return (
        <svg {...props}>
          <circle cx="12" cy="12" r="9.5" stroke="#1677FF" strokeWidth="1.75" />
          <path
            d="M12 5.5L13.7 10.3L18.5 12L13.7 13.7L12 18.5L10.3 13.7L5.5 12L10.3 10.3L12 5.5Z"
            fill="#1677FF"
          />
        </svg>
      );
    case "moonshot":
      return (
        <svg {...props}>
          <path
            d="M14.8 4.2A8.2 8.2 0 1 0 19.8 15.7A6.8 6.8 0 0 1 14.8 4.2Z"
            fill="currentColor"
          />
          <circle cx="17.5" cy="7" r="1.6" fill="currentColor" />
        </svg>
      );
    case "deepseek":
      return (
        <svg {...props}>
          <path
            d="M4.5 13.2C4.5 9.4 7.7 6.5 12.2 6.5C15.8 6.5 18.8 8.7 19.5 11.7C20.2 11.5 21 11.1 21.5 10.5C21.3 13.1 19.7 15.2 17.5 16.2C15.9 17.1 14 17.5 11.8 17.5C7.6 17.5 4.5 15.8 4.5 13.2Z"
            fill="#4D6BFE"
          />
          <circle cx="10.2" cy="11.2" r="1.2" fill="#FFFFFF" />
        </svg>
      );
    case "openai":
      return (
        <svg {...props}>
          <path
            d="M12 3.5L15.6 5.6V9.8L12 11.9L8.4 9.8V5.6L12 3.5Z"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinejoin="round"
          />
          <path
            d="M15.6 5.6L19.2 7.7V11.9L15.6 14M8.4 5.6L4.8 7.7V11.9L8.4 14M8.4 14L4.8 16.1L8.4 18.2L12 16.1M15.6 14L19.2 16.1L15.6 18.2L12 16.1M12 16.1V20.5"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      );
    case "anthropic":
      return (
        <svg {...props}>
          <path
            d="M13.8 5L19.2 19H16.4L15.1 15.5H9.6L8.3 19H5.5L10.9 5H13.8ZM10.5 13.1H14.2L12.35 8.1L10.5 13.1Z"
            fill="#D97757"
          />
        </svg>
      );
    case "zhipuai":
      return (
        <svg {...props}>
          <rect x="3.5" y="3.5" width="17" height="17" rx="4" fill="#3B82F6" />
          <path
            d="M7.5 8H16.5L7.5 16H16.5"
            stroke="#FFFFFF"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      );
    case "dashscope":
      return (
        <svg {...props}>
          <path
            d="M12 4L18.9 8V16L12 20L5.1 16V8L12 4Z"
            stroke="#6366F1"
            strokeWidth="1.8"
            strokeLinejoin="round"
          />
          <circle cx="12" cy="12" r="2.6" fill="#6366F1" />
        </svg>
      );
    case "google":
      return (
        <svg {...props}>
          <path
            d="M12 3.5C12.7 8.1 15.9 11.3 20.5 12C15.9 12.7 12.7 15.9 12 20.5C11.3 15.9 8.1 12.7 3.5 12C8.1 11.3 11.3 8.1 12 3.5Z"
            fill="#4285F4"
          />
        </svg>
      );
    case "openrouter":
      return (
        <svg {...props}>
          <circle cx="6" cy="12" r="2.2" stroke="currentColor" strokeWidth="1.7" />
          <circle cx="18" cy="7" r="2.2" stroke="currentColor" strokeWidth="1.7" />
          <circle cx="18" cy="17" r="2.2" stroke="currentColor" strokeWidth="1.7" />
          <path
            d="M8.2 11.2L15.8 7.8M8.2 12.8L15.8 16.2"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
          />
        </svg>
      );
    case "siliconflow":
      return (
        <svg {...props}>
          <path
            d="M4.5 9.5C7 7 9.5 7 12 9.5C14.5 12 17 12 19.5 9.5M4.5 14.5C7 12 9.5 12 12 14.5C14.5 17 17 17 19.5 14.5"
            stroke="#7C3AED"
            strokeWidth="2"
            strokeLinecap="round"
          />
        </svg>
      );
    case "opencode":
      return (
        <svg {...props}>
          <rect x="3.5" y="4.5" width="17" height="15" rx="3" stroke="currentColor" strokeWidth="1.7" />
          <path
            d="M8 9.5L11 12L8 14.5M12.5 14.5H16"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      );
    case "local":
      return (
        <svg {...props}>
          <rect x="6" y="6" width="12" height="12" rx="2" stroke="currentColor" strokeWidth="1.6" />
          <rect x="9.5" y="9.5" width="5" height="5" rx="0.8" fill="currentColor" />
          <path
            d="M9 3.5V6M15 3.5V6M9 18V20.5M15 18V20.5M3.5 9H6M3.5 15H6M18 9H20.5M18 15H20.5"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
          />
        </svg>
      );
    default:
      return (
        <svg {...props}>
          <circle cx="12" cy="12" r="8.5" stroke="currentColor" strokeWidth="1.6" />
          <path
            d="M3.8 12H20.2M12 3.5C14.5 6.3 14.5 17.7 12 20.5C9.5 17.7 9.5 6.3 12 3.5Z"
            stroke="currentColor"
            strokeWidth="1.5"
          />
        </svg>
      );
  }
}
