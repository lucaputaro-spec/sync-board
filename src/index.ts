import type { Env } from "./env";

export { Room } from "./room";

const ROUTE = /^\/api\/board\/([a-z0-9]{10,16})\/ws$/;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const match = ROUTE.exec(url.pathname);
    if (!match) return new Response("Not found", { status: 404 });

    // Nur die eigene Seite darf sich verbinden, keine fremde Website.
    const origin = request.headers.get("Origin");
    if (!origin || new URL(origin).host !== url.host) return new Response("Forbidden", { status: 403 });

    const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
    const { success } = await env.LIMITER.limit({ key: ip });
    if (!success) return new Response("Too many connections, try again in a minute", { status: 429 });

    return env.ROOMS.get(env.ROOMS.idFromName(match[1]!)).fetch(request);
  },
};
