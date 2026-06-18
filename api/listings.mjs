/**
 * Spark API → CMA Builder proxy  (Vercel serverless function)
 * ---------------------------------------------------------------------------
 * The browser NEVER sees your Spark token. This function holds it as an
 * environment variable and forwards filtered queries to the Spark RESO Web API
 * (ARMLS via FBS), then maps the RESO records into the shape the CMA Builder
 * expects.
 *
 * Required environment variables (set in the Vercel dashboard, NOT in code):
 *   SPARK_ACCESS_TOKEN   your Spark replication access token (the "Access Token")
 *   SPARK_OAUTH_KEY      your Spark OAuth key            (optional, for ref)
 *   SPARK_BASE           optional, defaults to the replication endpoint
 *   ALLOW_ORIGIN         optional, your site origin for CORS (defaults to *)
 *
 * Endpoint:  GET /api/listings?status=Active,Closed&pmin=9000000&beds=5&...&q=...
 */

const BASE = process.env.SPARK_BASE || "https://replication.sparkapi.com/Reso/OData";

const SELECT = [
  "ListingId","ListingKey","UnparsedAddress","City","PostalCode","StateOrProvince",
  "StandardStatus","ListPrice","ClosePrice","CloseDate",
  "LivingArea","BedroomsTotal","BathroomsTotalInteger","GarageSpaces",
  "PoolPrivateYN","PoolFeatures","LotSizeAcres","LotSizeSquareFeet",
  "YearBuilt","StoriesTotal","Levels","PropertySubType","ArchitecturalStyle",
  "PropertyType","Latitude","Longitude"
].join(",");

