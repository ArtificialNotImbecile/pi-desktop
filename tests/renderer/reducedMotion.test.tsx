import type { ReactNode } from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";

vi.mock("motion/react", () => ({
  AnimatePresence: ({ children }: { children: ReactNode }) => <>{children}</>,
  useReducedMotion: () => true,
  motion: {
    div: ({ initial, animate, exit, transition, ...props }: {
      initial: unknown;
      animate: unknown;
      exit: unknown;
      transition: unknown;
      children?: ReactNode;
      [key: string]: unknown;
    }) => (
      <div
        {...props}
        data-initial={JSON.stringify(initial)}
        data-animate={JSON.stringify(animate)}
        data-exit={JSON.stringify(exit)}
        data-transition={JSON.stringify(transition)}
      />
    )
  }
}));

import { FadeScale, FadeSlide, Presence } from "../../src/renderer/components/ui/Motion";

describe("reduced motion surfaces", () => {
  test("removes scale and slide travel while retaining a short opacity transition", () => {
    render(
      <Presence>
        <FadeScale data-testid="scale">Scale surface</FadeScale>
        <FadeSlide data-testid="slide" distance={12}>Slide surface</FadeSlide>
      </Presence>
    );

    const scale = screen.getByTestId("scale");
    const slide = screen.getByTestId("slide");
    expect(JSON.parse(scale.dataset.initial ?? "{}")).toEqual({ opacity: 0 });
    expect(JSON.parse(scale.dataset.exit ?? "{}")).toEqual({ opacity: 0 });
    expect(JSON.parse(scale.dataset.transition ?? "{}").duration).toBe(0.01);
    expect(JSON.parse(slide.dataset.initial ?? "{}")).toEqual({ opacity: 0, y: 0 });
    expect(JSON.parse(slide.dataset.exit ?? "{}")).toEqual({ opacity: 0, y: 0 });
    expect(JSON.parse(slide.dataset.transition ?? "{}").duration).toBe(0.01);
  });
});
