// src/index.ts
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { cors } from "hono/cors";

type Env = {
  Bindings: {
    DB: D1Database;
    APP_TOKEN: string;
    ALLOWED_ORIGINS?: string;
  };
};

const app = new OpenAPIHono<Env>();

// CORS
app.use(
  "*",
  (c, next) =>
    cors({
      origin: (origin) => {
        const allow = (c.env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim());
        if (!origin) return allow[0] || "*";
        return allow.includes(origin) ? origin : allow[0] || "*";
      },
      allowHeaders: ["authorization", "content-type"],
      allowMethods: ["GET", "POST", "OPTIONS"],
    })(c, next)
);

// Schemas
const BodyMassPoint = z.object({
  uuid: z.string().uuid(),
  startDate: z.string().datetime(),
  endDate: z.string().datetime(),
  unit: z.enum(["kg", "lb"]),
  value: z.number().positive(),
  sourceBundleId: z.string(),
});
const ImportPayload = z.object({ bodyMass: z.array(BodyMassPoint).default([]) });
const WeightRow = z.object({ date: z.string().datetime(), kg: z.number() });

// Auth
function checkBearer(c: any) {
  const h = c.req.header("authorization") || "";
  const tok = h.startsWith("Bearer ") ? h.slice(7) : "";
  return tok && tok === c.env.APP_TOKEN;
}

// Sub-app mounted under /api
const api = new OpenAPIHono<Env>();

api.openapi(
  createRoute({
    method: "post",
    path: "/health/import",
    request: {
      body: { content: { "application/json": { schema: ImportPayload } } },
      headers: z.object({ authorization: z.string() }),
    },
    responses: {
      200: { description: "OK", content: { "application/json": { schema: z.object({ ok: z.boolean(), upserts: z.number() }) } } },
      400: { description: "Invalid payload" },
      401: { description: "Unauthorized" },
    },
    tags: ["Health"],
    summary: "Import body weight samples",
  }),
  async (c) => {
    if (!checkBearer(c)) return c.json({ error: "Unauthorized" }, 401);
    const payload = ImportPayload.parse(await c.req.json());
    if (!payload.bodyMass.length) return c.json({ ok: true, upserts: 0 });

    const stmt = `
      INSERT INTO weight (uuid, startDate, endDate, kg, sourceBundleId, createdAt, updatedAt)
      VALUES (?1, ?2, ?3, ?4, ?5, datetime('now'), datetime('now'))
      ON CONFLICT(uuid) DO UPDATE SET
        startDate=excluded.startDate,
        endDate=excluded.endDate,
        kg=excluded.kg,
        sourceBundleId=excluded.sourceBundleId,
        updatedAt=datetime('now');
    `;
    const batch = payload.bodyMass.map((s) => {
      const kg = s.unit === "lb" ? s.value / 2.20462 : s.value;
      return c.env.DB.prepare(stmt).bind(s.uuid, s.startDate, s.endDate, kg, s.sourceBundleId);
    });
    await c.env.DB.batch(batch);
    return c.json({ ok: true, upserts: payload.bodyMass.length });
  }
);

api.openapi(
  createRoute({
    method: "get",
    path: "/health/weight",
    responses: {
      200: { description: "List", content: { "application/json": { schema: z.array(WeightRow) } } },
    },
    tags: ["Health"],
    summary: "List weight samples",
  }),
  async (c) => {
    const rs = await c.env.DB.prepare(
      "SELECT startDate as date, kg FROM weight ORDER BY startDate ASC;"
    ).all();
    return c.json((rs.results || []) as z.infer<typeof WeightRow>[]);
  }
);

// mount at /api and keep docs
app.route("/api", api);
app.doc("/openapi.json", { openapi: "3.1.0", info: { title: "Health Bridge API", version: "1.0.0" } });

export default app;
