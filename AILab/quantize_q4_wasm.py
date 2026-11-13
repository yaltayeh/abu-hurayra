"""4-bit variant that runs on onnxruntime-web WASM: MatMulNBits (4-bit, block 32, symmetric) for every MatMul incl. the
logits projection, and the token embedding kept as per-row symmetric int8 (Gather + Cast + Mul, standard ops only).
No GatherBlockQuantized (it has no WASM kernel). Output: decoder_model_merged_bnb4.onnx (the encoder is shared with q4)."""
import os, sys, numpy as np, onnx
from onnx import numpy_helper, helper, TensorProto
from onnxruntime.quantization.matmul_nbits_quantizer import MatMulNBitsQuantizer, DefaultWeightOnlyQuantConfig
from optimum.onnx.graph_transformations import merge_decoders

out = sys.argv[1] if len(sys.argv) > 1 else "out-q4w/onnx"
os.makedirs("tmp", exist_ok=True); os.makedirs(out, exist_ok=True)
E = "model.decoder.embed_tokens.weight"

def prep_unshare(src, dst):
    m = onnx.load(src); g = m.graph
    emb = next(i for i in g.initializer if i.name == E)
    t = next(n for n in g.node if n.op_type == "Transpose" and n.input[0] == E)
    g.initializer.append(numpy_helper.from_array(np.ascontiguousarray(numpy_helper.to_array(emb).T), t.output[0]))
    g.node.remove(t)
    onnx.save(m, dst)

def q4_matmuls(src, dst):
    m = onnx.load(src)
    cfg = DefaultWeightOnlyQuantConfig(block_size=32, is_symmetric=True, bits=4, op_types_to_quantize=("MatMul",))
    qz = MatMulNBitsQuantizer(m, algo_config=cfg); qz.process()
    qz.model.save_model_to_file(dst, False)

def int8_embedding(path):
    m = onnx.load(path); g = m.graph
    emb = next(i for i in g.initializer if i.name == E)
    W = numpy_helper.to_array(emb)
    scale = (np.maximum(np.abs(W).max(axis=1), 1e-8) / 127.0).astype(np.float32)
    Wq = np.clip(np.round(W / scale[:, None]), -127, 127).astype(np.int8)
    keep = [i for i in g.initializer if i.name != E]; del g.initializer[:]; g.initializer.extend(keep)
    g.initializer.append(numpy_helper.from_array(Wq, E + "_int8"))
    g.initializer.append(numpy_helper.from_array(scale, E + "_row_scale"))
    g.initializer.append(numpy_helper.from_array(np.array([-1], dtype=np.int64), E + "_unsq"))
    nodes = []
    for n in g.node:
        if n.op_type == "Gather" and n.input[0] == E:
            ids, out_name = n.input[1], n.output[0]
            nodes += [
                helper.make_node("Gather", [E + "_int8", ids], [out_name + "_q"], axis=0, name=n.name + "_q"),
                helper.make_node("Cast", [out_name + "_q"], [out_name + "_f"], to=TensorProto.FLOAT, name=n.name + "_cast"),
                helper.make_node("Gather", [E + "_row_scale", ids], [out_name + "_s"], axis=0, name=n.name + "_gs"),
                helper.make_node("Unsqueeze", [out_name + "_s", E + "_unsq"], [out_name + "_su"], name=n.name + "_unsq"),
                helper.make_node("Mul", [out_name + "_f", out_name + "_su"], [out_name], name=n.name + "_mul"),
            ]
        else:
            nodes.append(n)
    del g.node[:]; g.node.extend(nodes)
    assert not any(n.op_type == "Gather" and n.input[0] == E for n in g.node)
    onnx.checker.check_model(m)
    onnx.save(m, path)

for name in ["decoder_model", "decoder_with_past_model"]:
    prep_unshare(f"export-fp32/{name}.onnx", f"tmp/prep_{name}.onnx")
    q4_matmuls(f"tmp/prep_{name}.onnx", f"tmp/{name}_q4w.onnx")
    int8_embedding(f"tmp/{name}_q4w.onnx")
merge_decoders("tmp/decoder_model_q4w.onnx", "tmp/decoder_with_past_model_q4w.onnx", save_path=f"{out}/decoder_model_merged_bnb4.onnx", strict=False)
