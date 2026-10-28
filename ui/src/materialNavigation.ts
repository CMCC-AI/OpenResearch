import { createContext } from "react";

export const MaterialNavigationContext = createContext<((id?: string) => void) | null>(null);
