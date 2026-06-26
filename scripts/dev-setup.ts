import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

type StepName =
  | "repo_root"
  | "prereqs"
  | "npm_install"
  | "assistant_config"
  | "docker_stack"
  | "probes";

type ChangeStatus = "added" | "updated" | "unchanged" | "skipped";

type AssistantName = "claude" | "codex";

type SetupState = {
  repoRoot: string;
  startedAt: string;
  updatedAt: string;
  completedSteps: StepName[];
  lastStep: StepName | null;
};

type AssistantDetection = {
  installed: boolean;
  detectedBy: string[];
};

type PrereqCheck = {
  ok: boolean;
  summary: string;
  instructions: string[];
};

type PrereqReport = {
  docker: PrereqCheck;
  node: PrereqCheck;
  helix: PrereqCheck;
  iii: PrereqCheck;
  openAiKey: PrereqCheck;
  assistants: Record<AssistantName, AssistantDetection>;
  missing: PrereqCheck[];
};

type JsonResult = {
  status: ChangeStatus;
  path: string;
};

type ConfigureReport = {
  configuredAssistants: AssistantName[];
  claudeHooks: JsonResult;
  claudeMcp: JsonResult;
  codexHooks: JsonResult;
  codexMcp: JsonResult;
};

type ComposeServiceStatus = {
  service: string;
  state: string;
  status: string;
  exitCode: number | null;
  raw: Record<string, unknown>;
};

type ProbeResult = {
  name: string;
  url: string;
  ok: boolean;
  status: number | null;
  detail: string;
};

type StackReport = {
  action: "unchanged" | "repaired";
  services: ComposeServiceStatus[];
  probes: ProbeResult[];
};

type SetupContext = {
  repoRoot: string;
  statePath: string;
  rootEnvPath: string;
  rootTsxPath: string;
  tsxPath: string;
  injectPath: string;
  capturePath: string;
  mcpServerPath: string;
};

type MergeStatus = "added" | "updated" | "unchanged";

class ManualActionError extends Error {
  instructions: string[];

  constructor(message: string, instructions: string[]) {
    super(message);
    this.name = "ManualActionError";
    this.instructions = instructions;
  }
}

const LONG_RUNNING_SERVICES = ["minio", "helix", "iii", "worker", "dashboard"] as const;
const ONE_SHOT_SERVICE = "minio-setup";

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const repoRoot = resolveRepoRoot(args.repoRoot);
  const ctx = buildContext(repoRoot);
  const state = loadState(ctx.statePath);
  const completed = new Set<StepName>(state?.completedSteps ?? []);

  if (state) {
    log(`Resuming dev setup from ${ctx.statePath}`);
  }

  saveState(ctx.statePath, repoRoot, completed, "repo_root");

  const prereqs = runStep(
    ctx,
    completed,
    "prereqs",
    () => {
      const report = checkPrerequisites(ctx);
      if (report.missing.length > 0) {
        throw new ManualActionError(
          "Cannot continue until all required prerequisites are available.",
          buildMissingPrereqInstructions(ctx, report),
        );
      }
      return report;
    },
  );

  runStep(ctx, completed, "npm_install", () => ensureRootInstall(ctx));

  const configureReport = runStep(
    ctx,
    completed,
    "assistant_config",
    () => configureAssistants(ctx, prereqs.assistants),
  );

  const stackReport = runStep(ctx, completed, "docker_stack", () => ensureDockerStack(ctx));
  runStep(ctx, completed, "probes", () => stackReport);

  let openedDashboard = false;
  if (!args.noOpen) {
    openedDashboard = openDashboard("http://localhost:48173/dashboard");
  }

  rmSync(ctx.statePath, { force: true });
  printSuccess(ctx, prereqs, configureReport, stackReport, openedDashboard);
}

function parseArgs(argv: string[]): { repoRoot?: string; noOpen: boolean; help: boolean } {
  const parsed = { repoRoot: undefined as string | undefined, noOpen: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--repo-root") {
      parsed.repoRoot = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--no-open") {
      parsed.noOpen = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      continue;
    }
    throw new ManualActionError(`Unknown argument: ${arg}`, [
      "Use `--repo-root <absolute-path-to-unimind>` when you are not running from the repo root.",
      "Use `--no-open` to skip automatically opening the dashboard.",
    ]);
  }
  return parsed;
}

