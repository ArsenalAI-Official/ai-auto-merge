/**
 * Self-contained operations dashboard served at GET /dashboard.
 * No build step, no CDN assets — safe for air-gapped deployments.
 * Polls /api/stats and /api/runs every 10s.
 */
export const dashboardHtml = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ai-auto-merge · dashboard</title>
<style>
  :root {
    --bg: #0b0f17; --panel: #121826; --panel2: #0e1420; --line: #1f2937;
    --text: #e5e7eb; --muted: #8b95a7; --accent: #7c8cff; --accent2: #34d399;
    --warn: #fbbf24; --bad: #f87171; --mono: ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: radial-gradient(1200px 500px at 20% -10%, #16203a 0%, var(--bg) 55%);
    color: var(--text); font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  }
  header {
    display: flex; align-items: center; gap: 12px; padding: 18px 28px;
    border-bottom: 1px solid var(--line); position: sticky; top: 0;
    background: rgba(11,15,23,.85); backdrop-filter: blur(8px); z-index: 5;
  }
  .logo { font-size: 20px; }
  h1 { font-size: 16px; margin: 0; font-weight: 600; letter-spacing: .2px; }
  h1 span { color: var(--accent); }
  .sub { color: var(--muted); font-size: 12px; margin-left: auto; display: flex; gap: 14px; align-items: center; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--accent2); display: inline-block; margin-right: 5px; }
  .dot.err { background: var(--bad); }
  main { max-width: 1180px; margin: 0 auto; padding: 24px 28px 60px; }
  .cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); gap: 14px; }
  .card {
    background: linear-gradient(180deg, var(--panel) 0%, var(--panel2) 100%);
    border: 1px solid var(--line); border-radius: 12px; padding: 14px 16px;
  }
  .card .k { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .8px; }
  .card .v { font-size: 24px; font-weight: 650; margin-top: 4px; font-variant-numeric: tabular-nums; }
  .card .d { color: var(--muted); font-size: 11px; margin-top: 2px; }
  h2 { font-size: 13px; text-transform: uppercase; letter-spacing: 1px; color: var(--muted); margin: 30px 0 12px; }
  table { width: 100%; border-collapse: collapse; background: var(--panel2); border: 1px solid var(--line); border-radius: 12px; overflow: hidden; }
  thead th { text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: .8px; color: var(--muted); padding: 10px 14px; border-bottom: 1px solid var(--line); }
  tbody td { padding: 10px 14px; border-bottom: 1px solid var(--line); vertical-align: top; }
  tbody tr:last-child td { border-bottom: none; }
  tbody tr.run { cursor: pointer; }
  tbody tr.run:hover { background: #151c2c; }
  .pill { display: inline-block; padding: 2px 9px; border-radius: 999px; font-size: 11px; font-weight: 600; }
  .pill.resolved { background: #093; background: rgba(52,211,153,.15); color: var(--accent2); }
  .pill.partial { background: rgba(251,191,36,.15); color: var(--warn); }
  .pill.dry_run { background: rgba(124,140,255,.15); color: var(--accent); }
  .pill.review_required, .pill.skipped { background: rgba(251,191,36,.12); color: var(--warn); }
  .pill.error { background: rgba(248,113,113,.15); color: var(--bad); }
  .pill.no_conflicts, .pill.disabled { background: rgba(139,149,167,.15); color: var(--muted); }
  .pill.running { background: rgba(124,140,255,.2); color: var(--accent); animation: pulse 1.4s infinite; }
  @keyframes pulse { 50% { opacity: .55; } }
  .mono { font-family: var(--mono); font-size: 12px; }
  .muted { color: var(--muted); }
  .files { display: none; }
  tr.open + tr.files { display: table-row; }
  .files td { background: #0a0e16; padding: 8px 14px 14px; }
  .file-row { display: flex; gap: 10px; padding: 4px 0; font-size: 12px; align-items: baseline; }
  .file-row .path { font-family: var(--mono); color: var(--text); white-space: nowrap; }
  .file-row .exp { color: var(--muted); }
  .tag { font-size: 10px; padding: 1px 7px; border-radius: 6px; border: 1px solid var(--line); color: var(--muted); white-space: nowrap; }
  .tag.applied { color: var(--accent2); border-color: rgba(52,211,153,.4); }
  .bar { height: 6px; border-radius: 4px; background: var(--line); overflow: hidden; margin-top: 8px; }
  .bar i { display: block; height: 100%; background: linear-gradient(90deg, var(--accent), var(--accent2)); }
  .empty { text-align: center; color: var(--muted); padding: 36px 0; }
  a { color: var(--accent); text-decoration: none; }
</style>
</head>
<body>
<header>
  <div class="logo">🤖</div>
  <h1>ai-auto-merge <span>/ dashboard</span></h1>
  <div class="sub">
    <span id="conn"><span class="dot"></span>live</span>
    <span id="updated" class="mono"></span>
  </div>
</header>
<main>
  <div class="cards" id="cards"></div>
  <h2>What ai-auto-merge has learned <span class="muted">— accept/override patterns per repo &amp; file type</span></h2>
  <div id="insights"></div>
  <h2>Recent runs <span class="muted" id="window"></span></h2>
  <div id="runs"></div>
</main>
<script>
(() => {
  const token = new URLSearchParams(location.search).get('token');
  const qs = token ? '?token=' + encodeURIComponent(token) : '';
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

  const fmtTok = (n) => n >= 1e6 ? (n/1e6).toFixed(1)+'M' : n >= 1e3 ? (n/1e3).toFixed(1)+'k' : String(n);
  const fmtUsd = (n) => n === 0 ? '$0.00' : n < 0.01 ? '<$0.01' : '$' + n.toFixed(2);
  const ago = (iso) => {
    const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
    if (s < 60) return Math.floor(s) + 's ago';
    if (s < 3600) return Math.floor(s/60) + 'm ago';
    if (s < 86400) return Math.floor(s/3600) + 'h ago';
    return Math.floor(s/86400) + 'd ago';
  };
  const dur = (ms) => ms == null ? '—' : ms < 1000 ? ms + 'ms' : (ms/1000).toFixed(1) + 's';

  function card(k, v, d) {
    return '<div class="card"><div class="k">' + esc(k) + '</div><div class="v">' + v + '</div>' + (d ? '<div class="d">' + d + '</div>' : '') + '</div>';
  }

  function renderStats(s) {
    const o = s.runs.byOutcome || {};
    const ok = (o.resolved||0) + (o.partial||0);
    const attempted = ok + (o.review_required||0) + (o.error||0);
    const rate = attempted ? Math.round(ok/attempted*100) : null;
    const cachePct = s.usage.totalTokens ? Math.round(s.usage.cacheReadTokens/s.usage.totalTokens*100) : 0;
    const fastShare = s.files.total ? Math.round((1 - s.files.aiShare) * 100) : 0;
    $('cards').innerHTML = [
      card('Runs (window)', s.runs.total, s.runs.last24h + ' in last 24h · ' + s.runs.inflight + ' running'),
      card('Resolution rate', rate == null ? '—' : rate + '%', 'resolved+partial of attempted' + (rate != null ? '<div class="bar"><i style="width:' + rate + '%"></i></div>' : '')),
      card('Files auto-applied', s.files.autoApplied, s.files.flaggedForReview + ' flagged for review'),
      card('Fast-path share', fastShare + '%', 'resolved without AI calls'),
      card('Tokens', fmtTok(s.usage.totalTokens), cachePct + '% from cache'),
      card('Est. spend', fmtUsd(s.usage.costUsd), 'avg run ' + dur(s.usage.avgDurationMs)),
      card('Learning', s.learning && s.learning.enabled ? s.learning.trackedBuckets + ' tracked' : 'off', s.learning && s.learning.enabled ? s.learning.gatingBuckets + ' categories auto-gated' : 'set LEARNING_ENABLED'),
      card('Queue', esc(s.queue.mode), s.queue.stats ? s.queue.stats.waiting + ' waiting · ' + s.queue.stats.active + ' active · ' + s.queue.stats.failed + ' failed' : 'in-process fallback'),
      card('Uptime', s.uptimeHuman, 'v' + esc(s.version) + (s.notifications ? ' · notify on' : '')),
    ].join('');
    $('window').textContent = '(last ' + s.runs.total + ')';
  }

  function renderInsights(data) {
    if (!data.enabled) {
      $('insights').innerHTML = '<div class="empty">Adaptive learning is disabled (LEARNING_ENABLED=false).</div>';
      return;
    }
    const rows = data.buckets.filter((b) => b.accepted + b.overridden > 0);
    if (!rows.length) {
      $('insights').innerHTML = '<div class="empty">No learning signal yet. As humans accept or override AI resolutions, per-repo / per-filetype patterns appear here — and categories crossing the override threshold get auto-routed to manual review.</div>';
      return;
    }
    const body = rows.slice(0, 20).map((b) => {
      const total = b.accepted + b.overridden;
      const pct = Math.round(b.overrideRate * 100);
      const barColor = b.gating ? 'var(--bad)' : pct > 25 ? 'var(--warn)' : 'var(--accent2)';
      return '<tr>' +
        '<td class="mono">' + esc(b.repo) + '</td>' +
        '<td class="mono">.' + esc(b.ext) + '</td>' +
        '<td class="mono muted">' + esc(b.method) + '</td>' +
        '<td class="mono">' + b.accepted + ' / ' + b.overridden + '</td>' +
        '<td style="min-width:120px"><div class="bar"><i style="width:' + pct + '%;background:' + barColor + '"></i></div><span class="mono muted">' + pct + '% overridden (' + total + ')</span></td>' +
        '<td>' + (b.gating ? '<span class="pill error">auto-gated</span>' : '<span class="pill resolved">trusted</span>') + '</td>' +
      '</tr>';
    }).join('');
    $('insights').innerHTML = '<table><thead><tr>' +
      '<th>Repo</th><th>Type</th><th>Method</th><th>Accept / Override</th><th>Override rate</th><th>Status</th>' +
      '</tr></thead><tbody>' + body + '</tbody></table>' +
      '<div class="muted mono" style="margin-top:8px">Gating at ≥' + Math.round(data.threshold * 100) + '% override once a category has ≥' + data.minSamples + ' samples.</div>';
  }

  function fileRow(f) {
    return '<div class="file-row">' +
      '<span class="tag' + (f.applied ? ' applied' : '') + '">' + (f.applied ? 'applied' : 'review') + '</span>' +
      '<span class="tag">' + esc(f.method) + '</span>' +
      '<span class="tag">' + esc(f.confidence) + '</span>' +
      '<span class="path">' + esc(f.path) + '</span>' +
      '<span class="exp">' + esc(f.explanation) + '</span>' +
    '</div>';
  }

  function renderRuns(runs) {
    if (!runs.length) {
      $('runs').innerHTML = '<div class="empty">No runs yet — merge a PR (or comment <span class="mono">/ai-merge</span> on one) and watch this space.</div>';
      return;
    }
    const rows = runs.map((r, i) => {
      const outcome = r.outcome || 'running';
      const trig = r.trigger.kind === 'merge' ? '#' + r.trigger.prNumber + ' merged by @' + esc(r.trigger.mergedBy) : '/ai-merge by @' + esc(r.trigger.requestedBy);
      const tokens = r.usage ? fmtTok(r.usage.inputTokens + r.usage.outputTokens + r.usage.cacheReadTokens + r.usage.cacheWriteTokens) : '0';
      return '<tr class="run" data-i="' + i + '">' +
        '<td><span class="pill ' + esc(outcome) + '">' + esc(outcome) + '</span></td>' +
        '<td class="mono">' + (r.prUrl ? '<a href="' + esc(r.prUrl) + '" target="_blank" rel="noopener">' + esc(r.repo) + '#' + r.prNumber + '</a>' : esc(r.repo) + '#' + r.prNumber) + '</td>' +
        '<td>' + esc(r.prTitle).slice(0, 70) + '</td>' +
        '<td class="muted">' + trig + '</td>' +
        '<td class="mono muted">' + r.files.length + ' files</td>' +
        '<td class="mono muted">' + tokens + ' tok · ' + fmtUsd(r.usage ? r.usage.costUsd : 0) + '</td>' +
        '<td class="mono muted">' + dur(r.durationMs) + '</td>' +
        '<td class="mono muted">' + ago(r.startedAt) + '</td>' +
      '</tr>' +
      '<tr class="files"><td colspan="8">' +
        (r.files.length ? r.files.map(fileRow).join('') : '<span class="muted">no file details</span>') +
        (r.detail ? '<div class="file-row"><span class="tag">detail</span><span class="exp">' + esc(r.detail) + '</span></div>' : '') +
        (r.commitSha ? '<div class="file-row"><span class="tag">commit</span><span class="path">' + esc(r.commitSha.slice(0,7)) + '</span></div>' : '') +
      '</td></tr>';
    }).join('');
    $('runs').innerHTML = '<table><thead><tr>' +
      '<th>Outcome</th><th>PR</th><th>Title</th><th>Trigger</th><th>Files</th><th>Usage</th><th>Duration</th><th>When</th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table>';
    document.querySelectorAll('tr.run').forEach((tr) => {
      tr.addEventListener('click', () => tr.classList.toggle('open'));
    });
  }

  async function refresh() {
    try {
      const [stats, runs, insights] = await Promise.all([
        fetch('/api/stats' + qs).then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); }),
        fetch('/api/runs' + qs + (qs ? '&' : '?') + 'limit=50').then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); }),
        fetch('/api/insights' + qs).then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); }),
      ]);
      renderStats(stats);
      renderInsights(insights);
      renderRuns(runs.runs);
      $('conn').innerHTML = '<span class="dot"></span>live';
      $('updated').textContent = new Date().toLocaleTimeString();
    } catch (e) {
      $('conn').innerHTML = '<span class="dot err"></span>' + (String(e.message) === '401' ? 'unauthorized — append ?token=…' : 'disconnected');
    }
  }

  refresh();
  setInterval(() => { if (!document.hidden) refresh(); }, 10_000);
})();
</script>
</body>
</html>
`;
