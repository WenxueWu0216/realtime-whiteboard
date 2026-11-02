/**
 * Where the server lives.
 * - Explicit VITE_WS_URL / VITE_API_URL at build time win (docker-compose, dev).
 * - Otherwise in dev: ws://localhost:1234.
 * - Otherwise (production image behind an ingress/ALB): same origin, WebSockets
 *   on /ws/<room> and the API on /boards/..., so one image works on any host.
 */
const sameOrigin = typeof window !== "undefined" && !import.meta.env.DEV;
const wsProto = typeof window !== "undefined" && window.location.protocol === "https:" ? "wss" : "ws";

export const WS_URL: string =
  import.meta.env.VITE_WS_URL || (sameOrigin ? `${wsProto}://${window.location.host}/ws` : "ws://localhost:1234");

export const API_URL: string =
  import.meta.env.VITE_API_URL ||
  (import.meta.env.VITE_WS_URL
    ? import.meta.env.VITE_WS_URL.replace(/^ws/, "http").replace(/\/ws\/?$/, "")
    : sameOrigin
      ? window.location.origin
      : "http://localhost:1234");
