import { createFileRoute } from "@tanstack/react-router";
import { PersonalSettingsPage } from "../product/PersonalSettingsPage";
export const Route = createFileRoute("/settings/quota")({ component: () => <PersonalSettingsPage section="quota"/> });
