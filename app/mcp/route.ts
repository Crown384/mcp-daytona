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

function reject(status: number, message: string): Response {
  return Response.json({ error: message }, { status });
}

export async function POST(request: Request): Promise<Response> {
  if (!isAllowedOrigin(request)) {
    return reject(403, "Origin not allowed");
  }

  return handleMcpRequest(request);
}

export function GET(request: Request): Response {
  if (!isAllowedOrigin(request)) {
    return reject(403, "Origin not allowed");
  }

  return new Response(null, {
    status: 405,
    headers: { Allow: "POST" },
  });
}
