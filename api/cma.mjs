/**
 * Saved-CMA storage (Vercel KV / Upstash Redis via REST — no npm dependency).
 * ---------------------------------------------------------------------------
 *  POST /api/cma            (team password required)  body: { all, mode, name } -> { id }
 *  GET  /api/cma?id=<id>    (PUBLIC — client share link source)               -> snapshot
 *  GET  /api/cma?list=1     (team password required)                          -> { items }
 *
 * Setup: in the Vercel project, Storage → create a KV (Upstash) store and
 * connect it. Vercel injects KV_REST_API_URL and KV_REST_API_TOKEN automatically.
 */
const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

async function kv(cmd) {
  const r = await fetch(KV_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${KV_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(cmd),
  });
  if (!r.ok) { const t = await r.text(); throw new Error("KV " + r.status + ": " + t.slice(0, 200)); }
  return (await r.json()).result;
}
const newId = () => Math.random().toString(36).slice(2, 8) + Math.random().toString(36).slice(2, 6);

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", process.env.ALLOW_ORIGIN || "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-app-key");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (!KV_URL || !KV_TOKEN) return res.status(500).json({ error: "Cloud storage not set up. Add a Vercel KV store to this project." });

  const APP_PASSWORD = (process.env.APP_PASSWORD || "").trim();
  const key = ((req.headers["x-app-key"] || req.query.key || "") + "").trim();
  const authed = !APP_PASSWORD || key === APP_PASSWORD;

  try {
    if (req.method === "POST") {
      if (!authed) return res.status(401).json({ error: "Unauthorized" });
      let body = req.body;
      if (typeof body === "string") { try { body = JSON.parse(body); } catch (_) { body = {}; } }
      if (!body || !Array.isArray(body.all) || !body.all.length) return res.status(400).json({ error: "Missing CMA data" });
      const id = newId();
      const rec = {
        all: body.all,
        mode: body.mode === "lease" ? "lease" : "sale",
        name: (body.name || (body.all[0] && body.all[0].UnparsedAddress) || "CMA").toString().slice(0, 120),
        date: new Date().toISOString(),
      };
      await kv(["SET", "cma:" + id, JSON.stringify(rec)]);
      await kv(["LPUSH", "cma:index", JSON.stringify({ id, name: rec.name, date: rec.date, mode: rec.mode })]);
      await kv(["LTRIM", "cma:index", "0", "199"]);
      return res.status(200).json({ id });
    }

    if (req.query.list) {
      if (!authed) return res.status(401).json({ error: "Unauthorized" });
      const arr = (await kv(["LRANGE", "cma:index", "0", "99"])) || [];
      const items = arr.map(s => { try { return JSON.parse(s); } catch (_) { return null; } }).filter(Boolean);
      return res.status(200).json({ items });
    }

    if (req.query.id) {
      const val = await kv(["GET", "cma:" + req.query.id]);   // PUBLIC: this is the client share link
      if (!val) return res.status(404).json({ error: "Not found" });
      res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600");
      return res.status(200).json(typeof val === "string" ? JSON.parse(val) : val);
    }

    return res.status(400).json({ error: "Provide ?id= or ?list=1, or POST to save." });
  } catch (e) {
    return res.status(502).json({ error: "Cloud error", detail: String(e.message || e) });
  }
}
