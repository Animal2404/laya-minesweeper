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
# 本地 System One 决策模型（可选后端）
#
#   von        Von 1.1（395M，ModernBERT）   POST /v1/systemone   约 20ms
#   agentjev   AgentJev-0.6B（Qwen3 骨架）   POST /api/evaluate   约 1.2s
#
# 两者都与 Laya 一样：给 state + questions，直接返回概率分布，不生成文本。
# 通过环境变量配置地址；探不通就不注册该后端。
# ---------------------------------------------------------------------------
VON_URL = os.environ.get("VON_URL", "http://127.0.0.1:8150").rstrip("/")
AGENTJEV_URL = os.environ.get("AGENTJEV_URL", "http://127.0.0.1:8149").rstrip("/")


def _http_json(url: str, body: dict, timeout=120, tries=2):
    import ssl
    data = json.dumps(body, ensure_ascii=False).encode("utf-8")
    ctx = ssl.create_default_context()
    try:
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
    except Exception:
        pass
    last = None
    for i in range(tries):
        try:
            req = urllib.request.Request(url, data=data,
                                         headers={"Content-Type": "application/json"},
                                         method="POST")
            with urllib.request.urlopen(req, timeout=timeout, context=ctx) as r:
                return json.loads(r.read().decode("utf-8"))
        except Exception as e:
            last = e
            time.sleep(0.6 * (i + 1))
    raise RuntimeError("调用失败 %s: %s" % (url, last))


def _probe(url: str, path: str, timeout=3) -> bool:
    try:
        with urllib.request.urlopen(url + path, timeout=timeout) as r:
            return r.status == 200
    except Exception:
        return False


def predict_von(payload: dict) -> dict:
    """Von：协议与 TypeSafe /v1/systemone 一致。"""
    state = payload.get("state")
    questions = payload.get("questions")
    if state in (None, "", {}, []):
        raise ValueError("state 不能为空")
    if not isinstance(questions, dict) or not questions:
        raise ValueError("questions 必须是非空对象")
    t0 = time.perf_counter()
    res = _http_json(VON_URL + "/v1/systemone",
                     {"model": "von-1.1.0", "state": state, "questions": questions})
    ms = (time.perf_counter() - t0) * 1000
    ans = res.get("answers") or res.get("results") or {}
    return {"answers": _normalize_answers(ans, questions), "latency_ms": round(ms, 1),
            "device": "local", "routing": {"model": "von-1.1", "backend": "von"}}


def predict_agentjev(payload: dict) -> dict:
    """AgentJev：questions 是**数组**，选项放在 options 里。"""
    state = payload.get("state")
    questions = payload.get("questions")
    if state in (None, "", {}, []):
        raise ValueError("state 不能为空")
    if not isinstance(questions, dict) or not questions:
        raise ValueError("questions 必须是非空对象")

    qs = []
    for qid, q in questions.items():
        item = {"id": qid, "type": q.get("type", "choice"),
                "question": q.get("instructions") or q.get("question") or qid}
        if item["type"] == "choice":
            crit = q.get("criteria") or {}
            if isinstance(crit, dict):
                item["options"] = [{"id": str(k), "text": str(v)} for k, v in crit.items()]
            else:
                item["options"] = [{"id": str(i), "text": str(v)} for i, v in enumerate(crit)]
        elif item["type"] == "score":
            crit = q.get("criteria") or []
            item["options"] = [{"id": str(i), "text": str(v)} for i, v in enumerate(crit)]
        qs.append(item)

    t0 = time.perf_counter()
    res = _http_json(AGENTJEV_URL + "/api/evaluate", {"requests": [{"state": state, "questions": qs}]})
    ms = (time.perf_counter() - t0) * 1000

    # 归一化：把 distribution 的索引映射回 criteria 的键
    out = {}
    results = res.get("results") or []
    if results and isinstance(results[0], dict):
        for a in (results[0].get("answers") or []):
            qid = a.get("id")
            q = questions.get(qid, {})
            dist = a.get("distribution") or {}
            if q.get("type") == "noul":
                out[qid] = {"noul": float(a.get("top_probability", 0.5))}
            elif q.get("type") == "score":
                probs = {str(i): float(v) for i, v in dist.items()}
                out[qid] = {"probabilities": probs, "type": "score"}
            else:
                crit = q.get("criteria") or {}
                keys = list(crit.keys()) if isinstance(crit, dict) else list(range(len(crit or [])))
                probs = {}
                for idx, p in dist.items():
                    try:
                        k = keys[int(idx)]
                    except Exception:
                        k = str(idx)
                    probs[str(k)] = float(p)
                best = max(probs.items(), key=lambda kv: kv[1])[0] if probs else None
                out[qid] = {"choice": best, "confidence": max(probs.values()) if probs else 0.0,
                            "probabilities": probs}
    return {"answers": out, "latency_ms": round(ms, 1),
            "device": "local", "routing": {"model": "AgentJev-0.6B", "backend": "agentjev"}}


def _normalize_answers(ans, questions) -> dict:
    """把各后端的返回统一成 {qid: {choice|noul|probabilities}}。"""
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
    return out


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
    if want.startswith("von"):
        return predict_von(payload)
    if want.startswith("agentjev") or want.startswith("jev"):
        return predict_agentjev(payload)

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
            ms = [{"id": "laya", "label": "Laya（本地 GPU）",
                   "ready": STATUS.get("state") == "ready", "where": "本地"}]
            ms.append({"id": "von", "label": "Von 1.1（本地 395M，最快）",
                       "ready": _probe(VON_URL, "/health"), "where": "本地"})
            ms.append({"id": "agentjev", "label": "AgentJev-0.6B（本地）",
                       "ready": _probe(AGENTJEV_URL, "/health"), "where": "本地"})
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
