/**
 * Register a minimal browser environment for React Testing Library under Node.
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
assign("Element", window.Element);
assign("Node", window.Node);
assign("DocumentFragment", window.DocumentFragment);
assign("MutationObserver", window.MutationObserver);
assign("getComputedStyle", window.getComputedStyle.bind(window));
assign("requestAnimationFrame", (cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 0));
assign("cancelAnimationFrame", (id: number) => clearTimeout(id));
assign("IS_REACT_ACT_ENVIRONMENT", true);

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
