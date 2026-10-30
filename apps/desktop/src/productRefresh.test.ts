import { afterEach, describe, expect, it, vi } from "vitest";
import { watchForProductRefresh } from "./productRefresh";

class TestVisibilitySource extends EventTarget {
  visibilityState: DocumentVisibilityState = "visible";

  setVisibility(state: DocumentVisibilityState) {
    this.visibilityState = state;
    this.dispatchEvent(new Event("visibilitychange"));
  }
}

describe("desktop product refresh scheduling", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("refreshes immediately and periodically, skips hidden windows, and refreshes when visible", async () => {
    vi.useFakeTimers();
    const visibility = new TestVisibilitySource();
    const refresh = vi.fn(async () => {});
    const onError = vi.fn();
    const stop = watchForProductRefresh(refresh, onError, visibility);

    await vi.advanceTimersByTimeAsync(0);
    expect(refresh).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(15_000);
    expect(refresh).toHaveBeenCalledTimes(2);

    visibility.setVisibility("hidden");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(refresh).toHaveBeenCalledTimes(2);

    visibility.setVisibility("visible");
    await vi.advanceTimersByTimeAsync(0);
    expect(refresh).toHaveBeenCalledTimes(3);

    stop();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(refresh).toHaveBeenCalledTimes(3);
    expect(onError).not.toHaveBeenCalled();
  });

  it("does not overlap requests and reports refresh failures", async () => {
    vi.useFakeTimers();
    const visibility = new TestVisibilitySource();
    const onError = vi.fn();
    let rejectRefresh: (error: Error) => void = () => {};
    const refresh = vi.fn(() => new Promise<void>((_resolve, reject) => {
      rejectRefresh = reject;
    }));
    const stop = watchForProductRefresh(refresh, onError, visibility, 100);

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(500);
    expect(refresh).toHaveBeenCalledTimes(1);

    rejectRefresh(new Error("server unavailable"));
    await vi.advanceTimersByTimeAsync(0);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "server unavailable" }));

    await vi.advanceTimersByTimeAsync(100);
    expect(refresh).toHaveBeenCalledTimes(2);
    stop();
  });
});
