/**
 * People Pulse Lite (/lite): a separately built, framework-free page for slow phones (DESIGN_2028 3.9, S-75).
 * No React, no map, no third-party requests. System fonts; the self-hosted Noto Telugu subset is fetched only when
 * Telugu is chosen. Reports made offline are queued on the device and sent when the connection returns.
 * Budget (HTML+JS+CSS, gzip): 150 KB, enforced by tests/load/lite.size.test.ts.
 */
import "./lite.css";

type Lang = "en" | "te";
const API = "/api/v1/civic";
const LS = { lang: "lite-lang", queue: "lite-queue" };
const TOKEN_KEY = "civic-token"; // shared with the full app, sessionStorage only

const T = {
  en: {
    title: "Report a local problem", lang: "తెలుగు", signin: "Sign in", phone: "Mobile number (10 digits)", pin: "PIN (4 to 6 digits)",
    signinBtn: "Sign in", newAcc: "New here? Sign up with a code", haveAcc: "Already have an account? Sign in", sendCode: "Send code", code: "6-digit code", create: "Create account",
    consent: "I have read the notice and I agree", signedIn: "You are signed in", signout: "Sign out", category: "Type of problem",
    village: "Your village (type at least 2 letters)", desc: "What is the problem?", photo: "Photo (optional)", submit: "Send report",
    sent: "Report sent. Reference: ", queued: "No connection. Saved on this phone, it will be sent when you are online.", pending: "Waiting to send: ",
    needSignin: "Please sign in first.", needFields: "Choose a type of problem and a village, and describe the problem.", noMatch: "No village found",
    selected: "Selected: ", wrongLogin: "Wrong phone or PIN.", tooMany: "Too many tries. Please wait a little and try again.",
    smsBusy: "Codes are busy right now. Please try again later.", failed: "Something went wrong. Please try again.", badPhone: "Enter a 10-digit mobile number.",
    weakPin: "Choose a PIN that is not easy to guess.", codeBad: "The code is wrong or has expired.", phoneUsed: "This number already has an account. Please sign in.",
    offline: "Offline", scam: "We never ask for your code or PIN by phone.", photoNoQueue: " (photo is not saved offline)", loading: "Loading",
    codeSent: "Code sent.", devCode: "Test code: ", noticeLoad: "Loading the notice", photoBad: "This photo could not be used. Choose a JPEG or PNG photo.",
  },
  te: {
    title: "స్థానిక సమస్యను నమోదు చేయండి", lang: "English", signin: "సైన్ ఇన్", phone: "మొబైల్ నంబర్ (10 అంకెలు)", pin: "పిన్ (4 నుండి 6 అంకెలు)",
    signinBtn: "సైన్ ఇన్", newAcc: "కొత్తవారా? కోడ్‌తో నమోదు చేసుకోండి", haveAcc: "ఖాతా ఉందా? సైన్ ఇన్ చేయండి", sendCode: "కోడ్ పంపండి", code: "6 అంకెల కోడ్", create: "ఖాతా సృష్టించండి",
    consent: "నేను నోటీసు చదివాను, అంగీకరిస్తున్నాను", signedIn: "మీరు సైన్ ఇన్ అయ్యారు", signout: "సైన్ అవుట్", category: "సమస్య రకం",
    village: "మీ గ్రామం (కనీసం 2 అక్షరాలు టైప్ చేయండి)", desc: "సమస్య ఏమిటి?", photo: "ఫోటో (ఐచ్ఛికం)", submit: "నివేదిక పంపండి",
    sent: "నివేదిక పంపబడింది. రెఫరెన్స్: ", queued: "కనెక్షన్ లేదు. ఈ ఫోన్‌లో భద్రపరిచాము, ఆన్‌లైన్‌లోకి వచ్చాక పంపుతాము.", pending: "పంపవలసినవి: ",
    needSignin: "ముందుగా సైన్ ఇన్ చేయండి.", needFields: "సమస్య రకం, గ్రామం ఎంచుకొని, సమస్యను వివరించండి.", noMatch: "గ్రామం కనబడలేదు",
    selected: "ఎంచుకున్నది: ", wrongLogin: "ఫోన్ లేదా పిన్ తప్పు.", tooMany: "చాలా ప్రయత్నాలు జరిగాయి. కొంతసేపు ఆగి మళ్ళీ ప్రయత్నించండి.",
    smsBusy: "ఇప్పుడు కోడ్‌లు బిజీగా ఉన్నాయి. తర్వాత ప్రయత్నించండి.", failed: "ఏదో తప్పు జరిగింది. మళ్ళీ ప్రయత్నించండి.", badPhone: "10 అంకెల మొబైల్ నంబర్ ఇవ్వండి.",
    weakPin: "ఊహించడం కష్టమైన పిన్ ఎంచుకోండి.", codeBad: "కోడ్ తప్పు లేదా గడువు ముగిసింది.", phoneUsed: "ఈ నంబర్‌కు ఖాతా ఉంది. సైన్ ఇన్ చేయండి.",
    offline: "ఆఫ్‌లైన్", scam: "మేము ఫోన్‌లో మీ కోడ్ లేదా పిన్ ఎప్పుడూ అడగము.", photoNoQueue: " (ఫోటో ఆఫ్‌లైన్‌లో భద్రపరచబడదు)", loading: "లోడ్ అవుతోంది",
    codeSent: "కోడ్ పంపబడింది.", devCode: "పరీక్ష కోడ్: ", noticeLoad: "నోటీసు లోడ్ అవుతోంది", photoBad: "ఈ ఫోటో వాడలేము. JPEG లేదా PNG ఫోటో ఎంచుకోండి.",
  },
} as const;
type Key = keyof typeof T.en;