function printHelp(): void {
  console.log(`UniMind dev setup

Usage:
  npx --yes tsx scripts/dev-setup.ts
  npx --yes tsx /absolute/path/to/unimind/scripts/dev-setup.ts --repo-root /absolute/path/to/unimind

Options:
  --repo-root <path>  Absolute path to the unimind repo when current directory is not the repo root
  --no-open           Skip automatically opening http://localhost:48173/dashboard
  --help, -h          Show this help text`);
}

function resolveRepoRoot(explicitRepoRoot?: string): string {
  const candidate = explicitRepoRoot ? resolve(explicitRepoRoot) : process.cwd();
  if (!isValidRepoRoot(candidate)) {
    throw new ManualActionError("Could not resolve the UniMind repo root.", [
      explicitRepoRoot
        ? `The provided path is not a valid UniMind repo root: ${candidate}`
        : `Current directory is not the UniMind repo root: ${candidate}`,
      "Run the skill from the `unimind` repo root, or provide the absolute path with:",
      "  npx --yes tsx /absolute/path/to/unimind/scripts/dev-setup.ts --repo-root /absolute/path/to/unimind",
    ]);
  }
  if (basename(candidate) !== "unimind") {
    throw new ManualActionError("The resolved path is valid but is not named `unimind`.", [
      `Resolved path: ${candidate}`,
      "Please provide the absolute path to the actual `unimind` checkout.",
    ]);
  }
  return candidate;
}

function isValidRepoRoot(repoRoot: string): boolean {
  return [
    join(repoRoot, "docker-compose.yml"),
    join(repoRoot, "package.json"),
    join(repoRoot, "src", "mcp", "server.ts"),
    join(repoRoot, "src", "hooks", "inject.ts"),
    join(repoRoot, "src", "hooks", "capture.ts"),
  ].every((path) => existsSync(path));
}

function buildContext(repoRoot: string): SetupContext {
  const tsxBin = process.platform === "win32" ? "tsx.cmd" : "tsx";
  return {
    repoRoot,
    statePath: join(repoRoot, ".unimind", "dev-setup-state.json"),
    rootEnvPath: join(repoRoot, ".env"),
    rootTsxPath: join(repoRoot, "node_modules", ".bin", tsxBin),
    tsxPath: join(repoRoot, "node_modules", ".bin", tsxBin),
    injectPath: join(repoRoot, "src", "hooks", "inject.ts"),
    capturePath: join(repoRoot, "src", "hooks", "capture.ts"),
    mcpServerPath: join(repoRoot, "src", "mcp", "server.ts"),
  };
}

function loadState(statePath: string): SetupState | null {
  if (!existsSync(statePath)) return null;
  try {
    const raw = JSON.parse(readFileSync(statePath, "utf8")) as SetupState;
    return raw;
  } catch {
    return null;
  }
}

function saveState(
  statePath: string,
  repoRoot: string,
  completed: Set<StepName>,
  lastStep: StepName | null,
): void {
  mkdirSync(join(repoRoot, ".unimind"), { recursive: true });
  const payload: SetupState = {
    repoRoot,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    completedSteps: [...completed],
    lastStep,
  };
  if (existsSync(statePath)) {
    try {
      const previous = JSON.parse(readFileSync(statePath, "utf8")) as Partial<SetupState>;
      payload.startedAt = typeof previous.startedAt === "string" ? previous.startedAt : payload.startedAt;
    } catch {
      // Ignore malformed state here; a fresh state file is safe.
    }
  }
  writeFileSync(statePath, `${JSON.stringify(payload, null, 2)}\n`);
}

function runStep<T>(
  ctx: SetupContext,
  completed: Set<StepName>,
  step: StepName,
  action: () => T,
): T {
  if (completed.has(step)) {
    log(`Re-checking step after a previous partial run: ${step}`);
  }
  saveState(ctx.statePath, ctx.repoRoot, completed, step);
  const result = action();
  completed.add(step);
  saveState(ctx.statePath, ctx.repoRoot, completed, step);
  return result;
}

