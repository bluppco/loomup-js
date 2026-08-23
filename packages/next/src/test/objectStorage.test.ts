import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fileAndPathFromFormData } from "../objectStorage.js";

describe("fileAndPathFromFormData", () => {
  it("reads file field and path field", () => {
    const form = new FormData();
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" });
    form.set("file", blob, "photo.png");
    form.set("path", "uploads/photo.png");
    const out = fileAndPathFromFormData(form);
    assert.equal(out.path, "uploads/photo.png");
    assert.equal(out.contentType, "image/png");
    assert.equal(out.file.size, 3);
  });

  it("applies pathPrefix and strips leading slash", () => {
    const form = new FormData();
    form.set("file", new Blob(["x"], { type: "text/plain" }), "a.txt");
    const out = fileAndPathFromFormData(form, {
      path: "/nested/a.txt",
      pathPrefix: "user-1",
    });
    assert.equal(out.path, "user-1/nested/a.txt");
  });

  it("throws when file field missing", () => {
    assert.throws(
      () => fileAndPathFromFormData(new FormData()),
      /must be a File\/Blob/,
    );
  });
});
