// The toolbar button brings the board forward: the tab already showing it, or a new one.
// runtime.getContexts lists this extension's own pages, so no "tabs" permission is needed.
chrome.action.onClicked.addListener(async () => {
  const url = chrome.runtime.getURL('board.html');
  const open = (await chrome.runtime.getContexts?.({ contextTypes: ['TAB'] }).catch(() => []) || [])
    .find((c) => c.documentUrl?.startsWith(url) && c.tabId >= 0);
  if (!open) return chrome.tabs.create({ url });
  await chrome.tabs.update(open.tabId, { active: true });
  if (open.windowId >= 0) await chrome.windows.update(open.windowId, { focused: true });
});
