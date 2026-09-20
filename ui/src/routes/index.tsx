import { createFileRoute } from "@tanstack/react-router";
import { LandingPage } from "../product/LandingPage";

export const Route = createFileRoute("/")({ component: LandingPage });
