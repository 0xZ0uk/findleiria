import { authRoutes, savedRoutes } from "@events-tracker/auth";
import { env } from "@events-tracker/env/server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { digestRoutes } from "./digest";

const app = new Hono();

app.use(logger());
app.use(
	"/*",
	cors({
		origin: env.CORS_ORIGIN,
		allowMethods: ["GET", "POST", "OPTIONS"],
	}),
);

app.route("/", authRoutes);
app.route("/", savedRoutes);
app.route("/", digestRoutes);

app.get("/", (c) => {
	return c.text("OK");
});

export default app;
