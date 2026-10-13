import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import ts from "typescript";

function mod(source) {
  const code = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022,
  }}).outputText;
  return "data:text/javascript;base64," + Buffer.from(code).toString("base64");
}
function compile(path, replacements) {
  let code = ts.transpileModule(readFileSync(resolve(path), "utf8"), { compilerOptions: {
    module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022,
  }}).outputText;
  for (const [from, target] of Object.entries(replacements)) {
    code = code.replaceAll('from "' + from + '"', 'from "' + target + '"');
  }
  return "data:text/javascript;base64," + Buffer.from(code).toString("base64");
}
const config = mod('export function getConfig(){ return {daytonaApiKey:"fake",daytonaApiUrl:"https://api.test"}; }');
const github = mod('export function normalizeRepository(v){return v;} export async function getRepositoryCredentials(repository){return {repository,token:"fake",username:"bot",identityName:"bot",identityEmail:"bot@example.test"};}');
const runner = mod('export const RUNNER_SCRIPT="echo dummy";');
const envStore = mod(readFileSync(resolve("lib/env-store.ts"), "utf8"));
const auth = mod(readFileSync(resolve("lib/mcp-auth.ts"), "utf8"));
const daytona = compile("lib/daytona.ts", {
  "./config": config, "./github-app": github, "./runner": runner, "./env-store": envStore,
});
const mcp = compile("lib/mcp.ts", { "./daytona": daytona, "./mcp-auth": auth });
const { handleMcpRequest } = await import(mcp);
const aliceToken = "alice_" + "a".repeat(48);
const bobToken = "bob_" + "b".repeat(48);
const sha = async value => [...new Uint8Array(await crypto.subtle.digest(
  "SHA-256", new TextEncoder().encode(value),
))].map(x => x.toString(16).padStart(2,"0")).join("");

async function records() {
  return [
    { id:"alice", tokenSha256:await sha(aliceToken), enabled:true,
      repositories:["owner/repo"], projects:["track"], environments:["staging"] },
    { id:"bob", tokenSha256:await sha(bobToken), enabled:true,
      repositories:["owner/repo"], projects:[], environments:[] },
  ];
}
async function rpc(name, token, args={}) {
  const response = await handleMcpRequest(new Request("https://mcp.example/mcp", {
    method:"POST",
    headers:{ "Content-Type":"application/json", ...(token ? { Authorization:"Bearer " + token } : {}) },
    body:JSON.stringify({ jsonrpc:"2.0", id:1, method:"tools/call", params:{ name, arguments:args } }),
  }));
  return (await response.json()).result;
}

