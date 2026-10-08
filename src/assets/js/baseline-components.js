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

if (!customElements.get("baseline-summary-table")) {
  customElements.define("baseline-summary-table", BaselineSummaryTable);
}

if (!customElements.get("baseline-timeseries-chart")) {
  customElements.define("baseline-timeseries-chart", BaselineTimeseriesChart);
}
