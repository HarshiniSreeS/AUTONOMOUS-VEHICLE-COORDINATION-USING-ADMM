"""
Autonomous Vehicle Coordination Simulation Engine
===================================================
Processes NGSIM trajectory data to:
  1. Extract vehicle states at each timestep
  2. Build 50m communication graph G=(V,E) from pairwise distances
  3. Detect local traffic groups via proximity + speed + lane criteria
  4. Identify manual/uncertain vehicles via variance-based σ̂ metric
  5. Predict future positions (kinematic model)
  6. Calculate per-vehicle costs: f_i = w_T·T + w_R·R + w_E·E
  7. Run ADMM coordination for affected AVs
"""

import numpy as np
from pathlib import Path
from collections import defaultdict

# ─── NGSIM Column Indices (space-delimited .txt) ──────────────────────────────
# Cols: Vehicle_ID, Frame_ID, Total_Frames, Global_Time,
#       Local_X, Local_Y, Global_X, Global_Y,
#       Vehicle_Length, Vehicle_Width, Lane_ID,
#       v_Vel (ft/s), v_Acc (ft/s²), ...
COL_VID       = 0
COL_FRAME     = 1
COL_TOTFRAMES = 2
COL_TIME      = 3
COL_LOCALX    = 4
COL_LOCALY    = 5
COL_GLOBALX   = 6
COL_GLOBALY   = 7
COL_LENGTH    = 8
COL_WIDTH     = 9
COL_LANE      = 10
COL_SPEED     = 11
COL_ACCEL     = 12

# ─── Configuration ────────────────────────────────────────────────────────────
COMM_RADIUS        = 50.0   # meters — V2V communication range
SPEED_THRESHOLD    = 3.0    # m/s — max speed difference for "travelling together"
LANE_THRESHOLD     = 1      # max lane difference for compatible groups
PERSISTENCE_STEPS  = 5      # timesteps a pair must stay close to be "grouped"
FT_TO_M            = 0.3048 # NGSIM data is in feet; convert to meters
PREDICTION_DT      = 2.0    # seconds — prediction horizon

# Cost weights (from PPT: f_i = 0.4T + 0.4R + 0.2E)
W_T = 0.4
W_R = 0.4
W_E = 0.2

# ADMM hyperparameters
RHO            = 1.0
MAX_ITERATIONS = 50
TOLERANCE      = 1e-3


class VehicleState:
    """State of one vehicle at one timestamp."""
    __slots__ = ['vid', 'time', 'x', 'y', 'speed', 'accel', 'lane',
                 'length', 'width', 'global_x', 'global_y']

    def __init__(self, vid, time, x, y, speed, accel, lane,
                 length=0, width=0, global_x=0, global_y=0):
        self.vid = vid
        self.time = time
        self.x = x * FT_TO_M          # convert feet → meters
        self.y = y * FT_TO_M
        self.speed = speed * FT_TO_M   # ft/s → m/s
        self.accel = accel * FT_TO_M   # ft/s² → m/s²
        self.lane = lane
        self.length = length * FT_TO_M
        self.width = width * FT_TO_M
        self.global_x = global_x
        self.global_y = global_y

    def to_dict(self):
        return {
            'vid': self.vid, 'time': self.time,
            'x': round(self.x, 3), 'y': round(self.y, 3),
            'speed': round(self.speed, 3), 'accel': round(self.accel, 3),
            'lane': self.lane,
            'length': round(self.length, 3), 'width': round(self.width, 3),
        }


