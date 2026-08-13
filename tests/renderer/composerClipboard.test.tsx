import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { ClipboardImagePasteRequest, PickedPath } from "../../src/shared/ipc";
import { RichComposer } from "../../src/renderer/components/chat/RichComposer/RichComposer";
import { useComposer } from "../../src/renderer/hooks/useComposer";

const IMAGE_BYTES = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);

class ClipboardDataTransferItemList extends Array<DataTransferItem> {
  add(file: File): DataTransferItem {
    const item = {
      kind: "file",
      type: file.type,
      getAsFile: () => file,
      getAsString: () => undefined,
      webkitGetAsEntry: () => null
    } as DataTransferItem;
    this.push(item);
    return item;
  }
}

class ClipboardDataTransfer {
  readonly items = new ClipboardDataTransferItemList();

  get files(): FileList {
    return this.items.map((item) => item.getAsFile()).filter((file): file is File => file !== null) as unknown as FileList;
  }

  get types(): readonly string[] {
    return this.items.length > 0 ? ["Files"] : [];
  }

  getData(): string {
    return "";
  }
}

class ImageClipboardEvent extends Event {
  readonly clipboardData: DataTransfer | null;

  constructor(type: string, init: ClipboardEventInit = {}) {
    super(type, init);
    this.clipboardData = init.clipboardData ?? null;
  }
}

function ComposerClipboardHarness(props: {
  onSubmit(content: string, attachments: PickedPath[]): Promise<boolean | void>;
}) {
  const composer = useComposer({
    runState: "idle",
    canSendImages: true,
    onErrorReset: () => undefined,
    onSubmit: props.onSubmit,
    onQueueSubmit: async () => true,
    onEditSubmit: async () => true,
    onToast: () => undefined
  });

  return (
    <form onSubmit={(event) => void composer.submit(event)}>
      <RichComposer
        ariaLabel="Message"
        placeholder="Type a message"
        value={composer.draft}
        onChange={composer.setDraft}
        onClearError={() => undefined}
        onCommandStateChange={() => undefined}
        onKeyDown={() => undefined}
        onPasteAttachment={composer.attachClipboardImage}
        onSubmitFromKeyboard={() => void composer.submit()}
      />
      <output aria-label="Attachment names">
        {composer.attachments.map((attachment) => attachment.name).join(",")}
      </output>
      <button type="submit">Send</button>
    </form>
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("composer clipboard image files", () => {
  test("attaches a synthetic image File and sends the saved attachment", async () => {
    vi.stubGlobal("DataTransfer", ClipboardDataTransfer);
    vi.stubGlobal("ClipboardEvent", ImageClipboardEvent);

    const savedAttachment: PickedPath = {
      name: "pasted-red.png",
      path: "C:\\attachments\\clipboard\\pasted-red.png",
      kind: "file",
      mediaType: "image/png",
      isImage: true,
      previewDataUrl: "data:image/png;base64,iVBORw0KGgo="
    };
    const savePastedImage = vi.fn(async (_request: ClipboardImagePasteRequest) => savedAttachment);
    Object.assign(window, { jasmine: { savePastedImage } });
    const onSubmit = vi.fn(async (_content: string, _attachments: PickedPath[]) => true);
    render(<ComposerClipboardHarness onSubmit={onSubmit} />);

    const file = new File([IMAGE_BYTES], "pasted-red.png", { type: "image/png" });
    const clipboard = new DataTransfer();
    clipboard.items.add(file);
    const paste = new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData: clipboard
    });

    await act(async () => {
      screen.getByRole("textbox", { name: "Message" }).dispatchEvent(paste);
    });

    await waitFor(() => expect(savePastedImage).toHaveBeenCalledTimes(1));
    expect(paste.defaultPrevented).toBe(true);
    const request = savePastedImage.mock.calls[0][0];
    expect(request.name).toBe("pasted-red.png");
    expect(request.mimeType).toBe("image/png");
    expect(Array.from(new Uint8Array(request.data))).toEqual(Array.from(IMAGE_BYTES));
    expect((await screen.findByRole("status", { name: "Attachment names" })).textContent).toBe("pasted-red.png");

    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith("", [savedAttachment]));
  });
});
