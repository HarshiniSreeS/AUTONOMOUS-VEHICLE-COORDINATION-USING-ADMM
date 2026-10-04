/* ═══════════════════════════════════════════════════════════════════════════
   AV Coordination Simulation — Frontend Application
   Canvas-based visualization with real-time API integration
   ═══════════════════════════════════════════════════════════════════════════ */

const API_BASE = '';  // Same origin (FastAPI serves both)

// ─── State ────────────────────────────────────────────────────────────────────
const state = {
    timeline: [],           // [{timestamp, vehicle_count}]
    currentFrame: 0,        // Current timeline index
    simData: null,          // Full pipeline result for current frame
    playing: false,
    playSpeed: 1,
    playInterval: null,
    selectedVehicle: null,  // Hovered/selected vehicle vid

    // Display toggles
    showLinks: true,
    showRadius: false,
    showPredictions: true,
    showLabels: true,
    showGroups: true,

    // Canvas state
    canvas: null,
    ctx: null,
    canvasW: 0,
    canvasH: 0,

    // Coordinate transform (data → canvas)
    dataMinX: 0, dataMaxX: 80,
    dataMinY: 0, dataMaxY: 2200,
    padding: 40,

    // Group colors (assigned dynamically)
    groupColors: [
        'rgba(59,130,246,0.12)', 'rgba(139,92,246,0.12)',
        'rgba(16,185,129,0.12)', 'rgba(6,182,212,0.12)',
        'rgba(236,72,153,0.12)', 'rgba(245,158,11,0.12)',
        'rgba(99,102,241,0.12)', 'rgba(168,85,247,0.12)',
    ],
    groupStrokeColors: [
        'rgba(59,130,246,0.35)', 'rgba(139,92,246,0.35)',
        'rgba(16,185,129,0.35)', 'rgba(6,182,212,0.35)',
        'rgba(236,72,153,0.35)', 'rgba(245,158,11,0.35)',
        'rgba(99,102,241,0.35)', 'rgba(168,85,247,0.35)',
    ],
};

// ─── DOM Elements ─────────────────────────────────────────────────────────────
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const els = {
    canvas: $('#simCanvas'),
    slider: $('#timelineSlider'),
    timeLabel: $('#timeLabel'),
    frameLabel: $('#frameLabel'),
    btnPlay: $('#btnPlay'),
    btnStepBack: $('#btnStepBack'),
    btnStepFwd: $('#btnStepFwd'),
    btnReset: $('#btnReset'),
    connectionStatus: $('#connectionStatus'),
    vehicleCountBadge: $('#vehicleCountBadge'),
    timestampCountBadge: $('#timestampCountBadge'),
    overlayTimestamp: $('#overlayTimestamp'),
    vehicleList: $('#vehicleList'),
    groupsList: $('#groupsList'),

    // Stats
    statVehicles: $('#statVehicles'),
    statEdges: $('#statEdges'),
    statGroups: $('#statGroups'),
    statManual: $('#statManual'),
    statRisk: $('#statRisk'),
    statADMM: $('#statADMM'),

    // ADMM
    admmConverged: $('#admmConverged'),
    admmIterations: $('#admmIterations'),
    admmPrimal: $('#admmPrimal'),
    admmDual: $('#admmDual'),
    admmZ: $('#admmZ'),
    admmAffected: $('#admmAffected'),
    convergenceChart: $('#convergenceChart'),
    costChart: $('#costChart'),

    // Toggles
    showLinks: $('#showLinks'),
    showRadius: $('#showRadius'),
    showPredictions: $('#showPredictions'),
    showLabels: $('#showLabels'),
    showGroups: $('#showGroups'),
};

// ─── API Helpers ──────────────────────────────────────────────────────────────
async function apiGet(path) {
    const res = await fetch(`${API_BASE}${path}`);
    if (!res.ok) throw new Error(`API ${path}: ${res.status}`);
    return res.json();
}