const esc = s => String(s).replace(/'/g, "''");
const toMiles = (a, b) => {
  const R = 3958.8, toR = x => x * Math.PI / 180;
  const dLat = toR(b.lat - a.lat), dLon = toR(b.lon - a.lon);
  const s = Math.sin(dLat/2)**2 + Math.cos(toR(a.lat))*Math.cos(toR(b.lat))*Math.sin(dLon/2)**2;
  return 2 * R * Math.asin(Math.sqrt(s));
};

function pickPhoto(media) {
  if (!Array.isArray(media) || !media.length) return "";
  const photos = media
    .filter(m => m && (m.MediaURL || m.MediaUrl) && (!m.MediaCategory || /photo|image/i.test(m.MediaCategory)))
    .sort((a, b) => (a.Order ?? 99) - (b.Order ?? 99));
  return photos.length ? (photos[0].MediaURL || photos[0].MediaUrl) : "";
}

function mapRecord(r) {
  return {
    ListingId: r.ListingId || r.ListingKey,
    UnparsedAddress: r.UnparsedAddress || "",
    City: r.City || "", PostalCode: r.PostalCode || "", StateOrProvince: r.StateOrProvince || "AZ",
    StandardStatus: r.StandardStatus || "Active",
    ListPrice: r.ListPrice ?? null,
    ClosePrice: r.ClosePrice ?? null,
    CloseDate: r.CloseDate ? String(r.CloseDate).slice(0, 10) : null,
    LivingArea: r.LivingArea ?? 0,
    BedroomsTotal: r.BedroomsTotal ?? 0,
    BathroomsTotalInteger: r.BathroomsTotalInteger ?? 0,
    GarageSpaces: r.GarageSpaces ?? 0,
    PrivatePool: !!r.PoolPrivateYN,
    CommunityPool: Array.isArray(r.PoolFeatures) ? r.PoolFeatures.some(x => /community/i.test(x)) : false,
    LotSizeAcres: r.LotSizeAcres ?? (r.LotSizeSquareFeet ? +(r.LotSizeSquareFeet / 43560).toFixed(2) : 0),
    YearBuilt: r.YearBuilt ?? null,
    Stories: r.StoriesTotal ?? (Array.isArray(r.Levels) ? r.Levels.length : 1),
    DwellingType: r.PropertySubType || "Residential",
    DwellingStyle: Array.isArray(r.ArchitecturalStyle) ? (r.ArchitecturalStyle[0] || "") : (r.ArchitecturalStyle || ""),
    Latitude: r.Latitude ?? null,
    Longitude: r.Longitude ?? null,
    PropertyType: r.PropertyType || "",
    TransactionType: /lease|rent/i.test(r.PropertyType || "") ? "Lease" : "Sale",
    Photo: pickPhoto(r.Media),
  };
}

export default async function handler(req, res) {
  // CORS
  const origin = process.env.ALLOW_ORIGIN || "*";
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-app-key");
  if (req.method === "OPTIONS") return res.status(204).end();

  // team password gate (free alternative to paid deployment protection).
  // Set APP_PASSWORD in Vercel env vars; the builder sends it as the x-app-key header.
  const APP_PASSWORD = (process.env.APP_PASSWORD || "").trim();
  if (APP_PASSWORD) {
    const key = ((req.headers["x-app-key"] || req.query.key || "") + "").trim();
    if (key !== APP_PASSWORD) return res.status(401).json({ error: "Unauthorized — team password required." });
  }

  const token = process.env.SPARK_ACCESS_TOKEN;
  if (!token) return res.status(500).json({ error: "SPARK_ACCESS_TOKEN not configured on the server." });

  const q = req.query;
  const clauses = [];

  // free-text subject lookup (address or MLS #)
  if (q.q) {
    const term = esc(q.q);
    clauses.push(`(contains(UnparsedAddress,'${term}') or ListingId eq '${term}')`);
  }

  // transaction type: sale vs lease (rental comps)
  if (q.ptype === "sale") clauses.push(`PropertyType eq 'Residential'`);
  else if (q.ptype === "lease") clauses.push(`PropertyType eq 'Residential Lease'`);

  // status (csv) — UI sends "Closed" for Sold already
  if (q.status) {
    const sts = q.status.split(",").map(s => `StandardStatus eq '${esc(s.trim())}'`);
    if (sts.length) clauses.push(`(${sts.join(" or ")})`);
  }
  if (q.city) {
    const c = q.city.split(",").map(s => `City eq '${esc(s.trim())}'`);
    if (c.length) clauses.push(`(${c.join(" or ")})`);
  }
  if (q.zip) {
    const z = q.zip.split(",").map(s => `PostalCode eq '${esc(s.trim())}'`);
    if (z.length) clauses.push(`(${z.join(" or ")})`);
  }
  if (q.pmin) clauses.push(`ListPrice ge ${+q.pmin}`);
  if (q.pmax) clauses.push(`ListPrice le ${+q.pmax}`);
  if (q.beds) clauses.push(`BedroomsTotal ge ${+q.beds}`);
  if (q.baths) clauses.push(`BathroomsTotalInteger ge ${+q.baths}`);
  if (q.sqmin) clauses.push(`LivingArea ge ${+q.sqmin}`);
  if (q.sqmax) clauses.push(`LivingArea le ${+q.sqmax}`);
  if (q.ymin) clauses.push(`YearBuilt ge ${+q.ymin}`);
  if (q.ymax) clauses.push(`YearBuilt le ${+q.ymax}`);
  if (q.garage) clauses.push(`GarageSpaces ge ${+q.garage}`);
  if (q.dtype) clauses.push(`PropertySubType eq '${esc(q.dtype)}'`);
  if (q.pool === "Yes") clauses.push(`PoolPrivateYN eq true`);
  if (q.pool === "No") clauses.push(`PoolPrivateYN eq false`);
  if (q.months) {
    const d = new Date(); d.setMonth(d.getMonth() - (+q.months));
    clauses.push(`CloseDate ge ${d.toISOString().slice(0, 10)}`);
  }
  // explicit sold-date range (applies to Closed comps; current listings pass through)
  if (q.dfrom || q.dto) {
    const parts = [];
    if (q.dfrom) parts.push(`CloseDate ge ${q.dfrom}`);
    if (q.dto)   parts.push(`CloseDate le ${q.dto}`);
    clauses.push(`(StandardStatus ne 'Closed' or (${parts.join(" and ")}))`);
  }

  const top = Math.min(+q.top || 200, 200);
  const params = new URLSearchParams();
  if (clauses.length) params.set("$filter", clauses.join(" and "));
  params.set("$select", SELECT);
  params.set("$expand", "Media($select=MediaURL,Order,MediaCategory)");
  params.set("$top", String(top));
  params.set("$orderby", "ModificationTimestamp desc");

  const url = `${BASE}/Property?${params.toString()}`;

  try {
    const r = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
    if (!r.ok) {
      const text = await r.text();
      return res.status(r.status).json({ error: "Spark API error", status: r.status, detail: text.slice(0, 500) });
    }
    const data = await r.json();
    let out = (data.value || []).map(mapRecord);

    // post-fetch filters that OData can't do cleanly (collection / computed)
    if (q.style) out = out.filter(x => x.DwellingStyle === q.style);
    if (q.levels) out = out.filter(x => String(x.Stories) === String(q.levels));
    if (q.cpool === "Yes") out = out.filter(x => x.CommunityPool);
    if (q.cpool === "No") out = out.filter(x => !x.CommunityPool);
    if (q.lat && q.lon) {
      const a = { lat: +q.lat, lon: +q.lon };
      out.forEach(x => { x.DistanceMiles = x.Latitude != null ? +toMiles(a, { lat: x.Latitude, lon: x.Longitude }).toFixed(1) : null; });
      if (q.dist) out = out.filter(x => x.DistanceMiles != null && x.DistanceMiles <= +q.dist);
      out.sort((m, n) => (m.DistanceMiles ?? 999) - (n.DistanceMiles ?? 999));
    }

    res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=300");
    return res.status(200).json({ count: out.length, value: out });
  } catch (e) {
    return res.status(502).json({ error: "Proxy fetch failed", detail: String(e) });
  }
}
