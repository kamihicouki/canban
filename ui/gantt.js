// Gantt Chart View: task tree (WBS) on the left, horizontal timeline bars on the right,
// with the selected card docked into the right area (the view switch, `gantt`; ui/lifetime.js).
// Included into board.html's script (shares its scope).
state.gantt = {
  sel: null,
  sidebarWidth: Number(store.get('ganttSidebarWidth', 340)) || 340,
};

const ganttOn = () => state.view === 'gantt';
const DAY_MILLIS = 24 * 60 * 60 * 1000;

function ganttItems(b) {
  const cards = b.lists.flatMap((l) => l.cards);
  const tasks = cards.filter((c) => c.kind === 'task');
  const linkedSessionIds = new Set(tasks.flatMap((t) => t.links || []));
  const standaloneSessions = cards.filter((c) => c.kind !== 'task' && !linkedSessionIds.has(c.id));

  const items = [];
  for (const t of tasks) {
    items.push({ card: t, isTask: true, level: 0 });
    for (const sid of t.links || []) {
      const sc = findCard(sid);
      if (sc) items.push({ card: sc, isTask: false, level: 1, parentId: t.id });
    }
  }
  for (const s of standaloneSessions) {
    items.push({ card: s, isTask: false, level: 0 });
  }
  return items;
}

