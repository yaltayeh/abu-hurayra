"""int8 dynamic quantization. Decoders are quantized separately (quantize_dynamic skips If-subgraphs) then merged."""
import os, sys
from onnxruntime.quantization import quantize_dynamic, QuantType
from optimum.onnx.graph_transformations import merge_decoders
out = sys.argv[1] if len(sys.argv) > 1 else "out/onnx"
per_channel = (sys.argv[2] == "pc") if len(sys.argv) > 2 else True
wt = QuantType.QInt8 if (len(sys.argv) > 3 and sys.argv[3] == "s8") else QuantType.QUInt8
os.makedirs("tmp", exist_ok=True); os.makedirs(out, exist_ok=True)
for name in ["encoder_model", "decoder_model", "decoder_with_past_model"]:
    dst = f"{out}/encoder_model_quantized.onnx" if name == "encoder_model" else f"tmp/{name}_quantized.onnx"
    quantize_dynamic(f"export-fp32/{name}.onnx", dst, weight_type=wt, per_channel=per_channel)
merge_decoders("tmp/decoder_model_quantized.onnx", "tmp/decoder_with_past_model_quantized.onnx",
               save_path=f"{out}/decoder_model_merged_quantized.onnx", strict=False)
