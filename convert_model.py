#!/usr/bin/env python3
"""Export Maia2 PyTorch checkpoints to ONNX with optional quantisation.

This script keeps the conversion as faithful as possible by:
  * reusing the original preprocessing utilities (board_to_tensor,
    map_to_category) so the exported graph sees the exact tensor format
    used during training/inference;
  * running an ONNX Runtime side-by-side check against the PyTorch
    model on a representative FEN set to make sure numerical drift is
    negligible;
  * supporting an optional quantisation step that can be skipped if it
    hurts accuracy.

The default export produces `maia2_models/rapid_model.onnx`.  Invoke
`--quantize` to additionally create `rapid_model_quantized.onnx` after
verifying accuracy.
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
from typing import Iterable, Tuple

import chess
import numpy as np
import onnx
import onnxruntime as ort
import torch
from onnxruntime.quantization import QuantFormat, QuantType, quantize_dynamic

from maia2 import model as maia_model_lib
from maia2.utils import (
    board_to_tensor,
    create_elo_dict,
    map_to_category,
)

# Representative positions covering different game phases so the export
# is traced with meaningful data. Feel free to extend.
REPRESENTATIVE_FENS = [
    "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
    "r1bqkbnr/pppp1ppp/2n5/4p3/1bP5/2N2N2/PP1PPPPP/R1BQKB1R w KQkq - 0 4",
    "r2q1rk1/pp1n1pbp/2pp1np1/4p3/2P1P3/1P1PBN2/PBQN1PPP/R3K2R w KQ - 4 10",
    "8/8/8/2k5/8/8/5PPP/4K2R w K - 1 40",
]


def _prepare_inputs(fens: Iterable[str], elo: int) -> Tuple[torch.Tensor, torch.Tensor, torch.Tensor]:
    """Convert FENs to tensors consistent with training preprocessing."""
    elo_dict = create_elo_dict()
    elo_bucket = map_to_category(elo, elo_dict)

    boards = []
    for fen in fens:
        board = chess.Board(fen)
        tensor = board_to_tensor(board)  # (18, 8, 8)
        boards.append(tensor)
    boards_tensor = torch.stack(boards, dim=0).to(torch.float32)

    batch = boards_tensor.shape[0]
    elo_tensor = torch.full((batch,), elo_bucket, dtype=torch.long)
    return boards_tensor, elo_tensor.clone(), elo_tensor.clone()


def export_onnx_model(
    model: torch.nn.Module,
    output_path: Path,
    sample_fens: Iterable[str],
    sample_elo: int,
    opset: int = 17,
) -> None:
    output_path = output_path.resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)

    boards, elos_self, elos_oppo = _prepare_inputs(sample_fens, sample_elo)

    model_cpu = model.cpu().eval()
    with torch.no_grad():
        torch.onnx.export(
            model_cpu,
            (boards, elos_self, elos_oppo),
            str(output_path),
            input_names=["board_input", "elo_self", "elo_oppo"],
            output_names=["move_probs", "side_info_logits", "win_prob"],
            dynamic_axes={
                "board_input": {0: "batch"},
                "elo_self": {0: "batch"},
                "elo_oppo": {0: "batch"},
                "move_probs": {0: "batch"},
                "side_info_logits": {0: "batch"},
                "win_logits": {0: "batch"},
            },
            opset_version=opset,
            do_constant_folding=True,
        )

    print(f"Exported ONNX model to {output_path}")

    # Basic structural check
    onnx_model = onnx.load(str(output_path))
    onnx.checker.check_model(onnx_model)
    print("ONNX model structure validated.")


def _run_torch(model: torch.nn.Module, boards, elos_self, elos_oppo):
    model.eval()
    with torch.no_grad():
        return model(boards, elos_self, elos_oppo)


def _run_onnx(session: ort.InferenceSession, boards, elos_self, elos_oppo):
    inputs = {
        "board_input": boards.cpu().numpy(),
        "elo_self": elos_self.cpu().numpy(),
        "elo_oppo": elos_oppo.cpu().numpy(),
    }
    return session.run(None, inputs)


def verify_against_pytorch(
    model: torch.nn.Module,
    onnx_path: Path,
    fens: Iterable[str],
    elo: int,
    atol: float = 1e-4,
) -> None:
    boards, elos_self, elos_oppo = _prepare_inputs(fens, elo)

    torch_logits = _run_torch(model, boards, elos_self, elos_oppo)
    ort_sess = ort.InferenceSession(str(onnx_path))
    ort_logits = _run_onnx(ort_sess, boards, elos_self, elos_oppo)

    names = ["move_probs", "side_info_logits", "win_prob"]
    for name, torch_out, ort_out in zip(names, torch_logits, ort_logits):
        diff = np.max(np.abs(torch_out.cpu().numpy() - ort_out))
        print(f"Δ({name}) = {diff:.6f}")
        if diff > atol:
            raise RuntimeError(
                f"ONNX output '{name}' deviates from PyTorch by {diff:.6f}, "
                f"which is above tolerance {atol}."
            )
    print("Numerical parity check passed.")


def maybe_quantize(onnx_path: Path, output_path: Path) -> None:
    print(f"Quantising {onnx_path} → {output_path} (dynamic INT8 on linear ops)…")
    quantize_dynamic(
        model_input=str(onnx_path),
        model_output=str(output_path),
        op_types_to_quantize=["MatMul", "Gemm"],
        weight_type=QuantType.QInt8,
        optimize_model=True,
        per_channel=False,
        reduce_range=False,
        quant_format=QuantFormat.QDQ,
    )
    orig_size = onnx_path.stat().st_size / (1024 * 1024)
    quant_size = output_path.stat().st_size / (1024 * 1024)
    print(f"  size: {orig_size:.2f} MiB → {quant_size:.2f} MiB")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--output",
        default="maia2_models/rapid_model.onnx",
        type=Path,
        help="Path to save the exported ONNX model",
    )
    parser.add_argument(
        "--quantize",
        action="store_true",
        help="Also produce a dynamically quantised model",
    )
    parser.add_argument(
        "--quantized-output",
        default="maia2_models/rapid_model_quantized.onnx",
        type=Path,
        help="Target path for the quantised model (if --quantize)",
    )
    parser.add_argument(
        "--opset",
        type=int,
        default=17,
        help="ONNX opset version to use",
    )
    parser.add_argument(
        "--verification-elo",
        type=int,
        default=1500,
        help="ELO bucket to use for parity checks",
    )
    parser.add_argument(
        "--fens",
        type=str,
        default=None,
        help="Optional JSON/line-delimited file with extra FENs for verification",
    )
    return parser.parse_args()


def load_additional_fens(path: str | None) -> Iterable[str]:
    if not path:
        return []
    p = Path(path)
    if not p.exists():
        raise FileNotFoundError(p)
    try:
        with p.open("r", encoding="utf-8") as fh:
            data = json.load(fh)
        if not isinstance(data, list):
            raise ValueError("JSON file must contain a list of FEN strings")
        return data
    except json.JSONDecodeError:
        with p.open("r", encoding="utf-8") as fh:
            return [line.strip() for line in fh if line.strip()]


def main() -> None:
    args = parse_args()

    device = torch.device("cpu")
    print("Loading Maia2 rapid model…")
    maia_model = maia_model_lib.from_pretrained(type="rapid", device=device)

    sample_fens = list(REPRESENTATIVE_FENS)
    sample_fens.extend(load_additional_fens(args.fens))
    # Remove duplicates while preserving order.
    seen = set()
    sample_fens = [fen for fen in sample_fens if not (fen in seen or seen.add(fen))]

    export_onnx_model(maia_model, args.output, sample_fens, args.verification_elo, opset=args.opset)
    verify_against_pytorch(maia_model, args.output, sample_fens, args.verification_elo)

    if args.quantize:
        maybe_quantize(args.output, args.quantized_output)

    print("All done.")


if __name__ == "__main__":
    main()
