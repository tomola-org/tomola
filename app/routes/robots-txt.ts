import type { Route } from "./+types/robots-txt";
import { notFound, publicResponse } from "~/lib/api/http.server";
import { operatorConfig } from "~/lib/operator-config.server";

export function loader({ request }: Route.LoaderArgs): Response {
  const { robotsTxt } = operatorConfig();
  if (robotsTxt === null) return notFound(request, "text");
  return publicResponse(request, robotsTxt, "text/plain; charset=utf-8", 3600);
}