// ─── Initialization ───────────────────────────────────────────────────────────
async function init() {
    setupCanvas();
    setupEventListeners();

    try {
        // Load dataset info
        const info = await apiGet('/api/info');
        els.vehicleCountBadge.textContent = `${info.vehicle_count} vehicles`;
        els.timestampCountBadge.textContent = `${info.timestamp_count} timesteps`;

        // Load timeline
        state.timeline = await apiGet('/api/timeline');
        els.slider.max = state.timeline.length - 1;
        els.slider.value = 0;

        // Mark connected
        const dot = els.connectionStatus.querySelector('.status-dot');
        dot.classList.add('connected');
        els.connectionStatus.querySelector('.status-text').textContent = 'Connected';

        // Load first frame
        await loadFrame(0);

    } catch (err) {
        console.error('Init error:', err);
        els.connectionStatus.querySelector('.status-text').textContent = 'Error: ' + err.message;
    }
}

// ─── Canvas Setup ─────────────────────────────────────────────────────────────
function setupCanvas() {
    state.canvas = els.canvas;
    state.ctx = state.canvas.getContext('2d');
    resizeCanvas();
    window.addEventListener('resize', () => {
        resizeCanvas();
        render();
    });
}

function resizeCanvas() {
    const container = state.canvas.parentElement;
    const dpr = window.devicePixelRatio || 1;
    state.canvasW = container.clientWidth;
    state.canvasH = container.clientHeight;
    state.canvas.width = state.canvasW * dpr;
    state.canvas.height = state.canvasH * dpr;
    state.canvas.style.width = state.canvasW + 'px';
    state.canvas.style.height = state.canvasH + 'px';
    state.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

// ─── Coordinate Transforms ───────────────────────────────────────────────────
function dataToCanvas(x, y) {
    const pad = state.padding;
    const w = state.canvasW - pad * 2;
    const h = state.canvasH - pad * 2;

    // Map data Y to canvas Y (invert: higher Y in data = higher on screen)
    const cx = pad + ((x - state.dataMinX) / (state.dataMaxX - state.dataMinX)) * w;
    const cy = pad + h - ((y - state.dataMinY) / (state.dataMaxY - state.dataMinY)) * h;

    return [cx, cy];
}

function commRadiusToCanvas() {
    // Convert 50m comm radius to canvas pixels (using Y scale since road is vertical)
    const h = state.canvasH - state.padding * 2;
    const dataRange = state.dataMaxY - state.dataMinY;
    return (50 / dataRange) * h;  // 50m in data coordinates → pixels
}

// ─── Load Frame ───────────────────────────────────────────────────────────────
async function loadFrame(index) {
    if (index < 0 || index >= state.timeline.length) return;
    state.currentFrame = index;

    const ts = state.timeline[index].timestamp;
    els.slider.value = index;
    els.timeLabel.textContent = `t = ${ts}`;
    els.frameLabel.textContent = `Frame ${index + 1}/${state.timeline.length}`;
    els.overlayTimestamp.textContent = `t = ${ts} | Frame ${index + 1}`;

    try {
        state.simData = await apiGet(`/api/simulate?timestamp=${ts}`);
        updateDataBounds();
        updatePanels();
        render();
    } catch (err) {
        console.error('Load frame error:', err);
    }
}

function updateDataBounds() {
    if (!state.simData || !state.simData.vehicles.length) return;
    const vs = state.simData.vehicles;
    const xs = vs.map(v => v.x);
    const ys = vs.map(v => v.y);
    // Add some margin
    const mx = 20, my = 30;
    state.dataMinX = Math.min(...xs) - mx;
    state.dataMaxX = Math.max(...xs) + mx;
    state.dataMinY = Math.min(...ys) - my;
    state.dataMaxY = Math.max(...ys) + my;
}

// ─── Rendering ────────────────────────────────────────────────────────────────
function render() {
    const ctx = state.ctx;
    const w = state.canvasW;
    const h = state.canvasH;

    // Clear
    ctx.clearRect(0, 0, w, h);

    // Background gradient
    const bgGrad = ctx.createLinearGradient(0, 0, 0, h);
    bgGrad.addColorStop(0, '#080c15');
    bgGrad.addColorStop(1, '#0d1220');
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, w, h);

    if (!state.simData) return;

    // Draw road grid
    drawRoadGrid(ctx, w, h);

    // Draw groups (background hulls)
    if (state.showGroups) drawGroups(ctx);

    // Draw communication links
    if (state.showLinks) drawCommLinks(ctx);

    // Draw predictions
    if (state.showPredictions) drawPredictions(ctx);

    // Draw comm radius for selected vehicle
    if (state.showRadius) drawCommRadius(ctx);

    // Draw vehicles
    drawVehicles(ctx);
}

