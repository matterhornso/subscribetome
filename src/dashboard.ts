// The dashboard web UI — a single self-contained HTML page.
//
// No build step, no framework, no external assets. The page reads its auth
// token from the URL (?token=) and sends it on every API call.
//
// Styling follows a three-layer token architecture (primitive -> semantic ->
// component) expressed as CSS custom properties, with systematic spacing and
// type scales. Client JS uses string concatenation (no template literals) to
// keep this server-side template literal free of escaping hazards.

import { CATALOG } from "./catalog.ts";

export function dashboardHTML(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<title>subscribetome</title>
<style>
  /* ---- tokens: primitive ---- */
  :root {
    --ink-950:#0a0c10; --ink-900:#0f1218; --ink-850:#141821; --ink-800:#1a1f2a;
    --ink-700:#252b38; --ink-600:#333b4a;
    --slate-50:#eef0f4; --slate-300:#b8bfcc; --slate-400:#8b94a4; --slate-500:#646d7e;
    --emerald-300:#6ee7b7; --emerald-400:#34d39a; --emerald-500:#10b981;
    --red-400:#f06d6d; --amber-400:#f5b942;
    --space:4px;
    --r-sm:6px; --r-md:10px; --r-lg:16px;
    --font-sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,system-ui,sans-serif;
    --font-mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;
    --ease:cubic-bezier(.2,.6,.2,1);
  }
  /* ---- tokens: semantic ---- */
  :root {
    --bg:var(--ink-950); --surface:var(--ink-900); --surface-2:var(--ink-850);
    --field:var(--ink-950); --border:var(--ink-800); --border-strong:var(--ink-700);
    --text:var(--slate-50); --text-muted:var(--slate-400); --text-dim:var(--slate-500);
    --primary:var(--emerald-400); --primary-bright:var(--emerald-300); --on-primary:#06241a;
    --danger:var(--red-400);
    --focus:rgba(52,211,154,.45);
    --shadow-md:0 8px 28px -8px rgba(0,0,0,.6);
  }
  /* ---- reset ---- */
  *,*::before,*::after { box-sizing:border-box; }
  html,body { height:100%; }
  body {
    margin:0; background:var(--bg); color:var(--text);
    font:400 14px/1.55 var(--font-sans);
    -webkit-font-smoothing:antialiased; letter-spacing:.1px;
  }
  ::selection { background:rgba(52,211,154,.28); }
  h1,h2,h3,p { margin:0; }
  code,.mono { font-family:var(--font-mono); }

  /* ---- header ---- */
  header {
    position:sticky; top:0; z-index:10;
    display:flex; align-items:center; justify-content:space-between;
    padding:0 calc(var(--space)*7); height:60px;
    background:rgba(15,18,24,.85); backdrop-filter:blur(8px);
    border-bottom:1px solid var(--border);
  }
  .brand { display:flex; align-items:center; gap:calc(var(--space)*2.5); }
  .brand .mark {
    width:26px; height:26px; border-radius:7px; flex:none;
    background:linear-gradient(140deg,var(--emerald-300),var(--emerald-500));
    display:grid; place-items:center; color:var(--on-primary);
    font-weight:800; font-size:14px;
  }
  .brand .name { font-size:15px; font-weight:600; letter-spacing:.2px; }
  .brand .name b { color:var(--primary); font-weight:600; }
  .spend {
    display:flex; align-items:baseline; gap:calc(var(--space)*2);
    font-size:12px; color:var(--text-muted);
    background:var(--surface-2); border:1px solid var(--border);
    padding:calc(var(--space)*1.5) calc(var(--space)*3); border-radius:999px;
  }
  .spend b { font-size:14px; color:var(--text); font-variant-numeric:tabular-nums; }

  /* ---- layout ---- */
  main {
    max-width:840px; margin:0 auto;
    padding:calc(var(--space)*9) calc(var(--space)*7) calc(var(--space)*16);
    display:flex; flex-direction:column; gap:calc(var(--space)*5);
  }
  .card {
    background:var(--surface); border:1px solid var(--border);
    border-radius:var(--r-lg); padding:calc(var(--space)*6);
  }
  .card-head {
    display:flex; align-items:center; justify-content:space-between;
    margin-bottom:calc(var(--space)*5);
  }
  .card-head h2 {
    font-size:11px; font-weight:600; letter-spacing:1.4px; text-transform:uppercase;
    color:var(--text-muted);
  }
  .card-head .meta { font-size:12px; color:var(--text-dim); }
  .sub-head {
    font-size:11px; font-weight:600; letter-spacing:1.4px; text-transform:uppercase;
    color:var(--text-muted); margin:calc(var(--space)*7) 0 calc(var(--space)*4);
  }

  /* ---- forms ---- */
  .grid { display:grid; gap:calc(var(--space)*4); }
  .grid.cols-2 { grid-template-columns:1fr 1fr; }
  .grid.cols-3 { grid-template-columns:1fr 1fr 1fr; }
  .field { display:flex; flex-direction:column; gap:calc(var(--space)*1.5); }
  label { font-size:12px; font-weight:500; color:var(--text-muted); }
  input,select {
    width:100%; height:38px; padding:0 calc(var(--space)*3);
    background:var(--field); color:var(--text);
    border:1px solid var(--border-strong); border-radius:var(--r-sm);
    font:inherit; transition:border-color .15s var(--ease),box-shadow .15s var(--ease);
  }
  input::placeholder { color:var(--text-dim); }
  input:hover,select:hover { border-color:var(--ink-600); }
  input:focus,select:focus { outline:none; border-color:var(--primary); box-shadow:0 0 0 3px var(--focus); }
  input[type=date] { color-scheme:dark; }
  select { -webkit-appearance:none; appearance:none; cursor:pointer; color-scheme:dark; }

  /* ---- buttons ---- */
  button {
    font:inherit; cursor:pointer; border-radius:var(--r-sm);
    transition:background .15s var(--ease),border-color .15s var(--ease),
      transform .05s var(--ease),opacity .15s var(--ease);
  }
  button:active { transform:translateY(1px); }
  button:focus-visible { outline:none; box-shadow:0 0 0 3px var(--focus); }
  .btn-primary {
    height:38px; padding:0 calc(var(--space)*5);
    background:var(--primary); color:var(--on-primary); border:0;
    font-weight:650; letter-spacing:.2px;
  }
  .btn-primary:hover { background:var(--primary-bright); }
  .btn-primary:disabled { opacity:.5; cursor:not-allowed; }
  .btn-ghost {
    height:34px; padding:0 calc(var(--space)*4);
    background:transparent; color:var(--text-muted);
    border:1px solid var(--border-strong); font-weight:500;
  }
  .btn-ghost:hover { color:var(--text); border-color:var(--ink-600); }
  .btn-row { display:flex; align-items:center; gap:calc(var(--space)*4); margin-top:calc(var(--space)*5); }

  /* ---- custom fields ---- */
  .cf-row { display:flex; gap:calc(var(--space)*2); margin-top:calc(var(--space)*2.5); }
  .cf-row .cf-label { flex:0 0 38%; }
  .cf-row .cf-value { flex:1; }
  .cf-del {
    flex:none; width:38px; height:38px; background:transparent; color:var(--text-muted);
    border:1px solid var(--border-strong); border-radius:var(--r-sm); font-size:13px;
  }
  .cf-del:hover { color:var(--danger); border-color:var(--danger); }
  .add-field {
    margin-top:calc(var(--space)*3.5); background:transparent;
    border:1px dashed var(--border-strong); color:var(--text-muted);
    border-radius:var(--r-sm); padding:8px 14px; font-size:12.5px;
  }
  .add-field:hover { color:var(--primary); border-color:var(--primary); }

  /* ---- tables ---- */
  .table-wrap { overflow-x:auto; }
  table { width:100%; border-collapse:collapse; min-width:440px; }
  th {
    text-align:left; padding:0 calc(var(--space)*2) calc(var(--space)*2.5);
    font-size:11px; font-weight:600; letter-spacing:.5px; text-transform:uppercase;
    color:var(--text-dim); border-bottom:1px solid var(--border);
  }
  td {
    padding:calc(var(--space)*3) calc(var(--space)*2);
    border-bottom:1px solid var(--border); vertical-align:middle;
  }
  tr:last-child td { border-bottom:0; }
  tbody tr { transition:background .12s var(--ease); }
  tbody tr:hover { background:var(--surface-2); }
  td code { font-size:12.5px; color:var(--primary-bright); }
  .empty { color:var(--text-dim); padding:calc(var(--space)*5) calc(var(--space)*2); }
  .num { font-variant-numeric:tabular-nums; }

  /* ---- badges ---- */
  .badge {
    display:inline-flex; align-items:center; gap:6px;
    font-size:11px; font-weight:600; padding:3px 9px; border-radius:999px;
    text-transform:capitalize;
  }
  .badge::before { content:""; width:6px; height:6px; border-radius:999px; }
  .badge.active { background:rgba(52,211,154,.13); color:var(--emerald-300); }
  .badge.active::before { background:var(--emerald-400); }
  .badge.revoked { background:rgba(139,148,164,.12); color:var(--text-muted); }
  .badge.revoked::before { background:var(--text-dim); }
  .badge.allow { background:rgba(52,211,154,.13); color:var(--emerald-300); }
  .badge.allow::before { background:var(--emerald-400); }
  .badge.warn { background:rgba(245,185,66,.13); color:var(--amber-400); }
  .badge.warn::before { background:var(--amber-400); }
  .badge.deny { background:rgba(240,109,109,.13); color:var(--red-400); }
  .badge.deny::before { background:var(--red-400); }

  /* ---- policy ---- */
  .policy-grid {
    display:grid; grid-template-columns:1fr 1fr 1fr; gap:calc(var(--space)*4);
  }
  .policy-row2 {
    display:grid; grid-template-columns:140px 100px 1fr auto;
    gap:calc(var(--space)*4); align-items:end; margin-top:calc(var(--space)*4);
  }
  .verdict-card {
    margin-top:calc(var(--space)*4); padding:calc(var(--space)*4);
    background:var(--surface-2); border:1px solid var(--border);
    border-radius:var(--r-md); font-size:13px;
  }
  .verdict-card.deny { border-color:rgba(240,109,109,.45); }
  .verdict-card.warn { border-color:rgba(245,185,66,.45); }
  .verdict-card.allow { border-color:rgba(52,211,154,.35); }
  .verdict-card .v-head {
    display:flex; align-items:center; gap:10px; margin-bottom:8px;
    font-weight:600;
  }
  .verdict-card .v-key {
    display:flex; gap:10px; align-items:center;
    padding:4px 0; font-family:var(--font-mono); font-size:12.5px;
    color:var(--text-muted);
  }
  .verdict-card .v-key code { color:var(--primary-bright); }
  .pred-any { color:var(--text-dim); }
  @media (max-width:640px) {
    .policy-grid,.policy-row2 { grid-template-columns:1fr; }
  }

  /* ---- misc ---- */
  .note {
    margin-top:calc(var(--space)*4); padding-top:calc(var(--space)*4);
    border-top:1px solid var(--border);
    font-size:12px; line-height:1.6; color:var(--text-dim);
  }
  .msg { margin-top:calc(var(--space)*3); font-size:13px; min-height:18px; }
  .msg.ok { color:var(--emerald-300); }
  .msg.err { color:var(--danger); }
  .source { font-size:12px; color:var(--text-dim); text-transform:capitalize; }

  /* ---- copy-to-clipboard ---- */
  code.copy {
    cursor:pointer; border-radius:4px; padding:1px 3px;
    transition:background .12s var(--ease);
  }
  code.copy:hover { background:rgba(52,211,154,.16); }
  code.copy:active { background:rgba(52,211,154,.26); }
  .toast {
    position:fixed; left:50%; bottom:24px;
    transform:translateX(-50%) translateY(8px);
    max-width:90vw; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
    background:var(--surface-2); color:var(--text);
    border:1px solid var(--border-strong); border-radius:999px;
    padding:8px 16px; font-size:12.5px; box-shadow:var(--shadow-md);
    opacity:0; pointer-events:none; z-index:50;
    transition:opacity .15s var(--ease),transform .15s var(--ease);
  }
  .toast.show { opacity:1; transform:translateX(-50%) translateY(0); }

  @media (max-width:640px) {
    .grid.cols-2,.grid.cols-3 { grid-template-columns:1fr; }
    header,main { padding-left:calc(var(--space)*4); padding-right:calc(var(--space)*4); }
  }
</style>
</head>
<body>
<header>
  <div class="brand">
    <div class="mark">s</div>
    <div class="name">subscribe<b>tome</b></div>
  </div>
  <div class="spend">monthly spend <b id="spend">$0.00</b></div>
</header>

<main>
  <section class="card">
    <div class="card-head"><h2>Add keys</h2></div>
    <div class="field">
      <label for="svc">Service</label>
      <select id="svc"></select>
    </div>
    <div id="svc-fields"></div>
    <div class="grid cols-3" style="margin-top:16px">
      <div class="field"><label for="k-plan">Plan (optional)</label>
        <input id="k-plan" placeholder="Pro" autocomplete="off"></div>
      <div class="field"><label for="k-cost">Monthly cost USD (optional)</label>
        <input id="k-cost" type="number" min="0" step="0.01" placeholder="20"></div>
      <div class="field"><label for="k-renews">Renews on (optional)</label>
        <input id="k-renews" type="date"></div>
    </div>
    <div class="btn-row">
      <button class="btn-primary" id="add-btn">Add</button>
      <span id="add-msg" class="msg"></span>
    </div>
    <p class="note">Secrets go straight to your macOS Keychain — never the Claude Code
      chat. Pick a service for its standard fields, or "Other" for a custom one; fill
      only the fields you have. You and the model only ever see each
      <code>{{stm:tool:label}}</code> placeholder.</p>
  </section>

  <section class="card">
    <div class="card-head"><h2>API keys</h2><span class="meta">Click a placeholder to copy</span></div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Placeholder</th><th>Status</th><th>Source</th><th>Added</th><th></th></tr></thead>
        <tbody id="keys"></tbody>
      </table>
    </div>
    <div class="sub-head">Subscriptions</div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Tool</th><th>Plan</th><th>Monthly</th><th>Renews</th><th></th></tr></thead>
        <tbody id="tools"></tbody>
      </table>
    </div>
  </section>

  <section class="card">
    <div class="card-head">
      <h2>Command policy</h2>
      <span class="meta">Allow / deny / warn rules at PreToolUse</span>
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr>
          <th>Order</th><th>Key</th><th>Command</th><th>Agent</th>
          <th>Action</th><th>Reason</th><th></th>
        </tr></thead>
        <tbody id="policies"></tbody>
      </table>
    </div>

    <div class="sub-head">Add rule</div>
    <div class="policy-grid">
      <div class="field"><label for="p-key">Key glob</label>
        <input id="p-key" placeholder="* (any) — e.g. stripe:*" autocomplete="off" spellcheck="false"></div>
      <div class="field"><label for="p-cmd">Command glob</label>
        <input id="p-cmd" placeholder="* (any) — e.g. *rm -rf*" autocomplete="off" spellcheck="false"></div>
      <div class="field"><label for="p-agent">Agent glob</label>
        <input id="p-agent" placeholder="* (any) — e.g. claude-code" autocomplete="off" spellcheck="false"></div>
    </div>
    <div class="policy-row2">
      <div class="field"><label for="p-action">Action</label>
        <select id="p-action">
          <option value="deny">Deny</option>
          <option value="warn">Warn</option>
          <option value="allow">Allow</option>
        </select>
      </div>
      <div class="field"><label for="p-order">Order</label>
        <input id="p-order" type="number" value="100"></div>
      <div class="field"><label for="p-reason">Reason</label>
        <input id="p-reason" placeholder="surfaced to the agent on deny" autocomplete="off"></div>
      <button class="btn-primary" id="add-policy-btn">Add</button>
    </div>
    <div id="policy-msg" class="msg"></div>

    <div class="sub-head">Test a command</div>
    <div class="grid" style="grid-template-columns:1fr auto;align-items:end">
      <div class="field"><label for="p-test-cmd">Command (use stm placeholders)</label>
        <input id="p-test-cmd" class="mono" placeholder='echo {{stm:openai:default}}' autocomplete="off" spellcheck="false"></div>
      <button class="btn-ghost" id="test-policy-btn">Test</button>
    </div>
    <div id="policy-test" class="verdict-card" style="display:none"></div>

    <p class="note">Rules evaluate at <code>PreToolUse</code>, before the keychain is read.
      Strictest verdict wins per command (<code>deny &gt; warn &gt; allow</code>).
      No matching rule means allow — add a final catch-all to flip to default-deny.
      A predicate left blank matches anything.</p>
  </section>

  <section class="card">
    <div class="card-head"><h2>Import from .env files</h2></div>
    <div class="grid" style="grid-template-columns:1fr auto;align-items:end">
      <div class="field"><label for="imp-dir">Directory to scan</label>
        <input id="imp-dir" placeholder="/Users/you/projects" autocomplete="off" spellcheck="false"></div>
      <button class="btn-ghost" id="scan-btn">Scan</button>
    </div>
    <div id="imp-msg" class="msg"></div>
    <div class="table-wrap" id="imp-table" style="display:none;margin-top:8px">
      <table>
        <thead><tr><th>Variable</th><th>Value</th><th>Tool</th><th>Label</th><th>Import</th></tr></thead>
        <tbody id="imp-rows"></tbody>
      </table>
    </div>
    <div class="btn-row" id="imp-actions" style="display:none">
      <button class="btn-primary" id="imp-btn">Import selected</button>
    </div>
  </section>
</main>

<div id="toast" class="toast" role="status" aria-live="polite"></div>

<script>
var TOKEN = new URLSearchParams(location.search).get("token") || "";
var CATALOG = ${JSON.stringify(CATALOG)};
var scanned = [];
var lastInv = null;
var editingTool = null;
var toastTimer = null;

function esc(s){return String(s).replace(/[&<>"]/g,function(c){
  return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c];});}
