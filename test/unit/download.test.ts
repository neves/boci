import { expect, test } from "bun:test";
import { writeDownload } from "../../src/core/download.ts";

test("streams stdout chunks before the response completes and preserves bytes", async () => {
  const first = new Uint8Array([0x00, 0x80, 0xff]);
  const last = new Uint8Array([0x01, 0xfe, 0x00]);
  let releaseLast!: () => void;
  const waitingForLast = new Promise<void>((resolve) => {
    releaseLast = resolve;
  });
  let firstDelivered!: () => void;
  const delivered = new Promise<void>((resolve) => {
    firstDelivered = resolve;
  });
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(first);
      void waitingForLast.then(() => {
        controller.enqueue(last);
        controller.close();
      });
    },
  });
  const received: number[] = [];
  const writing = writeDownload(
    {
      argv: [],
      env: {},
      cwd: ".",
      out: () => {},
      outBytes: async (chunk) => {
        received.push(...chunk);
        if (received.length === first.length) firstDelivered();
      },
      err: () => {},
      isTTY: () => false,
      columns: () => undefined,
    },
    new Response(body),
    "-",
  );

  await delivered;
  expect(received).toEqual([...first]);
  releaseLast();
  await writing;
  expect(received).toEqual([...first, ...last]);
});