function drawRoadGrid(ctx, w, h) {
    ctx.save();
    // Vertical lane dividers (subtle)
    const lanes = 5;
    const laneWidth = (state.dataMaxX - state.dataMinX) / lanes;
    ctx.setLineDash([4, 8]);
    ctx.strokeStyle = 'rgba(255,255,255,0.04)';
    ctx.lineWidth = 1;

    for (let i = 1; i < lanes; i++) {
        const [cx] = dataToCanvas(state.dataMinX + i * laneWidth, 0);
        ctx.beginPath();
        ctx.moveTo(cx, state.padding);
        ctx.lineTo(cx, h - state.padding);
        ctx.stroke();
    }

    // Horizontal distance markers
    const yStep = 100; // every 100m
    ctx.setLineDash([2, 6]);
    ctx.strokeStyle = 'rgba(255,255,255,0.03)';
    ctx.font = 'bold 16px "JetBrains Mono"';
    ctx.fillStyle = 'rgba(255,255,255,0.25)';
    ctx.textAlign = 'right';

    for (let y = Math.ceil(state.dataMinY / yStep) * yStep;
         y <= state.dataMaxY; y += yStep) {
        const [, cy] = dataToCanvas(0, y);
        ctx.beginPath();
        ctx.moveTo(state.padding, cy);
        ctx.lineTo(w - state.padding, cy);
        ctx.stroke();
        ctx.fillText(`${Math.round(y)}m`, state.padding - 4, cy + 3);
    }

    ctx.setLineDash([]);
    ctx.restore();
}

function drawGroups(ctx) {
    if (!state.simData.groups) return;
    const vehicles = state.simData.vehicles;
    const vMap = {};
    vehicles.forEach(v => vMap[v.vid] = v);

    state.simData.groups.forEach((group, gi) => {
        const points = group
            .filter(vid => vMap[vid])
            .map(vid => dataToCanvas(vMap[vid].x, vMap[vid].y));

        if (points.length < 2) return;

        // Draw convex hull-like shape
        const color = state.groupColors[gi % state.groupColors.length];
        const strokeColor = state.groupStrokeColors[gi % state.groupStrokeColors.length];

        // Compute centroid
        const cx = points.reduce((s, p) => s + p[0], 0) / points.length;
        const cy = points.reduce((s, p) => s + p[1], 0) / points.length;

        // Sort points by angle from centroid for proper hull
        const sorted = [...points].sort((a, b) => {
            return Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx);
        });

        ctx.save();
        ctx.beginPath();
        const expand = 20; // px padding around group
        sorted.forEach((p, i) => {
            const dx = p[0] - cx;
            const dy = p[1] - cy;
            const dist = Math.sqrt(dx * dx + dy * dy);
            const nx = dx / (dist || 1) * expand + p[0];
            const ny = dy / (dist || 1) * expand + p[1];
            if (i === 0) ctx.moveTo(nx, ny);
            else ctx.lineTo(nx, ny);
        });
        ctx.closePath();
        ctx.fillStyle = color;
        ctx.fill();
        ctx.strokeStyle = strokeColor;
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.restore();
    });
}

