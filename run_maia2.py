import torch
from maia2 import model, inference

def get_maia_move(maia_model, prepared_inference, fen_string: str, elo: int) -> str | None:
    """
    Menjalankan model Maia2 untuk mendapatkan langkah terbaik berdasarkan FEN dan ELO.

    Args:
        maia_model: Model maia2 yang sudah dimuat.
        prepared_inference: Objek hasil dari `inference.prepare()`.
        fen_string: String FEN yang merepresentasikan posisi papan catur.
        elo: Peringkat ELO yang akan digunakan untuk pemain saat ini dan lawan.

    Returns:
        Langkah terbaik dalam notasi UCI (misal: "e2e4") atau None jika terjadi kesalahan.
    """
    try:
        print(f"Menganalisis FEN: {fen_string}")
        print(f"Menggunakan ELO: {elo}")

        # Menjalankan inferensi untuk posisi tunggal
        # elo_self adalah ELO pemain yang sedang giliran
        # elo_oppo adalah ELO lawan
        move_probs, win_prob = inference.inference_each(
            maia_model,
            prepared_inference,
            fen=fen_string,
            elo_self=elo,
            elo_oppo=elo
        )

        if not move_probs:
            print("Error: Tidak ada langkah legal yang ditemukan atau model gagal memprediksi.")
            return None

        # Ambil langkah dengan probabilitas tertinggi
        best_move = max(move_probs, key=move_probs.get)
        
        print(f"Probabilitas kemenangan: {win_prob*100:.2f}%")
        # print(f"Probabilitas langkah: {move_probs}")


        return best_move

    except Exception as e:
        print(f"Terjadi kesalahan tak terduga saat inferensi: {e}")
        return None

if __name__ == "__main__":
    print("="*50)
    print("Memuat model Maia2... (Mungkin perlu beberapa saat saat pertama kali)")
    print("="*50)

    # Gunakan 'cpu' jika Anda tidak memiliki GPU/CUDA. Ganti ke 'cuda' jika ada.
    DEVICE = "cpu"
    
    maia2_model = None  # Inisialisasi di luar try
    try:
        # Memuat model pra-terlatih untuk catur "rapid"
        maia2_model = model.from_pretrained(type="rapid", device=DEVICE)
        
        # Menyiapkan objek yang diperlukan untuk inferensi
        prepared = inference.prepare()

        print("Model Maia2 berhasil dimuat.")
        print("="*50)
        print("Selamat Datang di Maia2 Chess Bot Interaktif")
        print("="*50)

    except Exception as e:
        print(f"Gagal memuat model Maia2: {e}")
        exit() # Keluar dari skrip jika model gagal dimuat

    # Loop utama untuk input ELO dan FEN
    while True:
        # 1. Pilih ELO (Maia2 lebih fleksibel, tidak terbatas pada daftar)
        selected_elo = 0
        while selected_elo <= 0:
            try:
                elo_input = input("Masukkan ELO rating yang diinginkan (ketik 'keluar' untuk berhenti): ").strip()
                if elo_input.lower() == 'keluar':
                    exit()
                selected_elo = int(elo_input)
                if selected_elo <= 0:
                    print("ELO harus angka positif.")
            except ValueError:
                print("Input tidak valid. Masukkan angka.")
            except KeyboardInterrupt:
                print("\nKeluar dari program.")
                exit()
        
        print(f"\nAnda memilih ELO: {selected_elo}")
        print("-")

        # Loop untuk input FEN setelah ELO dipilih
        while True:
            fen_input = input("Masukkan FEN string (atau 'kembali' untuk ganti ELO): ").strip()
            if fen_input.lower() == 'kembali':
                break # Kembali ke pemilihan ELO
            if fen_input.lower() == 'keluar':
                exit() # Keluar dari program

            # Contoh FEN awal: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"
            best_move = get_maia_move(maia2_model, prepared, fen_input, selected_elo)

            if best_move:
                print(f"Langkah terbaik yang disarankan oleh Maia: {best_move}")
            else:
                print("Tidak dapat menentukan langkah terbaik.")
            print("-" * 20)
