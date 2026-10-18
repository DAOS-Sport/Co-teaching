import test from "node:test";
import assert from "node:assert/strict";
import { createBatchConfirmation } from "./adapters/services/batch-confirmation";

test("batch confirmation binds input/state/kind, is opaque, and expires", () => {
  let time = 100;
  const codec = createBatchConfirmation("synthetic-key", () => time);
  const context = { kind: "import", input: { venue: "v", text: "synthetic" }, state: [{ id: "x", version: 1 }] };
  const token = codec.issue(context);
  assert.equal(codec.verify(token, context), true);
  assert.equal(codec.verify(token, { ...context, kind: "copy" }), false);
  assert.equal(codec.verify(token, { ...context, state: [{ id: "x", version: 2 }] }), false);
  assert.equal(codec.verify(token, { ...context, input: { venue: "other", text: "synthetic" } }), false);
  assert.equal(Buffer.from(token.split(".")[0], "base64url").toString().includes("synthetic"), false);
  assert.equal(codec.verify(token + "x", context), false);
  assert.equal(createBatchConfirmation("different", () => time).verify(token, context), false);
  time += 300_000;
  assert.equal(codec.verify(token, context), false);
});
