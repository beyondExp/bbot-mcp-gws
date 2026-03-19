import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO = "googleworkspace/cli";

function log(...args) {
  // Postinstall logs must go to stdout/stderr for CI visibility.
  // eslint-disable-next-line no-console
  console.log("[mcp-gws][postinstall]", ...args);
}

function warn(...args) {
  // eslint-disable-next-line no-console
  console.warn("[mcp-gws][postinstall]", ...args);
}

function fail(msg) {
  const err = new Error(msg);
  err.code = "GWS_INSTALL_FAILED";
  throw err;
}

function exists(p) {
  try {
    fs.accessSync(p, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function mkdirp(p) {
  fs.mkdirSync(p, { recursive: true });
}

function rmrf(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

function platformTargets() {
  const { platform, arch } = process;

  if (platform === "win32") {
    if (arch === "x64") return ["x86_64-pc-windows-msvc"];
    if (arch === "arm64") return ["aarch64-pc-windows-msvc"];
  }

  if (platform === "darwin") {
    if (arch === "x64") return ["x86_64-apple-darwin"];
    if (arch === "arm64") return ["aarch64-apple-darwin"];
  }

  if (platform === "linux") {
    if (arch === "x64") {
      return [
        "x86_64-unknown-linux-gnu",
        "x86_64-unknown-linux-musl-static",
        "x86_64-unknown-linux-musl-dynamic",
      ];
    }
    if (arch === "arm64") {
      return [
        "aarch64-unknown-linux-gnu",
        "aarch64-unknown-linux-musl-static",
        "aarch64-unknown-linux-musl-dynamic",
      ];
    }
  }

  return [];
}

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: {
      "accept": "application/vnd.github+json",
      "user-agent": "@bbot/mcp-gws postinstall",
    },
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} from ${url}`);
  }
  return await res.json();
}

async function download(url, outPath) {
  const res = await fetch(url, {
    headers: {
      // GitHub release asset endpoints honor redirects; no auth required for public repos.
      "user-agent": "@bbot/mcp-gws postinstall",
    },
  });
  if (!res.ok) {
    throw new Error(`Download failed: HTTP ${res.status} from ${url}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(outPath, buf);
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: "inherit", ...opts });
  return r.status === 0;
}

function findBinaryRecursive(dir, binaryNames) {
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const full = path.join(cur, ent.name);
      if (ent.isDirectory()) {
        stack.push(full);
      } else if (ent.isFile()) {
        if (binaryNames.includes(ent.name)) return full;
      }
    }
  }
  return null;
}

function chmodX(p) {
  try {
    fs.chmodSync(p, 0o755);
  } catch {
    // ignore on windows
  }
}

async function main() {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const repoRoot = path.resolve(__dirname, "..");
  const binDir = path.join(repoRoot, "bin");
  const binName = process.platform === "win32" ? "gws.exe" : "gws";
  const destBin = path.join(binDir, binName);

  // If the binary already exists, do nothing.
  if (exists(destBin)) {
    log(`gws already installed at ${destBin}`);
    return;
  }

  // Allow skipping in constrained environments.
  if ((process.env.BBOT_SKIP_GWS_INSTALL || "").trim() === "1") {
    warn("BBOT_SKIP_GWS_INSTALL=1 set; skipping gws install");
    return;
  }

  const targets = platformTargets();
  if (targets.length === 0) {
    fail(`Unsupported platform for gws install: ${process.platform}/${process.arch}`);
  }

  mkdirp(binDir);

  const releaseTag = (process.env.GWS_RELEASE_TAG || "").trim(); // optional
  const releaseUrl = releaseTag
    ? `https://api.github.com/repos/${REPO}/releases/tags/${encodeURIComponent(releaseTag)}`
    : `https://api.github.com/repos/${REPO}/releases/latest`;

  log(`fetching release metadata (${releaseTag || "latest"})`);
  const rel = await fetchJson(releaseUrl);
  const assets = Array.isArray(rel.assets) ? rel.assets : [];

  const preferredExts = process.platform === "win32" ? [".zip"] : [".tar.gz", ".tgz", ".zip"];

  function pickAssetForTarget(target) {
    const needle = target.toLowerCase();
    const candidates = assets.filter((a) => {
      const name = String(a?.name || "").toLowerCase();
      if (!name.includes(needle)) return false;
      return preferredExts.some((ext) => name.endsWith(ext));
    });
    // Prefer tarballs on unix.
    candidates.sort((a, b) => String(a.name).length - String(b.name).length);
    return candidates[0] || null;
  }

  let picked = null;
  for (const target of targets) {
    picked = pickAssetForTarget(target);
    if (picked) {
      log(`selected asset ${picked.name} for target ${target}`);
      break;
    }
  }
  if (!picked) {
    const names = assets.map((a) => a?.name).filter(Boolean).slice(0, 30);
    fail(`No matching release asset found for targets ${targets.join(", ")}. assets[0..30]=${JSON.stringify(names)}`);
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bbot-gws-"));
  const archivePath = path.join(tmpDir, picked.name);
  const extractDir = path.join(tmpDir, "extract");
  mkdirp(extractDir);

  log(`downloading ${picked.browser_download_url}`);
  await download(picked.browser_download_url, archivePath);

  const nameLower = String(picked.name).toLowerCase();
  if (nameLower.endsWith(".tar.gz") || nameLower.endsWith(".tgz")) {
    // tar should exist on Linux/macOS images used by E2B.
    const ok = run("tar", ["-xzf", archivePath, "-C", extractDir]);
    if (!ok) fail("Failed to extract tar archive (tar -xzf)");
  } else if (nameLower.endsWith(".zip")) {
    if (process.platform === "win32") {
      const ok = run("powershell", [
        "-NoProfile",
        "-Command",
        `Expand-Archive -Force -Path "${archivePath}" -DestinationPath "${extractDir}"`,
      ]);
      if (!ok) fail("Failed to extract zip archive (Expand-Archive)");
    } else {
      // Prefer unzip if available.
      const ok = run("unzip", ["-o", archivePath, "-d", extractDir]);
      if (!ok) fail("Failed to extract zip archive (unzip)");
    }
  } else {
    fail(`Unsupported asset type: ${picked.name}`);
  }

  const found = findBinaryRecursive(extractDir, [binName, "gws", "gws.exe"]);
  if (!found) {
    fail("Extracted archive but did not find gws binary inside");
  }

  fs.copyFileSync(found, destBin);
  chmodX(destBin);
  log(`installed gws to ${destBin}`);

  // Cleanup best-effort.
  rmrf(tmpDir);
}

main().catch((err) => {
  warn(String(err?.stack || err));
  process.exitCode = 0; // don't fail npm ci; wrapper can still run if gws is preinstalled
});

