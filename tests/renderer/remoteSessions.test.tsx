import { useState, type ReactNode } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type {
  RemoteDoctorReport,
  RemoteProfileStatus,
  RemoteProfileSummary,
  RemoteSessionSummary,
  RemoteSessionStartResult,
  RemoteSessionTranscript,
  RemoteWorkspace
} from "../../src/shared/ipc";
import { RemoteSessionPage } from "../../src/renderer/components/remote/RemoteSessionPage";
import { RemoteTree } from "../../src/renderer/components/remote/RemoteTree";
import { RemoteSettingsPage } from "../../src/renderer/components/settings/RemoteSettingsPage";
import { useRemotes } from "../../src/renderer/hooks/useRemotes";
import { I18nProvider } from "../../src/renderer/i18n";
import { installFakeBridge, type FakeBridge } from "./fakeBridge";

function withI18n(children: ReactNode) {
  return <I18nProvider language="en">{children}</I18nProvider>;
}

const DIRECT: RemoteProfileSummary = {
  id: "profile-direct",
  name: "ops-box",
  sshHost: "ops-box",
  sshPort: null,
  defaultCwd: "/srv/application",
  networkMode: "remote-direct",
  noProxy: [],
  allowedPorts: [80, 443],
  upstreamProxyEnv: null,
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z"
};

// The same machine with the client proxy on is a second profile with its own
// remote directory, which is exactly the distinction the tree has to show.
const PROXIED: RemoteProfileSummary = {
  ...DIRECT,
  id: "profile-proxied",
  name: "ops-box-proxied",
  networkMode: "client-proxy"
};

const WORKSPACE: RemoteWorkspace = {
  id: "workspace-1",
  profileId: DIRECT.id,
  cwd: "/srv/application",
  name: "application",
  pinned: false,
  source: "discovered",
  isDefaultCwd: true,
  sessionCount: 2,
  latestSessionAt: "2026-08-19T10:00:00.000Z",
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-19T10:00:00.000Z"
};

function session(overrides: Partial<RemoteSessionSummary> & { sessionId: string }): RemoteSessionSummary {
  return {
    profileId: DIRECT.id,
    cwd: "/srv/application",
    title: overrides.sessionId,
    name: null,
    preview: null,
    turnCount: 3,
    remoteCreatedAt: "2026-08-18T09:00:00.000Z",
    remoteUpdatedAt: "2026-08-19T10:00:00.000Z",
    remoteSizeBytes: 4096,
    cachedBytes: 0,
    state: "remote",
    listedAt: "2026-08-19T10:00:00.000Z",
    ...overrides
  };
}

function transcript(overrides: Partial<RemoteSessionTranscript> & { sessionId: string }): RemoteSessionTranscript {
  return {
    profileId: DIRECT.id,
    title: overrides.sessionId,
    cwd: "/srv/application",
    state: "cached",
    entries: [
      { id: "e1", kind: "user", timestamp: "2026-08-18T09:00:00.000Z", text: "refactor the auth middleware", toolName: null, appended: false }
    ],
    omittedEntryCount: 0,
    cachedBytes: 4096,
    remoteSizeBytes: 4096,
    fetchedBytes: 0,
    refetched: false,
    syncedAt: "2026-08-19T10:00:00.000Z",
    ...overrides
  };
}

function status(state: RemoteProfileStatus["state"]): RemoteProfileStatus {
  return {
    profileId: DIRECT.id,
    state,
    message: null,
    errorCode: null,
    remediation: null,
    runtimeVersion: null,
    piVersion: null,
    checkedAt: "2026-08-19T10:00:00.000Z",
    busy: false,
    sessionOperation: null
  };
}

let fake: FakeBridge;

afterEach(() => {
  vi.useRealTimers();
});

