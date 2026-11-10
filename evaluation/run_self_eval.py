#!/usr/bin/env python3
"""Run the SemanticTasks acceptance tasks and verify state outside the agent channel."""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import time
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
HDC = Path("/Applications/DevEco-Studio.app/Contents/sdk/default/openharmony/toolchains/hdc")
TASKS_PATH = ROOT / "evaluation/tasks/semantic-tasks.json"
RUN_ROOT = ROOT / "evaluation/runs/self"
TASK_FIELDS = ["id", "title", "project", "dueDate", "priority", "completed", "favorite"]


def run(args: list[str], timeout: int = 60) -> subprocess.CompletedProcess[str]:
    return subprocess.run(args, capture_output=True, text=True, timeout=timeout, check=False)


def hdc_shell(*args: str, timeout: int = 60) -> subprocess.CompletedProcess[str]:
    return run([str(HDC), "shell", *args], timeout=timeout)


def hdc_shell_text(command: str, timeout: int = 60) -> str:
    result = run([str(HDC), "shell", command], timeout=timeout)
    return (result.stdout or "") + (result.stderr or "")


def pid_of(bundle: str) -> str:
    output = hdc_shell_text(f"pidof {bundle}")
    tokens = output.strip().split()
    return tokens[0] if tokens else ""


def read_eval_state(bundle: str) -> dict[str, Any] | None:
    pid = pid_of(bundle)
    if not pid:
        return None
    command = f"hilog -x | grep SEM_EVAL | grep ' {pid} ' | tail -1"
    output = hdc_shell_text(command)
    match = re.search(r"SEM_EVAL: (\{.*\})\s*$", output)
    if not match:
        return None
    try:
        return json.loads(match.group(1))
    except json.JSONDecodeError:
        return None


def wait_for_eval_state(bundle: str, attempts: int = 8) -> dict[str, Any] | None:
    for _ in range(attempts):
        state = read_eval_state(bundle)
        if state is not None:
            return state
        time.sleep(0.5)
    return None


def capture_screenshot(path: Path, remote: str) -> bool:
    hdc_shell("uitest", "screenCap", "-p", remote)
    result = run([str(HDC), "file", "recv", remote, str(path)], timeout=60)
    return path.exists()


def task_map(state: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {task.get("id", ""): task for task in state.get("tasks", [])}


def evaluate_check(state: dict[str, Any], check: dict[str, Any]) -> bool:
    if check.get("type") == "task_field":
        task = task_map(state).get(check.get("taskId"))
        return task is not None and task.get(check.get("field")) == check.get("value")
    if check.get("type") == "app_field":
        value = state.get(check.get("field"))
        if "contains" in check:
            return isinstance(value, str) and check["contains"] in value
        return value == check.get("value")
    return False


def changed_fields(initial: dict[str, Any], final: dict[str, Any], check: dict[str, Any]) -> list[dict[str, Any]]:
    changes: list[dict[str, Any]] = []
    initial_tasks = task_map(initial)
    final_tasks = task_map(final)
    for task_id, before in initial_tasks.items():
        after = final_tasks.get(task_id)
        if after is None:
            changes.append({"scope": "task", "taskId": task_id, "field": "missing", "before": before, "after": None})
            continue
        for field in TASK_FIELDS:
            if before.get(field) != after.get(field):
                changes.append({"scope": "task", "taskId": task_id, "field": field, "before": before.get(field), "after": after.get(field)})
    for field in ["query", "onlyOpen", "onlyFavorite"]:
        if initial.get(field) != final.get(field):
            changes.append({"scope": "app", "field": field, "before": initial.get(field), "after": final.get(field)})
    return changes


def allowed_change(change: dict[str, Any], allowed: list[dict[str, str]], check: dict[str, Any]) -> bool:
    if change["scope"] == "task":
        return any(change["taskId"] == item.get("taskId") and change["field"] == item.get("field") for item in allowed)
    if check.get("type") == "app_field" and change["field"] == check.get("field"):
        return True
    return False


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

    results: list[dict[str, Any]] = []
    tasks = config["tasks"][: args.limit] if args.limit else config["tasks"]
    if args.only:
        tasks = [task for task in tasks if task["id"] == args.only]
    for task in tasks:
        task_id = task["id"]
        run_dir = RUN_ROOT / task_id
        run_dir.mkdir(parents=True, exist_ok=True)
        hdc_shell("aa", "force-stop", bundle)
        hdc_shell("aa", "start", "-a", "EntryAbility", "-b", bundle)
        time.sleep(2.0)
        initial = wait_for_eval_state(bundle)
        before_shot = run_dir / "before.jpeg"
        capture_screenshot(before_shot, f"/data/local/tmp/{task_id}-before.jpeg")

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
        final = wait_for_eval_state(bundle)
        after_shot = run_dir / "after.jpeg"
        capture_screenshot(after_shot, f"/data/local/tmp/{task_id}-after.jpeg")

        check_ok = final is not None and evaluate_check(final, task["check"])
        changes = changed_fields(initial, final, task["check"]) if initial and final else []
        unallowed = [change for change in changes if not allowed_change(change, task.get("allowedChanges", []), task["check"])]
        verified = bool(check_ok and initial is not None and final is not None and not unallowed)
        record = {
            "id": task_id,
            "goal": task["goal"],
            "agent": agent_result,
            "agentExitCode": agent_process.returncode,
            "elapsedSeconds": elapsed,
            "verified": verified,
            "checkOk": check_ok,
            "changes": changes,
            "unallowedChanges": unallowed,
            "initialState": initial,
            "finalState": final,
            "trajectory": str(run_dir / "trajectory.jsonl"),
            "beforeScreenshot": str(before_shot),
            "afterScreenshot": str(after_shot),
        }
        (run_dir / "result.json").write_text(json.dumps(record, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        results.append(record)
        status = "PASS" if verified else "FAIL"
        print(f"{status} {task_id} | agentFinished={bool(agent_result.get('result', {}).get('success'))} | verified={verified} | {agent_result.get('result', {}).get('reason', agent_result.get('error', ''))}")

    summary = {
        "app": config["app"],
        "bundle": bundle,
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
