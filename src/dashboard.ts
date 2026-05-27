// The dashboard web UI — a single self-contained HTML page.
//
// No build step, no framework, no external assets. The page reads its auth
// token from the URL (?token=) and sends it on every API call.
//
// Styling follows a three-layer token architecture (primitive -> semantic ->
// component) expressed as CSS custom properties, with systematic spacing and
// type scales. Client JS uses string concatenation (no template literals) to
// keep this server-side template literal free of escaping hazards.

import { CATALOG, CATEGORY_LABEL, CATEGORY_ORDER } from "./catalog.ts";

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

  /* ---- browse services (catalog browser, v0.2.6) ---- */
  .browse-intro {
    font-size:13px; color:var(--text-dim); margin-bottom:calc(var(--space)*4);
    max-width:62ch;
  }
  .svc-grid {
    display:grid; grid-template-columns:repeat(auto-fill,minmax(140px,1fr));
    gap:calc(var(--space)*3);
  }
  .svc-tile {
    display:flex; align-items:center; justify-content:space-between;
    gap:calc(var(--space)*2);
    background:var(--ink-850); border:1px solid var(--border);
    border-radius:var(--r-md); padding:calc(var(--space)*3) calc(var(--space)*4);
    color:var(--text); font-size:13px; font-weight:500;
    cursor:pointer; user-select:none; text-align:left;
    transition:border-color 120ms ease, background 120ms ease, transform 120ms ease;
    font-family:inherit;
  }
  .svc-tile:hover {
    border-color:var(--emerald-400); background:rgba(52,211,154,.06);
    transform:translateY(-1px);
  }
  .svc-tile:focus-visible {
    outline:2px solid var(--emerald-400); outline-offset:2px;
  }
  .svc-tile .ext { color:var(--text-muted); font-size:12px; }
  .svc-tile:hover .ext { color:var(--emerald-300); }
  @keyframes stm-flash {
    0%   { box-shadow:0 0 0 0 rgba(52,211,154,.0), inset 0 0 0 1px var(--border); }
    20%  { box-shadow:0 0 0 4px rgba(52,211,154,.35), inset 0 0 0 1px var(--emerald-400); }
    100% { box-shadow:0 0 0 0 rgba(52,211,154,.0), inset 0 0 0 1px var(--border); }
  }
  .card.flash { animation:stm-flash 1.5s ease-out; }

  /* ---- keystore label (v0.3.1) ---- */
  .keystore-label {
    margin-right:14px; font-size:11px; font-weight:600; letter-spacing:.4px;
    text-transform:uppercase; color:var(--text-dim);
    padding:3px 9px; border-radius:999px;
    background:rgba(255,255,255,.04); border:1px solid var(--border);
  }

  /* ---- spend visibility (v0.3.0) ---- */
  .spend-source {
    display:inline-block; margin-left:8px;
    font-size:11px; font-weight:600; letter-spacing:.4px; text-transform:uppercase;
    padding:2px 8px; border-radius:999px;
    background:rgba(255,255,255,.04); color:var(--text-dim);
    border:1px solid var(--border);
  }
  .spend-source.fetched { color:var(--emerald-300); border-color:rgba(52,211,154,.3); }
  .spend-source.partial { color:#fbbf24; border-color:rgba(251,191,36,.3); }
  .spend-source.self    { color:var(--text-dim); }
  .spend-tag {
    display:inline-block; font-size:10.5px; padding:1px 6px; border-radius:4px;
    color:var(--text-dim); background:rgba(255,255,255,.04);
    border:1px solid var(--border); margin-left:6px;
  }
  .spend-tag.fetched { color:var(--emerald-300); border-color:rgba(52,211,154,.3); }
  .spend-tag.error   { color:var(--danger); border-color:rgba(245,101,101,.3); }
  .sync-log {
    margin-top:calc(var(--space)*3);
    padding:calc(var(--space)*3) calc(var(--space)*4);
    background:var(--ink-850); border:1px solid var(--border);
    border-radius:var(--r-md); font-family:var(--font-mono); font-size:12px;
    color:var(--text); white-space:pre-wrap; line-height:1.55;
    max-height:200px; overflow-y:auto;
  }
  .sync-log .ok { color:var(--emerald-300); }
  .sync-log .bad { color:var(--danger); }
  .sync-log .meta { color:var(--text-dim); }

  /* ---- session signal (?from=<cwd>) ---- */
  .session-signal {
    margin-bottom:calc(var(--space)*4);
    padding:calc(var(--space)*3) calc(var(--space)*4);
    background:rgba(52,211,154,.05); border:1px solid rgba(52,211,154,.25);
    border-radius:var(--r-md); font-size:13px; color:var(--text);
    display:flex; align-items:center; gap:calc(var(--space)*3); flex-wrap:wrap;
  }
  .session-signal.unmatched {
    background:var(--ink-850); border-color:var(--border);
    color:var(--text-dim);
  }
  .session-signal code {
    color:var(--text); background:rgba(255,255,255,.05);
    padding:1px 6px; border-radius:4px; font-size:12px;
  }
  .session-signal .pill {
    margin-left:auto;
  }

  /* ---- tab bar (top-level navigation) ---- */
  .tab-bar {
    display:flex; gap:2px;
    margin-bottom:calc(var(--space)*5);
    border-bottom:1px solid var(--border);
    overflow-x:auto; -webkit-overflow-scrolling:touch;
  }
  .tab {
    background:transparent; border:0; border-bottom:2px solid transparent;
    padding:10px 18px; margin-bottom:-1px;
    color:var(--text-muted); font-size:13.5px; font-weight:500;
    white-space:nowrap; cursor:pointer;
    transition:color .15s var(--ease), border-color .15s var(--ease);
  }
  .tab:hover { color:var(--text); }
  .tab.active { color:var(--text); border-bottom-color:var(--primary); }
  .tab-panel { display:none; }
  .tab-panel.active { display:block; animation:fade-in .18s var(--ease); }
  @keyframes fade-in { from { opacity:0; transform:translateY(2px); } to { opacity:1; transform:none; } }

  /* ---- projects card (Phase 2) ---- */
  .proj-row {
    border:1px solid var(--border); border-radius:var(--r-md);
    padding:calc(var(--space)*4); margin-bottom:calc(var(--space)*3);
    background:var(--ink-850);
  }
  .proj-row .head {
    display:grid; grid-template-columns:auto 1fr auto;
    align-items:center; gap:calc(var(--space)*3);
    margin-bottom:calc(var(--space)*2);
  }
  .proj-row .head .name {
    font-size:14px; font-weight:600; color:var(--text);
  }
  .proj-row .head .path {
    font-family:var(--mono,ui-monospace,monospace); font-size:12px;
    color:var(--text-dim);
    overflow:hidden; text-overflow:ellipsis; white-space:nowrap; min-width:0;
  }
  .proj-row .head .controls {
    display:flex; gap:8px; align-items:center; flex-shrink:0;
  }
  @media (max-width:680px) {
    .proj-row .head {
      grid-template-columns:1fr;
    }
    .proj-row .head .controls { flex-wrap:wrap; }
  }
  .proj-pills {
    display:flex; flex-wrap:wrap; gap:6px; margin-top:6px;
  }
  .proj-pills code.copy {
    background:rgba(255,255,255,.04); border:1px solid var(--border);
    padding:3px 8px; font-size:12px;
  }
  .proj-pills .empty {
    font-size:12.5px; color:var(--text-dim); font-style:italic;
  }
  /* Enforce-scope as a real toggle switch (not a checkbox pill) — the
     pill+button cluster previously had matching transparent borders so
     "Enforce" and "Edit scope" text appeared to overlap. A track-and-
     thumb switch is visually distinct from the adjacent ghost buttons. */
  .proj-enforce {
    display:inline-flex; align-items:center; gap:8px;
    font-size:12px; color:var(--text-muted);
    cursor:pointer; user-select:none;
    padding:0 4px;
    transition:color .15s var(--ease);
  }
  .proj-enforce:hover { color:var(--text); }
  .proj-enforce input {
    appearance:none; -webkit-appearance:none;
    position:relative;
    width:32px; height:18px; border-radius:999px;
    background:var(--ink-700); border:1px solid var(--border-strong);
    margin:0; cursor:pointer; flex:none;
    transition:background .15s var(--ease), border-color .15s var(--ease);
  }
  .proj-enforce input::after {
    content:""; position:absolute;
    top:50%; left:2px; transform:translateY(-50%);
    width:12px; height:12px; border-radius:50%;
    background:var(--text-dim);
    transition:left .15s var(--ease), background .15s var(--ease);
  }
  .proj-enforce input:checked {
    background:rgba(52,211,154,.18); border-color:var(--primary);
  }
  .proj-enforce input:checked::after { left:16px; background:var(--primary); }
  .proj-enforce:has(input:checked) { color:var(--primary); }
  .proj-edit {
    margin-top:calc(var(--space)*3); padding-top:calc(var(--space)*3);
    border-top:1px solid var(--border);
  }
  .proj-edit .checklist {
    display:grid; grid-template-columns:repeat(auto-fill,minmax(240px,1fr));
    gap:6px 12px; margin-top:calc(var(--space)*2);
  }
  .proj-edit .checklist label {
    display:flex; align-items:center; gap:8px;
    font-size:12.5px; color:var(--text); cursor:pointer;
    padding:4px 6px; border-radius:6px;
  }
  .proj-edit .checklist label:hover { background:rgba(255,255,255,.03); }
  .proj-edit .checklist input { accent-color:var(--emerald-400); }
  .proj-add {
    display:grid; grid-template-columns:2fr 2fr auto; gap:calc(var(--space)*3);
    align-items:end; margin-top:calc(var(--space)*3);
  }
  @media (max-width:640px) {
    .proj-add { grid-template-columns:1fr; }
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

  /* ---- audit log subview ---- */
  .audit-controls {
    display:grid; grid-template-columns:180px 1fr auto auto;
    gap:calc(var(--space)*3); align-items:center; margin-top:calc(var(--space)*3);
  }
  .audit-controls select,
  .audit-controls input { height:34px; }
  .audit-controls button { height:34px; }
  .ev-badge {
    display:inline-block; font-size:10.5px; font-weight:600; padding:2px 8px;
    border-radius:999px; text-transform:lowercase; letter-spacing:.3px;
    font-family:var(--font-mono);
  }
  .ev-substitute  { background:rgba(52,211,154,.13); color:var(--emerald-300); }
  .ev-policy-deny { background:rgba(240,109,109,.13); color:var(--red-400); }
  .ev-policy-warn { background:rgba(245,185,66,.13); color:var(--amber-400); }
  .ev-unresolved  { background:rgba(245,185,66,.10); color:var(--amber-400); }
  .ev-malformed   { background:rgba(139,148,164,.14); color:var(--text-muted); }
  #audit-rows td {
    font-family:var(--font-mono); font-size:12px;
    padding:calc(var(--space)*2) calc(var(--space)*2);
    color:var(--text-muted);
  }
  #audit-rows td.t-time { color:var(--text-dim); font-variant-numeric:tabular-nums; }
  #audit-rows td.t-key  { color:var(--primary-bright); }
  @media (max-width:640px) {
    .policy-grid,.policy-row2 { grid-template-columns:1fr; }
    .audit-controls { grid-template-columns:1fr; }
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
  <div class="spend">
    <span id="agents-label" class="keystore-label agents-label"
      title="Agents stm wraps today. Different agents have different security guarantees — hover the entry on the spec page for the trade-off."></span>
    <span id="keystore-label" class="keystore-label"></span>
    monthly spend <b id="spend">$0.00</b>
    <span id="spend-source" class="spend-source"></span>
    <button class="btn-ghost" id="sync-btn" style="margin-left:12px"
      title="Outbound calls only happen when you click this — only to the providers you've configured.">
      Sync spend
    </button>
  </div>
</header>

<main>
  <div id="session-signal" class="session-signal" style="display:none"></div>

  <div class="tab-bar" role="tablist" aria-label="Sections">
    <button class="tab active" data-tab="keys" role="tab" aria-selected="true">Keys</button>
    <button class="tab" data-tab="projects" role="tab" aria-selected="false">Projects</button>
    <button class="tab" data-tab="policy" role="tab" aria-selected="false">Policy &amp; audit</button>
    <button class="tab" data-tab="import" role="tab" aria-selected="false">Import</button>
  </div>

  <div class="tab-panel active" data-panel="keys" role="tabpanel">
  <section class="card">
    <div class="card-head"><h2>API keys</h2><span class="meta">Click a placeholder to copy</span></div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Placeholder</th><th>Status</th><th>Source</th><th>Added</th><th></th></tr></thead>
        <tbody id="keys"></tbody>
      </table>
    </div>
    <div class="sub-head" style="display:flex;align-items:center;justify-content:space-between">
      <span>Subscriptions</span>
      <span style="font-weight:400;text-transform:none;letter-spacing:.2px;font-size:12px;color:var(--text-dim)">
        stm makes outbound calls only when you click Sync spend &middot; only to providers you have configured
      </span>
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Tool</th><th>Plan</th><th>Monthly</th><th>Renews</th><th></th></tr></thead>
        <tbody id="tools"></tbody>
      </table>
    </div>
    <div id="sync-log" class="sync-log" style="display:none"></div>
  </section>

  <section id="add-keys-card" class="card">
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
    <p class="note">Secrets go straight to your OS keychain — never the Claude Code
      chat. Pick a service for its standard fields, or "Other" for a custom one; fill
      only the fields you have. You and the model only ever see each
      <code>{{stm:tool:label}}</code> placeholder.</p>
  </section>

  <section id="browse-services" class="card">
    <div class="card-head" style="cursor:pointer" id="browse-head">
      <h2><span id="browse-caret" style="display:inline-block;width:14px;transition:transform .15s var(--ease)">▸</span> Browse services</h2>
      <span class="meta">50 pre-configured · click a tile to pre-arm the form above</span>
    </div>
    <div id="browse-body" style="display:none">
      <p class="browse-intro">
        Pick what you want to wire up. Each tile opens the provider's
        API-keys page in a new tab and pre-arms the Add keys form above —
        paste the key when you come back.
      </p>
      <div id="svc-categories"></div>
    </div>
  </section>
  </div><!-- /tab-panel keys -->

  <div class="tab-panel" data-panel="projects" role="tabpanel">
  <section id="projects-card" class="card">
    <div class="card-head">
      <h2>Projects</h2>
      <span class="meta">Per-project key scope · longest-prefix cwd match</span>
    </div>
    <p class="note" style="margin-top:0;padding-top:0;border-top:0">
      Register a project (path + name), then pick which keys are in
      scope. SessionStart will tell only those keys to Claude Code when
      a session opens inside that path. Flip <b>Enforce</b> on to make
      PreToolUse refuse out-of-scope substitutions.
    </p>
    <div id="projects-list"></div>
    <div class="sub-head">Add a project</div>
    <div class="proj-add">
      <div class="field"><label for="proj-path">Path</label>
        <input id="proj-path" class="mono" placeholder="~/code/acme-app" autocomplete="off" spellcheck="false"></div>
      <div class="field"><label for="proj-name">Name</label>
        <input id="proj-name" placeholder="Acme App" autocomplete="off"></div>
      <button class="btn-primary" id="proj-add-btn">Add</button>
    </div>
    <div id="proj-msg" class="msg"></div>
  </section>
  </div><!-- /tab-panel projects -->

  <div class="tab-panel" data-panel="policy" role="tabpanel">
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

    <div class="sub-head" style="display:flex;align-items:center;justify-content:space-between">
      <span>Recent decisions</span>
      <span style="font-weight:400;text-transform:none;letter-spacing:.2px;font-size:12px;color:var(--text-dim)">
        forensic log of what PreToolUse did · never holds a real key value
      </span>
    </div>
    <div class="audit-controls">
      <select id="audit-event">
        <option value="">All events</option>
        <option value="substitute">substitute</option>
        <option value="policy.deny">policy.deny</option>
        <option value="policy.warn">policy.warn</option>
        <option value="unresolved">unresolved</option>
        <option value="malformed">malformed</option>
      </select>
      <input id="audit-tool" placeholder="filter by tool (optional)" autocomplete="off" spellcheck="false">
      <button class="btn-ghost" id="audit-refresh-btn">Refresh</button>
      <button class="btn-ghost" id="audit-clear-btn" style="color:var(--danger);border-color:var(--danger)">Clear log</button>
    </div>
    <div class="table-wrap" style="margin-top:12px">
      <table>
        <thead><tr>
          <th style="width:135px">Time</th>
          <th style="width:110px">Event</th>
          <th>Key</th>
          <th>Info</th>
        </tr></thead>
        <tbody id="audit-rows"></tbody>
      </table>
    </div>
    <div id="audit-meta" style="margin-top:8px;font-size:12px;color:var(--text-dim)"></div>

    <p class="note">Rules evaluate at <code>PreToolUse</code>, before the keychain is read.
      Strictest verdict wins per command (<code>deny &gt; warn &gt; allow</code>).
      No matching rule means allow — add a final catch-all to flip to default-deny.
      A predicate left blank matches anything.</p>
  </section>
  </div><!-- /tab-panel policy -->

  <div class="tab-panel" data-panel="import" role="tabpanel">
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
  </div><!-- /tab-panel import -->
</main>

<div id="toast" class="toast" role="status" aria-live="polite"></div>

<script>
var TOKEN = new URLSearchParams(location.search).get("token") || "";
var CATALOG = ${JSON.stringify(CATALOG)};
var CATEGORY_LABEL = ${JSON.stringify(CATEGORY_LABEL)};
var CATEGORY_ORDER = ${JSON.stringify(CATEGORY_ORDER)};
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
  refreshAudit().catch(function(e){
    el("audit-meta").textContent="Failed to load audit log: "+e.message;
  });
  refreshProjects().catch(function(e){
    setMsg("proj-msg","Failed to load projects: "+e.message,"err");
  });
}

function fmtTs(iso){
  if(!iso)return "";
  return iso.slice(0,10)+" "+iso.slice(11,19);
}
function evClass(ev){
  return "ev-badge ev-"+ev.replace(".","-");
}
function renderAudit(rows,total){
  var tb=el("audit-rows");
  if(!rows.length){
    tb.innerHTML='<tr><td colspan="4" class="empty" style="font-family:inherit">No audit rows. Run a command with an stm placeholder to see one appear.</td></tr>';
    el("audit-meta").textContent=total>0?(total+" total rows · none match the current filter"):"";
    return;
  }
  tb.innerHTML=rows.map(function(r){
    var key=r.tool&&r.label
      ? "{{stm:"+esc(r.tool)+":"+esc(r.label)+"}}"
      : (r.tool||r.label||"\\u2014");
    var info="";
    if(r.policy_id){
      info='rule #'+r.policy_id+(r.reason?': '+esc(r.reason):'');
    }else if(r.reason){
      info=esc(r.reason);
    }
    return '<tr>'
      +'<td class="t-time">'+esc(fmtTs(r.ts))+'</td>'
      +'<td><span class="'+evClass(r.event)+'">'+esc(r.event)+'</span></td>'
      +'<td class="t-key">'+key+'</td>'
      +'<td>'+info+'</td></tr>';
  }).join("");
  var shown=rows.length;
  el("audit-meta").textContent=shown+" row"+(shown===1?"":"s")+" shown · "+total+" total in log";
}
async function refreshAudit(){
  var qs=[];
  var ev=el("audit-event").value;
  var tool=val("audit-tool");
  qs.push("limit=50");
  if(ev)qs.push("event="+encodeURIComponent(ev));
  if(tool)qs.push("tool="+encodeURIComponent(tool));
  var r=await api("/api/audit?"+qs.join("&"));
  renderAudit(r.rows||[],r.count||0);
}
async function clearAuditLog(){
  if(!confirm("Delete every row in the audit log? This cannot be undone."))return;
  try{
    var r=await api("/api/audit/clear",{method:"POST"});
    toast("Cleared "+r.removed+" row"+(r.removed===1?"":"s"));
    refreshAudit();
  }catch(e){
    el("audit-meta").textContent="Failed to clear: "+e.message;
  }
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

// ---- projects (Phase 2 of session-and-project-scope) -------------------

/**
 * Cache the last-rendered projects list so toggling an enforce switch or
 * removing a scope pill can update one row without a full refetch.
 * Editing-state lives here too: the id of the project whose checklist
 * is currently expanded, or null.
 */
var lastProjects = [];
var editingProject = null;

async function refreshProjects(){
  var r=await api("/api/projects");
  lastProjects=r.projects||[];
  renderProjects(lastProjects);
}

function renderProjects(projects){
  var box=el("projects-list"); if(!box)return;
  if(!projects.length){
    box.innerHTML='<div class="note" style="margin:0;padding:0;border-top:0">'
      +'No projects registered. Add one below — its path matches your '
      +"session's <code>cwd</code> by longest prefix."
      +'</div>';
    return;
  }
  // Catalog of every (tool,label) the user has stored. Drives the checklist
  // in the edit panel. Active keys only — a revoked key shouldn't appear.
  var allKeys=lastInv?lastInv.keys.filter(function(k){return k.status==="active";}):[];
  var html="";
  for(var i=0;i<projects.length;i++){
    var p=projects[i];
    var pills="";
    if(p.scope.length===0){
      pills='<span class="empty">no keys scoped yet</span>';
    } else {
      pills=p.scope.map(function(s){
        return '<code class="copy" data-ph="'+esc(s.placeholder)+'">'+esc(s.placeholder)+'</code>';
      }).join("");
    }
    html+='<div class="proj-row" data-id="'+p.id+'">';
    html+='<div class="head">';
    html+='<span class="name">'+esc(p.name)+'</span>';
    html+='<span class="path">'+esc(p.path)+'</span>';
    html+='<span class="controls">';
    html+='<label class="proj-enforce" title="When ON, PreToolUse denies any out-of-scope substitution in this project">'
      +'<input type="checkbox" class="enf" data-id="'+p.id+'"'+(p.enforce_scope===1?' checked':'')+'>'
      +'<span>Enforce</span></label>';
    html+='<button class="btn-ghost proj-edit-btn" data-id="'+p.id+'">'
      +(editingProject===p.id?'Done':'Edit scope')+'</button>';
    html+='<button class="btn-ghost proj-remove-btn" data-id="'+p.id+'" '
      +'style="color:var(--danger);border-color:var(--danger)">Remove</button>';
    html+='</span></div>';
    html+='<div class="proj-pills">'+pills+'</div>';
    if(editingProject===p.id){
      html+='<div class="proj-edit">';
      html+='<div class="sub-head" style="margin:0">In-scope keys</div>';
      if(allKeys.length===0){
        html+='<p class="note" style="margin:8px 0 0;padding:0;border-top:0">'
          +'No keys stored yet. Add one in the Add keys card above, then come back.</p>';
      } else {
        var inScope={};
        for(var s=0;s<p.scope.length;s++){
          inScope[p.scope[s].tool+":"+p.scope[s].label]=true;
        }
        html+='<div class="checklist">';
        for(var j=0;j<allKeys.length;j++){
          var k=allKeys[j];
          var addr=k.tool+":"+k.label;
          var checked=inScope[addr]?' checked':'';
          html+='<label><input type="checkbox" class="scope-toggle" data-id="'+p.id+'"'
            +' data-tool="'+esc(k.tool)+'" data-label="'+esc(k.label)+'"'+checked+'>'
            +esc(k.placeholder)+'</label>';
        }
        html+='</div>';
      }
      html+='</div>';
    }
    html+='</div>';
  }
  box.innerHTML=html;
}

async function addProject(){
  var btn=el("proj-add-btn"); btn.disabled=true;
  try{
    var p=val("proj-path"), n=val("proj-name");
    if(!p||!n)throw new Error("Path and name are both required.");
    await api("/api/projects",{method:"POST",body:JSON.stringify({path:p,name:n})});
    el("proj-path").value=""; el("proj-name").value="";
    setMsg("proj-msg","Project added.","ok");
    refreshProjects();
  }catch(e){setMsg("proj-msg",e.message,"err");}
  finally{btn.disabled=false;}
}

async function removeProjectRow(id){
  try{
    await api("/api/projects/"+encodeURIComponent(id),{method:"DELETE"});
    if(editingProject===id)editingProject=null;
    toast("Project removed");
    refreshProjects();
  }catch(e){setMsg("proj-msg",e.message,"err");}
}

async function toggleEnforce(id,on){
  try{
    await api("/api/projects/"+encodeURIComponent(id)+"/enforce",
      {method:"POST",body:JSON.stringify({on:on})});
    toast(on?"Enforcement ON":"Enforcement OFF");
    refreshProjects();
  }catch(e){setMsg("proj-msg",e.message,"err"); refreshProjects();}
}

async function toggleScope(id,tool,label,on){
  try{
    await api("/api/projects/"+encodeURIComponent(id)+"/scope",
      {method:on?"POST":"DELETE",
       body:JSON.stringify({tool:tool,label:label})});
    refreshProjects();
  }catch(e){setMsg("proj-msg",e.message,"err"); refreshProjects();}
}

/**
 * Resolve ?from=<cwd> from the URL and render the session signal at the
 * top of the dashboard. When the cwd maps to a registered project, the
 * signal links to that project's row; otherwise it offers a "Create
 * project from this path" affordance.
 */
async function renderSessionSignal(){
  var box=el("session-signal"); if(!box)return;
  var from=new URLSearchParams(location.search).get("from");
  if(!from){ box.style.display="none"; return; }
  try{
    var r=await api("/api/projects/match?cwd="+encodeURIComponent(from));
    if(r.project){
      box.className="session-signal";
      var n=r.project.scope.length;
      box.innerHTML='Session in <b>'+esc(r.project.name)+'</b> · '
        +n+' key'+(n===1?'':'s')+' in scope · '
        +'<code>'+esc(r.project.path)+'</code>'
        +'<button class="btn-ghost pill" data-pid="'+r.project.id+'" id="signal-edit-btn">Edit scope</button>';
    } else {
      box.className="session-signal unmatched";
      box.innerHTML='Session in <code>'+esc(r.cwd||from)+'</code> · no project matches this path · '
        +'<button class="btn-primary pill" id="signal-create-btn" data-cwd="'+esc(r.cwd||from)+'">'
        +'Create project from this path</button>';
    }
    box.style.display="";
  }catch(e){
    /* signal is best-effort — hide silently on error so it never blocks the dashboard */
    box.style.display="none";
  }
}

/**
 * "Create project from this path" — prefills the Add-project form with
 * the cwd and a name derived from the last path segment, then scrolls
 * and flashes the Projects card so the user can confirm + tweak before
 * submitting.
 */
function prefillProjectFromCwd(cwd){
  var name=cwd.replace(/\\/+$/,"").split("/").filter(Boolean).pop() || cwd;
  el("proj-path").value=cwd;
  el("proj-name").value=name;
  var card=el("projects-card");
  if(card){
    card.scrollIntoView({behavior:"smooth",block:"start"});
    flashCard("projects-card");
  }
  el("proj-name").focus();
  el("proj-name").select();
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
  renderSpendSource(inv);
  // v0.3.1: surface where keys actually live — per the cross-platform
  // spec the active backend must never be hidden from the user.
  var kl=el("keystore-label");
  if(kl){
    if(inv.keystore){
      kl.textContent=String(inv.keystore);
      kl.title="Keys live in: "+String(inv.keystore);
      kl.style.display="";
    } else {
      kl.style.display="none";
    }
  }
  // v0.4.0: surface which agents stm wraps. Codex (session-env mode) is
  // weaker than Claude Code (per-command rewrite) and the spec mandates
  // that trade-off be visible everywhere the active agent is shown.
  var al=el("agents-label");
  if(al){
    if(inv.agents && inv.agents.length){
      var labels=inv.agents.map(function(a){return a.label;}).join(" · ");
      al.textContent="agents: "+labels;
      al.title="Each agent has its own security posture. Claude Code rewrites "+
        "the command per-call (transcript stays clean). Codex injects keys as "+
        "session env vars (weaker — the keys live in the agent's process env "+
        "for the whole session). See specs/cross-platform-and-codex.md §6.";
      al.style.display="";
    } else {
      al.style.display="none";
    }
  }
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
  // Stash fetched spend rows (keyed by tool name) so renderTools can
  // tag each subscription row with its source ("fetched" vs implicit
  // "self-reported"). Empty object when /api/inventory returns no
  // spend rows yet — back-compat for users with no sync configured.
  lastSpend = {};
  if (Array.isArray(inv.spend)) {
    for (var i = 0; i < inv.spend.length; i++) {
      lastSpend[inv.spend[i].tool] = inv.spend[i];
    }
  }
  renderTools(inv.tools);
}

/**
 * Render the spend-source pill next to the monthly-spend total in the
 * header. Three states per specs/spend-visibility.md §4:
 *   - "fetched"      — every tracked tool has a fetched number
 *   - "partial"      — some fetched, some self-reported
 *   - "self-reported"— manual ledger only (today's state)
 *   - "" (hidden)    — no monthly_cost AND no fetched data yet
 */
function renderSpendSource(inv){
  var pill = el("spend-source"); if (!pill) return;
  var b = inv.monthlySpendBreakdown || { fetched:0, manual:0, fetchedTools:0, manualTools:0 };
  if (b.fetchedTools > 0 && b.manualTools === 0) {
    pill.textContent = "fetched"; pill.className = "spend-source fetched";
  } else if (b.fetchedTools > 0 && b.manualTools > 0) {
    pill.textContent = "partial"; pill.className = "spend-source partial";
  } else if (b.manualTools > 0) {
    pill.textContent = "self-reported"; pill.className = "spend-source self";
  } else {
    pill.textContent = ""; pill.className = "spend-source";
  }
}

/** Map tool-name → spend row (rebuilt on every /api/inventory refresh). */
var lastSpend = {};

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
    // Fetched-spend overlay: when the sync orchestrator has a value
    // for this tool, show it instead of (or beside) the manual cost,
    // tagged with its source so the user can see at a glance which
    // numbers came from a provider.
    var sp = lastSpend[t.name];
    var monthlyHTML;
    if (sp && typeof sp.fetched_usd === "number") {
      monthlyHTML = '<span class="num">$'+sp.fetched_usd.toFixed(2)+'</span>'
        +'<span class="spend-tag fetched" title="Fetched '+esc(sp.fetched_at||"")
        +' from the provider via stm sync">fetched</span>';
    } else if (sp && sp.source === "error" && t.monthly_cost != null) {
      monthlyHTML = '<span class="num">$'+t.monthly_cost+'</span>'
        +'<span class="spend-tag error" title="Last sync failed: '+esc(sp.last_error||"")
        +'">sync failed</span>';
    } else if (t.monthly_cost != null) {
      monthlyHTML = '<span class="num">$'+t.monthly_cost+'</span>';
    } else {
      monthlyHTML = '<span style="color:var(--text-dim)">\\u2014</span>';
    }
    return '<tr>'
      +'<td>'+esc(t.display_name)+'</td>'
      +'<td style="color:var(--text-muted)">'+esc(t.plan||"\\u2014")+'</td>'
      +'<td class="num">'+monthlyHTML+'</td>'
      +'<td class="num" style="color:var(--text-muted)">'+esc(t.renews_on||"\\u2014")+'</td>'
      +'<td style="text-align:right"><button class="btn-ghost sub-edit" '
      +'style="height:28px;padding:0 12px" data-tool="'+esc(t.name)+'">Edit</button></td></tr>';
  }).join("");
}

