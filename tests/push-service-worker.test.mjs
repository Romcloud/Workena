import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../public/sw.js", import.meta.url), "utf8");

function worker() {
  const handlers = new Map();
  const shown = [];
  const messages = [];
  const opened = [];
  const self = {
    location: { origin: "https://workena.example" },
    registration: { showNotification: async (...args) => { shown.push(args); } },
    clients: {
      matchAll: async () => [],
      openWindow: async (url) => { opened.push(url); },
    },
    addEventListener: (type, handler) => handlers.set(type, handler),
  };
  vm.runInNewContext(source, { self, URL, console });
  return { self, handlers, shown, messages, opened };
}

test("push event displays the notification", async () => {
  const { handlers, shown } = worker();
  let task;
  handlers.get("push")({
    data: { json: () => ({ title: "Nová pridelená zákazka", body: "Otvorte Workenu." }) },
    waitUntil: (promise) => { task = promise; },
  });
  await task;
  assert.equal(shown[0][0], "Nová pridelená zákazka");
  assert.equal(shown[0][1].body, "Otvorte Workenu.");
});

test("notification click opens work orders without an existing window", async () => {
  const { handlers, opened } = worker();
  let task;
  let closed = false;
  handlers.get("notificationclick")({
    notification: { close: () => { closed = true; } },
    waitUntil: (promise) => { task = promise; },
  });
  await task;
  assert.equal(closed, true);
  assert.deepEqual(opened, ["/?open=work-orders"]);
});

test("notification click focuses an existing Workena window", async () => {
  const { self, handlers } = worker();
  const messages = [];
  let focused = false;
  self.clients.matchAll = async () => [{
    url: "https://workena.example/",
    focus: async () => { focused = true; },
    postMessage: (message) => messages.push(message.type),
  }];
  let task;
  handlers.get("notificationclick")({
    notification: { close() {} },
    waitUntil: (promise) => { task = promise; },
  });
  await task;
  assert.equal(focused, true);
  assert.deepEqual(messages, ["OPEN_WORK_ORDERS"]);
});