function val(id){return document.getElementById(id).value.trim();}
function el(id){return document.getElementById(id);}
function setMsg(id,text,cls){var m=el(id);m.textContent=text;m.className="msg"+(cls?" "+cls:"");}
function setMsgHTML(id,html,cls){var m=el(id);m.innerHTML=html;m.className="msg"+(cls?" "+cls:"");}

function toast(msg){
  var t=el("toast");t.textContent=msg;t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer=setTimeout(function(){t.classList.remove("show");},1900);
}
function copyText(text){
  function ok(){toast("Copied  "+text);}
  if(navigator.clipboard&&navigator.clipboard.writeText){
    navigator.clipboard.writeText(text).then(ok,function(){fallbackCopy(text,ok);});
  }else{fallbackCopy(text,ok);}
}
function fallbackCopy(text,ok){
  var ta=document.createElement("textarea");
  ta.value=text;ta.style.position="fixed";ta.style.opacity="0";
  document.body.appendChild(ta);ta.focus();ta.select();
  try{document.execCommand("copy");ok();}catch(e){toast("Copy failed \\u2014 select it manually");}
  document.body.removeChild(ta);
}
function copyChip(ph){
  return '<code class="copy" data-ph="'+esc(ph)+'" title="Click to copy">'+esc(ph)+'</code>';
}

