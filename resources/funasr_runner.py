#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""FunASR 本地转写 runner（LiveReview 内置）。

用法：
    python funasr_runner.py --input a.wav --output a --format srt --language zh

输入：16k 单声道 wav（调用方已用 ffmpeg 抽好）
输出：<output>.srt / .txt / .vtt / .json

约定：stdout 里形如 "PROGRESS 42%" 的行会被主程序解析成进度。
所有日志走 stdout，错误以非 0 退出码返回。
"""

import argparse
import json
import os
import sys


def log(msg: str) -> None:
    print(msg, flush=True)


def ts_srt(ms: int) -> str:
    ms = max(0, int(ms))
    h, ms = divmod(ms, 3600000)
    m, ms = divmod(ms, 60000)
    s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def ts_vtt(ms: int) -> str:
    return ts_srt(ms).replace(",", ".")


def normalise_segments(res) -> list:
    """把 FunASR 的返回统一成 [{start_ms, end_ms, text}]"""
    segs = []
    if not res:
        return segs
    first = res[0] if isinstance(res, list) else res

    raw = first.get("sentence_info") if isinstance(first, dict) else None
    if raw:
        for s in raw:
            text = (s.get("text") or "").strip()
            if not text:
                continue
            start = s.get("start", 0)
            end = s.get("end", 0)
            # 某些版本给的是帧号（远大于时长），做一次粗校正
            if end and end > 10_000_000:
                start, end = start / 16.0, end / 16.0
            segs.append({"start_ms": int(start), "end_ms": int(end), "text": text})
        return segs

    text = ""
    if isinstance(first, dict):
        text = (first.get("text") or "").strip()
    if text:
        segs.append({"start_ms": 0, "end_ms": 0, "text": text})
    return segs


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True, help="16k 单声道 wav")
    ap.add_argument("--output", required=True, help="输出前缀（不含扩展名）")
    ap.add_argument("--format", default="srt", choices=["srt", "txt", "vtt", "json"])
    ap.add_argument("--language", default="zh")
    ap.add_argument("--model", default="", help="模型名或本地路径，默认 paraformer-zh")
    ap.add_argument("--model-root", dest="model_root", default="", help="模型缓存目录")
    args = ap.parse_args()

    if not os.path.exists(args.input):
        log("ERR 找不到输入文件：" + args.input)
        return 3

    try:
        from funasr import AutoModel
    except Exception as e:  # noqa: BLE001
        log("ERR 未安装 funasr：" + str(e))
        log("ERR 请执行：pip install -U funasr modelscope")
        return 2

    if args.model_root:
        os.environ.setdefault("MODELSCOPE_CACHE", args.model_root)

    model_name = args.model or "paraformer-zh"
    log("PROGRESS 5% 正在加载模型 " + model_name)

    model = None
    try:
        model = AutoModel(
            model=model_name,
            vad_model="fsmn-vad",
            punc_model="ct-punc",
            disable_update=True,
        )
    except Exception as e:  # noqa: BLE001
        log("WARN 带 VAD/标点模型加载失败，退回纯 ASR：" + str(e))
        try:
            model = AutoModel(model=model_name, disable_update=True)
        except Exception as e2:  # noqa: BLE001
            log("ERR 模型加载失败：" + str(e2))
            return 4

    log("PROGRESS 20% 开始识别（本地推理，请耐心等待）")
    try:
        res = model.generate(input=args.input, batch_size_s=300, sentence_timestamp=True)
    except Exception as e:  # noqa: BLE001
        log("WARN sentence_timestamp 不被支持，改用普通模式：" + str(e))
        try:
            res = model.generate(input=args.input, batch_size_s=300)
        except Exception as e2:  # noqa: BLE001
            log("ERR 识别失败：" + str(e2))
            return 5

    log("PROGRESS 85% 整理结果")
    segs = normalise_segments(res)
    if not segs:
        log("ERR 未识别到任何文本")
        return 6

    out = args.output
    fmt = args.format

    if fmt == "json":
        with open(out + ".json", "w", encoding="utf-8") as f:
            json.dump(
                {
                    "input": args.input,
                    "model": model_name,
                    "language": args.language,
                    "segments": segs,
                    "text": "".join(s["text"] for s in segs),
                },
                f,
                ensure_ascii=False,
                indent=2,
            )
    elif fmt == "txt":
        with open(out + ".txt", "w", encoding="utf-8") as f:
            for i, s in enumerate(segs, 1):
                f.write(s["text"] + "\n")
    elif fmt == "vtt":
        with open(out + ".vtt", "w", encoding="utf-8") as f:
            f.write("WEBVTT\n\n")
            for i, s in enumerate(segs, 1):
                f.write(f"{i}\n{ts_vtt(s['start_ms'])} --> {ts_vtt(s['end_ms'] or s['start_ms'] + 3000)}\n{s['text']}\n\n")
    else:  # srt
        with open(out + ".srt", "w", encoding="utf-8") as f:
            for i, s in enumerate(segs, 1):
                f.write(
                    f"{i}\n{ts_srt(s['start_ms'])} --> {ts_srt(s['end_ms'] or s['start_ms'] + 3000)}\n{s['text']}\n\n"
                )

    log("PROGRESS 100% 完成，输出 " + out + "." + fmt)
    return 0


if __name__ == "__main__":
    sys.exit(main())
