#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""下载 FunASR 中文转写所需模型（LiveReview 内置）。

用法：
    python funasr_download_models.py [模型根目录]

默认模型组：Paraformer 中文 ASR + FSMN-VAD + CT-Transformer 标点。
全部从 ModelScope 拉取，不走国外源。
"""

import os
import sys


MODELS = [
    "iic/speech_seaco_paraformer_large_asr_nat-zh-cn-16k-common-vocab8404-pytorch",
    "iic/speech_fsmn_vad_zh-cn-16k-common-pytorch",
    "iic/punc_ct-transformer_zh-cn-common-vocab272727-pytorch",
]

FALLBACKS = {
    MODELS[0]: [
        "iic/speech_paraformer-large_asr_nat-zh-cn-16k-common-vocab8404-pytorch",
    ]
}


def main() -> int:
    root = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
        os.path.expanduser("~"), ".cache", "modelscope", "hub"
    )
    root = os.path.abspath(root)
    os.makedirs(root, exist_ok=True)
    os.environ["MODELSCOPE_CACHE"] = root
    print(f"模型根目录：{root}", flush=True)

    try:
        from modelscope import snapshot_download
    except Exception as e:  # noqa: BLE001
        print("ERR 未安装 modelscope：" + str(e), flush=True)
        print("ERR 请执行：pip install -U modelscope", flush=True)
        return 2

    failed = []
    for model in MODELS:
        names = [model] + FALLBACKS.get(model, [])
        ok = False
        for name in names:
            print(f"下载 {name} …", flush=True)
            try:
                path = snapshot_download(name, cache_dir=root)
                print(f"OK {name} -> {path}", flush=True)
                ok = True
                break
            except Exception as e:  # noqa: BLE001
                print(f"WARN {name} 失败：{e}", flush=True)
        if not ok:
            failed.append(model)

    if failed:
        print("ERR 以下模型未能下载：" + ", ".join(failed), flush=True)
        return 3

    print("DONE 全部模型已就绪", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