/**
 * Spend sync (specs/spend-visibility.md). The button is the ONLY thing
 * on the page that triggers an outbound network call — the rule from
 * the spec's §2 is surfaced in the button's title attribute and in a
 * compact log under the Subscriptions table.
 */
async function syncSpend(){
  var btn=el("sync-btn"); if(!btn)return;
  var log=el("sync-log");
  btn.disabled=true; var prev=btn.textContent; btn.textContent="Syncing...";
  if(log){
    log.style.display="";
    log.innerHTML='<span class="meta">'+new Date().toISOString()+' \\u00b7 syncing every configured provider...</span>\\n';
  }
  try{
    var r=await api("/api/spend/sync",{method:"POST",body:"{}"});
    var rows=r.results||[];
    if(log){
      var lines=rows.map(function(x){
        if(x.ok){
          return '<span class="ok">[ok]</span>   '+esc(x.tool)+'   $'+(x.usd||0).toFixed(2)
            +' \\u00b7 <span class="meta">'+esc(x.at)+'</span>';
        }
        if(x.missingCredential){
          return '<span class="meta">[skip]</span> '+esc(x.tool)
            +' \\u00b7 not configured ('+esc(x.error||"")+')';
        }
        return '<span class="bad">[fail]</span> '+esc(x.tool)+' \\u00b7 '+esc(x.error||"unknown");
      });
      log.innerHTML+=lines.join("\\n")+"\\n";
      log.scrollTop=log.scrollHeight;
    }
    var ok=rows.filter(function(x){return x.ok;}).length;
    var fail=rows.filter(function(x){return !x.ok && !x.missingCredential;}).length;
    toast(ok+" synced, "+fail+" failed");
    refresh();
  }catch(e){
    if(log){
      log.innerHTML+='<span class="bad">[fail]</span> '+esc(e.message)+"\\n";
    }
    toast("Sync failed: "+e.message);
  }finally{
    btn.disabled=false; btn.textContent=prev;
  }
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

/**
 * Render the "Browse services" card: each category as a section with a
 * grid of tile buttons. The tile button carries data-idx so the click
 * handler can index into CATALOG without parsing names.
 */
function renderBrowseServices(){
  var box=el("svc-categories"); if(!box)return;
  // Bucket every catalog entry by its category, preserving CATALOG order.
  var buckets={};
  for(var i=0;i<CATALOG.length;i++){
    var s=CATALOG[i]; var c=s.category||"";
    if(!buckets[c])buckets[c]=[];
    buckets[c].push({idx:i,svc:s});
  }
  var html="";
  for(var k=0;k<CATEGORY_ORDER.length;k++){
    var cat=CATEGORY_ORDER[k];
    var rows=buckets[cat];
    if(!rows||!rows.length)continue;
    html+='<div class="sub-head">'+esc(CATEGORY_LABEL[cat]||cat)+'</div>';
    html+='<div class="svc-grid">';
    for(var r=0;r<rows.length;r++){
      var entry=rows[r];
      var title=entry.svc.tagline?' title="'+esc(entry.svc.tagline)+'"':'';
      html+='<button type="button" class="svc-tile" data-idx="'+entry.idx+'"'+title+'>'
        +'<span>'+esc(entry.svc.name)+'</span>'
        +'<span class="ext" aria-hidden="true">\\u2197</span>'
        +'</button>';
    }
    html+='</div>';
  }
  box.innerHTML=html;
}

/**
 * Add a brief emerald pulse to a card so the user's eye finds the form
 * when they switch tabs back from the provider's API-keys page.
 */
function flashCard(id){
  var c=el(id); if(!c)return;
  c.classList.remove("flash");
  // Force reflow so re-adding the class restarts the animation.
  void c.offsetWidth;
  c.classList.add("flash");
}

/**
 * Click handler for a Browse-services tile. Opens the provider's URL in
 * a new tab (no referrer, no opener), pre-selects that service in the
 * Add keys dropdown, smooth-scrolls to the form, and flashes the card so
 * the user's eye lands in the right place on tab-back.
 *
 * No tracking. Plain target="_blank" rel="noopener noreferrer" — the
 * user goes straight to the provider; subscribetome.pro never sees the
 * click.
 */
function pickService(catalogIndex){
  var svc=CATALOG[catalogIndex]; if(!svc)return;
  if(svc.url){
    window.open(svc.url, "_blank", "noopener,noreferrer");
  }
  var sel=el("svc"); if(sel){ sel.value=String(catalogIndex); }
  renderSvcFields();
  var card=el("add-keys-card");
  if(card){
    card.scrollIntoView({behavior:"smooth", block:"start"});
    flashCard("add-keys-card");
  }
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
      +'placeholder="paste it \\u2014 goes straight to your OS keychain"></div>';
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
    // Phase 3 of session-and-project-scope: include the session's cwd
    // so the server can extend an existing project's scope (or surface
    // a "create project" suggestion). cwd comes from ?from=<cwd> the
    // CLI appends; absent for users who opened the dashboard manually.
    var from=new URLSearchParams(location.search).get("from")||"";
    var body={selections:sel};
    if(from)body.cwd=from;
    var r=await api("/api/import/confirm",{method:"POST",body:JSON.stringify(body)});
    var msg="Imported "+r.imported+" key"+(r.imported===1?"":"s")
      +(r.errors.length?" \\u00b7 "+r.errors.length+" error(s): "+r.errors.join("; "):"");
    setMsg("imp-msg",msg,r.errors.length?"err":"ok");
    // Phase 3: surface the scope auto-suggest. Two shapes:
    //  - added-to-existing → toast (silent extension, just confirm).
    //  - suggest-create    → inline banner with a Create-project button.
    if(r.scopeUpdate){
      handleImportScopeUpdate(r.scopeUpdate);
    }
    refresh();
  }catch(e){setMsg("imp-msg",e.message,"err");}
  finally{btn.disabled=false;}
}