function checkPrerequisites(ctx: SetupContext): PrereqReport {
  const claudeInstalled = detectAssistant("claude", join(homedir(), ".claude"));
  const codexInstalled = detectAssistant("codex", join(homedir(), ".codex"));

  const dockerVersion = captureCommand("docker", ["--version"]);
  const dockerComposeVersion = captureCommand("docker", ["compose", "version"]);
  const dockerInfo = captureCommand("docker", ["info"]);

  const dockerOk = dockerVersion.ok && dockerComposeVersion.ok && dockerInfo.ok;
  const dockerCheck: PrereqCheck = dockerOk
    ? {
        ok: true,
        summary: `${trimOneLine(dockerVersion.stdout)} | ${trimOneLine(dockerComposeVersion.stdout)}`,
        instructions: [],
      }
    : {
        ok: false,
        summary: "Docker is missing, Docker Compose v2 is missing, or the Docker daemon is not running.",
        instructions: [
          "macOS: install Docker Desktop (`brew install --cask docker`) or Colima + Docker (`brew install colima docker && colima start`).",
          "Linux: install Docker (`curl -fsSL https://get.docker.com | sh`) or Podman if your environment supports it.",
          "If Docker is installed but stopped, start it before rerunning setup.",
        ],
      };

  const nodeVersion = captureCommand("node", ["--version"]);
  const nodeMajor = nodeVersion.ok ? parseNodeMajor(nodeVersion.stdout) : null;
  const nodeOk = nodeVersion.ok && nodeMajor !== null && nodeMajor >= 20;
  const nodeCheck: PrereqCheck = nodeOk
    ? { ok: true, summary: trimOneLine(nodeVersion.stdout), instructions: [] }
    : {
        ok: false,
        summary: "Node.js 20+ is required.",
        instructions: [
          "Install Node.js 20 or newer, then rerun setup.",
          "macOS (Homebrew): `brew install node`.",
          "Otherwise install the current LTS from the official Node.js distribution.",
        ],
      };

  const helixVersion = captureCommand("helix", ["-v"]);
  const helixCheck: PrereqCheck = helixVersion.ok
    ? { ok: true, summary: trimOneLine(helixVersion.stdout || helixVersion.stderr), instructions: [] }
    : {
        ok: false,
        summary: "Helix CLI is not installed.",
        instructions: [
          'Install Helix with `curl -sSL "https://install.helix-db.com" | bash`.',
          "Docs: https://docs.helix-db.com/database/local-development#quick-start-with-the-cli",
        ],
      };

  const iiiVersion = captureCommand("iii", ["-v"]);
  const iiiCheck: PrereqCheck = iiiVersion.ok
    ? { ok: true, summary: trimOneLine(iiiVersion.stdout || iiiVersion.stderr), instructions: [] }
    : {
        ok: false,
        summary: "iii CLI is not installed.",
        instructions: [
          "Install iii, then rerun setup.",
          "Docs: https://iii.dev/docs/install",
        ],
      };

  const openAiKey = resolveOpenAiKey(ctx.rootEnvPath);
  const openAiCheck: PrereqCheck = openAiKey.found
    ? { ok: true, summary: openAiKey.source, instructions: [] }
    : {
        ok: false,
        summary: "OPENAI_API_KEY is missing.",
        instructions: [
          `Add OPENAI_API_KEY to ${ctx.rootEnvPath} or export it in your shell before rerunning setup.`,
          `Example ${ctx.rootEnvPath} entry: OPENAI_API_KEY=your_key_here`,
        ],
      };

  const missing = [dockerCheck, nodeCheck, helixCheck, iiiCheck, openAiCheck].filter((item) => !item.ok);
  if (!claudeInstalled.installed && !codexInstalled.installed) {
    missing.push({
      ok: false,
      summary: "Neither Claude nor Codex appears to be installed.",
      instructions: [
        "Install Claude Code and/or Codex, then launch the installed app once before rerunning setup.",
        "Claude should create ~/.claude and Codex should create ~/.codex after first launch.",
      ],
    });
  }

  return {
    docker: dockerCheck,
    node: nodeCheck,
    helix: helixCheck,
    iii: iiiCheck,
    openAiKey: openAiCheck,
    assistants: {
      claude: claudeInstalled,
      codex: codexInstalled,
    },
    missing,
  };
}