async function api(path,opts){
  opts=opts||{};
  opts.headers=Object.assign({"X-STM-Token":TOKEN,"content-type":"application/json"},opts.headers||{});
  var r=await fetch(path,opts);
  var j={};try{j=await r.json();}catch(e){}
  if(!r.ok)throw new Error(j.error||r.statusText);
  return j;
}

async function refresh(){
  var inv=await api("/api/inventory");
  lastInv=inv;
  render(inv);
  refreshPolicies().catch(function(e){
    setMsg("policy-msg","Failed to load policies: "+e.message,"err");
  });
}

async function refreshPolicies(){
  var r=await api("/api/policies");
  renderPolicies(r.policies||[]);
}

function predCell(v){
  return v==null||v===""
    ? '<span class="pred-any">*</span>'
    : '<code style="font-size:12px">'+esc(v)+'</code>';
}

function renderPolicies(rules){
  var tb=el("policies");
  if(!rules.length){
    tb.innerHTML='<tr><td colspan="7" class="empty">No policy rules. Default action when no rule matches is allow.</td></tr>';
    return;
  }
  tb.innerHTML=rules.map(function(r){
    return '<tr>'
      +'<td class="num" style="color:var(--text-muted);width:60px">'+r.ordering+'</td>'
      +'<td>'+predCell(r.when_key)+'</td>'
      +'<td>'+predCell(r.when_command)+'</td>'
      +'<td>'+predCell(r.when_agent)+'</td>'
      +'<td><span class="badge '+esc(r.action)+'">'+esc(r.action)+'</span></td>'
      +'<td style="color:var(--text-muted);font-size:13px">'+esc(r.reason||"")+'</td>'
      +'<td style="text-align:right"><button class="btn-ghost pol-del" '
      +'style="height:28px;padding:0 12px" data-id="'+r.id+'">Remove</button></td>'
      +'</tr>';
  }).join("");
}

