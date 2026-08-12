import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import permissionGateExtension, {
  canonicalizeLocalPath,
  checkPathScope,
  createJasminePermissionGateExtension,
  sanitizePermissionDisplay
} from "../dist/index.js";

function createHarness({
  options,
  flag = "ask",
  hasUI = false,
  select,
  cwd = process.cwd(),
  signal
} = {}) {
  let handler;
  let registeredFlag;
  const pi = {
    getFlag(name) {
      assert.equal(name, "permission-mode");
      return flag;
    },
    on(name, candidate) {
      assert.equal(name, "tool_call");
      handler = candidate;
    },
    registerFlag(name, config) {
      registeredFlag = { name, config };
    }
  };
  const factory = options === undefined
    ? permissionGateExtension
    : createJasminePermissionGateExtension(options);
  factory(pi);
  assert.ok(handler);
  return {
    registeredFlag,
    invoke(event) {
      return handler(event, {
        cwd,
        hasUI,
        mode: hasUI ? "tui" : "print",
        signal,
        ui: {
          select: select ?? (async () => undefined)
        }
      });
    }
  };
}

function bashEvent(command = "git status") {
  return { type: "tool_call", toolCallId: "bash-1", toolName: "bash", input: { command } };
}

function writeEvent(filePath) {
  return {
    type: "tool_call",
    toolCallId: "write-1",
    toolName: "write",
    input: { path: filePath, content: "test" }
  };
}

function editEvent(filePath) {
  return {
    type: "tool_call",
    toolCallId: "edit-1",
    toolName: "edit",
    input: { path: filePath, edits: [] }
  };
}

const nativeScope = (projectRoot, cwd = projectRoot) => ({
  projectRoot,
  cwd,
  pathFlavor: "native"
});

test("default factory registers the Pi CLI flag", () => {
  const harness = createHarness();
  assert.deepEqual(harness.registeredFlag, {
    name: "permission-mode",
    config: {
      type: "string",
      default: "ask",
      description: "Permission mode: ask or full-access"
    }
  });
});

test("full-access bypasses bash and approval callbacks", async () => {
  let approvals = 0;
  const harness = createHarness({
    options: {
      getMode: () => "full-access",
      requestApproval: async () => {
        approvals += 1;
        return "deny";
      }
    }
  });
  assert.equal(await harness.invoke(bashEvent()), undefined);
  assert.equal(approvals, 0);
});

test("ask mode forwards raw bash data but only safe display text", async () => {
  const controller = new AbortController();
  let observed;
  let observedSignal;
  const command = "printf 'ok\\n'\n\u001b[31m\u202eevil";
  const harness = createHarness({
    signal: controller.signal,
    options: {
      getMode: () => "ask",
      getScope: () => nativeScope("C:\\repo"),
      requestApproval: async (request, signal) => {
        observed = request;
        observedSignal = signal;
        return "allow-once";
      }
    }
  });
  assert.equal(await harness.invoke(bashEvent(command)), undefined);
  assert.equal(observed.command, command);
  assert.equal(observed.reason, "bash");
  assert.equal(observed.toolCallId, "bash-1");
  assert.equal(observedSignal, controller.signal);
  assert.doesNotMatch(observed.summary, /[\n\r\u001b\u202e]/u);
  assert.match(observed.summary, /\\n/);
  assert.match(observed.summary, /\\x1b/);
  assert.match(observed.summary, /\\u202e/);
  assert.equal(Object.isFrozen(observed), true);
});

test("explicit denial blocks a bash call", async () => {
  const harness = createHarness({
    options: {
      getScope: () => nativeScope("C:\\repo"),
      requestApproval: async () => "deny"
    }
  });
  const result = await harness.invoke(bashEvent());
  assert.equal(result.block, true);
  assert.match(result.reason, /Permission denied for bash/);
});

test("approval callback exceptions fail closed", async () => {
  const harness = createHarness({
    options: {
      requestApproval: async () => {
        throw new Error("broker unavailable");
      }
    }
  });
  const result = await harness.invoke(bashEvent());
  assert.equal(result.block, true);
  assert.match(result.reason, /failed or was cancelled/);
});

test("invalid approval callback decisions fail closed", async () => {
  const harness = createHarness({
    options: { requestApproval: async () => "always-allow" }
  });
  const result = await harness.invoke(bashEvent());
  assert.equal(result.block, true);
  assert.match(result.reason, /invalid decision/);
});

test("CLI without dialog UI blocks instead of hanging", async () => {
  const harness = createHarness({ hasUI: false });
  const result = await harness.invoke(bashEvent());
  assert.equal(result.block, true);
  assert.match(result.reason, /no interactive UI/);
});

