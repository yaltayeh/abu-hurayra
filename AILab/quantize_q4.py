"""4-bit weight-only quantization (MatMulNBits + GatherBlockQuantized), block size 32, symmetric."""
import os, sys, numpy as np, onnx
from onnx import numpy_helper
from onnxruntime.quantization.matmul_nbits_quantizer import MatMulNBitsQuantizer, DefaultWeightOnlyQuantConfig
from optimum.onnx.graph_transformations import merge_decoders

out = sys.argv[1] if len(sys.argv) > 1 else "out-q4/onnx"
sym = (sys.argv[2] != "asym") if len(sys.argv) > 2 else True
os.makedirs("tmp", exist_ok=True); os.makedirs(out, exist_ok=True)
E = "model.decoder.embed_tokens.weight"

def prep_unshare(src, dst):
    """Give the logits MatMul its own initializer (the quantizer only handles constant B inputs)."""
    m = onnx.load(src); g = m.graph
    emb = next(i for i in g.initializer if i.name == E)
    t = next(n for n in g.node if n.op_type == "Transpose" and n.input[0] == E)
    g.initializer.append(numpy_helper.from_array(np.ascontiguousarray(numpy_helper.to_array(emb).T), t.output[0]))
    g.node.remove(t)
    onnx.save(m, dst)

def q4(src, dst):
    m = onnx.load(src)
    cfg = DefaultWeightOnlyQuantConfig(block_size=32, is_symmetric=sym, bits=4, op_types_to_quantize=("MatMul", "Gather"))
    qz = MatMulNBitsQuantizer(m, algo_config=cfg)
    qz.process()
    qz.model.save_model_to_file(dst, False)

for name in ["encoder_model", "decoder_model", "decoder_with_past_model"]:
    src = f"export-fp32/{name}.onnx"
    if name != "encoder_model":
        prep_unshare(src, f"tmp/prep_{name}.onnx"); src = f"tmp/prep_{name}.onnx"
    dst = f"{out}/encoder_model_q4.onnx" if name == "encoder_model" else f"tmp/{name}_q4.onnx"
    q4(src, dst)
merge_decoders("tmp/decoder_model_q4.onnx", "tmp/decoder_with_past_model_q4.onnx",
               save_path=f"{out}/decoder_model_merged_q4.onnx", strict=False)