/**
 * Render the Phase-3 scope auto-suggest result. For an existing project
 * we just toast — silent extension is fine because the user clearly
 * imported keys for the project they're already in. For "suggest-create"
 * we drop a small banner under the import message with one click to
 * prefill the Add-a-project form with the cwd + imported keys.
 */
function handleImportScopeUpdate(su){
  if(!su)return;
  if(su.kind==="added-to-existing"){
    var n=su.addedToScope.length;
    toast("Scoped "+n+" key"+(n===1?"":"s")+" to "+su.projectName);
    return;
  }
  if(su.kind==="suggest-create"){
    // Stash the imported list so prefillProjectFromCwd can pick it up
    // and auto-scope after the project is created.
    window.__stmPendingScope={cwd:su.cwd,imported:su.imported};
    var box=el("imp-msg");
    var n=su.imported.length;
    var html=esc(box.textContent||"")
      +'<div style="margin-top:10px;padding:10px 12px;background:rgba(52,211,154,.05);'
      +'border:1px solid rgba(52,211,154,.25);border-radius:6px;font-size:13px;color:var(--text)">'
      +'No project matches <code>'+esc(su.cwd)+'</code>. '
      +'Create one to scope '+n+' imported key'+(n===1?'':'s')+' to it?'
      +' <button class="btn-primary" id="imp-create-proj-btn" style="margin-left:8px;padding:4px 10px;font-size:12px">'
      +'Create project</button></div>';
    box.innerHTML=html;
  }
}

