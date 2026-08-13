import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { useAppSurfaces } from "../../src/renderer/hooks/useAppSurfaces";
import { useFloatingSurfaceDismissal } from "../../src/renderer/hooks/useFloatingSurfaceDismissal";

function SurfaceHarness() {
  const surfaces = useAppSurfaces();
  useFloatingSurfaceDismissal({
    ...surfaces,
    deleteThreadOpen: false,
    rememberDialogOpen: false,
    closeFloatingSurfaces: surfaces.closeFloatingSurfaces
  });

  return (
    <main>
      <button className="model-pill" type="button" onClick={() => surfaces.setModelMenuOpen(true)}>Model</button>
      {surfaces.modelMenuOpen ? <div className="model-menu">Models</div> : null}
      <footer className="side-footer">
        <button type="button" onClick={() => surfaces.setMoreOpen(true)}>More</button>
      </footer>
      {surfaces.moreOpen ? <div className="side-menu">More menu</div> : null}
      <button type="button" onClick={() => {
        surfaces.closeFloatingSurfaces();
        surfaces.setSearchOpen(true);
      }}>Search</button>
      {surfaces.searchOpen ? <div className="search-backdrop">Search surface</div> : null}
      <div data-testid="outside">Outside</div>
    </main>
  );
}

describe("floating surface dismissal", () => {
  test("Escape, outside clicks, and a newly opened surface clear stale overlays", () => {
    render(<SurfaceHarness />);

    fireEvent.click(screen.getByRole("button", { name: "Model" }));
    expect(screen.getByText("Models")).toBeDefined();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByText("Models")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Model" }));
    fireEvent.mouseDown(screen.getByTestId("outside"));
    expect(screen.queryByText("Models")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "More" }));
    expect(screen.getByText("More menu")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(screen.queryByText("More menu")).toBeNull();
    expect(screen.getByText("Search surface")).toBeDefined();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByText("Search surface")).toBeNull();
  });
});
