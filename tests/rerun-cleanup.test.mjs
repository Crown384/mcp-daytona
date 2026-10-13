import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import ts from "typescript";

function mod(source) {
  const code=ts.transpileModule(source,{compilerOptions:{
    module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022,
  }}).outputText;
  return "data:text/javascript;base64,"+Buffer.from(code).toString("base64");
}
const config=mod('export function getConfig(){return {daytonaApiKey:"dummy",daytonaApiUrl:"https://daytona.test"};}');
const github=mod('export async function getRepositoryCredentials(repository){return {repository,token:"dummy",username:"bot",identityName:"bot",identityEmail:"bot@example.test"};} export function normalizeRepository(repository){return repository;}');
const runner=mod('export const RUNNER_SCRIPT="echo mock";');
const env=mod(readFileSync(resolve("lib/env-store.ts"),"utf8"));
let compiled=ts.transpileModule(readFileSync(resolve("lib/daytona.ts"),"utf8"),{
  compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022},
}).outputText;
for(const [from,to] of Object.entries({"./config":config,"./github-app":github,"./runner":runner,"./env-store":env})){
  compiled=compiled.replaceAll('from "'+from+'"','from "'+to+'"');
}
const { rerunCycle }=await import("data:text/javascript;base64,"+Buffer.from(compiled).toString("base64"));
const secret="dummy-sandbox-secret-that-must-never-be-logged";
const principal={id:"alice",repositories:["owner/repo"],projects:["track"],environments:["staging"]};
const input={sandboxId:"sandbox-1",timeoutSeconds:120,syncMode:"reset",afterRun:"delete",
  workingPath:".",envStore:{project:"track",environment:"staging"}};

async function withEnv(callback){
  const names=["PAMA_ENV_STORE_URL","PAMA_ENV_STORE_TOKEN","PAMA_ENV_STORE_TRUSTED_REPOS"];
  const old=Object.fromEntries(names.map(key=>[key,process.env[key]]));
  const oldFetch=globalThis.fetch;
  process.env.PAMA_ENV_STORE_URL="https://env.example";
  process.env.PAMA_ENV_STORE_TOKEN="pes_"+"x".repeat(40);
  process.env.PAMA_ENV_STORE_TRUSTED_REPOS="owner/repo";
  try{await callback();}
  finally{
    globalThis.fetch=oldFetch;
    for(const name of names){
      if(old[name]===undefined)delete process.env[name];
      else process.env[name]=old[name];
    }
  }
}
function respond(on){
  const calls=[];
  globalThis.fetch=async(raw,init={})=>{
    const u=new URL(raw),method=init.method??"GET";
    calls.push(method+" "+u.host+u.pathname);
    if(u.host==="env.example"){
      if(on.envDenied)return new Response("private:"+secret,{status:403});
      return Response.json({project:{slug:"track"},environment:"staging",values:{DUMMY_SECRET:secret}});
    }
    if(u.host==="daytona.test"&&method==="GET"){
      return Response.json({id:"sandbox-1",state:"started",labels:{
        "managed-by":"mcp-daytona",repository:"owner/repo",branch:"staging",
        "mcp-client-id":on.otherOwner?"bob":"alice",
      }});
    }
    if(u.host==="daytona.test"&&method==="DELETE"){
      if(on.deleteFails)return new Response("private:"+secret,{status:403});
      return new Response(null,{status:204});
    }
    if(u.host==="proxy.app.daytona.io"){
      if(on.runnerFails)return new Response("private:"+secret,{status:503});
      return Response.json({exitCode:0,result:"dummy completed"});
    }
    throw Error("Unexpected mocked request: "+raw);
  };
  return calls;
}

test("a failed secret-enabled runner still destroys its owned sandbox",async()=>{
  await withEnv(async()=>{
    const calls=respond({runnerFails:true});
    await assert.rejects(rerunCycle(input,principal),error=>{
      assert.match(error.message,/Daytona runner execution failed/);
      assert.doesNotMatch(error.message,/dummy-sandbox-secret/);
      return true;
    });
    assert.ok(calls.some(c=>c==="DELETE daytona.test/sandbox/sandbox-1"));
  });
});
test("a secret lookup refusal also triggers authorized requested deletion",async()=>{
  await withEnv(async()=>{
    const calls=respond({envDenied:true});
    await assert.rejects(rerunCycle(input,principal),/Env Store refused environment access/);
    assert.ok(calls.some(c=>c==="DELETE daytona.test/sandbox/sandbox-1"));
    assert.equal(calls.some(c=>c.includes("proxy.app.daytona.io")),false);
  });
});
test("failed cleanup cannot echo an upstream secret in failure or success paths",async()=>{
  await withEnv(async()=>{
    const failures=respond({runnerFails:true,deleteFails:true});
    await assert.rejects(rerunCycle(input,principal),error=>{
      assert.match(error.message,/Lifecycle action also failed/);
      assert.match(error.message,/verify sandbox cleanup/);
      assert.doesNotMatch(error.message,/dummy-sandbox-secret/);
      return true;
    });
    assert.ok(failures.some(c=>c.startsWith("DELETE ")));
    respond({deleteFails:true});
    const result=await rerunCycle(input,principal);
    assert.equal(result.lifecycleStatus,"failed");
    assert.match(result.lifecycleError,/verify sandbox cleanup/);
    assert.doesNotMatch(result.lifecycleError,/dummy-sandbox-secret/);
  });
});
test("cross-client refusal never deletes another caller's sandbox",async()=>{
  await withEnv(async()=>{
    const calls=respond({otherOwner:true});
    await assert.rejects(rerunCycle(input,principal),/not accessible/);
    assert.equal(calls.some(c=>c.startsWith("DELETE ")),false);
  });
});
