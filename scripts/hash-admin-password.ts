import { createAdminPasswordVerifier } from "../packages/operations/src/index.js";

const password = process.env.ADMIN_PASSWORD;
if (!password) throw new Error("ADMIN_PASSWORD is required");

process.stdout.write(`${await createAdminPasswordVerifier(password)}\n`);
