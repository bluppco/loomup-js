import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fileAndPathFromFormData } from "../runtime/server/objectStorage.js";

describe("nuxt fileAndPathFromFormData", () => {
  it("reads file and path", () => {
    const form = new FormData();
    form.set("file", new Blob([new Uint8Array([9])], { type: "application/pdf" }), "d.pdf");
    form.set("path", "docs/d.pdf");
    const out = fileAndPathFromFormData(form);
    assert.equal(out.path, "docs/d.pdf");
    assert.equal(out.contentType, "application/pdf");
  });
});
