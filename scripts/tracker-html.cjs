const fs = require("fs");
const root = require("path").resolve(__dirname, "..") + "/";
const t = JSON.parse(fs.readFileSync(root + "docs/stories/tracker.json", "utf8"));
const esc = (x) => String(x ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const st = ["done", "in_progress", "todo", "blocked"];
const col = { done: "#1a7f4b", in_progress: "#b7791f", todo: "#6b7280", blocked: "#c53030" };
const cnt = (o) => st.map((s) => o.filter((x) => x.status === s).length);
const tot = t.stories.length, done = t.stories.filter((s) => s.status === "done").length;
const grp = (k) => {
  const m = {};
  for (const s of t.stories) (m[s[k] || "(original design)"] ??= []).push(s);
  return Object.entries(m).sort();
};
const bar = (arr) => {
  const c = cnt(arr), n = arr.length || 1;
  return `<div class=bar>${c.map((v, i) => (v ? `<i style="width:${(v / n) * 100}%;background:${col[st[i]]}" title="${st[i]} ${v}"></i>` : "")).join("")}</div>`;
};
const sect = (title, k) =>
  `<h2>${title}</h2><table class=g>` +
  grp(k).map(([g, a]) => { const c = cnt(a); return `<tr><td>${esc(g)}</td><td class=b>${bar(a)}</td><td class=n>${c[0]}/${a.length} done${c[1] ? " · " + c[1] + " active" : ""}${c[3] ? " · " + c[3] + " blocked" : ""}</td></tr>`; }).join("") +
  "</table>";
const rows = t.stories.map((s) =>
  `<tr data-s="${s.status}"><td>${s.id}</td><td>${esc(s.epic)}</td><td>${esc(s.title)}${s.notes ? `<div class=note>${esc(s.notes)}</div>` : ""}</td><td>${s.priority || ""}</td><td>${s.wave || s.phase || ""}</td><td><b style="color:${col[s.status]}">${s.status.replace("_", " ")}</b></td></tr>`).join("");
const open = t.stories.filter((s) => s.status !== "done");
const html = `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>Story tracker</title><style>
:root{color-scheme:light dark;--bg:#fafaf7;--fg:#1c1c1c;--mut:#666;--line:#ddd}@media(prefers-color-scheme:dark){:root{--bg:#161616;--fg:#eee;--mut:#999;--line:#333}}
body{font:14px/1.45 system-ui,sans-serif;background:var(--bg);color:var(--fg);margin:0;padding:16px 16px 48px;max-width:1100px;margin:auto}
h1{margin:.2em 0}h2{margin:1.4em 0 .4em;font-size:15px;text-transform:uppercase;letter-spacing:.05em;color:var(--mut)}
.big{font-size:34px;font-weight:700}.sum span{margin-right:14px}.dot{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:4px}
table{border-collapse:collapse;width:100%}td{padding:5px 8px;border-bottom:1px solid var(--line);vertical-align:top}table.g td.b{width:45%}td.n{color:var(--mut);white-space:nowrap}
.bar{display:flex;height:12px;border-radius:6px;overflow:hidden;background:var(--line)}.bar i{display:block}
.note{color:var(--mut);font-size:12px;margin-top:2px}
#f{margin:10px 0}#f button{margin-right:6px;padding:4px 10px;border:1px solid var(--line);background:transparent;color:inherit;border-radius:14px;cursor:pointer}#f button.on{background:var(--fg);color:var(--bg)}
.wrap{overflow-x:auto}</style>
<h1>Story tracker</h1><div class=big>${Math.round((done / tot) * 100)}% <span style="font-size:15px;font-weight:400;color:var(--mut)">${done} of ${tot} stories done</span></div>
<div class=sum>${st.map((s, i) => `<span><i class=dot style="background:${col[s]}"></i>${s.replace("_", " ")} ${cnt(t.stories)[i]}</span>`).join("")}</div>
<p style="color:var(--mut)">Snapshot of docs/stories/tracker.json. Stories that need people (counsel, audio, vendors, decisions) stay blocked until a human act happens; notes under each title say what is built and what is not.</p>
${sect("By wave", "wave")}${sect("By priority", "priority")}${sect("By epic", "epic")}
<h2>All stories (${tot}) — ${open.length} not done</h2><div id=f>${["all", ...st].map((s) => `<button data-f="${s}" class="${s === "all" ? "on" : ""}">${s.replace("_", " ")}</button>`).join("")}</div>
<div class=wrap><table id=t>${rows}</table></div>
<script>document.querySelectorAll("#f button").forEach(b=>b.onclick=()=>{document.querySelectorAll("#f button").forEach(x=>x.classList.remove("on"));b.classList.add("on");const f=b.dataset.f;document.querySelectorAll("#t tr").forEach(r=>r.style.display=f==="all"||r.dataset.s===f?"":"none")})</script>`;
const out = root + "docs/stories/tracker.html";
fs.writeFileSync(out, html);
console.log(JSON.stringify({ tot, done, counts: cnt(t.stories) }));
