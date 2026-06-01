const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");
const { AgentRuntimeManager } = require("../src/agent/opencodeRuntimeManager");

async function withTempWorkspace(callback) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tantalum-opencode-smoke-"));
  const workspaceRoot = path.join(root, "workspace");
  const userDataRoot = path.join(root, "user-data");
  await fs.mkdir(workspaceRoot, { recursive: true });
  await fs.mkdir(userDataRoot, { recursive: true });
  await fs.writeFile(path.join(workspaceRoot, "README.md"), "# Smoke Workspace\n\nUsed by the opencode runtime smoke test.\n", "utf8");

  try {
    return await callback({ root, workspaceRoot, userDataRoot });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

function createManager({ workspaceRoot, userDataRoot, executeGatewayRequest, events }) {
  return new AgentRuntimeManager({
    app: {
      getPath(name) {
        return name === "userData" ? userDataRoot : os.tmpdir();
      },
    },
    getWorkspaceRoot: () => workspaceRoot,
    executeGatewayRequest,
    securityManager: {
      resolveApproval: () => ({ ok: true }),
    },
    markWorkspaceDirty: () => `smoke-${Date.now()}`,
    addRecentFile: () => {},
    emitProgress: (event) => events.push(event),
  });
}

function fakeChatCompletion(content) {
  return {
    id: `chatcmpl-smoke-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: "tantalum-fast",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content,
        },
        finish_reason: "stop",
      },
    ],
  };
}

function workspaceFileContextItem(workspaceRoot, relativePath, content, overrides = {}) {
  return {
    kind: "file",
    path: path.join(workspaceRoot, relativePath),
    relativePath,
    name: path.basename(relativePath),
    content,
    source: "workspace",
    ...overrides,
  };
}

async function runNormalAskSmoke() {
  await withTempWorkspace(async ({ workspaceRoot, userDataRoot }) => {
    const events = [];
    const gatewayRequests = [];
    const manager = createManager({
      workspaceRoot,
      userDataRoot,
      events,
      executeGatewayRequest: async ({ request }) => {
        gatewayRequests.push(request);
        assert.equal(request.stream, false);
        assert.equal(request.stream_options, undefined);
        assert.equal(request.streamOptions, undefined);
        return fakeChatCompletion("Smoke response from fake gateway.");
      },
    });

    const result = await manager.run({
      prompt: "explain this project space structure",
      source: "managed",
      mode: "fast",
      intent: "agent",
      threadId: "smoke-normal",
    });

    assert.match(result.output, /Smoke response/i);
    assert.equal(result.changedFiles.length, 0);
    assert.ok(
      events.some((event) => event.activity?.title === "Model request started"),
      "expected model bridge activity to be emitted",
    );
    assert.ok(
      events.some((event) => event.activity?.title === "Watching opencode activity"),
      "expected opencode event watcher activity to be emitted",
    );
    assert.ok(gatewayRequests.length > 0, "expected opencode to call the local model bridge");
    const requestText = gatewayRequests.map((request) => JSON.stringify(request)).join("\n");
    assert.match(requestText, /concise, direct, normal English/, "expected opencode prompt to include the local compact output fallback");
    assert.doesNotMatch(requestText, /caveman/i, "opencode prompt must not expose the legacy output style name");
  });
}

async function runPowerDirectModeSmoke() {
  for (const incomingMode of ["power", "plan"]) {
    await withTempWorkspace(async ({ workspaceRoot, userDataRoot }) => {
      const events = [];
      const gatewayCalls = [];
      const manager = createManager({
        workspaceRoot,
        userDataRoot,
        events,
        executeGatewayRequest: async (call) => {
          gatewayCalls.push(call);
          return fakeChatCompletion(`Power response for ${incomingMode}.`);
        },
      });

      const result = await manager.run({
        prompt: "what is two plus two?",
        source: "managed",
        mode: incomingMode,
        intent: "agent",
        threadId: `smoke-power-direct-${incomingMode}`,
      });

      assert.match(result.output, /Power response/);
      assert.equal(gatewayCalls.length, 1);
      assert.equal(gatewayCalls[0].mode, "power");
      assert.equal(gatewayCalls[0].request.model, "openai/tantalum-power");
      assert.equal(Object.prototype.hasOwnProperty.call(gatewayCalls[0].request, "temperature"), false);
    });
  }
}

async function runHangingGatewaySmoke() {
  const previousInactivity = process.env.TANTALUM_OPENCODE_INACTIVITY_TIMEOUT_MS;
  const previousPromptTimeout = process.env.TANTALUM_OPENCODE_PROMPT_TIMEOUT_MS;
  process.env.TANTALUM_OPENCODE_INACTIVITY_TIMEOUT_MS = "1500";
  process.env.TANTALUM_OPENCODE_PROMPT_TIMEOUT_MS = "6000";

  try {
    await withTempWorkspace(async ({ workspaceRoot, userDataRoot }) => {
      const events = [];
      const manager = createManager({
        workspaceRoot,
        userDataRoot,
        events,
        executeGatewayRequest: async () => new Promise(() => {}),
      });

      let thrown = null;
      try {
        await Promise.race([
          manager.run({
            prompt: "explain this project space structure",
            source: "managed",
            mode: "fast",
            intent: "agent",
            threadId: "smoke-hang",
          }),
          new Promise((_, reject) => setTimeout(() => reject(new Error("Smoke hang test exceeded 12 seconds.")), 12000)),
        ]);
      } catch (error) {
        thrown = error;
      }

      assert.ok(thrown, "expected the hanging gateway run to fail");
      assert.match(String(thrown.message || thrown), /did not report progress|runtime limit|aborted|terminated/i);
      assert.ok(
        events.some((event) => event.activity?.title === "No opencode activity" || event.activity?.title === "opencode timed out"),
        "expected a visible timeout activity entry",
      );
    });
  } finally {
    if (previousInactivity === undefined) {
      delete process.env.TANTALUM_OPENCODE_INACTIVITY_TIMEOUT_MS;
    } else {
      process.env.TANTALUM_OPENCODE_INACTIVITY_TIMEOUT_MS = previousInactivity;
    }

    if (previousPromptTimeout === undefined) {
      delete process.env.TANTALUM_OPENCODE_PROMPT_TIMEOUT_MS;
    } else {
      process.env.TANTALUM_OPENCODE_PROMPT_TIMEOUT_MS = previousPromptTimeout;
    }
  }
}

async function runRenameExtensionSmoke() {
  await withTempWorkspace(async ({ workspaceRoot, userDataRoot }) => {
    const sourcePath = path.join(workspaceRoot, "blink.c");
    await fs.writeFile(
      sourcePath,
      "#define LED_BUILTIN 2\n\nvoid setup() {}\n\nvoid loop() {}\n",
      "utf8",
    );

    const events = [];
    const manager = createManager({
      workspaceRoot,
      userDataRoot,
      events,
      executeGatewayRequest: async () => {
        throw new Error("Extension rename smoke should not call the model gateway.");
      },
    });

    const result = await manager.run({
      prompt: "change file type to ino instead of c",
      source: "managed",
      mode: "fast",
      intent: "agent",
      threadId: "smoke-rename",
      activeTab: {
        path: sourcePath,
        name: "blink.c",
        content: "#define LED_BUILTIN 2\n\nvoid setup() {}\n\nvoid loop() {}\n",
        isDirty: false,
      },
    });

    assert.equal(await fileExists(sourcePath), false);
    assert.equal(await fileExists(path.join(workspaceRoot, "blink.ino")), true);
    assert.equal(result.reviewMode, "live-applied");
    assert.ok(result.changedFiles.some((file) => file.path === "blink.c" && file.changeType === "delete"));
    assert.ok(result.changedFiles.some((file) => file.path === "blink.ino" && file.changeType === "create"));
  });
}

async function runRenameAndUpdateSmoke() {
  await withTempWorkspace(async ({ workspaceRoot, userDataRoot }) => {
    const sourcePath = path.join(workspaceRoot, "blink.c");
    await fs.writeFile(sourcePath, "void setup() {}\n\nvoid loop() {}\n", "utf8");

    let gatewayCalls = 0;
    const events = [];
    const manager = createManager({
      workspaceRoot,
      userDataRoot,
      events,
      executeGatewayRequest: async () => {
        gatewayCalls += 1;
        return fakeChatCompletion("Reviewed the converted sketch.");
      },
    });

    const result = await manager.run({
      prompt: "change c file to ino and update the code",
      source: "managed",
      mode: "fast",
      intent: "agent",
      threadId: "smoke-rename-update",
    });

    assert.ok(gatewayCalls > 0, "expected the update-code task to call opencode");
    assert.equal(await fileExists(sourcePath), false);
    assert.equal(await fileExists(path.join(workspaceRoot, "blink.ino")), true);
    assert.ok(result.changedFiles.some((file) => file.path === "blink.c" && file.changeType === "delete"));
    assert.ok(result.changedFiles.some((file) => file.path === "blink.ino" && file.changeType === "create"));
    assert.ok(result.taskList.items.some((item) => item.kind === "rename_file" && item.status === "completed"));
    assert.ok(result.taskList.items.some((item) => item.kind === "opencode_edit" && item.status === "completed"));
  });
}

async function runTypoArticleRouteSmoke() {
  await withTempWorkspace(async ({ workspaceRoot, userDataRoot }) => {
    await fs.writeFile(path.join(workspaceRoot, "blink.c"), "void setup() {}\n", "utf8");
    await fs.writeFile(path.join(workspaceRoot, "blink.ino"), "void setup() {}\n", "utf8");

    const events = [];
    const manager = createManager({
      workspaceRoot,
      userDataRoot,
      events,
      executeGatewayRequest: async () => fakeChatCompletion("unused"),
    });

    const route = await manager.route({
      prompt:
        "delete tha blink c file and create a ino file for arduino uno board motor control. then rename the current blink ino file as ledblink",
      source: "managed",
      mode: "fast",
      intent: "agent",
      threadId: "smoke-typo-route",
    });

    const deleteTask = route.taskList.items.find((item) => item.kind === "delete_file");
    assert.ok(deleteTask, "expected a delete task");
    assert.equal(deleteTask.targetPath, "blink.c");
    assert.equal(deleteTask.title, "Delete blink.c");
    assert.notEqual(deleteTask.targetPath, "thablink.c");
    assert.notEqual(deleteTask.status, "blocked");

    const createTask = route.taskList.items.find((item) => item.title === "Create .ino file");
    assert.ok(createTask, "expected a generic .ino create/edit task");
    assert.equal(createTask.kind, "opencode_edit");
    assert.equal(createTask.targetPath, undefined);

    const renameTask = route.taskList.items.find((item) => item.kind === "rename_file");
    assert.ok(renameTask, "expected a rename task");
    assert.equal(renameTask.targetPath, "blink.ino");
    assert.equal(renameTask.newPath, "ledblink.ino");
    assert.equal(renameTask.title, "Rename blink.ino to ledblink.ino");
    assert.notEqual(renameTask.status, "blocked");
  });
}

async function runTypoCommandVerbRouteSmoke() {
  await withTempWorkspace(async ({ workspaceRoot, userDataRoot }) => {
    await fs.mkdir(path.join(workspaceRoot, "sketches"), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, "sketches", "tof_sensor.ino"), "void setup() {}\n", "utf8");
    await fs.writeFile(path.join(workspaceRoot, "blink.ino"), "void setup() {}\n", "utf8");
    await fs.writeFile(path.join(workspaceRoot, "motor.ino"), "void loop() {}\n", "utf8");

    const events = [];
    const manager = createManager({
      workspaceRoot,
      userDataRoot,
      events,
      executeGatewayRequest: async () => fakeChatCompletion("not-json"),
    });

    const deleteRun = await manager.run({
      prompt: "deelete the tof sensor sketch file",
      source: "managed",
      mode: "fast",
      intent: "agent",
      threadId: "smoke-typo-command-delete-run",
    });
    assert.equal(deleteRun.requiresApproval, true);
    assert.doesNotMatch(deleteRun.output, /\b(del|rm)\b|command prompt|powershell|terminal/i);
    const deleteTask = deleteRun.taskList.items.find((item) => item.kind === "delete_file");
    assert.ok(deleteTask, "expected typo delete to create a delete task");
    assert.equal(deleteTask.targetPath, "sketches/tof_sensor.ino");

    const leadingNounDeleteRoute = await manager.route({
      prompt: "deeelete the file sensor sketch file",
      source: "managed",
      mode: "fast",
      intent: "agent",
      threadId: "smoke-typo-command-delete-leading-noun",
    });
    assert.equal(leadingNounDeleteRoute.engine, "opencode_edit");
    assert.equal(leadingNounDeleteRoute.requiresUserDecision, true);
    assert.doesNotMatch(leadingNounDeleteRoute.userMessage, /\b(del|rm)\b|command prompt|powershell|terminal/i);
    const leadingNounDeleteTask = leadingNounDeleteRoute.taskList.items.find((item) => item.kind === "delete_file");
    assert.ok(leadingNounDeleteTask, "expected typo delete with a leading file noun to create a delete task");
    assert.equal(leadingNounDeleteTask.targetPath, "sketches/tof_sensor.ino");
    assert.notEqual(leadingNounDeleteTask.targetPath, "filesensor.ino");

    const createRoute = await manager.route({
      prompt: "creat esp32 blink sketch",
      source: "managed",
      mode: "fast",
      intent: "agent",
      threadId: "smoke-typo-command-create",
    });
    const createTask = createRoute.taskList.items.find((item) => item.kind === "create_file");
    assert.ok(createTask, "expected typo create to create a file task");
    assert.equal(createTask.targetPath, "esp32_blink.ino");

    const moveRoute = await manager.route({
      prompt: "mov all ino files to sketches",
      source: "managed",
      mode: "fast",
      intent: "agent",
      threadId: "smoke-typo-command-move",
    });
    const moveTasks = moveRoute.taskList.items.filter((item) => item.kind === "move_file");
    assert.deepEqual(
      moveTasks.map((item) => [item.targetPath, item.newPath]).sort(),
      [
        ["blink.ino", "sketches/blink.ino"],
        ["motor.ino", "sketches/motor.ino"],
      ],
    );

    const renameRoute = await manager.route({
      prompt: "renmae blink.ino to ledblink.ino",
      source: "managed",
      mode: "fast",
      intent: "agent",
      threadId: "smoke-typo-command-rename",
    });
    const renameTask = renameRoute.taskList.items.find((item) => item.kind === "rename_file");
    assert.ok(renameTask, "expected typo rename to create a rename task");
    assert.equal(renameTask.targetPath, "blink.ino");
    assert.equal(renameTask.newPath, "ledblink.ino");

    const updateRoute = await manager.route({
      prompt: "udpate the motor sketch",
      source: "managed",
      mode: "fast",
      intent: "agent",
      threadId: "smoke-typo-command-update",
    });
    const updateTask = updateRoute.taskList.items.find((item) => item.kind === "opencode_edit");
    assert.ok(updateTask, "expected typo update to create an edit task");
    assert.equal(updateTask.targetPath, "motor.ino");
  });
}

async function runTypoDeleteRetryUsesPreviousPromptSmoke() {
  await withTempWorkspace(async ({ workspaceRoot, userDataRoot }) => {
    const activePath = path.join(workspaceRoot, "dc_motor_control.ino");
    const tofPath = path.join(workspaceRoot, "sketches", "tof_sensor.ino");
    await fs.mkdir(path.dirname(tofPath), { recursive: true });
    await fs.writeFile(activePath, "void setup() {}\n", "utf8");
    await fs.writeFile(tofPath, "void setup() {}\n", "utf8");

    const events = [];
    let gatewayCalls = 0;
    const manager = createManager({
      workspaceRoot,
      userDataRoot,
      events,
      executeGatewayRequest: async () => {
        gatewayCalls += 1;
        if (gatewayCalls % 2 === 1) {
          return fakeChatCompletion(
            JSON.stringify({
              instruction: "",
              clarification: 'Which file do you mean by "sensor sketch file"? Please provide the exact file name or attach it.',
              riskLevel: "high",
              tasks: [],
            }),
          );
        }

        return fakeChatCompletion(
          JSON.stringify({
            intent: "workspace_edit",
            operation: "delete_file",
            targetPhrase: "sensor sketch file",
            destinationPhrase: "",
            candidatePath: "sketches/tof_sensor.ino",
            candidateSource: "workspace",
            confidence: 0.9,
            clarification: "",
          }),
        );
      },
    });
    const activeTab = {
      path: activePath,
      name: "dc_motor_control.ino",
      content: "void setup() {}\n",
      isDirty: false,
    };

    const initialRoute = await manager.route({
      prompt: "deeelete the file sensor sketch file",
      source: "managed",
      mode: "fast",
      intent: "agent",
      threadId: "smoke-typo-delete-active-tab",
      activeTab,
    });
    assert.equal(initialRoute.engine, "opencode_edit");
    const initialDeleteTask = initialRoute.taskList.items.find((item) => item.kind === "delete_file");
    assert.ok(initialDeleteTask, "expected active-tab typo delete to create a delete task");
    assert.equal(initialDeleteTask.targetPath, "sketches/tof_sensor.ino");
    assert.doesNotMatch(initialRoute.userMessage, /which file|currently open|command prompt|powershell|terminal|\b(del|rm)\b/i);

    const retryRoute = await manager.route({
      prompt: "try again",
      source: "managed",
      mode: "fast",
      intent: "agent",
      threadId: "smoke-typo-delete-retry",
      activeTab,
      threadMessages: [
        { role: "user", content: "deeelete the file sensor sketch file" },
        { role: "assistant", content: "No file named 'sensor sketch file' is attached or found." },
      ],
    });
    assert.equal(retryRoute.engine, "opencode_edit");
    assert.equal(retryRoute.requiresUserDecision, true);
    assert.equal(retryRoute.decisionKind, "approve_skip");
    assert.equal(retryRoute.pendingAction.originalPrompt, "deeelete the file sensor sketch file");
    assert.doesNotMatch(retryRoute.userMessage, /which file|currently open|command prompt|powershell|terminal|\b(del|rm)\b/i);
    const retryDeleteTask = retryRoute.taskList.items.find((item) => item.kind === "delete_file");
    assert.ok(retryDeleteTask, "expected retry to reuse the previous delete request");
    assert.equal(retryDeleteTask.targetPath, "sketches/tof_sensor.ino");

    const proceedRoute = await manager.route({
      prompt: "proceed",
      source: "managed",
      mode: "fast",
      intent: "agent",
      threadId: "smoke-typo-delete-retry-proceed",
      activeTab,
      pendingAction: retryRoute.pendingAction,
      taskList: retryRoute.taskList,
    });
    assert.equal(proceedRoute.engine, "opencode_edit");
    assert.equal(proceedRoute.reason, "approved_pending_action");
    assert.doesNotMatch(proceedRoute.userMessage || "", /nothing pending/i);
  });
}

async function runStandaloneRetryDoesNotUseDirectChatSmoke() {
  await withTempWorkspace(async ({ workspaceRoot, userDataRoot }) => {
    const activePath = path.join(workspaceRoot, "dc_motor_control.ino");
    await fs.writeFile(activePath, "void setup() {}\n", "utf8");

    const events = [];
    let gatewayCalls = 0;
    const manager = createManager({
      workspaceRoot,
      userDataRoot,
      events,
      executeGatewayRequest: async () => {
        gatewayCalls += 1;
        return fakeChatCompletion("This should not be used.");
      },
    });

    const result = await manager.run({
      prompt: "try again",
      source: "managed",
      mode: "fast",
      intent: "agent",
      threadId: "smoke-standalone-retry",
      activeTab: {
        path: activePath,
        name: "dc_motor_control.ino",
        content: "void setup() {}\n",
        isDirty: false,
      },
      threadMessages: [],
    });

    assert.equal(gatewayCalls, 0, "standalone retry should not call the lightweight chat model");
    assert.equal(result.engine, "local");
    assert.match(result.output, /previous project space request/i);
    assert.doesNotMatch(result.output, /running lightweight chat|command prompt|powershell|terminal|file explorer|\b(del|rm)\b/i);
  });
}

async function runApprovedTypoDeleteSketchSmoke() {
  await withTempWorkspace(async ({ workspaceRoot, userDataRoot }) => {
    const tofPath = path.join(workspaceRoot, "sketches", "tof_sensor.ino");
    await fs.mkdir(path.dirname(tofPath), { recursive: true });
    await fs.writeFile(tofPath, "void setup() {}\n", "utf8");

    const events = [];
    const manager = createManager({
      workspaceRoot,
      userDataRoot,
      events,
      executeGatewayRequest: async () => fakeChatCompletion("not-json"),
    });

    const route = await manager.route({
      prompt: "deelete the tof sensor sketch file",
      source: "managed",
      mode: "fast",
      intent: "agent",
      threadId: "smoke-approved-typo-delete-route",
    });

    const result = await manager.run({
      prompt: "proceed",
      source: "managed",
      mode: "fast",
      intent: "agent",
      threadId: "smoke-approved-typo-delete-run",
      pendingAction: route.pendingAction,
      approvedActionId: route.pendingAction.id,
      taskList: route.taskList,
    });

    assert.equal(await fileExists(tofPath), false);
    assert.ok(result.changedFiles.some((file) => file.path === "sketches/tof_sensor.ino" && file.changeType === "delete"));
    assert.ok(result.taskList.items.some((item) => item.kind === "delete_file" && item.status === "completed"));
  });
}

async function runTypoDeleteAmbiguousSketchSmoke() {
  await withTempWorkspace(async ({ workspaceRoot, userDataRoot }) => {
    await fs.mkdir(path.join(workspaceRoot, "sketches"), { recursive: true });
    await fs.mkdir(path.join(workspaceRoot, "backup"), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, "sketches", "tof_sensor.ino"), "void setup() {}\n", "utf8");
    await fs.writeFile(path.join(workspaceRoot, "backup", "tof_sensor.ino"), "void setup() {}\n", "utf8");

    const events = [];
    const manager = createManager({
      workspaceRoot,
      userDataRoot,
      events,
      executeGatewayRequest: async () => fakeChatCompletion("not-json"),
    });

    const route = await manager.route({
      prompt: "deelete the tof sensor sketch file",
      source: "managed",
      mode: "fast",
      intent: "agent",
      threadId: "smoke-typo-delete-ambiguous-sketch",
    });

    assert.equal(route.engine, "local");
    assert.equal(route.decisionKind, "clarify");
    assert.match(route.userMessage, /multiple files/i);
    assert.match(route.userMessage, /sketches\/tof_sensor\.ino/);
    assert.match(route.userMessage, /backup\/tof_sensor\.ino/);
    assert.doesNotMatch(route.userMessage, /\b(del|rm)\b|command prompt|powershell|terminal/i);
  });
}

async function runUncertainWorkspaceActionClassifierSmoke() {
  await withTempWorkspace(async ({ workspaceRoot, userDataRoot }) => {
    await fs.mkdir(path.join(workspaceRoot, "sketches"), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, "sketches", "tof_sensor.ino"), "void setup() {}\n", "utf8");

    const events = [];
    const classifierRequests = [];
    const manager = createManager({
      workspaceRoot,
      userDataRoot,
      events,
      executeGatewayRequest: async ({ request }) => {
        classifierRequests.push(request);
        return fakeChatCompletion(
          JSON.stringify({
            intent: "workspace_edit",
            operation: "delete_file",
            targetPhrase: "tof sensor sketch file",
            destinationPhrase: "",
            confidence: 0.91,
            clarification: "",
          }),
        );
      },
    });

    const route = await manager.route({
      prompt: "get rid of the tof sensor sketch file",
      source: "managed",
      mode: "fast",
      intent: "agent",
      threadId: "smoke-uncertain-classifier-delete",
    });

    assert.equal(classifierRequests.length, 1, "expected direct-chat fallback to call the classifier");
    assert.equal(route.engine, "opencode_edit");
    assert.equal(route.requiresUserDecision, true);
    assert.equal(route.decisionKind, "approve_skip");
    assert.doesNotMatch(route.userMessage, /\b(del|rm)\b|command prompt|powershell|terminal/i);
    const deleteTask = route.taskList.items.find((item) => item.kind === "delete_file");
    assert.ok(deleteTask, "expected classifier delete task");
    assert.equal(deleteTask.targetPath, "sketches/tof_sensor.ino");
  });
}

async function runUncertainWorkspaceActionClarificationSmoke() {
  await withTempWorkspace(async ({ workspaceRoot, userDataRoot }) => {
    await fs.mkdir(path.join(workspaceRoot, "sketches"), { recursive: true });
    await fs.mkdir(path.join(workspaceRoot, "backup"), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, "sketches", "tof_sensor.ino"), "void setup() {}\n", "utf8");
    await fs.writeFile(path.join(workspaceRoot, "backup", "tof_sensor.ino"), "void setup() {}\n", "utf8");

    const events = [];
    const manager = createManager({
      workspaceRoot,
      userDataRoot,
      events,
      executeGatewayRequest: async () =>
        fakeChatCompletion(
          JSON.stringify({
            intent: "workspace_edit",
            operation: "delete_file",
            targetPhrase: "tof sensor sketch file",
            destinationPhrase: "",
            confidence: 0.9,
            clarification: "",
          }),
        ),
    });

    const route = await manager.route({
      prompt: "get rid of the tof sensor sketch file",
      source: "managed",
      mode: "fast",
      intent: "agent",
      threadId: "smoke-uncertain-classifier-ambiguous-delete",
    });

    assert.equal(route.engine, "local");
    assert.equal(route.decisionKind, "clarify");
    assert.match(route.userMessage, /multiple files/i);
    assert.match(route.userMessage, /sketches\/tof_sensor\.ino/);
    assert.match(route.userMessage, /backup\/tof_sensor\.ino/);
    assert.doesNotMatch(route.userMessage, /\b(del|rm)\b|command prompt|powershell|terminal/i);
  });
}

async function runUncertainWorkspaceActionLowConfidenceSmoke() {
  await withTempWorkspace(async ({ workspaceRoot, userDataRoot }) => {
    const events = [];
    const manager = createManager({
      workspaceRoot,
      userDataRoot,
      events,
      executeGatewayRequest: async () =>
        fakeChatCompletion(
          JSON.stringify({
            intent: "clarify",
            operation: "none",
            targetPhrase: "",
            destinationPhrase: "",
            confidence: 0.42,
            clarification: "Which file should I change?",
          }),
        ),
    });

    const route = await manager.route({
      prompt: "trash the sketch file",
      source: "managed",
      mode: "fast",
      intent: "agent",
      threadId: "smoke-uncertain-classifier-low-confidence",
    });

    assert.equal(route.engine, "local");
    assert.equal(route.decisionKind, "clarify");
    assert.match(route.userMessage, /Which file/i);
    assert.doesNotMatch(route.userMessage, /\b(del|rm)\b|command prompt|powershell|terminal/i);
  });
}

async function runActionRepairMoveIntentSmoke() {
  await withTempWorkspace(async ({ workspaceRoot, userDataRoot }) => {
    await fs.writeFile(path.join(workspaceRoot, "blink.ino"), "void setup() {}\n", "utf8");
    await fs.writeFile(path.join(workspaceRoot, "motor.ino"), "void loop() {}\n", "utf8");

    const events = [];
    const classifierRequests = [];
    const manager = createManager({
      workspaceRoot,
      userDataRoot,
      events,
      executeGatewayRequest: async ({ request }) => {
        classifierRequests.push(request);
        return fakeChatCompletion(
          JSON.stringify({
            intent: "workspace_edit",
            operation: "move_file",
            targetPhrase: "all ino files",
            destinationPhrase: "sketches",
            candidatePath: "",
            candidateSource: "none",
            confidence: 0.91,
            clarification: "",
          }),
        );
      },
    });

    const route = await manager.route({
      prompt: "put all ino into sketches",
      source: "managed",
      mode: "fast",
      intent: "agent",
      threadId: "smoke-action-repair-move-intent",
    });

    assert.equal(classifierRequests.length, 1, "expected direct inference repair for put/place move wording");
    assert.equal(route.engine, "opencode_edit");
    assert.equal(route.requiresUserDecision, true);
    const moveTasks = route.taskList.items.filter((item) => item.kind === "move_file");
    assert.deepEqual(
      moveTasks.map((item) => [item.targetPath, item.newPath]).sort(),
      [
        ["blink.ino", "sketches/blink.ino"],
        ["motor.ino", "sketches/motor.ino"],
      ],
    );
    assert.doesNotMatch(route.userMessage, /\b(del|rm)\b|command prompt|powershell|terminal|file explorer/i);
  });
}

async function runFastIntentRouterCreateProjectStructureSmoke() {
  await withTempWorkspace(async ({ workspaceRoot, userDataRoot }) => {
    const events = [];
    const classifierRequests = [];
    const manager = createManager({
      workspaceRoot,
      userDataRoot,
      events,
      executeGatewayRequest: async ({ request }) => {
        classifierRequests.push(request);
        return fakeChatCompletion(
          JSON.stringify({
            intent: "workspace_edit",
            operation: "create_file",
            targetPhrase: "agent md file with project strucure",
            destinationPhrase: "",
            candidatePath: "",
            candidateSource: "prompt",
            confidence: 0.93,
            clarification: "",
          }),
        );
      },
    });

    const route = await manager.route({
      prompt: "creeeeeate a agent md file with project strucure",
      source: "managed",
      mode: "fast",
      intent: "agent",
      threadId: "smoke-fast-intent-router-project-structure",
    });

    assert.equal(classifierRequests.length, 1, "expected fast intent router before direct inference");
    assert.equal(route.engine, "opencode_edit");
    assert.equal(route.reason, "fast_intent_router");
    assert.equal(route.requiresUserDecision, false);
    const structureTask = route.taskList.items.find((item) => item.kind === "create_project_structure_doc");
    assert.ok(structureTask, "expected project-structure document task");
    assert.equal(structureTask.targetPath, "agent.md");

    const result = await manager.run({
      prompt: "creeeeeate a agent md file with project strucure",
      source: "managed",
      mode: "fast",
      intent: "agent",
      threadId: "smoke-fast-intent-router-project-structure-run",
    });

    assert.equal(classifierRequests.length, 2, "expected fast intent router during route and run");
    assert.equal(result.requiresApproval, false);
    assert.ok(result.changedFiles.some((file) => file.path === "agent.md" && file.changeType === "create"));
    assert.match(await fs.readFile(path.join(workspaceRoot, "agent.md"), "utf8"), /# Project Structure/);
  });
}

async function runFastIntentRouterQuestionSmoke() {
  await withTempWorkspace(async ({ workspaceRoot, userDataRoot }) => {
    const events = [];
    const classifierRequests = [];
    const manager = createManager({
      workspaceRoot,
      userDataRoot,
      events,
      executeGatewayRequest: async ({ request }) => {
        classifierRequests.push(request);
        return fakeChatCompletion(
          JSON.stringify({
            intent: "workspace_question",
            operation: "none",
            targetPhrase: "agent md file",
            destinationPhrase: "",
            candidatePath: "",
            candidateSource: "none",
            confidence: 0.9,
            clarification: "",
          }),
        );
      },
    });

    const route = await manager.route({
      prompt: "is agent md a file",
      source: "managed",
      mode: "fast",
      intent: "agent",
      threadId: "smoke-fast-intent-router-question",
    });

    assert.equal(classifierRequests.length, 1, "expected project-space-like direct prompt to use the fast intent router");
    assert.equal(route.engine, "direct_llm");
    assert.equal(route.requiresUserDecision, false);
    assert.equal(route.taskList, undefined);

    const plainQuestionRoute = await manager.route({
      prompt: "what is two plus two?",
      source: "managed",
      mode: "fast",
      intent: "agent",
      threadId: "smoke-fast-intent-router-plain-question",
    });

    assert.equal(classifierRequests.length, 1, "expected plain non-project-space question to skip the fast intent router");
    assert.equal(plainQuestionRoute.engine, "direct_llm");
  });
}

async function runFastIntentRouterLowConfidenceSmoke() {
  await withTempWorkspace(async ({ workspaceRoot, userDataRoot }) => {
    const events = [];
    const classifierRequests = [];
    const manager = createManager({
      workspaceRoot,
      userDataRoot,
      events,
      executeGatewayRequest: async ({ request }) => {
        classifierRequests.push(request);
        return fakeChatCompletion(
          JSON.stringify({
            intent: "clarify",
            operation: "none",
            targetPhrase: "agent md file project strucure",
            destinationPhrase: "",
            candidatePath: "",
            candidateSource: "none",
            confidence: 0.48,
            clarification: "Do you want me to create agent.md with the project structure, or are you asking what it should contain?",
          }),
        );
      },
    });

    const route = await manager.route({
      prompt: "agent md file project strucure",
      source: "managed",
      mode: "fast",
      intent: "agent",
      threadId: "smoke-fast-intent-router-low-confidence",
    });

    assert.equal(classifierRequests.length, 1, "expected low-confidence project-space-like prompt to use the fast intent router");
    assert.equal(route.engine, "local");
    assert.equal(route.decisionKind, "clarify");
    assert.match(route.userMessage, /create agent\.md/i);
    assert.equal(route.taskList, undefined);
  });
}

async function runReferentialFollowupSerialEditSmoke() {
  await withTempWorkspace(async ({ workspaceRoot, userDataRoot }) => {
    await fs.writeFile(path.join(workspaceRoot, "esp32_inbuild_rgb_to_light.ino"), "void setup() {\n  pinMode(48, OUTPUT);\n}\n", "utf8");

    const events = [];
    const classifierRequests = [];
    const manager = createManager({
      workspaceRoot,
      userDataRoot,
      events,
      executeGatewayRequest: async ({ request }) => {
        classifierRequests.push(request);
        return fakeChatCompletion(
          JSON.stringify({
            intent: "workspace_edit",
            operation: "edit_file",
            targetPhrase: "esp32_inbuild_rgb_to_light.ino",
            destinationPhrase: "",
            candidatePath: "esp32_inbuild_rgb_to_light.ino",
            candidateSource: "workspace",
            confidence: 0.94,
            clarification: "",
            instruction: "Add Serial.begin(115200) at the start of setup() and print a startup message with Serial.println().",
          }),
        );
      },
    });

    const route = await manager.route({
      prompt: "do all those",
      source: "managed",
      mode: "fast",
      intent: "agent",
      threadId: "smoke-referential-followup-serial-edit",
      threadMessages: [
        {
          role: "user",
          content: "I pushed esp32_inbuild_rgb_to_light.ino and got garbled serial text.",
        },
        {
          role: "assistant",
          content:
            "Add Serial.begin(115200) at the start of setup() in esp32_inbuild_rgb_to_light.ino and add Serial.println(\"ESP32 S3 RGB LED setup starting...\"); to confirm the sketch is running.",
        },
      ],
    });

    assert.equal(classifierRequests.length, 1, "expected referential follow-up classifier");
    assert.equal(route.engine, "opencode_edit");
    assert.equal(route.reason, "referential_followup");
    assert.equal(route.requiresUserDecision, false);
    const editTask = route.taskList.items.find((item) => item.kind === "opencode_edit");
    assert.ok(editTask, "expected referential follow-up edit task");
    assert.equal(editTask.targetPath, "esp32_inbuild_rgb_to_light.ino");
    assert.match(editTask.instruction, /Serial\.begin\(115200\)/);
    const requestText = JSON.stringify(classifierRequests[0]);
    assert.match(requestText, /referentialFollowup/);
    assert.match(requestText, /recentThreadMessages/);
  });
}

async function runReferentialFollowupNoActionClarificationSmoke() {
  await withTempWorkspace(async ({ workspaceRoot, userDataRoot }) => {
    const events = [];
    const classifierRequests = [];
    const manager = createManager({
      workspaceRoot,
      userDataRoot,
      events,
      executeGatewayRequest: async ({ request }) => {
        classifierRequests.push(request);
        return fakeChatCompletion(
          JSON.stringify({
            intent: "clarify",
            operation: "none",
            targetPhrase: "",
            destinationPhrase: "",
            candidatePath: "",
            candidateSource: "none",
            confidence: 0.42,
            clarification: "What project space change should I apply?",
            instruction: "",
          }),
        );
      },
    });

    const route = await manager.route({
      prompt: "do all those",
      source: "managed",
      mode: "fast",
      intent: "agent",
      threadId: "smoke-referential-followup-no-action",
      threadMessages: [
        { role: "user", content: "what is two plus two?" },
        { role: "assistant", content: "Two plus two is four." },
      ],
    });

    assert.equal(classifierRequests.length, 1, "expected referential follow-up classifier");
    assert.equal(route.engine, "local");
    assert.equal(route.decisionKind, "clarify");
    assert.match(route.userMessage, /project space change/i);
  });
}

async function runReferentialFollowupAmbiguousTargetSmoke() {
  await withTempWorkspace(async ({ workspaceRoot, userDataRoot }) => {
    await fs.writeFile(path.join(workspaceRoot, "first.ino"), "void setup() {}\n", "utf8");
    await fs.writeFile(path.join(workspaceRoot, "second.ino"), "void setup() {}\n", "utf8");

    const events = [];
    const manager = createManager({
      workspaceRoot,
      userDataRoot,
      events,
      executeGatewayRequest: async () =>
        fakeChatCompletion(
          JSON.stringify({
            intent: "clarify",
            operation: "edit_file",
            targetPhrase: "first.ino or second.ino",
            destinationPhrase: "",
            candidatePath: "",
            candidateSource: "none",
            confidence: 0.64,
            clarification: "Should I apply the serial setup change to first.ino or second.ino?",
            instruction: "Add Serial.begin(115200) in setup().",
          }),
        ),
    });

    const route = await manager.route({
      prompt: "do that",
      source: "managed",
      mode: "fast",
      intent: "agent",
      threadId: "smoke-referential-followup-ambiguous-target",
      threadMessages: [
        { role: "user", content: "which files need serial setup?" },
        { role: "assistant", content: "You could add Serial.begin(115200) to first.ino or second.ino." },
      ],
    });

    assert.equal(route.engine, "local");
    assert.equal(route.decisionKind, "clarify");
    assert.match(route.userMessage, /first\.ino or second\.ino/i);
  });
}

async function runReferentialFollowupDestructiveApprovalSmoke() {
  await withTempWorkspace(async ({ workspaceRoot, userDataRoot }) => {
    await fs.writeFile(path.join(workspaceRoot, "old_debug.ino"), "void setup() {}\n", "utf8");

    const events = [];
    const manager = createManager({
      workspaceRoot,
      userDataRoot,
      events,
      executeGatewayRequest: async () =>
        fakeChatCompletion(
          JSON.stringify({
            intent: "workspace_edit",
            operation: "delete_file",
            targetPhrase: "old_debug.ino",
            destinationPhrase: "",
            candidatePath: "old_debug.ino",
            candidateSource: "workspace",
            confidence: 0.91,
            clarification: "",
            instruction: "",
          }),
        ),
    });

    const route = await manager.route({
      prompt: "do that",
      source: "managed",
      mode: "fast",
      intent: "agent",
      threadId: "smoke-referential-followup-destructive",
      threadMessages: [
        { role: "user", content: "what should I clean up?" },
        { role: "assistant", content: "Delete old_debug.ino if you no longer need that debug sketch." },
      ],
    });

    assert.equal(route.engine, "opencode_edit");
    assert.equal(route.reason, "referential_followup");
    assert.equal(route.requiresUserDecision, true);
    assert.equal(route.decisionKind, "approve_skip");
    const deleteTask = route.taskList.items.find((item) => item.kind === "delete_file");
    assert.ok(deleteTask, "expected destructive follow-up delete task");
    assert.equal(deleteTask.targetPath, "old_debug.ino");
  });
}

async function runPlannerClarificationActionRepairSmoke() {
  await withTempWorkspace(async ({ workspaceRoot, userDataRoot }) => {
    await fs.mkdir(path.join(workspaceRoot, "sketches"), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, "sketches", "tof_sensor.ino"), "void setup() {}\n", "utf8");

    const events = [];
    let gatewayCalls = 0;
    const manager = createManager({
      workspaceRoot,
      userDataRoot,
      events,
      executeGatewayRequest: async () => {
        gatewayCalls += 1;
        if (gatewayCalls === 1) {
          return fakeChatCompletion(
            JSON.stringify({
              instruction: "",
              clarification: 'Which file do you mean by "mystery sketch"? Please provide the exact file name or attach it.',
              riskLevel: "high",
              tasks: [],
            }),
          );
        }

        return fakeChatCompletion(
          JSON.stringify({
            intent: "workspace_edit",
            operation: "delete_file",
            targetPhrase: "mystery sketch",
            destinationPhrase: "",
            candidatePath: "sketches/tof_sensor.ino",
            candidateSource: "workspace",
            confidence: 0.92,
            clarification: "",
          }),
        );
      },
    });

    const route = await manager.route({
      prompt: "delete the mystery sketch",
      source: "managed",
      mode: "fast",
      intent: "agent",
      threadId: "smoke-planner-clarification-action-repair",
    });

    assert.equal(gatewayCalls, 2, "expected planner clarification followed by structured action repair");
    assert.equal(route.engine, "opencode_edit");
    assert.equal(route.requiresUserDecision, true);
    assert.doesNotMatch(route.userMessage, /which file|command prompt|powershell|terminal|file explorer|\b(del|rm)\b/i);
    const deleteTask = route.taskList.items.find((item) => item.kind === "delete_file");
    assert.ok(deleteTask, "expected repaired delete task");
    assert.equal(deleteTask.targetPath, "sketches/tof_sensor.ino");
  });
}

async function runActiveEditorSuggestionActionRepairSmoke() {
  await withTempWorkspace(async ({ workspaceRoot, userDataRoot }) => {
    const activePath = path.join(workspaceRoot, "dc_motor_control.ino");
    await fs.writeFile(activePath, "void setup() {}\n", "utf8");

    const events = [];
    let gatewayCalls = 0;
    const manager = createManager({
      workspaceRoot,
      userDataRoot,
      events,
      executeGatewayRequest: async () => {
        gatewayCalls += 1;
        if (gatewayCalls === 1) {
          return fakeChatCompletion(
            JSON.stringify({
              instruction: "",
              clarification: "Which file should I delete?",
              riskLevel: "high",
              tasks: [],
            }),
          );
        }

        return fakeChatCompletion(
          JSON.stringify({
            intent: "workspace_edit",
            operation: "delete_file",
            targetPhrase: "sensor sketch file",
            destinationPhrase: "",
            candidatePath: "dc_motor_control.ino",
            candidateSource: "active_editor",
            confidence: 0.86,
            clarification: "",
          }),
        );
      },
    });

    const route = await manager.route({
      prompt: "deelete the file sensor sketch file",
      source: "managed",
      mode: "fast",
      intent: "agent",
      threadId: "smoke-active-editor-suggestion-action-repair",
      activeTab: {
        path: activePath,
        name: "dc_motor_control.ino",
        content: "void setup() {}\n",
        isDirty: false,
      },
    });

    assert.equal(route.engine, "opencode_edit");
    assert.equal(route.requiresUserDecision, true);
    assert.equal(route.decisionKind, "approve_skip");
    assert.match(route.userMessage, /suggested the open file dc_motor_control\.ino/i);
    const deleteTask = route.taskList.items.find((item) => item.kind === "delete_file");
    assert.ok(deleteTask, "expected active editor suggestion delete task");
    assert.equal(deleteTask.targetPath, "dc_motor_control.ino");
    assert.doesNotMatch(route.userMessage, /command prompt|powershell|terminal|file explorer|\b(del|rm)\b/i);
  });
}

async function runActionRepairRejectsCommandOutputSmoke() {
  await withTempWorkspace(async ({ workspaceRoot, userDataRoot }) => {
    await fs.writeFile(path.join(workspaceRoot, "dc_motor_control.ino"), "void setup() {}\n", "utf8");

    const events = [];
    const manager = createManager({
      workspaceRoot,
      userDataRoot,
      events,
      executeGatewayRequest: async () =>
        fakeChatCompletion('To delete the file, use Command Prompt:\n\ndel "D:\\\\workspace\\\\dc_motor_control.ino"'),
    });

    const route = await manager.route({
      prompt: "get rid of the motor sketch file",
      source: "managed",
      mode: "fast",
      intent: "agent",
      threadId: "smoke-action-repair-rejects-command-output",
    });

    assert.equal(route.engine, "local");
    assert.equal(route.decisionKind, "clarify");
    assert.doesNotMatch(route.userMessage, /command prompt|powershell|terminal|file explorer|\b(del|rm)\b/i);
  });
}

async function runClarificationSelectionApprovalSmoke() {
  await withTempWorkspace(async ({ workspaceRoot, userDataRoot }) => {
    await fs.mkdir(path.join(workspaceRoot, "sketches"), { recursive: true });
    const temperaturePath = path.join(workspaceRoot, "sketches", "temperature_sensor_reading.ino");
    const tofPath = path.join(workspaceRoot, "sketches", "tof_sensor_reading.ino");
    const ultrasonicPath = path.join(workspaceRoot, "sketches", "ultrasonic_sensor_reading.ino");
    await fs.writeFile(temperaturePath, "void setup() {}\n", "utf8");
    await fs.writeFile(tofPath, "void setup() {}\n", "utf8");
    await fs.writeFile(ultrasonicPath, "void setup() {}\n", "utf8");

    const events = [];
    let gatewayCalls = 0;
    const manager = createManager({
      workspaceRoot,
      userDataRoot,
      events,
      executeGatewayRequest: async () => {
        gatewayCalls += 1;
        if (gatewayCalls === 1) {
          return fakeChatCompletion("not-json");
        }
        if (gatewayCalls === 2) {
          return fakeChatCompletion(
            JSON.stringify({
              intent: "clarify",
              operation: "none",
              targetPhrase: "sensor sketch file",
              destinationPhrase: "",
              candidatePath: "",
              candidateSource: "none",
              confidence: 0.64,
              clarification:
                "There are several sensor-related sketch files: sketches/temperature_sensor_reading.ino, sketches/tof_sensor_reading.ino, and sketches/ultrasonic_sensor_reading.ino. Which one do you want to delete?",
            }),
          );
        }

        return fakeChatCompletion(
          JSON.stringify({
            intent: "workspace_edit",
            operation: "delete_file",
            targetPhrase: "tof one",
            destinationPhrase: "",
            candidatePath: "sketches/tof_sensor_reading.ino",
            candidateSource: "workspace",
            confidence: 0.92,
            clarification: "",
          }),
        );
      },
    });

    const initialRoute = await manager.route({
      prompt: "delete sensor sketch file",
      source: "managed",
      mode: "fast",
      intent: "agent",
      threadId: "smoke-clarification-selection-initial",
    });

    assert.equal(initialRoute.engine, "local");
    assert.equal(initialRoute.decisionKind, "clarify");
    assert.match(initialRoute.userMessage, /multiple files|sensor/i);
    assert.match(initialRoute.userMessage, /temperature_sensor_reading\.ino/);
    assert.match(initialRoute.userMessage, /tof_sensor_reading\.ino/);
    assert.match(initialRoute.userMessage, /ultrasonic_sensor_reading\.ino/);
    const initialDeleteTask = initialRoute.taskList.items.find((item) => item.kind === "delete_file");
    assert.ok(initialDeleteTask, "expected initial blocked delete task");
    assert.equal(initialDeleteTask.status, "blocked");

    const selectionRoute = await manager.route({
      prompt: "tof one",
      source: "managed",
      mode: "fast",
      intent: "agent",
      threadId: "smoke-clarification-selection-route",
      taskList: initialRoute.taskList,
      threadMessages: [
        { role: "user", content: "delete sensor sketch file" },
        { role: "assistant", content: initialRoute.userMessage },
      ],
    });

    assert.equal(selectionRoute.engine, "opencode_edit");
    assert.equal(selectionRoute.requiresUserDecision, true);
    assert.equal(selectionRoute.decisionKind, "approve_skip");
    assert.ok(selectionRoute.pendingAction?.id, "expected a pending action after selection");
    assert.doesNotMatch(selectionRoute.userMessage, /confirm if|command prompt|powershell|terminal|file explorer|\b(del|rm)\b/i);
    const selectedDeleteTask = selectionRoute.taskList.items.find((item) => item.kind === "delete_file");
    assert.ok(selectedDeleteTask, "expected selected delete task");
    assert.equal(selectedDeleteTask.status, "pending");
    assert.equal(selectedDeleteTask.targetPath, "sketches/tof_sensor_reading.ino");
    assert.equal(selectionRoute.taskList.actionId, selectionRoute.pendingAction.id);

    const result = await manager.run({
      prompt: "proceed",
      source: "managed",
      mode: "fast",
      intent: "agent",
      threadId: "smoke-clarification-selection-run",
      pendingAction: selectionRoute.pendingAction,
      approvedActionId: selectionRoute.pendingAction.id,
      taskList: selectionRoute.taskList,
    });

    assert.equal(await fileExists(tofPath), false);
    assert.equal(await fileExists(temperaturePath), true);
    assert.equal(await fileExists(ultrasonicPath), true);
    assert.ok(result.changedFiles.some((file) => file.path === "sketches/tof_sensor_reading.ino" && file.changeType === "delete"));
  });
}

async function runClarificationSelectionAmbiguousSmoke() {
  await withTempWorkspace(async ({ workspaceRoot, userDataRoot }) => {
    await fs.mkdir(path.join(workspaceRoot, "sketches"), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, "sketches", "temperature_sensor_reading.ino"), "void setup() {}\n", "utf8");
    await fs.writeFile(path.join(workspaceRoot, "sketches", "tof_sensor_reading.ino"), "void setup() {}\n", "utf8");
    await fs.writeFile(path.join(workspaceRoot, "sketches", "ultrasonic_sensor_reading.ino"), "void setup() {}\n", "utf8");

    const now = new Date().toISOString();
    const blockedTaskList = {
      id: "tasks-blocked-sensor",
      actionId: null,
      items: [
        {
          id: "delete-blocked",
          title: "Delete sensor.ino",
          status: "blocked",
          kind: "delete_file",
          targetPath: "sensor.ino",
          error:
            "I found multiple files named sensor.ino: sketches/temperature_sensor_reading.ino, sketches/tof_sensor_reading.ino, sketches/ultrasonic_sensor_reading.ino. Please name the exact path.",
        },
      ],
      createdAt: now,
      updatedAt: now,
    };

    const events = [];
    const manager = createManager({
      workspaceRoot,
      userDataRoot,
      events,
      executeGatewayRequest: async () =>
        fakeChatCompletion(
          JSON.stringify({
            intent: "clarify",
            operation: "none",
            targetPhrase: "sensor one",
            destinationPhrase: "",
            candidatePath: "",
            candidateSource: "none",
            confidence: 0.63,
            clarification:
              "Which sensor file should I delete: sketches/temperature_sensor_reading.ino, sketches/tof_sensor_reading.ino, or sketches/ultrasonic_sensor_reading.ino?",
          }),
        ),
    });

    const route = await manager.route({
      prompt: "sensor one",
      source: "managed",
      mode: "fast",
      intent: "agent",
      threadId: "smoke-clarification-selection-ambiguous",
      taskList: blockedTaskList,
    });

    assert.equal(route.engine, "local");
    assert.equal(route.decisionKind, "clarify");
    assert.equal(route.requiresUserDecision, true);
    assert.match(route.userMessage, /Which sensor file/i);
    assert.ok(route.taskList.items.some((item) => item.status === "blocked" && item.targetPath === "sensor.ino"));
    assert.doesNotMatch(route.userMessage, /confirm if|command prompt|powershell|terminal|file explorer|\b(del|rm)\b/i);
  });
}

async function runClarificationSelectionRejectsProseSmoke() {
  await withTempWorkspace(async ({ workspaceRoot, userDataRoot }) => {
    await fs.mkdir(path.join(workspaceRoot, "sketches"), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, "sketches", "tof_sensor_reading.ino"), "void setup() {}\n", "utf8");

    const now = new Date().toISOString();
    const blockedTaskList = {
      id: "tasks-blocked-prose",
      actionId: null,
      items: [
        {
          id: "delete-blocked",
          title: "Delete sensor.ino",
          status: "blocked",
          kind: "delete_file",
          targetPath: "sensor.ino",
          error: "I could not find sensor.ino in this project space. Please name the exact file to delete.",
        },
      ],
      createdAt: now,
      updatedAt: now,
    };

    const events = [];
    const manager = createManager({
      workspaceRoot,
      userDataRoot,
      events,
      executeGatewayRequest: async () => fakeChatCompletion("You want to delete sketches/tof_sensor_reading.ino. Confirm if you want this file deleted."),
    });

    const route = await manager.route({
      prompt: "tof one",
      source: "managed",
      mode: "fast",
      intent: "agent",
      threadId: "smoke-clarification-selection-rejects-prose",
      taskList: blockedTaskList,
    });

    assert.equal(route.engine, "local");
    assert.equal(route.decisionKind, "clarify");
    assert.equal(route.requiresUserDecision, true);
    assert.ok(route.taskList.items.some((item) => item.status === "blocked" && item.targetPath === "sensor.ino"));
    assert.doesNotMatch(route.userMessage, /confirm if|command prompt|powershell|terminal|file explorer|\b(del|rm)\b/i);
  });
}

async function runApprovedMixedPromptSmoke() {
  await withTempWorkspace(async ({ workspaceRoot, userDataRoot }) => {
    const blinkCPath = path.join(workspaceRoot, "blink.c");
    const blinkInoPath = path.join(workspaceRoot, "blink.ino");
    const ledBlinkPath = path.join(workspaceRoot, "ledblink.ino");
    await fs.writeFile(blinkCPath, "void setup() {}\n\nvoid loop() {}\n", "utf8");
    await fs.writeFile(blinkInoPath, "void setup() {}\n\nvoid loop() {}\n", "utf8");

    const prompt =
      "delete tha blink c file and create a ino file for arduino uno board motor control. server motor for rotate one side fully then rotate other side. should happen for 10 times. make it a variable so i can change the count later on. then rename the current blink ino file as ledblink";
    const events = [];
    const gatewayRequests = [];
    const manager = createManager({
      workspaceRoot,
      userDataRoot,
      events,
      executeGatewayRequest: async ({ request }) => {
        gatewayRequests.push(request);
        return fakeChatCompletion("Prepared the requested remaining Arduino sketch task.");
      },
    });

    const route = await manager.route({
      prompt,
      source: "managed",
      mode: "fast",
      intent: "agent",
      threadId: "smoke-approved-mixed-route",
    });

    assert.equal(route.requiresUserDecision, true);
    assert.ok(route.pendingAction?.id, "expected a pending action");

    const result = await manager.run({
      prompt: "proceed",
      source: "managed",
      mode: "fast",
      intent: "agent",
      threadId: "smoke-approved-mixed-run",
      pendingAction: route.pendingAction,
      approvedActionId: route.pendingAction.id,
      taskList: route.taskList,
    });

    const requestText = gatewayRequests
      .filter((request) => !JSON.stringify(request).includes("Tantalum's fast planner"))
      .map((request) => JSON.stringify(request))
      .join("\n");
    assert.match(requestText, /Remaining tasks:/, "expected opencode to receive a remaining-work prompt");
    assert.match(requestText, /Create \.ino file/, "expected opencode to receive only the create/edit task");
    assert.match(requestText, /arduino uno board motor control/i, "expected non-deterministic content requirements to be preserved");
    assert.doesNotMatch(requestText, /Delete blink\.c/, "opencode should not receive completed delete tasks");
    assert.doesNotMatch(requestText, /Rename blink\.ino/, "opencode should not receive completed rename tasks");
    assert.doesNotMatch(requestText, /delete tha blink/i, "opencode should not receive the original destructive typo instruction");

    assert.equal(await fileExists(blinkCPath), false);
    assert.equal(await fileExists(blinkInoPath), false);
    assert.equal(await fileExists(ledBlinkPath), true);
    assert.ok(result.changedFiles.some((file) => file.path === "blink.c" && file.changeType === "delete"));
    assert.ok(result.changedFiles.some((file) => file.path === "ledblink.ino" && file.changeType === "create"));
    assert.ok(
      events.some((event) => event.taskList?.items?.some((item) => item.title === "Delete blink.c")),
      "expected progress to include the resolved delete task label",
    );
  });
}

async function runBulkHelperDeleteKeepInoRouteSmoke() {
  await withTempWorkspace(async ({ workspaceRoot, userDataRoot }) => {
    await fs.writeFile(path.join(workspaceRoot, "rgb.ino"), "void setup() {}\nvoid loop() {}\n", "utf8");
    await fs.writeFile(path.join(workspaceRoot, "rgb_utils.cpp"), '#include "rgb_utils.h"\nvoid setRgb() {}\n', "utf8");
    await fs.writeFile(path.join(workspaceRoot, "rgb_utils.h"), "void setRgb();\n", "utf8");
    await fs.writeFile(path.join(workspaceRoot, "rgb_extra.hpp"), "void setExtraRgb();\n", "utf8");

    const events = [];
    const manager = createManager({
      workspaceRoot,
      userDataRoot,
      events,
      executeGatewayRequest: async () => fakeChatCompletion("not-json"),
    });

    const route = await manager.route({
      prompt: "delete all cpp, h file and just keep rgb ino file. move required stuffs to one that ino file",
      source: "managed",
      mode: "fast",
      intent: "agent",
      threadId: "smoke-bulk-helper-delete-keep-ino",
    });

    assert.equal(route.requiresUserDecision, true);
    assert.equal(route.decisionKind, "approve_skip");
    const editTask = route.taskList.items.find((item) => item.kind === "opencode_edit");
    assert.ok(editTask, "expected an edit task for the kept sketch");
    assert.equal(editTask.targetPath, "rgb.ino");
    assert.deepEqual(editTask.sourcePaths.sort(), ["rgb_extra.hpp", "rgb_utils.cpp", "rgb_utils.h"].sort());

    const deleteTasks = route.taskList.items.filter((item) => item.kind === "delete_file");
    assert.deepEqual(
      deleteTasks.map((item) => item.targetPath).sort(),
      ["rgb_extra.hpp", "rgb_utils.cpp", "rgb_utils.h"].sort(),
    );
    assert.ok(deleteTasks.every((item) => item.deferUntilAfterEdit === true), "expected helper deletes to wait until after edit");
  });
}

async function runHeaderFollowupRouteSmoke() {
  await withTempWorkspace(async ({ workspaceRoot, userDataRoot }) => {
    await fs.writeFile(path.join(workspaceRoot, "rgb.ino"), "void setup() {}\nvoid loop() {}\n", "utf8");
    await fs.writeFile(path.join(workspaceRoot, "rgb_utils.h"), "void setRgb();\n", "utf8");

    const events = [];
    const manager = createManager({
      workspaceRoot,
      userDataRoot,
      events,
      executeGatewayRequest: async () => fakeChatCompletion("not-json"),
    });

    const route = await manager.route({
      prompt: "also remove header file and move all logic to ino file",
      source: "managed",
      mode: "fast",
      intent: "agent",
      threadId: "smoke-header-followup-route",
    });

    assert.equal(route.requiresUserDecision, true);
    const deleteTask = route.taskList.items.find((item) => item.kind === "delete_file");
    const editTask = route.taskList.items.find((item) => item.kind === "opencode_edit");
    assert.ok(deleteTask, "expected header delete task");
    assert.equal(deleteTask.targetPath, "rgb_utils.h");
    assert.equal(deleteTask.deferUntilAfterEdit, true);
    assert.ok(editTask, "expected edit task to move header logic");
    assert.equal(editTask.targetPath, "rgb.ino");
    assert.deepEqual(editTask.sourcePaths, ["rgb_utils.h"]);
  });
}

async function runHeaderClarificationSelectionSmoke() {
  await withTempWorkspace(async ({ workspaceRoot, userDataRoot }) => {
    await fs.writeFile(path.join(workspaceRoot, "rgb_utils.h"), "void setRgb();\n", "utf8");

    const events = [];
    const manager = createManager({
      workspaceRoot,
      userDataRoot,
      events,
      executeGatewayRequest: async () => fakeChatCompletion("not-json"),
    });
    const blockedTaskList = {
      id: "tasks-header-blocked",
      actionId: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      items: [
        {
          id: "delete-header-blocked",
          title: "Delete header",
          status: "blocked",
          kind: "delete_file",
          targetPath: "header",
          error: "I could not find header in this project space. Please name the exact file to delete.",
        },
      ],
    };

    const route = await manager.route({
      prompt: "i mean .h rgb utils file",
      source: "managed",
      mode: "fast",
      intent: "agent",
      threadId: "smoke-header-clarification-selection",
      taskList: blockedTaskList,
    });

    assert.equal(route.engine, "opencode_edit");
    assert.equal(route.decisionKind, "approve_skip");
    assert.match(route.userMessage, /rgb_utils\.h/);
    const deleteTask = route.taskList.items.find((item) => item.kind === "delete_file");
    assert.ok(deleteTask, "expected clarified header delete task");
    assert.equal(deleteTask.targetPath, "rgb_utils.h");
    assert.equal(deleteTask.status, "pending");
  });
}

async function runMoveAllInoRouteSmoke() {
  await withTempWorkspace(async ({ workspaceRoot, userDataRoot }) => {
    await fs.writeFile(path.join(workspaceRoot, "blink.ino"), "void setup() {}\n", "utf8");
    await fs.writeFile(path.join(workspaceRoot, "motor.ino"), "void loop() {}\n", "utf8");
    await fs.mkdir(path.join(workspaceRoot, "sketches"), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, "sketches", "existing.ino"), "void setup() {}\n", "utf8");

    const events = [];
    const manager = createManager({
      workspaceRoot,
      userDataRoot,
      events,
      executeGatewayRequest: async () => fakeChatCompletion("not-json"),
    });

    const route = await manager.route({
      prompt: "move all ino files to a folder called sketches. create the folder and move into it",
      source: "managed",
      mode: "fast",
      intent: "agent",
      threadId: "smoke-move-all-ino-route",
    });

    assert.equal(route.requiresUserDecision, true);
    const moveTasks = route.taskList.items.filter((item) => item.kind === "move_file");
    assert.equal(moveTasks.length, 2);
    assert.deepEqual(
      moveTasks.map((item) => [item.targetPath, item.newPath]).sort(),
      [
        ["blink.ino", "sketches/blink.ino"],
        ["motor.ino", "sketches/motor.ino"],
      ],
    );
    assert.ok(!route.taskList.items.some((item) => item.targetPath === "folder.ino" || item.title === "Create folder.ino"));
    assert.ok(!route.taskList.items.some((item) => item.targetPath === "sketches/existing.ino"));

    const createFolderFirstRoute = await manager.route({
      prompt: "create a folder called sketches and move all ino files into it",
      source: "managed",
      mode: "fast",
      intent: "agent",
      threadId: "smoke-create-folder-first-move-all-ino-route",
    });
    assert.deepEqual(
      createFolderFirstRoute.taskList.items
        .filter((item) => item.kind === "move_file")
        .map((item) => [item.targetPath, item.newPath])
        .sort(),
      [
        ["blink.ino", "sketches/blink.ino"],
        ["motor.ino", "sketches/motor.ino"],
      ],
    );
    assert.ok(!createFolderFirstRoute.taskList.items.some((item) => item.targetPath === "folder.ino" || item.title === "Create folder.ino"));
  });
}

async function runApprovedMoveAllInoSmoke() {
  await withTempWorkspace(async ({ workspaceRoot, userDataRoot }) => {
    const blinkPath = path.join(workspaceRoot, "blink.ino");
    const motorPath = path.join(workspaceRoot, "motor.ino");
    const sketchBlinkPath = path.join(workspaceRoot, "sketches", "blink.ino");
    const sketchMotorPath = path.join(workspaceRoot, "sketches", "motor.ino");
    await fs.writeFile(blinkPath, "void setup() {}\n", "utf8");
    await fs.writeFile(motorPath, "void loop() {}\n", "utf8");

    const events = [];
    const manager = createManager({
      workspaceRoot,
      userDataRoot,
      events,
      executeGatewayRequest: async () => fakeChatCompletion("not-json"),
    });

    const route = await manager.route({
      prompt: "move all ino files to a folder called sketches. create the folder and move into it",
      source: "managed",
      mode: "fast",
      intent: "agent",
      threadId: "smoke-approved-move-all-ino-route",
    });

    const result = await manager.run({
      prompt: "proceed",
      source: "managed",
      mode: "fast",
      intent: "agent",
      threadId: "smoke-approved-move-all-ino-run",
      pendingAction: route.pendingAction,
      approvedActionId: route.pendingAction.id,
      taskList: route.taskList,
    });

    assert.equal(await fileExists(blinkPath), false);
    assert.equal(await fileExists(motorPath), false);
    assert.equal(await fileExists(sketchBlinkPath), true);
    assert.equal(await fileExists(sketchMotorPath), true);
    assert.equal(await fileExists(path.join(workspaceRoot, "folder.ino")), false);
    assert.ok(result.changedFiles.some((file) => file.path === "blink.ino" && file.changeType === "delete"));
    assert.ok(result.changedFiles.some((file) => file.path === "motor.ino" && file.changeType === "delete"));
    assert.ok(result.changedFiles.some((file) => file.path === "sketches/blink.ino" && file.changeType === "create"));
    assert.ok(result.changedFiles.some((file) => file.path === "sketches/motor.ino" && file.changeType === "create"));
    assert.ok(result.taskList.items.every((item) => item.kind !== "move_file" || item.status === "completed"));
  });
}

async function runMoveDuplicateDestinationSmoke() {
  await withTempWorkspace(async ({ workspaceRoot, userDataRoot }) => {
    await fs.writeFile(path.join(workspaceRoot, "blink.ino"), "void setup() {}\n", "utf8");
    await fs.mkdir(path.join(workspaceRoot, "nested"), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, "nested", "blink.ino"), "void loop() {}\n", "utf8");

    const events = [];
    const manager = createManager({
      workspaceRoot,
      userDataRoot,
      events,
      executeGatewayRequest: async () => fakeChatCompletion("not-json"),
    });

    const route = await manager.route({
      prompt: "move all ino files to a folder called sketches",
      source: "managed",
      mode: "fast",
      intent: "agent",
      threadId: "smoke-move-duplicate-destination",
    });

    assert.equal(route.engine, "local");
    assert.equal(route.decisionKind, "clarify");
    assert.match(route.userMessage, /multiple files named/i);
    assert.match(route.userMessage, /sketches\/blink\.ino/i);
  });
}

async function runDeleteRootSketchFilesRouteSmoke() {
  await withTempWorkspace(async ({ workspaceRoot, userDataRoot }) => {
    await fs.writeFile(path.join(workspaceRoot, "blink.ino"), "void setup() {}\n", "utf8");
    await fs.writeFile(path.join(workspaceRoot, "motor.ino"), "void loop() {}\n", "utf8");
    await fs.mkdir(path.join(workspaceRoot, "nested"), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, "nested", "keep.ino"), "void setup() {}\n", "utf8");

    const events = [];
    const manager = createManager({
      workspaceRoot,
      userDataRoot,
      events,
      executeGatewayRequest: async () => fakeChatCompletion("not-json"),
    });

    const route = await manager.route({
      prompt: "delete all the sketch files in the root folder",
      source: "managed",
      mode: "fast",
      intent: "agent",
      threadId: "smoke-delete-root-sketch-route",
    });

    assert.equal(route.requiresUserDecision, true);
    const deleteTasks = route.taskList.items.filter((item) => item.kind === "delete_file");
    assert.deepEqual(
      deleteTasks.map((item) => item.targetPath).sort(),
      ["blink.ino", "motor.ino"],
    );
    assert.ok(!route.taskList.items.some((item) => item.targetPath === "allthesketchfilesintherootfolder"));
    assert.ok(!route.taskList.items.some((item) => item.targetPath === "nested/keep.ino"));
  });
}

async function runApprovedDeleteRootSketchFilesSmoke() {
  await withTempWorkspace(async ({ workspaceRoot, userDataRoot }) => {
    const blinkPath = path.join(workspaceRoot, "blink.ino");
    const motorPath = path.join(workspaceRoot, "motor.ino");
    const nestedPath = path.join(workspaceRoot, "nested", "keep.ino");
    await fs.writeFile(blinkPath, "void setup() {}\n", "utf8");
    await fs.writeFile(motorPath, "void loop() {}\n", "utf8");
    await fs.mkdir(path.dirname(nestedPath), { recursive: true });
    await fs.writeFile(nestedPath, "void setup() {}\n", "utf8");

    const events = [];
    const manager = createManager({
      workspaceRoot,
      userDataRoot,
      events,
      executeGatewayRequest: async () => fakeChatCompletion("not-json"),
    });

    const route = await manager.route({
      prompt: "delete all the sketch files in the root folder",
      source: "managed",
      mode: "fast",
      intent: "agent",
      threadId: "smoke-approved-delete-root-sketch-route",
    });

    const result = await manager.run({
      prompt: "proceed",
      source: "managed",
      mode: "fast",
      intent: "agent",
      threadId: "smoke-approved-delete-root-sketch-run",
      pendingAction: route.pendingAction,
      approvedActionId: route.pendingAction.id,
      taskList: route.taskList,
    });

    assert.equal(await fileExists(blinkPath), false);
    assert.equal(await fileExists(motorPath), false);
    assert.equal(await fileExists(nestedPath), true);
    assert.ok(result.changedFiles.some((file) => file.path === "blink.ino" && file.changeType === "delete"));
    assert.ok(result.changedFiles.some((file) => file.path === "motor.ino" && file.changeType === "delete"));
    assert.ok(!result.changedFiles.some((file) => file.path === "nested/keep.ino"));
    assert.ok(result.taskList.items.every((item) => item.kind !== "delete_file" || item.status === "completed"));
  });
}

async function runDeleteRootSketchFilesEmptySmoke() {
  await withTempWorkspace(async ({ workspaceRoot, userDataRoot }) => {
    await fs.mkdir(path.join(workspaceRoot, "nested"), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, "nested", "keep.ino"), "void setup() {}\n", "utf8");

    const events = [];
    const manager = createManager({
      workspaceRoot,
      userDataRoot,
      events,
      executeGatewayRequest: async () => fakeChatCompletion("not-json"),
    });

    const route = await manager.route({
      prompt: "delete all the sketch files in the root folder",
      source: "managed",
      mode: "fast",
      intent: "agent",
      threadId: "smoke-delete-root-sketch-empty",
    });

    assert.equal(route.engine, "local");
    assert.equal(route.decisionKind, "clarify");
    assert.match(route.userMessage, /could not find any \.ino files in the Project Space root/i);
  });
}

async function runAmbiguousFuzzyTargetSmoke() {
  await withTempWorkspace(async ({ workspaceRoot, userDataRoot }) => {
    await fs.writeFile(path.join(workspaceRoot, "blink.c"), "void setup() {}\n", "utf8");
    await fs.writeFile(path.join(workspaceRoot, "blank.c"), "void setup() {}\n", "utf8");

    const events = [];
    const manager = createManager({
      workspaceRoot,
      userDataRoot,
      events,
      executeGatewayRequest: async () => fakeChatCompletion("unused"),
    });

    const route = await manager.route({
      prompt: "delete blnk c file",
      source: "managed",
      mode: "fast",
      intent: "agent",
      threadId: "smoke-ambiguous-fuzzy",
    });

    const deleteTask = route.taskList.items.find((item) => item.kind === "delete_file");
    assert.ok(deleteTask, "expected a delete task");
    assert.equal(deleteTask.status, "blocked");
    assert.match(deleteTask.error, /multiple files/i);
    assert.match(deleteTask.error, /blink\.c/);
    assert.match(deleteTask.error, /blank\.c/);
  });
}

async function runDefaultSketchExtensionSmoke() {
  await withTempWorkspace(async ({ workspaceRoot, userDataRoot }) => {
    const events = [];
    const manager = createManager({
      workspaceRoot,
      userDataRoot,
      events,
      executeGatewayRequest: async () => fakeChatCompletion("not-json"),
    });

    const createRoute = await manager.route({
      prompt: "create esp32code",
      source: "managed",
      mode: "fast",
      intent: "agent",
      threadId: "smoke-default-create-ino",
    });
    const createTask = createRoute.taskList.items.find((item) => item.kind === "create_file");
    assert.ok(createTask, "expected a create task");
    assert.equal(createTask.targetPath, "esp32code.ino");
    assert.equal(createTask.title, "Create esp32code.ino");

    const phraseRoute = await manager.route({
      prompt: "create the file esp32 blink led",
      source: "managed",
      mode: "fast",
      intent: "agent",
      threadId: "smoke-default-create-phrase-ino",
    });
    const phraseTask = phraseRoute.taskList.items.find((item) => item.kind === "create_file");
    assert.ok(phraseTask, "expected a create task from a descriptive file phrase");
    assert.equal(phraseTask.targetPath, "esp32_blink_led.ino");

    const forPhraseRoute = await manager.route({
      prompt: "create file for esp32 blink led",
      source: "managed",
      mode: "fast",
      intent: "agent",
      threadId: "smoke-default-create-for-phrase-ino",
    });
    const forPhraseTask = forPhraseRoute.taskList.items.find((item) => item.kind === "create_file");
    assert.ok(forPhraseTask, "expected a create task from a file-for phrase");
    assert.equal(forPhraseTask.targetPath, "esp32_blink_led.ino");

    const explicitExtensionRoute = await manager.route({
      prompt: "create README.md",
      source: "managed",
      mode: "fast",
      intent: "agent",
      threadId: "smoke-explicit-extension",
    });
    const explicitTask = explicitExtensionRoute.taskList.items.find((item) => item.kind === "create_file");
    assert.ok(explicitTask, "expected an explicit create task");
    assert.equal(explicitTask.targetPath, "README.md");

    const editRoute = await manager.route({
      prompt: "edit the code",
      source: "managed",
      mode: "fast",
      intent: "agent",
      threadId: "smoke-default-edit-ino",
    });
    const editTask = editRoute.taskList.items.find((item) => item.kind === "opencode_edit");
    assert.ok(editTask, "expected an edit task");
    assert.equal(editTask.targetExtension, "ino");
  });
}

async function runPreferredImplicitEditTargetSmoke() {
  const prompt = "create code for s3 inbuild rgb to light blue";
  const derivedTarget = "s3_inbuild_rgb_to_light_blue.ino";

  await withTempWorkspace(async ({ workspaceRoot, userDataRoot }) => {
    await fs.writeFile(path.join(workspaceRoot, "sketch.ino"), "", "utf8");

    const events = [];
    const gatewayRequests = [];
    const manager = createManager({
      workspaceRoot,
      userDataRoot,
      events,
      executeGatewayRequest: async ({ request }) => {
        gatewayRequests.push(request);
        return fakeChatCompletion(
          JSON.stringify({
            instruction: "Create the requested sketch.",
            clarification: null,
            riskLevel: "low",
            tasks: [
              {
                kind: "create_file",
                title: `Create ${derivedTarget}`,
                targetPath: derivedTarget,
              },
            ],
          }),
        );
      },
    });

    const route = await manager.route({
      prompt,
      source: "managed",
      mode: "fast",
      intent: "agent",
      threadId: "smoke-preferred-implicit-edit-target",
      contextItems: [workspaceFileContextItem(workspaceRoot, "sketch.ino", "")],
    });

    assert.ok(gatewayRequests.length > 0, "expected fast planner request");
    assert.match(JSON.stringify(gatewayRequests), /preferredImplicitEditTarget/);
    assert.match(JSON.stringify(gatewayRequests), /sketch\.ino/);
    assert.equal(route.taskList.items.length, 1);
    const editTask = route.taskList.items[0];
    assert.equal(editTask.kind, "opencode_edit");
    assert.equal(editTask.targetPath, "sketch.ino");
    assert.equal(editTask.title, "Write code in sketch.ino");
  });

  await withTempWorkspace(async ({ workspaceRoot, userDataRoot }) => {
    await fs.writeFile(path.join(workspaceRoot, "sketch.ino"), "void setup() {}\n", "utf8");

    const events = [];
    const manager = createManager({
      workspaceRoot,
      userDataRoot,
      events,
      executeGatewayRequest: async () => fakeChatCompletion("not-json"),
    });

    const route = await manager.route({
      prompt,
      source: "managed",
      mode: "fast",
      intent: "agent",
      threadId: "smoke-nonempty-attached-create-target",
      contextItems: [workspaceFileContextItem(workspaceRoot, "sketch.ino", "void setup() {}\n")],
    });

    assert.equal(route.requiresUserDecision, false);
    assert.equal(route.decisionKind, "none");
    assert.equal(route.taskList.items.length, 1);
    const editTask = route.taskList.items[0];
    assert.equal(editTask.kind, "opencode_edit");
    assert.equal(editTask.targetPath, "sketch.ino");
    assert.equal(editTask.title, "Write code in sketch.ino");
  });

  await withTempWorkspace(async ({ workspaceRoot, userDataRoot }) => {
    await fs.writeFile(path.join(workspaceRoot, "sketch.ino"), "void setup() {}\n", "utf8");

    const events = [];
    const manager = createManager({
      workspaceRoot,
      userDataRoot,
      events,
      executeGatewayRequest: async () => fakeChatCompletion("not-json"),
    });

    const route = await manager.route({
      prompt: "write for s3 builtin led to light blue",
      source: "managed",
      mode: "fast",
      intent: "agent",
      threadId: "smoke-active-file-create-target",
      activeTab: { path: path.join(workspaceRoot, "sketch.ino") },
    });

    assert.equal(route.requiresUserDecision, false);
    assert.equal(route.decisionKind, "none");
    assert.equal(route.taskList.items.length, 1);
    const editTask = route.taskList.items[0];
    assert.equal(editTask.kind, "opencode_edit");
    assert.equal(editTask.targetPath, "sketch.ino");
  });

  await withTempWorkspace(async ({ workspaceRoot, userDataRoot }) => {
    await fs.writeFile(path.join(workspaceRoot, "sketch.ino"), "", "utf8");
    await fs.writeFile(path.join(workspaceRoot, "other.ino"), "", "utf8");

    const events = [];
    const manager = createManager({
      workspaceRoot,
      userDataRoot,
      events,
      executeGatewayRequest: async () => fakeChatCompletion("not-json"),
    });

    const route = await manager.route({
      prompt,
      source: "managed",
      mode: "fast",
      intent: "agent",
      threadId: "smoke-multiple-empty-attached-create-target",
      contextItems: [
        workspaceFileContextItem(workspaceRoot, "sketch.ino", ""),
        workspaceFileContextItem(workspaceRoot, "other.ino", ""),
      ],
    });

    const createTask = route.taskList.items.find((item) => item.kind === "create_file");
    assert.ok(createTask, "expected multiple empty attached files not to choose arbitrarily");
    assert.equal(createTask.targetPath, derivedTarget);
  });

  await withTempWorkspace(async ({ workspaceRoot, userDataRoot }) => {
    await fs.writeFile(path.join(workspaceRoot, "sketch.ino"), "", "utf8");

    const events = [];
    const manager = createManager({
      workspaceRoot,
      userDataRoot,
      events,
      executeGatewayRequest: async () => fakeChatCompletion("not-json"),
    });

    const route = await manager.route({
      prompt: "create code for foo.ino",
      source: "managed",
      mode: "fast",
      intent: "agent",
      threadId: "smoke-explicit-path-over-implicit-edit-target",
      contextItems: [workspaceFileContextItem(workspaceRoot, "sketch.ino", "")],
    });

    const createTask = route.taskList.items.find((item) => item.kind === "create_file");
    assert.ok(createTask, "expected explicit prompt file to win over implicit edit target");
    assert.equal(createTask.targetPath, "foo.ino");
  });

  await withTempWorkspace(async ({ workspaceRoot, userDataRoot }) => {
    await fs.writeFile(path.join(workspaceRoot, "sketch.ino"), "", "utf8");

    const events = [];
    const manager = createManager({
      workspaceRoot,
      userDataRoot,
      events,
      executeGatewayRequest: async () => fakeChatCompletion("not-json"),
    });

    const route = await manager.route({
      prompt: "update this file to blink the onboard led",
      source: "managed",
      mode: "fast",
      intent: "agent",
      threadId: "smoke-update-empty-attached-target",
      contextItems: [workspaceFileContextItem(workspaceRoot, "sketch.ino", "")],
    });

    assert.equal(route.taskList.items.length, 1);
    const editTask = route.taskList.items[0];
    assert.equal(editTask.kind, "opencode_edit");
    assert.equal(editTask.targetPath, "sketch.ino");
  });

  await withTempWorkspace(async ({ workspaceRoot, userDataRoot }) => {
    const events = [];
    const manager = createManager({
      workspaceRoot,
      userDataRoot,
      events,
      executeGatewayRequest: async () => fakeChatCompletion("not-json"),
    });

    const route = await manager.route({
      prompt,
      source: "managed",
      mode: "fast",
      intent: "agent",
      threadId: "smoke-external-attachment-not-empty-target",
      contextItems: [
        {
          kind: "file",
          path: "attachment://sketch.ino",
          name: "sketch.ino",
          content: "",
          source: "attachment",
        },
      ],
    });

    const createTask = route.taskList.items.find((item) => item.kind === "create_file");
    assert.ok(createTask, "expected dropped external attachment not to become the create target");
    assert.equal(createTask.targetPath, derivedTarget);
  });
}

async function runShortFirmwareFollowupTargetSmoke() {
  await withTempWorkspace(async ({ workspaceRoot, userDataRoot }) => {
    await fs.writeFile(path.join(workspaceRoot, "sketch.ino"), "void setup() {}\n", "utf8");

    const events = [];
    const manager = createManager({
      workspaceRoot,
      userDataRoot,
      events,
      executeGatewayRequest: async () => {
        throw new Error("short firmware follow-up should not need the classifier");
      },
    });

    const route = await manager.route({
      prompt: "use neopixel",
      source: "managed",
      mode: "fast",
      intent: "agent",
      threadId: "smoke-short-firmware-followup",
      threadMemory: {
        files: [threadMemoryFile("sketch.ino", { aliases: ["s3 led sketch"] })],
      },
    });

    assert.equal(route.engine, "opencode_edit");
    assert.equal(route.reason, "short_firmware_followup");
    assert.equal(route.requiresUserDecision, false);
    assert.equal(route.decisionKind, "none");
    assert.equal(route.taskList.items.length, 1);
    const editTask = route.taskList.items[0];
    assert.equal(editTask.kind, "opencode_edit");
    assert.equal(editTask.targetPath, "sketch.ino");
  });

  await withTempWorkspace(async ({ workspaceRoot, userDataRoot }) => {
    await fs.writeFile(path.join(workspaceRoot, "sketch.ino"), "void setup() {}\n", "utf8");
    await fs.writeFile(path.join(workspaceRoot, "other.ino"), "void setup() {}\n", "utf8");

    const events = [];
    const manager = createManager({
      workspaceRoot,
      userDataRoot,
      events,
      executeGatewayRequest: async () => {
        throw new Error("ambiguous short firmware follow-up should not need the classifier");
      },
    });

    const route = await manager.route({
      prompt: "use neopixel",
      source: "managed",
      mode: "fast",
      intent: "agent",
      threadId: "smoke-short-firmware-followup-ambiguous",
      threadMemory: {
        files: [threadMemoryFile("sketch.ino"), threadMemoryFile("other.ino")],
      },
    });

    assert.equal(route.engine, "local");
    assert.equal(route.reason, "short_firmware_followup_ambiguous_target");
    assert.equal(route.decisionKind, "clarify");
    assert.match(route.userMessage, /multiple remembered source files/i);
    assert.match(route.userMessage, /sketch\.ino/);
    assert.match(route.userMessage, /other\.ino/);
  });
}

async function runPlannerClarificationCreateFallbackSmoke() {
  await withTempWorkspace(async ({ workspaceRoot, userDataRoot }) => {
    const events = [];
    const manager = createManager({
      workspaceRoot,
      userDataRoot,
      events,
      executeGatewayRequest: async () =>
        fakeChatCompletion(
          JSON.stringify({
            instruction: "",
            clarification: "No file path given. Say file name and folder.",
            riskLevel: "medium",
            tasks: [],
          }),
        ),
    });

    const route = await manager.route({
      prompt: "create the file esp32 blink led",
      source: "managed",
      mode: "fast",
      intent: "agent",
      threadId: "smoke-planner-clarification-create-fallback",
    });

    assert.notEqual(route.decisionKind, "clarify");
    const createTask = route.taskList.items.find((item) => item.kind === "create_file");
    assert.ok(createTask, "expected deterministic create fallback after planner clarification");
    assert.equal(createTask.targetPath, "esp32_blink_led.ino");
  });
}

async function runPlannerDefaultSketchExtensionSmoke() {
  await withTempWorkspace(async ({ workspaceRoot, userDataRoot }) => {
    const events = [];
    const manager = createManager({
      workspaceRoot,
      userDataRoot,
      events,
      executeGatewayRequest: async () =>
        fakeChatCompletion(
          JSON.stringify({
            instruction: "Create the requested ESP32 blink sketch.",
            clarification: null,
            riskLevel: "medium",
            tasks: [
              {
                kind: "create_file",
                title: "Create blink sketch",
                targetPath: "blink",
                instruction: "Create a blink sketch.",
              },
            ],
          }),
        ),
    });

    const createRoute = await manager.route({
      prompt: "create blink",
      source: "managed",
      mode: "fast",
      intent: "agent",
      threadId: "smoke-planner-default-create-ino",
    });
    const createTask = createRoute.taskList.items.find((item) => item.kind === "create_file");
    assert.ok(createTask, "expected planner create task");
    assert.equal(createTask.targetPath, "blink.ino");
  });

  await withTempWorkspace(async ({ workspaceRoot, userDataRoot }) => {
    const events = [];
    const manager = createManager({
      workspaceRoot,
      userDataRoot,
      events,
      executeGatewayRequest: async () =>
        fakeChatCompletion(
          JSON.stringify({
            instruction: "Write Arduino blink code.",
            clarification: null,
            riskLevel: "medium",
            tasks: [
              {
                kind: "opencode_edit",
                title: "Write blink sketch",
                instruction: "Write Arduino blink code.",
              },
            ],
          }),
        ),
    });

    const editRoute = await manager.route({
      prompt: "write blink code",
      source: "managed",
      mode: "fast",
      intent: "agent",
      threadId: "smoke-planner-default-edit-ino",
    });
    const editTask = editRoute.taskList.items.find((item) => item.kind === "create_file");
    assert.ok(editTask, "expected planner write-code task to use an inferred sketch path");
    assert.equal(editTask.targetPath, "blink.ino");
  });

  await withTempWorkspace(async ({ workspaceRoot, userDataRoot }) => {
    const events = [];
    const manager = createManager({
      workspaceRoot,
      userDataRoot,
      events,
      executeGatewayRequest: async () =>
        fakeChatCompletion(
          JSON.stringify({
            instruction: "Create the requested ESP32 blink sketch.",
            clarification: null,
            riskLevel: "medium",
            tasks: [
              {
                kind: "opencode_edit",
                title: "Create blink sketch",
                targetExtension: "ino",
                instruction: "Create the requested ESP32 blink sketch.",
              },
            ],
          }),
        ),
    });

    const route = await manager.route({
      prompt: "create the file esp32 blink led",
      source: "managed",
      mode: "fast",
      intent: "agent",
      threadId: "smoke-planner-generic-create-prefers-inferred-path",
    });
    const createTask = route.taskList.items.find((item) => item.kind === "create_file");
    assert.ok(createTask, "expected deterministic create target to replace generic planner edit");
    assert.equal(createTask.targetPath, "esp32_blink_led.ino");
  });
}

async function runPermissionModeRouteSmoke() {
  await withTempWorkspace(async ({ workspaceRoot, userDataRoot }) => {
    const events = [];
    const manager = createManager({
      workspaceRoot,
      userDataRoot,
      events,
      executeGatewayRequest: async () => fakeChatCompletion("unused"),
    });

    const defaultRoute = await manager.route({
      prompt: "delete README.md",
      source: "managed",
      mode: "fast",
      intent: "agent",
      permissionMode: "default",
      threadId: "smoke-default-approval",
    });
    assert.equal(defaultRoute.requiresUserDecision, true);
    assert.equal(defaultRoute.decisionKind, "approve_skip");
    assert.ok(defaultRoute.pendingAction?.id, "expected default destructive route to require a pending action");

    const bypassRoute = await manager.route({
      prompt: "delete README.md",
      source: "managed",
      mode: "fast",
      intent: "agent",
      permissionMode: "bypass",
      threadId: "smoke-bypass-approval",
    });
    assert.equal(bypassRoute.requiresUserDecision, false);
    assert.equal(bypassRoute.decisionKind, "none");
    assert.equal(bypassRoute.pendingAction, undefined);
    assert.match(bypassRoute.reason, /bypassed/);

    const askRoute = await manager.route({
      prompt: "delete README.md",
      source: "managed",
      mode: "fast",
      intent: "ask",
      permissionMode: "bypass",
      threadId: "smoke-ask-bypass-blocked",
    });
    assert.equal(askRoute.requiresUserDecision, false);
    assert.equal(askRoute.engine, "local");
    assert.match(askRoute.userMessage, /Ask mode is read-only/);
  });
}

function threadMemoryFile(pathValue, overrides = {}) {
  return {
    path: pathValue,
    name: path.basename(pathValue),
    aliases: [],
    source: "task",
    lastAction: "created",
    expectedExists: true,
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

async function runThreadMemoryNamedDeleteSmoke() {
  await withTempWorkspace(async ({ workspaceRoot, userDataRoot }) => {
    await fs.writeFile(path.join(workspaceRoot, "temperature_sensor.ino"), "void setup() {}\n", "utf8");

    const events = [];
    const manager = createManager({
      workspaceRoot,
      userDataRoot,
      events,
      executeGatewayRequest: async () => fakeChatCompletion("not-json"),
    });

    const route = await manager.route({
      prompt: "delete the temperature file we created",
      source: "managed",
      mode: "fast",
      intent: "agent",
      permissionMode: "default",
      threadId: "smoke-memory-named-delete",
      threadMemory: {
        files: [
          threadMemoryFile("temperature_sensor.ino", {
            aliases: ["temperature file", "temperature", "temperature sensor sketch"],
          }),
        ],
      },
    });

    assert.equal(route.requiresUserDecision, true);
    assert.equal(route.decisionKind, "approve_skip");
    const deleteTask = route.taskList.items.find((item) => item.kind === "delete_file");
    assert.ok(deleteTask, "expected remembered delete task");
    assert.equal(deleteTask.targetPath, "temperature_sensor.ino");
    assert.equal(deleteTask.status, "pending");
  });
}

async function runThreadMemoryVagueDeleteClarificationSmoke() {
  await withTempWorkspace(async ({ workspaceRoot, userDataRoot }) => {
    await fs.writeFile(path.join(workspaceRoot, "temperature_sensor.ino"), "void setup() {}\n", "utf8");

    const events = [];
    const manager = createManager({
      workspaceRoot,
      userDataRoot,
      events,
      executeGatewayRequest: async () => fakeChatCompletion("not-json"),
    });

    const route = await manager.route({
      prompt: "delete this file",
      source: "managed",
      mode: "fast",
      intent: "agent",
      permissionMode: "default",
      threadId: "smoke-memory-vague-delete",
      threadMemory: {
        files: [threadMemoryFile("temperature_sensor.ino", { aliases: ["temperature"] })],
      },
    });

    assert.equal(route.engine, "local");
    assert.equal(route.decisionKind, "clarify");
    assert.match(route.userMessage, /Remembered files/i);
    assert.match(route.userMessage, /temperature_sensor\.ino/);
  });
}

async function runThreadMemoryAmbiguousEditSmoke() {
  await withTempWorkspace(async ({ workspaceRoot, userDataRoot }) => {
    await fs.writeFile(path.join(workspaceRoot, "dc_motor_control.ino"), "void setup() {}\n", "utf8");
    await fs.writeFile(path.join(workspaceRoot, "servo_motor.ino"), "void setup() {}\n", "utf8");

    const events = [];
    const manager = createManager({
      workspaceRoot,
      userDataRoot,
      events,
      executeGatewayRequest: async () => fakeChatCompletion("not-json"),
    });

    const route = await manager.route({
      prompt: "edit the motor file from before",
      source: "managed",
      mode: "fast",
      intent: "agent",
      threadId: "smoke-memory-ambiguous-edit",
      threadMemory: {
        files: [
          threadMemoryFile("dc_motor_control.ino", { aliases: ["motor file", "dc motor"] }),
          threadMemoryFile("servo_motor.ino", { aliases: ["motor file", "servo motor"] }),
        ],
      },
    });

    assert.equal(route.engine, "local");
    assert.equal(route.decisionKind, "clarify");
    assert.match(route.userMessage, /multiple remembered files/i);
    assert.match(route.userMessage, /dc_motor_control\.ino/);
    assert.match(route.userMessage, /servo_motor\.ino/);
  });
}

async function runThreadMemoryRenamedPathSmoke() {
  await withTempWorkspace(async ({ workspaceRoot, userDataRoot }) => {
    await fs.writeFile(path.join(workspaceRoot, "ledblink.ino"), "void setup() {}\n", "utf8");

    const events = [];
    const manager = createManager({
      workspaceRoot,
      userDataRoot,
      events,
      executeGatewayRequest: async () => fakeChatCompletion("not-json"),
    });

    const route = await manager.route({
      prompt: "delete the blink file",
      source: "managed",
      mode: "fast",
      intent: "agent",
      permissionMode: "default",
      threadId: "smoke-memory-renamed-delete",
      threadMemory: {
        files: [
          threadMemoryFile("ledblink.ino", {
            previousPath: "blink.ino",
            aliases: ["blink.ino", "blink file", "led blink"],
            lastAction: "renamed",
          }),
        ],
      },
    });

    assert.equal(route.requiresUserDecision, true);
    const deleteTask = route.taskList.items.find((item) => item.kind === "delete_file");
    assert.ok(deleteTask, "expected remembered renamed delete task");
    assert.equal(deleteTask.targetPath, "ledblink.ino");
  });
}

async function runThreadMemoryDeletedFileSmoke() {
  await withTempWorkspace(async ({ workspaceRoot, userDataRoot }) => {
    const events = [];
    const manager = createManager({
      workspaceRoot,
      userDataRoot,
      events,
      executeGatewayRequest: async () => fakeChatCompletion("not-json"),
    });

    const route = await manager.route({
      prompt: "delete the temperature file",
      source: "managed",
      mode: "fast",
      intent: "agent",
      permissionMode: "default",
      threadId: "smoke-memory-deleted-file",
      threadMemory: {
        files: [
          threadMemoryFile("temperature_sensor.ino", {
            aliases: ["temperature", "temperature file"],
            lastAction: "deleted",
            expectedExists: false,
          }),
        ],
      },
    });

    assert.equal(route.engine, "local");
    assert.equal(route.decisionKind, "clarify");
    assert.match(route.userMessage, /already deleted/i);
    assert.match(route.userMessage, /temperature_sensor\.ino/);
  });
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function runPermissionActivitySmoke() {
  const runtimeSource = await fs.readFile(path.join(__dirname, "..", "src", "agent", "opencodeRuntimeManager.js"), "utf8");
  assert.match(runtimeSource, /permission\.updated/);
  assert.match(runtimeSource, /Permission allowed/);
  assert.match(runtimeSource, /Permission rejected/);
  assert.match(runtimeSource, /#resolveOpenCodePermission/);
  assert.match(runtimeSource, /payload\.permissionMode === "bypass"/);
  assert.match(runtimeSource, /return options\.bypassApprovals \? "always" : "once"/);
  assert.match(runtimeSource, /Bypass Approval enabled/);
  assert.match(runtimeSource, /OPENCODE_BASH_BLOCKED/);
  assert.match(runtimeSource, /bash: "deny"/);
  assert.doesNotMatch(runtimeSource, /bash: "ask"/);
  assert.match(runtimeSource, /String\(part\.tool \|\| ""\)\.toLowerCase\(\) === "bash"/);
  assert.match(runtimeSource, /COMPACT_OUTPUT_STYLE_FALLBACK/);
  assert.match(runtimeSource, /concise, direct, normal English/);
  assert.match(runtimeSource, /tantalum-power/);
  assert.match(runtimeSource, /mode === "power" \? 80 : 50/);
  assert.match(runtimeSource, /mode === "power" \? DEFAULT_OPENCODE_POWER_CONTEXT_WINDOW : DEFAULT_OPENCODE_FAST_CONTEXT_WINDOW/);
  assert.match(runtimeSource, /mode === "power" \? DEFAULT_OPENCODE_POWER_TIMEOUT_MS : DEFAULT_OPENCODE_FAST_TIMEOUT_MS/);
  assert.match(runtimeSource, /Retrying file edit/);
  assert.match(runtimeSource, /buildNoDiffRetryPrompt/);
  assert.match(runtimeSource, /The previous response did not modify any project space files/);
  assert.match(runtimeSource, /did not match the applied agent change after writing/);
  assert.match(runtimeSource, /still exists after the agent delete was applied/);
  assert.doesNotMatch(runtimeSource, /CAVEMAN_OUTPUT_STYLE_FALLBACK/);
  assert.doesNotMatch(runtimeSource, /Caveman mode active/);
}

async function main() {
  await runNormalAskSmoke();
  await runPowerDirectModeSmoke();
  await runHangingGatewaySmoke();
  await runRenameExtensionSmoke();
  await runRenameAndUpdateSmoke();
  await runTypoArticleRouteSmoke();
  await runTypoCommandVerbRouteSmoke();
  await runTypoDeleteRetryUsesPreviousPromptSmoke();
  await runStandaloneRetryDoesNotUseDirectChatSmoke();
  await runApprovedTypoDeleteSketchSmoke();
  await runTypoDeleteAmbiguousSketchSmoke();
  await runUncertainWorkspaceActionClassifierSmoke();
  await runUncertainWorkspaceActionClarificationSmoke();
  await runUncertainWorkspaceActionLowConfidenceSmoke();
  await runActionRepairMoveIntentSmoke();
  await runFastIntentRouterCreateProjectStructureSmoke();
  await runFastIntentRouterQuestionSmoke();
  await runFastIntentRouterLowConfidenceSmoke();
  await runReferentialFollowupSerialEditSmoke();
  await runReferentialFollowupNoActionClarificationSmoke();
  await runReferentialFollowupAmbiguousTargetSmoke();
  await runReferentialFollowupDestructiveApprovalSmoke();
  await runPlannerClarificationActionRepairSmoke();
  await runActiveEditorSuggestionActionRepairSmoke();
  await runActionRepairRejectsCommandOutputSmoke();
  await runClarificationSelectionApprovalSmoke();
  await runClarificationSelectionAmbiguousSmoke();
  await runClarificationSelectionRejectsProseSmoke();
  await runApprovedMixedPromptSmoke();
  await runBulkHelperDeleteKeepInoRouteSmoke();
  await runHeaderFollowupRouteSmoke();
  await runHeaderClarificationSelectionSmoke();
  await runMoveAllInoRouteSmoke();
  await runApprovedMoveAllInoSmoke();
  await runMoveDuplicateDestinationSmoke();
  await runDeleteRootSketchFilesRouteSmoke();
  await runApprovedDeleteRootSketchFilesSmoke();
  await runDeleteRootSketchFilesEmptySmoke();
  await runAmbiguousFuzzyTargetSmoke();
  await runDefaultSketchExtensionSmoke();
  await runPreferredImplicitEditTargetSmoke();
  await runShortFirmwareFollowupTargetSmoke();
  await runPlannerClarificationCreateFallbackSmoke();
  await runPlannerDefaultSketchExtensionSmoke();
  await runPermissionModeRouteSmoke();
  await runThreadMemoryNamedDeleteSmoke();
  await runThreadMemoryVagueDeleteClarificationSmoke();
  await runThreadMemoryAmbiguousEditSmoke();
  await runThreadMemoryRenamedPathSmoke();
  await runThreadMemoryDeletedFileSmoke();
  await runPermissionActivitySmoke();
  console.log("opencode runtime smoke checks passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
