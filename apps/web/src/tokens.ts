/**
 * RecruitOS design tokens and Variant B Bench styles.
 * Transcribed from DESIGN.md and tokens.css.
 * Strictly zero em dashes.
 */
export const TOKENS_CSS = `
:root {
  color-scheme: light;

  --bg:               #ECEEEF;
  --surface:          #F7F8F8;
  --surface-paper:    #FFFFFF;
  --surface-inset:    #E4E7E8;
  --hairline:         #CDD2D4;
  --hairline-strong:  #98A0A4;

  --text:             #14181B;
  --text-muted:       #5C666B;
  --text-faint:       #838C91;

  --accent:           #2F5FD0;
  --accent-hover:     #24499F;
  --accent-wash:      #E6EDFB;

  --support:          #0F7A6A;
  --support-wash:     #DFF0EC;
  --contradict:       #B07A16;
  --contradict-wash:  #F7EEDA;
  --gap-outline:      #98A0A4;

  --danger:           #9E2B25;
  --danger-wash:      #F7E3E1;

  --grid-dot:         #D6DADC;

  --t-micro:  11px;  --lh-micro:  15px;
  --t-xs:     12px;  --lh-xs:     16px;
  --t-sm:     13px;  --lh-sm:     18px;
  --t-base:   14px;  --lh-base:   20px;
  --t-md:     16px;  --lh-md:     24px;
  --t-lg:     19px;  --lh-lg:     26px;
  --t-xl:     26px;  --lh-xl:     32px;
  --t-doc:    17px;  --lh-doc:    27px;
  --t-doc-sm: 15px;  --lh-doc-sm: 24px;

  --r-row:    2px;
  --r-panel:  4px;
  --r-dialog: 6px;
  --r-pill: 999px;
  --r-mark:   0px;

  --row-h:      36px;
  --row-text:   13px;
  --row-lh:     18px;

  --bar-h:  48px;
  --rail-w: 216px;

  --f-sans: "IBM Plex Sans", system-ui, -apple-system, "Segoe UI", sans-serif;
  --f-cond: "IBM Plex Sans Condensed", "IBM Plex Sans", system-ui, sans-serif;
  --f-serif: "Source Serif 4", "Source Serif Pro", Charter, Georgia, serif;
  --f-mono: "IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace;
}

[data-density="compact"]     { --row-h: 28px; --row-text: 12px; --row-lh: 16px; }
[data-density="default"]     { --row-h: 36px; --row-text: 13px; --row-lh: 18px; }
[data-density="comfortable"] { --row-h: 44px; --row-text: 14px; --row-lh: 20px; }

[data-theme="dark"] {
  color-scheme: dark;

  --bg:               #0E1114;
  --surface:          #161A1E;
  --surface-paper:    #1C2126;
  --surface-inset:    #12161A;
  --hairline:         #2C333A;
  --hairline-strong:  #5E6871;

  --text:             #E9EDEF;
  --text-muted:       #99A3AA;
  --text-faint:       #77818A;

  --accent:           #7AA5F5;
  --accent-hover:     #9CBEFF;
  --accent-wash:      #17263F;

  --support:          #4FC0A8;
  --support-wash:     #102B27;
  --contradict:       #DFAE55;
  --contradict-wash:  #2E2513;
  --gap-outline:      #5E6871;

  --danger:           #E8827A;
  --danger-wash:      #331B19;

  --grid-dot:         #262C32;
}

* { box-sizing: border-box; }

html, body {
  margin: 0;
  height: 100%;
  background: var(--bg);
  color: var(--text);
  font-family: var(--f-sans);
  font-size: var(--t-base);
  line-height: var(--lh-base);
  -webkit-font-smoothing: antialiased;
}

.mono {
  font-family: var(--f-mono);
  font-variant-numeric: tabular-nums lining-nums;
}

.serif { font-family: var(--f-serif); }

.caps {
  font-family: var(--f-mono);
  font-size: var(--t-micro);
  line-height: var(--lh-micro);
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--text-muted);
}

.muted { color: var(--text-muted); }
.faint { color: var(--text-faint); }

a, .link {
  color: var(--accent);
  text-decoration: underline;
  text-underline-offset: 2px;
  cursor: pointer;
}

.app {
  display: grid;
  grid-template-rows: var(--bar-h) 1fr;
  grid-template-columns: var(--rail-w) 1fr;
  grid-template-areas: "bar bar" "rail work";
  height: 100vh;
}

.globalbar {
  grid-area: bar;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 0 16px;
  background: var(--surface);
  border-bottom: 1px solid var(--hairline);
  font-size: var(--t-xs);
  line-height: var(--lh-xs);
}
.globalbar .brand { font-weight: 600; font-size: var(--t-base); letter-spacing: -0.01em; }
.globalbar .sep { color: var(--hairline-strong); }
.globalbar .spacer { flex: 1; }

.pill-synthetic {
  font-family: var(--f-mono);
  font-size: var(--t-micro);
  letter-spacing: 0.04em;
  text-transform: uppercase;
  border: 1px solid var(--hairline-strong);
  border-radius: var(--r-pill);
  padding: 2px 8px;
  color: var(--text-muted);
  background: none;
}

.rail {
  grid-area: rail;
  background: var(--surface);
  border-right: 1px solid var(--hairline);
  padding: 12px 0;
  overflow-y: auto;
}
.rail .group { padding: 8px 12px 4px; }
.rail .item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 12px;
  font-size: var(--t-sm);
  line-height: var(--lh-sm);
  color: var(--text-muted);
  border-left: 3px solid transparent;
  cursor: pointer;
}
.rail .item:hover { background: var(--surface-inset); color: var(--text); }
.rail .item.active {
  color: var(--text);
  font-weight: 600;
  border-left-color: var(--accent);
  background: var(--surface-inset);
}
.rail .item .n { font-family: var(--f-mono); font-size: var(--t-xs); color: var(--text-faint); }

.work { grid-area: work; overflow: auto; display: flex; flex-direction: column; }

/* B: instrument band */
.band {
  display: grid;
  grid-template-columns: repeat(6, 1fr);
  border-bottom: 1px solid var(--hairline-strong);
  background: var(--surface);
}
.band > div {
  padding: 8px 12px;
  border-right: 1px solid var(--hairline);
}
.band > div:last-child { border-right: none; }
.band .k { font-family: var(--f-cond); font-size: 11px; letter-spacing: .04em; text-transform: uppercase; color: var(--text-muted); }
.band .v { font-family: var(--f-mono); font-size: 16px; line-height: 24px; font-variant-numeric: tabular-nums; margin-top: 2px; }
.band .s { font-family: var(--f-mono); font-size: 11px; color: var(--text-faint); }

/* Tables */
table.q { width: 100%; border-collapse: collapse; }
table.q thead th {
  position: sticky; top: 0; z-index: 2;
  height: 34px;
  background: var(--surface-inset);
  border-bottom: 1px solid var(--hairline);
  font-family: var(--f-cond);
  font-size: var(--t-micro);
  line-height: var(--lh-micro);
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--text-muted);
  text-align: left;
  padding: 0 8px;
  font-weight: 600;
  white-space: nowrap;
}
table.q td {
  height: var(--row-h);
  padding: 6px 8px;
  font-size: var(--row-text);
  line-height: var(--row-lh);
  border-bottom: 1px solid var(--hairline);
  vertical-align: middle;
  white-space: nowrap;
}
table.q td.num {
  font-family: var(--f-mono);
  font-variant-numeric: tabular-nums lining-nums;
  text-align: right;
}
table.q tr.row-escalated td:first-child { box-shadow: inset 3px 0 0 0 var(--accent); }
table.q tr.rejected td { color: var(--text-muted); }

.group-head {
  background: var(--bg);
  border-top: 1px solid var(--hairline-strong);
  border-bottom: 1px solid var(--hairline);
}
.group-head td {
  height: 26px;
  padding: 4px 8px;
  font-family: var(--f-mono);
  font-size: var(--t-micro);
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--text-muted);
}

.cut td {
  height: 22px;
  padding: 0 8px;
  border-top: 2px solid var(--text);
  border-bottom: none;
  font-family: var(--f-mono);
  font-size: var(--t-micro);
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text);
  text-align: center;
  background: var(--bg);
}

.status { font-family: var(--f-mono); font-size: var(--t-xs); color: var(--text-muted); }
.status.rejected { color: var(--danger); }
.reason { font-family: var(--f-mono); font-size: var(--t-xs); color: var(--text-muted); white-space: normal; }

.strip { display: inline-flex; gap: 2px; vertical-align: middle; }
.strip i {
  display: block;
  width: 7px;
  height: 14px;
  border-radius: 1px;
}
.strip i.sup { background: var(--support); }
.strip i.con {
  background: var(--contradict-wash);
  border: 1px solid var(--contradict);
  background-image: repeating-linear-gradient(45deg,
    var(--contradict) 0 1px, transparent 1px 3px);
}
.strip i.gap {
  background: none;
  border: 1px dashed var(--gap-outline);
}

/* Bracket */
.bracket {
  border-left: 3px solid var(--hairline-strong);
  padding-left: 10px;
}
.bracket.sup { border-left-color: var(--support); }
.bracket.con { border-left-color: var(--contradict); }
.bracket.esc { border-left-color: var(--accent); }
.bracket.gap {
  border-left: none;
  border: 1px dashed var(--gap-outline);
  padding: 10px;
}

/* Span Highlights */
mark.sup {
  background: var(--support-wash);
  border-radius: 0;
  color: inherit;
  box-shadow: inset 0 -2px 0 0 var(--support);
  padding: 1px 0;
}
mark.con {
  background: var(--contradict-wash);
  background-image: repeating-linear-gradient(45deg,
    rgba(176,122,22,0.30) 0 1px, transparent 1px 4px);
  border-radius: 0;
  color: inherit;
  box-shadow: inset 0 -2px 0 0 var(--contradict);
  padding: 1px 0;
}
mark .tag {
  font-family: var(--f-mono);
  font-size: 10px;
  color: var(--text-faint);
  vertical-align: super;
  margin-left: 2px;
}

/* Span Integrity Refusal State */
.span-refused {
  display: inline;
  border: 1px solid var(--danger);
  border-radius: 0;
  color: var(--danger);
  font-family: var(--f-mono);
  font-size: var(--t-xs);
  padding: 1px 4px;
  background: repeating-linear-gradient(135deg,
    var(--danger-wash) 0 3px, transparent 3px 6px);
  text-decoration: line-through;
}

/* Packet B 3-pane Layout */
.packet-b { display: grid; grid-template-columns: 5fr 7fr 6fr; height: 100%; position: relative; }
.pane { overflow: auto; position: relative; }
.pane.arith  { background: var(--surface-inset); border-right: 1px solid var(--hairline-strong); }
.pane.ledger { background: var(--surface); border-right: 1px solid var(--hairline-strong); }
.pane.source { background: var(--surface-paper); }
.panehead {
  position: sticky; top: 0; z-index: 3;
  display: flex; align-items: center; justify-content: space-between;
  height: 30px; padding: 0 12px;
  background: inherit;
  border-bottom: 1px solid var(--hairline-strong);
  font-family: var(--f-cond); font-size: 11px; letter-spacing: .04em;
  text-transform: uppercase; color: var(--text-muted);
}

.arithbox { padding: 12px; }
.arithbox .big { font-family: var(--f-mono); font-size: 26px; line-height: 32px; font-variant-numeric: tabular-nums; }
table.terms { width: 100%; border-collapse: collapse; font-family: var(--f-mono); font-size: 12px; }
table.terms th { font-family: var(--f-cond); font-size: 11px; letter-spacing: .04em; text-transform: uppercase;
  color: var(--text-muted); text-align: left; font-weight: 600; padding: 3px 4px; border-bottom: 1px solid var(--hairline); }
table.terms td { padding: 3px 4px; border-bottom: 1px solid var(--hairline); }
table.terms td.n { text-align: right; }
table.terms tr.on td { background: var(--accent-wash); box-shadow: inset 3px 0 0 0 var(--accent); }
table.terms tr.total td { border-top: 1px solid var(--text); border-bottom: none; font-weight: 600; }

.dimblock { padding: 10px 12px; border-bottom: 1px solid var(--hairline-strong); }
.dimhead { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.dimhead .idx { font-family: var(--f-mono); font-size: 12px; color: var(--text-faint); }
.dimhead .nm { font-size: 13px; font-weight: 600; flex: 1; }
.card {
  background: var(--surface-paper);
  border: 1px solid var(--hairline);
  border-radius: var(--r-panel);
  padding: 8px 10px;
  margin-bottom: 6px;
}
.card q { font-family: var(--f-serif); font-size: 14px; line-height: 22px; display: block; quotes: none; }
.card .meta { font-family: var(--f-mono); font-size: 11px; color: var(--text-faint); margin-top: 4px; }
.card.focused { border-color: var(--accent); background: var(--accent-wash); }
.doc { padding: 20px 24px; max-width: 68ch; font-family: var(--f-serif); font-size: 16px; line-height: 26px; }
`;