async function addPolicy(){
  var btn=el("add-policy-btn"); btn.disabled=true;
  try{
    var body={
      whenKey:val("p-key")||null,
      whenCommand:val("p-cmd")||null,
      whenAgent:val("p-agent")||null,
      action:el("p-action").value,
      reason:val("p-reason")||null,
      ordering:val("p-order")?Number(val("p-order")):100
    };
    var r=await api("/api/policies",{method:"POST",body:JSON.stringify(body)});
    setMsg("policy-msg","Added rule #"+r.policy.id+" (order "+r.policy.ordering+")","ok");
    ["p-key","p-cmd","p-agent","p-reason"].forEach(function(i){el(i).value="";});
    el("p-order").value="100";
    el("p-action").value="deny";
    refreshPolicies();
  }catch(e){setMsg("policy-msg",e.message,"err");}
  finally{btn.disabled=false;}
}

async function removePolicy(id){
  try{
    await api("/api/policies/"+encodeURIComponent(id),{method:"DELETE"});
    toast("Rule #"+id+" removed");
    refreshPolicies();
  }catch(e){setMsg("policy-msg",e.message,"err");}
}

async function testPolicy(){
  var btn=el("test-policy-btn"); btn.disabled=true;
  try{
    var cmd=val("p-test-cmd");
    if(!cmd)throw new Error("Enter a command to test.");
    var r=await api("/api/policies/test",{method:"POST",body:JSON.stringify({command:cmd})});
    renderVerdict(r);
  }catch(e){
    var box=el("policy-test");
    box.className="verdict-card";
    box.style.display="";
    box.innerHTML='<div class="v-head" style="color:var(--danger)">Error</div>'
      +'<div style="color:var(--text-muted)">'+esc(e.message)+'</div>';
  }
  finally{btn.disabled=false;}
}

