// Diagram geometry is derived only from recorded, versioned observations.
const LOOP_STATUS = { ready: '準備', active: '実行・検証', review: '調整・確認', paused: '停止中', completed: '条件を達成' };
function loopVerified(c, r) { return r.verified || c.confirmations?.some(x => x.roundId === r.id); }
function loopMeasure(c, r) {
  if (!r?.results || !loopVerified(c, r)) return null;
  const passed = r.results.filter(x => x.pass === true).length;
  return { passed, total: r.results.length, unknown: r.results.filter(x => x.pass === null).length, value: passed / r.results.length };
}
function loopRadius(value) { return 48 + (1 - (value ?? 0)) * 116; }
function loopPoint(radius, angle) { return [210 + Math.cos(angle) * radius, 210 + Math.sin(angle) * radius]; }
function loopTrail(c) {
  const paths = []; let previous = null;
  for (const r of c.rounds.filter(r => r.version === c.version)) {
    const m = loopMeasure(c, r);
    if (!m) { previous = null; continue; }
    const end = loopRadius(m.value), start = previous ?? end;
    const points = Array.from({ length: 65 }, (_, i) => loopPoint(start + (end - start) * i / 64, -Math.PI / 2 + i / 64 * Math.PI * 2));
    paths.push({ id: r.id, path: points.map((p, i) => `${i ? 'L' : 'M'}${p.map(n => n.toFixed(1)).join(' ')}`).join(' '), point: points.at(-1), number: r.number });
    previous = end;
  }
  return paths;
}