/** Mounts the tree against the hook, the way the shell composes them. */
function TreeHarness(props: { onOpenSession?(profileId: string, sessionId: string): void }) {
  const remotes = useRemotes({ onError: () => {}, onToast: () => {} });
  return (
    <RemoteTree
      hostGroups={remotes.hostGroups}
      workspaces={remotes.workspaces}
      sessions={remotes.sessions}
      statuses={remotes.statuses}
      refreshingProfileIds={remotes.refreshingProfileIds}
      activeProfileId={null}
      activeSessionId={null}
      onAddProfile={() => {}}
      onExpandProfile={(profileId) => void remotes.openProfile(profileId)}
      onRefreshProfile={(profileId) => void remotes.refreshSessions(profileId, { force: true })}
      onOpenProfileSettings={() => {}}
      onCheckProfile={() => {}}
      onAddWorkspace={() => {}}
      onRemoveWorkspace={() => {}}
      onToggleWorkspacePinned={() => {}}
      onOpenWorkspace={() => {}}
      onOpenSession={(profileId, sessionId) => props.onOpenSession?.(profileId, sessionId)}
    />
  );
}

describe("remote tree", () => {
  test("groups profiles under one host and names each egress mode", async () => {
    fake = installFakeBridge();
    fake.setRemoteState({
      profiles: [DIRECT, PROXIED],
      workspaces: [WORKSPACE],
      statuses: [status("ready")]
    });

    render(withI18n(<TreeHarness />));

    const host = await screen.findByRole("button", { name: /Expand host ops-box/ });
    fireEvent.click(host);

    // One host row, two profiles, each named and labelled by how it reaches the
    // network. The tree column is narrow, so the egress keeps its short form.
    const direct = screen.getByTitle(`${DIRECT.name} · ${DIRECT.sshHost}`);
    const proxied = screen.getByTitle(`${PROXIED.name} · ${PROXIED.sshHost}`);
    expect(direct.textContent).toContain("Direct");
    expect(proxied.textContent).toContain("Proxied");
    expect(screen.getByText("2 profiles")).toBeDefined();
  });

  test("two profiles sharing a host and an egress mode are still told apart", async () => {
    fake = installFakeBridge();
    // Nothing stops one host from having two direct profiles, and they own
    // separate remote trees, so rows carrying only the egress would be
    // identical for two histories that cannot see each other.
    const second: RemoteProfileSummary = { ...DIRECT, id: "profile-second", name: "ops-box-staging" };
    fake.setRemoteState({ profiles: [DIRECT, second], workspaces: [], statuses: [] });

    render(withI18n(<TreeHarness />));
    fireEvent.click(await screen.findByRole("button", { name: /Expand host ops-box/ }));

    expect(screen.getByTitle(`${DIRECT.name} · ${DIRECT.sshHost}`).textContent).toContain(DIRECT.name);
    expect(screen.getByTitle(`${second.name} · ${second.sshHost}`).textContent).toContain(second.name);
  });

  test("expanding a profile shows stored sessions before any refresh answers", async () => {
    fake = installFakeBridge();
    // A refresh that never settles stands in for a slow or unreachable host.
    const pending = new Promise<RemoteSessionSummary[]>(() => {});
    fake.setRemoteState({
      profiles: [DIRECT],
      workspaces: [WORKSPACE],
      statuses: [status("ready")],
      sessions: { [DIRECT.id]: [session({ sessionId: "session-a", title: "fix CI cache", state: "cached", cachedBytes: 4096 })] }
    });
    const originalRefresh = fake.bridge.refreshRemoteSessions;
    fake.bridge.refreshRemoteSessions = () => pending;

    render(withI18n(<TreeHarness />));

    fireEvent.click(await screen.findByRole("button", { name: /Expand host ops-box/ }));
    fireEvent.click(await screen.findByRole("button", { name: /Expand profile ops-box/ }));
    fireEvent.click(await screen.findByRole("button", { name: /Expand workspace application/ }));

    // The stored row is on screen even though the network call is still open.
    expect(await screen.findByRole("button", { name: "Open session fix CI cache" })).toBeDefined();
    expect(screen.getByText("Local copy")).toBeDefined();
    fake.bridge.refreshRemoteSessions = originalRefresh;
  });

  test("a session refresh is time-boxed per profile and forced by the refresh control", async () => {
    fake = installFakeBridge();
    fake.setRemoteState({
      profiles: [DIRECT],
      workspaces: [WORKSPACE],
      statuses: [status("ready")],
      sessions: { [DIRECT.id]: [session({ sessionId: "session-a" })] }
    });

    render(withI18n(<TreeHarness />));
    const host = await screen.findByRole("button", { name: /Expand host ops-box/ });
    fireEvent.click(host);
    const expand = await screen.findByRole("button", { name: /Expand profile ops-box/ });

    fireEvent.click(expand);
    await waitFor(() => expect(fake.calls.refreshRemoteSessions).toEqual([DIRECT.id]));

    // Collapsing and expanding again inside the window must not repeat the SSH
    // round trip; the stored rows are still current enough.
    fireEvent.click(await screen.findByRole("button", { name: /Collapse profile ops-box/ }));
    fireEvent.click(await screen.findByRole("button", { name: /Expand profile ops-box/ }));
    await waitFor(() => expect(fake.calls.listRemoteSessions.length).toBeGreaterThan(1));
    expect(fake.calls.refreshRemoteSessions).toEqual([DIRECT.id]);

    fireEvent.click(screen.getByRole("button", { name: "Refresh sessions" }));
    await waitFor(() => expect(fake.calls.refreshRemoteSessions).toEqual([DIRECT.id, DIRECT.id]));
  });
});

