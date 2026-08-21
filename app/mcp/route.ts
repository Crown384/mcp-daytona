import { getConfig } from "@/lib/config";
import { handleMcpRequest } from "@/lib/mcp";

function isAllowedOrigin(request: Request): boolean {
  const origin = request.headers.get("Origin");
  if (!origin) {
    return true;
  }

  const requestOrigin = new URL(request.url).origin;
  return (
    origin === requestOrigin ||
    origin === "https://chatgpt.com" ||
    origin === "https://chat.openai.com" ||
    /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)
  );
}

function isAuthorized(request: Request): boolean {
  const { mcpApiKey } = getConfig();
  const urlKey = new URL(request.url).searchParams.get("key");
  const authorization = request.headers.get("Authorization");
  const bearerKey = authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined;

  return urlKey === mcpApiKey || bearerKey === mcpApiKey;
}

function reject(status: number, message: string): Response {
  return Response.json({ error: message }, { status });
}

export async function POST(request: Request): Promise<Response> {
  if (!isAllowedOrigin(request)) {
    return reject(403, "Origin not allowed");
  }

  if (!isAuthorized(request)) {
    return reject(401, "Unauthorized");
  }

  return handleMcpRequest(request);
}

export function GET(request: Request): Response {
  if (!isAllowedOrigin(request)) {
    return reject(403, "Origin not allowed");
  }

  if (!isAuthorized(request)) {
    return reject(401, "Unauthorized");
  }

  return new Response(null, {
    status: 405,
    headers: { Allow: "POST" },
  });
}