test("CLI dialog permits Allow once and passes the abort signal", async () => {
  const controller = new AbortController();
  let observed;
  const harness = createHarness({
    hasUI: true,
    signal: controller.signal,
    select: async (title, choices, options) => {
      observed = { title, choices, options };
      return "Allow once";
    }
  });
  assert.equal(await harness.invoke(bashEvent("echo hello")), undefined);
  assert.match(observed.title, /^Permission required/);
  assert.deepEqual(observed.choices, ["Allow once", "Deny"]);
  assert.equal(observed.options.signal, controller.signal);
});

test("CLI dialog cancellation denies", async () => {
  const harness = createHarness({ hasUI: true, select: async () => undefined });
  const result = await harness.invoke(bashEvent());
  assert.equal(result.block, true);
});

test("default CLI full-access flag bypasses the gate", async () => {
  const harness = createHarness({ flag: "full-access" });
  assert.equal(await harness.invoke(bashEvent()), undefined);
});

test("invalid modes and failing mode providers fail closed", async (t) => {
  await t.test("invalid mode", async () => {
    const harness = createHarness({ options: { getMode: () => "unsafe" } });
    const result = await harness.invoke(bashEvent());
    assert.equal(result.block, true);
    assert.match(result.reason, /mode is invalid/);
  });
  await t.test("provider failure", async () => {
    const harness = createHarness({ options: { getMode: () => { throw new Error("bad settings"); } } });
    const result = await harness.invoke(bashEvent());
    assert.equal(result.block, true);
    assert.match(result.reason, /mode could not be read/);
  });
});

test("scope provider failures and invalid scopes fail closed", async (t) => {
  await t.test("provider failure", async () => {
    const harness = createHarness({ options: { getScope: () => { throw new Error("gone"); } } });
    const result = await harness.invoke(bashEvent());
    assert.equal(result.block, true);
    assert.match(result.reason, /scope could not be read/);
  });
  await t.test("invalid path flavor", async () => {
    const harness = createHarness({ options: { getScope: () => ({ projectRoot: "/repo", pathFlavor: "url" }) } });
    const result = await harness.invoke(bashEvent());
    assert.equal(result.block, true);
    assert.match(result.reason, /scope could not be read/);
  });
});

test("malformed bash and file inputs are blocked without asking", async (t) => {
  let approvals = 0;
  const harness = createHarness({
    options: {
      getScope: () => ({ projectRoot: null }),
      requestApproval: async () => {
        approvals += 1;
        return "allow-once";
      }
    }
  });
  for (const event of [bashEvent(""), bashEvent("echo\0bad"), writeEvent(" "), editEvent("bad\0path")]) {
    await t.test(`${event.toolName}:${JSON.stringify(event.input)}`, async () => {
      const result = await harness.invoke(event);
      assert.equal(result.block, true);
    });
  }
  assert.equal(approvals, 0);
});

test("read and unrelated tools are not gated", async () => {
  const harness = createHarness({
    options: { getMode: () => { throw new Error("must not be called"); } }
  });
  assert.equal(await harness.invoke({
    type: "tool_call",
    toolCallId: "read-1",
    toolName: "read",
    input: { path: "secret.txt" }
  }), undefined);
  assert.equal(await harness.invoke({
    type: "tool_call",
    toolCallId: "custom-1",
    toolName: "custom_mutator",
    input: {}
  }), undefined);
});