describe("remote profile actions", () => {
  test("a stop that did not stop anything is reported as a failure", async () => {
    fake = installFakeBridge();
    fake.setRemoteState({ profiles: [DIRECT], statuses: [] });
    // The service catches a failed stop and resolves with a failed status rather
    // than rejecting, so the returned state is the only honest signal.
    fake.bridge.stopRemoteProfile = async () => ({
      ...status("failed"),
      message: "The remote daemon did not answer."
    });

    const errors: string[] = [];
    const toasts: string[] = [];
    let stopped: boolean | null = null;

    function Harness() {
      const remotes = useRemotes({
        onError: (message) => errors.push(message),
        onToast: (message) => toasts.push(message)
      });
      return (
        <button type="button" onClick={() => void remotes.stopProfile(DIRECT.id).then((result) => { stopped = result; })}>
          {"stop"}
        </button>
      );
    }

    render(withI18n(<Harness />));
    fireEvent.click(screen.getByRole("button", { name: "stop" }));

    await waitFor(() => expect(stopped).toBe(false));
    expect(errors).toEqual(["The remote daemon did not answer."]);
    expect(toasts).toEqual([]);
  });

  test("a check that lands after another profile is selected does not describe it", async () => {
    let answerDirect: ((report: RemoteDoctorReport) => void) | null = null;
    const onCheck = async (profileId: string) => (profileId === DIRECT.id
      ? new Promise<RemoteDoctorReport>((resolve) => { answerDirect = resolve; })
      : doctorReport(profileId, `${profileId} answered`));

    function Harness() {
      const [selectedProfileId, setSelectedProfileId] = useState<string | null>(DIRECT.id);
      return (
        <RemoteSettingsPage
          profiles={[DIRECT, PROXIED]}
          workspaces={[]}
          statuses={{}}
          selectedProfileId={selectedProfileId}
          onSelectProfile={setSelectedProfileId}
          onAddProfile={() => {}}
          onAddWorkspace={() => {}}
          onRemoveProfile={async () => {}}
          onCheck={onCheck}
          onInstall={async () => true}
          onStop={async () => true}
        />
      );
    }

    render(withI18n(<Harness />));
    fireEvent.click(screen.getByRole("button", { name: "Run check" }));
    // The profile list stays usable while a check runs, so its answer can arrive
    // for a host that is no longer the one on screen.
    fireEvent.click(screen.getByText(PROXIED.name));
    await act(async () => {
      answerDirect?.(doctorReport(DIRECT.id, `${DIRECT.id} answered`));
    });

    expect(screen.queryByText(`${DIRECT.id} answered`)).toBeNull();
    expect(screen.getByText("Not run yet")).toBeTruthy();
  });
});

function doctorReport(profileId: string, message: string): RemoteDoctorReport {
  return {
    profileId,
    ok: true,
    checks: [{ id: "ssh", status: "pass", message }],
    checkedAt: "2026-08-19T10:00:00.000Z"
  };
}