function detectAssistant(commandName: AssistantName, configDir: string): AssistantDetection {
  const detectedBy: string[] = [];
  if (commandExists(commandName)) detectedBy.push("command");
  if (existsSync(configDir)) detectedBy.push("config_dir");
  return { installed: detectedBy.length > 0, detectedBy };
}

function buildMissingPrereqInstructions(ctx: SetupContext, report: PrereqReport): string[] {
  const instructions = ["Missing prerequisites:"];
  for (const item of report.missing) {
    instructions.push(`- ${item.summary}`);
    for (const detail of item.instructions) {
      instructions.push(`  ${detail}`);
    }
  }
  instructions.push("");
  instructions.push("You can continue manually after fixing the missing prerequisites:");
  instructions.push(`1. From ${ctx.repoRoot}, run \`npm ci\`.`);
  instructions.push(`2. From ${ctx.repoRoot}, run \`docker compose up -d --build\`.`);
  instructions.push("3. Verify the stack:");
  instructions.push("   - Helix: curl http://localhost:6969/v1/query (any HTTP response is acceptable)");
  instructions.push("   - iii: curl http://127.0.0.1:3111/ (any HTTP response is acceptable)");
  instructions.push("   - Worker: curl http://localhost:48180/health (expect 200)");
  instructions.push("   - Dashboard: open http://localhost:48173/dashboard");
  instructions.push("4. Optional iii UI: run `iii console` from any folder, then open http://127.0.0.1:3113/.");
  instructions.push("5. After prerequisites are fixed, rerun `/dev-setup` or the same `npx --yes tsx .../scripts/dev-setup.ts` command.");
  return instructions;
}

function resolveOpenAiKey(envPath: string): { found: boolean; source: string } {
  if (process.env.OPENAI_API_KEY?.trim()) {
    return { found: true, source: "present in current shell environment" };
  }
  if (!existsSync(envPath)) {
    return { found: false, source: "missing" };
  }
  const lines = readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^\s*OPENAI_API_KEY\s*=\s*(.+)\s*$/);
    if (match && match[1].trim()) {
      return { found: true, source: `present in ${envPath}` };
    }
  }
  return { found: false, source: "missing" };
}

function ensureRootInstall(ctx: SetupContext): void {
  if (existsSync(ctx.rootTsxPath)) {
    log("Root npm install already present.");
    return;
  }
  log("Installing root npm dependencies with `npm ci`...");
  runStreamingCommand("npm", ["ci"], ctx.repoRoot, "Root npm install failed.");
}

function configureAssistants(
  ctx: SetupContext,
  assistants: Record<AssistantName, AssistantDetection>,
): ConfigureReport {
  const report: ConfigureReport = {
    configuredAssistants: [],
    claudeHooks: { status: "skipped", path: join(homedir(), ".claude", "settings.json") },
    claudeMcp: { status: "skipped", path: join(homedir(), ".claude.json") },
    codexHooks: { status: "skipped", path: join(homedir(), ".codex", "hooks.json") },
    codexMcp: { status: "skipped", path: join(homedir(), ".codex", "config.toml") },
  };

  if (assistants.claude.installed) {
    report.configuredAssistants.push("claude");
    report.claudeHooks = configureClaudeHooks(ctx);
    report.claudeMcp = configureClaudeMcp(ctx);
  }

  if (assistants.codex.installed) {
    report.configuredAssistants.push("codex");
    report.codexHooks = configureCodexHooks(ctx);
    report.codexMcp = configureCodexMcp(ctx);
  }

  return report;
}

