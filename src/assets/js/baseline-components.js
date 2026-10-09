/**
 * Native Web Components for Baseline Availability:
 * - <baseline-summary-table>: Interactive enhancement for the 7-day average summary table
 * - <baseline-timeseries-chart>: Interactive SVG time-series chart (0-100% Y-axis, up to 90 days X-axis)
 *
 * Uses strict DOM creation APIs (createElement / createElementNS / textContent) without innerHTML
 * and avoids inline style attributes to comply with strict Content-Security-Policy (style-src 'self').
 */

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * Formats a number to 2 decimal places with a "%" suffix.
 * @param {number} value
 * @returns {string}
 */
function formatPct(value) {
  return `${Number(value || 0).toFixed(2)}%`;
}

/**
 * Formats a signed percentage delta (e.g. "+0.61%" or "-0.46%").
 * @param {number} delta
 * @returns {string}
 */
function formatDelta(delta) {
  const num = Number(delta || 0);
  if (num === 0) return "0.00%";
  return `${num > 0 ? "+" : ""}${num.toFixed(2)}%`;
}

/**
 * Formats an ISO YYYY-MM-DD date string into a short human-readable label (e.g. "Sep 28").
 * @param {string} isoDate
 * @returns {string}
 */
function formatShortDate(isoDate) {
  const ms = Date.parse(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(ms)) return isoDate;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(ms));
}

/**
 * Creates an SVG element in the SVG namespace with the given attributes.
 * @param {string} tag
 * @param {Record<string, string | number>} [attrs={}]
 * @returns {SVGElement}
 */
function createSvgEl(tag, attrs = {}) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    el.setAttribute(k, String(v));
  }
  return el;
}

/**
 * Shared state bus between <baseline-summary-table> and <baseline-timeseries-chart>.
 */
const viewState = {
  metricMode: "pct", // "pct" (% of mapped) | "pctTotal" (% of total)
  highlightedTargetId: null,
  pinnedTargetId: null,
  selectedDateIndex: null,
};

function notifyStateChange(source) {
  window.dispatchEvent(
    new CustomEvent("baseline-view-state", {
      detail: { ...viewState, source },
    })
  );
}

class BaselineSummaryTable extends HTMLElement {
  connectedCallback() {
    this.data = window.BASELINE_INITIAL_DATA || null;
    this.onDataReady = (e) => {
      this.data = e.detail;
      this.setupInteractivity();
    };
    this.onViewState = () => {
      this.syncHighlightAndMetric();
    };

    window.addEventListener("baseline-data-ready", this.onDataReady);
    window.addEventListener("baseline-view-state", this.onViewState);

    if (this.data) {
      this.setupInteractivity();
    }
  }

  disconnectedCallback() {
    window.removeEventListener("baseline-data-ready", this.onDataReady);
    window.removeEventListener("baseline-view-state", this.onViewState);
  }

  setupInteractivity() {
    const rows = this.querySelectorAll("tbody tr[data-target-id]");
    rows.forEach((row) => {
      const targetId = row.getAttribute("data-target-id");
      if (!targetId) return;

      row.addEventListener("mouseenter", () => {
        if (!viewState.pinnedTargetId) {
          viewState.highlightedTargetId = targetId;
          notifyStateChange("table");
        }
      });

      row.addEventListener("mouseleave", () => {
        if (!viewState.pinnedTargetId && viewState.highlightedTargetId === targetId) {
          viewState.highlightedTargetId = null;
          notifyStateChange("table");
        }
      });

      row.addEventListener("click", () => {
        if (viewState.pinnedTargetId === targetId) {
          viewState.pinnedTargetId = null;
          viewState.highlightedTargetId = null;
        } else {
          viewState.pinnedTargetId = targetId;
          viewState.highlightedTargetId = targetId;
        }
        notifyStateChange("table");
      });

      row.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          row.click();
        }
      });
    });

    const modeButtons = this.querySelectorAll("button[data-metric-mode]");
    modeButtons.forEach((btn) => {
      btn.addEventListener("click", () => {
        const mode = btn.getAttribute("data-metric-mode");
        if (mode === "pct" || mode === "pctTotal") {
          viewState.metricMode = mode;
          notifyStateChange("table-mode");
        }
      });
    });

    this.syncHighlightAndMetric();
  }

  syncHighlightAndMetric() {
    const activeTargetId = viewState.pinnedTargetId || viewState.highlightedTargetId;
    const rows = this.querySelectorAll("tbody tr[data-target-id]");

    const targetMap = new Map();
    if (this.data && Array.isArray(this.data.targets)) {
      for (const t of this.data.targets) {
        targetMap.set(t.id, t);
      }
    }

    rows.forEach((row) => {
      const id = row.getAttribute("data-target-id");
      const isHighlighted = activeTargetId === id;
      const isPinned = viewState.pinnedTargetId === id;
      row.toggleAttribute("data-highlighted", isHighlighted);
      row.toggleAttribute("data-pinned", isPinned);
      row.setAttribute("aria-selected", isPinned ? "true" : "false");

      const target = targetMap.get(id);
      if (target) {
        const primaryVal =
          viewState.metricMode === "pctTotal" ? target.avg7.pctTotal : target.avg7.pct;
        const primaryText = row.querySelector("[data-cell-primary-value]");
        if (primaryText) {
          primaryText.textContent = formatPct(primaryVal);
        }
        const barFill = row.querySelector("rect.pct-bar-fill");
        if (barFill) {
          barFill.setAttribute("width", String(Math.max(0, Math.min(100, primaryVal))));
        }
      }
    });

    const modeButtons = this.querySelectorAll("button[data-metric-mode]");
    modeButtons.forEach((btn) => {
      const isSelected = btn.getAttribute("data-metric-mode") === viewState.metricMode;
      btn.setAttribute("aria-pressed", isSelected ? "true" : "false");
    });
  }
}

class BaselineTimeseriesChart extends HTMLElement {
  connectedCallback() {
    this.data = window.BASELINE_INITIAL_DATA || null;
    this.hoveredDateIdx = null;
    this.hoveredTargetId = null;

    this.onDataReady = (e) => {
      this.data = e.detail;
      this.render();
    };
    this.onViewState = () => {
      this.updateActiveStates();
    };

    window.addEventListener("baseline-data-ready", this.onDataReady);
    window.addEventListener("baseline-view-state", this.onViewState);

    if (this.data) {
      this.render();
    }
  }

  disconnectedCallback() {
    window.removeEventListener("baseline-data-ready", this.onDataReady);
    window.removeEventListener("baseline-view-state", this.onViewState);
  }

  getYearStrokeClass(year, minYear, maxYear) {
    const span = Math.max(1, maxYear - minYear);
    const ratio = (year - minYear) / span;
    if (ratio >= 0.8) return "year-line-recent";
    if (ratio >= 0.45) return "year-line-mid";
    return "year-line-older";
  }

