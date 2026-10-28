"""Footguns in the local video processing (motion smoothing, upscaling).

- The upscaler asked for the 'low-power' adapter, which on a machine with
  integrated and discrete graphics is the integrated GPU, for a neural
  workload that runs at the video's frame rate.
- Both paths copied every frame with createImageBitmap(video); a VideoFrame
  references the decoded picture and the GPU samples it in place.
"""

from pathlib import Path

FRONTEND = Path(__file__).resolve().parents[2] / "frontend"
WORKERS = [FRONTEND / "lib" / "framegen" / "interpolation.worker.ts", FRONTEND / "lib" / "upscaling" / "neural.worker.ts"]
CONTROLLERS = [FRONTEND / "lib" / "framegen" / "controller.ts", FRONTEND / "lib" / "upscaling" / "controller.ts"]


def test_processing_workers_ask_for_the_fast_gpu():
    for worker in WORKERS:
        text = worker.read_text(encoding="utf-8")
        assert "powerPreference: 'high-performance'" in text, worker.name
        assert "powerPreference: 'low-power'" not in text, worker.name


def test_frames_are_not_copied_into_bitmaps_per_frame():
    for controller in CONTROLLERS:
        text = controller.read_text(encoding="utf-8")
        assert "createImageBitmap(this.video)" not in text, controller.name
        assert "new VideoFrame(this.video)" in text, controller.name


def test_motion_smoothing_tunes_for_the_gpu():
    worker = WORKERS[0].read_text(encoding="utf-8")
    assert "tuneConvRB(" in worker and "convTune" in worker
