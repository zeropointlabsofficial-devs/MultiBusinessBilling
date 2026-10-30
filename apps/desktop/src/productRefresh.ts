type VisibilitySource = Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener">;

export function watchForProductRefresh(
  refresh: () => Promise<void>,
  onError: (error: unknown) => void,
  visibilitySource: VisibilitySource,
  intervalMs = 15_000,
) {
  let active = true;
  let refreshing = false;

  const run = () => {
    if (!active || refreshing || visibilitySource.visibilityState !== "visible") return;
    refreshing = true;
    void Promise.resolve()
      .then(refresh)
      .catch((error: unknown) => {
        if (active) onError(error);
      })
      .finally(() => {
        refreshing = false;
      });
  };
  const onVisibilityChange = () => run();

  visibilitySource.addEventListener("visibilitychange", onVisibilityChange);
  const timer = setInterval(run, intervalMs);
  run();

  return () => {
    active = false;
    clearInterval(timer);
    visibilitySource.removeEventListener("visibilitychange", onVisibilityChange);
  };
}
