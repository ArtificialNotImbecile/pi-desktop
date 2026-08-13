import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

// jsdom stops short of a few APIs the renderer expects to exist. Each stub
// below is deliberately inert: it satisfies construction so a component can
// mount, and tests that care about observer behavior drive the callbacks
// themselves rather than relying on these to fire.
class InertObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): [] {
    return [];
  }
}

if (!("ResizeObserver" in globalThis)) {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = InertObserver;
}
if (!("IntersectionObserver" in globalThis)) {
  (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = InertObserver;
}
if (!window.matchMedia) {
  window.matchMedia = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false
  }) as MediaQueryList;
}
if (!Element.prototype.scrollTo) {
  Element.prototype.scrollTo = function scrollTo() {};
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = function scrollIntoView() {};
}

afterEach(() => {
  cleanup();
  delete (window as { jasmine?: unknown }).jasmine;
});
