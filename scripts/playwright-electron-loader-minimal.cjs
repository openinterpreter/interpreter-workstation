globalThis.__playwright_run = async () => {
  // Tahoe wants the app to boot on its normal path; Playwright only needs the
  // handshake hook to exist.
};
