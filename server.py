#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
Laya Minesweeper — 本地服务

一个最小后端,只做两件事:
    GET  /              → 扫雷页面
    POST /api/predict   → 调 Laya 做一次判断

为什么需要后端
--------------
扫雷页面里「代码负责数学、Laya 负责判断」:约束求解在前端 JS 里跑,
只有需要"判断某格有没有雷"时才发一个请求。Laya 是 Python 库,
所以需要一个本地进程把它包成 HTTP。

设计取舍
--------
* 只用标准库(外加 laya 自身依赖),不引入 FastAPI/Flask —— 少一层依赖,
  克隆下来就能跑。
* 单进程单锁:一块 GPU 一次只能跑一个前向传播,并发调用只会互相拖慢。
* 绑定 127.0.0.1:只本机可访问,不暴露到局域网。
* 默认自动选设备(CUDA → MPS → CPU),也可 --device 强制。

用法
    python server.py                       # 默认端口 8080
    python server.py --port 9000
    python server.py --model multilingual  # 换 checkpoint
    python server.py --no-warmup           # 跳过预热
"""
from __future__ import annotations

import argparse
import json
import urllib.request
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

os.environ.setdefault("USE_TF", "0")
os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
os.environ.setdefault("HF_HUB_DISABLE_XET", "1")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

HERE = os.path.dirname(os.path.abspath(__file__))
INDEX = os.path.join(HERE, "static", "index.html")
MAX_BODY = 4 << 20          # 4 MB，扫雷一局最多 14 个问题，绰绰有余

# 全局状态:模型只加载一次
AGENT = None
AGENT_LOCK = threading.Lock()      # 保护加载
INFER_LOCK = threading.Lock()      # 串行化推理（一块 GPU 一次一个前向传播）
STATUS = {"state": "pending", "model": None, "device": None, "load_s": None, "error": None}


def log(msg):
    print(msg, flush=True)


def load_agent(model: str, device: str | None, subfolder: str | None):
    """加载 checkpoint。支持三种写法:
        --model english             → convaiinnovations/laya
        --model multilingual        → .../laya + subfolder=multilingual
        --model /path/to/dir        → 本地目录（离线）
        --model convaiinnovations/laya
    """
    import laya
    global AGENT
    with AGENT_LOCK:
        if AGENT is not None:
            return AGENT
        STATUS["state"] = "loading"
        t0 = time.time()
        try:
            if os.path.isdir(model):
                agent = laya.load(model, device=device, subfolder=subfolder)
            elif model in ("english", "multilingual", "typed-decisions"):
                if model == "english":
                    agent = laya.load("convaiinnovations/laya", device=device)
                else:
                    agent = laya.load("convaiinnovations/laya", device=device, subfolder=model)
            else:
                agent = laya.load(model, device=device, subfolder=subfolder)
            AGENT = agent
            STATUS.update(state="ready", model=model,
                          device=str(agent.device), load_s=round(time.time() - t0, 1))
            log("[laya] %s ready in %.1fs on %s" % (model, time.time() - t0, agent.device))
        except Exception as e:
            STATUS.update(state="error", error="%s: %s" % (type(e).__name__, e))
            raise
    return AGENT


def warmup():
    """首次调用会编译 kernel，慢好几倍。启动时先打一发，别让玩家等。"""
    try:
        agent = AGENT
        t0 = time.time()
        agent.predict({"board": "热身"},
                      {"w": {"type": "noul", "instructions": "这是一次预热调用吗？",
                             "criteria": {"true": "是", "false": "否"}}})
        log("[laya] warmup done in %.1fs" % (time.time() - t0))
    except Exception as e:
        log("[laya] warmup 失败（不影响使用）: %s" % e)


# ---------------------------------------------------------------------------
# Jev（System One 云端模型，可选）
#
# 与 Laya 一样是"结构化决策"模型：给一段 state + 若干问题，直接返回
# 概率/置信度，不生成文本。通过环境变量配置，未配置时该项在界面上不可选。
#   JEV_API_KEY   必填，没有就不注册这个后端
#   JEV_BASE_URL  默认 https://omnilabs.vibeadmin.cn/v1
#   JEV_MODEL     默认 jev-latest
# ---------------------------------------------------------------------------
JEV_KEY = os.environ.get("JEV_API_KEY", "").strip()
JEV_BASE = os.environ.get("JEV_BASE_URL", "https://omnilabs.vibeadmin.cn/v1").rstrip("/")
JEV_MODEL = os.environ.get("JEV_MODEL", "jev-latest")


def _jev_post(path: str, body: dict, timeout=90):
    """调 Jev。网络不稳，带重试。"""
    import ssl
    ctx = ssl.create_default_context()
    try:
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
    except Exception:
        pass
    data = json.dumps(body, ensure_ascii=False).encode("utf-8")
    last = None
    for i in range(3):
        try:
            req = urllib.request.Request(
                JEV_BASE + path, data=data,
                headers={"Authorization": "Bearer " + JEV_KEY,
                         "Content-Type": "application/json"},
                method="POST")
            with urllib.request.urlopen(req, timeout=timeout, context=ctx) as r:
                return json.loads(r.read().decode("utf-8"))
        except Exception as e:
            last = e
            time.sleep(1.5 * (i + 1))
    raise RuntimeError("Jev 调用失败: %s" % last)


def predict_jev(payload: dict) -> dict:
    """把同样的 state/questions 转发给 Jev，并归一化成与 Laya 一致的返回结构。"""
    if not JEV_KEY:
        raise RuntimeError("未配置 JEV_API_KEY")
    state = payload.get("state")
    questions = payload.get("questions")
    if state in (None, "", {}, []):
        raise ValueError("state 不能为空")
    if not isinstance(questions, dict) or not questions:
        raise ValueError("questions 必须是非空对象")

    t0 = time.perf_counter()
    # Jev 的 System One 端点：POST /v1/systemone
    body = {"model": JEV_MODEL, "state": state, "questions": questions}
    try:
        res = _jev_post("/systemone", body)
    except Exception:
        # 端点名可能不同，退回 chat/completions（让服务端自己解析结构化问题）
        res = _jev_post("/chat/completions", {
            "model": JEV_MODEL,
            "messages": [{"role": "user", "content":
                          json.dumps({"state": state, "questions": questions},
                                     ensure_ascii=False)}],
            "response_format": {"type": "json_object"},
        })
    ms = (time.perf_counter() - t0) * 1000

    # 归一化：接受 {answers:{...}} / {choices:{...}} / 直接 {qid:...} 三种形态
    ans = res.get("answers") or res.get("choices") or res
    if isinstance(ans, list):                       # OpenAI 风格
        try:
            ans = json.loads(ans[0]["message"]["content"])
            ans = ans.get("answers") or ans
        except Exception:
            ans = {}
    out = {}
    for qid, q in questions.items():
        a = ans.get(qid) if isinstance(ans, dict) else None
        if isinstance(a, dict):
            out[qid] = a
        elif isinstance(a, (int, float)) and q.get("type") == "noul":
            out[qid] = {"noul": float(a)}
        elif isinstance(a, str) and q.get("type") == "choice":
            out[qid] = {"choice": a, "confidence": 1.0}
        else:
            out[qid] = {"noul": 0.5} if q.get("type") == "noul" else {"choice": None}
    return {"answers": out, "latency_ms": round(ms, 1),
            "device": "cloud", "routing": {"model": JEV_MODEL, "backend": "jev"}}


def predict(payload: dict) -> dict:
    state = payload.get("state")
    questions = payload.get("questions")
    if state in (None, "", {}, []):
        raise ValueError("state 不能为空")
    if not isinstance(questions, dict) or not questions:
        raise ValueError("questions 必须是非空对象")
    if len(json.dumps(questions, ensure_ascii=False)) > 200000:
        raise ValueError("questions 太大")

    want = str(payload.get("backend") or payload.get("model") or "").lower()
    if want in ("jev", "jev-latest") or want.startswith("jev"):
        return predict_jev(payload)

    agent = AGENT
    if agent is None:
        if STATUS["state"] == "error":
            raise RuntimeError("模型加载失败: %s" % STATUS["error"])
        raise RuntimeError("模型尚未就绪 (state=%s)" % STATUS["state"])

    # 一次前向传播回答全部问题 —— 这也是扫雷会把 14 个格子合并成一个请求的原因
    with INFER_LOCK:
        t0 = time.perf_counter()
        result = agent.system_one(state, questions)
        ms = (time.perf_counter() - t0) * 1000

    result["latency_ms"] = round(ms, 1)
    result["device"] = str(agent.device)
    result["routing"] = {"model": STATUS["model"]}
    return result


class Handler(BaseHTTPRequestHandler):
    server_version = "laya-minesweeper"
    protocol_version = "HTTP/1.1"       # keep-alive:一局游戏会连发几十个请求

    # ---------- 工具 ----------
    def _send(self, code, obj, ctype="application/json; charset=utf-8"):
        if isinstance(obj, (dict, list)):
            body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        elif isinstance(obj, str):
            body = obj.encode("utf-8")
        else:
            body = obj
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _host_ok(self):
        """只接受本机来源，避免被同网段的其他机器当免费推理服务用。"""
        host = (self.headers.get("Host") or "").split(":")[0]
        return host in ("127.0.0.1", "localhost", "::1", "")

    def log_message(self, fmt, *args):
        pass                             # 保持输出干净

    # ---------- 路由 ----------
    def do_GET(self):
        path = self.path.split("?")[0]
        if path in ("/", "/index.html"):
            try:
                with open(INDEX, "rb") as f:
                    return self._send(200, f.read(), "text/html; charset=utf-8")
            except FileNotFoundError:
                return self._send(500, {"error": "static/index.html 缺失"})
        if path == "/api/health":
            return self._send(200, STATUS)
        if path == "/api/models":
            ms = [{"id": "laya", "label": "Laya（本地 %s）" % STATUS.get("model", ""),
                   "ready": STATUS.get("state") == "ready", "where": "本地 GPU"}]
            ms.append({"id": "jev", "label": "Jev（云端 %s）" % JEV_MODEL,
                       "ready": bool(JEV_KEY), "where": "云端",
                       "hint": "" if JEV_KEY else "未配置 JEV_API_KEY"})
            return self._send(200, {"models": ms, "default": "laya"})
        return self._send(404, {"error": "not found"})

    def do_POST(self):
        if not self._host_ok():
            return self._send(403, {"error": "只允许本机访问"})
        if self.path.split("?")[0] != "/api/predict":
            return self._send(404, {"error": "not found"})
        try:
            n = int(self.headers.get("Content-Length") or 0)
            if n <= 0 or n > MAX_BODY:
                raise ValueError("body 长度不合法")
            payload = json.loads(self.rfile.read(n).decode("utf-8"))
            return self._send(200, predict(payload))
        except ValueError as e:
            return self._send(400, {"error": str(e)})
        except Exception as e:
            import traceback
            traceback.print_exc()
            return self._send(500, {"error": "%s: %s" % (type(e).__name__, e)})


def main():
    ap = argparse.ArgumentParser(description="Laya Minesweeper 本地服务")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=int(os.environ.get("PORT", "8080")))
    ap.add_argument("--model", default=os.environ.get("LAYA_MODEL", "english"),
                    help="english / multilingual / typed-decisions / HF repo / 本地目录")
    ap.add_argument("--device", default=os.environ.get("LAYA_DEVICE") or None)
    ap.add_argument("--subfolder", default=None, help="若 --model 是仓库且要指定子目录")
    ap.add_argument("--no-warmup", action="store_true")
    ap.add_argument("--check", action="store_true", help="只加载模型做自检,不启服务")
    args = ap.parse_args()

    log("Laya Minesweeper")
    log("  模型     : %s" % args.model)
    log("  设备     : %s" % (args.device or "自动 (cuda → mps → cpu)"))

    try:
        load_agent(args.model, args.device, args.subfolder)
    except Exception as e:
        log("[错误] 模型加载失败: %s" % e)
        return 2

    if not args.no_warmup:
        warmup()

    if args.check:
        log("[自检] 模型可用,device=%s" % STATUS["device"])
        return 0

    log("  打开页面 : http://%s:%d/" % (args.host, args.port))
    log("  健康检查 : http://%s:%d/api/health" % (args.host, args.port))
    log("  Ctrl+C 停止")
    try:
        ThreadingHTTPServer((args.host, args.port), Handler).serve_forever()
    except KeyboardInterrupt:
        log("\n已停止")
    return 0


if __name__ == "__main__":
    sys.exit(main())
