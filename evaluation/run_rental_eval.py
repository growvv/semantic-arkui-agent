#!/usr/bin/env python3
"""Run the local Rental tab-navigation acceptance task and verify the bridge state."""

from __future__ import annotations

import argparse
import json
import operator
import subprocess
import time
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
HDC = Path("/Applications/DevEco-Studio.app/Contents/sdk/default/openharmony/toolchains/hdc")
TASKS_PATH = ROOT / "evaluation/tasks/rental.json"
RUN_ROOT = ROOT / "evaluation/runs/rental"
OPS = {"==": operator.eq, ">": operator.gt, ">=": operator.ge}


def run(args: list[str], timeout: int = 90) -> subprocess.CompletedProcess[str]:
    return subprocess.run(args, capture_output=True, text=True, timeout=timeout, check=False)


def hdc_shell(*args: str) -> subprocess.CompletedProcess[str]:
    return run([str(HDC), "shell", *args], timeout=60)


def capture(path: Path, remote: str) -> None:
    hdc_shell("uitest", "screenCap", "-p", remote)
    run([str(HDC), "file", "recv", remote, str(path)], timeout=60)


def snapshot(serial: str, out: Path) -> dict[str, Any] | None:
    run(["node", str(ROOT / "bin/haptest"), "semantic", "tree", "--serial", serial, "--out", str(out)], timeout=90)
    if not out.exists():
        return None
    try:
        return json.loads(out.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return None


def evaluate(snapshot_data: dict[str, Any] | None, check: dict[str, Any]) -> tuple[bool, str]:
    if not snapshot_data:
        return False, "snapshot missing"
    for node in snapshot_data.get("nodes", []):
        if node.get("id") != check.get("id"):
            continue
        if check.get("alsoVisible") and node.get("visible") is not True:
            return False, "node is not visible"
        state = node.get("state") or {}
        actual = state.get(check.get("field"))
        op = OPS.get(check.get("op", "=="))
        if op is None or actual is None:
            return False, f"state field {check.get('field')} missing"
        return bool(op(actual, check.get("value"))), f"{check.get('field')}={actual!r}"
    return False, f"node {check.get('id')} missing"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--serial", default=None)
    args = parser.parse_args()
    config = json.loads(TASKS_PATH.read_text(encoding="utf-8"))
    bundle = config["bundle"]
    serial = args.serial or config["serial"]
    RUN_ROOT.mkdir(parents=True, exist_ok=True)
    hdc_shell("power-shell", "wakeup")
    hdc_shell("uitest", "uiInput", "keyEvent", "Home")
    time.sleep(0.5)

    results = []
    for task in config["tasks"]:
        run_dir = RUN_ROOT / task["id"]
        run_dir.mkdir(parents=True, exist_ok=True)
        hdc_shell("aa", "force-stop", bundle)
        hdc_shell("aa", "start", "-a", "EntryAbility", "-b", bundle)
        time.sleep(2.0)
        capture(run_dir / "before.jpeg", f"/data/local/tmp/rental-{task['id']}-before.jpeg")
        before = snapshot(serial, run_dir / "before.json")
        command = [
            "node", str(ROOT / "bin/haptest"), "semantic", "run",
            "--serial", serial, "--bundle", bundle, "--task", task["goal"], "--out", str(run_dir),
        ]
        started = time.monotonic()
        process = run(command, timeout=300)
        elapsed = round(time.monotonic() - started, 2)
        (run_dir / "agent.stdout").write_text(process.stdout or "", encoding="utf-8")
        (run_dir / "agent.stderr").write_text(process.stderr or "", encoding="utf-8")
        try:
            agent_result = json.loads(process.stdout)
        except json.JSONDecodeError:
            agent_result = {"ok": False, "raw": process.stdout}
        time.sleep(0.5)
        after = snapshot(serial, run_dir / "after.json")
        capture(run_dir / "after.jpeg", f"/data/local/tmp/rental-{task['id']}-after.jpeg")
        verified, detail = evaluate(after, task["check"])
        record = {
            "id": task["id"],
            "goal": task["goal"],
            "agent": agent_result,
            "elapsedSeconds": elapsed,
            "verified": verified,
            "checkDetail": detail,
            "beforeSnapshot": str(run_dir / "before.json"),
            "afterSnapshot": str(run_dir / "after.json"),
            "trajectory": str(run_dir / "trajectory.jsonl"),
            "beforeScreenshot": str(run_dir / "before.jpeg"),
            "afterScreenshot": str(run_dir / "after.jpeg"),
        }
        (run_dir / "result.json").write_text(json.dumps(record, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        results.append(record)
        print(f"{'PASS' if verified else 'FAIL'} {task['id']} | agentFinished={bool(agent_result.get('result', {}).get('success'))} | {detail} | {agent_result.get('result', {}).get('reason', agent_result.get('error', ''))}")

    summary = {
        "app": config["app"], "bundle": bundle, "source": config.get("source"),
        "total": len(results), "verified": sum(1 for item in results if item["verified"]),
        "agentFinished": sum(1 for item in results if item["agent"].get("result", {}).get("success")),
        "promptTokens": sum(item["agent"].get("result", {}).get("promptTokens", 0) for item in results),
        "completionTokens": sum(item["agent"].get("result", {}).get("completionTokens", 0) for item in results),
        "results": results,
    }
    (RUN_ROOT / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({key: summary[key] for key in ["app", "total", "verified", "agentFinished", "promptTokens", "completionTokens"]}, ensure_ascii=False))
    return 0 if summary["verified"] == summary["total"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
