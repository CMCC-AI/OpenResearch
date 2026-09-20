import { createFileRoute } from "@tanstack/react-router";
import { CapabilitiesPage } from "../product/CapabilitiesPage";

export const Route = createFileRoute("/capabilities")({ component: CapabilitiesPage });