function renderVerdict(r){
  var box=el("policy-test");
  box.style.display="";
  box.className="verdict-card "+esc(r.action);
  var parts='<div class="v-head">'
    +'<span class="badge '+esc(r.action)+'">'+esc(r.action)+'</span>'
    +(r.rule?'<span style="color:var(--text-muted);font-weight:500">rule #'+r.rule.id+'</span>'
            :'<span style="color:var(--text-muted);font-weight:500">no rule matched — default allow</span>')
    +'</div>';
  if(r.reason){
    parts+='<div style="color:var(--text);margin-bottom:8px">'+esc(r.reason)+'</div>';
  }
  if(r.note){
    parts+='<div style="color:var(--text-dim);font-size:12.5px">'+esc(r.note)+'</div>';
  }
  if(r.perKey&&r.perKey.length){
    parts+='<div style="margin-top:8px;color:var(--text-dim);font-size:11.5px;letter-spacing:.6px;text-transform:uppercase">Per substitution</div>';
    parts+=r.perKey.map(function(p){
      var act=p.decision.action;
      return '<div class="v-key">'
        +'<code>{{stm:'+esc(p.key)+'}}</code>'
        +'<span style="color:var(--text-dim)">\\u2192</span>'
        +'<span class="badge '+esc(act)+'">'+esc(act)+'</span>'
        +(p.decision.rule?'<span style="color:var(--text-dim);font-size:11.5px">rule #'+p.decision.rule.id+'</span>':'')
        +'</div>';
    }).join("");
  }
  box.innerHTML=parts;
}