test("native local writes and edits inside a project do not prompt", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-permission-inside-"));
  try {
    await mkdir(path.join(root, "nested"));
    let approvals = 0;
    const harness = createHarness({
      cwd: root,
      options: {
        getScope: () => nativeScope(root),
        requestApproval: async () => {
          approvals += 1;
          return "deny";
        }
      }
    });
    await t.test("write missing descendant", async () => {
      assert.equal(await harness.invoke(writeEvent(path.join("nested", "new.txt"))), undefined);
    });
    await t.test("edit existing lexical target", async () => {
      assert.equal(await harness.invoke(editEvent(path.join("nested", "existing.txt"))), undefined);
    });
    assert.equal(approvals, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("native paths outside the project require approval", async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "pi-permission-outside-"));
  const root = path.join(parent, "repo");
  await mkdir(root);
  try {
    const requests = [];
    const harness = createHarness({
      cwd: root,
      options: {
        getScope: () => nativeScope(root),
        requestApproval: async (request) => {
          requests.push(request);
          return "allow-once";
        }
      }
    });
    await t.test("parent traversal", async () => {
      assert.equal(await harness.invoke(writeEvent(path.join("..", "outside.txt"))), undefined);
    });
    await t.test("prefix collision", async () => {
      assert.equal(await harness.invoke(editEvent(`${root}-evil${path.sep}file.txt`)), undefined);
    });
    assert.deepEqual(requests.map((request) => request.reason), ["outside-project", "outside-project"]);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("no-project mutations always require approval", async () => {
  const requests = [];
  const harness = createHarness({
    cwd: path.parse(process.cwd()).root,
    options: {
      getScope: () => ({ projectRoot: null, cwd: process.cwd(), pathFlavor: "native" }),
      requestApproval: async (request) => {
        requests.push(request);
        return "allow-once";
      }
    }
  });
  assert.equal(await harness.invoke(writeEvent("inside-looking.txt")), undefined);
  assert.equal(await harness.invoke(editEvent("inside-looking.txt")), undefined);
  assert.deepEqual(requests.map((request) => request.reason), ["no-project", "no-project"]);
});

test("POSIX scope permits canonical targets inside the project", async () => {
  let approvals = 0;
  const harness = createHarness({
    options: {
      getScope: () => ({
        projectRoot: "/srv/repo",
        cwd: "/srv/repo/subdir",
        pathFlavor: "posix"
      }),
      canonicalizePath: ({ path: candidate }) => candidate,
      requestApproval: async () => {
        approvals += 1;
        return "deny";
      }
    }
  });
  assert.equal(await harness.invoke(writeEvent("new.txt")), undefined);
  assert.equal(approvals, 0);
});

test("POSIX traversal outside the project asks for approval", async () => {
  let request;
  const harness = createHarness({
    options: {
      getScope: () => ({
        projectRoot: "/srv/repo",
        cwd: "/srv/repo",
        pathFlavor: "posix"
      }),
      canonicalizePath: ({ path: candidate }) => candidate,
      requestApproval: async (candidate) => {
        request = candidate;
        return "allow-once";
      }
    }
  });
  assert.equal(await harness.invoke(writeEvent("../outside.txt")), undefined);
  assert.equal(request.reason, "outside-project");
});

test("POSIX scope without a canonical resolver asks instead of trusting lexical scope", async () => {
  let request;
  const harness = createHarness({
    options: {
      getScope: () => ({
        projectRoot: "/srv/repo",
        cwd: "/srv/repo",
        pathFlavor: "posix"
      }),
      requestApproval: async (candidate) => {
        request = candidate;
        return "allow-once";
      }
    }
  });
  assert.equal(await harness.invoke(editEvent("inside.txt")), undefined);
  assert.equal(request.reason, "canonicalization-failed");
});

test("canonical symlink escape requires approval even when lexical path is inside", async () => {
  let request;
  const harness = createHarness({
    options: {
      getScope: () => ({
        projectRoot: "/srv/repo",
        cwd: "/srv/repo",
        pathFlavor: "posix"
      }),
      canonicalizePath: ({ kind }) => kind === "project-root" ? "/real/repo" : "/etc/passwd",
      requestApproval: async (candidate) => {
        request = candidate;
        return "allow-once";
      }
    }
  });
  assert.equal(await harness.invoke(editEvent("link/passwd")), undefined);
  assert.equal(request.reason, "outside-project");
});

test("canonical resolver failures and relative results require approval", async (t) => {
  const scope = () => ({
    projectRoot: "/srv/repo",
    cwd: "/srv/repo",
    pathFlavor: "posix"
  });
  await t.test("exception", async () => {
    let request;
    const harness = createHarness({
      options: {
        getScope: scope,
        canonicalizePath: () => { throw new Error("offline"); },
        requestApproval: async (candidate) => {
          request = candidate;
          return "allow-once";
        }
      }
    });
    assert.equal(await harness.invoke(writeEvent("file.txt")), undefined);
    assert.equal(request.reason, "canonicalization-failed");
  });
  await t.test("relative result", async () => {
    let request;
    const harness = createHarness({
      options: {
        getScope: scope,
        canonicalizePath: () => "relative/path",
        requestApproval: async (candidate) => {
          request = candidate;
          return "allow-once";
        }
      }
    });
    assert.equal(await harness.invoke(editEvent("file.txt")), undefined);
    assert.equal(request.reason, "canonicalization-failed");
  });
});

test("checkPathScope rejects a non-absolute trusted root", async () => {
  const result = await checkPathScope({
    rawPath: "file.txt",
    toolName: "write",
    scope: {
      projectRoot: "relative/repo",
      cwd: "relative/repo",
      pathFlavor: "posix"
    },
    canonicalizePath: ({ path: candidate }) => candidate
  });
  assert.equal(result.status, "canonicalization-failed");
});

test("canonicalizeLocalPath resolves a missing descendant through its existing ancestor", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-permission-canonical-"));
  try {
    const expected = path.join(await canonicalizeLocalPath(root), "missing", "file.txt");
    assert.equal(await canonicalizeLocalPath(path.join(root, "missing", "file.txt")), expected);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("display sanitizer escapes control and bidi characters and bounds output", () => {
  const unsafe = `a\n\r\t\u001b\u0085\u061c\u200b\u2028\u202e${"x".repeat(200)}`;
  const result = sanitizePermissionDisplay(unsafe, 80);
  assert.equal(result.length, 80);
  assert.doesNotMatch(result, /[\n\r\t\u001b\u0085\u061c\u200b\u2028\u202e]/u);
  assert.match(result, /\\n/);
  assert.match(result, /truncated/);
  assert.equal(sanitizePermissionDisplay("x".repeat(100), 12).length, 12);
});