/**
 * Create-project glue between the import banner and the Projects card.
 * After the project lands, scope each imported key to it in one batch.
 */
async function createProjectFromImport(){
  var pending=window.__stmPendingScope;
  if(!pending)return;
  var name=prompt("Project name?", deriveSuggestedName(pending.cwd));
  if(!name)return;
  try{
    var r=await api("/api/projects",{method:"POST",
      body:JSON.stringify({path:pending.cwd,name:name})});
    var pid=r.project.id;
    for(var i=0;i<pending.imported.length;i++){
      try{
        await api("/api/projects/"+pid+"/scope",{method:"POST",
          body:JSON.stringify(pending.imported[i])});
      }catch(_){ /* best-effort */ }
    }
    window.__stmPendingScope=null;
    toast('Project "'+name+'" created with '+pending.imported.length+' keys');
    refreshProjects();
    var card=el("projects-card");
    if(card){
      card.scrollIntoView({behavior:"smooth",block:"start"});
      flashCard("projects-card");
    }
  }catch(e){
    setMsg("imp-msg","Failed to create project: "+e.message,"err");
  }
}

function deriveSuggestedName(cwd){
  return cwd.replace(/\\/+$/,"").split("/").filter(Boolean).pop() || cwd;
}

el("add-btn").addEventListener("click",addKeys);
el("sync-btn").addEventListener("click",syncSpend);
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
el("audit-refresh-btn").addEventListener("click",function(){
  refreshAudit().catch(function(e){
    el("audit-meta").textContent="Failed: "+e.message;
  });
});
el("audit-clear-btn").addEventListener("click",clearAuditLog);
el("audit-event").addEventListener("change",function(){
  refreshAudit().catch(function(e){ el("audit-meta").textContent="Failed: "+e.message; });
});
el("audit-tool").addEventListener("keydown",function(e){
  if(e.key==="Enter"){ e.preventDefault();
    refreshAudit().catch(function(err){ el("audit-meta").textContent="Failed: "+err.message; });
  }
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
renderBrowseServices();
el("svc-categories").addEventListener("click",function(e){
  var t=e.target.closest(".svc-tile"); if(!t)return;
  var idx=Number(t.getAttribute("data-idx"));
  if(Number.isFinite(idx))pickService(idx);
});

// ---- projects card wiring ----
el("proj-add-btn").addEventListener("click",addProject);
el("proj-name").addEventListener("keydown",function(e){
  if(e.key==="Enter"){ e.preventDefault(); addProject(); }
});
el("projects-list").addEventListener("click",function(e){
  // Copy a scope placeholder pill
  var c=e.target.closest(".proj-pills code.copy");
  if(c){ copyText(c.dataset.ph); return; }
  // Edit / Done toggle
  var edBtn=e.target.closest(".proj-edit-btn");
  if(edBtn){
    var id=Number(edBtn.getAttribute("data-id"));
    editingProject=(editingProject===id)?null:id;
    renderProjects(lastProjects);
    return;
  }
  // Remove
  var rmBtn=e.target.closest(".proj-remove-btn");
  if(rmBtn){
    if(confirm("Remove this project? Scope rows are dropped (keys are kept).")){
      removeProjectRow(Number(rmBtn.getAttribute("data-id")));
    }
    return;
  }
});
el("projects-list").addEventListener("change",function(e){
  // Enforce checkbox
  var enf=e.target.closest("input.enf");
  if(enf){
    toggleEnforce(Number(enf.getAttribute("data-id")), enf.checked);
    return;
  }
  // Scope checklist toggle
  var sc=e.target.closest("input.scope-toggle");
  if(sc){
    toggleScope(
      Number(sc.getAttribute("data-id")),
      sc.getAttribute("data-tool"),
      sc.getAttribute("data-label"),
      sc.checked,
    );
    return;
  }
});

// ---- Browse services collapse/expand ----
(function(){
  var head=document.getElementById("browse-head");
  var body=document.getElementById("browse-body");
  var caret=document.getElementById("browse-caret");
  if(!head||!body||!caret) return;
  function applyState(open){
    body.style.display = open ? "block" : "none";
    caret.style.transform = open ? "rotate(90deg)" : "rotate(0deg)";
    try{ localStorage.setItem("stm-browse-open", open ? "1" : "0"); }catch(e){}
  }
  head.addEventListener("click",function(){
    applyState(body.style.display==="none");
  });
  // Restore the user's last choice; default to collapsed.
  var saved="0";
  try{ saved=localStorage.getItem("stm-browse-open")||"0"; }catch(e){}
  applyState(saved==="1");
})();

// ---- tab switching ----
function activateTab(name){
  var tabs=document.querySelectorAll(".tab");
  for(var i=0;i<tabs.length;i++){
    var on=tabs[i].getAttribute("data-tab")===name;
    tabs[i].classList.toggle("active",on);
    tabs[i].setAttribute("aria-selected",on?"true":"false");
  }
  var panels=document.querySelectorAll(".tab-panel");
  for(var j=0;j<panels.length;j++){
    panels[j].classList.toggle("active",panels[j].getAttribute("data-panel")===name);
  }
  try{ localStorage.setItem("stm-tab",name); }catch(e){}
}
document.querySelectorAll(".tab").forEach(function(btn){
  btn.addEventListener("click",function(){ activateTab(btn.getAttribute("data-tab")); });
});
// Restore last-active tab (survives a refresh).
try{
  var saved=localStorage.getItem("stm-tab");
  if(saved && document.querySelector('.tab[data-tab="'+saved+'"]')) activateTab(saved);
}catch(e){}

// ---- session signal wiring (?from=<cwd>) ----
document.addEventListener("click",function(e){
  var ed=e.target.closest("#signal-edit-btn");
  if(ed){
    editingProject=Number(ed.getAttribute("data-pid"));
    activateTab("projects");
    renderProjects(lastProjects);
    var card=el("projects-card");
    if(card){
      card.scrollIntoView({behavior:"smooth",block:"start"});
      flashCard("projects-card");
    }
    return;
  }
  var cr=e.target.closest("#signal-create-btn");
  if(cr){ activateTab("projects"); prefillProjectFromCwd(cr.getAttribute("data-cwd")); return; }
  // Phase 3: "Create project" button from the import banner.
  var ic=e.target.closest("#imp-create-proj-btn");
  if(ic){ activateTab("projects"); createProjectFromImport(); return; }
});

refresh()
  .then(function(){ return renderSessionSignal(); })
  .catch(function(e){setMsg("add-msg","Failed to load: "+e.message,"err");});
</script>
</body>
</html>`;
}
