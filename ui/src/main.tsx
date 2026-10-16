import { ReactQueryDevtools } from "@tanstack/react-query-devtools";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "./queries/client";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";
import { router } from "./router";
import { Toaster } from "./components/ui";
import { WindowControls } from "./components/WindowControls";
import { WINDOWS_TITLEBAR } from "./desktopTitlebar";
import { getLocale } from "./paraglide/runtime.js";
import "./tailwind.css";
import { CloudWorkspace } from "./product/CloudWorkspace";

const locale = getLocale();
document.documentElement.lang = locale;
document.documentElement.dir = "ltr";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <CloudWorkspace><RouterProvider router={router} /></CloudWorkspace>
      {import.meta.env.DEV && <ReactQueryDevtools initialIsOpen buttonPosition="bottom-right" />}
    </QueryClientProvider>
    <Toaster />
    {WINDOWS_TITLEBAR && <WindowControls />}
  </StrictMode>,
);
