// The toolbar button brings the board forward: the tab already showing it, or a new one.
// runtime.getContexts lists this extension's own pages, so no "tabs" permission is needed.
async function openBoardTab(cardId) {
  const url = chrome.runtime.getURL('board.html');
  const open = (await chrome.runtime.getContexts?.({ contextTypes: ['TAB'] }).catch(() => []) || [])
    .find((c) => c.documentUrl?.startsWith(url) && c.tabId >= 0);
  const target = cardId ? `${url}#card=${encodeURIComponent(cardId)}` : url;
  if (!open) return chrome.tabs.create({ url: target });
  await chrome.tabs.update(open.tabId, cardId ? { active: true, url: target } : { active: true });
  if (open.windowId >= 0) await chrome.windows.update(open.windowId, { focused: true });
}

chrome.action.onClicked.addListener(() => openBoardTab());
chrome.commands?.onCommand.addListener((command, tab) => {
  if (command === 'open-side-panel' && tab?.windowId >= 0) chrome.sidePanel?.open?.({ windowId: tab.windowId })?.catch(console.warn);
});
chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: false })?.catch(console.warn);
chrome.runtime.onMessage?.addListener((message, sender, respond) => {
  if (message?.type !== 'open-board-tab' || sender.id !== chrome.runtime.id) return;
  openBoardTab(typeof message.cardId === 'string' ? message.cardId : null).then(() => respond({ ok: true }), error => respond({ error: error.message }));
  return true;
});