function renderGantt(b) {
  const items = ganttItems(b);
  if (!items.some((it) => it.card.id === state.gantt.sel) && !paneDocked()) {
    state.gantt.sel = items[0]?.card.id ?? null;
  }

  const container = h('div', { class: 'gantt-view', role: 'region', 'aria-label': 'ガントチャート' });

  // 1. Left Sidebar: WBS / Task List
  const sidebar = h('aside', {
    class: 'gantt-sidebar',
    style: { width: `${state.gantt.sidebarWidth}px` },
    'aria-label': 'タスク階層 (WBS)'
  });

  const sidebarHead = h('div', { class: 'gantt-sidebar-head' },
    h('div', { class: 'flex items-center gap-2' },
      h('span', { html: picon('calendar', 15) }),
      h('span', { text: 'タスク・WBS' }),
      h('span', { class: 'n text-[10px] muted', text: `${items.length}件` })
    ),
    h('div', { class: 'gantt-row-meta' },
      h('span', { text: '進捗' }),
      h('span', { text: '更新' })
    )
  );

  const sidebarBody = h('div', { class: 'gantt-sidebar-body' });
  for (const it of items) {
    const { card, isTask, level } = it;
    const isSelected = state.gantt.sel === card.id;
    const progress = isTask ? '75%' : (card.status === 'done' ? '100%' : (card.status === 'running' ? '80%' : '50%'));
    const row = h('div', {
      class: `gantt-row${level > 0 ? ' is-child' : ''}`,
      'data-card-id': card.id,
      'aria-selected': String(isSelected),
      onclick: () => ganttSelect(card.id),
      ondblclick: () => openCard(card.id, { dock: false })
    },
      h('div', { class: 'flex items-center gap-1.5 min-w-0 pr-2 grow' },
        isTask ? h('span', { class: 'badge-task text-[9px] px-1 rounded font-bold', text: 'T' }) : faceGlyph(card.status, card.statusKnown),
        h('span', { class: 'gantt-row-title', text: card.title })
      ),
      h('div', { class: 'gantt-row-meta' },
        h('span', { text: progress }),
        h('span', { text: relTime(card.updatedAt) })
      )
    );
    sidebarBody.append(row);
  }
  sidebar.append(sidebarHead, sidebarBody);

  // 2. Resizer Handle
  const resizer = h('div', { class: 'gantt-resizer', title: 'ドラッグでサイドバー幅を変更' });
  let isResizing = false;
  resizer.addEventListener('mousedown', () => {
    isResizing = true;
    resizer.classList.add('resizing');
    document.body.style.cursor = 'col-resize';
    const onMove = (e) => {
      if (!isResizing) return;
      const w = Math.max(200, Math.min(650, e.clientX));
      state.gantt.sidebarWidth = w;
      sidebar.style.width = `${w}px`;
    };
    const onUp = () => {
      if (!isResizing) return;
      isResizing = false;
      resizer.classList.remove('resizing');
      document.body.style.cursor = '';
      store.set('ganttSidebarWidth', state.gantt.sidebarWidth);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  });
  resizer.addEventListener('dblclick', () => {
    state.gantt.sidebarWidth = 340;
    sidebar.style.width = '340px';
    store.set('ganttSidebarWidth', 340);
  });

  // 3. Right Content Area: Either the Gantt Timeline Canvas OR the Docked Card
  const rightContent = h('div', { class: 'gantt-content' });
  const timelineEl = h('div', { class: 'gantt-timeline', 'aria-label': 'タイムライン' });

  // Generate 20 days range (-10 days to +9 days)
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const startDay = new Date(today.getTime() - 9 * DAY_MILLIS);
  const totalDays = 22;
  const colWidth = 48;

  const calDays = [];
  for (let i = 0; i < totalDays; i++) {
    const d = new Date(startDay.getTime() + i * DAY_MILLIS);
    const isToday = d.getTime() === today.getTime();
    const isWeekend = d.getDay() === 0 || d.getDay() === 6;
    const label = `${d.getMonth() + 1}/${d.getDate()}`;
    calDays.push(h('div', {
      class: `gantt-day-header${isToday ? ' is-today' : ''}${isWeekend ? ' is-weekend' : ''}`
    }, h('span', { text: label })));
  }

  const calHeader = h('div', { class: 'gantt-cal-header', style: { width: `${totalDays * colWidth}px` } },
    h('div', { class: 'gantt-cal-month', text: `${today.getFullYear()}年 ${today.getMonth() + 1}月` }),
    h('div', { class: 'gantt-cal-days' }, ...calDays)
  );

  const canvasRows = h('div', { class: 'gantt-canvas-rows', style: { width: `${totalDays * colWidth}px` } });

  // TODAY Red vertical marker line (day 9 = 9 * colWidth + 24)
  const todayOffset = 9 * colWidth + 24;
  const todayLine = h('div', { class: 'gantt-today-line', style: { left: `${todayOffset}px` } });
  canvasRows.append(todayLine);

  // Bars for each row
  for (const it of items) {
    const { card, isTask } = it;
    const rowEl = h('div', { class: 'gantt-canvas-row' });
    const diffDays = Math.max(0, Math.min(8, daysAgo(card.updatedAt)));
    const barLeft = Math.max(0, (9 - diffDays) * colWidth);
    const barWidth = Math.max(96, Math.min(300, (diffDays + 2) * colWidth));

    const bar = h('div', {
      class: `gantt-bar-item ${isTask ? 'task-bracket' : 'session-bar'}`,
      style: { left: `${barLeft}px`, width: `${barWidth}px` },
      title: card.title,
      onclick: () => ganttSelect(card.id)
    },
      h('div', { class: 'gantt-bar-progress', style: { width: isTask ? '75%' : '80%' } }),
      h('span', { class: 'truncate font-bold', text: card.title }),
      h('span', { class: 'text-[9px] font-mono muted ml-1', text: relTime(card.updatedAt) })
    );

    // Hover tooltip
    bar.addEventListener('mousemove', (e) => {
      showGanttTooltip(e, card);
    });
    bar.addEventListener('mouseleave', () => {
      hideGanttTooltip();
    });

    rowEl.append(bar);
    canvasRows.append(rowEl);
  }

  timelineEl.append(calHeader, canvasRows);

  // Docked card host (overlay renders here when docked)
  const mainDock = h('section', { class: 'inbox-main gantt-main', 'aria-label': '選んだカード' });

  rightContent.append(timelineEl, mainDock);
  container.append(sidebar, resizer, rightContent);

  // Sync scroll on mount
  queueMicrotask(() => {
    timelineEl.scrollLeft = Math.max(0, todayOffset - 240);
  });

  return container;
}

function ganttSelect(id) {
  state.gantt.sel = id;
  for (const r of $$('.gantt-row')) r.setAttribute('aria-selected', String(r.dataset.cardId === id));
  openCard(id, { dock: true });
}

// Tooltip logic
let ganttTooltipEl = null;
function showGanttTooltip(e, card) {
  if (!ganttTooltipEl) {
    ganttTooltipEl = h('div', { class: 'gantt-hover-tooltip' });
    document.body.append(ganttTooltipEl);
  }
  ganttTooltipEl.replaceChildren(
    h('div', { class: 'font-bold text-xs truncate mb-1' }, card.title),
    h('div', { class: 'text-[10px] text-sky-300 font-mono mb-1' }, `更新: ${fmtDate(card.updatedAt)}`),
    h('div', { class: 'text-[11px] leading-tight text-white/90 bg-black/40 p-1.5 rounded' },
      card.activity || card.lastMessage || 'タスクが進行中です。クリックで詳細を開きます。'
    )
  );
  ganttTooltipEl.style.left = `${e.clientX}px`;
  ganttTooltipEl.style.top = `${e.clientY - 12}px`;
  ganttTooltipEl.hidden = false;
}

function hideGanttTooltip() {
  if (ganttTooltipEl) ganttTooltipEl.hidden = true;
}

function syncGanttDockedCard() {
  if (!ganttOn() || !$('#board .gantt-main')) { if (paneDocked()) closeCards({ dock: false }); return; }
  if (paneDocked()) return paneMetrics();
  if (paneLayer.hidden && state.gantt.sel && findCard(state.gantt.sel)) openCard(state.gantt.sel, { dock: true });
}
