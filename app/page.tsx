export default function Home() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-zinc-950 px-6 text-zinc-100">
      <section className="w-full max-w-2xl space-y-8">
        <div className="space-y-3">
          <p className="font-mono text-xs uppercase tracking-[0.24em] text-zinc-500">
            Private developer plugin
          </p>
          <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">
            Daytona MCP
          </h1>
          <p className="max-w-xl text-base leading-7 text-zinc-400">
            One production worker. One controlled execution tool. GitHub remains the source of truth;
            Daytona only runs the repository cycle in an isolated sandbox.
          </p>
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          {[
            ["Tool", "run_cycle"],
            ["Endpoint", "/mcp"],
            ["Runtime", "Daytona"],
          ].map(([label, value]) => (
            <div key={label} className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
              <p className="text-xs uppercase tracking-wider text-zinc-500">{label}</p>
              <p className="mt-2 font-mono text-sm text-zinc-200">{value}</p>
            </div>
          ))}
        </div>

        <p className="text-sm text-zinc-500">
          This service is intentionally private and has no public dashboard or account system.
        </p>
      </section>
    </main>
  );
}