test("per-client controls isolate list/get/rerun/manage/configure/destroy and fail closed for revoked owners", async () => {
  const prior = process.env.PAMA_ENV_STORE_MCP_CLIENTS_JSON;
  const priorFetch = globalThis.fetch;
  const clients = await records();
  process.env.PAMA_ENV_STORE_MCP_CLIENTS_JSON = JSON.stringify(clients);
  const sandboxes = [
    {id:"legacy",state:"started",labels:{"managed-by":"mcp-daytona",repository:"owner/repo",branch:"main"}},
    {id:"owned-bob",state:"started",labels:{"managed-by":"mcp-daytona",repository:"owner/repo",branch:"main","mcp-client-id":"bob"}},
  ];
  const mutations = [];
  let serial=0;
  try {
    globalThis.fetch = async (raw,init={}) => {
      const url = new URL(raw), method=init.method ?? "GET";
      const path=url.pathname;
      if (url.hostname === "proxy.app.daytona.io") return Response.json({exitCode:0,result:"clean"});
      if (path === "/sandbox" && method === "POST") {
        const id="created-"+(++serial);
        sandboxes.push({id,state:"started",labels:{}});
        return Response.json({id});
      }
      if (path === "/sandbox" && method === "GET") return Response.json({items:sandboxes});
      const id=path.split("/")[2];
      const found=sandboxes.find(s=>s.id===id);
      if (!found) return Response.json({error:"missing"}, {status:404});
      if (path.endsWith("/labels") && method==="PUT") {
        Object.assign(found.labels,JSON.parse(init.body).labels);
        mutations.push("label:"+id);
        return Response.json({});
      }
      if (method==="GET") return Response.json(found);
      mutations.push(method+":"+path);
      return Response.json({});
    };
    assert.equal((await rpc("list_sandboxes",null)).isError,true);
    assert.equal((await rpc("list_sandboxes", "incorrect")).isError,true);
    const started=await rpc("run_cycle",aliceToken,{repository:"owner/repo",after_run:"keep"});
    assert.equal(started.isError,false, JSON.stringify(started));
    assert.equal(started.structuredContent.sandboxId,"created-1");
    assert.equal(sandboxes.at(-1).labels["mcp-client-id"],"alice");
    const visibleAlice=(await rpc("list_sandboxes",aliceToken)).structuredContent.sandboxes.items;
    const visibleBob=(await rpc("list_sandboxes",bobToken)).structuredContent.sandboxes.items;
    assert.deepEqual(visibleAlice.map(x=>x.id),["created-1"]);
    assert.deepEqual(visibleBob.map(x=>x.id),["owned-bob"]);
    for (const [tool,args] of [
      ["get_sandbox",{sandbox_id:"created-1"}],
      ["rerun_cycle",{sandbox_id:"created-1"}],
      ["manage_sandbox",{sandbox_id:"created-1",action:"stop"}],
      ["configure_sandbox",{sandbox_id:"created-1",setting:"auto_stop",minutes:5}],
      ["destroy_sandbox",{sandbox_id:"created-1"}],
      ["get_sandbox",{sandbox_id:"legacy"}],
    ]) {
      const result=await rpc(tool,bobToken,args);
      assert.equal(result.isError,true,tool);
      assert.match(result.structuredContent.error,/not accessible/,tool);
    }
    assert.equal(mutations.some(x=>x.includes("/stop") || x.includes("/autostop") || x.includes("DELETE")),false);
    assert.equal((await rpc("get_sandbox",aliceToken,{sandbox_id:"created-1"})).isError,false);
    assert.equal((await rpc("run_cycle",aliceToken,{repository:"other/repo"})).isError,true);
    const production=await rpc("run_cycle",aliceToken,{repository:"owner/repo",env_store_project:"track",env_store_environment:"production"});
    assert.equal(production.isError,true);
    assert.match(production.structuredContent.error,/cannot access project\/environment/);
    clients[0].enabled=false; // Immediate next-request denial after registry rotation.
    process.env.PAMA_ENV_STORE_MCP_CLIENTS_JSON=JSON.stringify(clients);
    assert.equal((await rpc("get_sandbox",aliceToken,{sandbox_id:"created-1"})).isError,true);
    assert.equal((await rpc("list_sandboxes",bobToken)).isError,false);
  } finally {
    if (prior===undefined) delete process.env.PAMA_ENV_STORE_MCP_CLIENTS_JSON;
    else process.env.PAMA_ENV_STORE_MCP_CLIENTS_JSON=prior;
    globalThis.fetch=priorFetch;
  }
});

test("malformed principal registry and old shared token never bypass scoped mode",async()=>{
  const prior=process.env.PAMA_ENV_STORE_MCP_CLIENTS_JSON;
  const legacy=process.env.PAMA_ENV_STORE_MCP_AUTH_TOKEN;
  try {
    process.env.PAMA_ENV_STORE_MCP_AUTH_TOKEN="l".repeat(48);
    for (const registry of ["", "[]", "{}", "not-json", JSON.stringify([{
      id:"alice",tokenSha256:"a".repeat(64),enabled:true,
      repositories:["owner/*"],projects:[],environments:[],
    }])]) {
      process.env.PAMA_ENV_STORE_MCP_CLIENTS_JSON=registry;
      assert.equal((await rpc("list_sandboxes","l".repeat(48))).isError,true);
      assert.equal((await rpc("list_sandboxes",aliceToken)).isError,true);
    }
    const clients=await records();
    process.env.PAMA_ENV_STORE_MCP_CLIENTS_JSON=JSON.stringify(clients);
    assert.equal((await rpc("list_sandboxes","l".repeat(48))).isError,true);
  } finally {
    if(prior===undefined)delete process.env.PAMA_ENV_STORE_MCP_CLIENTS_JSON;
    else process.env.PAMA_ENV_STORE_MCP_CLIENTS_JSON=prior;
    if(legacy===undefined)delete process.env.PAMA_ENV_STORE_MCP_AUTH_TOKEN;
    else process.env.PAMA_ENV_STORE_MCP_AUTH_TOKEN=legacy;
  }
});