/** Glyphs are plain text characters (no emoji) so they render on any phone and cost no image bytes. */
const CATS: { id: string; en: string; te: string; g: string }[] = [
  { id: "water", en: "Drinking water", te: "తాగునీరు", g: "≈" },
  { id: "roads", en: "Roads", te: "రోడ్లు", g: "≡" },
  { id: "electricity", en: "Electricity", te: "విద్యుత్", g: "ϟ" },
  { id: "health", en: "Health", te: "ఆరోగ్యం", g: "✚" },
  { id: "education", en: "School", te: "పాఠశాల", g: "✎" },
  { id: "agriculture", en: "Farming", te: "వ్యవసాయం", g: "♣" },
  { id: "welfare", en: "Welfare", te: "సంక్షేమం", g: "♡" },
  { id: "law_order", en: "Law and order", te: "శాంతిభద్రతలు", g: "⚑" },
  { id: "other", en: "Other", te: "ఇతరం", g: "…" },
];

const safe = {
  get(k: string): string | null { try { return localStorage.getItem(k); } catch { return null; } },
  set(k: string, v: string) { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
  tok(): string | null { try { return sessionStorage.getItem(TOKEN_KEY); } catch { return null; } },
  setTok(t: string | null) { try { if (t) sessionStorage.setItem(TOKEN_KEY, t); else sessionStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ } },
};

interface Queued { category: string; village_lgd: string; text: string; te: boolean }
const readQueue = (): Queued[] => { try { const q = JSON.parse(safe.get(LS.queue) || "[]"); return Array.isArray(q) ? q : []; } catch { return []; } };
const writeQueue = (q: Queued[]) => safe.set(LS.queue, JSON.stringify(q.slice(0, 20)));

let lang: Lang = (safe.get(LS.lang) as Lang) === "te" ? "te" : "en";
if (!safe.get(LS.lang) && /^te/i.test(navigator.language || "")) lang = "te";
const t = (k: Key): string => T[lang][k];

/** Tiny hyperscript: children are text nodes, so nothing user-supplied is ever parsed as HTML. */
function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string | boolean | ((e: Event) => void)> = {}, ...kids: (Node | string | null)[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (typeof v === "boolean") { if (v) el.setAttribute(k, ""); }
    else if (k === "testid") el.setAttribute("data-testid", v);
    else el.setAttribute(k, v);
  }
  for (const c of kids) if (c !== null) el.append(c);
  return el;
}

