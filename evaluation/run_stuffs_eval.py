#!/usr/bin/env python3
"""Run STUFFS_NEXT acceptance tasks and verify the bridge snapshot outside the agent."""

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
TASKS_PATH = ROOT / "evaluation/tasks/stuffs.json"
RUN_ROOT = ROOT / "evaluation/runs/stuffs"
OPS = {">": operator.gt, ">=": operator.ge, "==": operator.eq}


def run(args: list[str], timeout: int = 60) -> subprocess.CompletedProcess[str]:
    return subprocess.run(args, capture_output=True, text=True, timeout=timeout, check=False)


def hdc_shell(*args: str, timeout: int = 60) -> subprocess.CompletedProcess[str]:
    return run([str(HDC), "shell", *args], timeout=timeout)


def capture_screenshot(path: Path, remote: str) -> bool:
    hdc_shell("uitest", "screenCap", "-p", remote)
    run([str(HDC), "file", "recv", remote, str(path)], timeout=60)
    return path.exists()


def snapshot(serial: str, out: Path) -> dict[str, Any] | None:
    command = ["node", str(ROOT / "bin/haptest"), "semantic", "tree", "--serial", serial, "--out", str(out)]
    result = run(command, timeout=90)
    if not out.exists():
        return None
    try:
        return json.loads(out.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return None


def find_node(snapshot_data: dict[str, Any] | None, node_id: str) -> dict[str, Any] | None:
    if not snapshot_data:
        return None
    for node in snapshot_data.get("nodes", []):
        if node.get("id") == node_id:
            return node
    return None


def evaluate(snapshot_data: dict[str, Any] | None, check: dict[str, Any]) -> tuple[bool, str]:
    node = find_node(snapshot_data, check.get("id", ""))
    if node is None:
        return False, f"node {check.get('id')} missing"
    if check.get("type") == "node_visible":
        visible = node.get("visible") is True
        return visible, f"visible={node.get('visible')}"
    if check.get("type") == "node_state":
        if check.get("alsoVisible") and node.get("visible") is not True:
            return False, "node is not visible"
        state = node.get("state") or {}
        actual = state.get(check.get("field"))
        expected = check.get("value")
        op = OPS.get(check.get("op", "=="))
        if op is None or actual is None:
            return False, f"state field {check.get('field')} missing"
        try:
            matched = bool(op(actual, expected))
        except TypeError:
            return False, f"cannot compare {actual!r} with {expected!r}"
        if check.get("alsoContains"):
            contains = check["alsoContains"]
            value = state.get(contains.get("field"))
            if not isinstance(value, str) or contains.get("value") not in value:
                return False, f"state field {contains.get('field')} does not contain {contains.get('value')!r}: {value!r}"
        return matched and True, f"{check.get('field')}={actual!r} {check.get('op')} {expected!r}"
    return False, "unknown check"


def reset(bundle: str) -> None:
    hdc_shell("aa", "force-stop", bundle)
    hdc_shell("bm", "clean", "-n", bundle, "-d")
    hdc_shell("aa", "start", "-a", "EntryAbility", "-b", bundle)
    time.sleep(2.0)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--serial", default=None)
    parser.add_argument("--limit", type=int, default=None)
    parser.add_argument("--only", default=None)
    args = parser.parse_args()

    config = json.loads(TASKS_PATH.read_text(encoding="utf-8"))
    bundle = config["bundle"]
    serial = args.serial or config["serial"]
    RUN_ROOT.mkdir(parents=True, exist_ok=True)
    hdc_shell("power-shell", "wakeup")
    hdc_shell("uitest", "uiInput", "keyEvent", "Home")
    time.sleep(0.5)

    tasks = config["tasks"][: args.limit] if args.limit else config["tasks"]
    if args.only:
        tasks = [task for task in tasks if task["id"] == args.only]

    results: list[dict[str, Any]] = []
    for task in tasks:
        task_id = task["id"]
        run_dir = RUN_ROOT / task_id
        run_dir.mkdir(parents=True, exist_ok=True)
        reset(bundle)
        before_shot = run_dir / "before.jpeg"
        capture_screenshot(before_shot, f"/data/local/tmp/stuffs-{task_id}-before.jpeg")
        before_snapshot = snapshot(serial, run_dir / "before.json")

        command = [
            "node", str(ROOT / "bin/haptest"), "semantic", "run",
            "--serial", serial,
            "--bundle", bundle,
            "--task", task["goal"],
            "--out", str(run_dir),
        ]
        started = time.monotonic()
        agent_process = run(command, timeout=300)
        elapsed = round(time.monotonic() - started, 2)
        (run_dir / "agent.stdout").write_text(agent_process.stdout or "", encoding="utf-8")
        (run_dir / "agent.stderr").write_text(agent_process.stderr or "", encoding="utf-8")
        try:
            agent_result = json.loads(agent_process.stdout)
        except json.JSONDecodeError:
            agent_result = {"ok": False, "raw": agent_process.stdout}

        time.sleep(0.5)
        after_snapshot = snapshot(serial, run_dir / "after.json")
        after_shot = run_dir / "after.jpeg"
        capture_screenshot(after_shot, f"/data/local/tmp/stuffs-{task_id}-after.jpeg")

        check_ok, check_detail = evaluate(after_snapshot, task["check"])
        verified = bool(check_ok)
        record = {
            "id": task_id,
            "goal": task["goal"],
            "agent": agent_result,
            "agentExitCode": agent_process.returncode,
            "elapsedSeconds": elapsed,
            "verified": verified,
            "checkDetail": check_detail,
            "beforeSnapshot": str(run_dir / "before.json"),
            "afterSnapshot": str(run_dir / "after.json"),
            "trajectory": str(run_dir / "trajectory.jsonl"),
            "beforeScreenshot": str(before_shot),
            "afterScreenshot": str(after_shot),
        }
        (run_dir / "result.json").write_text(json.dumps(record, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        results.append(record)
        status = "PASS" if verified else "FAIL"
        print(f"{status} {task_id} | agentFinished={bool(agent_result.get('result', {}).get('success'))} | {check_detail} | {agent_result.get('result', {}).get('reason', agent_result.get('error', ''))}")

    summary = {
        "app": config["app"],
        "bundle": bundle,
        "source": config.get("source"),
        "total": len(results),
        "verified": sum(1 for item in results if item["verified"]),
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
