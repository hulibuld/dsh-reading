#!/usr/bin/env python3
"""把本地未推的提交通过 GitHub Git Data API 推上去。

为什么不用 git push：截至 2026-11-03，这台机器到 github.com:443 的 git 协议报
`SSL connection timeout`，而 api.github.com 正常。gh-proxy 只代理 fetch，push 会把
带 token 的地址判成 not found。

用法：
    TARGETS=ca39460:b113450 python3 tools/push-to-github.py

TARGETS 的每一项是 `本地提交:它的父提交`，逗号分隔。脚本会为每个提交建 blob/tree/commit，
再把 refs/heads/main 指过去，所以远端历史是逐条重建的，不是一次 squash。
token 从 `git credential fill` 取，不写进任何文件。
"""
import json
import os
import subprocess
import sys
import urllib.request

REPO = "hulibuld/dsh-reading"
BRANCH = "main"
API = "https://api.github.com"
CWD = "/Users/joyfon620/Documents/deepseek-harness/default-workspace/dsh-Reading"

TOKEN = subprocess.run(
    "printf 'protocol=https\\nhost=github.com\\n\\n' | git credential fill | sed -n 's/^password=//p'",
    shell=True, capture_output=True, text=True, check=True,
).stdout.strip()
if not TOKEN:
    sys.exit("没有拿到 token")

def git(*args, binary=False):
    out = subprocess.run(["git", "-c", "core.quotepath=false", *args], cwd=CWD, capture_output=True, check=True).stdout
    return out if binary else out.decode()

CURL_CFG = "/tmp/push_api.curlcfg"
subprocess.run(["bash", "-lc",
    "printf 'header = \"Authorization: Bearer %s\"\\n' \"$TOKEN\" > " + CURL_CFG + " && chmod 600 " + CURL_CFG],
    env={**os.environ, "TOKEN": TOKEN}, check=True)

def api(method, path, payload=None, retries=4):
    args = ["curl", "-sS", "-m", "90", "--retry", "2", "-X", method, API + path, "-K", CURL_CFG,
            "-H", "Accept: application/vnd.github+json", "-H", "Content-Type: application/json",
            "-H", "User-Agent: dsh-reading-push", "-w", "\\n%{http_code}"]
    if payload is not None:
        body_path = "/tmp/push_api.body.json"
        with open(body_path, "w") as fh:
            json.dump(payload, fh)
        args += ["--data-binary", "@" + body_path]
    last = ""
    for _ in range(retries):
        proc = subprocess.run(args, capture_output=True, text=True)
        if proc.returncode != 0:
            last = (proc.stderr or "").strip()
            continue
        out = proc.stdout
        code = out.rsplit("\n", 1)[-1].strip()
        body = out.rsplit("\n", 1)[0]
        if code.isdigit() and code.startswith("2"):
            return json.loads(body) if body.strip() else {}
        last = f"{code}: {body[:600]}"
        if code in ("401", "403", "404", "422"):
            break
    sys.exit(f"{method} {path} -> {last}")

remote = api("GET", f"/repos/{REPO}/git/ref/heads/{BRANCH}")
remote_sha = remote["object"]["sha"]
base_tree = api("GET", f"/repos/{REPO}/git/commits/{remote_sha}")["tree"]["sha"]
print(f"远端 {BRANCH} = {remote_sha[:7]}")

import os as _os
local_targets = [tuple(pair.split(":")) for pair in _os.environ.get("TARGETS", "b113450:5dcd167,ca39460:b113450").split(",") if pair]
for target, diff_base in local_targets:
    sha = git("rev-parse", target).strip()
    message = git("log", "-1", "--pretty=%B", sha).strip()
    changed = [line for line in git("diff", "--name-status", f"{diff_base}..{sha}").splitlines() if line.strip()]
    entries = []
    for line in changed:
        parts = line.split("\t")
        status, path = parts[0], parts[1]
        mode = git("ls-tree", sha, "--", path).split()[0] if status[0] != "D" else None
        if mode is None:
            entries.append({"path": path, "mode": "100644", "type": "blob", "sha": None})
            continue
        blob = git("show", f"{sha}:{path}", binary=True)
        created = api("POST", f"/repos/{REPO}/git/blobs",
                      {"content": blob.hex() if False else __import__("base64").b64encode(blob).decode(),
                       "encoding": "base64"})
        entries.append({"path": path, "mode": "100644", "type": "blob", "sha": created["sha"]})
    entries = [e for e in entries if e["sha"]]
    tree = api("POST", f"/repos/{REPO}/git/trees", {"base_tree": base_tree, "tree": entries})
    commit = api("POST", f"/repos/{REPO}/git/commits",
                 {"message": message, "tree": tree["sha"], "parents": [remote_sha]})
    remote_sha = commit["sha"]
    api("PATCH", f"/repos/{REPO}/git/refs/heads/{BRANCH}", {"sha": remote_sha, "force": False})
    print(f"推上 {target} -> {remote_sha[:7]}（{len(entries)} 个文件）: {message.splitlines()[0]}")

head = api("GET", f"/repos/{REPO}/commits/{BRANCH}")
print("远端 HEAD:", head["sha"][:7], head["commit"]["message"].splitlines()[0])