function configureClaudeHooks(ctx: SetupContext): JsonResult {
  const path = join(homedir(), ".claude", "settings.json");
  mkdirSync(join(homedir(), ".claude"), { recursive: true });
  const data = readJsonFile(path, {});
  const hooks = ensureObject(data, "hooks", path);
  const changes: MergeStatus[] = [];

  changes.push(mergeHookEntry(
    hooks,
    "UserPromptSubmit",
    "src/hooks/inject.ts",
    {
      hooks: [
        {
          type: "command",
          command: hookCommand(ctx.tsxPath, ctx.injectPath),
          timeout: 30,
        },
      ],
    },
  ));

  changes.push(mergeHookEntry(
    hooks,
    "PostToolUse",
    "src/hooks/capture.ts",
    {
      matcher: "Edit|Write|MultiEdit|Bash|NotebookEdit",
      hooks: [
        {
          type: "command",
          command: hookCommand(ctx.tsxPath, ctx.capturePath),
          timeout: 10,
        },
      ],
    },
  ));

  for (const eventName of ["Stop", "PreCompact", "SessionEnd"]) {
    changes.push(mergeHookEntry(
      hooks,
      eventName,
      "src/hooks/capture.ts",
      {
        hooks: [
          {
            type: "command",
            command: hookCommand(ctx.tsxPath, ctx.capturePath),
            timeout: 10,
          },
        ],
      },
    ));
  }

  data.hooks = hooks;
  writeJsonFile(path, data);
  return { status: collapseStatuses(changes), path };
}

function configureClaudeMcp(ctx: SetupContext): JsonResult {
  const path = join(homedir(), ".claude.json");
  const data = readJsonFile(path, {});
  const mcpServers = ensureObject(data, "mcpServers", path);
  const desired = {
    command: ctx.tsxPath,
    args: [ctx.mcpServerPath],
  };

  const current = mcpServers.unimind;
  if (deepEqual(current, desired)) {
    writeJsonFile(path, data);
    return { status: "unchanged", path };
  }

  mcpServers.unimind = desired;
  data.mcpServers = mcpServers;
  writeJsonFile(path, data);
  return { status: current ? "updated" : "added", path };
}

function configureCodexHooks(ctx: SetupContext): JsonResult {
  const path = join(homedir(), ".codex", "hooks.json");
  mkdirSync(join(homedir(), ".codex"), { recursive: true });
  const data = readJsonFile(path, {});
  const hooks = ensureObject(data, "hooks", path);
  const changes: MergeStatus[] = [];

  changes.push(mergeHookEntry(
    hooks,
    "UserPromptSubmit",
    "src/hooks/inject.ts",
    {
      hooks: [
        {
          type: "command",
          command: hookCommand(ctx.tsxPath, ctx.injectPath),
          timeout: 30,
        },
      ],
    },
  ));

  changes.push(mergeHookEntry(
    hooks,
    "PostToolUse",
    "src/hooks/capture.ts",
    {
      matcher: "Edit|Write|Bash",
      hooks: [
        {
          type: "command",
          command: hookCommand(ctx.tsxPath, ctx.capturePath),
          timeout: 10,
        },
      ],
    },
  ));

  for (const eventName of ["Stop", "PreCompact"]) {
    changes.push(mergeHookEntry(
      hooks,
      eventName,
      "src/hooks/capture.ts",
      {
        hooks: [
          {
            type: "command",
            command: hookCommand(ctx.tsxPath, ctx.capturePath),
            timeout: 10,
          },
        ],
      },
    ));
  }

  data.hooks = hooks;
  writeJsonFile(path, data);
  return { status: collapseStatuses(changes), path };
}

