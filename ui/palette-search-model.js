// Pure command-palette search scope and race control. Included before keyboard.js.
function paletteBoardCards(board) {
  const cards = new Map();
  for (const list of board?.lists || []) for (const card of list.cards || []) {
    cards.set(card.id, { ...card, paletteList: list.title });
    for (const child of card.links || []) if (!cards.has(child.id)) cards.set(child.id, { ...child, paletteList: list.title });
  }
  return [...cards.values()];
}
function paletteOutsideRows(results, boardCards, { days = 0, now = Date.now() } = {}) {
  const present = new Set(boardCards.map(card => card.id));
  const seen = new Set();
  return (results || []).filter(row => row?.cardId && !present.has(row.cardId) && !seen.has(row.cardId) && seen.add(row.cardId)).map(row => {
    const updated = typeof row.updatedAt === 'number' ? row.updatedAt : Date.parse(row.updatedAt);
    const outsideReason = row.archived === true ? 'アーカイブ済み'
      : Number(days) > 0 && Number.isFinite(updated) && now - updated > Number(days) * 86400e3 ? `${Number(days)}日より前` : '絞り込みの外';
    return { ...row, outsideReason };
  });
}
function createPaletteSearch({ search, onChange, delay = 200, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let generation = 0, timer = null, disposed = false;
  let current = { query: '', loading: false, rows: [], error: null, warnings: [], coverage: null, total: null, fulltext: false };
  const publish = next => { current = { ...current, ...next }; if (!disposed) onChange?.(current); };
  return {
    get state() { return current; },
    update(raw, { fulltext = false } = {}) {
      const query = String(raw || '').trim(), token = ++generation;
      if (timer !== null) clearTimer(timer);
      timer = null;
      if (disposed) return;
      const eligible = [...query].length >= 2;
      publish({ query, loading: eligible, rows: [], error: null, warnings: [], coverage: null, total: null, fulltext: !!fulltext });
      if (!eligible) return;
      timer = setTimer(async () => {
        timer = null;
        try {
          const result = await search({ q: query, days: 0, includeArchived: true, includeSubagents: true, dotScope: 'all', limit: 20, fulltext: !!fulltext });
          if (disposed || token !== generation) return;
          if (!Array.isArray(result?.results)) throw new Error('検索結果の形式を確認できません');
          publish({ loading: false, rows: result.results, warnings: Array.isArray(result.errors) ? result.errors : [], coverage: result.searchCoverage || null, total: Number.isFinite(result.total) ? result.total : result.results.length });
        } catch (error) {
          if (!disposed && token === generation) publish({ loading: false, rows: [], error: error?.message || '検索結果を取得できません' });
        }
      }, delay);
    },
    dispose() { disposed = true; generation++; if (timer !== null) clearTimer(timer); timer = null; },
  };
}

function paletteCoverageWarning(coverage) {
  if (!coverage?.fulltextApplied) return '';
  const index = coverage.index;
  if (!index?.updatedAt) return '本文索引の更新時刻は未取得です';
  if (Number.isFinite(index.indexed) && Number.isFinite(index.total) && index.indexed < index.total) return `本文索引に未取得があります（${index.indexed}/${index.total}件）`;
  return '';
}

// Only deliberate visits from global search are recorded; ordinary board navigation remains independent.
function createPaletteVisitHistory({ max = 8 } = {}) {
  const visits = [];
  const matches = ids => !!visits.length && ids.includes(visits.at(-1).targetId);
  return {
    get length() { return visits.length; },
    canReturn: matches,
    push(origin, targetId) {
      if (!matches(origin.ids || [])) visits.splice(0);
      if (origin.ids?.includes(targetId)) return false;
      visits.push({ origin, targetId });
      if (visits.length > max) visits.splice(0, visits.length - max);
      return true;
    },
    take(ids) { return matches(ids) ? visits.pop() : null; },
    restore(visit) { if (visit) { visits.push(visit); if (visits.length > max) visits.shift(); } },
    clear() { visits.splice(0); },
  };
}