  render() {
    this.replaceChildren();
    if (!this.data || !Array.isArray(this.data.dates) || this.data.dates.length === 0) {
      const empty = document.createElement("p");
      empty.className = "empty-state";
      empty.textContent = "No time-series data available yet.";
      this.appendChild(empty);
      return;
    }

    const { dates, targets } = this.data;
    const dayCount = dates.length;
    this.hoveredDateIdx = dayCount - 1;

    // 1. Top Legend / Target Filter Bar
    const controlsRow = document.createElement("div");
    controlsRow.className = "chart-controls-bar";

    const legendGroup = document.createElement("div");
    legendGroup.className = "chart-legend";
    legendGroup.setAttribute("role", "toolbar");
    legendGroup.setAttribute("aria-label", "Highlight Baseline target line");

    this.legendButtons = new Map();
    for (const t of targets) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `legend-pill legend-pill-${t.kind}`;
      btn.setAttribute("data-target-id", t.id);
      btn.setAttribute("aria-pressed", "false");

      const swatch = document.createElement("span");
      swatch.className = `legend-swatch swatch-${t.kind}`;
      swatch.setAttribute("aria-hidden", "true");
      btn.appendChild(swatch);

      const labelSpan = document.createElement("span");
      labelSpan.textContent = t.kind === "year" ? String(t.year) : t.label;
      btn.appendChild(labelSpan);

      btn.addEventListener("mouseenter", () => {
        if (!viewState.pinnedTargetId) {
          viewState.highlightedTargetId = t.id;
          notifyStateChange("chart-legend");
        }
      });
      btn.addEventListener("mouseleave", () => {
        if (!viewState.pinnedTargetId && viewState.highlightedTargetId === t.id) {
          viewState.highlightedTargetId = null;
          notifyStateChange("chart-legend");
        }
      });
      btn.addEventListener("click", () => {
        if (viewState.pinnedTargetId === t.id) {
          viewState.pinnedTargetId = null;
          viewState.highlightedTargetId = null;
        } else {
          viewState.pinnedTargetId = t.id;
          viewState.highlightedTargetId = t.id;
        }
        notifyStateChange("chart-legend");
      });

      this.legendButtons.set(t.id, btn);
      legendGroup.appendChild(btn);
    }

    controlsRow.appendChild(legendGroup);
    this.appendChild(controlsRow);

    // 2. SVG Time-Series Chart Canvas
    const svgWrap = document.createElement("div");
    svgWrap.className = "chart-svg-container";

    const W = 920;
    const H = 400;
    const padL = 56;
    const padR = 28;
    const padT = 24;
    const padB = 44;
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;

    this.chartGeom = { W, H, padL, padR, padT, padB, plotW, plotH };

    const svg = createSvgEl("svg", {
      viewBox: `0 0 ${W} ${H}`,
      class: "timeseries-svg",
      role: "img",
      "aria-label": `Baseline availability percentage time series from ${dates[0]} to ${dates[dayCount - 1]}`,
      tabindex: "0",
    });

    // Horizontal Y-axis gridlines & 0-100% labels
    const gridGroup = createSvgEl("g", { class: "chart-grid" });
    for (let pct = 0; pct <= 100; pct += 20) {
      const y = padT + plotH - (pct / 100) * plotH;
      const line = createSvgEl("line", {
        x1: padL,
        y1: y.toFixed(1),
        x2: W - padR,
        y2: y.toFixed(1),
        class: pct === 0 || pct === 100 ? "grid-line grid-line-axis" : "grid-line",
      });
      gridGroup.appendChild(line);

      const label = createSvgEl("text", {
        x: padL - 10,
        y: (y + 4).toFixed(1),
        "text-anchor": "end",
        class: "axis-label axis-label-y",
      });
      label.textContent = `${pct}%`;
      gridGroup.appendChild(label);
    }

    // X-axis date ticks (up to ~8 evenly spaced ticks)
    const maxTicks = Math.min(dayCount, 8);
    const tickIndices = new Set([0, dayCount - 1]);
    if (dayCount > 2) {
      const step = (dayCount - 1) / (maxTicks - 1);
      for (let i = 1; i < maxTicks - 1; i++) {
        tickIndices.add(Math.round(i * step));
      }
    }

    for (const idx of [...tickIndices].sort((a, b) => a - b)) {
      const x = this.getXForIndex(idx, dayCount);
      const tickLine = createSvgEl("line", {
        x1: x.toFixed(1),
        y1: padT + plotH,
        x2: x.toFixed(1),
        y2: padT + plotH + 6,
        class: "axis-tick",
      });
      gridGroup.appendChild(tickLine);

      const dateLabel = createSvgEl("text", {
        x: x.toFixed(1),
        y: padT + plotH + 24,
        "text-anchor": idx === 0 ? "start" : idx === dayCount - 1 ? "end" : "middle",
        class: "axis-label axis-label-x",
      });
      dateLabel.textContent = formatShortDate(dates[idx]);
      gridGroup.appendChild(dateLabel);
    }

    svg.appendChild(gridGroup);

    // Vertical hover crosshair line
    this.crosshairLine = createSvgEl("line", {
      x1: padL,
      y1: padT,
      x2: padL,
      y2: padT + plotH,
      class: "chart-crosshair",
    });
    svg.appendChild(this.crosshairLine);

    // Target lines group (years rendered first, Widely & Newly rendered on top)
    this.linesGroup = createSvgEl("g", { class: "chart-lines" });
    this.dotsGroup = createSvgEl("g", { class: "chart-dots" });
    svg.appendChild(this.linesGroup);
    svg.appendChild(this.dotsGroup);

    // Floating SVG Callout Tooltip (inside SVG to avoid inline CSS style attributes)
    this.tooltipGroup = createSvgEl("g", {
      class: "svg-tooltip",
      transform: "translate(70, 32)",
    });
    this.tooltipBg = createSvgEl("rect", {
      x: 0,
      y: 0,
      width: 224,
      height: 94,
      rx: 8,
      class: "svg-tooltip-bg",
    });
    this.tooltipDateText = createSvgEl("text", {
      x: 12,
      y: 20,
      class: "svg-tooltip-date",
    });
    this.tooltipPrimaryText = createSvgEl("text", {
      x: 12,
      y: 42,
      class: "svg-tooltip-primary",
    });
    this.tooltipWidelyText = createSvgEl("text", {
      x: 12,
      y: 64,
      class: "svg-tooltip-sub svg-tooltip-widely",
    });
    this.tooltipNewlyText = createSvgEl("text", {
      x: 12,
      y: 82,
      class: "svg-tooltip-sub svg-tooltip-newly",
    });
    this.tooltipGroup.appendChild(this.tooltipBg);
    this.tooltipGroup.appendChild(this.tooltipDateText);
    this.tooltipGroup.appendChild(this.tooltipPrimaryText);
    this.tooltipGroup.appendChild(this.tooltipWidelyText);
    this.tooltipGroup.appendChild(this.tooltipNewlyText);
    svg.appendChild(this.tooltipGroup);

    // Interactive pointer overlay
    const overlay = createSvgEl("rect", {
      x: padL,
      y: padT,
      width: plotW,
      height: plotH,
      class: "chart-hit-overlay",
    });

