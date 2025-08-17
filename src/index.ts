// src/index.ts
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { cors } from "hono/cors";

type Env = {
  Bindings: {
    DB: D1Database;
    APP_TOKEN?: string;         // optional; if set, required by POST
    ALLOWED_ORIGINS?: string;   // comma-separated list, e.g., "https://rcormier.dev,https://www.rcormier.dev"
  };
};

// ---------- Schemas ----------
const WeightIn = z.object({
  weight: z.number().openapi({ example: 372.4 }),
  unit: z.enum(["lb", "kg"]).openapi({ example: "lb" }),
  // ISO-8601 with offset (Shortcuts format). You can switch to UTC server-side if preferred.
  timestamp: z.string().openapi({ example: "2025-08-17T12:47:05-04:00" }),
}).openapi("WeightIn");

const WeightRow = z.object({
  date: z.string().openapi({ example: "2025-08-17T12:47:05-04:00" }),
  kg: z.number().openapi({ example: 169.00 }),
  lb: z.number().openapi({ example: 372.4 }),
});

// ---------- App ----------
const app = new OpenAPIHono<Env>();

// CORS (allow your sites; fallback to *)
app.use(
  "*",
  cors({
    origin: (origin, c) => {
      const list = (c.env.ALLOWED_ORIGINS ?? "").split(",").map(s => s.trim()).filter(Boolean);
      if (list.length === 0) return "*";
      return list.includes(origin ?? "") ? origin : list[0]; // be permissive to first allowed
    },
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
  })
);

// Sub-app under /api
const api = new OpenAPIHono<Env>();

// ---------- Auth helper ----------
function requireBearer(c: any) {
  const expected = c.env.APP_TOKEN;
  if (!expected) return true; // no token configured, skip auth
  const auth = c.req.header("authorization") ?? "";
  const ok = auth.startsWith("Bearer ") && auth.slice(7) === expected;
  if (!ok) {
    return c.json({ ok: false, error: "Unauthorized" }, 401);
  }
  return null;
}

// ---------- POST /api/health/weight ----------
api.openapi(
  createRoute({
    method: "post",
    path: "/health/weight",
    request: {
      body: {
        content: {
          "application/json": { schema: WeightIn },
        },
        required: true,
      },
    },
    responses: {
      200: {
        description: "Stored",
        content: { "application/json": { schema: z.object({ ok: z.literal(true) }) } },
      },
      401: { description: "Unauthorized" },
      400: { description: "Bad Request" },
    },
    tags: ["weight"],
  }),
  async (c) => {
    const authFail = requireBearer(c);
    if (authFail) return authFail;

    const body = await c.req.json<z.infer<typeof WeightIn>>().catch(() => null);
    if (!body) return c.json({ ok: false, error: "Invalid JSON" }, 400);

    // Normalize to kg
    const kg = body.unit === "lb" ? body.weight / 2.20462 : body.weight;
    const kgFixed = Number(kg.toFixed(2));

    // Write to D1
    // Ensure you created a table like:
    // CREATE TABLE IF NOT EXISTS weight (date TEXT PRIMARY KEY, kg REAL);
    // If you don't have a UNIQUE/PK on date, drop the ON CONFLICT clause.
    const stmt = c.env.DB.prepare(
      `INSERT INTO weight (uuid, startDate, endDate, kg, sourceBundleId, createdAt, updatedAt)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
       ON CONFLICT(uuid) DO UPDATE SET kg=excluded.kg, updatedAt=excluded.updatedAt`
    ).bind(
      body.uuid,
      body.startDate,
      body.endDate,
      kgFixed,
      body.sourceBundleId,
      new Date().toISOString(),
      new Date().toISOString()
    );

    await stmt.run();

    return c.json({ ok: true });
  }
);

// ---------- GET /api/health/weight?limit=30 ----------
api.openapi(
  createRoute({
    method: "get",
    path: "/health/weight",
    request: {
      query: z.object({
        limit: z.string().optional().openapi({ example: "30" }),
      }),
    },
    responses: {
      200: {
        description: "Recent rows",
        content: { "application/json": { schema: z.array(WeightRow) } },
      },
    },
    tags: ["weight"],
  }),
  async (c) => {
    const url = new URL(c.req.url);
    const limit = Math.max(1, Math.min(200, Number(url.searchParams.get("limit") ?? "30")));

    // For GET queries, select startDate as date:
    const rows = await c.env.DB.prepare(
      `SELECT startDate AS date, kg FROM weight ORDER BY startDate DESC LIMIT ?1`
    ).bind(limit).all();

    const results = (rows.results ?? []).map((row: any) => ({
      date: row.date,
      kg: row.kg,
      lb: Number((row.kg * 2.20462).toFixed(2)),
    }));

    return c.json(results as z.infer<typeof WeightRow>[]);
  }
);

// Mount API and docs
app.route("/api", api);
app.doc("/openapi.json", { openapi: "3.1.0", info: { title: "Health Bridge API", version: "1.0.0" } });

export default app;
