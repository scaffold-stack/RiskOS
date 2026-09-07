import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { validateHistoricalRiskCases } from "../packages/risk-engine/src/validation.js";

const inputPath = process.argv[2];
const outputPath = process.argv[3];
if (!inputPath || !outputPath) throw new Error("Usage: npm run gate:risk-cases -- historical-risk-cases.json artifacts/risk-validation.json");
const input = JSON.parse(await readFile(resolve(inputPath), "utf8"));
const artifact = validateHistoricalRiskCases(input);
const destination = resolve(outputPath);
await mkdir(dirname(destination), { recursive: true });
await writeFile(destination, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ status: artifact.status, caseCount: artifact.caseCount, mismatchCount: artifact.mismatchCount, artifact: destination }));
if (artifact.status !== "passed") process.exitCode = 1;