class SimulationEngine:
    """Full pipeline: data → graph → groups → detection → prediction → cost → ADMM."""

    def __init__(self, data_path: str):
        self.data_path = Path(data_path)
        self.raw_data = []           # list of VehicleState
        self.timestamps = []         # sorted unique timestamps
        self.vehicle_ids = []        # sorted unique vehicle IDs
        self.states_by_time = {}     # {timestamp: {vid: VehicleState}}
        self.states_by_vehicle = {}  # {vid: [VehicleState sorted by time]}
        self._load_data()

    # ──────────────────────────────────────────────────────────────────────────
    # DATA LOADING
    # ──────────────────────────────────────────────────────────────────────────

    def _load_data(self):
        """Parse the NGSIM space-delimited trajectory file."""
        by_time = defaultdict(dict)
        by_vehicle = defaultdict(list)

        with open(self.data_path, 'r') as f:
            for line in f:
                fields = line.split()
                if len(fields) < 13:
                    continue
                vid   = int(fields[COL_VID])
                time  = int(fields[COL_TIME])
                vs = VehicleState(
                    vid   = vid,
                    time  = time,
                    x     = float(fields[COL_LOCALX]),
                    y     = float(fields[COL_LOCALY]),
                    speed = float(fields[COL_SPEED]),
                    accel = float(fields[COL_ACCEL]),
                    lane  = int(fields[COL_LANE]),
                    length = float(fields[COL_LENGTH]),
                    width  = float(fields[COL_WIDTH]),
                    global_x = float(fields[COL_GLOBALX]),
                    global_y = float(fields[COL_GLOBALY]),
                )
                self.raw_data.append(vs)
                by_time[time][vid] = vs
                by_vehicle[vid].append(vs)

        self.states_by_time = dict(by_time)
        self.states_by_vehicle = {
            vid: sorted(states, key=lambda s: s.time)
            for vid, states in by_vehicle.items()
        }
        self.timestamps = sorted(self.states_by_time.keys())
        self.vehicle_ids = sorted(self.states_by_vehicle.keys())

    # ──────────────────────────────────────────────────────────────────────────
    # COMMUNICATION GRAPH  G=(V,E)
    # ──────────────────────────────────────────────────────────────────────────

    @staticmethod
    def _distance(s1: VehicleState, s2: VehicleState) -> float:
        return np.sqrt((s1.x - s2.x)**2 + (s1.y - s2.y)**2)

    def build_communication_graph(self, timestamp: int):
        """
        Build communication graph at a given timestamp.
        Edge (i,j) exists iff d_ij ≤ COMM_RADIUS.
        Returns: {vid: [neighbor_vids]}, {(vi,vj): distance}
        """
        snapshot = self.states_by_time.get(timestamp, {})
        vids = list(snapshot.keys())
        graph = {vid: [] for vid in vids}
        distances = {}

        for i in range(len(vids)):
            for j in range(i + 1, len(vids)):
                vi, vj = vids[i], vids[j]
                d = self._distance(snapshot[vi], snapshot[vj])
                if d <= COMM_RADIUS:
                    graph[vi].append(vj)
                    graph[vj].append(vi)
                    distances[(vi, vj)] = round(d, 2)
                    distances[(vj, vi)] = round(d, 2)

        return graph, distances

    # ──────────────────────────────────────────────────────────────────────────
    # LOCAL TRAFFIC GROUP DETECTION
    # ──────────────────────────────────────────────────────────────────────────

    def detect_local_groups(self, timestamp: int):
        """
        Three conditions:
          1. Spatial proximity:   d_ij ≤ COMM_RADIUS
          2. Similar movement:    |v_i - v_j| ≤ SPEED_THRESHOLD
          3. Compatible lane:     |lane_i - lane_j| ≤ LANE_THRESHOLD

        Returns groups as list of sets of vehicle IDs.
        Uses union-find for efficient clustering.
        """
        snapshot = self.states_by_time.get(timestamp, {})
        vids = list(snapshot.keys())
        if not vids:
            return []

        # Union-Find
        parent = {v: v for v in vids}

        def find(x):
            while parent[x] != x:
                parent[x] = parent[parent[x]]
                x = parent[x]
            return x

        def union(a, b):
            ra, rb = find(a), find(b)
            if ra != rb:
                parent[ra] = rb

        for i in range(len(vids)):
            for j in range(i + 1, len(vids)):
                vi, vj = vids[i], vids[j]
                si, sj = snapshot[vi], snapshot[vj]

                d = self._distance(si, sj)
                if d > COMM_RADIUS:
                    continue
                if abs(si.speed - sj.speed) > SPEED_THRESHOLD:
                    continue
                if abs(si.lane - sj.lane) > LANE_THRESHOLD:
                    continue

                union(vi, vj)

        # Collect groups
        groups_map = defaultdict(set)
        for v in vids:
            groups_map[find(v)].add(v)

        return [g for g in groups_map.values() if len(g) > 1]

    # ──────────────────────────────────────────────────────────────────────────
    # PERSISTENCE CHECK: remain together over multiple timesteps
    # ──────────────────────────────────────────────────────────────────────────

    def check_persistence(self, vid_a: int, vid_b: int, center_time: int,
                          n_steps: int = PERSISTENCE_STEPS):
        """
        Check if two vehicles stay within COMM_RADIUS across
        n_steps consecutive timesteps centred on center_time.
        """
        idx = None
        for i, t in enumerate(self.timestamps):
            if t >= center_time:
                idx = i
                break
        if idx is None:
            return False, []

        start = max(0, idx - n_steps // 2)
        end = min(len(self.timestamps), start + n_steps)
        check_times = self.timestamps[start:end]

        dists = []
        for t in check_times:
            snap = self.states_by_time.get(t, {})
            if vid_a not in snap or vid_b not in snap:
                return False, dists
            d = self._distance(snap[vid_a], snap[vid_b])
            dists.append({'time': t, 'distance': round(d, 2)})
            if d > COMM_RADIUS:
                return False, dists

        return True, dists

    # ──────────────────────────────────────────────────────────────────────────
    # MANUAL VEHICLE DETECTION  (σ̂_i = (σ²_v + σ²_a) / (σ²_v_max + σ²_a_max))
    # ──────────────────────────────────────────────────────────────────────────

    def detect_manual_vehicles(self):
        """
        Variance-based analysis over each vehicle's full trajectory.
        High variance in speed + acceleration → likely manual.
        Threshold = 75th percentile of σ̂.
        """
        records = []
        for vid in self.vehicle_ids:
            states = self.states_by_vehicle[vid]
            speeds = [s.speed for s in states]
            accels = [s.accel for s in states]
            var_v = float(np.var(speeds))
            var_a = float(np.var(accels))
            records.append({
                'vid': vid,
                'var_v': round(var_v, 4),
                'var_a': round(var_a, 4),
                'n_frames': len(states),
            })

        var_v_max = max(r['var_v'] for r in records) or 1.0
        var_a_max = max(r['var_a'] for r in records) or 1.0

        for r in records:
            sigma = (r['var_v'] + r['var_a']) / (var_v_max + var_a_max)
            r['sigma_hat'] = round(sigma, 4)

        sigmas = [r['sigma_hat'] for r in records]
        threshold = float(np.percentile(sigmas, 75))

        for r in records:
            r['is_manual'] = bool(r['sigma_hat'] > threshold)
            r['label'] = 'Manual' if r['is_manual'] else 'Autonomous'

        return records, threshold

    # ──────────────────────────────────────────────────────────────────────────
    # FUTURE POSITION PREDICTION  (kinematic: x' = x + v·dt + ½a·dt²)
    # ──────────────────────────────────────────────────────────────────────────

    def predict_positions(self, timestamp: int, dt: float = PREDICTION_DT):
        """
        For each vehicle present at `timestamp`, predict position at t+dt.
        Uses last two frames to estimate velocity direction.
        """
        snapshot = self.states_by_time.get(timestamp, {})
        idx_map = {t: i for i, t in enumerate(self.timestamps)}
        t_idx = idx_map.get(timestamp)

        predictions = {}
        for vid, state in snapshot.items():
            # Get previous state for direction estimation
            trajectory = self.states_by_vehicle[vid]
            prev_state = None
            for s in reversed(trajectory):
                if s.time < timestamp:
                    prev_state = s
                    break

            if prev_state is not None:
                frame_dt = (state.time - prev_state.time) / 1000.0
                if frame_dt > 0:
                    vx = (state.x - prev_state.x) / frame_dt
                    vy = (state.y - prev_state.y) / frame_dt
                else:
                    vx, vy = 0, state.speed
            else:
                vx, vy = 0, state.speed

            x_pred = state.x + vx * dt + 0.5 * state.accel * dt**2 * (vx / (abs(vx) + 1e-9))
            y_pred = state.y + vy * dt + 0.5 * state.accel * dt**2 * (vy / (abs(vy) + 1e-9))

            predictions[vid] = {
                'vid': vid,
                'x_now': round(state.x, 3),
                'y_now': round(state.y, 3),
                'x_pred': round(x_pred, 3),
                'y_pred': round(y_pred, 3),
                'vx': round(vx, 3),
                'vy': round(vy, 3),
                'speed': round(state.speed, 3),
                'accel': round(state.accel, 3),
                'lane': state.lane,
            }

        return predictions

    # ──────────────────────────────────────────────────────────────────────────
    # COST FUNCTION: f_i = w_T · T_norm + w_R · R_norm + w_E · E_norm
    # ──────────────────────────────────────────────────────────────────────────

    def calculate_costs(self, timestamp: int, predictions: dict,
                        manual_info: list, graph: dict):
        """
        For each vehicle:
          T_i = remaining travel time estimate
          R_i = collision risk (1/d_min) · (1 + λ·σ̂_i)
          E_i = energy (acceleration²)
        """
        snapshot = self.states_by_time.get(timestamp, {})
        if not snapshot:
            return []

        y_target = max(s.y for s in snapshot.values())
        sigma_map = {r['vid']: r['sigma_hat'] for r in manual_info}

        cost_records = []
        for vid, pred in predictions.items():
            speed = max(pred['speed'], 0.1)

            # Travel time
            T_i = max((y_target - pred['y_pred']) / speed, 0)

            # Collision risk
            neighbors = graph.get(vid, [])
            if neighbors:
                dists = []
                for n_vid in neighbors:
                    if n_vid in predictions:
                        npred = predictions[n_vid]
                        d = np.sqrt((pred['x_pred'] - npred['x_pred'])**2 +
                                    (pred['y_pred'] - npred['y_pred'])**2)
                        dists.append(d)
                d_min = max(min(dists), 0.1) if dists else 1000
            else:
                d_min = 1000

            sigma_hat_i = sigma_map.get(vid, 0)
            R_i = (1.0 / d_min) * (1 + sigma_hat_i)

            # Energy
            E_i = pred['accel'] ** 2

            cost_records.append({
                'vid': vid,
                'T_raw': round(T_i, 4),
                'R_raw': round(R_i, 6),
                'E_raw': round(E_i, 4),
                'd_min': round(d_min, 2),
                'sigma_hat': round(sigma_hat_i, 4),
            })

        # Normalize
        if cost_records:
            t_vals = [r['T_raw'] for r in cost_records]
            r_vals = [r['R_raw'] for r in cost_records]
            e_vals = [r['E_raw'] for r in cost_records]

            def norm(vals):
                mn, mx = min(vals), max(vals)
                rng = mx - mn
                return [(v - mn) / rng if rng > 0 else 0 for v in vals]

            t_n, r_n, e_n = norm(t_vals), norm(r_vals), norm(e_vals)

            for i, rec in enumerate(cost_records):
                rec['T_norm'] = round(t_n[i], 4)
                rec['R_norm'] = round(r_n[i], 4)
                rec['E_norm'] = round(e_n[i], 4)
                rec['f_i'] = round(W_T * t_n[i] + W_R * r_n[i] + W_E * e_n[i], 4)

        return cost_records

    # ──────────────────────────────────────────────────────────────────────────
    # ADMM COORDINATION
    # ──────────────────────────────────────────────────────────────────────────

    def run_admm(self, affected_vids: list, cost_records: list,
                 predictions: dict, graph: dict):
        """
        Distributed ADMM for the AVs near a manual vehicle.

        Decision variable x_i = [speed_adjustment, lane_offset] for each AV.
        Consensus constraint: neighbouring AVs agree on shared boundary states.

        Augmented Lagrangian per agent:
          L_ρ(x_i, z, u_i) = f_i(x_i) + u_i^T(x_i - z) + (ρ/2)||x_i - z||²

        Updates:
          x_i ← argmin L_ρ  (closed-form for quadratic approximation)
          z   ← average of (x_i + u_i)
          u_i ← u_i + (x_i - z)
        """
        n = len(affected_vids)
        if n == 0:
            return {'iterations': 0, 'converged': True, 'history': [],
                    'vehicles': [], 'x_final': {}, 'z_final': []}

        cost_map = {r['vid']: r for r in cost_records}

        # Initialize: x_i ∈ R² (speed_adj, lane_offset)
        x = {vid: np.array([0.0, 0.0]) for vid in affected_vids}
        z = np.zeros(2)
        u = {vid: np.zeros(2) for vid in affected_vids}

        history = []

        for k in range(MAX_ITERATIONS):
            # ── x-update (per vehicle, parallelizable) ──
            for vid in affected_vids:
                cost = cost_map.get(vid, {})
                f_i = cost.get('f_i', 0)

                # Gradient of f_i approximated as [R_norm·sign, -E_norm]
                # This creates a tendency to slow down near risky vehicles
                # and reduce energy expenditure
                grad_fi = np.array([
                    cost.get('R_norm', 0) * 2.0,  # risk pushes speed down
                    cost.get('E_norm', 0) * 0.5,   # energy pushes lane stable
                ])

                # Proximal / quadratic step:
                # x_i = (1/(1+ρ)) * (ρ*(z - u_i) - grad_fi)
                x[vid] = (1.0 / (1.0 + RHO)) * (RHO * (z - u[vid]) - grad_fi)

            # ── z-update (consensus / averaging) ──
            z_new = np.mean([x[vid] + u[vid] for vid in affected_vids], axis=0)

            # ── u-update (dual variable / price) ──
            for vid in affected_vids:
                u[vid] = u[vid] + (x[vid] - z_new)

            # ── Convergence check ──
            primal_residual = np.sqrt(sum(
                np.sum((x[vid] - z_new)**2) for vid in affected_vids
            ) / n)

            dual_residual = np.sqrt(np.sum((z_new - z)**2)) * RHO

            z = z_new

            iteration_data = {
                'iteration': k + 1,
                'primal_residual': round(float(primal_residual), 6),
                'dual_residual': round(float(dual_residual), 6),
                'z': [round(float(v), 4) for v in z],
                'x_snapshot': {vid: [round(float(v), 4) for v in x[vid]]
                               for vid in affected_vids},
            }
            history.append(iteration_data)

            if primal_residual < TOLERANCE and dual_residual < TOLERANCE:
                break

        return {
            'iterations': len(history),
            'converged': bool(primal_residual < TOLERANCE and dual_residual < TOLERANCE),
            'final_primal_residual': round(float(primal_residual), 6),
            'final_dual_residual': round(float(dual_residual), 6),
            'history': history,
            'vehicles': affected_vids,
            'x_final': {vid: [round(float(v), 4) for v in x[vid]]
                        for vid in affected_vids},
            'z_final': [round(float(v), 4) for v in z],
        }

    # ──────────────────────────────────────────────────────────────────────────
    # FULL PIPELINE: single-timestamp snapshot
    # ──────────────────────────────────────────────────────────────────────────

    def run_full_pipeline(self, timestamp: int):
        """Execute the complete pipeline at one timestamp."""
        snapshot = self.states_by_time.get(timestamp, {})
        if not snapshot:
            return {'error': f'No data at timestamp {timestamp}'}

        # 1) Communication graph
        graph, distances = self.build_communication_graph(timestamp)

        # 2) Local traffic groups
        groups = self.detect_local_groups(timestamp)

        # 3) Manual vehicle detection
        manual_info, threshold = self.detect_manual_vehicles()
        manual_vids = [r['vid'] for r in manual_info if r['is_manual']]

        # 4) Predictions
        predictions = self.predict_positions(timestamp)

        # 5) Costs
        costs = self.calculate_costs(timestamp, predictions, manual_info, graph)

        # 6) Find AVs affected by manual vehicles
        affected_avs = set()
        for mv in manual_vids:
            neighbors = graph.get(mv, [])
            for n in neighbors:
                if n not in manual_vids:
                    affected_avs.add(n)
            affected_avs.add(mv)  # include the manual vehicle itself

        # 7) ADMM on affected group
        admm_result = self.run_admm(list(affected_avs), costs, predictions, graph)

        # Build response
        vehicle_states = []
        for vid, state in snapshot.items():
            info = next((r for r in manual_info if r['vid'] == vid), {})
            cost = next((c for c in costs if c['vid'] == vid), {})
            pred = predictions.get(vid, {})
            vehicle_states.append({
                **state.to_dict(),
                'is_manual': info.get('is_manual', False),
                'label': info.get('label', 'Unknown'),
                'sigma_hat': info.get('sigma_hat', 0),
                'f_i': cost.get('f_i', 0),
                'T_norm': cost.get('T_norm', 0),
                'R_norm': cost.get('R_norm', 0),
                'E_norm': cost.get('E_norm', 0),
                'x_pred': pred.get('x_pred', state.x),
                'y_pred': pred.get('y_pred', state.y),
                'in_admm': vid in affected_avs,
            })

        # Format edges for frontend
        edges = []
        seen = set()
        for vi, neighbors in graph.items():
            for vj in neighbors:
                key = tuple(sorted([vi, vj]))
                if key not in seen:
                    seen.add(key)
                    edges.append({
                        'from': vi, 'to': vj,
                        'distance': distances.get((vi, vj), 0),
                    })

        # Format groups
        groups_list = [sorted(list(g)) for g in groups]

        return {
            'timestamp': timestamp,
            'vehicle_count': len(snapshot),
            'vehicles': sorted(vehicle_states, key=lambda v: v['vid']),
            'edges': edges,
            'edge_count': len(edges),
            'groups': groups_list,
            'group_count': len(groups_list),
            'manual_vehicles': manual_vids,
            'manual_threshold': round(threshold, 4),
            'affected_avs': sorted(list(affected_avs)),
            'admm': admm_result,
            'costs': sorted(costs, key=lambda c: c['vid']),
        }

    def get_timeline_data(self):
        """Get all timesteps with vehicle counts for the timeline slider."""
        timeline = []
        for t in self.timestamps:
            snap = self.states_by_time[t]
            timeline.append({
                'timestamp': t,
                'vehicle_count': len(snap),
            })
        return timeline

    def get_animation_frames(self, start_idx: int = 0, count: int = 50):
        """Get multiple consecutive frames for smooth animation."""
        end_idx = min(start_idx + count, len(self.timestamps))
        frames = []
        for i in range(start_idx, end_idx):
            t = self.timestamps[i]
            snapshot = self.states_by_time[t]
            frame = {
                'timestamp': t,
                'frame_index': i,
                'vehicles': [
                    s.to_dict() for s in snapshot.values()
                ],
            }
            frames.append(frame)
        return frames
