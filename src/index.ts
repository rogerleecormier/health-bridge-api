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
  timestamp: z.string().openapi({ example: "2025-08-17T12:47:05-04:00" }),
  uuid: z.string().optional().openapi({ example: "abc123-def456" }),
  startDate: z.string().optional().openapi({ example: "2025-08-17T12:47:05-04:00" }),
  endDate: z.string().optional().openapi({ example: "2025-08-17T12:47:05-04:00" }),
  sourceBundleId: z.string().optional().openapi({ example: "com.apple.health" }),
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

// Helper function to generate UUID (since crypto.randomUUID might not be available)
function generateUUID(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    const v = c == 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
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
    try {
      const authFail = requireBearer(c);
      if (authFail) return authFail;

      // Parse and validate the request body
      let body;
      try {
        const rawBody = await c.req.json();
        console.log("Raw body received:", JSON.stringify(rawBody, null, 2));
        
        // Validate with Zod
        body = WeightIn.parse(rawBody);
        console.log("Validated body:", JSON.stringify(body, null, 2));
      } catch (parseError) {
        console.error("JSON parse or validation error:", parseError);
        return c.json({ ok: false, error: "Invalid JSON or missing required fields" }, 400);
      }

      // Normalize to kg
      const kg = body.unit === "lb" ? body.weight / 2.20462 : body.weight;
      const kgFixed = Number(kg.toFixed(2));

      // Generate UUID if not provided - ensure it's never undefined or empty
      let uuid = body.uuid?.trim();
      if (!uuid) {
        try {
          uuid = crypto.randomUUID();
        } catch {
          uuid = generateUUID();
        }
      }
      
      // Use timestamp for startDate/endDate if not provided - ensure they're never undefined
      const startDate = body.startDate?.trim() || body.timestamp;
      const endDate = body.endDate?.trim() || body.timestamp;
      const sourceBundleId = body.sourceBundleId?.trim() || "manual-entry";

      // Final validation - ensure no undefined or empty values
      const values = { uuid, startDate, endDate, kgFixed, sourceBundleId };
      console.log("Final values to bind:", values);

      // Check for any undefined, null, or empty string values
      for (const [key, value] of Object.entries(values)) {
        if (value === undefined || value === null || value === "") {
          console.error(`Invalid value for ${key}:`, value);
          return c.json({ ok: false, error: `Invalid value for ${key}` }, 400);
        }
      }

      const currentTime = new Date().toISOString();

      const stmt = c.env.DB.prepare(
        `INSERT INTO weight (uuid, startDate, endDate, kg, sourceBundleId, createdAt, updatedAt)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(uuid) DO UPDATE SET kg=excluded.kg, updatedAt=excluded.updatedAt`
      ).bind(
        uuid,
        startDate,
        endDate,
        kgFixed,
        sourceBundleId,
        currentTime,
        currentTime
      );

      await stmt.run();
      console.log("Successfully inserted/updated weight record");
      return c.json({ ok: true });
      
    } catch (error) {
      console.error("Unexpected error:", error);
      return c.json({ ok: false, error: "Internal server error" }, 500);
    }
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
    try {
      const url = new URL(c.req.url);
      const limit = Math.max(1, Math.min(500, Number(url.searchParams.get("limit") ?? "30")));

      const rows = await c.env.DB.prepare(
        `SELECT startDate AS date, kg FROM weight ORDER BY startDate DESC LIMIT ?1`
      ).bind(limit).all();

      const results = (rows.results ?? []).map((row: any) => ({
        date: row.date,
        kg: row.kg,
        lb: Number((row.kg * 2.20462).toFixed(2)),
      }));

      return c.json(results as z.infer<typeof WeightRow>[]);
    } catch (error) {
      console.error("GET error:", error);
      // Always return an empty array on error to match the declared response type
      return c.json([] as z.infer<typeof WeightRow>[]);
    }
  }
);

// Mount API and docs
app.route("/api", api);
app.doc("/openapi.json", { openapi: "3.1.0", info: { title: "Health Bridge API", version: "1.0.0" } });

export default app;