function render(inv){
  el("spend").textContent="$"+inv.monthlySpend.toFixed(2);
  var kb=el("keys");
  if(!inv.keys.length){
    kb.innerHTML='<tr><td colspan="5" class="empty">No keys yet — add one above.</td></tr>';
  }else{
    kb.innerHTML=inv.keys.map(function(k){
      var rev=k.status==="active"
        ? '<button class="btn-ghost rev" style="height:28px;padding:0 12px" '
          +'data-tool="'+esc(k.tool)+'" data-label="'+esc(k.label)+'">Revoke</button>'
        : '';
      return '<tr><td>'+copyChip(k.placeholder)+'</td>'
        +'<td><span class="badge '+(k.status==="revoked"?"revoked":"active")+'">'
        +esc(k.status)+'</span></td>'
        +'<td class="source">'+esc(k.source)+'</td>'
        +'<td class="num" style="color:var(--text-muted)">'+esc(k.created_at.slice(0,10))+'</td>'
        +'<td style="text-align:right">'+rev+'</td></tr>';
    }).join("");
  }
  renderTools(inv.tools);
}

function renderTools(tools){
  var tb=el("tools");
  if(!tools.length){
    tb.innerHTML='<tr><td colspan="5" class="empty">No subscriptions tracked yet.</td></tr>';
    return;
  }
  tb.innerHTML=tools.map(function(t){
    if(t.name===editingTool){
      return '<tr data-tool="'+esc(t.name)+'">'
        +'<td>'+esc(t.display_name)+'</td>'
        +'<td><input class="ed-plan" value="'+esc(t.plan||"")+'" placeholder="Pro" '
        +'autocomplete="off" style="height:30px"></td>'
        +'<td><input class="ed-cost" type="number" min="0" step="0.01" '
        +'value="'+(t.monthly_cost!=null?t.monthly_cost:"")+'" placeholder="20" style="height:30px"></td>'
        +'<td><input class="ed-renews" type="date" value="'+esc(t.renews_on||"")+'" style="height:30px"></td>'
        +'<td style="text-align:right;white-space:nowrap">'
        +'<button class="btn-primary sub-save" style="height:30px;padding:0 12px" '
        +'data-tool="'+esc(t.name)+'">Save</button> '
        +'<button class="btn-ghost sub-cancel" style="height:30px;padding:0 10px">Cancel</button>'
        +'</td></tr>';
    }
    return '<tr>'
      +'<td>'+esc(t.display_name)+'</td>'
      +'<td style="color:var(--text-muted)">'+esc(t.plan||"\\u2014")+'</td>'
      +'<td class="num">'+(t.monthly_cost!=null?"$"+t.monthly_cost:'<span style="color:var(--text-dim)">\\u2014</span>')+'</td>'
      +'<td class="num" style="color:var(--text-muted)">'+esc(t.renews_on||"\\u2014")+'</td>'
      +'<td style="text-align:right"><button class="btn-ghost sub-edit" '
      +'style="height:28px;padding:0 12px" data-tool="'+esc(t.name)+'">Edit</button></td></tr>';
  }).join("");
}

