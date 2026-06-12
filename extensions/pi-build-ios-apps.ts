import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, openSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type ExecResult = {
  code: number | null;
  stdout: string;
  stderr: string;
  command: string;
};

type ServeSimState = {
  pid: number;
  port: number;
  udid: string;
  logFile: string;
};

type DirectPreviewState = {
  server?: Server;
  port: number;
  udid: string;
  streamPort: number;
  url: string;
  owned: boolean;
};

type ExtensionState = {
  serveSim: Map<string, ServeSimState>;
  directPreviews: Map<number, DirectPreviewState>;
  cmuxSurface?: string;
};

const state: ExtensionState = {
  serveSim: new Map(),
  directPreviews: new Map(),
};

const WORK_DIR = join(tmpdir(), "pi-build-ios-apps");
const DEFAULT_UDID = "booted";
const DEFAULT_SERVE_SIM_PORT = 3210;
const DEFAULT_STREAM_PORT = 3100;
const DEFAULT_DIRECT_PREVIEW_PORT = 33210;

function ensureWorkDir(): void {
  if (!existsSync(WORK_DIR)) mkdirSync(WORK_DIR, { recursive: true });
}

function textResult(
  text: string,
  details: Record<string, unknown> = {},
): AgentToolResult<Record<string, unknown>> {
  return {
    content: [{ type: "text" as const, text }],
    details,
  };
}

function commandString(command: string, args: string[]): string {
  return [command, ...args].map((part) => {
    if (/^[A-Za-z0-9_./:=@+-]+$/.test(part)) return part;
    return JSON.stringify(part);
  }).join(" ");
}

async function run(
  command: string,
  args: string[] = [],
  options: {
    cwd?: string;
    env?: Record<string, string | undefined>;
    timeoutMs?: number;
    signal?: AbortSignal;
    input?: string;
  } = {},
): Promise<ExecResult> {
  return await new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = options.timeoutMs
      ? setTimeout(() => {
          if (settled) return;
          stderr += `\n[pi-build-ios-apps] timeout after ${options.timeoutMs}ms`;
          child.kill("SIGTERM");
          setTimeout(() => {
            if (!settled) child.kill("SIGKILL");
          }, 750).unref();
        }, options.timeoutMs)
      : undefined;
    const abort = () => {
      stderr += "\n[pi-build-ios-apps] aborted";
      child.kill("SIGTERM");
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      stderr += `\n${error.message}`;
    });
    child.on("close", (code) => {
      settled = true;
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      resolve({ code, stdout, stderr, command: commandString(command, args) });
    });
    if (options.input) child.stdin.end(options.input);
    else child.stdin.end();
  });
}

async function commandExists(command: string): Promise<boolean> {
  const result = await run("/bin/zsh", ["-lc", `command -v ${command}`], { timeoutMs: 3000 });
  return result.code === 0 && result.stdout.trim().length > 0;
}

async function httpOk(url: string, timeoutMs = 2500): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { cache: "no-store", signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function readBytesHex(url: string, byteCount = 32, timeoutMs = 2500): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { cache: "no-store", signal: controller.signal });
    if (!res.ok || !res.body) return null;
    const reader = res.body.getReader();
    const chunks: number[] = [];
    while (chunks.length < byteCount) {
      const next = await reader.read();
      if (next.done) break;
      for (const value of next.value) {
        chunks.push(value);
        if (chunks.length >= byteCount) break;
      }
    }
    await reader.cancel().catch(() => undefined);
    return Buffer.from(chunks).toString("hex");
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function simctlEnv(env?: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env ?? {})) {
    out[`SIMCTL_CHILD_${key}`] = value;
  }
  return out;
}

async function waitForServeSim(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await httpOk(`http://127.0.0.1:${port}/health`, 800)) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

function findSurfaceRef(value: unknown): string | undefined {
  if (typeof value === "string") {
    const match = value.match(/\bsurface:\d+\b/);
    return match?.[0];
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findSurfaceRef(item);
      if (found) return found;
    }
    return undefined;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) {
      const found = findSurfaceRef(item);
      if (found) return found;
    }
  }
  return undefined;
}