/** Mounts the reader with a selection the test drives, as the route does. */
function PageHarness(props: { initialSessionId: string | null; sessions: RemoteSessionSummary[] }) {
  const remotes = useRemotes({ onError: () => {}, onToast: () => {} });
  const [selected, setSelected] = useState<string | null>(props.initialSessionId);
  return (
    <RemoteSessionPage
      profile={DIRECT}
      workspace={WORKSPACE}
      cwd={WORKSPACE.cwd}
      status={remotes.statuses[DIRECT.id]}
      sessions={remotes.sessions[DIRECT.id] ?? props.sessions}
      activeSessionId={selected}
      refreshing={false}
      onRefresh={() => void remotes.refreshSessions(DIRECT.id, { force: true })}
      onSelectSession={setSelected}
      onOpenSession={(sessionId, options) => remotes.openSession(DIRECT.id, sessionId, options)}
      onBeginSession={() => setSelected(null)}
      onStartSession={(text) => remotes.startSession(DIRECT.id, WORKSPACE.cwd, text)}
      onPromptSession={(sessionId, text) => remotes.promptSession(DIRECT.id, sessionId, text)}
      onAbortSession={(sessionId) => remotes.abortSession(DIRECT.id, sessionId)}
    />
  );
}

describe("remote session reader", () => {
  test("a completed first prompt never pulls the user back after the workspace unmounts", async () => {
    const created = session({ sessionId: "created-after-leave", title: "remote work" });
    const started: RemoteSessionStartResult = {
      session: created,
      transcript: transcript({ sessionId: created.sessionId, title: created.title })
    };
    let resolveStart!: (result: RemoteSessionStartResult | null) => void;
    const onSelectSession = vi.fn();
    const view = render(withI18n(
      <RemoteSessionPage
        profile={DIRECT}
        workspace={WORKSPACE}
        cwd={WORKSPACE.cwd}
        status={status("ready")}
        sessions={[]}
        activeSessionId={null}
        refreshing={false}
        onRefresh={() => {}}
        onSelectSession={onSelectSession}
        onOpenSession={async () => null}
        onBeginSession={() => {}}
        onStartSession={() => new Promise((resolve) => { resolveStart = resolve; })}
        onPromptSession={async () => null}
        onAbortSession={async () => true}
      />
    ));
    fireEvent.click(screen.getAllByRole("button", { name: "New session" })[0]!);
    fireEvent.change(screen.getByRole("textbox", { name: "Remote prompt" }), { target: { value: "long remote task" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    view.unmount();

    await act(async () => { resolveStart(started); });
    expect(onSelectSession).not.toHaveBeenCalled();
  });

  test("switching remote workspaces clears stale run controls without aborting the old prompt", async () => {
    const created = session({ sessionId: "created-in-old-workspace", title: "remote work" });
    const started: RemoteSessionStartResult = {
      session: created,
      transcript: transcript({ sessionId: created.sessionId, title: created.title })
    };
    let resolveStart!: (result: RemoteSessionStartResult | null) => void;
    const onSelectSession = vi.fn();
    const common = {
      profile: DIRECT,
      status: status("ready"),
      sessions: [] as RemoteSessionSummary[],
      activeSessionId: null,
      refreshing: false,
      onRefresh: () => {},
      onSelectSession,
      onOpenSession: async () => null,
      onBeginSession: () => {},
      onStartSession: () => new Promise<RemoteSessionStartResult | null>((resolve) => { resolveStart = resolve; }),
      onPromptSession: async () => null,
      onAbortSession: async () => true
    };
    const view = render(withI18n(
      <RemoteSessionPage {...common} workspace={WORKSPACE} cwd={WORKSPACE.cwd} />
    ));
    fireEvent.click(screen.getAllByRole("button", { name: "New session" })[0]!);
    fireEvent.change(screen.getByRole("textbox", { name: "Remote prompt" }), { target: { value: "long remote task" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByRole("button", { name: "Stop" })).toBeDefined();

    const otherWorkspace: RemoteWorkspace = { ...WORKSPACE, id: "workspace-2", cwd: "/srv/other", name: "other" };
    view.rerender(withI18n(
      <RemoteSessionPage {...common} workspace={otherWorkspace} cwd={otherWorkspace.cwd} />
    ));

    await waitFor(() => expect(screen.queryByRole("button", { name: "Stop" })).toBeNull());
    expect(screen.queryByRole("textbox", { name: "Remote prompt" })).toBeNull();
    expect(screen.getAllByRole("button", { name: "New session" })[0]).toHaveProperty("disabled", false);
    await act(async () => { resolveStart(started); });
    expect(onSelectSession).not.toHaveBeenCalled();
  });

  test("a detached remote prompt remains discoverable and stoppable after returning to its workspace", async () => {
    const onAbortSession = vi.fn(async () => true);
    render(withI18n(
      <RemoteSessionPage
        profile={DIRECT}
        workspace={WORKSPACE}
        cwd={WORKSPACE.cwd}
        status={{
          ...status("ready"),
          sessionOperation: {
            sessionId: "detached-session",
            cwd: WORKSPACE.cwd,
            state: "reconnecting"
          }
        }}
        sessions={[]}
        activeSessionId={null}
        refreshing={false}
        onRefresh={() => {}}
        onSelectSession={() => {}}
        onOpenSession={async () => null}
        onBeginSession={() => {}}
        onStartSession={async () => null}
        onPromptSession={async () => null}
        onAbortSession={onAbortSession}
      />
    ));

    expect(screen.getByText("Reconnecting to remote work")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(onAbortSession).toHaveBeenCalledWith("detached-session"));
  });

  test("an accepted first prompt is not restored when post-settlement session sync is pending", async () => {
    const onSelectSession = vi.fn();
    render(withI18n(
      <RemoteSessionPage
        profile={DIRECT}
        workspace={WORKSPACE}
        cwd={WORKSPACE.cwd}
        status={status("ready")}
        sessions={[]}
        activeSessionId={null}
        refreshing={false}
        onRefresh={() => {}}
        onSelectSession={onSelectSession}
        onOpenSession={async () => null}
        onBeginSession={() => {}}
        onStartSession={async () => ({ pending: true, sessionId: "accepted-session" })}
        onPromptSession={async () => null}
        onAbortSession={async () => true}
      />
    ));

    fireEvent.click(screen.getAllByRole("button", { name: "New session" })[0]!);
    fireEvent.change(screen.getByRole("textbox", { name: "Remote prompt" }), { target: { value: "do not submit me twice" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(screen.queryByRole("textbox", { name: "Remote prompt" })).toBeNull());
    expect(onSelectSession).not.toHaveBeenCalled();
    expect(screen.queryByDisplayValue("do not submit me twice")).toBeNull();
  });

  test("an accepted existing-session prompt is not restored when transcript sync is pending", async () => {
    const row = session({ sessionId: "accepted-existing", title: "remote work" });
    render(withI18n(
      <RemoteSessionPage
        profile={DIRECT}
        workspace={WORKSPACE}
        cwd={WORKSPACE.cwd}
        status={status("ready")}
        sessions={[row]}
        activeSessionId={row.sessionId}
        refreshing={false}
        onRefresh={() => {}}
        onSelectSession={() => {}}
        onOpenSession={async () => transcript({ sessionId: row.sessionId, title: row.title })}
        onBeginSession={() => {}}
        onStartSession={async () => null}
        onPromptSession={async () => ({ pending: true, sessionId: row.sessionId })}
        onAbortSession={async () => true}
      />
    ));

    await screen.findByText("refactor the auth middleware");
    const prompt = screen.getByRole("textbox", { name: "Remote prompt" }) as HTMLTextAreaElement;
    fireEvent.change(prompt, { target: { value: "do not repeat this turn" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(prompt.value).toBe(""));
    expect(screen.queryByDisplayValue("do not repeat this turn")).toBeNull();
  });

  test("a prompt rejected before acceptance remains in the draft for retry", async () => {
    render(withI18n(
      <RemoteSessionPage
        profile={DIRECT}
        workspace={WORKSPACE}
        cwd={WORKSPACE.cwd}
        status={status("ready")}
        sessions={[]}
        activeSessionId={null}
        refreshing={false}
        onRefresh={() => {}}
        onSelectSession={() => {}}
        onOpenSession={async () => null}
        onBeginSession={() => {}}
        onStartSession={async () => null}
        onPromptSession={async () => null}
        onAbortSession={async () => true}
      />
    ));

    fireEvent.click(screen.getAllByRole("button", { name: "New session" })[0]!);
    fireEvent.change(screen.getByRole("textbox", { name: "Remote prompt" }), { target: { value: "retry after opening fails" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(await screen.findByDisplayValue("retry after opening fails")).toBeDefined();
  });

  test("an empty workspace creates a real session and can run its first prompt", async () => {
    fake = installFakeBridge();
    fake.setRemoteState({
      profiles: [DIRECT],
      workspaces: [{ ...WORKSPACE, sessionCount: 0 }],
      statuses: [status("ready")],
      sessions: { [DIRECT.id]: [] }
    });

    const view = render(withI18n(<PageHarness initialSessionId={null} sessions={[]} />));
    const header = view.container.querySelector(".remote-page-header") as HTMLElement;
    fireEvent.click(within(header).getByRole("button", { name: "New session" }));

    const prompt = screen.getByRole("textbox", { name: "Remote prompt" });
    fireEvent.change(prompt, { target: { value: "inspect the remote workspace" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(fake.calls.startRemoteSession).toEqual([{
      profileId: DIRECT.id,
      cwd: WORKSPACE.cwd,
      text: "inspect the remote workspace"
    }]));
    expect(await screen.findByText("Remote response complete.")).toBeDefined();
  });

  test("a completed first prompt stays accepted when the hook's workspace refresh fails", async () => {
    fake = installFakeBridge();
    fake.setRemoteState({
      profiles: [DIRECT],
      workspaces: [{ ...WORKSPACE, sessionCount: 0 }],
      statuses: [status("ready")],
      sessions: { [DIRECT.id]: [] }
    });
    const originalStart = fake.bridge.startRemoteSession;
    fake.bridge.startRemoteSession = async (request) => {
      const result = await originalStart(request);
      fake.bridge.listRemoteWorkspaces = async () => { throw new Error("projection refresh failed"); };
      return result;
    };

    const view = render(withI18n(<PageHarness initialSessionId={null} sessions={[]} />));
    fireEvent.click(within(view.container.querySelector(".remote-page-header") as HTMLElement).getByRole("button", { name: "New session" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Remote prompt" }), { target: { value: "accepted first turn" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(await screen.findByText("Remote response complete.")).toBeDefined();
    expect(screen.queryByDisplayValue("accepted first turn")).toBeNull();
  });

  test("a completed existing-session prompt stays accepted when the hook's workspace refresh fails", async () => {
    fake = installFakeBridge();
    const row = session({ sessionId: "session-sync-warning", title: "remote work" });
    fake.setRemoteState({
      profiles: [DIRECT],
      workspaces: [WORKSPACE],
      statuses: [status("ready")],
      sessions: { [DIRECT.id]: [row] },
      transcripts: { [row.sessionId]: transcript({ sessionId: row.sessionId, title: row.title }) }
    });
    const originalPrompt = fake.bridge.promptRemoteSession;
    fake.bridge.promptRemoteSession = async (request) => {
      const result = await originalPrompt(request);
      fake.bridge.listRemoteWorkspaces = async () => { throw new Error("projection refresh failed"); };
      return result;
    };

    render(withI18n(<PageHarness initialSessionId={row.sessionId} sessions={[row]} />));
    await screen.findByText("refactor the auth middleware");
    const prompt = screen.getByRole("textbox", { name: "Remote prompt" }) as HTMLTextAreaElement;
    fireEvent.change(prompt, { target: { value: "accepted existing turn" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(await screen.findByText("Remote response complete.")).toBeDefined();
    expect(prompt.value).toBe("");
  });

  test("an active remote prompt exposes an explicit stop action", async () => {
    fake = installFakeBridge();
    const row = session({ sessionId: "session-running", title: "remote work" });
    fake.setRemoteState({
      profiles: [DIRECT],
      workspaces: [WORKSPACE],
      statuses: [status("ready")],
      sessions: { [DIRECT.id]: [row] },
      transcripts: { "session-running": transcript({ sessionId: "session-running", title: "remote work" }) }
    });
    fake.bridge.promptRemoteSession = async (request) => {
      fake.calls.promptRemoteSession.push(request);
      return new Promise<RemoteSessionTranscript>(() => {});
    };

    render(withI18n(<PageHarness initialSessionId="session-running" sessions={[row]} />));
    await screen.findByText("refactor the auth middleware");
    fireEvent.change(screen.getByRole("textbox", { name: "Remote prompt" }), { target: { value: "long remote task" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    fireEvent.click(await screen.findByRole("button", { name: "Stop" }));

    await waitFor(() => expect(fake.calls.abortRemoteSession).toEqual([{
      profileId: DIRECT.id,
      sessionId: "session-running"
    }]));
  });

  test("a cached session opens from the local copy and reports no fetch", async () => {
    fake = installFakeBridge();
    const cached = session({ sessionId: "session-cached", title: "fix CI cache", state: "cached", cachedBytes: 4096 });
    fake.setRemoteState({
      profiles: [DIRECT],
      workspaces: [WORKSPACE],
      statuses: [status("ready")],
      sessions: { [DIRECT.id]: [cached] },
      transcripts: { "session-cached": transcript({ sessionId: "session-cached", title: "fix CI cache" }) }
    });

    render(withI18n(<PageHarness initialSessionId="session-cached" sessions={[cached]} />));

    expect(await screen.findByText("refactor the auth middleware")).toBeDefined();
    // The rendered clock follows the viewer's timezone, so this asserts that the
    // sync line reports a time rather than a fetch, not which time it prints.
    expect(screen.getByText(/^Synced \w/u)).toBeDefined();
    expect(fake.calls.openRemoteSession).toEqual([{ profileId: DIRECT.id, sessionId: "session-cached" }]);
  });

  test("a session the remote has grown reports what the incremental read fetched", async () => {
    fake = installFakeBridge();
    const stale = session({ sessionId: "session-stale", title: "add e2e cases", state: "stale", cachedBytes: 2_411_008 });
    fake.setRemoteState({
      profiles: [DIRECT],
      workspaces: [WORKSPACE],
      statuses: [status("ready")],
      sessions: { [DIRECT.id]: [stale] },
      transcripts: {
        "session-stale": transcript({
          sessionId: "session-stale",
          title: "add e2e cases",
          fetchedBytes: 62_464,
          cachedBytes: 2_473_472,
          entries: [
            { id: "old", kind: "user", timestamp: null, text: "earlier turn", toolName: null, appended: false },
            { id: "new", kind: "assistant", timestamp: null, text: "the newly fetched tail", toolName: null, appended: true }
          ]
        })
      }
    });

    render(withI18n(<PageHarness initialSessionId="session-stale" sessions={[stale]} />));

    // Only the tail was fetched, and the rows that arrived say so.
    expect(await screen.findByText("Fetched 61 KB")).toBeDefined();
    const appended = screen.getByText("the newly fetched tail").closest("article");
    expect(appended?.className).toContain("appended");
    expect(within(appended as HTMLElement).getByText("New")).toBeDefined();
    expect(screen.getByText("earlier turn").closest("article")?.className).not.toContain("appended");
  });

  test("a session removed on the host stays readable and cannot be downloaded again", async () => {
    fake = installFakeBridge();
    const gone = session({ sessionId: "session-gone", title: "clean up logs", state: "gone", cachedBytes: 1024 });
    fake.setRemoteState({
      profiles: [DIRECT],
      workspaces: [WORKSPACE],
      statuses: [status("ready")],
      sessions: { [DIRECT.id]: [gone] },
      transcripts: { "session-gone": transcript({ sessionId: "session-gone", title: "clean up logs", state: "gone" }) }
    });

    render(withI18n(<PageHarness initialSessionId="session-gone" sessions={[gone]} />));

    expect(await screen.findByText("This session no longer exists on the host. The local copy is read-only.")).toBeDefined();
    expect(screen.getByRole("button", { name: "Download again" })).toHaveProperty("disabled", true);
  });

  test("downloading again asks for a full refetch rather than an incremental read", async () => {
    fake = installFakeBridge();
    const cached = session({ sessionId: "session-cached", title: "fix CI cache", state: "cached", cachedBytes: 4096 });
    fake.setRemoteState({
      profiles: [DIRECT],
      workspaces: [WORKSPACE],
      statuses: [status("ready")],
      sessions: { [DIRECT.id]: [cached] },
      transcripts: { "session-cached": transcript({ sessionId: "session-cached", title: "fix CI cache" }) }
    });

    render(withI18n(<PageHarness initialSessionId="session-cached" sessions={[cached]} />));
    await screen.findByText("refactor the auth middleware");

    fireEvent.click(screen.getByRole("button", { name: "Download again" }));

    await waitFor(() => expect(fake.calls.openRemoteSession.at(-1)).toEqual({
      profileId: DIRECT.id,
      sessionId: "session-cached",
      refetch: true
    }));
  });

  test("selecting another session stops showing the previous one", async () => {
    fake = installFakeBridge();
    const cached = session({ sessionId: "session-cached", title: "fix CI cache", state: "cached", cachedBytes: 4096 });
    const slow = session({ sessionId: "session-slow", title: "migrate Postgres" });
    fake.setRemoteState({
      profiles: [DIRECT],
      workspaces: [WORKSPACE],
      statuses: [status("ready")],
      sessions: { [DIRECT.id]: [cached, slow] },
      transcripts: { "session-cached": transcript({ sessionId: "session-cached", title: "fix CI cache" }) }
    });
    // The second session never answers, which is what a slow link looks like.
    const original = fake.bridge.openRemoteSession;
    fake.bridge.openRemoteSession = (request) => request.sessionId === "session-slow"
      ? new Promise(() => {})
      : original(request);

    render(withI18n(<PageHarness initialSessionId="session-cached" sessions={[cached, slow]} />));
    expect(await screen.findByText("refactor the auth middleware")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Open session migrate Postgres" }));

    await waitFor(() => expect(screen.queryByText("refactor the auth middleware")).toBeNull());
    expect(screen.getByText("Opening the session")).toBeDefined();
    fake.bridge.openRemoteSession = original;
  });

  test("an open that fails reaches a terminal state that can be retried", async () => {
    fake = installFakeBridge();
    const row = session({ sessionId: "session-unreachable", title: "migrate Postgres" });
    fake.setRemoteState({
      profiles: [DIRECT],
      workspaces: [WORKSPACE],
      statuses: [status("ready")],
      sessions: { [DIRECT.id]: [row] },
      transcripts: {}
    });
    let attempts = 0;
    fake.bridge.openRemoteSession = async (request) => {
      attempts += 1;
      if (attempts === 1) throw new Error("ssh is unreachable");
      return transcript({ sessionId: request.sessionId, title: "migrate Postgres" });
    };

    render(withI18n(<PageHarness initialSessionId="session-unreachable" sessions={[row]} />));

    // Without a terminal state the reader would sit on its loading line forever.
    expect(await screen.findByText("This session could not be opened.")).toBeDefined();
    expect(screen.queryByText("Opening the session")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("refactor the auth middleware")).toBeDefined();
    expect(attempts).toBe(2);
  });

  test("losing the connection reads as remote work continuing, not as a failure", async () => {
    fake = installFakeBridge();
    fake.setRemoteState({ profiles: [DIRECT], workspaces: [WORKSPACE], statuses: [] });

    render(withI18n(<PageHarness initialSessionId={null} sessions={[]} />));
    // The initial snapshot has to land first: it would otherwise resolve after
    // the broadcast and overwrite it with the state from before.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      await fake.emitRemoteStatus(status("disconnected"));
    });

    expect(screen.getByText("Remote work keeps running. Reconnect to follow it again.")).toBeDefined();
    expect(screen.getByText("Not connected")).toBeDefined();
  });
});