function drawCommLinks(ctx) {
    if (!state.simData.edges) return;
    const vMap = {};
    state.simData.vehicles.forEach(v => vMap[v.vid] = v);

    ctx.save();
    state.simData.edges.forEach(edge => {
        const v1 = vMap[edge.from];
        const v2 = vMap[edge.to];
        if (!v1 || !v2) return;

        const [x1, y1] = dataToCanvas(v1.x, v1.y);
        const [x2, y2] = dataToCanvas(v2.x, v2.y);

        // Color based on distance (green → yellow → red as approaching limit)
        const ratio = edge.distance / 50;
        const r = Math.round(59 + ratio * 180);
        const g = Math.round(130 - ratio * 60);
        const b = Math.round(246 - ratio * 200);
        const alpha = 0.15 + (1 - ratio) * 0.2;

        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.strokeStyle = `rgba(${r},${g},${b},${alpha})`;
        ctx.lineWidth = 1;
        ctx.stroke();

        // Distance label at midpoint
        if (state.showLabels) {
            const mx = (x1 + x2) / 2;
            const my = (y1 + y2) / 2;
            ctx.font = 'bold 13px "JetBrains Mono"';
            ctx.fillStyle = `rgba(${r},${g},${b},0.5)`;
            ctx.textAlign = 'center';
            ctx.fillText(`${edge.distance.toFixed(0)}m`, mx, my - 4);
        }
    });
    ctx.restore();
}

function drawPredictions(ctx) {
    if (!state.simData.vehicles) return;

    ctx.save();
    state.simData.vehicles.forEach(v => {
        if (!v.x_pred || !v.y_pred) return;

        const [x1, y1] = dataToCanvas(v.x, v.y);
        const [x2, y2] = dataToCanvas(v.x_pred, v.y_pred);

        ctx.setLineDash([3, 5]);
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.strokeStyle = v.is_manual
            ? 'rgba(239,68,68,0.3)'
            : 'rgba(59,130,246,0.2)';
        ctx.lineWidth = 1.5;
        ctx.stroke();

        // Small circle at predicted position
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.arc(x2, y2, 5, 0, Math.PI * 2);
        ctx.fillStyle = v.is_manual
            ? 'rgba(239,68,68,0.4)'
            : 'rgba(59,130,246,0.3)';
        ctx.fill();
    });
    ctx.setLineDash([]);
    ctx.restore();
}

function drawCommRadius(ctx) {
    const r = commRadiusToCanvas();
    state.simData.vehicles.forEach(v => {
        const [cx, cy] = dataToCanvas(v.x, v.y);
        ctx.save();
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.strokeStyle = v.is_manual
            ? 'rgba(239,68,68,0.15)'
            : 'rgba(59,130,246,0.1)';
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.restore();
    });
}

