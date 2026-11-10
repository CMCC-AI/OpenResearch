import { createFileRoute } from "@tanstack/react-router";
import { AdminTokenQuotasPage } from "../product/AdminTokenQuotasPage";
export const Route = createFileRoute("/admin/quotas")({
  validateSearch: (value: Record<string, unknown>): { email?: string } => ({
    email:
      typeof value.email === "string" && value.email.length <= 254
        ? value.email
        : undefined,
  }),
  component: Page,
});
function Page() {
  return <AdminTokenQuotasPage initialEmail={Route.useSearch().email} />;
}