async function openInCmux(url: string, options: {
  reuse?: boolean;
  surface?: string;
  newSurface?: boolean;
  signal?: AbortSignal;
}): Promise<{ opened: boolean; surface?: string; stdout?: string; stderr?: string; reason?: string }> {
  if (!(await commandExists("cmux"))) {
    return { opened: false, reason: "cmux command not found" };
  }

  const surface = options.surface || (!options.newSurface && options.reuse !== false ? state.cmuxSurface : undefined);
  if (surface) {
    const navigate = await run("cmux", ["browser", surface, "goto", url], {
      timeoutMs: 10_000,
      signal: options.signal,
    });
    if (navigate.code === 0) {
      state.cmuxSurface = surface;
      return { opened: true, surface, stdout: navigate.stdout, stderr: navigate.stderr };
    }
  }

  const args = ["--json", "browser", "open", url];
  if (process.env.CMUX_WORKSPACE_ID) {
    args.push("--workspace", process.env.CMUX_WORKSPACE_ID);
  }
  args.push("--focus", "false");
  const opened = await run("cmux", args, { timeoutMs: 10_000, signal: options.signal });
  const parsed = (() => {
    try {
      return JSON.parse(opened.stdout) as unknown;
    } catch {
      return opened.stdout;
    }
  })();
  const newSurface = findSurfaceRef(parsed) || findSurfaceRef(opened.stdout);
  if (newSurface) state.cmuxSurface = newSurface;
  return {
    opened: opened.code === 0,
    surface: newSurface,
    stdout: opened.stdout,
    stderr: opened.stderr,
    reason: opened.code === 0 ? undefined : "cmux browser open failed",
  };
}