function drawVehicles(ctx) {
    if (!state.simData.vehicles) return;

    state.simData.vehicles.forEach(v => {
        const [cx, cy] = dataToCanvas(v.x, v.y);
        const isSelected = state.selectedVehicle === v.vid;

        // Vehicle body
        let color, glow;
        if (v.is_manual) {
            color = '#ef4444';
            glow = 'rgba(239,68,68,0.4)';
        } else if (v.in_admm) {
            color = '#f59e0b';
            glow = 'rgba(245,158,11,0.4)';
        } else {
            color = '#10b981';
            glow = 'rgba(16,185,129,0.3)';
        }

        ctx.save();

        // Glow effect
        if (isSelected || v.is_manual || v.in_admm) {
            ctx.shadowColor = glow;
            ctx.shadowBlur = isSelected ? 20 : 12;
        }

        // Draw vehicle rectangle (oriented along road direction)
        const vLen = 10;  // visual length
        const vWid = 6;  // visual width

        ctx.translate(cx, cy);

        // Vehicle body
        ctx.beginPath();
        ctx.roundRect(-vWid / 2, -vLen / 2, vWid, vLen, 2);
        ctx.fillStyle = color;
        ctx.fill();

        // Border
        ctx.strokeStyle = isSelected ? '#ffffff' : 'rgba(255,255,255,0.3)';
        ctx.lineWidth = isSelected ? 2 : 0.5;
        ctx.stroke();

        ctx.shadowBlur = 0;

        // Speed indicator (small line showing direction)
        const speedScale = v.speed / 25;
        ctx.beginPath();
        ctx.moveTo(0, -vLen / 2);
        ctx.lineTo(0, -vLen / 2 - speedScale * 8);
        ctx.strokeStyle = `rgba(255,255,255,0.4)`;
        ctx.lineWidth = 1.5;
        ctx.stroke();

        ctx.restore();

        // Label
        if (state.showLabels) {
            ctx.save();
            ctx.font = `${isSelected ? '800' : '700'} 15px "JetBrains Mono"`;
            ctx.textAlign = 'center';
            ctx.fillStyle = isSelected ? '#ffffff' : 'rgba(255,255,255,0.9)';
            ctx.fillText(`V${v.vid}`, cx, cy - 16);

            // Show speed for selected
            if (isSelected) {
                ctx.font = 'bold 13px "JetBrains Mono"';
                ctx.fillStyle = 'rgba(255,255,255,0.7)';
                ctx.fillText(`${v.speed.toFixed(1)} m/s`, cx, cy + 24);
            }
            ctx.restore();
        }
    });
}

// ─── UI Panel Updates ─────────────────────────────────────────────────────────
function updatePanels() {
    if (!state.simData) return;
    const d = state.simData;

    // Stats
    els.statVehicles.textContent = d.vehicle_count;
    els.statEdges.textContent = d.edge_count;
    els.statGroups.textContent = d.group_count;
    els.statManual.textContent = d.manual_vehicles.length;

    const maxRisk = d.costs.length
        ? Math.max(...d.costs.map(c => c.R_norm || 0)).toFixed(2)
        : '—';
    els.statRisk.textContent = maxRisk;
    els.statADMM.textContent = d.admm.iterations;

    // ADMM panel
    if (d.admm.converged) {
        els.admmConverged.textContent = '✓ Converged';
        els.admmConverged.className = 'admm-value converged';
    } else {
        els.admmConverged.textContent = '⟳ Running';
        els.admmConverged.className = 'admm-value running';
    }
    els.admmIterations.textContent = d.admm.iterations;
    els.admmPrimal.textContent = d.admm.final_primal_residual ?? '—';
    els.admmDual.textContent = d.admm.final_dual_residual ?? '—';
    els.admmZ.textContent = d.admm.z_final
        ? `[${d.admm.z_final.map(v => v.toFixed(3)).join(', ')}]` : '—';
    els.admmAffected.textContent = d.admm.vehicles.length
        ? d.admm.vehicles.map(v => `V${v}`).join(', ') : 'None';

    // Vehicle classification list
    updateVehicleList(d);

    // Groups list
    updateGroupsList(d);

    // Charts
    drawConvergenceChart(d.admm);
    drawCostChart(d.costs, d.manual_vehicles, d.admm.vehicles);
}

function updateVehicleList(d) {
    const container = els.vehicleList;
    container.innerHTML = '';

    d.vehicles
        .sort((a, b) => b.sigma_hat - a.sigma_hat)
        .forEach(v => {
            const div = document.createElement('div');
            let cls = 'vehicle-item';
            if (v.is_manual) cls += ' manual';
            else if (v.in_admm) cls += ' admm';
            else cls += ' autonomous';
            div.className = cls;

            div.innerHTML = `
                <span class="vid">V${v.vid}</span>
                <span class="sigma">σ̂=${v.sigma_hat.toFixed(3)}</span>
                <span class="sigma">${v.label}</span>
            `;

            div.addEventListener('mouseenter', () => {
                state.selectedVehicle = v.vid;
                render();
            });
            div.addEventListener('mouseleave', () => {
                state.selectedVehicle = null;
                render();
            });

            container.appendChild(div);
        });
}

