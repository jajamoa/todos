// One endpoint. The token in ?t= picks the list; there is nothing else to route.
//
// A token is a capability: whoever has the link has the list. That is the whole access
// model, so the only thing that matters is that generated tokens are unguessable (the
// client makes them from crypto.getRandomValues) and that a token you typed yourself is
// understood to be a room name, not a secret. The UI says so.
//
// Presence rides along on the poll the client already makes, so there is no second
// endpoint and no socket: a sorted set per list, scored by timestamp, trimmed to the
// last 30 seconds. ZCARD is the number of people here.
// Vercel's Upstash integration injects KV_REST_API_* (or UPSTASH_REDIS_REST_*); a
// hand-set pair is UPSTASH_*. Accept all three so clicking "add Upstash" on the project
// just works with no renaming.
const RURL = () => process.env.UPSTASH_URL || process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const RTOK = () => process.env.UPSTASH_TOKEN || process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const TTL = 60 * 60 * 24 * 400;        // a list nobody opens for ~13 months expires
const ALIVE = 30000;                   // you are "here" if you polled in the last 30s
const EMPTY = { todos: [], trash: [], rev: 0 };

const ok = (t) => typeof t === "string" && /^[A-Za-z0-9_-]{4,64}$/.test(t);

// Upstash takes a single command at the base URL and a batch at /pipeline. Everything
// here is a batch, so it always goes to /pipeline: posting a batch to the base URL is
// read as one command with junk arguments, and it answers 200 while storing nothing.
async function redis(cmd) {
  const url = RURL(), tok = RTOK();
  const r = await fetch(url.replace(/\/$/, "") + "/pipeline", {
    method: "POST",
    headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
    body: JSON.stringify(cmd),
  });
  return r.json();
}

const clean = (s) => String(s == null ? "" : s).slice(0, 2000);
const num = (n) => (Number.isFinite(Number(n)) ? Number(n) : 0);

function sane(list, gone) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((x) => x && typeof x.id === "string" && x.id.length <= 64)
    .slice(0, 1000)
    .map((x) => ({
      id: x.id,
      text: clean(x.text),
      done: !!x.done,
      depth: Math.max(0, Math.min(2, num(x.depth))),
      updatedAt: num(x.updatedAt),
      ...(gone ? { deletedAt: num(x.deletedAt) } : {}),
    }));
}

// Union per item, later timestamp wins. The trash doubles as the tombstone set, which is
// what stops one device's delete from being undone by another device that still has the
// row. Restoring re-stamps updatedAt past deletedAt, so it wins by the same rule.
function merge(mine, theirs) {
  const todos = new Map(), trash = new Map();
  for (const doc of [mine, theirs]) {
    for (const t of doc.todos) {
      const p = todos.get(t.id);
      if (!p || t.updatedAt > p.updatedAt) todos.set(t.id, t);
    }
    for (const t of doc.trash) {
      const p = trash.get(t.id);
      if (!p || t.deletedAt > p.deletedAt) trash.set(t.id, t);
    }
  }
  for (const [id, gone] of trash) {
    const live = todos.get(id);
    if (!live) continue;
    if (live.updatedAt > gone.deletedAt) trash.delete(id);
    else todos.delete(id);
  }
  const out = [], seen = new Set();
  for (const id of [...theirs.todos.map((t) => t.id), ...mine.todos.map((t) => t.id)]) {
    if (seen.has(id) || !todos.has(id)) continue;
    seen.add(id);
    out.push(todos.get(id));
  }
  return { todos: out, trash: [...trash.values()].sort((a, b) => b.deletedAt - a.deletedAt).slice(0, 200), rev: Date.now() };
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");   // the token is in the URL; don't leak it onward
  if (!RURL()) return res.status(503).json({ error: "no store" });

  const t = (req.query && req.query.t) || "";
  if (!ok(t)) return res.status(400).json({ error: "bad token" });
  const KEY = `todos:${t}`, WHO = `todos:who:${t}`;

  // heartbeat: mark this client here, drop anyone who went quiet, count the rest
  const me = String((req.query && req.query.me) || "").slice(0, 40) || "anon";
  const now = Date.now();
  let here = 1;
  try {
    const r = await redis([
      ["ZADD", WHO, String(now), me],
      ["ZREMRANGEBYSCORE", WHO, "-inf", String(now - ALIVE)],
      ["ZCARD", WHO],
      ["EXPIRE", WHO, "120"],
    ]);
    here = Number((r[2] && r[2].result) || 1);
  } catch (e) {}

  const read = async () => {
    try {
      const r = await redis([["GET", KEY]]);
      const doc = r[0] && r[0].result ? JSON.parse(r[0].result) : null;
      return doc && Array.isArray(doc.todos) ? { ...EMPTY, ...doc } : { ...EMPTY };
    } catch (e) {
      return { ...EMPTY };
    }
  };

  if (req.method === "GET") return res.status(200).json({ ...(await read()), here });

  if (req.method === "PUT" || req.method === "POST") {
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = null; } }
    if (!body || typeof body !== "object") return res.status(400).json({ error: "body" });
    const merged = merge(await read(), { todos: sane(body.todos), trash: sane(body.trash, true) });
    await redis([["SET", KEY, JSON.stringify(merged), "EX", String(TTL)]]);
    return res.status(200).json({ ...merged, here });
  }

  return res.status(405).json({ error: "method" });
};