function configureCodexMcp(ctx: SetupContext): JsonResult {
  const path = join(homedir(), ".codex", "config.toml");
  mkdirSync(join(homedir(), ".codex"), { recursive: true });
  const desiredBlock = [
    "[mcp_servers.unimind]",
    "enabled = true",
    `command = ${JSON.stringify(ctx.tsxPath)}`,
    `args = [${JSON.stringify(ctx.mcpServerPath)}]`,
    "",
  ].join("\n");

  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  const matches = [...existing.matchAll(/(^|\n)\[mcp_servers\.unimind\][\s\S]*?(?=\n\[|$)/g)];
  if (matches.length > 1) {
    throw new ManualActionError(`Codex config contains multiple [mcp_servers.unimind] blocks in ${path}.`, [
      `Please keep only one [mcp_servers.unimind] block in ${path}, then rerun setup.`,
    ]);
  }

  if (matches.length === 1) {
    const currentBlock = matches[0][0].trim();
    if (currentBlock === desiredBlock.trim()) {
      return { status: "unchanged", path };
    }
    const replaced = existing.replace(matches[0][0], `\n${desiredBlock}`);
    writeFileSync(path, ensureTrailingNewline(replaced));
    return { status: "updated", path };
  }

  const next = `${existing.trimEnd()}\n\n${desiredBlock}`.replace(/^\n+/, "");
  writeFileSync(path, ensureTrailingNewline(next));
  return { status: existing.trim() ? "added" : "added", path };
}

function mergeHookEntry(
  hooksRoot: Record<string, unknown>,
  eventName: string,
  targetSuffix: string,
  desired: Record<string, unknown>,
): MergeStatus {
  const current = Array.isArray(hooksRoot[eventName]) ? [...(hooksRoot[eventName] as unknown[])] : [];
  const matching = current.filter((entry) => hookEntryTargets(entry, targetSuffix));
  const others = current.filter((entry) => !hookEntryTargets(entry, targetSuffix));

  if (matching.length === 1 && deepEqual(matching[0], desired)) {
    hooksRoot[eventName] = current;
    return "unchanged";
  }

  hooksRoot[eventName] = [...others, desired];
  return matching.length === 0 ? "added" : "updated";
}

function hookEntryTargets(entry: unknown, targetSuffix: string): boolean {
  if (!entry || typeof entry !== "object") return false;
  const hooks = (entry as { hooks?: unknown[] }).hooks;
  if (!Array.isArray(hooks)) return false;
  return hooks.some((hook) => {
    if (!hook || typeof hook !== "object") return false;
    const command = String((hook as { command?: unknown }).command ?? "");
    return command.includes(targetSuffix);
  });
}

function hookCommand(tsxPath: string, scriptPath: string): string {
  return `${shellQuote(tsxPath)} ${shellQuote(scriptPath)}`;
}

function shellQuote(value: string): string {
  if (process.platform === "win32") {
    return `"${value.replace(/"/g, '\\"')}"`;
  }
  return `"${value.replace(/(["\\$`])/g, "\\$1")}"`;
}

function ensureDockerStack(ctx: SetupContext): StackReport {
  const initialServices = collectComposeStatuses(ctx.repoRoot);
  const initialProbes = collectProbes();

  if (isStackHealthy(initialServices, initialProbes)) {
    return { action: "unchanged", services: initialServices, probes: initialProbes };
  }

  log("Docker stack is missing or unhealthy. Running `docker compose up -d --build`...");
  runStreamingCommand("docker", ["compose", "up", "-d", "--build"], ctx.repoRoot, "Docker compose up failed.");

  return waitForHealthyStack(ctx.repoRoot);
}

function waitForHealthyStack(repoRoot: string): StackReport {
  const deadline = Date.now() + 5 * 60_000;
  let lastServices = collectComposeStatuses(repoRoot);
  let lastProbes = collectProbes();

  while (Date.now() < deadline) {
    lastServices = collectComposeStatuses(repoRoot);
    lastProbes = collectProbes();
    if (isStackHealthy(lastServices, lastProbes)) {
      return { action: "repaired", services: lastServices, probes: lastProbes };
    }
    sleepSync(5_000);
  }

  throw new ManualActionError("Docker services did not become healthy in time.", [
    "Run `docker compose ps --all` from the repo root and inspect the service states.",
    "Run `docker compose logs --tail=200` from the repo root to inspect recent failures.",
    "When the services are corrected, rerun `/dev-setup` to continue the checks.",
  ]);
}

function collectComposeStatuses(repoRoot: string): ComposeServiceStatus[] {
  const services = listComposeServices(repoRoot);
  return services.map((service) => inspectComposeService(repoRoot, service));
}

