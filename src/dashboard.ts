// The dashboard web UI — a single self-contained HTML page.
//
// No build step, no framework, no external assets. The page reads its auth
// token from the URL (?token=) and sends it on every API call. Client JS uses
// string concatenation (no template literals) to keep this server-side
// template literal free of escaping hazards.

export function dashboardHTML(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>subscribetome</title>
<style>
  :root{--bg:#0f1115;--panel:#171a21;--line:#262b36;--fg:#e6e8ee;--mut:#8b93a7;--acc:#6ee7b7;}
  *{box-sizing:border-box;}
  body{margin:0;background:var(--bg);color:var(--fg);
    font:14px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace;}
  header{padding:20px 28px;border-bottom:1px solid var(--line);
    display:flex;justify-content:space-between;align-items:baseline;}
  h1{margin:0;font-size:18px;letter-spacing:.5px;}
  h1 span{color:var(--acc);}
  .spend{color:var(--mut);} .spend b{color:var(--fg);font-size:16px;}
  main{max-width:920px;margin:0 auto;padding:24px 28px;}
  section{background:var(--panel);border:1px solid var(--line);border-radius:10px;
    padding:18px 20px;margin-bottom:20px;}
  h2{margin:0 0 14px;font-size:12px;text-transform:uppercase;letter-spacing:1px;color:var(--mut);}
  label{display:block;font-size:12px;color:var(--mut);margin:10px 0 4px;}
  input,select{width:100%;background:var(--bg);border:1px solid var(--line);color:var(--fg);
    padding:8px 10px;border-radius:6px;font:inherit;}
  .row{display:flex;gap:12px;flex-wrap:wrap;} .row>div{flex:1;min-width:140px;}
  button{background:var(--acc);color:#06281d;border:0;padding:9px 16px;border-radius:6px;
    font:inherit;font-weight:700;cursor:pointer;margin-top:14px;}
  button.ghost{background:transparent;color:var(--mut);border:1px solid var(--line);font-weight:400;}
  table{width:100%;border-collapse:collapse;}
  th,td{text-align:left;padding:7px 8px;border-bottom:1px solid var(--line);vertical-align:top;}
  th{color:var(--mut);font-weight:600;font-size:12px;}
  code{color:var(--acc);}
  .revoked{color:var(--mut);text-decoration:line-through;}
  .msg{margin-top:10px;font-size:13px;min-height:18px;}
  .msg.ok{color:var(--acc);} .msg.err{color:#f87171;}
  .mut{color:var(--mut);} .note{font-size:12px;color:var(--mut);margin-top:8px;}
</style>
</head>
<body>
<header>
  <h1>subscribe<span>tome</span></h1>
  <div class="spend">monthly spend <b id="spend">$0.00</b></div>
</header>
<main>
  <section>
    <h2>Add a key</h2>
    <div class="row">
      <div><label>Tool</label><input id="k-tool" placeholder="openai"></div>
      <div><label>Label</label><input id="k-label" value="default"></div>
    </div>
    <label>API key value</label>
    <input id="k-value" type="password" placeholder="paste the key - it goes straight to your OS keychain">
    <div class="row">
      <div><label>Plan (optional)</label><input id="k-plan" placeholder="Pro"></div>
      <div><label>Monthly cost USD (optional)</label><input id="k-cost" type="number" placeholder="20"></div>
      <div><label>Renews on (optional)</label><input id="k-renews" type="date"></div>
    </div>
    <button id="add-btn">Add key</button>
    <div id="add-msg" class="msg"></div>
    <div class="note">The key value never appears in the Claude Code chat. After saving you
      only ever see its <code>{{stm:tool:label}}</code> placeholder.</div>
  </section>

  <section>
    <h2>API keys</h2>
    <table><thead><tr><th>Placeholder</th><th>Status</th><th>Source</th><th>Added</th><th></th></tr></thead>
      <tbody id="keys"></tbody></table>
    <h2 style="margin-top:20px">Subscriptions</h2>
    <table><thead><tr><th>Tool</th><th>Plan</th><th>Monthly</th><th>Renews</th></tr></thead>
      <tbody id="tools"></tbody></table>
  </section>

  <section>
    <h2>Import from .env files</h2>
    <div class="row"><div><label>Directory to scan</label>
      <input id="imp-dir" placeholder="/Users/you/projects"></div></div>
    <button id="scan-btn" class="ghost">Scan</button>
    <div id="imp-msg" class="msg"></div>
    <table id="imp-table" style="display:none;margin-top:10px">
      <thead><tr><th>Var</th><th>Value</th><th>Tool</th><th>Label</th><th>Import</th></tr></thead>
      <tbody id="imp-rows"></tbody></table>
    <button id="imp-btn" style="display:none">Import selected</button>
  </section>
</main>
<script>
var TOKEN = new URLSearchParams(location.search).get("token") || "";
var scanned = [];

function esc(s){return String(s).replace(/[&<>"]/g,function(c){
  return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c];});}
function val(id){return document.getElementById(id).value.trim();}
function setMsg(id,text,cls){var m=document.getElementById(id);m.textContent=text;
  m.className="msg"+(cls?" "+cls:"");}

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
  document.getElementById("spend").textContent="$"+inv.monthlySpend.toFixed(2);
  var kb=document.getElementById("keys");
  if(!inv.keys.length){kb.innerHTML='<tr><td colspan="5" class="mut">no keys yet</td></tr>';}
  else{kb.innerHTML=inv.keys.map(function(k){
    var rev=k.status==="active"
      ? '<button class="ghost rev" style="margin:0;padding:3px 8px" data-tool="'
        +esc(k.tool)+'" data-label="'+esc(k.label)+'">revoke</button>' : '';
    return '<tr><td><code>'+esc(k.placeholder)+'</code></td>'
      +'<td class="'+(k.status==="revoked"?"revoked":"")+'">'+esc(k.status)+'</td>'
      +'<td>'+esc(k.source)+'</td><td>'+esc(k.created_at.slice(0,10))+'</td>'
      +'<td>'+rev+'</td></tr>';}).join("");}
  var tb=document.getElementById("tools");
  if(!inv.tools.length){tb.innerHTML='<tr><td colspan="4" class="mut">no tools yet</td></tr>';}
  else{tb.innerHTML=inv.tools.map(function(t){
    return '<tr><td>'+esc(t.display_name)+'</td><td>'+esc(t.plan||"-")+'</td>'
      +'<td>'+(t.monthly_cost!=null?"$"+t.monthly_cost:"-")+'</td>'
      +'<td>'+esc(t.renews_on||"-")+'</td></tr>';}).join("");}
}

async function addKey(){
  try{
    var body={tool:val("k-tool"),label:val("k-label"),value:val("k-value"),
      plan:val("k-plan")||null,cost:val("k-cost")?Number(val("k-cost")):null,
      renews:val("k-renews")||null};
    if(!body.tool||!body.value)throw new Error("tool and key value are required");
    var r=await api("/api/keys",{method:"POST",body:JSON.stringify(body)});
    setMsg("add-msg","added "+r.placeholder,"ok");
    document.getElementById("k-value").value="";
    ["k-plan","k-cost","k-renews"].forEach(function(i){document.getElementById(i).value="";});
    refresh();
  }catch(e){setMsg("add-msg",e.message,"err");}
}

async function revoke(tool,label){
  try{await api("/api/keys/revoke",{method:"POST",body:JSON.stringify({tool:tool,label:label})});
    refresh();}catch(e){setMsg("add-msg",e.message,"err");}
}

async function scan(){
  setMsg("imp-msg","scanning...");
  try{
    var dir=val("imp-dir");
    if(!dir)throw new Error("enter a directory to scan");
    var r=await api("/api/import/scan",{method:"POST",body:JSON.stringify({dirs:[dir]})});
    scanned=r.candidates;
    var tbl=document.getElementById("imp-table"),btn=document.getElementById("imp-btn");
    if(!scanned.length){setMsg("imp-msg","no candidate keys found");
      tbl.style.display="none";btn.style.display="none";return;}
    setMsg("imp-msg","found "+scanned.length+" candidate(s)","ok");
    document.getElementById("imp-rows").innerHTML=scanned.map(function(c,i){
      return '<tr><td>'+esc(c.varName)+'</td><td class="mut">'+esc(c.valueMasked)+'</td>'
        +'<td><input id="it-'+i+'" value="'+esc(c.suggestedTool)+'" style="padding:4px"></td>'
        +'<td><input id="il-'+i+'" value="'+esc(c.suggestedLabel)+'" style="padding:4px"></td>'
        +'<td><input type="checkbox" id="ic-'+i+'" checked></td></tr>';}).join("");
    tbl.style.display="";btn.style.display="";
  }catch(e){setMsg("imp-msg",e.message,"err");}
}

async function confirmImport(){
  try{
    var sel=scanned.map(function(c,i){
      return {file:c.file,varName:c.varName,tool:val("it-"+i),label:val("il-"+i),
        take:document.getElementById("ic-"+i).checked};})
      .filter(function(s){return s.take;});
    if(!sel.length)throw new Error("nothing selected");
    var r=await api("/api/import/confirm",{method:"POST",body:JSON.stringify({selections:sel})});
    setMsg("imp-msg","imported "+r.imported
      +(r.errors.length?" - "+r.errors.length+" error(s): "+r.errors.join("; "):""),
      r.errors.length?"err":"ok");
    refresh();
  }catch(e){setMsg("imp-msg",e.message,"err");}
}

document.getElementById("add-btn").addEventListener("click",addKey);
document.getElementById("scan-btn").addEventListener("click",scan);
document.getElementById("imp-btn").addEventListener("click",confirmImport);
document.getElementById("keys").addEventListener("click",function(e){
  var b=e.target.closest(".rev");if(!b)return;
  revoke(b.dataset.tool,b.dataset.label);});

refresh().catch(function(e){setMsg("add-msg","failed to load: "+e.message,"err");});
</script>
</body>
</html>`;
}
