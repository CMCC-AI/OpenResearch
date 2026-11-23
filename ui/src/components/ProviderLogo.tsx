import { useId } from "react";
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
  const uid = useId().replace(/:/g, "");
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
    case "jiutian": {
      const gradId = `jt-${uid}`;
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 38 38"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          className={cn("shrink-0", className)}
          aria-hidden="true"
        >
          <path
            d="M18.6194 12.2951C17.7671 11.979 17.2094 12.2951 17.2094 12.2951C17.2094 12.2951 17.3314 11.1335 16.3001 10.4751C15.2686 9.81562 13.8098 9.29046 14.1191 9.89979C14.4831 10.6191 14.8004 11.6719 14.8004 11.6719C14.8004 11.6719 15.3026 12.5868 14.7543 12.7754C12.6669 13.4851 10.3436 14.5953 10.3436 14.5953C10.3436 14.5953 9.48443 15.1626 11.5256 15.9361C12.2423 16.2076 13.7989 15.4571 13.7989 15.4571C13.7989 15.4571 12.6616 18.4226 11.3438 19.0496C10.3613 19.5191 10.1739 20.0023 10.4344 20.1991C10.6964 20.3973 11.1646 21.2306 13.4813 18.9058C14.6444 17.74 16.3476 14.3078 16.3476 14.3078L17.4834 13.8286C17.4834 13.8286 15.9839 16.615 15.8481 18.1403C15.7369 19.3943 16.4426 20.7651 17.9843 21.1098C19.2219 21.3866 20.2236 21.1966 21.6228 20.9415C20.7854 24.3276 20.1529 25.412 17.2121 26.3306C15.7016 26.8151 17.9069 28.0136 20.8044 26.4746C23.3749 25.1093 22.8306 24.0005 22.8944 22.8821C22.9324 22.2158 23.0478 21.5563 23.2364 20.9185C23.2364 20.9185 24.1701 20.5005 28.2606 25.6128C31.4579 29.6081 32.2696 28.1466 34.8969 27.9606C37.5244 27.7733 34.6433 26.2615 32.6699 25.1336C30.6953 24.006 30.4401 24.2868 27.7136 21.9716C24.9871 19.6563 24.2598 19.2898 24.2598 19.2898C24.2598 19.2898 26.4609 17.7223 28.1683 17.3261C29.8783 16.9285 29.2159 16.372 28.1683 15.7001C27.1219 15.0285 26.7216 15.2931 25.6223 16.083C24.5244 16.8728 24.3506 16.562 24.3506 16.562C24.3506 16.562 24.1524 16.6435 24.0318 16.1793C23.9503 15.8645 23.6924 15.384 23.8959 14.9335C24.0996 14.4841 24.5298 14.2371 24.8501 13.9753C25.1718 13.7133 26.7189 12.4838 27.5318 12.0603C28.7396 11.4293 28.4955 10.5593 27.0784 9.90378C25.6589 9.24961 25.5679 9.23878 25.1689 9.66495C24.7699 10.0911 23.8906 10.8566 22.9406 11.1496C21.9906 11.4428 20.5778 10.7643 20.9863 11.9151C21.3934 13.0673 21.7273 13.1976 22.3041 13.4961C22.8809 13.7948 22.5076 16.2105 22.3041 17.3275C22.1698 18.101 20.8058 18.8256 19.5314 19.1486C18.2571 19.4703 16.7791 19.8598 17.4849 17.8553C18.1906 15.8495 18.8417 14.6688 19.3034 14.2141C19.7689 13.7595 20.1069 12.8475 18.6194 12.2951Z"
            fill={`url(#${gradId})`}
          />
          <path
            d="M27.1419 37.871L23.7356 36.2507L24.4181 34.4945L26.3046 35.3387C26.8569 33.9408 27.8518 31.4015 29.0704 28.371C29.3961 28.8365 29.7911 29.1718 30.5213 29.5965C28.4271 34.808 27.1419 37.871 27.1419 37.871ZM32.2746 24.2997C31.7236 24.001 31.4903 23.8885 30.5213 23.4175C31.9585 20.0797 33.3971 16.7425 34.8369 13.4058L32.7335 12.506L33.5164 10.7282L37.3069 12.3758C37.3069 12.3758 35.2021 17.3755 32.2746 24.2997ZM14.7838 3.24216L12.7996 2.37899L3.09346 24.4017L5.11012 25.2833L4.42061 26.8128L0.664117 25.2198L11.7873 0L15.51 1.615L14.7838 3.24216Z"
            fill="#666666"
          />
          <defs>
            <linearGradient id={gradId} x1="14.5394" y1="15.8595" x2="40.4855" y2="41.0177" gradientUnits="userSpaceOnUse">
              <stop stopColor="#00CDDE" />
              <stop offset="0.2" stopColor="#0BACE2" />
              <stop offset="0.56" stopColor="#248FED" />
              <stop offset="1" stopColor="#1F72F1" />
            </linearGradient>
          </defs>
        </svg>
      );
    }
    case "moonshot":
      return (
        <svg {...props}>
          <path
            d="M5.5 4.8H8.1V11.2L14.2 4.8H17.5L11.4 11.4L17.8 19.2H14.5L9.5 13.1L8.1 14.6V19.2H5.5V4.8Z"
            fill="currentColor"
          />
          <circle cx="19" cy="6.2" r="1.7" fill="currentColor" />
        </svg>
      );
    case "deepseek":
      return (
        <svg {...props}>
          <path
            d="M4.2 13.6C4.2 9.4 7.5 6.4 12 6.4C15.6 6.4 18.6 8.6 19.3 11.7C20.2 11.4 21.1 10.9 21.8 10.1C21.5 13 19.8 15.2 17.5 16.3C15.9 17.2 14 17.6 11.7 17.6C7.4 17.6 4.2 16 4.2 13.6Z"
            fill="#4D6BFE"
          />
          <path
            d="M11.6 6.6C11.9 5.2 12.9 4.2 14.3 4C13.7 5 13.5 5.9 13.6 6.8"
            fill="#4D6BFE"
          />
          <circle cx="9.6" cy="11.4" r="1.15" fill="#FFFFFF" />
        </svg>
      );
    case "openai":
      return (
        <svg {...props}>
          <path
            d="M12 3.3C10.1 3.3 8.4 4.4 7.6 6.1C5.9 6.5 4.5 7.7 3.9 9.4C3.3 11.1 3.7 13 4.8 14.4C4.2 16.1 4.6 18 5.9 19.3C7.2 20.6 9.1 21 10.8 20.4C12.1 21.5 14 21.8 15.7 21.2C17.4 20.6 18.6 19.1 18.9 17.3C20.3 16.3 21 14.5 20.7 12.7C20.4 10.9 19.1 9.4 17.4 8.8C17.3 7 16.3 5.4 14.7 4.5C13.9 3.7 13 3.3 12 3.3Z"
            stroke="currentColor"
            strokeWidth="1.5"
          />
          <path
            d="M9.6 8.2L14.4 8.2L16.8 12.3L14.4 16.4L9.6 16.4L7.2 12.3L9.6 8.2Z"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinejoin="round"
          />
        </svg>
      );
    case "anthropic":
      return (
        <svg {...props}>
          <path
            d="M12 3.5V20.5M3.5 12H20.5M6 6L18 18M18 6L6 18M8.6 4.2L15.4 19.8M15.4 4.2L8.6 19.8M4.2 8.6L19.8 15.4M19.8 8.6L4.2 15.4"
            stroke="#D97757"
            strokeWidth="1.65"
            strokeLinecap="round"
          />
        </svg>
      );
    case "zhipuai":
      return (
        <svg {...props}>
          <circle cx="12" cy="5.5" r="1.4" fill="#4F8BFF" />
          <circle cx="12" cy="18.5" r="1.4" fill="#4F8BFF" />
          <circle cx="5.5" cy="12" r="1.4" fill="#4F8BFF" />
          <circle cx="18.5" cy="12" r="1.4" fill="#4F8BFF" />
          <circle cx="7.4" cy="7.4" r="1.3" fill="#4F8BFF" />
          <circle cx="16.6" cy="7.4" r="1.3" fill="#4F8BFF" />
          <circle cx="7.4" cy="16.6" r="1.3" fill="#4F8BFF" />
          <circle cx="16.6" cy="16.6" r="1.3" fill="#4F8BFF" />
          <circle cx="12" cy="12" r="2" fill="#4F8BFF" />
        </svg>
      );
    case "dashscope":
      return (
        <svg {...props}>
          <path
            d="M12 4.2C14.8 4.2 17 6.3 17 8.9C19.2 9.4 20.4 11.7 19.4 14C18.7 15.7 16.9 16.6 15.2 16.4C14.8 18.4 13.1 19.8 11 19.8C8.9 19.8 7.2 18.3 6.9 16.3C5.1 16 3.8 14.3 4.1 12.4C4.4 10.6 5.9 9.3 7.7 9.2C8.1 6.4 9.8 4.2 12 4.2Z"
            stroke="#615CED"
            strokeWidth="1.75"
            strokeLinejoin="round"
          />
          <circle cx="12" cy="12" r="2.5" fill="#615CED" />
        </svg>
      );
    case "google": {
      const gradId = `gem-${uid}`;
      return (
        <svg {...props}>
          <path
            d="M12 3.2C12.7 7.9 16.1 11.3 20.8 12C16.1 12.7 12.7 16.1 12 20.8C11.3 16.1 7.9 12.7 3.2 12C7.9 11.3 11.3 7.9 12 3.2Z"
            fill={`url(#${gradId})`}
          />
          <defs>
            <linearGradient id={gradId} x1="4" y1="4" x2="20" y2="20" gradientUnits="userSpaceOnUse">
              <stop stopColor="#4285F4" />
              <stop offset="0.35" stopColor="#EA4335" />
              <stop offset="0.7" stopColor="#FBBC05" />
              <stop offset="1" stopColor="#34A853" />
            </linearGradient>
          </defs>
        </svg>
      );
    }
    case "openrouter":
      return (
        <svg {...props}>
          <path
            d="M9.5 16.5C7 16.5 5 14.5 5 12C5 9.5 7 7.5 9.5 7.5C11.5 7.5 13 8.8 14.5 10.2L17.5 8.2M14.5 13.8L17.5 15.8"
            stroke="currentColor"
            strokeWidth="1.9"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M16 6.8L18.8 7.8L17.8 10.5M16 17.2L18.8 16.2L17.8 13.5"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      );
    case "siliconflow":
      return (
        <svg {...props}>
          <path
            d="M6.5 6.5H15.5L13 9.5H4L6.5 6.5ZM10.5 10.5H19.5L17 13.5H8L10.5 10.5ZM8.5 14.5H17.5L15 17.5H6L8.5 14.5Z"
            fill="#7C3AED"
          />
        </svg>
      );
    case "opencode":
      return (
        <svg {...props}>
          <rect x="4.5" y="4.5" width="15" height="15" rx="2" stroke="currentColor" strokeWidth="1.8" />
          <path d="M9.5 8.5V15.5M14.5 8.5V15.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
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
