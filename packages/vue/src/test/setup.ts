/**
 * Register a minimal browser environment for Vue composable tests under Node.
 * Loaded via `node --import ./dist/test/setup.js`.
 */
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
  url: "http://localhost/",
  pretendToBeVisual: true,
});

const { window } = dom;

function assign(name: string, value: unknown) {
  Object.defineProperty(globalThis, name, {
    configurable: true,
    writable: true,
    value,
  });
}

assign("window", window);
assign("document", window.document);
assign("navigator", window.navigator);
assign("HTMLElement", window.HTMLElement);
assign("SVGElement", window.SVGElement);
assign("Element", window.Element);
assign("Node", window.Node);
assign("Text", window.Text);
assign("Comment", window.Comment);
assign("DocumentFragment", window.DocumentFragment);
assign("MutationObserver", window.MutationObserver);
assign("customElements", window.customElements);
assign("getComputedStyle", window.getComputedStyle.bind(window));
assign("requestAnimationFrame", (cb: FrameRequestCallback) =>
  setTimeout(() => cb(Date.now()), 0),
);
assign("cancelAnimationFrame", (id: number) => clearTimeout(id));

// Vue runtime-dom resolves some constructors off globalThis.
Object.defineProperty(window, "SVGElement", {
  configurable: true,
  writable: true,
  value: window.SVGElement,
});

// localStorage for useAuth persistence tests
const store = new Map<string, string>();
assign("localStorage", {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => {
    store.set(k, String(v));
  },
  removeItem: (k: string) => {
    store.delete(k);
  },
  clear: () => store.clear(),
  key: (i: number) => [...store.keys()][i] ?? null,
  get length() {
    return store.size;
  },
});