function updateGroupsList(d) {
    const container = els.groupsList;
    container.innerHTML = '';

    if (!d.groups.length) {
        container.innerHTML = '<div class="group-item" style="color:var(--text-muted);font-size:0.78rem;">No groups detected at this timestep</div>';
        return;
    }

    d.groups.forEach((group, i) => {
        const div = document.createElement('div');
        div.className = 'group-item';
        div.innerHTML = `
            <div class="group-header">
                <span class="group-name">Group ${i + 1}</span>
                <span class="group-count">${group.length} vehicles</span>
            </div>
            <div class="group-vehicles">${group.map(v => `V${v}`).join(', ')}</div>
        `;
        container.appendChild(div);
    });
}

// ─── Mini Charts (pure Canvas) ────────────────────────────────────────────────
function drawConvergenceChart(admm) {
    const canvas = els.convergenceChart;
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.parentElement.clientWidth;
    const h = 160;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Clear
    ctx.fillStyle = '#111827';
    ctx.fillRect(0, 0, w, h);

    if (!admm.history || !admm.history.length) {
        ctx.fillStyle = '#64748b';
        ctx.font = 'bold 16px Inter';
        ctx.textAlign = 'center';
        ctx.fillText('No ADMM data', w / 2, h / 2);
        return;
    }

    const pad = { l: 40, r: 10, t: 15, b: 25 };
    const cw = w - pad.l - pad.r;
    const ch = h - pad.t - pad.b;

    const primals = admm.history.map(h => h.primal_residual);
    const duals = admm.history.map(h => h.dual_residual);
    const all = [...primals, ...duals];
    const maxVal = Math.max(...all, 0.001);
    const n = primals.length;

    // Grid
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
        const y = pad.t + (i / 4) * ch;
        ctx.beginPath();
        ctx.moveTo(pad.l, y);
        ctx.lineTo(pad.l + cw, y);
        ctx.stroke();

        ctx.fillStyle = '#64748b';
        ctx.font = 'bold 14px "JetBrains Mono"';
        ctx.textAlign = 'right';
        const val = maxVal * (1 - i / 4);
        ctx.fillText(val.toFixed(3), pad.l - 4, y + 3);
    }

    // X axis labels
    ctx.textAlign = 'center';
    for (let i = 0; i < n; i += Math.max(1, Math.floor(n / 5))) {
        const x = pad.l + (i / Math.max(n - 1, 1)) * cw;
        ctx.fillText(i + 1, x, h - 5);
    }

    // Draw primal residual (blue)
    drawLine(ctx, primals, maxVal, pad, cw, ch, '#3b82f6', 2);

    // Draw dual residual (purple)
    drawLine(ctx, duals, maxVal, pad, cw, ch, '#8b5cf6', 2);

    // Legend
    ctx.font = 'bold 14px Inter';
    ctx.fillStyle = '#3b82f6';
    ctx.textAlign = 'left';
    ctx.fillText('● Primal', pad.l, h - 5);
    ctx.fillStyle = '#8b5cf6';
    ctx.fillText('● Dual', pad.l + 60, h - 5);
}

