from flask import Flask, request, jsonify
import torch
from maia2 import model, inference

app = Flask(__name__)

# Gunakan 'cpu' jika Anda tidak memiliki GPU/CUDA. Ganti ke 'cuda' jika ada.
DEVICE = "cpu"
maia2_model = None
prepared = None

def load_model():
    """Memuat model Maia2 dan objek inferensi."""
    global maia2_model, prepared
    if maia2_model is None:
        print("Memuat model Maia2 untuk pertama kali...")
        try:
            maia2_model = model.from_pretrained(type="rapid", device=DEVICE)
            prepared = inference.prepare()
            print("Model Maia2 berhasil dimuat.")
        except Exception as e:
            print(f"Gagal memuat model Maia2: {e}")
            # Jika model gagal dimuat, kita tidak bisa melanjutkan.
            # Di aplikasi nyata, Anda mungkin ingin menangani ini dengan lebih baik.
            exit()

def get_maia_move(fen_string: str, elo: int) -> str | None:
    """
    Menjalankan model Maia2 untuk mendapatkan langkah terbaik berdasarkan FEN dan ELO.
    """
    try:
        move_probs, win_prob = inference.inference_each(
            maia2_model,
            prepared,
            fen=fen_string,
            elo_self=elo,
            elo_oppo=elo
        )

        if not move_probs:
            return None

        best_move = max(move_probs, key=move_probs.get)
        return best_move

    except Exception as e:
        print(f"Terjadi kesalahan tak terduga saat inferensi: {e}")
        return None

@app.route('/maia', methods=['GET'])
def maia_move():
    """Endpoint untuk mendapatkan langkah dari Maia."""
    fen = request.args.get('fen')
    elo_str = request.args.get('elo')

    if not fen or not elo_str:
        return jsonify({"error": "Parameter 'fen' dan 'elo' dibutuhkan."}), 400

    try:
        elo = int(elo_str)
    except ValueError:
        return jsonify({"error": "Parameter 'elo' harus berupa angka."}), 400

    if elo <= 0:
        return jsonify({"error": "ELO harus angka positif."}), 400

    best_move = get_maia_move(fen, elo)

    if best_move:
        return jsonify({"move": best_move})
    else:
        return jsonify({"error": "Tidak dapat menentukan langkah terbaik."}), 500

if __name__ == '__main__':
    load_model()
    app.run(host='0.0.0.0', port=55555)
