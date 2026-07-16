import { createServer } from "node:http";
import { cp, mkdir, readFile, rm, stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { build } from "esbuild";

const root = resolve(import.meta.dirname, "..");
const production = process.argv.includes("--production");
const publicDir = resolve(root, production ? "dist" : ".dev");
const port = Number(process.env.PORT || 4173);
const testnetConfig = JSON.parse(await readFile(resolve(root, "config", "monad-testnet.json"), "utf8"));
let localDeployment = { address: testnetConfig.escrowAddress, txHash: null };

if (!production) {
  await rm(publicDir, { recursive: true, force: true });
  await mkdir(publicDir, { recursive: true });
  await cp(resolve(root, "public"), publicDir, { recursive: true });
  await build({
    entryPoints: [resolve(root, "public", "app.js")],
    outfile: resolve(publicDir, "app.js"),
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    logLevel: "warning",
  });
}

const contests = [
  {
    id: "monad-glow",
    title: "Monad summer launch visual",
    type: "Photo / Visual",
    brief: "Create a bold editorial key visual for a new onchain savings product. It should feel fast, trustworthy, and unmistakably Monad.",
    budget: 12,
    deadline: "2d 14h",
    validCount: 7,
    cap: 10,
    submissions: 9,
    status: "OPEN",
    requester: "0x7A2c…91F0",
    must: ["Purple kinetic energy", "Readable at mobile size", "No token-price claims"],
    avoid: ["Generic robot imagery", "Exchange UI"],
  },
  {
    id: "cafe-page",
    title: "One-page site for a night café",
    type: "Static Page",
    brief: "A responsive, atmospheric page that turns late-night visitors into table reservations.",
    budget: 28,
    deadline: "4d 03h",
    validCount: 3,
    cap: 5,
    submissions: 4,
    status: "OPEN",
    requester: "0x19bE…A240",
    must: ["Mobile-first", "Menu section", "Reservation CTA"],
    avoid: ["Stock coffee photos", "Heavy animation"],
  },
  {
    id: "invoice-tool",
    title: "Freelance rate calculator",
    type: "Micro Tool",
    brief: "A tiny browser tool that converts a target monthly income into a defensible hourly and project rate.",
    budget: 42,
    deadline: "6d 19h",
    validCount: 1,
    cap: 5,
    submissions: 1,
    status: "OPEN",
    requester: "0x3CD9…782B",
    must: ["Runs without backend", "Clear assumptions", "Export summary"],
    avoid: ["Sign-up wall", "Tracking scripts"],
  },
];

const json = (res, statusCode, body) => {
  res.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
};

const mime = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);
  if (url.pathname === "/api/health") return json(res, 200, { ok: true, chainId: 10143, token: "AUSD", walletWrites: "demo-only", chainVerificationConfigured: Boolean(localDeployment.address), deploymentReady: true, ausdAddress: testnetConfig.ausdAddress, ausdFaucetAddress: testnetConfig.ausdFaucetAddress, escrowAddress: localDeployment.address, platformRecipient: testnetConfig.platformRecipient, eligibilityOracle: testnetConfig.eligibilityOracle });
  if (url.pathname === "/api/dev/deploy-artifact" && req.method === "GET") {
    try {
      const artifact = JSON.parse(await readFile(resolve(root,"artifacts","contracts","src","KotaeEscrow.sol","KotaeEscrow.json"),"utf8"));
      return json(res,200,{abi:artifact.abi,bytecode:artifact.bytecode});
    } catch { return json(res,503,{error:"Compile the escrow before deployment"}); }
  }
  if (url.pathname === "/api/dev/deployment" && req.method === "GET") return json(res,200,localDeployment);
  if (url.pathname === "/api/dev/deployment" && req.method === "POST") {
    let raw=""; for await (const chunk of req) raw+=chunk;
    const body=JSON.parse(raw||"{}");
    if(!/^0x[0-9a-fA-F]{40}$/.test(body.address||"") || !/^0x[0-9a-fA-F]{64}$/.test(body.txHash||"")) return json(res,422,{error:"Invalid deployment receipt"});
    localDeployment={address:body.address,txHash:body.txHash}; return json(res,201,localDeployment);
  }
  if (url.pathname === "/api/contests" && req.method === "GET") return json(res, 200, { contests });
  if (url.pathname === "/api/contests" && req.method === "POST") {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw || "{}");
    const contest = {
      id: `contest-${Date.now()}`,
      title: body.title || "Untitled contest",
      type: body.type || "Photo / Visual",
      brief: body.brief || "",
      budget: Number(body.budget || 0),
      deadline: body.deadline || "7d 00h",
      validCount: 0,
      cap: Number(body.cap || 5),
      submissions: 0,
      status: "OPEN",
      requester: "0x8F21…C90A",
      must: body.must || [],
      avoid: body.avoid || [],
    };
    contests.unshift(contest);
    return json(res, 201, { contest, txHash: `0x${Date.now().toString(16).padStart(64, "0")}` });
  }

  const requested = url.pathname === "/" ? "/index.html" : url.pathname;
  const safePath = normalize(requested).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(publicDir, safePath);
  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403); res.end("Forbidden"); return;
  }
  try {
    const info = await stat(filePath);
    const finalPath = info.isDirectory() ? join(filePath, "index.html") : filePath;
    const body = await readFile(finalPath);
    res.writeHead(200, { "content-type": mime[extname(finalPath)] || "application/octet-stream" });
    res.end(body);
  } catch {
    try {
      const body = await readFile(join(publicDir, "index.html"));
      res.writeHead(200, { "content-type": mime[".html"] });
      res.end(body);
    } catch {
      res.writeHead(404); res.end("Not found");
    }
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Local: http://127.0.0.1:${port}`);
});
