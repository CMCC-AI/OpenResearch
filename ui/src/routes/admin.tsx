import { createFileRoute } from "@tanstack/react-router";
import { AdminLayout } from "../product/AdminLayout";
export const Route = createFileRoute("/admin")({ component: AdminLayout });
