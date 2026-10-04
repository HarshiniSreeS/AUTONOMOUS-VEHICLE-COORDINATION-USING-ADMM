"""
FastAPI server for the AV Coordination Simulation.
Serves the simulation API and static frontend files.
"""

import os
import sys
from pathlib import Path
from fastapi import FastAPI, Query
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse
from fastapi.middleware.cors import CORSMiddleware

# Add parent to path so we can import engine
sys.path.insert(0, str(Path(__file__).parent))
from engine import SimulationEngine

# ─── Initialize ───────────────────────────────────────────────────────────────
DATA_FILE = Path(__file__).parent.parent / "trajectories.txt"
app = FastAPI(title="AV Coordination Simulation", version="1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Load simulation engine on startup
engine = None

@app.on_event("startup")
async def startup():
    global engine
    print(f"Loading trajectory data from {DATA_FILE}...")
    engine = SimulationEngine(str(DATA_FILE))
    print(f"Loaded {len(engine.vehicle_ids)} vehicles, "
          f"{len(engine.timestamps)} timestamps, "
          f"{len(engine.raw_data)} total records")

# ─── API Endpoints ────────────────────────────────────────────────────────────

@app.get("/api/info")
async def get_info():
    """Basic dataset info."""
    return {
        "vehicle_count": len(engine.vehicle_ids),
        "vehicle_ids": engine.vehicle_ids,
        "timestamp_count": len(engine.timestamps),
        "time_range": {
            "start": engine.timestamps[0],
            "end": engine.timestamps[-1],
        },
        "total_records": len(engine.raw_data),
    }

@app.get("/api/timeline")
async def get_timeline():
    """Timeline data for the slider."""
    return engine.get_timeline_data()

@app.get("/api/simulate")
async def simulate(timestamp: int = Query(..., description="NGSIM timestamp")):
    """Run full pipeline at a specific timestamp."""
    result = engine.run_full_pipeline(timestamp)
    return result

@app.get("/api/frames")
async def get_frames(
    start: int = Query(0, description="Start frame index"),
    count: int = Query(50, description="Number of frames"),
):
    """Get animation frames."""
    return engine.get_animation_frames(start, count)

@app.get("/api/persistence")
async def check_persistence(
    vid_a: int = Query(...),
    vid_b: int = Query(...),
    timestamp: int = Query(...),
):
    """Check if two vehicles stay together over time."""
    persistent, dists = engine.check_persistence(vid_a, vid_b, timestamp)
    return {"persistent": persistent, "distances": dists}

@app.get("/api/manual_detection")
async def manual_detection():
    """Get manual vehicle detection results."""
    records, threshold = engine.detect_manual_vehicles()
    return {"vehicles": records, "threshold": threshold}

# ─── Serve Frontend ───────────────────────────────────────────────────────────
FRONTEND_DIR = Path(__file__).parent.parent / "frontend"

@app.get("/")
async def serve_index():
    return FileResponse(FRONTEND_DIR / "index.html")

# Mount static files (CSS, JS)
if FRONTEND_DIR.exists():
    app.mount("/static", StaticFiles(directory=str(FRONTEND_DIR)), name="static")

# Fallback for direct file requests
@app.get("/{filename:path}")
async def serve_static(filename: str):
    filepath = FRONTEND_DIR / filename
    if filepath.exists() and filepath.is_file():
        return FileResponse(filepath)
    return JSONResponse({"error": "Not found"}, status_code=404)
