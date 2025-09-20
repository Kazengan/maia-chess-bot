#!/usr/bin/env python3
"""
Convert Maia2 PyTorch model to ONNX format with quantization for browser deployment.
"""

import torch
import torch.nn as nn
from maia2 import model, inference
import onnx
import onnxruntime as ort
from onnxruntime.quantization import quantize_dynamic, QuantType
import numpy as np
import os
from typing import Tuple, Dict, Any

def create_dummy_input() -> Tuple[torch.Tensor, torch.Tensor, torch.Tensor]:
    """Create dummy input for model export."""
    # Create dummy FEN input (simplified board representation)
    # This should match the expected input format for Maia2
    batch_size = 1
    # Board representation (18 channels: 12 for pieces, 6 for additional info)
    board_input = torch.randn(batch_size, 18, 8, 8)
    
    # ELO inputs - need to be 1D tensor of bucket indices (0-10) for embedding layer
    # Based on model analysis, ELO is mapped to buckets 0-10
    elo_self = torch.tensor([5], dtype=torch.long)  # Middle bucket (1100-1300)
    elo_oppo = torch.tensor([5], dtype=torch.long)  # Middle bucket (1100-1300)
    return board_input, elo_self, elo_oppo

def export_to_onnx(model: nn.Module, output_path: str) -> None:
    """Export PyTorch model to ONNX format."""
    print(f"Exporting model to ONNX: {output_path}")
    
    # Create dummy input
    board_input, elo_self, elo_oppo = create_dummy_input()
    
    # Set model to evaluation mode
    model.eval()
    
    # Export to ONNX
    torch.onnx.export(
        model,
        (board_input, elo_self, elo_oppo),
        output_path,
        export_params=True,
        opset_version=14,
        do_constant_folding=True,
        input_names=['board_input', 'elo_self', 'elo_oppo'],
        output_names=['move_probs', 'win_prob'],
        dynamic_axes={
            'board_input': {0: 'batch_size'},
            'elo_self': {0: 'batch_size'},
            'elo_oppo': {0: 'batch_size'},
            'move_probs': {0: 'batch_size'},
            'win_prob': {0: 'batch_size'}
        }
    )
    
    print(f"Model exported to: {output_path}")
    
    # Verify the exported model
    verify_onnx_model(output_path)

def verify_onnx_model(onnx_path: str) -> None:
    """Verify the exported ONNX model."""
    print("Verifying ONNX model...")
    
    # Load the ONNX model
    onnx_model = onnx.load(onnx_path)
    onnx.checker.check_model(onnx_model)
    
    print("ONNX model verification completed successfully!")

def quantize_onnx_model(input_path: str, output_path: str) -> None:
    """Apply dynamic quantization to ONNX model."""
    print(f"Applying dynamic quantization to: {input_path}")
    print(f"Output will be saved to: {output_path}")
    
    # Apply dynamic quantization
    quantize_dynamic(
        model_input=input_path,
        model_output=output_path,
        op_types_to_quantize=['MatMul', 'Gemm'],  # Only quantize linear layers
        weight_type=QuantType.QInt8  # Use 8-bit integer quantization
    )
    
    print(f"Quantized model saved to: {output_path}")
    
    # Compare model sizes
    original_size = os.path.getsize(input_path) / 1024 / 1024  # MB
    quantized_size = os.path.getsize(output_path) / 1024 / 1024  # MB
    
    print(f"Original model size: {original_size:.2f} MB")
    print(f"Quantized model size: {quantized_size:.2f} MB")
    print(f"Size reduction: {((original_size - quantized_size) / original_size * 100):.1f}%")

def test_onnx_inference(onnx_path: str) -> None:
    """Test ONNX model inference."""
    print("Testing ONNX model inference...")
    
    # Create ONNX Runtime session
    ort_session = ort.InferenceSession(onnx_path)
    
    # Create dummy input
    board_input, elo_self, elo_oppo = create_dummy_input()
    
    # Convert to numpy arrays
    board_np = board_input.numpy()
    elo_self_np = elo_self.numpy()  # Already Long type
    elo_oppo_np = elo_oppo.numpy()  # Already Long type
    
    # Run inference
    inputs = {
        'board_input': board_np,
        'elo_self': elo_self_np,
        'elo_oppo': elo_oppo_np
    }
    
    outputs = ort_session.run(None, inputs)
    
    print(f"Output shape: {[output.shape for output in outputs]}")
    print(f"Move probabilities range: [{outputs[0].min():.4f}, {outputs[0].max():.4f}]")
    print(f"Win probability: {outputs[1][0][0]:.4f}")
    print("ONNX inference test completed successfully!")

def main():
    """Main conversion pipeline."""
    print("=" * 60)
    print("Maia2 Model Conversion Pipeline")
    print("=" * 60)
    
    # Paths
    original_model_path = "maia2_models/rapid_model.pt"
    onnx_path = "maia2_models/rapid_model.onnx"
    quantized_onnx_path = "maia2_models/rapid_model_quantized.onnx"
    
    # Step 1: Load original Maia2 model
    print("\n1. Loading original Maia2 model...")
    maia_model = model.from_pretrained(type="rapid", device="cpu")
    print(f"Model loaded successfully with {sum(p.numel() for p in maia_model.parameters()):,} parameters")
    
    # Step 2: Export to ONNX
    print("\n2. Exporting to ONNX format...")
    export_to_onnx(maia_model, onnx_path)
    
    # Step 3: Apply quantization
    print("\n3. Applying dynamic quantization...")
    quantize_onnx_model(onnx_path, quantized_onnx_path)
    
    # Step 4: Test quantized model
    print("\n4. Testing quantized model inference...")
    test_onnx_inference(quantized_onnx_path)
    
    print("\n" + "=" * 60)
    print("Model conversion completed successfully!")
    print(f"Original model: {original_model_path}")
    print(f"ONNX model: {onnx_path}")
    print(f"Quantized ONNX model: {quantized_onnx_path}")
    print("=" * 60)

if __name__ == "__main__":
    main()