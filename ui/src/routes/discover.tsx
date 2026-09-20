import { createFileRoute } from "@tanstack/react-router";
import { DiscoverPage } from "../product/DiscoverPage";

export const Route = createFileRoute("/discover")({ component: DiscoverPage });