async function api<T>(path: string, init: { method?: string; body?: unknown; raw?: Blob; auth?: boolean } = {}): Promise<{ status: number; data: T & Record<string, unknown> }> {
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers["content-type"] = "application/json";
  if (init.raw) headers["content-type"] = init.raw.type || "image/jpeg";
  const tok = safe.tok();
  if (tok && init.auth !== false) headers.authorization = `Bearer ${tok}`;
  const res = await fetch(API + path, { method: init.method ?? "GET", headers, body: init.raw ?? (init.body !== undefined ? JSON.stringify(init.body) : undefined) });
  let data: unknown = {};
  try { data = await res.json(); } catch { /* empty or non-JSON */ }
  return { status: res.status, data: (data ?? {}) as T & Record<string, unknown> };
}
const errText = (status: number, d: Record<string, unknown>): string => {
  if (status === 429 || d.limited) return t("tooMany");
  if (status === 503 || d.degraded) return t("smsBusy");
  if (status === 401) return t("wrongLogin");
  if (d.code === "weak_pin") return t("weakPin");
  if (d.code === "number_registered") return t("phoneUsed");
  return t("failed");
};
const tenDigits = (p: string) => p.replace(/\D/g, "").replace(/^91(?=\d{10}$)/, "");
const e164 = (p: string) => "+91" + tenDigits(p);

// ---------------------------------------------------------------- state
const st = {
  mode: "pin" as "pin" | "signup",
  step: 1 as 1 | 2,
  cat: "", village: null as { lgd: string; label: string } | null, hits: null as { lgd: string; label: string }[] | null,
  msg: "" as string, err: false, notice: "" as string, devOtp: "", busy: false,
};
const root = document.getElementById("lite-root")!;
let fontRequested = false;

function ensureFont() {
  if (lang !== "te" || fontRequested || typeof FontFace === "undefined") return;
  fontRequested = true;
  const f = new FontFace("Noto Telugu Lite", "url(/fonts/NotoSansTelugu-subset.woff2) format('woff2')", { display: "swap" });
  f.load().then((ff) => document.fonts.add(ff)).catch(() => { fontRequested = false; });
}

function say(msg: string, err = false) { st.msg = msg; st.err = err; render(); }

// ---------------------------------------------------------------- actions
async function doLogin(phone: string, pin: string) {
  if (!/^\d{10}$/.test(tenDigits(phone))) return say(t("badPhone"), true);
  const r = await api<{ token?: string }>("/identity/login", { method: "POST", body: { phone: e164(phone), pin }, auth: false });
  if (r.status === 200 && typeof r.data.token === "string") { safe.setTok(r.data.token); st.msg = ""; render(); void flush(); return; }
  say(errText(r.status, r.data), true);
}
async function loadNotice() {
  if (st.notice) return;
  try {
    const r = await api<{ text?: { en?: string; te?: string } }>("/households/notices/signup", { auth: false });
    st.notice = (r.data.text?.[lang] as string) || (r.data.text?.en as string) || "";
  } catch { /* shown as empty */ }
  render();
}
async function sendCode(phone: string) {
  if (!/^\d{10}$/.test(tenDigits(phone))) return say(t("badPhone"), true);
  const r = await api<{ dev_otp?: string }>("/identity/signup/request", { method: "POST", body: { phone: e164(phone) }, auth: false });
  if (r.status === 200) { st.step = 2; st.devOtp = typeof r.data.dev_otp === "string" ? r.data.dev_otp : ""; st.msg = t("codeSent"); st.err = false; return render(); }
  say(errText(r.status, r.data), true);
}
async function doSignup(phone: string, otp: string, pin: string) {
  const r = await api<{ token?: string }>("/identity/signup/verify", { method: "POST", body: { phone: e164(phone), otp, pin, consent_version: "v1" }, auth: false });
  if (r.status === 201 && typeof r.data.token === "string") { safe.setTok(r.data.token); st.msg = ""; st.step = 1; render(); void flush(); return; }
  say(r.status === 400 && !r.data.code ? t("codeBad") : errText(r.status, r.data), true);
}

