import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import Toast from "./toast";

describe("Toast", () => {
  /**
   * Once mounted, the toast is portaled into document.body: drawn inside the
   * app root, it would sit below react-modal overlays (the root is a
   * z-index:100 stacking context) and be aria-hidden while a modal is open.
   * Rendering it in place (here, while pre-rendering) would bring that back.
   */
  it("never renders in place, even with a message to show", () => {
    const app = createElement(
      "div",
      { id: "__next" },
      createElement(Toast, { toast: { id: 1, text: "This game is already full." }, onDismiss: () => undefined })
    );
    // @types/react-dom brings its own copy of @types/react, whose ReactElement differs slightly.
    const html = renderToStaticMarkup(app as Parameters<typeof renderToStaticMarkup>[0]);

    expect(html).toBe('<div id="__next"></div>');
  });
});