async function saveSubscription(tool){
  var row=el("tools").querySelector('tr[data-tool="'+tool+'"]');
  if(!row)return;
  var plan=row.querySelector(".ed-plan").value.trim();
  var cost=row.querySelector(".ed-cost").value.trim();
  var renews=row.querySelector(".ed-renews").value.trim();
  try{
    await api("/api/tools/subscription",{method:"POST",body:JSON.stringify({
      tool:tool,plan:plan||null,cost:cost!==""?Number(cost):null,renews:renews||null})});
    editingTool=null;
    toast("Subscription updated");
    refresh();
  }catch(e){setMsg("add-msg",e.message,"err");}
}

function initSvc(){
  var opts="";
  for(var i=0;i<CATALOG.length;i++){
    opts+='<option value="'+i+'">'+esc(CATALOG[i].name)+'</option>';
  }
  opts+='<option value="other">Other (custom)</option>';
  el("svc").innerHTML=opts;
  renderSvcFields();
}

function renderSvcFields(){
  var v=el("svc").value, box=el("svc-fields");
  if(v==="other"){
    box.innerHTML=
      '<div class="grid cols-2" style="margin-top:16px">'
      +'<div class="field"><label for="o-tool">Tool</label>'
      +'<input id="o-tool" placeholder="my-service" autocomplete="off" spellcheck="false"></div>'
      +'<div class="field"><label for="o-label">Label</label>'
      +'<input id="o-label" value="default" autocomplete="off" spellcheck="false"></div></div>'
      +'<div class="field" style="margin-top:16px"><label for="o-value">Secret value</label>'
      +'<input id="o-value" type="password" autocomplete="off" '
      +'placeholder="paste it \\u2014 goes straight to your macOS Keychain"></div>';
    return;
  }
  var svc=CATALOG[Number(v)];
  box.innerHTML=svc.credentials.map(function(lbl,i){
    return '<div class="field" style="margin-top:16px">'
      +'<label for="cv-'+i+'">'+esc(svc.name)+' \\u00b7 <code>'+esc(lbl)+'</code></label>'
      +'<input id="cv-'+i+'" type="password" autocomplete="off" '
      +'placeholder="paste '+esc(lbl)+' \\u2014 leave blank to skip"></div>';
  }).join("")
  +'<div id="custom-fields"></div>'
  +'<button type="button" class="add-field" id="add-field-btn">+ Add another field</button>';
}

/** Append an empty custom (label + value) row for the selected service. */
function addCustomField(){
  var box=el("custom-fields"); if(!box)return;
  var row=document.createElement("div");
  row.className="cf-row";
  row.innerHTML=
    '<input class="cf-label" autocomplete="off" spellcheck="false" '
    +'placeholder="label \\u2014 e.g. jwt-secret">'
    +'<input class="cf-value" type="password" autocomplete="off" placeholder="value">'
    +'<button type="button" class="cf-del" title="Remove field">\\u2715</button>';
  box.appendChild(row);
  row.querySelector(".cf-label").focus();
}

async function addKeys(){
  var btn=el("add-btn"); btn.disabled=true;
  try{
    var v=el("svc").value, items=[];
    if(v==="other"){
      var t=val("o-tool"), lbl=val("o-label")||"default", value=el("o-value").value;
      if(!t||!value)throw new Error("Tool and secret value are required.");
      items.push({tool:t,label:lbl,value:value});
    }else{
      var svc=CATALOG[Number(v)];
      svc.credentials.forEach(function(lbl,i){
        var cv=el("cv-"+i).value;
        if(cv)items.push({tool:svc.id,label:lbl,value:cv});
      });
      var rows=document.querySelectorAll("#custom-fields .cf-row");
      for(var c=0;c<rows.length;c++){
        var cl=rows[c].querySelector(".cf-label").value.trim();
        var cvv=rows[c].querySelector(".cf-value").value;
        if(cl&&cvv)items.push({tool:svc.id,label:cl,value:cvv});
      }
      if(!items.length)throw new Error("Fill at least one field.");
    }
    var plan=val("k-plan")||null,
        cost=val("k-cost")?Number(val("k-cost")):null,
        renews=val("k-renews")||null;
    var added=[],errors=[];
    for(var i=0;i<items.length;i++){
      var it=items[i],body={tool:it.tool,label:it.label,value:it.value};
      if(i===0){body.plan=plan;body.cost=cost;body.renews=renews;}
      try{
        var r=await api("/api/keys",{method:"POST",body:JSON.stringify(body)});
        added.push(r.placeholder);
      }catch(e){errors.push(it.label+": "+e.message);}
    }
    renderSvcFields(); // re-render clears the value inputs
    ["k-plan","k-cost","k-renews"].forEach(function(i){el(i).value="";});
    var msg=added.length?("Added "+added.map(copyChip).join("  ")):"";
    if(errors.length)msg+=(msg?" \\u00b7 ":"")+esc(errors.length+" failed \\u2014 "+errors.join("; "));
    setMsgHTML("add-msg",msg,errors.length?"err":"ok");
    refresh();
  }catch(e){setMsg("add-msg",e.message,"err");}
  finally{btn.disabled=false;}
}