let searchTimer: ReturnType<typeof setTimeout> | undefined;
let searchSeq = 0;
function onVillageInput(q: string) {
  clearTimeout(searchTimer);
  st.village = null;
  if (q.trim().length < 2) { st.hits = null; renderHits(); return; }
  searchTimer = setTimeout(async () => {
    const seq = ++searchSeq;
    try {
      const r = await api<{ results?: { village: { lgd: string; name_en: string; name_te: string | null }; hamlet: { name_en: string; name_te: string | null } | null; path: string[] }[] }>(`/geo/search?q=${encodeURIComponent(q.trim())}`, { auth: false });
      if (seq !== searchSeq) return;
      const seen = new Set<string>();
      st.hits = (r.data.results ?? []).filter((x) => !seen.has(x.village.lgd) && seen.add(x.village.lgd)).slice(0, 8).map((x) => ({
        lgd: x.village.lgd, label: `${lang === "te" && x.village.name_te ? x.village.name_te : x.village.name_en}${x.path?.[2] ? ", " + x.path[2] : ""}`,
      }));
    } catch { st.hits = []; }
    renderHits();
  }, 300);
}
function renderHits() {
  const box = document.getElementById("lite-hits");
  if (!box) return;
  box.replaceChildren();
  if (st.village) { box.append(h("p", { testid: "lite-village-selected", class: "mut" }, t("selected") + st.village.label)); return; }
  if (st.hits === null) return;
  if (!st.hits.length) { box.append(h("p", { class: "mut" }, t("noMatch"))); return; }
  box.append(h("ul", { class: "hits" }, ...st.hits.map((v) => h("li", {}, h("button", { type: "button", testid: `lite-village-${v.lgd}`, onclick: () => { st.village = v; renderHits(); } }, v.label)))));
}

/** Re-encode to JPEG (drops EXIF/GPS, shrinks for 2G). Falls back to the original JPEG/PNG when the browser cannot decode. */
async function prepPhoto(f: File): Promise<Blob | null> {
  try {
    const bmp = await createImageBitmap(f, { imageOrientation: "from-image" });
    const s = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
    const c = document.createElement("canvas"); c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
    const x = c.getContext("2d")!; x.fillStyle = "#fff"; x.fillRect(0, 0, c.width, c.height); x.drawImage(bmp, 0, 0, c.width, c.height);
    for (const q of [0.8, 0.65, 0.5]) {
      const b = await new Promise<Blob | null>((ok) => c.toBlob(ok, "image/jpeg", q));
      if (b && b.size <= 1_900_000) return b;
    }
    return null;
  } catch {
    return /^image\/(jpeg|png)$/.test(f.type) && f.size <= 1_900_000 ? f : null;
  }
}

const isNet = (e: unknown) => e instanceof TypeError || !navigator.onLine;

async function sendReport(q: Queued, photo?: Blob | null): Promise<{ id?: string }> {
  let photo_ref: string | undefined;
  if (photo) {
    const m = await api<{ ref?: string }>("/issues/media", { method: "POST", raw: photo });
    if (m.status !== 201 || typeof m.data.ref !== "string") throw Object.assign(new Error("media"), { status: m.status, data: m.data });
    photo_ref = m.data.ref;
  }
  const r = await api<{ id?: string }>("/issues", { method: "POST", body: { category: q.category, village_lgd: q.village_lgd, [q.te ? "description_te" : "description_en"]: q.text, photo_ref } });
  if (r.status !== 200 && r.status !== 201) throw Object.assign(new Error("report"), { status: r.status, data: r.data });
  return { id: r.data.id };
}

async function submit(form: HTMLFormElement) {
  const text = (form.elements.namedItem("desc") as HTMLTextAreaElement).value.trim();
  const file = (form.elements.namedItem("photo") as HTMLInputElement).files?.[0];
  if (!safe.tok()) return say(t("needSignin"), true);
  if (!st.cat || !st.village || !text) return say(t("needFields"), true);
  const q: Queued = { category: st.cat, village_lgd: st.village.lgd, text, te: /[ఀ-౿]/.test(text) };
  st.busy = true;
  let photo: Blob | null = null;
  if (file) { photo = await prepPhoto(file); if (!photo) { st.busy = false; return say(t("photoBad"), true); } }
  try {
    const out = await sendReport(q, photo);
    st.busy = false; st.cat = ""; st.village = null; st.hits = null; form.reset();
    say(t("sent") + (out.id ?? ""));
  } catch (e) {
    st.busy = false;
    const { status, data } = e as { status?: number; data?: Record<string, unknown> };
    if (isNet(e) || status === 429 || status === 503 || status === 502 || status === 504) {
      writeQueue([...readQueue(), q]);
      st.cat = ""; st.village = null; st.hits = null; form.reset();
      say(t("queued") + (photo ? t("photoNoQueue") : ""));
    } else if (status === 401) { safe.setTok(null); say(t("needSignin"), true); }
    else say(errText(status ?? 0, data ?? {}), true);
  }
}