function listComposeServices(repoRoot: string): string[] {
  const result = captureCommand("docker", ["compose", "config", "--services"], repoRoot);
  if (!result.ok) {
    throw new ManualActionError("Could not list Docker Compose services.", [
      "Run `docker compose config --services` from the repo root and fix any reported errors.",
    ]);
  }
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function inspectComposeService(repoRoot: string, service: string): ComposeServiceStatus {
  const result = captureCommand("docker", ["compose", "ps", "--all", service, "--format", "json"], repoRoot);
  if (!result.ok) {
    return { service, state: "unknown", status: "docker compose ps failed", exitCode: null, raw: {} };
  }
  const entry = parseComposeJson(result.stdout)[0] ?? {};
  const state = String(entry.State ?? entry.state ?? "").trim().toLowerCase();
  const status = String(entry.Status ?? entry.status ?? "").trim();
  const exitCodeRaw = entry.ExitCode ?? entry.exitCode;
  const exitCode = typeof exitCodeRaw === "number" ? exitCodeRaw : Number.isFinite(Number(exitCodeRaw)) ? Number(exitCodeRaw) : null;
  return {
    service,
    state,
    status,
    exitCode,
    raw: entry,
  };
}

function parseComposeJson(raw: string): Array<Record<string, unknown>> {
  const text = raw.trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.filter((item): item is Record<string, unknown> => !!item && typeof item === "object");
    }
    if (parsed && typeof parsed === "object") {
      return [parsed as Record<string, unknown>];
    }
  } catch {
    // Fall back to NDJSON.
  }
  return text
    .split(/\r?\n/)
    .map((line) => {
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .filter((item): item is Record<string, unknown> => item !== null);
}

function collectProbes(): ProbeResult[] {
  return [
    probeHttp("helix", "http://localhost:6969/v1/query", (status) => status > 0),
    probeHttp("iii", "http://127.0.0.1:3111/", (status) => status > 0),
    probeHttp("worker", "http://localhost:48180/health", (status) => status === 200),
    probeHttp("dashboard", "http://localhost:48173/dashboard", (status) => status === 200),
  ];
}

function probeHttp(name: string, url: string, success: (status: number) => boolean): ProbeResult {
  const result = spawnSync("node", [
    "-e",
    `fetch(${JSON.stringify(url)}, { signal: AbortSignal.timeout(4000) }).then(async (res) => {
      console.log(JSON.stringify({ ok: true, status: res.status, detail: await res.text().then((v) => v.slice(0, 120)).catch(() => "") }));
    }).catch((err) => {
      console.log(JSON.stringify({ ok: false, status: null, detail: err?.message ?? String(err) }));
    });`,
  ], { encoding: "utf8" });

  const payloadText = result.stdout.trim() || result.stderr.trim();
  try {
    const payload = JSON.parse(payloadText) as { ok: boolean; status: number | null; detail: string };
    return {
      name,
      url,
      ok: payload.status !== null && success(payload.status),
      status: payload.status,
      detail: payload.detail,
    };
  } catch {
    return {
      name,
      url,
      ok: false,
      status: null,
      detail: payloadText || "request failed",
    };
  }
}

function isStackHealthy(services: ComposeServiceStatus[], probes: ProbeResult[]): boolean {
  const serviceMap = new Map(services.map((service) => [service.service, service]));
  const longRunningOk = LONG_RUNNING_SERVICES.every((name) => {
    const current = serviceMap.get(name);
    if (!current) return false;
    return current.state === "running" || current.status.toLowerCase().startsWith("running");
  });

  const oneShot = serviceMap.get(ONE_SHOT_SERVICE);
  const oneShotOk = !!oneShot && (
    (oneShot.state === "exited" && oneShot.exitCode === 0) ||
    /\bexited\s*\(0\)\b/i.test(oneShot.status) ||
    /\bcompleted\b/i.test(oneShot.status)
  );

  return longRunningOk && oneShotOk && probes.every((probe) => probe.ok);
}

function openDashboard(url: string): boolean {
  const commands: Array<[string, string[]]> =
    process.platform === "darwin"
      ? [["open", [url]]]
      : process.platform === "win32"
        ? [["cmd", ["/c", "start", "", url]]]
        : [["xdg-open", [url]]];

  for (const [command, args] of commands) {
    const result = spawnSync(command, args, { stdio: "ignore" });
    if (result.status === 0) return true;
  }
  return false;
}

function printSuccess(
  ctx: SetupContext,
  prereqs: PrereqReport,
  configureReport: ConfigureReport,
  stackReport: StackReport,
  openedDashboard: boolean,
): void {
  console.log("");
  console.log("UniMind local setup is green.");
  console.log("");
  console.log("Prerequisites:");
  console.log(`- Docker: ${prereqs.docker.summary}`);
  console.log(`- Node: ${prereqs.node.summary}`);
  console.log(`- Helix: ${prereqs.helix.summary}`);
  console.log(`- iii: ${prereqs.iii.summary}`);
  console.log(`- OPENAI_API_KEY: ${prereqs.openAiKey.summary}`);
  console.log("");
  console.log("Assistants:");
  console.log(`- Claude: ${renderResult(configureReport.claudeHooks)} hooks, ${renderResult(configureReport.claudeMcp)} MCP`);
  console.log(`- Codex: ${renderResult(configureReport.codexHooks)} hooks, ${renderResult(configureReport.codexMcp)} MCP`);
  console.log("");
  console.log(`Docker stack: ${stackReport.action}`);
  for (const service of stackReport.services) {
    console.log(`- ${service.service}: ${service.status || service.state || "unknown"}`);
  }
  console.log("");
  console.log("Direct probes:");
  for (const probe of stackReport.probes) {
    console.log(`- ${probe.name}: ${probe.ok ? "green" : "red"} (${probe.status ?? "no response"}) ${probe.url}`);
  }
  console.log("");
  if (openedDashboard) {
    console.log("Dashboard opened at http://localhost:48173/dashboard");
  } else {
    console.log("Dashboard is ready at http://localhost:48173/dashboard");
    console.log("Automatic browser open was skipped or failed, so open it manually if needed.");
  }
  console.log("Optional iii console: run `iii console` from any folder, then open http://127.0.0.1:3113/");
  console.log(`State file cleaned up: ${ctx.statePath}`);
}

function renderResult(result: JsonResult): string {
  return result.status;
}

function collapseStatuses(statuses: MergeStatus[]): ChangeStatus {
  if (statuses.includes("updated")) return "updated";
  if (statuses.includes("added")) return "added";
  return "unchanged";
}

function readJsonFile(path: string, fallback: Record<string, unknown>): Record<string, unknown> {
  if (!existsSync(path)) return structuredClone(fallback);
  try {
    const data = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new Error("root JSON value must be an object");
    }
    return data as Record<string, unknown>;
  } catch (error) {
    throw new ManualActionError(`Could not parse JSON file ${path}.`, [
      `Please fix the JSON syntax in ${path}, then rerun setup.`,
      `Parse error: ${(error as Error).message}`,
    ]);
  }
}

