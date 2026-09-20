import { createFileRoute } from "@tanstack/react-router";
import { LiteraturePage } from "../product/LiteraturePage";

export const Route = createFileRoute("/literature")({ component: LiteraturePage });