let flushing = false;
/** Send queued reports in order; stop at the first network failure. */
async function flush() {
  if (flushing || !safe.tok() || !navigator.onLine) return;
  flushing = true;
  try {
    let q = readQueue();
    while (q.length) {
      try { await sendReport(q[0]); q = q.slice(1); writeQueue(q); }
      catch (e) {
        const status = (e as { status?: number }).status;
        if (isNet(e) || status === 401 || status === 429 || (status ?? 0) >= 500) break;
        q = q.slice(1); writeQueue(q); // rejected for good (validation): drop it so it cannot block the rest
      }
    }
  } finally { flushing = false; render(); }
}

// ---------------------------------------------------------------- render
function render() {
  ensureFont();
  document.documentElement.lang = lang;
  const signed = !!safe.tok();
  const queued = readQueue().length;
  const main = h("main", {},
    !navigator.onLine ? h("div", { class: "off", role: "status", testid: "lite-offline" }, t("offline")) : null,
    h("header", {},
      h("h1", {}, t("title")),
      h("button", { type: "button", testid: "lite-lang", lang: lang === "en" ? "te" : "en", onclick: () => { lang = lang === "en" ? "te" : "en"; safe.set(LS.lang, lang); st.notice = ""; render(); if (st.mode === "signup") void loadNotice(); } }, t("lang")),
    ),
    queued ? h("p", { class: "msg", role: "status", testid: "lite-queue" }, t("pending") + queued) : null,
    st.msg ? h("p", { class: "msg" + (st.err ? " err" : ""), role: st.err ? "alert" : "status", testid: "lite-status" }, st.msg) : null,
    signed ? signedBox() : authBox(),
    reportForm(),
    h("p", { class: "mut" }, t("scam")),
  );
  const keep = { active: document.activeElement?.id };
  // Keep what the person typed (and the chosen photo): move the live report inputs into the new tree, copy the sign-in fields.
  for (const id of ["lite-vq", "lite-desc", "lite-photo"]) {
    const old = document.getElementById(id), cur = main.querySelector("#" + id);
    if (old && cur) cur.replaceWith(old);
  }
  for (const id of ["phone", "otp", "pin"]) {
    const old = document.getElementById(id) as HTMLInputElement | null, cur = main.querySelector("#" + id) as HTMLInputElement | null;
    if (old && cur) cur.value = old.value;
  }
  root.replaceChildren(main);
  if (keep.active) document.getElementById(keep.active)?.focus();
  renderHits();
}

function signedBox(): Node {
  return h("div", { class: "row", testid: "lite-signed-in" }, h("span", {}, t("signedIn")),
    h("button", { type: "button", testid: "lite-signout", onclick: () => { safe.setTok(null); st.msg = ""; render(); } }, t("signout")));
}

function field(id: string, label: string, type: string, extra: Record<string, string> = {}): Node[] {
  return [h("label", { for: id }, label), h("input", { id, name: id, type, testid: "lite-" + id, ...extra })];
}

