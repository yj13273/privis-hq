// utils/screenshot.ts
// Background-only screenshot helper
//
// Responsibilities:
// - Wraps chrome.tabs.captureVisibleTab into an in-memory PNG data URL.
// - Ensures raw screenshots are never written to disk or extension storage.

/**
 * Captures the visible tab into an in-memory PNG data URL.
 * @param tabId Target tab ID
 */
export async function takeScreenshot(tabId: number): Promise<{ dataUrl: string; width: number; height: number }> {
  // captureVisibleTab works on the active tab of a window; resolve the tab's window.
  let tab: chrome.tabs.Tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    throw new Error(`takeScreenshot: tab ${tabId} not found`);
  }

  if (!tab.active) {
    throw new Error(
      `takeScreenshot: tab ${tabId} is not the active tab in its window; captureVisibleTab would capture a different tab`,
    );
  }
  const windowId = tab.windowId;

  try {
    const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
    if (!dataUrl) {
      throw new Error("takeScreenshot: captureVisibleTab returned empty data");
    }
    const dimensions = pngDimensions(dataUrl);
    return { dataUrl, ...dimensions };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`takeScreenshot: capture failed: ${detail}`);
  }
}

function pngDimensions(dataUrl: string): { width: number; height: number } {
  const encoded = dataUrl.split(",", 2)[1];
  if (!encoded) throw new Error("takeScreenshot: invalid PNG data URL");
  const bytes = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));
  if (bytes.length < 24 || bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47) {
    throw new Error("takeScreenshot: captured data is not a PNG");
  }
  const view = new DataView(bytes.buffer);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}