async function startDirectPreviewServer(options: {
  udid: string;
  port: number;
  streamPort: number;
}): Promise<DirectPreviewState> {
  const existing = state.directPreviews.get(options.port);
  if (existing) {
    return existing;
  }

  const url = `http://localhost:${options.port}/`;
  if (await httpOk(`http://127.0.0.1:${options.port}/health`, 500)) {
    const preview = {
      port: options.port,
      udid: options.udid,
      streamPort: options.streamPort,
      url,
      owned: false,
    };
    state.directPreviews.set(options.port, preview);
    return preview;
  }

  const server = createServer(async (req, res) => {
    const requestUrl = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (requestUrl.pathname === "/health") {
      const data = JSON.stringify({
        ok: true,
        udid: options.udid,
        streamUrl: `http://127.0.0.1:${options.streamPort}/stream.mjpeg`,
      });
      res.writeHead(200, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      res.end(data);
      return;
    }

    if (requestUrl.pathname === "/tap") {
      const x = Number(requestUrl.searchParams.get("x"));
      const y = Number(requestUrl.searchParams.get("y"));
      if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "x and y must be normalized 0..1 coordinates" }));
        return;
      }
      const tap = await run("npx", [
        "--yes",
        "serve-sim@latest",
        "tap",
        x.toFixed(6),
        y.toFixed(6),
        "-d",
        options.udid,
      ], { timeoutMs: 5000 });
      res.writeHead(tap.code === 0 ? 200 : 500, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      res.end(JSON.stringify({
        ok: tap.code === 0,
        command: tap.command,
        stdout: tap.stdout,
        stderr: tap.stderr,
      }));
      return;
    }

    if (requestUrl.pathname !== "/") {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("Not found");
      return;
    }

    const streamUrl = `http://127.0.0.1:${options.streamPort}/stream.mjpeg?t=${Date.now()}`;
    const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>iOS Simulator Direct Stream</title>
<style>
html,body{margin:0;min-height:100%;background:#050505;color:#f5f5f7;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
body{display:grid;place-items:center;overflow:hidden}
.stage{position:relative;width:min(390px,calc(100vw - 32px))}
.phone{display:block;width:100%;height:auto;border-radius:38px;box-shadow:0 0 0 1px rgba(255,255,255,.2),0 22px 70px rgba(0,0,0,.58);background:#111;cursor:crosshair;user-select:none;-webkit-user-drag:none}
.bar{position:fixed;left:16px;right:16px;bottom:14px;display:flex;justify-content:center;gap:8px;pointer-events:none}
.pill{font-size:12px;line-height:1;padding:8px 10px;border-radius:999px;background:rgba(20,20,22,.74);color:#7ee787;border:1px solid rgba(255,255,255,.12);backdrop-filter:blur(10px)}
.tap{color:#f5f5f7}
</style>
</head>
<body>
<main class="stage"><img id="screen" class="phone" alt="iOS Simulator" src="${streamUrl}" draggable="false" /></main>
<div class="bar"><div class="pill">direct stream</div><div id="status" class="pill tap">ready</div></div>
<script>
const img=document.getElementById("screen");
const status=document.getElementById("status");
function point(ev){const r=img.getBoundingClientRect();return{x:Math.max(0,Math.min(1,(ev.clientX-r.left)/r.width)),y:Math.max(0,Math.min(1,(ev.clientY-r.top)/r.height))};}
img.addEventListener("click",async(ev)=>{const p=point(ev);status.textContent="tap "+p.x.toFixed(2)+","+p.y.toFixed(2);try{const res=await fetch("/tap?x="+p.x+"&y="+p.y,{cache:"no-store"});status.textContent=res.ok?"tap sent":"tap failed";}catch{status.textContent="tap failed";}});
img.addEventListener("error",()=>{status.textContent="stream lost";setTimeout(()=>{img.src="${streamUrl.split("?")[0]}?t="+Date.now();},800);});
</script>
</body>
</html>`;
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(html);
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(options.port, "127.0.0.1");
  });

  const preview = {
    server,
    port: options.port,
    udid: options.udid,
    streamPort: options.streamPort,
    url,
    owned: true,
  };
  state.directPreviews.set(options.port, preview);
  return preview;
}

export default function piBuildIosApps(pi: ExtensionAPI) {
  pi.registerCommand("ios-build-help", {
    description: "Show pi-build-ios-apps usage",
    handler: async (_args, ctx) => {
      ctx.ui.notify("Use /skill:pi-build-ios-apps, then call pi_ios_doctor -> pi_ios_xcodebuild/pi_ios_simulator -> pi_ios_serve_sim -> pi_ios_preview or pi_ios_cmux_open.", "info");
    },
  });

  pi.registerTool({
    name: "pi_ios_doctor",
    label: "iOS Doctor",
    description: "Inspect local iOS build prerequisites: Xcode, simctl, Node/npm, CocoaPods, serve-sim, and cmux.",
    promptGuidelines: [
      "Use pi_ios_doctor before iOS builds or simulator preview work to establish the actual local toolchain state.",
      "pi_ios_doctor is read-only and must not be used to change system proxy settings.",
    ],
    parameters: Type.Object({
      includeSimulators: Type.Optional(Type.Boolean({ default: true })),
    }),
    async execute(_toolCallId, params: { includeSimulators?: boolean }, signal) {
      const checks = await Promise.all([
        run("xcodebuild", ["-version"], { timeoutMs: 5000, signal }),
        run("xcrun", ["simctl", "list", "runtimes"], { timeoutMs: 8000, signal }),
        run("node", ["--version"], { timeoutMs: 3000, signal }),
        run("npm", ["--version"], { timeoutMs: 3000, signal }),
        run("/bin/zsh", ["-lc", "command -v pod && pod --version"], { timeoutMs: 5000, signal }),
        run("npx", ["--yes", "serve-sim@latest", "--version"], { timeoutMs: 15_000, signal }),
        run("/bin/zsh", ["-lc", "command -v cmux && cmux version"], { timeoutMs: 5000, signal }),
      ]);
      const simulators = params.includeSimulators === false
        ? undefined
        : await run("xcrun", ["simctl", "list", "devices", "available"], { timeoutMs: 8000, signal });

      const summary = [
        "# pi-build-ios-apps doctor",
        `cwd: ${process.cwd()}`,
        `cmux workspace: ${process.env.CMUX_WORKSPACE_ID ?? "(not set)"}`,
        "",
        "## Tools",
        `xcodebuild:\n${checks[0].stdout || checks[0].stderr}`,
        `simctl runtimes:\n${checks[1].stdout || checks[1].stderr}`,
        `node: ${checks[2].stdout.trim() || checks[2].stderr.trim() || "missing"}`,
        `npm: ${checks[3].stdout.trim() || checks[3].stderr.trim() || "missing"}`,
        `pod: ${checks[4].stdout.trim() || checks[4].stderr.trim() || "missing"}`,
        `serve-sim: ${checks[5].stdout.trim() || checks[5].stderr.trim() || "missing"}`,
        `cmux: ${checks[6].stdout.trim() || checks[6].stderr.trim() || "missing"}`,
        simulators ? `\n## Available Simulators\n${simulators.stdout || simulators.stderr}` : "",
      ].join("\n");
      return textResult(summary, { checks, simulators });
    },
  });

  pi.registerTool({
    name: "pi_ios_xcodebuild",
    label: "iOS xcodebuild",
    description: "Run scoped xcodebuild actions for iOS Simulator projects and workspaces.",
    promptGuidelines: [
      "Use pi_ios_xcodebuild for Xcode workspace/project scheme listing, build, clean, and test actions.",
      "pi_ios_xcodebuild must include an explicit workspacePath or projectPath for nontrivial builds.",
      "Use pi_ios_xcodebuild with a simulator UDID destination when building for iOS Simulator.",
    ],
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("list"),
        Type.Literal("build"),
        Type.Literal("test"),
        Type.Literal("clean"),
        Type.Literal("build-for-testing"),
        Type.Literal("test-without-building"),
      ]),
      workspacePath: Type.Optional(Type.String()),
      projectPath: Type.Optional(Type.String()),
      scheme: Type.Optional(Type.String()),
      configuration: Type.Optional(Type.String({ default: "Debug" })),
      simulatorId: Type.Optional(Type.String()),
      destination: Type.Optional(Type.String()),
      derivedDataPath: Type.Optional(Type.String()),
      resultBundlePath: Type.Optional(Type.String()),
      extraArgs: Type.Optional(Type.Array(Type.String())),
      cwd: Type.Optional(Type.String()),
      timeoutMs: Type.Optional(Type.Number({ default: 600000 })),
    }),
    async execute(_toolCallId, params: {
      action: string;
      workspacePath?: string;
      projectPath?: string;
      scheme?: string;
      configuration?: string;
      simulatorId?: string;
      destination?: string;
      derivedDataPath?: string;
      resultBundlePath?: string;
      extraArgs?: string[];
      cwd?: string;
      timeoutMs?: number;
    }, signal) {
      const args: string[] = [];
      if (params.workspacePath) args.push("-workspace", params.workspacePath);
      if (params.projectPath) args.push("-project", params.projectPath);
      if (params.scheme) args.push("-scheme", params.scheme);
      if (params.configuration && params.action !== "list") args.push("-configuration", params.configuration);
      const destination = params.destination || (params.simulatorId ? `platform=iOS Simulator,id=${params.simulatorId}` : undefined);
      if (destination && params.action !== "list") args.push("-destination", destination);
      if (params.derivedDataPath) args.push("-derivedDataPath", params.derivedDataPath);
      if (params.resultBundlePath) args.push("-resultBundlePath", params.resultBundlePath);
      if (params.extraArgs?.length) args.push(...params.extraArgs);
      if (params.action === "list") args.push("-list", "-json");
      else args.push(params.action);
      const result = await run("xcodebuild", args, {
        cwd: params.cwd,
        timeoutMs: params.timeoutMs ?? 600_000,
        signal,
      });
      const text = [
        `$ ${result.command}`,
        `exit: ${result.code}`,
        result.stdout ? `\nstdout:\n${result.stdout}` : "",
        result.stderr ? `\nstderr:\n${result.stderr}` : "",
      ].join("\n");
      return textResult(text, { result });
    },
  });

  pi.registerTool({
    name: "pi_ios_simulator",
    label: "iOS Simulator",
    description: "Manage iOS Simulator with simctl: list, boot, install, launch, terminate, and screenshot.",
    promptGuidelines: [
      "Use pi_ios_simulator for simulator boot/install/launch/screenshot work before opening browser previews.",
      "Use pi_ios_simulator launch env to pass React Native values like RCT_METRO_PORT.",
    ],
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("list"),
        Type.Literal("boot"),
        Type.Literal("bootstatus"),
        Type.Literal("install"),
        Type.Literal("launch"),
        Type.Literal("terminate"),
        Type.Literal("screenshot"),
      ]),
      udid: Type.Optional(Type.String({ default: DEFAULT_UDID })),
      appPath: Type.Optional(Type.String()),
      bundleId: Type.Optional(Type.String()),
      outputPath: Type.Optional(Type.String()),
      env: Type.Optional(Type.Record(Type.String(), Type.String())),
      launchArgs: Type.Optional(Type.Array(Type.String())),
      timeoutMs: Type.Optional(Type.Number({ default: 120000 })),
    }),
    async execute(_toolCallId, params: {
      action: string;
      udid?: string;
      appPath?: string;
      bundleId?: string;
      outputPath?: string;
      env?: Record<string, string>;
      launchArgs?: string[];
      timeoutMs?: number;
    }, signal) {
      const udid = params.udid || DEFAULT_UDID;
      let args: string[];
      let env: Record<string, string> | undefined;
      switch (params.action) {
        case "list":
          args = ["simctl", "list", "devices", "available"];
          break;
        case "boot":
          args = ["simctl", "boot", udid];
          break;
        case "bootstatus":
          args = ["simctl", "bootstatus", udid, "-b"];
          break;
        case "install":
          if (!params.appPath) return textResult("appPath is required for install");
          args = ["simctl", "install", udid, params.appPath];
          break;
        case "launch":
          if (!params.bundleId) return textResult("bundleId is required for launch");
          args = ["simctl", "launch", udid, params.bundleId, ...(params.launchArgs ?? [])];
          env = simctlEnv(params.env);
          break;
        case "terminate":
          if (!params.bundleId) return textResult("bundleId is required for terminate");
          args = ["simctl", "terminate", udid, params.bundleId];
          break;
        case "screenshot":
          if (!params.outputPath) return textResult("outputPath is required for screenshot");
          args = ["simctl", "io", udid, "screenshot", params.outputPath];
          break;
        default:
          return textResult(`Unknown action: ${params.action}`);
      }
      const result = await run("xcrun", args, {
        env,
        timeoutMs: params.timeoutMs ?? 120_000,
        signal,
      });
      const text = [
        `$ ${result.command}`,
        `exit: ${result.code}`,
        result.stdout ? `\nstdout:\n${result.stdout}` : "",
        result.stderr ? `\nstderr:\n${result.stderr}` : "",
      ].join("\n");
      return textResult(text, { result });
    },
  });

  pi.registerTool({
    name: "pi_ios_serve_sim",
    label: "serve-sim",
    description: "Start, stop, inspect, and interact with serve-sim for one explicit Simulator UDID.",
    promptGuidelines: [
      "Use pi_ios_serve_sim start with an explicit UDID after the simulator and app are running.",
      "Use pi_ios_serve_sim status before blaming system proxy settings for a Connecting preview.",
      "Use pi_ios_serve_sim stop only for the explicit UDID; never kill unscoped serve-sim processes.",
    ],
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("start"),
        Type.Literal("stop"),
        Type.Literal("status"),
        Type.Literal("tap"),
        Type.Literal("type"),
        Type.Literal("button"),
        Type.Literal("rotate"),
      ]),
      udid: Type.String(),
      port: Type.Optional(Type.Number({ default: DEFAULT_SERVE_SIM_PORT })),
      restart: Type.Optional(Type.Boolean({ default: true })),
      x: Type.Optional(Type.Number()),
      y: Type.Optional(Type.Number()),
      text: Type.Optional(Type.String()),
      button: Type.Optional(Type.String({ default: "home" })),
      orientation: Type.Optional(Type.String()),
      timeoutMs: Type.Optional(Type.Number({ default: 120000 })),
    }),
    async execute(_toolCallId, params: {
      action: string;
      udid: string;
      port?: number;
      restart?: boolean;
      x?: number;
      y?: number;
      text?: string;
      button?: string;
      orientation?: string;
      timeoutMs?: number;
    }, signal) {
      const port = params.port ?? DEFAULT_SERVE_SIM_PORT;
      if (params.action === "start") {
        ensureWorkDir();
        if (params.restart !== false) {
          await run("npx", ["--yes", "serve-sim@latest", "--kill", params.udid], {
            timeoutMs: 10_000,
            signal,
          });
        }
        const logFile = join(WORK_DIR, `serve-sim-${params.udid}-${port}.log`);
        const fd = openSync(logFile, "a");
        const child = spawn("npx", ["--yes", "serve-sim@latest", "--port", String(port), params.udid], {
          detached: true,
          stdio: ["ignore", fd, fd],
          env: process.env,
        });
        child.unref();
        state.serveSim.set(params.udid, { pid: child.pid ?? -1, port, udid: params.udid, logFile });
        const ready = await waitForServeSim(DEFAULT_STREAM_PORT, params.timeoutMs ?? 120_000);
        const previewOk = await httpOk(`http://127.0.0.1:${port}/`, 2000);
        const status = await run("npx", ["--yes", "serve-sim@latest", "--list", params.udid], {
          timeoutMs: 10_000,
          signal,
        });
        return textResult([
          `serve-sim started for ${params.udid}`,
          `previewUrl: http://localhost:${port}/?device=${encodeURIComponent(params.udid)}`,
          `streamHealth: ${ready ? "ok" : "not ready"}`,
          `previewHttp: ${previewOk ? "ok" : "not ready"}`,
          `pid: ${child.pid ?? "unknown"}`,
          `logFile: ${logFile}`,
          "",
          status.stdout || status.stderr,
        ].join("\n"), { pid: child.pid, logFile, status });
      }

      if (params.action === "stop") {
        const known = state.serveSim.get(params.udid);
        if (known?.pid && known.pid > 0) {
          try {
            process.kill(known.pid, "SIGTERM");
          } catch {
            // ignore stale pids
          }
          state.serveSim.delete(params.udid);
        }
        const stopped = await run("npx", ["--yes", "serve-sim@latest", "--kill", params.udid], {
          timeoutMs: 10_000,
          signal,
        });
        return textResult(stopped.stdout || stopped.stderr || "stopped", { stopped });
      }

      if (params.action === "status") {
        const listed = await run("npx", ["--yes", "serve-sim@latest", "--list", params.udid], {
          timeoutMs: 10_000,
          signal,
        });
        const health = await httpOk(`http://127.0.0.1:${DEFAULT_STREAM_PORT}/health`, 2000);
        const frameHex = await readBytesHex(`http://127.0.0.1:${DEFAULT_STREAM_PORT}/stream.mjpeg`, 32, 2500);
        return textResult([
          listed.stdout || listed.stderr,
          `health: ${health ? "ok" : "failed"}`,
          `streamFirstBytesHex: ${frameHex ?? "(none)"}`,
        ].join("\n"), { listed, health, frameHex });
      }

      let args: string[];
      if (params.action === "tap") {
        if (params.x == null || params.y == null) return textResult("x and y are required for tap");
        args = ["--yes", "serve-sim@latest", "tap", String(params.x), String(params.y), "-d", params.udid];
      } else if (params.action === "type") {
        if (!params.text) return textResult("text is required for type");
        args = ["--yes", "serve-sim@latest", "type", params.text, "-d", params.udid];
      } else if (params.action === "button") {
        args = ["--yes", "serve-sim@latest", "button", params.button ?? "home", "-d", params.udid];
      } else if (params.action === "rotate") {
        if (!params.orientation) return textResult("orientation is required for rotate");
        args = ["--yes", "serve-sim@latest", "rotate", params.orientation, "-d", params.udid];
      } else {
        return textResult(`Unknown action: ${params.action}`);
      }
      const result = await run("npx", args, { timeoutMs: params.timeoutMs ?? 120_000, signal });
      return textResult([
        `$ ${result.command}`,
        `exit: ${result.code}`,
        result.stdout ? `\nstdout:\n${result.stdout}` : "",
        result.stderr ? `\nstderr:\n${result.stderr}` : "",
      ].join("\n"), { result });
    },
  });

  pi.registerTool({
    name: "pi_ios_preview",
    label: "iOS Preview",
    description: "Start or stop a direct MJPEG iOS Simulator preview page that avoids serve-sim's Connecting overlay.",
    promptGuidelines: [
      "Use pi_ios_preview when the official serve-sim page remains on Connecting but stream.mjpeg is healthy.",
      "Use pi_ios_preview openInCmux only through the reusable cmux surface flow; avoid extra browser tabs unless requested.",
    ],
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("start-direct"),
        Type.Literal("stop-direct"),
        Type.Literal("status"),
      ]),
      udid: Type.Optional(Type.String()),
      port: Type.Optional(Type.Number({ default: DEFAULT_DIRECT_PREVIEW_PORT })),
      streamPort: Type.Optional(Type.Number({ default: DEFAULT_STREAM_PORT })),
      openInCmux: Type.Optional(Type.Boolean({ default: false })),
      cmuxSurface: Type.Optional(Type.String()),
      newSurface: Type.Optional(Type.Boolean({ default: false })),
    }),
    async execute(_toolCallId, params: {
      action: string;
      udid?: string;
      port?: number;
      streamPort?: number;
      openInCmux?: boolean;
      cmuxSurface?: string;
      newSurface?: boolean;
    }, signal) {
      const port = params.port ?? DEFAULT_DIRECT_PREVIEW_PORT;
      if (params.action === "stop-direct") {
        const existing = state.directPreviews.get(port);
        const server = existing?.server;
        if (server) {
          await new Promise<void>((resolve) => server.close(() => resolve()));
          state.directPreviews.delete(port);
          return textResult(`Stopped direct preview on http://localhost:${port}/`);
        }
        if (existing) {
          state.directPreviews.delete(port);
          return textResult(`Direct preview on http://localhost:${port}/ is external to this Pi session; leaving it running.`);
        }
        return textResult(`No direct preview running on port ${port}`);
      }

      if (params.action === "status") {
        const existing = state.directPreviews.get(port);
        const health = existing ? await httpOk(`http://127.0.0.1:${port}/health`, 1000) : false;
        return textResult(JSON.stringify({
          running: Boolean(existing),
          url: existing?.url,
          health,
          cmuxSurface: state.cmuxSurface,
        }, null, 2), { existing: Boolean(existing), health });
      }

      if (params.action !== "start-direct") return textResult(`Unknown action: ${params.action}`);
      if (!params.udid) return textResult("udid is required for start-direct");
      const streamPort = params.streamPort ?? DEFAULT_STREAM_PORT;
      const streamHealth = await httpOk(`http://127.0.0.1:${streamPort}/health`, 2000);
      const frameHex = await readBytesHex(`http://127.0.0.1:${streamPort}/stream.mjpeg`, 32, 2500);
      let preview: DirectPreviewState;
      try {
        preview = await startDirectPreviewServer({ udid: params.udid, port, streamPort });
      } catch (error) {
        return textResult(`Could not start direct preview on http://localhost:${port}/: ${error instanceof Error ? error.message : String(error)}`, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      const cmux = params.openInCmux
        ? await openInCmux(preview.url, {
            reuse: true,
            surface: params.cmuxSurface,
            newSurface: params.newSurface,
            signal,
          })
        : undefined;
      return textResult([
        `directPreviewUrl: ${preview.url}`,
        `previewOwner: ${preview.owned ? "this Pi session" : "external existing server"}`,
        `streamHealth: ${streamHealth ? "ok" : "failed"}`,
        `streamFirstBytesHex: ${frameHex ?? "(none)"}`,
        cmux ? `cmux: ${cmux.opened ? "opened" : "not opened"} ${cmux.surface ?? ""} ${cmux.reason ?? ""}` : "cmux: not requested",
      ].join("\n"), { previewUrl: preview.url, previewOwned: preview.owned, streamHealth, frameHex, cmux });
    },
  });

  pi.registerTool({
    name: "pi_ios_cmux_open",
    label: "cmux Open iOS Preview",
    description: "Open or reuse a cmux browser surface for an iOS preview URL without creating extra tabs by default.",
    promptGuidelines: [
      "Use pi_ios_cmux_open to show iOS preview URLs in cmux when Pi is running inside cmux.",
      "pi_ios_cmux_open must reuse an existing surface by default; create a new surface only when no reusable surface exists or newSurface is true.",
      "pi_ios_cmux_open should pass focus false and avoid disrupting the user's active cmux workspace.",
    ],
    parameters: Type.Object({
      url: Type.String(),
      cmuxSurface: Type.Optional(Type.String()),
      newSurface: Type.Optional(Type.Boolean({ default: false })),
    }),
    async execute(_toolCallId, params: { url: string; cmuxSurface?: string; newSurface?: boolean }, signal) {
      const opened = await openInCmux(params.url, {
        reuse: true,
        surface: params.cmuxSurface,
        newSurface: params.newSurface,
        signal,
      });
      return textResult(JSON.stringify({
        ...opened,
        rememberedSurface: state.cmuxSurface,
        url: params.url,
      }, null, 2), opened as Record<string, unknown>);
    },
  });

  pi.on("session_shutdown", async () => {
    for (const preview of state.directPreviews.values()) {
      preview.server?.close();
    }
    state.directPreviews.clear();
  });
}