function authBox(): Node {
  const val = (f: HTMLFormElement, n: string) => (f.elements.namedItem(n) as HTMLInputElement).value;
  if (st.mode === "pin") {
    return h("section", { "aria-labelledby": "lite-h-signin" },
      h("h2", { id: "lite-h-signin" }, t("signin")),
      h("form", { onsubmit: (e) => { e.preventDefault(); const f = e.target as HTMLFormElement; void doLogin(val(f, "phone"), val(f, "pin")); } },
        ...field("phone", t("phone"), "tel", { inputmode: "numeric", autocomplete: "tel-national" }),
        ...field("pin", t("pin"), "password", { inputmode: "numeric", autocomplete: "current-password", maxlength: "6" }),
        h("p", {}, h("button", { type: "submit", class: "primary", testid: "lite-signin-submit" }, t("signinBtn"))),
      ),
      h("button", { type: "button", testid: "lite-to-signup", onclick: () => { st.mode = "signup"; st.step = 1; st.msg = ""; render(); void loadNotice(); } }, t("newAcc")),
    );
  }
  const back = h("button", { type: "button", testid: "lite-to-signin", onclick: () => { st.mode = "pin"; st.msg = ""; render(); } }, t("haveAcc"));
  if (st.step === 1) {
    return h("section", { "aria-labelledby": "lite-h-signin" },
      h("h2", { id: "lite-h-signin" }, t("newAcc")),
      h("div", { class: "consent", testid: "lite-notice", tabindex: "0" }, st.notice || t("noticeLoad")),
      h("form", { onsubmit: (e) => { e.preventDefault(); const f = e.target as HTMLFormElement; void sendCode(val(f, "phone")); } },
        h("label", {}, h("input", { type: "checkbox", name: "agree", required: true, testid: "lite-consent" }), " " + t("consent")),
        ...field("phone", t("phone"), "tel", { inputmode: "numeric", autocomplete: "tel-national" }),
        h("p", {}, h("button", { type: "submit", class: "primary", testid: "lite-send-code" }, t("sendCode"))),
      ), back);
  }
  return h("section", { "aria-labelledby": "lite-h-signin" },
    h("h2", { id: "lite-h-signin" }, t("newAcc")),
    st.devOtp ? h("p", { class: "mut", testid: "lite-dev-otp" }, t("devCode") + st.devOtp) : null,
    h("form", { onsubmit: (e) => { e.preventDefault(); const f = e.target as HTMLFormElement; void doSignup(val(f, "phone"), val(f, "otp"), val(f, "pin")); } },
      ...field("phone", t("phone"), "tel", { inputmode: "numeric", autocomplete: "tel-national" }),
      ...field("otp", t("code"), "text", { inputmode: "numeric", autocomplete: "one-time-code", maxlength: "6" }),
      ...field("pin", t("pin"), "password", { inputmode: "numeric", autocomplete: "new-password", maxlength: "6" }),
      h("p", {}, h("button", { type: "submit", class: "primary", testid: "lite-signup-submit" }, t("create"))),
    ), back);
}

function reportForm(): Node {
  return h("form", { testid: "lite-form", "aria-labelledby": "lite-h-report", onsubmit: (e) => { e.preventDefault(); if (!st.busy) void submit(e.target as HTMLFormElement); } },
    h("h2", { id: "lite-h-report" }, t("category")),
    h("fieldset", { class: "cats" }, ...CATS.map((c) => h("label", { class: "cat" },
      h("input", { type: "radio", name: "cat", value: c.id, testid: "lite-cat-" + c.id, ...(st.cat === c.id ? { checked: true } : {}), onchange: () => { st.cat = c.id; } }),
      h("span", {}, h("b", { "aria-hidden": "true" }, c.g), c[lang])))),
    h("label", { for: "lite-vq" }, t("village")),
    h("input", { id: "lite-vq", type: "search", autocomplete: "off", testid: "lite-village-q", oninput: (e) => onVillageInput((e.target as HTMLInputElement).value) }),
    h("div", { id: "lite-hits", "aria-live": "polite" }),
    h("label", { for: "lite-desc" }, t("desc")),
    h("textarea", { id: "lite-desc", name: "desc", rows: "4", maxlength: "1000", testid: "lite-desc" }),
    h("label", { for: "lite-photo" }, t("photo")),
    h("input", { id: "lite-photo", name: "photo", type: "file", accept: "image/*", testid: "lite-photo" }),
    h("p", {}, h("button", { type: "submit", class: "primary", testid: "lite-submit" }, t("submit"))),
  );
}

// ---------------------------------------------------------------- boot
render();
window.addEventListener("online", () => { render(); void flush(); });
window.addEventListener("offline", render);
void flush();
document.documentElement.setAttribute("data-lite-ready", "1");

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/civic-sw.js").then(() => navigator.serviceWorker.ready).then((reg) => {
    // First visit: the page's own assets were fetched before the worker took control, so hand it the list to cache for offline use.
    const urls = [location.pathname, ...performance.getEntriesByType("resource").map((r) => r.name)].filter((u) => { try { return new URL(u, location.href).origin === location.origin; } catch { return false; } });
    reg.active?.postMessage({ type: "precache", urls });
  }).catch(() => { /* offline shell is optional */ });
}