function ensureObject(
  root: Record<string, unknown>,
  key: string,
  path: string,
): Record<string, unknown> {
  const current = root[key];
  if (current === undefined) {
    const next: Record<string, unknown> = {};
    root[key] = next;
    return next;
  }
  if (!current || typeof current !== "object" || Array.isArray(current)) {
    throw new ManualActionError(`Expected ${key} to be an object in ${path}.`, [
      `Please change ${key} in ${path} to a JSON object, then rerun setup.`,
    ]);
  }
  return current as Record<string, unknown>;
}

function writeJsonFile(path: string, data: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
}

function captureCommand(command: string, args: string[], cwd?: string): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: process.env,
  });
  return {
    ok: result.status === 0,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function runStreamingCommand(command: string, args: string[], cwd: string, failureMessage: string): void {
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    env: process.env,
  });
  if (result.status !== 0) {
    throw new ManualActionError(failureMessage, [
      `Command failed: ${command} ${args.join(" ")}`,
      `Fix the command failure, then rerun setup from ${cwd}.`,
    ]);
  }
}

function commandExists(command: string): boolean {
  const probe =
    process.platform === "win32"
      ? spawnSync("where", [command], { stdio: "ignore" })
      : spawnSync("which", [command], { stdio: "ignore" });
  return probe.status === 0;
}

function parseNodeMajor(versionText: string): number | null {
  const match = versionText.trim().match(/^v?(\d+)/);
  return match ? Number(match[1]) : null;
}

function trimOneLine(value: string): string {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) ?? "";
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function ensureTrailingNewline(value: string): string {
  return value.endsWith("\n") ? value : `${value}\n`;
}

function log(message: string): void {
  console.log(`[dev-setup] ${message}`);
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

try {
  main();
} catch (error) {
  if (error instanceof ManualActionError) {
    console.error("");
    console.error(`dev-setup stopped: ${error.message}`);
    console.error("");
    for (const line of error.instructions) {
      console.error(line);
    }
    process.exit(1);
  }
  console.error(error);
  process.exit(1);
}
