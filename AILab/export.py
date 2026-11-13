"""Export tarteel-ai/whisper-base-ar-quran to ONNX with decoder cross-attentions (for word timestamps)."""
from optimum.exporters.onnx import main_export
from optimum.exporters.onnx.model_configs import WhisperOnnxConfig
from optimum.exporters.onnx.base import ConfigBehavior

_orig = WhisperOnnxConfig.outputs.fget
def outputs(self):
    out = _orig(self)
    if self._behavior is ConfigBehavior.DECODER:
        n = self._config.decoder_layers
        for i in range(n):
            out[f"cross_attentions.{i}"] = {0: "batch_size", 2: "decoder_sequence_length", 3: "encoder_sequence_length"}
    return out
WhisperOnnxConfig.outputs = property(outputs)

main_export("tarteel-ai/whisper-base-ar-quran", output="export-fp32",
    task="automatic-speech-recognition-with-past", opset=18, do_validation=False,
    model_kwargs={"output_attentions": True}, library_name="transformers")