async function revoke(tool,label){
  try{
    await api("/api/keys/revoke",{method:"POST",body:JSON.stringify({tool:tool,label:label})});
    refresh();
  }catch(e){setMsg("add-msg",e.message,"err");}
}

async function scan(){
  setMsg("imp-msg","Scanning\\u2026");
  try{
    var dir=val("imp-dir");
    if(!dir)throw new Error("Enter a directory to scan.");
    var r=await api("/api/import/scan",{method:"POST",body:JSON.stringify({dirs:[dir]})});
    scanned=r.candidates;
    if(!scanned.length){
      setMsg("imp-msg","No candidate keys found in .env files under that directory.");
      el("imp-table").style.display="none"; el("imp-actions").style.display="none"; return;
    }
    setMsg("imp-msg","Found "+scanned.length+" candidate"+(scanned.length>1?"s":"")
      +" — review, relabel, and import.","ok");
    el("imp-rows").innerHTML=scanned.map(function(c,i){
      return '<tr><td class="mono" style="font-size:12.5px">'+esc(c.varName)+'</td>'
        +'<td class="mono" style="color:var(--text-dim);font-size:12.5px">'+esc(c.valueMasked)+'</td>'
        +'<td><input id="it-'+i+'" value="'+esc(c.suggestedTool)+'" style="height:30px"></td>'
        +'<td><input id="il-'+i+'" value="'+esc(c.suggestedLabel)+'" style="height:30px"></td>'
        +'<td style="text-align:center"><input type="checkbox" id="ic-'+i+'" checked '
        +'style="width:auto;height:auto"></td></tr>';
    }).join("");
    el("imp-table").style.display=""; el("imp-actions").style.display="";
  }catch(e){setMsg("imp-msg",e.message,"err");}
}

async function confirmImport(){
  var btn=el("imp-btn"); btn.disabled=true;
  try{
    var sel=scanned.map(function(c,i){
      return {file:c.file,varName:c.varName,tool:val("it-"+i),label:val("il-"+i),
        take:el("ic-"+i).checked};
    }).filter(function(s){return s.take;});
    if(!sel.length)throw new Error("Nothing selected.");
    var r=await api("/api/import/confirm",{method:"POST",body:JSON.stringify({selections:sel})});
    setMsg("imp-msg","Imported "+r.imported+" key"+(r.imported===1?"":"s")
      +(r.errors.length?" \\u00b7 "+r.errors.length+" error(s): "+r.errors.join("; "):""),
      r.errors.length?"err":"ok");
    refresh();
  }catch(e){setMsg("imp-msg",e.message,"err");}
  finally{btn.disabled=false;}
}

el("add-btn").addEventListener("click",addKeys);
el("add-policy-btn").addEventListener("click",addPolicy);
el("test-policy-btn").addEventListener("click",testPolicy);
el("policies").addEventListener("click",function(e){
  var b=e.target.closest(".pol-del"); if(!b)return;
  if(confirm("Remove rule #"+b.dataset.id+"?")) removePolicy(b.dataset.id);
});
// Enter key in the test box runs the test
el("p-test-cmd").addEventListener("keydown",function(e){
  if(e.key==="Enter"){ e.preventDefault(); testPolicy(); }
});
el("svc").addEventListener("change",renderSvcFields);
el("svc-fields").addEventListener("click",function(e){
  if(e.target.id==="add-field-btn"){ addCustomField(); return; }
  if(e.target.classList&&e.target.classList.contains("cf-del")){
    var row=e.target.closest(".cf-row"); if(row)row.remove();
  }
});
el("scan-btn").addEventListener("click",scan);
el("imp-btn").addEventListener("click",confirmImport);
el("keys").addEventListener("click",function(e){
  var b=e.target.closest(".rev"); if(!b)return;
  revoke(b.dataset.tool,b.dataset.label);
});
el("tools").addEventListener("click",function(e){
  var ed=e.target.closest(".sub-edit");
  if(ed){editingTool=ed.dataset.tool;if(lastInv)renderTools(lastInv.tools);return;}
  var ca=e.target.closest(".sub-cancel");
  if(ca){editingTool=null;if(lastInv)renderTools(lastInv.tools);return;}
  var sv=e.target.closest(".sub-save");
  if(sv){saveSubscription(sv.dataset.tool);}
});
document.addEventListener("click",function(e){
  var c=e.target.closest?e.target.closest(".copy"):null;
  if(c)copyText(c.dataset.ph);
});
initSvc();
refresh().catch(function(e){setMsg("add-msg","Failed to load: "+e.message,"err");});
</script>
</body>
</html>`;
}