    const handlePointer = (clientX, clientY) => {
      const rect = svg.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      const svgX = ((clientX - rect.left) / rect.width) * W;
      const svgY = ((clientY - rect.top) / rect.height) * H;

      // Nearest date index
      const clampedX = Math.max(padL, Math.min(padL + plotW, svgX));
      const ratioX = dayCount > 1 ? (clampedX - padL) / plotW : 0;
      const dateIdx = Math.round(ratioX * (dayCount - 1));
      this.hoveredDateIdx = Math.max(0, Math.min(dayCount - 1, dateIdx));

      // Nearest line at that date index (unless a target is pinned)
      if (!viewState.pinnedTargetId) {
        const cursorPct = ((padT + plotH - svgY) / plotH) * 100;
        let closestId = null;
        let minDiff = Infinity;
        for (const t of targets) {
          const val = this.getValueForTarget(t, this.hoveredDateIdx);
          const diff = Math.abs(val - cursorPct);
          // Give primary lines (Widely / Newly) a slight magnetic preference
          const weightedDiff = t.kind === "year" ? diff : diff * 0.75;
          if (weightedDiff < minDiff && diff < 12) {
            minDiff = weightedDiff;
            closestId = t.id;
          }
        }
        if (this.hoveredTargetId !== closestId) {
          this.hoveredTargetId = closestId;
          viewState.highlightedTargetId = closestId;
          notifyStateChange("chart-hover");
        }
      }

      this.updateCrosshairAndInspector();
    };

    overlay.addEventListener("pointermove", (e) => {
      handlePointer(e.clientX, e.clientY);
    });

    overlay.addEventListener("pointerleave", () => {
      if (!viewState.pinnedTargetId && this.hoveredTargetId !== null) {
        this.hoveredTargetId = null;
        viewState.highlightedTargetId = null;
        notifyStateChange("chart-hover");
      }
      this.updateCrosshairAndInspector();
    });

    overlay.addEventListener("click", () => {
      if (this.hoveredTargetId) {
        if (viewState.pinnedTargetId === this.hoveredTargetId) {
          viewState.pinnedTargetId = null;
        } else {
          viewState.pinnedTargetId = this.hoveredTargetId;
          viewState.highlightedTargetId = this.hoveredTargetId;
        }
        notifyStateChange("chart-click");
      }
    });

    svg.addEventListener("keydown", (e) => {
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        this.hoveredDateIdx = Math.max(0, (this.hoveredDateIdx ?? dayCount - 1) - 1);
        this.updateCrosshairAndInspector();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        this.hoveredDateIdx = Math.min(dayCount - 1, (this.hoveredDateIdx ?? dayCount - 1) + 1);
        this.updateCrosshairAndInspector();
      }
    });

    svg.appendChild(overlay);
    svgWrap.appendChild(svg);
    this.appendChild(svgWrap);

    // 3. Date Details Breakdown Panel below the chart
    this.inspectorPanel = document.createElement("div");
    this.inspectorPanel.className = "chart-inspector-panel";
    this.inspectorPanel.setAttribute("aria-live", "polite");
    this.appendChild(this.inspectorPanel);

    this.drawLines();
    this.updateActiveStates();
  }

  getXForIndex(idx, dayCount) {
    const { padL, plotW } = this.chartGeom;
    if (dayCount <= 1) return padL + plotW / 2;
    return padL + (idx / (dayCount - 1)) * plotW;
  }

  getYForPct(pct) {
    const { padT, plotH } = this.chartGeom;
    const clamped = Math.max(0, Math.min(100, Number(pct || 0)));
    return padT + plotH - (clamped / 100) * plotH;
  }

  getValueForTarget(target, dateIdx) {
    const arr =
      viewState.metricMode === "pctTotal" ? target.series.pctTotal : target.series.pct;
    return arr[dateIdx] ?? 0;
  }

  drawLines() {
    if (!this.linesGroup || !this.data) return;
    this.linesGroup.replaceChildren();
    this.pathElements = new Map();

    const { dates, targets } = this.data;
    const dayCount = dates.length;
    const years = targets.filter((t) => t.kind === "year").map((t) => t.year);
    const minYear = Math.min(...years);
    const maxYear = Math.max(...years);

    // Render year lines first, then Widely and Newly on top
    const orderedForPaint = [
      ...targets.filter((t) => t.kind === "year"),
      ...targets.filter((t) => t.kind !== "year"),
    ];

    for (const t of orderedForPaint) {
      const points = [];
      for (let i = 0; i < dayCount; i++) {
        const x = this.getXForIndex(i, dayCount);
        const y = this.getYForPct(this.getValueForTarget(t, i));
        points.push(`${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`);
      }

      const yearClass =
        t.kind === "year" ? this.getYearStrokeClass(t.year, minYear, maxYear) : "";
      const path = createSvgEl("path", {
        d: points.join(" "),
        class: `chart-line chart-line-${t.kind} ${yearClass}`.trim(),
        "data-target-id": t.id,
      });

      this.linesGroup.appendChild(path);
      this.pathElements.set(t.id, path);
    }
  }

  updateActiveStates() {
    if (!this.data || !this.pathElements) return;
    this.drawLines();

    const activeId = viewState.pinnedTargetId || viewState.highlightedTargetId;
    for (const [id, path] of this.pathElements.entries()) {
      path.toggleAttribute("data-active", activeId === id);
      path.toggleAttribute("data-dimmed", Boolean(activeId && activeId !== id));
    }

    if (this.legendButtons) {
      for (const [id, btn] of this.legendButtons.entries()) {
        const isActive = activeId === id;
        const isPinned = viewState.pinnedTargetId === id;
        btn.toggleAttribute("data-active", isActive);
        btn.setAttribute("aria-pressed", isPinned ? "true" : "false");
      }
    }

    this.updateCrosshairAndInspector();
  }

  updateCrosshairAndInspector() {
    if (!this.data || !this.crosshairLine || !this.dotsGroup) return;
    const { dates, targets } = this.data;
    const dayCount = dates.length;
    const dateIdx = Math.max(0, Math.min(dayCount - 1, this.hoveredDateIdx ?? dayCount - 1));
    const dateStr = dates[dateIdx];
    const x = this.getXForIndex(dateIdx, dayCount);

    this.crosshairLine.setAttribute("x1", x.toFixed(1));
    this.crosshairLine.setAttribute("x2", x.toFixed(1));

    // Render active markers on the crosshair
    this.dotsGroup.replaceChildren();
    const activeId = viewState.pinnedTargetId || viewState.highlightedTargetId;

    const widelyTarget = targets.find((t) => t.id === "widely");
    const newlyTarget = targets.find((t) => t.id === "newly");
    const activeTarget = targets.find((t) => t.id === activeId) || widelyTarget;

    for (const t of targets) {
      const isPrimary = t.kind === "widely" || t.kind === "newly";
      const isFocused = t.id === activeId;
      if (!isPrimary && !isFocused && dayCount > 35) continue;

      const val = this.getValueForTarget(t, dateIdx);
      const y = this.getYForPct(val);
      const dot = createSvgEl("circle", {
        cx: x.toFixed(1),
        cy: y.toFixed(1),
        r: isFocused ? 5.5 : isPrimary ? 4.5 : 2.75,
        class: `chart-dot chart-dot-${t.kind}${isFocused ? " chart-dot-focused" : ""}`,
      });
      this.dotsGroup.appendChild(dot);
    }

    // Update SVG floating callout position and text
    if (this.tooltipGroup && activeTarget) {
      const { W, padL, padR, padT } = this.chartGeom;
      const boxW = 224;
      const tx = x + 16 + boxW > W - padR ? Math.max(padL + 8, x - boxW - 16) : x + 16;
      const ty = padT + 8;
      this.tooltipGroup.setAttribute("transform", `translate(${tx.toFixed(1)}, ${ty.toFixed(1)})`);

      const focusVal = this.getValueForTarget(activeTarget, dateIdx);
      const widelyVal = widelyTarget ? this.getValueForTarget(widelyTarget, dateIdx) : 0;
      const newlyVal = newlyTarget ? this.getValueForTarget(newlyTarget, dateIdx) : 0;

      this.tooltipDateText.textContent = `${dateStr} (${formatShortDate(dateStr)})`;
      this.tooltipPrimaryText.textContent = `${activeTarget.label}: ${formatPct(focusVal)}`;
      this.tooltipWidelyText.textContent = `Widely available: ${formatPct(widelyVal)}`;
      this.tooltipNewlyText.textContent = `Newly available: ${formatPct(newlyVal)}`;
    }

    // Update bottom inspector panel with all target values for the selected date
    if (this.inspectorPanel) {
      this.inspectorPanel.replaceChildren();

      const header = document.createElement("div");
      header.className = "inspector-header";

      const title = document.createElement("strong");
      title.className = "inspector-date-title";
      title.textContent = `Daily Snapshot: ${dateStr}`;
      header.appendChild(title);

      const hint = document.createElement("span");
      hint.className = "inspector-hint";
      hint.textContent =
        viewState.metricMode === "pctTotal"
          ? "Showing % of total page loads (hover chart or use ←/→ keys)"
          : "Showing % of mapped page loads (hover chart or use ←/→ keys)";
      header.appendChild(hint);

      this.inspectorPanel.appendChild(header);

      const grid = document.createElement("div");
      grid.className = "inspector-grid";

      for (const t of targets) {
        const item = document.createElement("div");
        item.className = `inspector-chip inspector-chip-${t.kind}`;
        if (activeId === t.id) {
          item.setAttribute("data-active", "");
        }

        const nameSpan = document.createElement("span");
        nameSpan.className = "inspector-chip-label";
        nameSpan.textContent = t.kind === "year" ? String(t.year) : t.label;

        const valSpan = document.createElement("span");
        valSpan.className = "inspector-chip-value";
        valSpan.textContent = formatPct(this.getValueForTarget(t, dateIdx));

        item.appendChild(nameSpan);
        item.appendChild(valSpan);
        grid.appendChild(item);
      }

      this.inspectorPanel.appendChild(grid);
    }
  }
}

