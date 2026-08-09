import assert from "node:assert/strict";
import { WorkingRegistry, shouldNotifyForMode } from "../../dist/main/main/services/workingRegistry.js";

class FakeDatabase {
  tasks = new Map();
  settings = { workingNotifications: { mode: "background", includeDetails: true } };

  recoverInterruptedWorking() {
    let changed = 0;
    for (const task of this.tasks.values()) {
      if (!["running", "waiting_user", "stopping"].includes(task.status)) continue;
      Object.assign(task, { status: "interrupted", activity: "Interrupted when Jasmine exited", finishedAt: new Date().toISOString(), unread: true });
      changed += 1;
    }
    return changed;
  }

  getWorkingSnapshot() {
    const items = [...this.tasks.values()];
    return {
      items,
      activeCount: items.filter((item) => ["running", "waiting_user", "stopping"].includes(item.status)).length,
      attentionCount: items.filter((item) => item.status === "waiting_user" || item.status === "failed").length
    };
  }

  startWorkingTask(input) {
    for (const [requestId, task] of this.tasks) {
      if (task.threadId === input.threadId) this.tasks.delete(requestId);
    }
    this.tasks.set(input.requestId, {
      ...input,
      threadTitle: `Chat ${input.threadId}`,
      projectId: "project-1",
      projectName: "Secret Project",
      status: "running",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      finishedAt: null,
      queueCount: 0,
      unread: false,
      notified: new Set()
    });
  }

  updateWorkingTask(input) {
    const task = this.tasks.get(input.requestId);
    if (!task) return false;
    Object.assign(task, input);
    return true;
  }

  markWorkingRead(requestId) {
    const task = this.tasks.get(requestId);
    if (!task) return false;
    task.unread = false;
    return true;
  }

  markWorkingThreadRead(threadId) {
    const task = [...this.tasks.values()].find((item) => item.threadId === threadId && item.unread);
    if (!task) return false;
    task.unread = false;
    return true;
  }

  clearCompletedWorking() {
    let deleted = 0;
    for (const [requestId, task] of this.tasks) {
      if (["completed", "failed", "cancelled", "interrupted"].includes(task.status)) {
        this.tasks.delete(requestId);
        deleted += 1;
      }
    }
    return deleted;
  }

  markWorkingNotificationSent(requestId, status) {
    const task = this.tasks.get(requestId);
    if (!task || task.notified.has(status)) return false;
    task.notified.add(status);
    return true;
  }

  getAppSettings() {
    return this.settings;
  }
}

const db = new FakeDatabase();
db.startWorkingTask({ requestId: "stale", threadId: "stale-thread", activity: "Running" });
const notifications = [];
const routes = [];
let background = true;
const registry = new WorkingRegistry(db, {
  broadcast() {},
  isBackground: () => background,
  showNotification(notification, onClick) {
    notifications.push({ notification, onClick });
    return true;
  },
  route(target) { routes.push(target); }
});

assert.equal(registry.initialize().items[0].status, "interrupted", "startup should recover stale active tasks");
registry.start({ requestId: "request-1", threadId: "thread-1" });
registry.start({ requestId: "request-2", threadId: "thread-1" });
assert.deepEqual(registry.snapshot().items.filter((task) => task.threadId === "thread-1").map((task) => task.requestId), ["request-2"], "one chat should have one Working item");

registry.waitingForUser("request-2");
registry.waitingForUser("request-2");
assert.equal(notifications.length, 1, "waiting-user notifications should be deduplicated per request/status");
assert.equal(registry.snapshot().attentionCount, 1);
notifications[0].onClick();
assert.equal(db.tasks.get("request-2").unread, false);
assert.equal(routes[0].threadId, "thread-1");

registry.finish("request-2", "completed");
registry.finish("request-2", "completed");
assert.equal(notifications.length, 2, "completion should notify once even after a waiting-user notification");
assert.equal(db.tasks.get("request-2").unread, true);

background = false;
registry.start({ requestId: "request-3", threadId: "thread-3" });
registry.finish("request-3", "failed");
assert.equal(notifications.length, 2, "background mode should suppress foreground notifications");

db.settings.workingNotifications = { mode: "always", includeDetails: false };
registry.start({ requestId: "request-4", threadId: "thread-4" });
registry.finish("request-4", "completed");
assert.equal(notifications.length, 3);
assert.doesNotMatch(notifications.at(-1).notification.body, /Secret Project|thread-4/, "privacy mode must hide project/chat details");

registry.viewThread("thread-5");
registry.start({ requestId: "request-5", threadId: "thread-5" });
registry.finish("request-5", "completed");
assert.equal(notifications.length, 3, "the currently viewed chat should not create a notification");
assert.equal(db.tasks.get("request-5").unread, false, "the currently viewed chat should be treated as read");

const unavailableDb = new FakeDatabase();
const unavailableRegistry = new WorkingRegistry(unavailableDb, {
  broadcast() {},
  isBackground: () => true,
  showNotification: () => false,
  route() {}
});
unavailableRegistry.start({ requestId: "unavailable", threadId: "thread-unavailable" });
unavailableRegistry.finish("unavailable", "completed");
assert.equal(unavailableRegistry.snapshot().items[0].unread, true, "unread state must survive unavailable Windows notifications");

assert.equal(shouldNotifyForMode("background", true), true);
assert.equal(shouldNotifyForMode("background", false), false);
assert.equal(shouldNotifyForMode("always", false), true);
assert.equal(shouldNotifyForMode("never", true), false);

console.log("Working registry, recovery, privacy, routing, and notification policy regression passed.");