function drawLine(ctx, values, maxVal, pad, cw, ch, color, lineWidth) {
    if (values.length < 2) return;
    const n = values.length;

    ctx.save();
    ctx.beginPath();
    values.forEach((v, i) => {
        const x = pad.l + (i / (n - 1)) * cw;
        const y = pad.t + ch - (v / maxVal) * ch;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
    ctx.stroke();

    // Dots
    values.forEach((v, i) => {
        const x = pad.l + (i / (n - 1)) * cw;
        const y = pad.t + ch - (v / maxVal) * ch;
        ctx.beginPath();
        ctx.arc(x, y, 4.5, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
    });
    ctx.restore();
}

function drawCostChart(costs, manualVids, admmVids) {
    const canvas = els.costChart;
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.parentElement.clientWidth;
    const h = 300;
    canvas.width  = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width  = w + 'px';
    canvas.style.height = h + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Background
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, 0, w, h);

    if (!costs.length) {
        ctx.fillStyle = '#64748b';
        ctx.font = '14px Inter';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('No cost data yet — press Play to run', w / 2, h / 2);
        return;
    }

    // Layout
    const pad  = { l: 46, r: 12, t: 18, b: 80 };
    const cw   = w - pad.l - pad.r;
    const ch   = h - pad.t - pad.b;
    const axisY = pad.t + ch;   // pixel y of the X-axis baseline

    const maxF = Math.max(...costs.map(c => c.f_i || 0), 0.01);
    const barW = Math.max(cw / costs.length - 2, 2);

    // ── Y grid lines + tick labels ──────────────────────────────────────
    [0, 0.25, 0.5, 0.75, 1.0].forEach(t => {
        const y = axisY - t * ch;
        ctx.strokeStyle = t === 0 ? 'rgba(255,255,255,0.18)' : 'rgba(255,255,255,0.05)';
        ctx.lineWidth   = t === 0 ? 1.5 : 1;
        ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(pad.l + cw, y); ctx.stroke();
        const val = (t * maxF).toFixed(2);
        ctx.fillStyle    = '#64748b';
        ctx.font         = '11px "JetBrains Mono"';
        ctx.textAlign    = 'right';
        ctx.textBaseline = 'middle';
        ctx.fillText(val, pad.l - 5, y);
    });

    // ── Y-axis title (rotated) ────────────────────────────────────────
    ctx.save();
    ctx.translate(11, pad.t + ch / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillStyle    = '#475569';
    ctx.font         = 'bold 11px Inter';
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('Cost fᵢ', 0, 0);
    ctx.restore();

    // ── Bars + X-axis labels ─────────────────────────────────────────
    const manualSet = new Set(manualVids);
    const admmSet   = new Set(admmVids);
    // figure out how many labels can fit without overlap (~30px each)
    const maxLabels = Math.floor(cw / 30);
    const step      = Math.max(1, Math.ceil(costs.length / maxLabels));

    costs.forEach((c, i) => {
        const x    = pad.l + (i / costs.length) * cw + 1;
        const barH = (c.f_i / maxF) * ch;
        const y    = axisY - barH;

        // Bar color
        let color;
        if (manualSet.has(c.vid)) {
            const g = ctx.createLinearGradient(x, y, x, axisY);
            g.addColorStop(0, '#ef4444'); g.addColorStop(1, '#ec4899'); color = g;
        } else if (admmSet.has(c.vid)) {
            const g = ctx.createLinearGradient(x, y, x, axisY);
            g.addColorStop(0, '#f59e0b'); g.addColorStop(1, '#ef4444'); color = g;
        } else {
            const g = ctx.createLinearGradient(x, y, x, axisY);
            g.addColorStop(0, '#10b981'); g.addColorStop(1, '#06b6d4'); color = g;
        }
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.roundRect(x, y, barW, barH, [2, 2, 0, 0]);
        ctx.fill();

        // X-axis label — drawn horizontally, anchored below baseline tick
        if (i % step === 0) {
            const lx = x + barW / 2;
            // small tick mark
            ctx.strokeStyle = 'rgba(255,255,255,0.2)';
            ctx.lineWidth   = 1;
            ctx.beginPath(); ctx.moveTo(lx, axisY); ctx.lineTo(lx, axisY + 5); ctx.stroke();
            // label
            ctx.fillStyle    = '#94a3b8';
            ctx.font         = 'bold 11px "JetBrains Mono"';
            ctx.textAlign    = 'center';
            ctx.textBaseline = 'top';
            ctx.fillText(`V${c.vid}`, lx, axisY + 8);
        }
    });

    // ── X-axis title ────────────────────────────────────────────────────────
    ctx.fillStyle    = '#475569';
    ctx.font         = 'bold 11px Inter';
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText('Vehicle ID', pad.l + cw / 2, h - 2);
}



// ─── Playback ─────────────────────────────────────────────────────────────────
function togglePlay() {
    if (state.playing) {
        stopPlay();
    } else {
        startPlay();
    }
}

function startPlay() {
    state.playing = true;
    els.btnPlay.textContent = '⏸';
    els.btnPlay.title = 'Pause';

    const baseInterval = 200; // ms per frame at 1x
    const interval = baseInterval / state.playSpeed;

    state.playInterval = setInterval(async () => {
        if (state.currentFrame >= state.timeline.length - 1) {
            stopPlay();
            return;
        }
        await loadFrame(state.currentFrame + 1);
    }, interval);
}

function stopPlay() {
    state.playing = false;
    els.btnPlay.textContent = '▶';
    els.btnPlay.title = 'Play';
    if (state.playInterval) {
        clearInterval(state.playInterval);
        state.playInterval = null;
    }
}

// ─── Event Listeners ──────────────────────────────────────────────────────────
function setupEventListeners() {
    // Slider
    els.slider.addEventListener('input', async (e) => {
        const wasPlaying = state.playing;
        if (wasPlaying) stopPlay();
        await loadFrame(parseInt(e.target.value));
    });

    // Playback buttons
    els.btnPlay.addEventListener('click', togglePlay);
    els.btnStepBack.addEventListener('click', () => {
        stopPlay();
        loadFrame(Math.max(0, state.currentFrame - 1));
    });
    els.btnStepFwd.addEventListener('click', () => {
        stopPlay();
        loadFrame(Math.min(state.timeline.length - 1, state.currentFrame + 1));
    });
    els.btnReset.addEventListener('click', () => {
        stopPlay();
        loadFrame(0);
    });

    // Speed buttons
    $$('.speed-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            $$('.speed-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            state.playSpeed = parseFloat(btn.dataset.speed);
            if (state.playing) {
                stopPlay();
                startPlay();
            }
        });
    });

    // Display toggles
    els.showLinks.addEventListener('change', (e) => {
        state.showLinks = e.target.checked; render();
    });
    els.showRadius.addEventListener('change', (e) => {
        state.showRadius = e.target.checked; render();
    });
    els.showPredictions.addEventListener('change', (e) => {
        state.showPredictions = e.target.checked; render();
    });
    els.showLabels.addEventListener('change', (e) => {
        state.showLabels = e.target.checked; render();
    });
    els.showGroups.addEventListener('change', (e) => {
        state.showGroups = e.target.checked; render();
    });

    // Canvas mouse hover for vehicle selection
    els.canvas.addEventListener('mousemove', (e) => {
        if (!state.simData) return;
        const rect = els.canvas.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;

        let closest = null;
        let minDist = 20; // pixels threshold

        state.simData.vehicles.forEach(v => {
            const [cx, cy] = dataToCanvas(v.x, v.y);
            const d = Math.sqrt((mx - cx) ** 2 + (my - cy) ** 2);
            if (d < minDist) {
                minDist = d;
                closest = v.vid;
            }
        });

        if (state.selectedVehicle !== closest) {
            state.selectedVehicle = closest;
            render();
        }
    });

    els.canvas.addEventListener('mouseleave', () => {
        state.selectedVehicle = null;
        render();
    });

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
        switch (e.key) {
            case ' ':
                e.preventDefault();
                togglePlay();
                break;
            case 'ArrowLeft':
                stopPlay();
                loadFrame(Math.max(0, state.currentFrame - 1));
                break;
            case 'ArrowRight':
                stopPlay();
                loadFrame(Math.min(state.timeline.length - 1, state.currentFrame + 1));
                break;
            case 'r':
            case 'R':
                stopPlay();
                loadFrame(0);
                break;
        }
    });
}

// ─── Start ────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', init);