const THEME_STORAGE_KEY = "baseline-theme";

function getStoredTheme() {
  try {
    const val = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (val === "light" || val === "dark") {
      return val;
    }
  } catch {
    // Storage access unavailable
  }
  return null;
}

function setStoredTheme(theme) {
  try {
    if (theme === "light" || theme === "dark") {
      window.localStorage.setItem(THEME_STORAGE_KEY, theme);
    } else {
      window.localStorage.removeItem(THEME_STORAGE_KEY);
    }
  } catch {
    // Ignore storage write errors
  }
}

function getSystemTheme() {
  return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

function getEffectiveTheme() {
  const attr = document.documentElement.getAttribute("data-theme");
  if (attr === "light" || attr === "dark") {
    return attr;
  }
  return getSystemTheme();
}

function initThemeToggle() {
  const stored = getStoredTheme();
  if (stored) {
    document.documentElement.setAttribute("data-theme", stored);
  }

  const toggleBtn = document.getElementById("theme-toggle");
  const toggleLabel = document.getElementById("theme-toggle-label");
  if (!toggleBtn) return;

  const syncButtonUi = () => {
    const isDark = getEffectiveTheme() === "dark";
    const actionLabel = isDark ? "Switch to light theme" : "Switch to dark theme";
    toggleBtn.setAttribute("aria-pressed", isDark ? "true" : "false");
    toggleBtn.setAttribute("aria-label", actionLabel);
    toggleBtn.setAttribute("title", actionLabel);
    if (toggleLabel) {
      toggleLabel.textContent = isDark ? "Light" : "Dark";
    }
  };

  toggleBtn.addEventListener("click", () => {
    const nextTheme = getEffectiveTheme() === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", nextTheme);
    setStoredTheme(nextTheme);
    syncButtonUi();
  });

  if (window.matchMedia) {
    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    mql.addEventListener("change", () => {
      syncButtonUi();
    });
  }

  syncButtonUi();
}

/**
 * Compares two numeric major or major.minor browser version strings.
 * @param {string} v1
 * @param {string} v2
 * @returns {number}
 */
function compareBrowserVersions(v1, v2) {
  if (v1 === v2) return 0;
  const [maj1 = 0, min1 = 0] = String(v1).split(".", 2).map(Number);
  const [maj2 = 0, min2 = 0] = String(v2).split(".", 2).map(Number);
  if (Number.isNaN(maj1) || Number.isNaN(min1) || Number.isNaN(maj2) || Number.isNaN(min2)) {
    return NaN;
  }
  if (maj1 !== maj2) return maj1 > maj2 ? 1 : -1;
  if (min1 !== min2) return min1 > min2 ? 1 : -1;
  return 0;
}

/**
 * Formats a traffic share percentage with extra precision for sub-0.01% entries in full tables.
 * @param {number} value
 * @returns {string}
 */
function formatSharePct(value) {
  const num = Number(value || 0);
  if (num === 0) return "0.00%";
  if (num >= 0.01) return `${num.toFixed(2)}%`;
  if (num >= 0.0001) return `${num.toFixed(4)}%`;
  return "<0.0001%";
}

class BaselineBrowserBreakdown extends HTMLElement {
  connectedCallback() {
    this.data = window.BASELINE_BROWSER_BREAKDOWN || null;
    this.selectedTargetId = "widely";
    this.activeMobileTab = "compatible";
    this.hoveredBlock = null;
    this.sortState = {
      compatible: { key: "proportion", dir: "desc" },
      incompatible: { key: "proportion", dir: "desc" },
    };

    this.onBreakdownReady = (e) => {
      this.data = e.detail;
      this.render();
    };

    this.onViewState = (e) => {
      const detail = e.detail || {};
      if (
        detail.source !== "breakdown" &&
        detail.pinnedTargetId &&
        detail.pinnedTargetId !== this.selectedTargetId
      ) {
        this.selectedTargetId = detail.pinnedTargetId;
      }
      this.updateView();
    };

    window.addEventListener("baseline-breakdown-ready", this.onBreakdownReady);
    window.addEventListener("baseline-view-state", this.onViewState);

    if (this.data) {
      this.render();
    }
  }

  disconnectedCallback() {
    window.removeEventListener("baseline-breakdown-ready", this.onBreakdownReady);
    window.removeEventListener("baseline-view-state", this.onViewState);
  }

  getShare(browserEntry) {
    return viewState.metricMode === "pctTotal"
      ? Number(browserEntry.pctTotal || 0)
      : Number(browserEntry.pct || 0);
  }

  partitionBrowsersForTarget(targetId) {
    if (!this.data || !Array.isArray(this.data.browsers)) {
      return { compatible: [], incompatible: [], compatibleSum: 0, incompatibleSum: 0 };
    }

    const minMap = (this.data.targetMinMaps && this.data.targetMinMaps[targetId]) || {};
    const compatible = [];
    const incompatible = [];
    let compatibleSum = 0;
    let incompatibleSum = 0;

    for (const b of this.data.browsers) {
      const minVer = minMap[b.browser];
      const isCompat =
        minVer !== undefined && compareBrowserVersions(b.version, minVer) >= 0;
      const share = this.getShare(b);
      const item = { ...b, share };
      if (isCompat) {
        compatible.push(item);
        compatibleSum += share;
      } else {
        incompatible.push(item);
        incompatibleSum += share;
      }
    }

    // Sort both lists highest proportion to lowest by default
    compatible.sort((a, b) => b.share - a.share || b.pct - a.pct);
    incompatible.sort((a, b) => b.share - a.share || b.pct - a.pct);

    return {
      compatible,
      incompatible,
      compatibleSum,
      incompatibleSum,
    };
  }

  /**
   * Builds bar segments for one side ("compatible" or "incompatible"),
   * sorted highest proportion to lowest left-to-right, compressing any browsers
   * that individually make up <0.5% of total traffic into a single block.
   */
  buildBarBlocks(items, side) {
    const majorBlocks = [];
    const minorItems = [];
    let minorShareSum = 0;

    for (const item of items) {
      // Compress any browser that makes up <0.5% of traffic into a single block
      if (item.share >= 0.5) {
        majorBlocks.push({
          type: "single",
          side,
          share: item.share,
          browser: item,
        });
      } else if (item.share > 0) {
        minorItems.push(item);
        minorShareSum += item.share;
      }
    }

    majorBlocks.sort((a, b) => b.share - a.share);

    if (minorItems.length > 0 && minorShareSum > 0) {
      majorBlocks.push({
        type: "compressed",
        side,
        share: minorShareSum,
        items: minorItems,
      });
    }

    return majorBlocks;
  }

  render() {
    this.replaceChildren();
    if (!this.data || !Array.isArray(this.data.browsers) || this.data.browsers.length === 0) {
      const empty = document.createElement("p");
      empty.className = "empty-state";
      empty.textContent = "No 7-day browser breakdown data available yet.";
      this.appendChild(empty);
      return;
    }

    // 1. Target Selector Buttons Row + Metric Mode Toggle
    const controlsWrap = document.createElement("div");
    controlsWrap.className = "breakdown-controls-row";

    const targetBtnGroup = document.createElement("div");
    targetBtnGroup.className = "chart-legend breakdown-target-buttons";
    targetBtnGroup.setAttribute("role", "toolbar");
    targetBtnGroup.setAttribute("aria-label", "Select Baseline target for browser breakdown");

    this.targetButtons = new Map();
    for (const t of this.data.targets || []) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `legend-pill legend-pill-${t.kind}`;
      btn.setAttribute("data-target-id", t.id);
      btn.setAttribute("aria-pressed", t.id === this.selectedTargetId ? "true" : "false");

      const swatch = document.createElement("span");
      swatch.className = `legend-swatch swatch-${t.kind}`;
      swatch.setAttribute("aria-hidden", "true");
      btn.appendChild(swatch);

      const labelSpan = document.createElement("span");
      labelSpan.textContent =
        t.kind === "newly"
          ? "Baseline Newly"
          : t.kind === "widely"
            ? "Baseline Widely"
            : String(t.year || t.shortLabel);
      btn.appendChild(labelSpan);

      btn.addEventListener("click", () => {
        this.selectedTargetId = t.id;
        this.hoveredBlock = null;
        this.updateView();
      });

      this.targetButtons.set(t.id, btn);
      targetBtnGroup.appendChild(btn);
    }

    controlsWrap.appendChild(targetBtnGroup);

    const modeGroup = document.createElement("div");
    modeGroup.className = "metric-toggle-group";
    modeGroup.setAttribute("role", "group");
    modeGroup.setAttribute("aria-label", "Traffic share denominator");

    this.modeButtons = [];
    for (const modeDef of [
      { mode: "pct", label: "% of Mapped" },
      { mode: "pctTotal", label: "% of Total" },
    ]) {
      const mBtn = document.createElement("button");
      mBtn.type = "button";
      mBtn.className = "metric-toggle-btn";
      mBtn.setAttribute("data-metric-mode", modeDef.mode);
      mBtn.setAttribute(
        "aria-pressed",
        viewState.metricMode === modeDef.mode ? "true" : "false"
      );
      mBtn.textContent = modeDef.label;
      mBtn.addEventListener("click", () => {
        viewState.metricMode = modeDef.mode;
        notifyStateChange("breakdown");
      });
      this.modeButtons.push(mBtn);
      modeGroup.appendChild(mBtn);
    }

    controlsWrap.appendChild(modeGroup);
    this.appendChild(controlsWrap);

    // 2. Bar Summary Banner (Compatible on left, 7-day note in center, Incompatible on right)
    this.barSummaryHeader = document.createElement("div");
    this.barSummaryHeader.className = "breakdown-bar-header";
    this.appendChild(this.barSummaryHeader);

    // 3. Wide Horizontal Stacked Bar Chart Container (SVG + below-bar tooltip)
    this.barContainer = document.createElement("div");
    this.barContainer.className = "breakdown-bar-container";
    this.appendChild(this.barContainer);

    // 4. Narrow Screen Tabs ("Compatible" and "Incompatible")
    const tabsBar = document.createElement("div");
    tabsBar.className = "breakdown-tabs";
    tabsBar.setAttribute("role", "tablist");
    tabsBar.setAttribute("aria-label", "Compatible and Incompatible browser tables");

    this.tabButtons = new Map();
    for (const tabDef of [
      { id: "compatible", label: "Compatible" },
      { id: "incompatible", label: "Incompatible" },
    ]) {
      const tabBtn = document.createElement("button");
      tabBtn.type = "button";
      tabBtn.className = `breakdown-tab-btn breakdown-tab-${tabDef.id}`;
      tabBtn.id = `breakdown-tab-${tabDef.id}`;
      tabBtn.setAttribute("role", "tab");
      tabBtn.setAttribute("data-tab-id", tabDef.id);
      tabBtn.setAttribute("aria-controls", `breakdown-panel-${tabDef.id}`);
      tabBtn.setAttribute(
        "aria-selected",
        this.activeMobileTab === tabDef.id ? "true" : "false"
      );
      tabBtn.textContent = tabDef.label;

      tabBtn.addEventListener("click", () => {
        this.activeMobileTab = tabDef.id;
        this.syncMobileTabs();
      });

      this.tabButtons.set(tabDef.id, tabBtn);
      tabsBar.appendChild(tabBtn);
    }
    this.appendChild(tabsBar);

    // 5. Pair of Sortable Tables (Compatible on left, Incompatible on right)
    this.tablesGrid = document.createElement("div");
    this.tablesGrid.className = "breakdown-tables-grid";
    this.tablesGrid.setAttribute("data-active-tab", this.activeMobileTab);

    this.compatPanel = this.createTablePanel("compatible", "Compatible Browsers");
    this.incompatPanel = this.createTablePanel("incompatible", "Incompatible Browsers");

    this.tablesGrid.appendChild(this.compatPanel.panel);
    this.tablesGrid.appendChild(this.incompatPanel.panel);
    this.appendChild(this.tablesGrid);

    this.updateView();
  }

  createTablePanel(side, headingText) {
    const panel = document.createElement("div");
    panel.className = `breakdown-table-panel breakdown-table-panel-${side}`;
    panel.id = `breakdown-panel-${side}`;
    panel.setAttribute("role", "tabpanel");
    panel.setAttribute("aria-labelledby", `breakdown-tab-${side}`);

    const panelHeader = document.createElement("div");
    panelHeader.className = `breakdown-panel-header breakdown-panel-header-${side}`;

    const titleWrap = document.createElement("div");
    titleWrap.className = "breakdown-panel-title-wrap";

    const dot = document.createElement("span");
    dot.className = `breakdown-status-dot status-dot-${side}`;
    dot.setAttribute("aria-hidden", "true");
    titleWrap.appendChild(dot);

    const h3 = document.createElement("h3");
    h3.className = "breakdown-panel-title";
    h3.textContent = headingText;
    titleWrap.appendChild(h3);

    const countBadge = document.createElement("span");
    countBadge.className = "breakdown-count-badge";
    titleWrap.appendChild(countBadge);

    panelHeader.appendChild(titleWrap);

    const totalShareBadge = document.createElement("span");
    totalShareBadge.className = `breakdown-share-badge share-badge-${side}`;
    panelHeader.appendChild(totalShareBadge);

    panel.appendChild(panelHeader);

    const scrollWrap = document.createElement("div");
    scrollWrap.className = "table-wrapper breakdown-table-scroll";

    const table = document.createElement("table");
    table.className = "data-table breakdown-browser-table";

    const thead = document.createElement("thead");
    const headerRow = document.createElement("tr");

    const browserTh = document.createElement("th");
    browserTh.scope = "col";
    browserTh.textContent = "Browser & Version";
    headerRow.appendChild(browserTh);

    const sortHeaders = new Map();
    const columns = [
      { key: "proportion", label: "Traffic Share" },
      { key: "releaseDate", label: "Release Date" },
      { key: "engineReleaseDate", label: "Engine Release" },
    ];

    for (const col of columns) {
      const th = document.createElement("th");
      th.scope = "col";
      th.className = "num-col sortable-th";
      th.setAttribute("aria-sort", "none");

      const sortBtn = document.createElement("button");
      sortBtn.type = "button";
      sortBtn.className = "table-sort-btn";
      sortBtn.setAttribute("data-sort-key", col.key);

      const textSpan = document.createElement("span");
      textSpan.textContent = col.label;
      sortBtn.appendChild(textSpan);

      const iconSpan = document.createElement("span");
      iconSpan.className = "sort-indicator";
      iconSpan.setAttribute("aria-hidden", "true");
      iconSpan.textContent = "↕";
      sortBtn.appendChild(iconSpan);

      sortBtn.addEventListener("click", () => {
        const current = this.sortState[side];
        if (current.key === col.key) {
          current.dir = current.dir === "desc" ? "asc" : "desc";
        } else {
          current.key = col.key;
          current.dir = "desc";
        }
        this.renderTableRows(side);
      });

      th.appendChild(sortBtn);
      headerRow.appendChild(th);
      sortHeaders.set(col.key, { th, iconSpan });
    }

    thead.appendChild(headerRow);
    table.appendChild(thead);

    const tbody = document.createElement("tbody");
    table.appendChild(tbody);
    scrollWrap.appendChild(table);
    panel.appendChild(scrollWrap);

    return {
      panel,
      countBadge,
      totalShareBadge,
      sortHeaders,
      tbody,
    };
  }

  syncMobileTabs() {
    if (!this.tablesGrid || !this.tabButtons) return;
    this.tablesGrid.setAttribute("data-active-tab", this.activeMobileTab);
    for (const [id, btn] of this.tabButtons.entries()) {
      const isSelected = id === this.activeMobileTab;
      btn.setAttribute("aria-selected", isSelected ? "true" : "false");
    }
  }

  updateView() {
    if (!this.data) return;

    // Update target button states
    if (this.targetButtons) {
      for (const [id, btn] of this.targetButtons.entries()) {
        const isActive = id === this.selectedTargetId;
        btn.toggleAttribute("data-active", isActive);
        btn.setAttribute("aria-pressed", isActive ? "true" : "false");
      }
    }

    // Update metric toggle buttons
    if (this.modeButtons) {
      for (const btn of this.modeButtons) {
        const isSelected = btn.getAttribute("data-metric-mode") === viewState.metricMode;
        btn.setAttribute("aria-pressed", isSelected ? "true" : "false");
      }
    }

    const partitioned = this.partitionBrowsersForTarget(this.selectedTargetId);
    this.currentPartition = partitioned;

    // Update mobile tab labels with counts
    const compatTab = this.tabButtons?.get("compatible");
    if (compatTab) {
      compatTab.textContent = `Compatible (${partitioned.compatible.length})`;
    }
    const incompatTab = this.tabButtons?.get("incompatible");
    if (incompatTab) {
      incompatTab.textContent = `Incompatible (${partitioned.incompatible.length})`;
    }

    this.renderHorizontalBar(partitioned);
    this.renderTableRows("compatible");
    this.renderTableRows("incompatible");
  }

  renderHorizontalBar(partitioned) {
    if (!this.barContainer || !this.barSummaryHeader) return;
    this.barSummaryHeader.replaceChildren();
    this.barContainer.replaceChildren();

    const targetObj = (this.data.targets || []).find((t) => t.id === this.selectedTargetId);
    const targetLabel = targetObj ? targetObj.label : `Baseline ${this.selectedTargetId}`;

    // Summary header above the bar
    const leftSummary = document.createElement("div");
    leftSummary.className = "bar-side-summary bar-side-compatible";
    const leftTitle = document.createElement("strong");
    leftTitle.className = "bar-side-pct bar-side-pct-compatible";
    leftTitle.textContent = `${formatPct(partitioned.compatibleSum)} Compatible`;
    const leftMeta = document.createElement("span");
    leftMeta.className = "bar-side-meta";
    leftMeta.textContent = `(fills from 0% left • ${partitioned.compatible.length} versions)`;
    leftSummary.appendChild(leftTitle);
    leftSummary.appendChild(leftMeta);

    const centerNote = document.createElement("div");
    centerNote.className = "bar-center-target-label";
    centerNote.textContent = `${targetLabel} • Last ${this.data.windowDays} days (${this.data.startDate} – ${this.data.endDate})`;

    const rightSummary = document.createElement("div");
    rightSummary.className = "bar-side-summary bar-side-incompatible";
    const rightMeta = document.createElement("span");
    rightMeta.className = "bar-side-meta";
    rightMeta.textContent = `(${partitioned.incompatible.length} versions • fills from 100% right)`;
    const rightTitle = document.createElement("strong");
    rightTitle.className = "bar-side-pct bar-side-pct-incompatible";
    rightTitle.textContent = `${formatPct(partitioned.incompatibleSum)} Incompatible`;
    rightSummary.appendChild(rightMeta);
    rightSummary.appendChild(rightTitle);

    this.barSummaryHeader.appendChild(leftSummary);
    this.barSummaryHeader.appendChild(centerNote);
    this.barSummaryHeader.appendChild(rightSummary);

    // Build blocks for Compatible (starts at 0% on the left) and Incompatible (ends at 100% on the right)
    const compatBlocks = this.buildBarBlocks(partitioned.compatible, "compatible");
    const incompatBlocks = this.buildBarBlocks(partitioned.incompatible, "incompatible");

    const W = 1000;
    const barY = 22;
    const barH = 44;
    const svgH = 148;

    const svg = createSvgEl("svg", {
      viewBox: `0 0 ${W} ${svgH}`,
      class: "breakdown-bar-svg",
      role: "img",
      "aria-label": `Horizontal browser compatibility bar for ${targetLabel} over the last ${this.data.windowDays} days`,
    });

    const defs = createSvgEl("defs");
    svg.appendChild(defs);

    // Scale ticks at 0%, 25%, 50%, 75%, 100%
    const scaleGroup = createSvgEl("g", { class: "bar-scale-group" });
    for (const pctTick of [0, 25, 50, 75, 100]) {
      const tx = (pctTick / 100) * W;
      const tickLabel = createSvgEl("text", {
        x: tx.toFixed(1),
        y: 14,
        "text-anchor": pctTick === 0 ? "start" : pctTick === 100 ? "end" : "middle",
        class: "axis-label bar-scale-label",
      });
      tickLabel.textContent = `${pctTick}%`;
      scaleGroup.appendChild(tickLabel);
    }
    svg.appendChild(scaleGroup);

    // Full-width background track (0% to 100%)
    const trackRect = createSvgEl("rect", {
      x: 0,
      y: barY,
      width: W,
      height: barH,
      rx: 6,
      class: "breakdown-bar-track",
    });
    svg.appendChild(trackRect);

    const blocksGroup = createSvgEl("g", { class: "breakdown-bar-segments" });
    svg.appendChild(blocksGroup);

    // Tooltip group rendered below the bar (y = barY + barH + 12)
    const tooltipGroup = createSvgEl("g", {
      class: "breakdown-svg-tooltip",
      "data-visible": "false",
    });
    const tooltipArrow = createSvgEl("polygon", {
      points: "0,0 -7,8 7,8",
      class: "breakdown-tooltip-arrow",
    });
    const tooltipBox = createSvgEl("g", {
      transform: "translate(0, 8)",
    });
    const tooltipBg = createSvgEl("rect", {
      x: 0,
      y: 0,
      width: 440,
      height: 58,
      rx: 7,
      class: "svg-tooltip-bg breakdown-tooltip-bg",
    });
    const tooltipTitle = createSvgEl("text", {
      x: 14,
      y: 23,
      class: "svg-tooltip-primary breakdown-tooltip-title",
    });
    const tooltipSubtitle = createSvgEl("text", {
      x: 14,
      y: 44,
      class: "svg-tooltip-sub breakdown-tooltip-subtitle",
    });
    tooltipBox.appendChild(tooltipBg);
    tooltipBox.appendChild(tooltipTitle);
    tooltipBox.appendChild(tooltipSubtitle);
    tooltipGroup.appendChild(tooltipArrow);
    tooltipGroup.appendChild(tooltipBox);
    svg.appendChild(tooltipGroup);

    const showBlockTooltip = (block, centerX) => {
      let line1 = "";
      let line2 = "";

      if (block.type === "single") {
        const b = block.browser;
        line1 = `${b.name} ${b.version} — ${formatPct(block.share)}`;
        const details = [];
        if (b.isDownstream && b.engine) {
          details.push(`Engine: ${b.engine}${b.engineVersion ? ` ${b.engineVersion}` : ""}`);
        }
        if (b.releaseDate) {
          details.push(`Released: ${b.releaseDate}`);
        }
        if (b.isDownstream && b.engineReleaseDate) {
          details.push(`Engine released: ${b.engineReleaseDate}`);
        }
        details.push(block.side === "compatible" ? "Compatible" : "Incompatible");
        line2 = details.join(" • ");
      } else {
        const sideLabel = block.side === "compatible" ? "Compatible" : "Incompatible";
        line1 = `${sideLabel}: Browsers <0.5% of traffic (${block.items.length} versions) — ${formatPct(block.share)}`;
        const topPreview = block.items.slice(0, 3).map((b) => {
          const engInfo =
            b.isDownstream && b.engine
              ? ` [${b.engine}${b.engineVersion ? ` ${b.engineVersion}` : ""}]`
              : "";
          return `${b.name} ${b.version}${engInfo} (${formatPct(b.share)})`;
        });
        const remaining = block.items.length - topPreview.length;
        line2 =
          remaining > 0
            ? `Top: ${topPreview.join(", ")} +${remaining} more`
            : `Includes: ${topPreview.join(", ")}`;
      }

      tooltipTitle.textContent = line1;
      tooltipSubtitle.textContent = line2;
      tooltipSubtitle.setAttribute(
        "class",
        `svg-tooltip-sub breakdown-tooltip-subtitle breakdown-tooltip-sub-${block.side}`
      );

      // Estimate dynamic width from text lengths so long downstream tooltips fit cleanly
      const maxChars = Math.max(line1.length, line2.length);
      const boxW = Math.max(320, Math.min(820, Math.round(maxChars * 7.2) + 32));
      tooltipBg.setAttribute("width", String(boxW));

      const clampedCenterX = Math.max(16, Math.min(W - 16, centerX));
      const boxX = Math.max(4, Math.min(W - boxW - 4, clampedCenterX - boxW / 2));
      const arrowY = barY + barH + 4;

      tooltipArrow.setAttribute("transform", `translate(${clampedCenterX.toFixed(1)}, ${arrowY})`);
      tooltipBox.setAttribute("transform", `translate(${boxX.toFixed(1)}, ${arrowY + 8})`);
      tooltipGroup.setAttribute("data-visible", "true");
    };

    const hideBlockTooltip = () => {
      tooltipGroup.setAttribute("data-visible", "false");
    };

    let clipCounter = 0;
    const renderSegment = (block, xStart, widthPx, idxWithinSide) => {
      if (widthPx <= 0) return;
      const g = createSvgEl("g", {
        class: `bar-segment-group bar-segment-${block.side}`,
        tabindex: "0",
        role: "button",
      });

      const shadeIndex = block.type === "compressed" ? "compressed" : String(idxWithinSide % 4);
      const rect = createSvgEl("rect", {
        x: xStart.toFixed(2),
        y: barY,
        width: Math.max(1.5, widthPx).toFixed(2),
        height: barH,
        class: `bar-segment-rect bar-rect-${block.side} bar-rect-shade-${shadeIndex}`,
      });
      g.appendChild(rect);

      // Add clipped inline label if block is wide enough (>= 48px out of 1000px, i.e. >= 4.8%)
      if (widthPx >= 48) {
        clipCounter += 1;
        const clipId = `bar-clip-${this.selectedTargetId}-${clipCounter}`;
        const clipPath = createSvgEl("clipPath", { id: clipId });
        clipPath.appendChild(
          createSvgEl("rect", {
            x: (xStart + 6).toFixed(1),
            y: barY,
            width: Math.max(0, widthPx - 12).toFixed(1),
            height: barH,
          })
        );
        defs.appendChild(clipPath);

        const labelGroup = createSvgEl("g", {
          "clip-path": `url(#${clipId})`,
          class: "bar-segment-label-group",
        });

        const primaryLabel = createSvgEl("text", {
          x: (xStart + 10).toFixed(1),
          y: barY + 20,
          class: "bar-segment-text-main",
        });
        primaryLabel.textContent =
          block.type === "single"
            ? `${block.browser.name} ${block.browser.version}`
            : `<0.5% (${block.items.length})`;

        const pctLabel = createSvgEl("text", {
          x: (xStart + 10).toFixed(1),
          y: barY + 35,
          class: "bar-segment-text-pct",
        });
        pctLabel.textContent = formatPct(block.share);

        labelGroup.appendChild(primaryLabel);
        labelGroup.appendChild(pctLabel);
        g.appendChild(labelGroup);
      }

      const centerX = xStart + widthPx / 2;
      g.addEventListener("pointerenter", () => {
        g.setAttribute("data-hovered", "true");
        showBlockTooltip(block, centerX);
      });
      g.addEventListener("pointerleave", () => {
        g.removeAttribute("data-hovered");
        hideBlockTooltip();
      });
      g.addEventListener("focus", () => {
        g.setAttribute("data-hovered", "true");
        showBlockTooltip(block, centerX);
      });
      g.addEventListener("blur", () => {
        g.removeAttribute("data-hovered");
        hideBlockTooltip();
      });

      blocksGroup.appendChild(g);
    };

    // 1. Lay out Compatible sections from 0% on the left hand side, highest to lowest left-to-right
    let compatCursorX = 0;
    compatBlocks.forEach((block, idx) => {
      const w = (block.share / 100) * W;
      renderSegment(block, compatCursorX, w, idx);
      compatCursorX += w;
    });

    // 2. Lay out Incompatible sections filling up from the right at 100%,
    // sorted highest proportion to lowest, left to right within the incompatible bar
    const totalIncompatW = incompatBlocks.reduce((acc, b) => acc + (b.share / 100) * W, 0);
    let incompatCursorX = Math.max(compatCursorX, W - totalIncompatW);
    incompatBlocks.forEach((block, idx) => {
      const w = (block.share / 100) * W;
      renderSegment(block, incompatCursorX, w, idx);
      incompatCursorX += w;
    });

    this.barContainer.appendChild(svg);
  }

  sortBrowserItems(items, sortConfig) {
    const { key, dir } = sortConfig;
    const mult = dir === "asc" ? 1 : -1;

    return [...items].sort((a, b) => {
      if (key === "releaseDate" || key === "engineReleaseDate") {
        const dateA = a[key] || null;
        const dateB = b[key] || null;
        // Always place rows without a date after rows with an available date
        if (!dateA && !dateB) return b.share - a.share;
        if (!dateA) return 1;
        if (!dateB) return -1;
        if (dateA !== dateB) {
          return dateA < dateB ? -1 * mult : 1 * mult;
        }
        return b.share - a.share;
      }

      // Default: sort by traffic proportion
      if (a.share !== b.share) {
        return (a.share - b.share) * mult;
      }
      return (a.pct - b.pct) * mult;
    });
  }

  renderTableRows(side) {
    if (!this.currentPartition) return;
    const panelObj = side === "compatible" ? this.compatPanel : this.incompatPanel;
    if (!panelObj) return;

    const rawItems =
      side === "compatible"
        ? this.currentPartition.compatible
        : this.currentPartition.incompatible;
    const totalShare =
      side === "compatible"
        ? this.currentPartition.compatibleSum
        : this.currentPartition.incompatibleSum;

    panelObj.countBadge.textContent = `${rawItems.length} version${rawItems.length === 1 ? "" : "s"}`;
    panelObj.totalShareBadge.textContent = formatPct(totalShare);

    const sortCfg = this.sortState[side];
    for (const [colKey, headerObj] of panelObj.sortHeaders.entries()) {
      if (colKey === sortCfg.key) {
        headerObj.th.setAttribute(
          "aria-sort",
          sortCfg.dir === "asc" ? "ascending" : "descending"
        );
        headerObj.iconSpan.textContent = sortCfg.dir === "asc" ? "↑" : "↓";
      } else {
        headerObj.th.setAttribute("aria-sort", "none");
        headerObj.iconSpan.textContent = "↕";
      }
    }

    const sortedItems = this.sortBrowserItems(rawItems, sortCfg);
    panelObj.tbody.replaceChildren();

    if (sortedItems.length === 0) {
      const tr = document.createElement("tr");
      const td = document.createElement("td");
      td.colSpan = 4;
      td.className = "empty-table-cell";
      td.textContent = `No ${side} browsers for this target.`;
      tr.appendChild(td);
      panelObj.tbody.appendChild(tr);
      return;
    }

    const fragment = document.createDocumentFragment();
    for (const item of sortedItems) {
      const tr = document.createElement("tr");

      // 1. Browser name + version (+ downstream engine badge if relevant)
      const nameTd = document.createElement("td");
      nameTd.className = "browser-name-cell";

      const mainName = document.createElement("span");
      mainName.className = "browser-title-text";
      mainName.textContent = `${item.name} ${item.version}`;
      nameTd.appendChild(mainName);

      if (item.isDownstream && item.engine) {
        const engineBadge = document.createElement("span");
        engineBadge.className = "downstream-engine-badge";
        engineBadge.textContent = `${item.engine}${item.engineVersion ? ` ${item.engineVersion}` : ""}`;
        nameTd.appendChild(engineBadge);
      }
      tr.appendChild(nameTd);

      // 2. Proportion in traffic
      const shareTd = document.createElement("td");
      shareTd.className = "num-col share-num-cell";
      shareTd.textContent = formatSharePct(item.share);
      tr.appendChild(shareTd);

      // 3. Release Date (where available)
      const relTd = document.createElement("td");
      relTd.className = "num-col date-cell";
      if (item.releaseDate) {
        relTd.textContent = item.releaseDate;
      } else {
        relTd.classList.add("date-unavailable");
        relTd.textContent = "—";
      }
      tr.appendChild(relTd);

      // 4. Engine Release Date (where available)
      const engRelTd = document.createElement("td");
      engRelTd.className = "num-col date-cell";
      if (item.engineReleaseDate) {
        engRelTd.textContent = item.engineReleaseDate;
      } else {
        engRelTd.classList.add("date-unavailable");
        engRelTd.textContent = "—";
      }
      tr.appendChild(engRelTd);

      fragment.appendChild(tr);
    }

    panelObj.tbody.appendChild(fragment);
  }
}

initThemeToggle();

if (!customElements.get("baseline-summary-table")) {
  customElements.define("baseline-summary-table", BaselineSummaryTable);
}

if (!customElements.get("baseline-timeseries-chart")) {
  customElements.define("baseline-timeseries-chart", BaselineTimeseriesChart);
}

if (!customElements.get("baseline-browser-breakdown")) {
  customElements.define("baseline-browser-breakdown", BaselineBrowserBreakdown);
}

